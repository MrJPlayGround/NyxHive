import { create } from "zustand";
import { gateway } from "../lib/ws";
import type { Health } from "../lib/types";

export interface ParsedHttpAudit {
	method?: string;
	host?: string | null;
	path?: string | null;
	redactedPath?: string | null;
	status?: number | null;
	ok?: boolean;
	outcome?: string;
	durationMs?: number;
	caller?: string | null;
	request?: {
		redactedHeaders?: Record<string, string>;
		redactedBodyPreview?: string | null;
		bodyHash?: string | null;
	};
	response?: {
		redactedHeaders?: Record<string, string>;
		redactedBodyPreview?: string | null;
		bodyHash?: string | null;
	};
	error?: string | null;
	secretFingerprints?: string[];
}

export interface AuditEntry {
	id: number;
	timestamp: number;
	event: string;
	channel: string | null;
	sender_id: string | null;
	agent: string | null;
	detail: string | null;
	parsed?: ParsedHttpAudit | Record<string, unknown> | null;
}

export interface AuditSummary {
	total: number;
	byEvent: Record<string, number>;
	byChannel: Record<string, number>;
	http?: {
		total: number;
		errors: number;
		topHosts: Array<{ host: string; count: number }>;
		slowest: AuditEntry[];
	};
	latestTimestamp: number | null;
}

export interface LogEntry {
	id?: string;
	level: "debug" | "info" | "warn" | "error";
	message: string;
	module?: string;
	timestamp: number;
}

export interface CoreTask {
	id: string;
	name: string;
	description?: string;
	enabled: boolean;
	next_run_at?: number | null;
	last_run_at?: number | null;
	last_status?: string | null;
	last_result_preview?: string | null;
	run_count?: number;
	consecutive_failures?: number;
}

export interface SchedulerCore {
	mode?: string;
	core_tasks: CoreTask[];
	enabled_count: number;
	paused_automation_families: string[];
}

export interface RoutingUsageRow {
	model: string;
	task_type: string;
	total: number;
	completed: number;
	failed: number;
	success_rate: number;
	avg_cost: number;
	avg_duration_ms: number;
}

export interface ProviderUsageProviderRow {
	provider: string;
	calls: number;
	failures: number;
	totalCostCents: number;
	models: number;
}

export interface ProviderUsageModelRow {
	provider: string;
	model: string;
	calls: number;
	completed: number;
	failures: number;
	successRate: number;
	avgDurationMs: number;
	totalCostCents: number;
	taskTypes: string[];
}

export interface ProviderUsageSummary {
	periodHours: number;
	totalCalls: number;
	totalFailures: number;
	totalCostCents: number;
	providers: ProviderUsageProviderRow[];
	models: ProviderUsageModelRow[];
}

export type AuditChip = "all" | "message" | "security" | "scheduler" | "failures" | "http";
export type TimeWindow = "15m" | "1h" | "24h" | "7d";

export interface AuditFilters {
	chip: AuditChip;
	timeWindow: TimeWindow;
	query: string;
	host: string;
	method: string;
	status: string;
	minDurationMs: string;
}

const TIME_WINDOW_MS: Record<TimeWindow, number> = {
	"15m": 15 * 60_000,
	"1h": 60 * 60_000,
	"24h": 24 * 60 * 60_000,
	"7d": 7 * 24 * 60 * 60_000,
};

const TIME_WINDOW_HOURS: Record<TimeWindow, number> = {
	"15m": 1,
	"1h": 1,
	"24h": 24,
	"7d": 168,
};

export type LogLevel = "all" | "debug" | "info" | "warn" | "error";

interface ControlState {
	health: Health | null;
	summary: AuditSummary | null;
	entries: AuditEntry[];
	logs: LogEntry[];
	schedulerCore: SchedulerCore | null;
	providerUsage: ProviderUsageSummary | null;
	loading: boolean;
	auditLoading: boolean;
	logsLoading: boolean;
	providerUsageLoading: boolean;
	filters: AuditFilters;
	expandedEntryId: number | null;
	logLevel: LogLevel;

	fetchHealth: () => Promise<void>;
	fetchSummary: () => Promise<void>;
	fetchAudit: () => Promise<void>;
	fetchLogs: () => Promise<void>;
	fetchSchedulerCore: () => Promise<void>;
	fetchProviderUsage: () => Promise<void>;
	fetchAll: () => Promise<void>;
	setFilter: <K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) => void;
	setExpandedEntry: (id: number | null) => void;
	setLogLevel: (level: LogLevel) => void;
}

