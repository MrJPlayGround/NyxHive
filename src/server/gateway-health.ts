import type { AgentRegistry } from "../agents/registry.js";
import type { NyxHiveConfig } from "../types.js";
import type { ProviderRouter } from "../providers/router.js";
import type { QueueDB } from "../queue/db.js";
import type { DelegationRunStore } from "../runs/store.js";
import type { Scheduler } from "../scheduler/index.js";
import type { ConnectionManager } from "./ws/connection.js";
import { describeServerContract } from "./urls.js";

type CheckStatus = "ok" | "warn" | "error";

export interface GatewayHealthDeps {
  config: NyxHiveConfig;
  startTime: number;
  queue?: QueueDB;
  providerRouter?: ProviderRouter;
  registry?: AgentRegistry;
  scheduler?: Scheduler;
  runs?: DelegationRunStore;
  connections?: ConnectionManager;
  wsRouter?: {
    listMethods?: () => string[];
    getMetrics?: () => Array<{
      method: string;
      count: number;
      failures: number;
      totalMs: number;
      avgMs: number;
      maxMs: number;
      lastMs: number;
      lastCalledAt: number;
      lastError?: string;
    }>;
  };
}

export interface GatewayHealthCheck {
  id: string;
  label: string;
  status: CheckStatus;
  summary: string;
  details?: Record<string, unknown>;
}

function makeCheck(
  id: string,
  label: string,
  status: CheckStatus,
  summary: string,
  details?: Record<string, unknown>,
): GatewayHealthCheck {
  return details ? { id, label, status, summary, details } : { id, label, status, summary };
}

function summarizeStatus(checks: GatewayHealthCheck[]): "ok" | "degraded" | "error" {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "warn")) return "degraded";
  return "ok";
}

function collectTrustPosture(config: NyxHiveConfig) {
  const pairedDmSurfaces: string[] = [];
  const publicSafeSurfaces: string[] = [];

  if (config.telegram?.bot_token_env) pairedDmSurfaces.push("telegram_dm");
  if (config.discord?.bot_token_env) {
    pairedDmSurfaces.push("discord_dm");
    publicSafeSurfaces.push("discord_public");
  }
  if (config.slack?.bot_token_env && config.slack?.app_token_env) {
    pairedDmSurfaces.push("slack_dm");
    publicSafeSurfaces.push("slack_public");
  }

  const summary = pairedDmSurfaces.length === 0 && publicSafeSurfaces.length === 0
    ? "Personal assistant trust boundary: workspace/API only."
    : `Personal assistant trust boundary: one trusted operator, ${pairedDmSurfaces.length} paired DM surface(s), ${publicSafeSurfaces.length} public-safe surface(s).`;

  return {
    status: "ok" as const,
    summary,
    details: {
      operatorBoundary: "single_trusted_operator",
      pairingEnabled: config.pairing?.enabled === true,
      pairedDmSurfaces,
      publicSafeSurfaces,
    },
  };
}

