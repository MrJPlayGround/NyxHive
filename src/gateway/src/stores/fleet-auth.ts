import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface InstanceAuthState {
	connected: boolean;
	authenticated: boolean;
	reconnecting: boolean;
	error: string | null;
	instanceName: string | null;
	leadAgent: string | null;
}

/** Persisted per-instance config */
export interface InstanceConfig {
	/** WS URL override (null = use fleet-config default / same-origin) */
	wsUrlOverride: string | null;
	/** Per-instance device credentials */
	deviceId: string | null;
	deviceSecret: string | null;
}

const DEFAULT_INSTANCE_AUTH: InstanceAuthState = {
	connected: false,
	authenticated: false,
	reconnecting: false,
	error: null,
	instanceName: null,
	leadAgent: null,
};

const DEFAULT_INSTANCE_CONFIG: InstanceConfig = {
	wsUrlOverride: null,
	deviceId: null,
	deviceSecret: null,
};

interface FleetAuthState {
	/** Live connection state, keyed by instance id */
	auth: Record<string, InstanceAuthState>;
	/** Persisted config, keyed by instance id */
	config: Record<string, InstanceConfig>;

	setAuth: (instanceId: string, updates: Partial<InstanceAuthState>) => void;
	getAuth: (instanceId: string) => InstanceAuthState;
	setConfig: (instanceId: string, updates: Partial<InstanceConfig>) => void;
	getConfig: (instanceId: string) => InstanceConfig;
}

export const useFleetAuth = create<FleetAuthState>()(
	persist(
		(set, get) => ({
			auth: {},
			config: {},

			setAuth: (instanceId, updates) =>
				set((state) => ({
					auth: {
						...state.auth,
						[instanceId]: {
							...(state.auth[instanceId] ?? DEFAULT_INSTANCE_AUTH),
							...updates,
						},
					},
				})),

			getAuth: (instanceId) => get().auth[instanceId] ?? { ...DEFAULT_INSTANCE_AUTH },

			setConfig: (instanceId, updates) =>
				set((state) => ({
					config: {
						...state.config,
						[instanceId]: {
							...(state.config[instanceId] ?? DEFAULT_INSTANCE_CONFIG),
							...updates,
						},
					},
				})),

			getConfig: (instanceId) => get().config[instanceId] ?? { ...DEFAULT_INSTANCE_CONFIG },
		}),
		{
			name: "nyxhive-fleet-auth",
			// Only persist config (credentials + URL overrides), not live auth state
			partialize: (state) => ({ config: state.config }),
		},
	),
);