export function buildAuditPayload(filters: AuditFilters): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		limit: 150,
		since: Date.now() - TIME_WINDOW_MS[filters.timeWindow],
	};

	switch (filters.chip) {
		case "message":
			payload.eventPrefix = "message.";
			break;
		case "security":
			payload.eventPrefix = "security.";
			break;
		case "scheduler":
			payload.eventPrefix = "scheduler.";
			break;
		case "failures":
			payload.outcome = "error";
			break;
		case "http":
			payload.event = "http.outbound";
			break;
	}

	if (filters.host) payload.host = filters.host;
	if (filters.method) payload.method = filters.method.toUpperCase();
	if (filters.status && Number.isFinite(Number(filters.status))) payload.status = Number(filters.status);
	if (filters.minDurationMs && Number.isFinite(Number(filters.minDurationMs))) payload.minDurationMs = Number(filters.minDurationMs);

	return payload;
}

function filterLocal(entries: AuditEntry[], query: string): AuditEntry[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return entries;
	return entries.filter((entry) =>
		[
			entry.event,
			entry.channel,
			entry.agent,
			entry.detail,
			JSON.stringify(entry.parsed ?? {}),
		]
			.filter(Boolean)
			.join(" ")
			.toLowerCase()
			.includes(needle),
	);
}

function inferProvider(model: string): string {
	const value = model.trim().toLowerCase();
	const [prefix] = value.split("/");
	if (value.includes("/")) {
		if (["openrouter", "or"].includes(prefix)) return "openrouter";
		if (["anthropic", "openai", "google", "x-ai", "deepseek", "mistralai", "meta-llama", "qwen"].includes(prefix)) return prefix;
		return prefix || "unknown";
	}
	if (value.startsWith("claude-")) return "anthropic";
	if (value.startsWith("gpt-") || value.startsWith("o1") || value.startsWith("o3") || value.startsWith("o4")) return "openai";
	if (value.includes("gemini")) return "google";
	if (value.includes("deepseek")) return "deepseek";
	if (value.includes("minimax")) return "minimax";
	if (value.includes("llama") || value.includes("mistral") || value.includes("qwen")) return "ollama";
	return "unknown";
}

function providerLabel(provider: string): string {
	const labels: Record<string, string> = {
		"meta-llama": "Meta Llama",
		"x-ai": "xAI",
		google: "Google",
		anthropic: "Anthropic",
		openai: "OpenAI",
		openrouter: "OpenRouter",
		deepseek: "DeepSeek",
		mistralai: "Mistral",
		minimax: "MiniMax",
		ollama: "Ollama",
		qwen: "Qwen",
		unknown: "Unknown",
	};
	return labels[provider] ?? provider;
}

function aggregateProviderUsage(rows: RoutingUsageRow[], periodHours: number): ProviderUsageSummary {
	const byModel = new Map<string, ProviderUsageModelRow & { durationWeight: number; taskTypeSet: Set<string> }>();

	for (const row of rows) {
		const provider = inferProvider(row.model);
		const key = `${provider}:${row.model}`;
		const total = Math.max(row.total ?? 0, 0);
		const completed = Math.max(row.completed ?? 0, 0);
		const failed = Math.max(row.failed ?? 0, 0);
		const totalCostCents = Math.max(row.avg_cost ?? 0, 0) * total * 100;
		const current = byModel.get(key) ?? {
			provider,
			model: row.model,
			calls: 0,
			completed: 0,
			failures: 0,
			successRate: 0,
			avgDurationMs: 0,
			totalCostCents: 0,
			taskTypes: [],
			durationWeight: 0,
			taskTypeSet: new Set<string>(),
		};

		current.calls += total;
		current.completed += completed;
		current.failures += failed;
		current.totalCostCents += totalCostCents;
		current.durationWeight += Math.max(row.avg_duration_ms ?? 0, 0) * total;
		if (row.task_type) current.taskTypeSet.add(row.task_type);
		byModel.set(key, current);
	}

	const models = [...byModel.values()].map((row) => ({
		provider: row.provider,
		model: row.model,
		calls: row.calls,
		completed: row.completed,
		failures: row.failures,
		successRate: row.calls > 0 ? Math.round((row.completed / row.calls) * 1000) / 10 : 0,
		avgDurationMs: row.calls > 0 ? Math.round(row.durationWeight / row.calls) : 0,
		totalCostCents: row.totalCostCents,
		taskTypes: [...row.taskTypeSet].sort(),
	})).sort((a, b) => b.totalCostCents - a.totalCostCents || b.calls - a.calls);

	const byProvider = new Map<string, ProviderUsageProviderRow & { modelSet: Set<string> }>();
	for (const row of models) {
		const current = byProvider.get(row.provider) ?? {
			provider: row.provider,
			calls: 0,
			failures: 0,
			totalCostCents: 0,
			models: 0,
			modelSet: new Set<string>(),
		};
		current.calls += row.calls;
		current.failures += row.failures;
		current.totalCostCents += row.totalCostCents;
		current.modelSet.add(row.model);
		byProvider.set(row.provider, current);
	}

	const providers = [...byProvider.values()].map((row) => ({
		provider: row.provider,
		calls: row.calls,
		failures: row.failures,
		totalCostCents: row.totalCostCents,
		models: row.modelSet.size,
	})).sort((a, b) => b.totalCostCents - a.totalCostCents || b.calls - a.calls || providerLabel(a.provider).localeCompare(providerLabel(b.provider)));

	return {
		periodHours,
		totalCalls: models.reduce((sum, row) => sum + row.calls, 0),
		totalFailures: models.reduce((sum, row) => sum + row.failures, 0),
		totalCostCents: models.reduce((sum, row) => sum + row.totalCostCents, 0),
		providers,
		models,
	};
}

