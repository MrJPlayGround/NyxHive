import { create } from "zustand";
import { gateway } from "../lib/ws";

export interface Agent {
	id: string;
	name: string;
	role: string;
	enabled: boolean;
	status: "idle" | "running" | "error";
	currentTask: string | null;
	totalInvocations: number;
	totalTokensIn: number;
	totalTokensOut: number;
	estimatedCostCents: number;
	lastInvokedAt: number | null;
}

interface AgentsState {
	agents: Agent[];
	loading: boolean;

	fetchAgents: () => Promise<void>;
	updateAgentStatus: (agentId: string, status: Agent["status"], task: string | null) => void;
}

export const useAgentsStore = create<AgentsState>()((set) => ({
	agents: [],
	loading: false,

	fetchAgents: async () => {
		set({ loading: true });
		try {
			const result = await gateway.request<{ agents: Agent[] }>("agents.list", {});
			set({ agents: result.agents, loading: false });
		} catch {
			set({ loading: false });
		}
	},

	updateAgentStatus: (agentId, status, task) => {
		set((state) => ({
			agents: state.agents.map((a) =>
				a.id === agentId || a.name.toLowerCase() === agentId.toLowerCase()
					? { ...a, status, currentTask: task }
					: a,
			),
		}));
	},
}));
