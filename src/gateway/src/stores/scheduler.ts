import { create } from "zustand";
import { toast_error, toast_success } from "../components/ui/toast";
import { gateway } from "../lib/ws";

export interface Job {
	id: string;
	name: string;
	description: string;
	schedule: string;
	agent: string;
	category: string;
	enabled: boolean;
	lastRun: number | null;
	nextRun: number | null;
	lastStatus: string | null;
	lastResult: string | null;
	lastError: string | null;
	runCount: number;
	consecutiveFailures: number;
}

interface SchedulerState {
	jobs: Job[];
	loading: boolean;
	runningJobs: Set<string>;

	fetchJobs: () => Promise<void>;
	toggleJob: (id: string, enabled: boolean) => Promise<void>;
	updateJob: (id: string, updates: Partial<Pick<Job, "schedule" | "name" | "description">>) => Promise<void>;
	runJob: (id: string) => Promise<void>;
	markRunning: (id: string) => void;
	markStopped: (id: string) => void;
}

export const useSchedulerStore = create<SchedulerState>()((set, get) => ({
	jobs: [],
	loading: false,
	runningJobs: new Set<string>(),

	fetchJobs: async () => {
		set({ loading: true });
		try {
			const result = await gateway.request<{ jobs: Job[] }>("scheduler.list", {});
			set({ jobs: result.jobs ?? [], loading: false });
		} catch {
			set({ loading: false });
		}
	},

	toggleJob: async (id, enabled) => {
		set((state) => ({
			jobs: state.jobs.map((j) => (j.id === id ? { ...j, enabled } : j)),
		}));
		try {
			await gateway.request("scheduler.update", { id, enabled });
			toast_success(enabled ? "Job enabled" : "Job disabled");
		} catch {
			get().fetchJobs();
		}
	},

	updateJob: async (id, updates) => {
		// Optimistic update
		set((state) => ({
			jobs: state.jobs.map((j) => (j.id === id ? { ...j, ...updates } : j)),
		}));
		try {
			const payload: Record<string, unknown> = { id };
			if (updates.schedule !== undefined) payload.cron_expression = updates.schedule;
			if (updates.name !== undefined) payload.name = updates.name;
			if (updates.description !== undefined) payload.description = updates.description;
			await gateway.request("scheduler.update", payload);
		} finally {
			// Always refetch to get server-computed fields (nextRun)
			get().fetchJobs();
		}
	},

	runJob: async (id) => {
		set((state) => {
			const next = new Set(state.runningJobs);
			next.add(id);
			return { runningJobs: next };
		});
		try {
			await gateway.request("scheduler.run", { id });
			toast_success("Job triggered");
		} catch (error) {
			set((state) => {
				const next = new Set(state.runningJobs);
				next.delete(id);
				return { runningJobs: next };
			});
			toast_error(
				"Failed to trigger job",
				error instanceof Error ? error.message : "Unknown error",
			);
			throw error;
		}
	},

	markRunning: (id) => set((state) => {
		const next = new Set(state.runningJobs);
		next.add(id);
		return { runningJobs: next };
	}),

	markStopped: (id) => set((state) => {
		const next = new Set(state.runningJobs);
		next.delete(id);
		return { runningJobs: next };
	}),
}));
