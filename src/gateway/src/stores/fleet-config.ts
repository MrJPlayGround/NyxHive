import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface FleetInstance {
	id: string;
	label: string;
	/** Explicit WebSocket URL. Empty string means derive from the current host + instance port. */
	wsUrl: string;
	preferredAgent: string | null;
	enabled: boolean;
	port: number;
	/** CSS color token or value for accent in the UI */
	color: string;
}

const ALWAYS_ON_INSTANCE_IDS = new Set(["nyxai", "nyxlabs"]);

const DEFAULT_INSTANCES: FleetInstance[] = [
	{
		id: "nyxai",
		label: "NyxAI",
		wsUrl: "",
		preferredAgent: "nyx",
		enabled: true,
		port: 3777,
		color: "var(--nyx-accent)",
	},
	{
		id: "nyxlabs",
		label: "NyxLabs",
		wsUrl: "",
		preferredAgent: "vortex",
		enabled: true,
		port: 3778,
		color: "#e8b84a",
	},
];

function normalizeInstance(defaults: FleetInstance, saved?: FleetInstance): FleetInstance {
	const merged = saved ? { ...defaults, ...saved } : defaults;
	return ALWAYS_ON_INSTANCE_IDS.has(defaults.id)
		? { ...merged, enabled: true }
		: merged;
}

export function mergeInstances(persisted: FleetInstance[] | undefined): FleetInstance[] {
	if (!persisted?.length) return DEFAULT_INSTANCES;

	const persistedById = new Map(persisted.map((instance) => [instance.id, instance]));

	return DEFAULT_INSTANCES.map((defaults) => {
		const saved = persistedById.get(defaults.id);
		return normalizeInstance(defaults, saved);
	});
}

interface FleetConfigState {
	instances: FleetInstance[];
	selectedInstanceId: string;
	selectInstance: (id: string) => void;
	updateInstance: (
		id: string,
		updates: Partial<Pick<FleetInstance, "wsUrl" | "preferredAgent" | "enabled" | "port">>,
	) => void;
}

export function mergeFleetConfigState(
	persisted: Partial<FleetConfigState> | undefined,
	currentState: FleetConfigState,
): FleetConfigState {
	const instances = mergeInstances(persisted?.instances);
	const selectedInstanceId = instances.some((instance) => instance.id === persisted?.selectedInstanceId)
		? persisted!.selectedInstanceId!
		: currentState.selectedInstanceId;

	return {
		...currentState,
		...persisted,
		instances,
		selectedInstanceId,
	};
}

export const useFleetConfig = create<FleetConfigState>()(
	persist(
		(set) => ({
			instances: DEFAULT_INSTANCES,
			selectedInstanceId: "nyxai",

			selectInstance: (id) => set({ selectedInstanceId: id }),

			updateInstance: (id, updates) =>
				set((state) => ({
					instances: state.instances.map((inst) =>
						inst.id === id
							? normalizeInstance(inst, {
								...inst,
								...updates,
							})
							: inst,
					),
				})),
		}),
		{
			name: "nyxhive-fleet-config",
			version: 1,
			partialize: (state) => ({
				instances: state.instances,
				selectedInstanceId: state.selectedInstanceId,
			}),
			merge: (persistedState, currentState) => {
				const persisted = persistedState as Partial<FleetConfigState> | undefined;
				return mergeFleetConfigState(persisted, currentState);
			},
		},
	),
);
