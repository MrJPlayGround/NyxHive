import { create } from "zustand";
import { persist } from "zustand/middleware";
import { gateway } from "../lib/ws";
import { uuid } from "../lib/utils";

interface AuthState {
	deviceId: string | null;
	deviceName: string;
	deviceSecret: string | null;
	connected: boolean;
	authenticated: boolean;
	reconnecting: boolean;
	error: string | null;
	instanceName: string | null;
	leadAgent: string | null;

	initDevice: () => void;
	connect: () => void;
	retryAuth: () => void;
	setConnected: (connected: boolean) => void;
	setAuthenticated: (authenticated: boolean) => void;
	setError: (error: string | null) => void;
	fetchInstanceInfo: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
	persist(
		(set, get) => ({
			deviceId: null,
			deviceName: "NyxHive Gateway",
			deviceSecret: null,
			connected: false,
			authenticated: false,
			reconnecting: false,
			error: null,
			instanceName: null,
			leadAgent: null,

			initDevice: () => {
				if (!get().deviceId) {
					set({
						deviceId: uuid(),
						deviceSecret: uuid(),
					});
				}
			},

			connect: () => {
				const { deviceId, deviceSecret, deviceName } = get();
				if (!deviceId || !deviceSecret) return;

				let wasAuthenticated = false;
				let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;
				const schedulePendingRetry = () => {
					if (pendingRetryTimer) return;
					pendingRetryTimer = setTimeout(() => {
						pendingRetryTimer = null;
						if (get().authenticated) return;
						gateway.disconnect();
					}, 3000);
				};
				const clearPendingRetry = () => {
					if (!pendingRetryTimer) return;
					clearTimeout(pendingRetryTimer);
					pendingRetryTimer = null;
				};

				gateway.onConnectionChange = (connected) => {
					if (connected) clearPendingRetry();
					if (!connected && get().authenticated) {
						// Was connected, now disconnected — show reconnecting state
						wasAuthenticated = true;
						set({
							connected: false,
							authenticated: false,
							reconnecting: true,
						});
					} else {
						set({
							connected,
							authenticated: connected ? get().authenticated : false,
							reconnecting: !connected && wasAuthenticated,
						});
					}
				};

				gateway.onChallenge = async (_nonce) => {
					try {
						const result = await gateway.request<{
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
						set({
							authenticated: true,
							connected: true,
							reconnecting: false,
							error: null,
						});
						if (isReconnect && result.bufferedMessages) {
							gateway.onReconnected?.(result.bufferedMessages);
						}
					} catch (err: unknown) {
						const error = err as { code?: string; message?: string };
						if (error.code === "DEVICE_PENDING") {
							set({
								error: "Device pending approval. Approve via CLI: nyxhive devices approve",
								reconnecting: false,
							});
							schedulePendingRetry();
						} else {
							set({ error: error.message ?? "Authentication failed", reconnecting: false });
						}
					}
				};

				const wsUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;
				gateway.connect(wsUrl);
			},

			retryAuth: () => {
				gateway.disconnect();
				get().connect();
			},

			fetchInstanceInfo: async () => {
				try {
					const result = await gateway.request<Record<string, unknown>>("system.health", {});
					const leadAgent = (result.leadAgent as string) ?? null;
					const instanceName = (result.instanceName as string) ?? null;
					set({ instanceName, leadAgent });
					document.title = `${instanceName ?? "NyxHive"} Gateway`;
				} catch { /* ignore */ }
			},

			setConnected: (connected) => set({ connected }),
			setAuthenticated: (authenticated) => set({ authenticated }),
			setError: (error) => set({ error }),
		}),
		{
			name: "nyxhive-device",
			partialize: (state) => ({
				deviceId: state.deviceId,
				deviceName: state.deviceName,
				deviceSecret: state.deviceSecret,
			}),
		},
	),
);