export function collectGatewayHealth(deps: GatewayHealthDeps) {
  const checks: GatewayHealthCheck[] = [];
  const uptimeSeconds = Math.floor((Date.now() - deps.startTime) / 1000);
  const memory = process.memoryUsage();
  const server = describeServerContract(deps.config);
  const authMode = deps.config.auth?.enabled === true
    ? "session"
    : deps.config.server?.api_key
      ? "api_key"
      : process.env.NYXHIVE_INSECURE === "true"
        ? "insecure_read_only"
        : "blocked";

  checks.push(makeCheck(
    "server.contract",
    "Server contract",
    server.warnings.length > 0 ? "warn" : "ok",
    server.warnings.length > 0 ? server.warnings.join(" ") : "Server URLs are configured.",
    {
      baseUrl: server.base_url,
      mcpUrl: server.mcp_url,
      relayCallbackUrl: server.relay_callback_url,
      publicUrlConfigured: server.public_url_configured,
      remoteContractReady: server.remote_contract_ready,
    },
  ));

  checks.push(makeCheck(
    "auth.mode",
    "Authentication",
    authMode === "blocked" ? "error" : authMode === "insecure_read_only" ? "warn" : "ok",
    authMode === "blocked"
      ? "No API authentication is configured and insecure mode is not enabled."
      : authMode === "insecure_read_only"
        ? "NYXHIVE_INSECURE=true allows unauthenticated read-only API access."
        : `Gateway is protected by ${authMode} auth.`,
    { mode: authMode },
  ));

  const trustPosture = collectTrustPosture(deps.config);
  checks.push(makeCheck(
    "trust.posture",
    "Trust posture",
    trustPosture.status,
    trustPosture.summary,
    trustPosture.details,
  ));

  const providerStatus = typeof deps.providerRouter?.getHealthStatus === "function"
    ? deps.providerRouter.getHealthStatus()
    : {};
  const erroredProviders = Object.entries(providerStatus).filter(([, status]) => status === "error");
  checks.push(makeCheck(
    "providers",
    "Providers",
    erroredProviders.length > 0 ? "error" : "ok",
    erroredProviders.length > 0
      ? `${erroredProviders.length} provider circuit(s) are open.`
      : `${Object.keys(providerStatus).length} provider circuit(s) ready.`,
    { providers: providerStatus },
  ));

  const queueHealth = typeof deps.queue?.getQueueHealth === "function"
    ? deps.queue.getQueueHealth({ deadLetterLimit: 10 })
    : undefined;
  const staleRunning = typeof deps.runs?.getStaleRunningCount === "function"
    ? deps.runs.getStaleRunningCount()
    : 0;
  if (queueHealth) {
    const queueWarns = [
      queueHealth.dead_letters.total > 0,
      queueHealth.stale_processing.length > 0,
      queueHealth.stale_pending.length > 0,
      staleRunning > 0,
    ].filter(Boolean).length;
    checks.push(makeCheck(
      "queue",
      "Queue",
      queueWarns > 0 ? "warn" : "ok",
      queueWarns > 0
        ? "Queue has dead letters, stale messages, or stale running delegation records."
        : "Queue is clear of dead letters and stale work.",
      {
        stats: queueHealth.stats,
        deadLetters: queueHealth.dead_letters.total,
        retryableDeadLetters: queueHealth.dead_letters.retryable,
        staleProcessing: queueHealth.stale_processing.length,
        stalePending: queueHealth.stale_pending.length,
        staleRunning,
      },
    ));
  }

  const registryEntries = typeof deps.registry?.getAllEntries === "function"
    ? deps.registry.getAllEntries(true)
    : undefined;
  const runningAgents = typeof deps.registry?.getRunningAgents === "function"
    ? deps.registry.getRunningAgents()
    : undefined;
  const configuredAgents = deps.config.agents ?? {};
  const configuredAgentCount = Object.keys(configuredAgents).length;
  const registeredAgentCount = registryEntries?.size ?? configuredAgentCount;
  checks.push(makeCheck(
    "agents",
    "Agents",
    registeredAgentCount > 0 ? "ok" : "warn",
    registeredAgentCount > 0
      ? `${registeredAgentCount} agent(s) configured.`
      : "No agents are registered.",
    {
      registered: registeredAgentCount,
      running: runningAgents?.size ?? 0,
      primaryAgent: deps.config.daemon?.primary_agent ?? null,
    },
  ));

  const schedulerTasks = typeof deps.scheduler?.listTasks === "function"
    ? deps.scheduler.listTasks(true)
    : undefined;
  if (deps.scheduler) {
    const failingTasks = (schedulerTasks ?? []).filter((task) => (task.consecutive_failures ?? 0) > 0);
    checks.push(makeCheck(
      "scheduler",
      "Scheduler",
      failingTasks.length > 0 ? "warn" : "ok",
      failingTasks.length > 0
        ? `${failingTasks.length} scheduled task(s) have consecutive failures.`
        : `${schedulerTasks?.length ?? 0} scheduled task(s) loaded.`,
      {
        tasks: schedulerTasks?.length ?? 0,
        failingTasks: failingTasks.map((task) => ({
          id: task.id,
          name: task.name,
          failures: task.consecutive_failures,
          lastError: task.last_error,
        })),
      },
    ));
  }

  const connectionStats = typeof deps.connections?.getStats === "function"
    ? deps.connections.getStats()
    : undefined;
  if (connectionStats) {
    checks.push(makeCheck(
      "websocket",
      "WebSocket",
      connectionStats.bufferedMessages > 100 ? "warn" : "ok",
      `${connectionStats.connected} active connection(s), ${connectionStats.bufferedMessages} buffered event(s).`,
      connectionStats,
    ));
  }

  const wsMetrics = deps.wsRouter?.getMetrics?.() ?? [];
  const failedMethods = wsMetrics.filter((metric) => metric.failures > 0);
  if (deps.wsRouter) {
    checks.push(makeCheck(
      "ws.methods",
      "WebSocket methods",
      failedMethods.length > 0 ? "warn" : "ok",
      failedMethods.length > 0
        ? `${failedMethods.length} WebSocket method(s) have recorded handler errors.`
        : `${deps.wsRouter.listMethods?.().length ?? 0} WebSocket method(s) registered.`,
      {
        registered: deps.wsRouter.listMethods?.() ?? [],
        failures: failedMethods.map((metric) => ({
          method: metric.method,
          failures: metric.failures,
          lastError: metric.lastError,
          lastCalledAt: metric.lastCalledAt,
        })),
      },
    ));
  }

  const status = summarizeStatus(checks);

  return {
    status,
    ok: status === "ok",
    generatedAt: Date.now(),
    uptime_seconds: uptimeSeconds,
    instanceName: deps.config.daemon?.name,
    version: "0.1.0",
    checks,
    warnings: checks.filter((check) => check.status === "warn").map((check) => check.summary),
    errors: checks.filter((check) => check.status === "error").map((check) => check.summary),
    server,
    auth: { mode: authMode },
    trust: trustPosture.details,
    providers: providerStatus,
    queue: queueHealth ? {
      ...queueHealth,
      stale_running: staleRunning,
      queueDepth: queueHealth.stats.pending,
      processing: queueHealth.stats.processing,
      deadLetters: queueHealth.dead_letters.total,
      retryableDeadLetters: queueHealth.dead_letters.retryable,
      staleProcessing: queueHealth.stale_processing.length,
      stalePending: queueHealth.stale_pending.length,
      staleRunning,
    } : undefined,
    agents: {
      count: registeredAgentCount,
      names: Object.keys(configuredAgents),
      running: runningAgents?.size ?? 0,
    },
    scheduler: schedulerTasks ? {
      tasks: schedulerTasks.length,
      failing: schedulerTasks.filter((task) => (task.consecutive_failures ?? 0) > 0).length,
    } : undefined,
    connections: connectionStats,
    wsMethods: {
      registered: deps.wsRouter?.listMethods?.() ?? [],
      metrics: wsMetrics,
    },
    memory: {
      rss_mb: Math.round(memory.rss / 1024 / 1024 * 10) / 10,
      heap_used_mb: Math.round(memory.heapUsed / 1024 / 1024 * 10) / 10,
      heap_total_mb: Math.round(memory.heapTotal / 1024 / 1024 * 10) / 10,
      external_mb: Math.round(memory.external / 1024 / 1024 * 10) / 10,
    },
  };
}
