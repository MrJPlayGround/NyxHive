import { create } from "zustand";
import { gateway } from "../lib/ws";
import type { Health, DoctorReport } from "../lib/types";

interface SystemState {
	health: Health | null;
	doctor: DoctorReport | null;
	healthLoading: boolean;
	doctorLoading: boolean;
	healthError: string | null;
	doctorError: string | null;

	fetchHealth: () => Promise<void>;
	fetchDoctor: () => Promise<void>;
}

export const useSystemStore = create<SystemState>()((set) => ({
	health: null,
	doctor: null,
	healthLoading: false,
	doctorLoading: false,
	healthError: null,
	doctorError: null,

	fetchHealth: async () => {
		set({ healthLoading: true, healthError: null });
		try {
			const result = await gateway.request<Health>("system.health", {});
			set({ health: result, healthLoading: false });
		} catch (err) {
			set({
				healthError: err instanceof Error ? err.message : "Failed to fetch health",
				healthLoading: false,
			});
		}
	},

	fetchDoctor: async () => {
		set({ doctorLoading: true, doctorError: null });
		try {
			const result = await gateway.request<DoctorReport>("system.doctor", {});
			set({ doctor: result, doctorLoading: false });
		} catch (err) {
			set({
				doctorError: err instanceof Error ? err.message : "Failed to fetch diagnostics",
				doctorLoading: false,
			});
		}
	},
}));
