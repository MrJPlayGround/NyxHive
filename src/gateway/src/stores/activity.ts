import { create } from "zustand";
import { gateway } from "../lib/ws";

export interface AuditEntry {
	id: number;
	timestamp: number;
	event: string;
	channel: string | null;
	sender_id: string | null;
	agent: string | null;
	detail: string | null;
}

export type EventCategory = "all" | "message" | "security" | "scheduler" | "pairing";

function categorize(event: string): EventCategory {
	if (event.startsWith("message.")) return "message";
	if (event.startsWith("security.")) return "security";
	if (event.startsWith("scheduler.")) return "scheduler";
	if (event.startsWith("pairing.") || event === "model.override") return "pairing";
	return "message";
}

interface ActivityState {
	entries: AuditEntry[];
	total: number | null;
	loading: boolean;
	category: EventCategory;
	agentFilter: string;

	fetchEntries: (offset?: number, limit?: number) => Promise<{ items: AuditEntry[]; total?: number }>;
	setCategory: (cat: EventCategory) => void;
	setAgentFilter: (agent: string) => void;
}

export const useActivityStore = create<ActivityState>()((set, get) => ({
	entries: [],
	total: null,
	loading: false,
	category: "all",
	agentFilter: "",

	fetchEntries: async (offset = 0, limit = 50) => {
		set({ loading: true });
		try {
			const { category, agentFilter } = get();
			const eventPrefixes: Record<EventCategory, string | undefined> = {
				all: undefined,
				message: "message.",
				security: "security.",
				scheduler: "scheduler.",
				pairing: "pairing.",
			};
			const result = await gateway.request<{ entries: AuditEntry[]; total?: number }>("audit.list", {
				limit,
				offset,
				eventPrefix: eventPrefixes[category],
				agent: agentFilter || undefined,
			});
			const entries = result.entries ?? [];
			set({ entries, total: result.total ?? null, loading: false });
			return { items: entries, total: result.total };
		} catch {
			set({ loading: false });
			return { items: [] };
		}
	},

	setCategory: (cat) => {
		set({ category: cat });
	},

	setAgentFilter: (agent) => {
		set({ agentFilter: agent });
	},
}));

export { categorize };
