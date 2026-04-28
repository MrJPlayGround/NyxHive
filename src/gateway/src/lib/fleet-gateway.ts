/**
 * FleetGatewayClient — manages multiple GatewayClient instances, one per fleet member.
 *
 * The existing singleton `gateway` in ws.ts is intentionally untouched. The fleet
 * layer adds parallel connections for the cockpit surface. Phase 2 can unify them.
 *
 * Caller pattern:
 *   fleetGateway.connect("nyxai", { wsUrl, deviceId, deviceName, deviceSecret });
 *   fleetGateway.request("nyxai", "chat.send", { ... });
 *   fleetGateway.on("nyxai", "turn.completed", handler);
 *   fleetGateway.disconnect("nyxai");
 */

import { GatewayClient } from "./ws";
import { useFleetAuth } from "../stores/fleet-auth";
import type { Frame } from "../../protocol/frame";

export interface FleetConnectOptions {
	wsUrl: string;
	deviceId: string;
	deviceName: string;
	deviceSecret: string;
}

const DEFAULT_INSTANCE_PORTS: Record<string, number> = {
	nyxai: 3779,
	nyxlabs: 3778,
};

/**
 * Derive the websocket URL for an instance.
 * If an explicit URL is provided, use it.
 * For "nyxai" with no explicit URL, derive from the current window origin.
 */
export function resolveFleetWsUrl(
	instanceId: string,
	explicitUrl: string,
	defaultPort?: number,
): string | null {
	if (explicitUrl) return explicitUrl;
	if (typeof window === "undefined") return null;
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const port = defaultPort ?? DEFAULT_INSTANCE_PORTS[instanceId];
	if (!port) return null;

	const host = window.location.hostname;
	if (!host) return null;

	return `${protocol}//${host}:${port}/ws`;
}

class FleetGatewayClient {
	private clients = new Map<string, GatewayClient>();
	private connectOptions = new Map<string, FleetConnectOptions>();

	/** Get or create a GatewayClient for a given instance. */
	getClient(instanceId: string): GatewayClient {
		let client = this.clients.get(instanceId);
		if (!client) {
			client = new GatewayClient();
			this.clients.set(instanceId, client);
		}
		return client;
	}

	/**
	 * Connect a fleet instance. Handles device auth challenge and surfaces
	 * connection/auth state into useFleetAuth.
	 */
	connect(instanceId: string, opts: FleetConnectOptions): void {
		const { wsUrl, deviceId, deviceName, deviceSecret } = opts;
		this.connectOptions.set(instanceId, opts);

		if (!wsUrl) {
			useFleetAuth.getState().setAuth(instanceId, {
				error: "No WebSocket URL configured",
				connected: false,
				authenticated: false,
			});
			return;
		}

		const client = this.getClient(instanceId);
		const setAuth = useFleetAuth.getState().setAuth;
		let wasAuthenticated = false;
		let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;
		const schedulePendingRetry = () => {
			if (pendingRetryTimer) return;
			pendingRetryTimer = setTimeout(() => {
				pendingRetryTimer = null;
				const current = useFleetAuth.getState().auth[instanceId];
				if (current?.authenticated) return;
				client.disconnect();
			}, 3000);
		};
		const clearPendingRetry = () => {
			if (!pendingRetryTimer) return;
			clearTimeout(pendingRetryTimer);
			pendingRetryTimer = null;
		};

		client.onConnectionChange = (connected) => {
			if (connected) clearPendingRetry();
			const currentAuth = useFleetAuth.getState().auth[instanceId];
			if (!connected && currentAuth?.authenticated) {
				wasAuthenticated = true;
				setAuth(instanceId, {
					connected: false,
					authenticated: false,
					reconnecting: true,
				});
			} else {
				setAuth(instanceId, {
					connected,
					authenticated: connected ? (currentAuth?.authenticated ?? false) : false,
					reconnecting: !connected && wasAuthenticated,
				});
			}
		};

		client.onChallenge = async (_nonce) => {
			try {
				const result = await client.request<{
					sessionToken: string;
					scopes: string[];
					serverVersion: string;
					bufferedMessages?: number;
				}>("connect.authenticate", {
					deviceId,
					deviceName,
					signature: deviceSecret,
					protocolVersion: 1,
				});

				const isReconnect = wasAuthenticated;
				wasAuthenticated = true;

				setAuth(instanceId, {
					authenticated: true,
					connected: true,
					reconnecting: false,
					error: null,
				});

				void this.fetchInstanceInfo(instanceId);

				if (isReconnect && result.bufferedMessages) {
					client.onReconnected?.(result.bufferedMessages);
				}
			} catch (err: unknown) {
				const error = err as { code?: string; message?: string };
				if (error.code === "DEVICE_PENDING") {
					setAuth(instanceId, {
						error: "Device pending approval — run: nyxhive devices approve",
						reconnecting: false,
					});
					schedulePendingRetry();
				} else {
					setAuth(instanceId, {
						error: error.message ?? "Authentication failed",
						reconnecting: false,
					});
				}
			}
		};

		client.connect(wsUrl);
	}

	/** Disconnect a fleet instance and clear its client. */
	disconnect(instanceId: string): void {
		const client = this.clients.get(instanceId);
		if (client) {
			client.disconnect();
			this.clients.delete(instanceId);
		}
		this.connectOptions.delete(instanceId);
		useFleetAuth.getState().setAuth(instanceId, {
			connected: false,
			authenticated: false,
			reconnecting: false,
			error: null,
			instanceName: null,
			leadAgent: null,
		});
	}

	/** Send a request to a specific instance. */
	request<T = unknown>(instanceId: string, method: string, payload: unknown, timeoutMs?: number): Promise<T> {
		return this.getClient(instanceId).request<T>(method, payload, timeoutMs);
	}

	/** Subscribe to an event on a specific instance. Returns an unsubscribe function. */
	on(instanceId: string, event: string, handler: (frame: Frame) => void): () => void {
		return this.getClient(instanceId).on(event, handler);
	}

	/** Check if a specific instance client is currently connected. */
	isConnected(instanceId: string): boolean {
		return this.clients.get(instanceId)?.isConnected ?? false;
	}

	reconnect(instanceId: string): void {
		const opts = this.connectOptions.get(instanceId);
		if (!opts) return;
		const client = this.clients.get(instanceId);
		client?.disconnect();
		this.connect(instanceId, opts);
	}

	private async fetchInstanceInfo(instanceId: string): Promise<void> {
		const client = this.clients.get(instanceId);
		if (!client) return;
		try {
			const result = await client.request<{ instanceName?: string; leadAgent?: string }>(
				"system.health",
				{},
			);
			useFleetAuth.getState().setAuth(instanceId, {
				instanceName: result.instanceName ?? null,
				leadAgent: result.leadAgent ?? null,
			});
		} catch {
			// non-fatal — just won't show instance name
		}
	}
}

export const fleetGateway = new FleetGatewayClient();
