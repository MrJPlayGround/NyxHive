/**
 * CockpitPage — fleet command center for NyxAI / NyxLabs.
 *
 * Architecture notes:
 * - NyxAI auth is bridged from the existing `useAuthStore` singleton (same-host
 *   gateway). We do NOT open a second WS connection to NyxAI.
 * - NyxLabs connects through the additive fleet client layer and derives
 *   their WebSocket endpoints from the current host by default.
 * - Fleet state lives in useFleetConfig (config) and useFleetAuth (runtime).
 * - Connection lifecycle is centralized in `useFleetConnections`.
 *
 * Phase 2 migration path:
 *   - Replace InstanceFocus placeholder shells with real chat/execution/diff
 *     primitives wired to fleetGateway.request/on for the selected instance.
 *   - Each instance gets its own useChatStore-equivalent slice or we lift state
 *     here and pass it down.
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import { useAuthStore } from "../stores/auth";
import { useFleetConfig } from "../stores/fleet-config";
import { useFleetAuth } from "../stores/fleet-auth";
import { InstanceRail } from "../components/cockpit/InstanceRail";
import { InstanceFocus } from "../components/cockpit/InstanceFocus";
import { FleetInboxPanel } from "../components/cockpit/FleetInboxPanel";
import { useFleetConnections } from "../hooks/useFleetConnections";
import { gateway } from "../lib/ws";
import { resolveRuntimeEvents } from "../lib/chat-runtime";
import { RUNTIME_EVENT_METHODS, isGatewayEvent } from "../lib/runtime-events";
import { useFleetChatStore } from "../stores/fleet-chat";
import { getCockpitRequestPollTargets } from "./cockpit-request-poll";

export function CockpitPage() {
	const { instances, selectedInstanceId, selectInstance } = useFleetConfig();
	const { auth, setAuth } = useFleetAuth();
	const ensureFleetChatInstance = useFleetChatStore((s) => s.ensureInstance);
	const fleetChatInstances = useFleetChatStore((s) => s.instances);
	const loadRequests = useFleetChatStore((s) => s.loadRequests);
	const resolveRequest = useFleetChatStore((s) => s.resolveRequest);
	const switchThread = useFleetChatStore((s) => s.switchThread);
	useFleetConnections();
	const [resolvingKey, setResolvingKey] = useState<string | null>(null);

	// Bridge NyxAI auth from the existing singleton store so the rail shows
	// the correct live status without opening a second connection.
	const nyxaiConnected = useAuthStore((s) => s.connected);
	const nyxaiAuthenticated = useAuthStore((s) => s.authenticated);
	const nyxaiReconnecting = useAuthStore((s) => s.reconnecting);
	const nyxaiError = useAuthStore((s) => s.error);
	const nyxaiInstanceName = useAuthStore((s) => s.instanceName);
	const nyxaiLeadAgent = useAuthStore((s) => s.leadAgent);
	const requestPollTargets = useMemo(
		() => getCockpitRequestPollTargets(instances, auth, nyxaiAuthenticated),
		[instances, auth, nyxaiAuthenticated],
	);
	const requestPollKey = requestPollTargets.join("|");

	useEffect(() => {
		setAuth("nyxai", {
			connected: nyxaiConnected,
			authenticated: nyxaiAuthenticated,
			reconnecting: nyxaiReconnecting,
			error: nyxaiError,
			instanceName: nyxaiInstanceName,
			leadAgent: nyxaiLeadAgent,
		});
	}, [nyxaiConnected, nyxaiAuthenticated, nyxaiReconnecting, nyxaiError, nyxaiInstanceName, nyxaiLeadAgent, setAuth]);

	useEffect(() => {
		for (const instance of instances) {
			ensureFleetChatInstance(instance.id, instance.preferredAgent);
		}
	}, [instances, ensureFleetChatInstance]);

	useEffect(() => {
		const refresh = () => {
			for (const instanceId of requestPollTargets) {
				void loadRequests(instanceId);
			}
		};

		refresh();
		const interval = setInterval(refresh, 15000);
		return () => clearInterval(interval);
	}, [loadRequests, requestPollKey, requestPollTargets]);

	useEffect(() => {
		const unsubs = RUNTIME_EVENT_METHODS.map((eventName) =>
			gateway.on(eventName, (frame) => {
				if (!isGatewayEvent(frame)) return;
				for (const event of resolveRuntimeEvents(frame)) {
					useFleetChatStore.getState().applyRuntimeEvent("nyxai", event);
				}
			}),
		);
		return () => {
			for (const unsubscribe of unsubs) unsubscribe();
		};
	}, []);

	const selectedInstance = instances.find((i) => i.id === selectedInstanceId) ?? instances[0];
	const selectedAuth = auth[selectedInstanceId] ?? {
		connected: false,
		authenticated: false,
		reconnecting: false,
		error: null,
		instanceName: null,
		leadAgent: null,
	};

	const requestCounts = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const instance of instances) {
			counts[instance.id] = fleetChatInstances[instance.id]?.pendingRequests.length ?? 0;
		}
		return counts;
	}, [instances, fleetChatInstances]);

	const inboxItems = useMemo(
		() => instances.flatMap((instance) =>
			(fleetChatInstances[instance.id]?.pendingRequests ?? []).map((request) => ({
				instance,
				request,
				active: instance.id === selectedInstanceId,
			})),
		).sort((left, right) => right.request.createdAt - left.request.createdAt),
		[instances, fleetChatInstances, selectedInstanceId],
	);

	const handleOpenInboxItem = useCallback(async (instanceId: string, threadId?: string) => {
		selectInstance(instanceId);
		if (threadId) {
			await switchThread(instanceId, threadId);
		}
	}, [selectInstance, switchThread]);

	const handleResolveInboxItem = useCallback(async (
		instanceId: string,
		requestId: string,
		action: "approve" | "reject" | "respond",
		response?: string,
	) => {
		const key = `${instanceId}:${requestId}:${action}`;
		setResolvingKey(key);
		try {
			await resolveRequest(instanceId, requestId, action, response);
		} finally {
			setResolvingKey(null);
		}
	}, [resolveRequest]);

	return (
		<div className="flex min-h-0 flex-1 overflow-hidden">
			<InstanceRail
				instances={instances}
				selectedId={selectedInstanceId}
				authStates={auth}
				runtimeStates={Object.fromEntries(
					Object.entries(fleetChatInstances).map(([instanceId, state]) => [instanceId, state.runtime]),
				)}
				requestCounts={requestCounts}
				onSelect={selectInstance}
			/>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
				<FleetInboxPanel
					items={inboxItems}
					resolvingKey={resolvingKey}
					onOpen={handleOpenInboxItem}
					onResolve={handleResolveInboxItem}
				/>
				{selectedInstance && (
					<InstanceFocus
						instance={selectedInstance}
						auth={selectedAuth}
						runtime={fleetChatInstances[selectedInstance.id]?.runtime}
					/>
				)}
			</div>
		</div>
	);
}