export const useControlStore = create<ControlState>()((set, get) => ({
	health: null,
	summary: null,
	entries: [],
	logs: [],
	schedulerCore: null,
	providerUsage: null,
	loading: false,
	auditLoading: false,
	logsLoading: false,
	providerUsageLoading: false,
	expandedEntryId: null,
	logLevel: "all",
	filters: {
		chip: "all",
		timeWindow: "1h",
		query: "",
		host: "",
		method: "",
		status: "",
		minDurationMs: "",
	},

	fetchHealth: async () => {
		try {
			const health = await gateway.request<Health>("system.health", {});
			set({ health });
		} catch {
			// Leave prior health visible if refresh fails.
		}
	},

	fetchSummary: async () => {
		try {
			const summary = await gateway.request<AuditSummary>("audit.summary", {
				since: Date.now() - TIME_WINDOW_MS[get().filters.timeWindow],
			});
			set({ summary });
		} catch {
			// Audit summary is optional for older gateways.
		}
	},

	fetchAudit: async () => {
		set({ auditLoading: true });
		try {
			const result = await gateway.request<{ entries: AuditEntry[] }>("audit.list", buildAuditPayload(get().filters));
			set({
				entries: filterLocal(result.entries ?? [], get().filters.query),
				auditLoading: false,
			});
		} catch {
			set({ auditLoading: false });
		}
	},

	fetchLogs: async () => {
		set({ logsLoading: true });
		try {
			const result = await gateway.request<{ entries: LogEntry[] }>("logs.recent", { limit: 80 });
			set({ logs: result.entries ?? [], logsLoading: false });
		} catch {
			set({ logsLoading: false });
		}
	},

	fetchSchedulerCore: async () => {
		try {
			const schedulerCore = await gateway.request<SchedulerCore>("scheduler.core", {});
			set({ schedulerCore });
		} catch {
			// Some instances run without scheduler.
		}
	},

	fetchProviderUsage: async () => {
		set({ providerUsageLoading: true });
		try {
			const hours = TIME_WINDOW_HOURS[get().filters.timeWindow];
			const result = await gateway.request<{ period_hours?: number; success_rates?: RoutingUsageRow[] }>("usage.routing", { hours });
			set({
				providerUsage: aggregateProviderUsage(result.success_rates ?? [], result.period_hours ?? hours),
				providerUsageLoading: false,
			});
		} catch {
			set({ providerUsageLoading: false });
		}
	},

	fetchAll: async () => {
		set({ loading: true });
		await Promise.all([
			get().fetchHealth(),
			get().fetchSummary(),
			get().fetchAudit(),
			get().fetchLogs(),
			get().fetchSchedulerCore(),
			get().fetchProviderUsage(),
		]);
		set({ loading: false });
	},

	setFilter: (key, value) => set((state) => ({
		filters: { ...state.filters, [key]: value },
	})),

	setExpandedEntry: (id) => set({ expandedEntryId: id }),

	setLogLevel: (level) => set({ logLevel: level }),
}));
