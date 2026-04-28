import { create } from "zustand";
import { gateway } from "../lib/ws";

export interface Trace {
	id: string;
	origin_message_id: string | null;
	channel: string;
	sender: string;
	sender_id: string | null;
	input_message: string;
	final_response: string | null;
	status: "running" | "completed" | "failed";
	total_tokens_in: number;
	total_tokens_out: number;
	total_cost: number;
	total_duration_ms: number;
	agent_count: number;
	created_at: number;
	completed_at: number | null;
}

export interface TraceEvent {
	id: number;
	trace_id: string;
	parent_event_id: number | null;
	agent: string;
	task: string;
	response_excerpt: string | null;
	status: "running" | "completed" | "failed";
	error: string | null;
	tokens_in: number;
	tokens_out: number;
	cost: number;
	duration_ms: number;
	model: string | null;
	task_type: string | null;
	model_hint: string | null;
	started_at: number;
	completed_at: number | null;
}

interface TracesState {
	traces: Trace[];
	total: number | null;
	loading: boolean;
	statusFilter: string;
	expandedTrace: string | null;
	traceEvents: Record<string, TraceEvent[]>;

	fetchTraces: (offset?: number, limit?: number) => Promise<{ items: Trace[]; total?: number }>;
	setStatusFilter: (status: string) => void;
	toggleTrace: (id: string) => void;
	fetchTraceEvents: (id: string) => Promise<void>;
}

export const useTracesStore = create<TracesState>()((set, get) => ({
	traces: [],
	total: null,
	loading: false,
	statusFilter: "",
	expandedTrace: null,
	traceEvents: {},

	fetchTraces: async (offset = 0, limit = 50) => {
		set({ loading: true });
		try {
			const { statusFilter } = get();
			const result = await gateway.request<{ traces: Trace[]; total?: number }>("traces.list", {
				status: statusFilter || undefined,
				limit,
				offset,
			});
			const traces = result.traces ?? [];
			set({ traces, total: result.total ?? null, loading: false });
			return { items: traces, total: result.total };
		} catch {
			set({ loading: false });
			return { items: [] };
		}
	},

	setStatusFilter: (status) => {
		set({ statusFilter: status });
		get().fetchTraces();
	},

	toggleTrace: (id) => {
		const { expandedTrace } = get();
		if (expandedTrace === id) {
			set({ expandedTrace: null });
		} else {
			set({ expandedTrace: id });
			if (!get().traceEvents[id]) {
				get().fetchTraceEvents(id);
			}
		}
	},

	fetchTraceEvents: async (id) => {
		try {
			const result = await gateway.request<{ trace: Trace | null; events: TraceEvent[] }>("traces.get", { id });
			set((state) => ({
				traceEvents: { ...state.traceEvents, [id]: result.events ?? [] },
			}));
		} catch {
			// silently fail
		}
	},
}));
