/** Health check detail */
export interface HealthCheck {
	id: string;
	label: string;
	status: "ok" | "warn" | "error";
	summary: string;
	details?: Record<string, unknown>;
}

/** Queue statistics */
export interface QueueStats {
	stats: {
		pending: number;
		processing: number;
		suspended: number;
		completed: number;
		failed: number;
		dead_letter: number;
	};
	deadLetters: number;
	retryableDeadLetters: number;
	staleProcessing: number;
	stalePending: number;
	staleRunning: number;
}

/** WebSocket connection statistics */
export interface ConnectionStats {
	connected: number;
	bufferedDevices: number;
	bufferedMessages: number;
	subscriptions: number;
	seq: number;
}

export interface AgentDiagnostics {
	count: number;
	names: string[];
	running: number;
}

export interface MemoryDiagnostics {
	rss_mb: number;
	heap_used_mb: number;
	heap_total_mb: number;
	external_mb: number;
}

/** System health data returned by system.health */
export interface Health {
	status: "ok" | "degraded" | "error";
	uptime: number;
	uptime_seconds: number;
	queueDepth: number;
	activeConnections: number;
	agents: number;
	memoryUsage: number;
	instanceName?: string;
	leadAgent?: string;
	warnings?: string[];
	errors?: string[];
	providers?: Record<string, string>;
	queue?: QueueStats;
	connections?: ConnectionStats;
	checks?: HealthCheck[];
}

/** WS method metrics entry */
export interface WsMethodMetric {
	method: string;
	count: number;
	failures: number;
	avgMs: number;
	maxMs: number;
	lastError?: string;
}

/** Full diagnostics returned by system.doctor */
export interface DoctorReport {
	status: "ok" | "degraded" | "error";
	uptime_seconds: number;
	uptime?: number;
	queueDepth?: number;
	activeConnections?: number;
	agents: AgentDiagnostics;
	memory?: MemoryDiagnostics;
	memoryUsage?: number;
	instanceName?: string;
	leadAgent?: string;
	warnings?: string[];
	errors?: string[];
	providers?: Record<string, string>;
	queue?: QueueStats;
	connections?: ConnectionStats;
	checks?: HealthCheck[];
	scheduler?: Record<string, unknown>;
	wsMethods?: {
		metrics?: WsMethodMetric[];
		[key: string]: unknown;
	};
}

/** Channel icon display names */
export const channelIcons: Record<string, string> = {
	telegram: "Telegram",
	discord: "Discord",
	slack: "Slack",
	imessage: "iMessage",
};
