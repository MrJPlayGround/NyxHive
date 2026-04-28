import { create } from "zustand";
import { gateway } from "../lib/ws";

export interface LogEntry {
	id: string;
	level: "debug" | "info" | "warn" | "error";
	message: string;
	module?: string;
	agent?: string;
	timestamp: number;
}

let logSeq = 0;

interface LogsState {
	entries: LogEntry[];
	subscribed: boolean;
	paused: boolean;
	filters: {
		level: string;
		agent: string;
		search: string;
	};
	maxEntries: number;

	subscribe: () => Promise<void>;
	unsubscribe: () => Promise<void>;
	addEntry: (entry: LogEntry) => void;
	togglePause: () => void;
	setFilter: (key: keyof LogsState["filters"], value: string) => void;
	clearLogs: () => void;
	exportLogs: () => void;
}

export const useLogsStore = create<LogsState>()((set, get) => ({
	entries: [],
	subscribed: false,
	paused: false,
	filters: { level: "", agent: "", search: "" },
	maxEntries: 5000,

	subscribe: async () => {
		try {
			await gateway.request("logs.subscribe", {});
			set({ subscribed: true });
			// Load recent log entries so the page isn't empty on first visit
			try {
				const result = await gateway.request<{ entries: LogEntry[] }>("logs.recent", { limit: 100 });
				if (result.entries?.length) {
					set({ entries: result.entries.map((e) => ({ ...e, id: e.id || `log-${++logSeq}` })) });
				}
			} catch {
				// Recent logs not available, live stream will fill in
			}
		} catch {
			// Ignore
		}
	},

	unsubscribe: async () => {
		try {
			await gateway.request("logs.unsubscribe", {});
			set({ subscribed: false });
		} catch {
			// Ignore
		}
	},

	addEntry: (entry) => {
		if (get().paused) return;
		const tagged = { ...entry, id: entry.id || `log-${++logSeq}` };
		set((state) => {
			const entries = [...state.entries, tagged];
			if (entries.length > state.maxEntries) {
				return { entries: entries.slice(-state.maxEntries) };
			}
			return { entries };
		});
	},

	togglePause: () => set((state) => ({ paused: !state.paused })),

	setFilter: (key, value) =>
		set((state) => ({ filters: { ...state.filters, [key]: value } })),

	clearLogs: () => set({ entries: [] }),

	exportLogs: () => {
		const { entries } = get();
		const text = entries
			.map(
				(e) =>
					`${new Date(e.timestamp).toISOString()} [${e.level.toUpperCase()}] ${e.module ? `[${e.module}] ` : ""}${e.message}`,
			)
			.join("\n");
		const blob = new Blob([text], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `nyxhive-logs-${Date.now()}.log`;
		a.click();
		URL.revokeObjectURL(url);
	},
}));
