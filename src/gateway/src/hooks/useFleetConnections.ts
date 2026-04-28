/**
 * useFleetConnections — connects enabled fleet instances using device credentials.
 *
 * Mount this once at the cockpit page level. It reads the fleet config, derives WebSocket
 * URLs, and manages connect/disconnect lifecycle via fleetGateway.
 *
 * Per-instance credentials from fleet-auth config take precedence over the
 * global device credentials from the main auth store (which are used as fallback).
 *
 * The existing singleton `gateway` (used by ChatPage) is unaffected.
 */

import { useEffect, useRef } from "react";
import { useAuthStore } from "../stores/auth";
import { useFleetConfig, type FleetInstance } from "../stores/fleet-config";
import { useFleetAuth, type InstanceConfig } from "../stores/fleet-auth";
import { fleetGateway, resolveFleetWsUrl } from "../lib/fleet-gateway";
import { resolveRuntimeEvents } from "../lib/chat-runtime";
import { RUNTIME_EVENT_METHODS } from "../lib/runtime-events";
import { useFleetChatStore } from "../stores/fleet-chat";

interface GlobalFleetCredentials {
	deviceId: string | null;
	deviceName: string | null;
	deviceSecret: string | null;
}

interface FleetConnectionTarget {
	wsUrl: string;
	deviceId: string;
	deviceName: string;
	deviceSecret: string;
	connectionKey: string;
}

const DEFAULT_INSTANCE_CONFIG: InstanceConfig = {
	wsUrlOverride: null,
	deviceId: null,
	deviceSecret: null,
};

export function resolveFleetConnectionTarget(
	instance: FleetInstance,
	globalCreds: GlobalFleetCredentials,
	instanceCfg: InstanceConfig | undefined,
): FleetConnectionTarget | null {
	const cfg = instanceCfg ?? DEFAULT_INSTANCE_CONFIG;
	const wsUrl = resolveFleetWsUrl(
		instance.id,
		cfg.wsUrlOverride ?? instance.wsUrl,
		instance.port,
	);
	if (!wsUrl) return null;

	const deviceId = cfg.deviceId ?? globalCreds.deviceId;
	const deviceSecret = cfg.deviceSecret ?? globalCreds.deviceSecret;
	if (!deviceId || !deviceSecret) return null;

	return {
		wsUrl,
		deviceId,
		deviceName: globalCreds.deviceName ?? instance.label,
		deviceSecret,
		connectionKey: `${wsUrl}|${deviceId}|${deviceSecret}`,
	};
}

export function useFleetConnections() {
	// Global device credentials — used as fallback for instances without their own
	const globalDeviceId = useAuthStore((s) => s.deviceId);
	const globalDeviceName = useAuthStore((s) => s.deviceName);
	const globalDeviceSecret = useAuthStore((s) => s.deviceSecret);

	const instances = useFleetConfig((s) => s.instances);
	const fleetConfig = useFleetAuth((s) => s.config);

	// Track connection inputs so URL or credential changes force a reconnect.
	const connectionKeysRef = useRef<Map<string, string>>(new Map());
	const subscriptionsRef = useRef<Map<string, Array<() => void>>>(new Map());

	useEffect(() => {
		const enabledInstances = instances.filter((instance) => instance.enabled && instance.id !== "nyxai");
		const nextIds = new Set(enabledInstances.map((instance) => instance.id));

		// Disconnect instances that are no longer part of the active fleet slice.
		for (const id of connectionKeysRef.current.keys()) {
			if (!nextIds.has(id)) {
				fleetGateway.disconnect(id);
				connectionKeysRef.current.delete(id);
				const unsubs = subscriptionsRef.current.get(id) ?? [];
				for (const unsubscribe of unsubs) unsubscribe();
				subscriptionsRef.current.delete(id);
			}
		}

		// Connect or refresh remote instances.
		for (const instance of enabledInstances) {
			const target = resolveFleetConnectionTarget(
				instance,
				{
					deviceId: globalDeviceId,
					deviceName: globalDeviceName,
					deviceSecret: globalDeviceSecret,
				},
				fleetConfig[instance.id],
			);
			if (!target) {
				fleetGateway.disconnect(instance.id);
				connectionKeysRef.current.delete(instance.id);
				const unsubs = subscriptionsRef.current.get(instance.id) ?? [];
				for (const unsubscribe of unsubs) unsubscribe();
				subscriptionsRef.current.delete(instance.id);
				continue;
			}

			if (connectionKeysRef.current.get(instance.id) === target.connectionKey) continue;

			const previousSubscriptions = subscriptionsRef.current.get(instance.id) ?? [];
			for (const unsubscribe of previousSubscriptions) unsubscribe();
			subscriptionsRef.current.delete(instance.id);

			fleetGateway.disconnect(instance.id);
			fleetGateway.connect(instance.id, {
				wsUrl: target.wsUrl,
				deviceId: target.deviceId,
				deviceName: target.deviceName,
				deviceSecret: target.deviceSecret,
			});
			connectionKeysRef.current.set(instance.id, target.connectionKey);
			const unsubs = RUNTIME_EVENT_METHODS.map((eventName) =>
				fleetGateway.on(instance.id, eventName, (frame) => {
					for (const event of resolveRuntimeEvents(frame)) {
						useFleetChatStore.getState().applyRuntimeEvent(instance.id, event);
					}
				}),
			);
			subscriptionsRef.current.set(instance.id, unsubs);
		}

		return () => {
			for (const id of connectionKeysRef.current.keys()) {
				fleetGateway.disconnect(id);
			}
			connectionKeysRef.current.clear();
			for (const unsubs of subscriptionsRef.current.values()) {
				for (const unsubscribe of unsubs) unsubscribe();
			}
			subscriptionsRef.current.clear();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [globalDeviceId, globalDeviceSecret, globalDeviceName, instances, fleetConfig]);
}
