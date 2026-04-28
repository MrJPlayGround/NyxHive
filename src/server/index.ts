import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { logger } from "../utils/logger.js";
import { clampInt } from "../utils/parse.js";
import { messagesRoutes } from "./routes/messages.js";
import { queueRoutes } from "./routes/queue.js";
import { memoryRoutes, graphMemoryRoutes } from "./routes/memory.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { usageRoutes } from "./routes/usage.js";
import { agentsRoutes } from "./routes/agents.js";
import { teamsRoutes } from "./routes/teams.js";
import { tracesRoutes } from "./routes/traces.js";
import { schedulerRoutes } from "./routes/scheduler.js";
import { logsRoutes } from "./routes/logs.js";
import { settingsRoutes } from "./routes/settings.js";
import { configRoutes } from "./routes/config.js";
import { tasksRoutes } from "./routes/tasks.js";
import { createSSEStream } from "./sse.js";
import { rateLimiter } from "./middleware/rate-limit.js";
import { originCheck } from "./middleware/origin-check.js";
import { authRoutes, userAdminRoutes } from "./routes/auth.js";
import { adminOnly, canRead } from "./middleware/rbac.js";
import { csrfProtection } from "./middleware/csrf.js";
import { AuthStore } from "../auth/store.js";
import type { AuthContext, AuthEnv } from "../auth/types.js";
import type { QueueProcessor } from "../queue/processor.js";
import type { QueueDB } from "../queue/db.js";
import type { PairingStore } from "../pairing/pairing.js";
import type { MemoryStore } from "../memory/store.js";
import type { KnowledgeStore } from "../memory/knowledge.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import type { TraceStore } from "../memory/traces.js";
import type { GraphMemory } from "../memory/graph.js";
import type { NyxHiveConfig, SSEEvent } from "../types.js";
import type { Scheduler } from "../scheduler/index.js";
import type { TaskStore } from "../tasks/store.js";
import type { DaemonRuntime } from "../setup/discord.js";
import { attachDiscord } from "../setup/discord.js";
import type { AuditLog } from "../utils/audit.js";
import type { ProviderRouter } from "../providers/router.js";
import type { AgentRegistry } from "../agents/registry.js";
import { memoryBankRoutes } from "./routes/memory-bank.js";
import { devRoutes } from "./routes/dev.js";
import { DevPlanStore } from "../development/plan.js";
import { FeedbackStore } from "../memory/feedback.js";
import { feedbackRoutes } from "./routes/feedback.js";
import type { ProposalStore } from "../proposals/store.js";
import { proposalRoutes } from "./routes/proposals.js";
import { proposalsBatchRoutes } from "./routes/proposals-batch.js";
import { statusRoutes } from "./routes/status.js";
import { tradingRoutes } from "./routes/trading.js";
import { briefingRoutes } from "./routes/briefing.js";
import { themeRoutes } from "./routes/theme.js";
import { iosChannelRoutes } from "./routes/ios-channels.js";
import { channelsRoutes } from "./routes/channels.js";
import type { iOSChannel } from "../channels/ios.js";
import { webhookRoutes } from "./routes/webhooks.js";
import type { WebhookChannel } from "../channels/webhook.js";
import { threadRoutes } from "./routes/threads.js";
import { sessionRoutes } from "./routes/sessions.js";
import { projectRoutes } from "./routes/projects.js";
import { threadEventRoutes } from "./routes/thread-events.js";
import { btwSteerRoutes } from "./routes/btw-steer.js";
import { instanceRoutes } from "./routes/instance.js";
import { devicesRoutes } from "./routes/devices.js";
import { proceduralSkillsRoutes } from "./routes/procedural-skills.js";
import { ThreadDB } from "./db/threads.js";
import { mcpRoutes } from "../mcp/server.js";
import { CoordinationStore } from "../mcp/coordination.js";
import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { ConnectionManager, DeviceStore, MethodRouter, createWebSocketHandler, registerHandlers } from "./ws/index.js";
import type { WsData } from "./ws/index.js";
import type { CrawlIngestBridge, CrawlService, CrawlSourceStore } from "../crawl/index.js";
import { describeServerContract, resolveMcpEndpointUrl, resolveServerBaseUrl } from "./urls.js";
import { RELAY_PRESENTING_INSTANCE_HEADER, type RelayCallbackManager } from "../federation/relay.js";
import { relayRoutes } from "./routes/relay.js";
import { runsRoutes } from "./routes/runs.js";
import type { DelegationRunStore } from "../runs/store.js";
import { recordShutdownRequest } from "../utils/shutdown.js";
import type { ProceduralSkillDraftStore } from "../memory/procedural-skills.js";
import type { CompiledKnowledgeStore } from "../memory/compiled-knowledge.js";
import { collectGatewayHealth } from "./gateway-health.js";
import { usesLargeMessageBodyLimit } from "./body-limits.js";

export interface ServerOptions {
  config: NyxHiveConfig;
  processor: QueueProcessor;
  queue: QueueDB;
  pairing?: PairingStore;
  memory?: MemoryStore;
  knowledge?: KnowledgeStore;
  embedder?: EmbeddingProvider;
  traces?: TraceStore;
  graphMemory?: GraphMemory;
  runtime?: DaemonRuntime;
  scheduler?: Scheduler;
  taskStore?: TaskStore;
  audit?: AuditLog;
  router?: ProviderRouter;
  registry?: AgentRegistry;
  iosChannel?: iOSChannel;
  proposalStore?: ProposalStore;
  webhookChannel?: WebhookChannel;
  crawlService?: CrawlService;
  crawlSources?: CrawlSourceStore;
  crawlIngest?: CrawlIngestBridge;
  tradingDb?: import("../trading/db.js").TradingDB;
  configPath?: string;
  instanceSoulsDir?: string;
  relayCallbacks?: RelayCallbackManager;
  runs?: DelegationRunStore;
  proceduralSkills?: ProceduralSkillDraftStore;
  compiledKnowledge?: CompiledKnowledgeStore;
}

export const DEFAULT_WORKSPACE_UI_URL = "http://localhost:3777/";

function normalizeWorkspaceUiUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_WORKSPACE_UI_URL;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function resolveWorkspaceUiUrl(): string {
  return normalizeWorkspaceUiUrl(
    process.env.NYX_WORKSPACE_PUBLIC_URL
      || process.env.NYX_WORKSPACE_URL
      || process.env.NYX_WORKSPACE_APP_URL,
  );
}

export function buildWorkspaceRedirectUrl(path: string, query: string, workspaceUrl = resolveWorkspaceUiUrl()): string {
  const base = normalizeWorkspaceUiUrl(workspaceUrl);
  const cleanPath = path.startsWith("/assets/") || path === "/favicon.ico"
    ? ""
    : path.replace(/^\/+/, "");
  const target = new URL(cleanPath, base);
  if (query) target.search = query.startsWith("?") ? query : `?${query}`;
  return target.toString();
}

function isServiceRoutePath(path: string): boolean {
  return path === "/api"
    || path.startsWith("/api/")
    || path === "/v1"
    || path.startsWith("/v1/")
    || path === "/ws"
    || path.startsWith("/ws/")
    || path === "/webhooks"
    || path.startsWith("/webhooks/");
}

export function registerRetiredGatewayUiRoutes(app: Hono<any>): void;
export function registerRetiredGatewayUiRoutes(app: Hono<any>, workspaceUrl: string): void;
export function registerRetiredGatewayUiRoutes(app: Hono<any>, workspaceUrl = resolveWorkspaceUiUrl()): void {
  app.get("*", (c) => {
    const path = c.req.path;
    if (isServiceRoutePath(path)) {
      return c.json({
        error: "Not found",
        message: "Unknown service route. The legacy gateway UI is retired; use the workspace UI for browser access.",
        workspace_url: normalizeWorkspaceUiUrl(workspaceUrl),
      }, 404);
    }

    const target = buildWorkspaceRedirectUrl(path, c.req.url.split("?")[1] ?? "", workspaceUrl);
    return c.redirect(target, 308);
  });
}

export function createServer(
  opts: ServerOptions,
): { app: Hono<AuthEnv>; start: () => void; stop: () => void; authStore?: AuthStore; threadDb?: ThreadDB; connections?: ConnectionManager } {
  const {
    config,
    processor,
    queue,
    pairing,
    memory,
    knowledge,
    embedder,
    traces,
    graphMemory,
    runtime,
    scheduler,
    taskStore,
    audit,
    router,
    registry,
    iosChannel,
    proposalStore,
    webhookChannel,
    crawlService,
    crawlSources,
    crawlIngest,
    configPath,
    instanceSoulsDir,
    relayCallbacks,
    runs,
    proceduralSkills,
    compiledKnowledge,
  } = opts;
  const app = new Hono<AuthEnv>();
  const startTime = Date.now();
  const runtimeBaseDir = configPath ? dirname(configPath) : process.cwd();

  // --- Thread DB (always initialized — threads are a core feature) ---
  const threadDbPath = join(config.daemon.data_dir, `${config.daemon.name ?? "nyxhive"}-threads.db`);
  const threadDbConn = new Database(threadDbPath);
  const threadDb = new ThreadDB(threadDbConn);

  // --- WebSocket infrastructure ---
  // DeviceStore gets its OWN connection — sharing threadDbConn caused SQLite
  // contention that starved CLI subprocess pipes during gateway authentication.
  const wsConnections = new ConnectionManager();
  const deviceDbConn = new Database(threadDbPath);
  const deviceStore = new DeviceStore(deviceDbConn);
  const wsRouter = new MethodRouter();
  const wsHandler = createWebSocketHandler({ connections: wsConnections, devices: deviceStore, router: wsRouter });

  // --- Auto-create projects from config ---
  if (config.daemon.projects?.length) {
    const instanceName = config.daemon.name;
    const existing = threadDb.listProjects().filter(p => p.instance === instanceName);
    const existingNames = new Set(existing.map(p => p.name));

    for (const proj of config.daemon.projects) {
      if (!existingNames.has(proj.name)) {
        threadDb.createProject({
          name: proj.name,
          instance: instanceName,
          repo_path: proj.repo_path,
        });
        logger.info(`[server] Created project '${proj.name}' for ${instanceName}`);
      }
    }

    // Backfill threads with NULL project_id to the default project
    const defaultProj = config.daemon.projects.find(p => p.default);
    if (defaultProj) {
      const dbProjects = threadDb.listProjects().filter(p => p.instance === instanceName);
      const dbDefault = dbProjects.find(p => p.name === defaultProj.name);
      if (dbDefault) {
        const result = threadDbConn.run(
          "UPDATE threads SET project_id = ? WHERE project_id IS NULL AND instance = ?",
          [dbDefault.id, instanceName],
        );
        if (result.changes > 0) {
          logger.info(`[server] Backfilled ${result.changes} threads to project '${defaultProj.name}'`);
        }
      }
    }
  }

  // --- Auth store (created when auth.enabled) ---
  const authEnabled = config.auth?.enabled === true;
  let authStore: AuthStore | undefined;

  if (authEnabled) {
    const dbPath = join(config.daemon.data_dir, `${config.daemon.name ?? "nyxhive"}.db`);
    const authDb = new Database(dbPath);
    authDb.exec("PRAGMA journal_mode = WAL");
    const walCheck = authDb.query("PRAGMA journal_mode").get() as { journal_mode: string } | null;
    if (walCheck?.journal_mode !== "wal") {
      logger.warn(`[server] Auth DB WAL mode not active (journal_mode=${walCheck?.journal_mode}), performance may be degraded`);
    }
    authDb.exec("PRAGMA busy_timeout = 5000");
    authStore = new AuthStore(authDb);
    logger.info("[server] Auth enabled — session + API key dual auth active");
  }

  // CORS
  const allowedOrigins = config?.server?.allowed_origins ?? ["http://localhost:3000"];
  app.use("*", cors({ origin: allowedOrigins }));
  if (!config?.server?.allowed_origins) {
    logger.warn("[server] CORS: no allowed_origins configured, defaulting to http://localhost:3000");
  }

  // Origin validation — reject state-changing requests from untrusted origins (defense in depth over CORS)
  app.use("/api/*", originCheck(allowedOrigins));

  // Security headers (CSP, etc.)
  app.use("*", async (c, next) => {
    await next();
    // Only add CSP to HTML responses (gateway SPA)
    const ct = c.res.headers.get("content-type") ?? "";
    if (ct.includes("text/html")) {
      c.res.headers.set("Content-Security-Policy", [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",  // Tailwind injects inline styles
        "img-src 'self' data: blob:",
        "connect-src 'self' ws: wss:",
        "font-src 'self' https://fonts.gstatic.com",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join("; "));
      c.res.headers.set("X-Content-Type-Options", "nosniff");
      c.res.headers.set("X-Frame-Options", "DENY");
      c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    }
  });

  // Global error handler — catches unhandled exceptions in routes
  app.onError((err, c) => {
    logger.error(`[server] Unhandled error: ${err.message}`);
    return c.json({ error: "Internal server error" }, 500);
  });

  // 404 handler
  app.notFound((c) => c.json({ error: "Not found" }, 404));

  // Health (unauthenticated)
  app.get("/api/info", (c) =>
    c.json({
      name: config.daemon.name,
      version: "0.1.0",
      status: "running",
      agents: Object.keys(config.agents),
      teams: Object.keys(config.teams ?? {}),
      server: describeServerContract(config),
    }),
  );
  const getGatewayHealth = () => collectGatewayHealth({
    config,
    startTime,
    queue,
    providerRouter: router,
    registry,
    scheduler,
    runs,
    connections: wsConnections,
    wsRouter,
  });

  app.get("/health", (c) => {
    const health = getGatewayHealth();
    return c.json(health, health.status === "error" ? 503 : 200);
  });


  // Instance discovery (unauthenticated)
  app.route("/instance", instanceRoutes(config, registry));

  // --- Auth status endpoint (unauthenticated, before auth middleware) ---
  if (authStore) {
    app.get("/api/auth/status", (c) => {
      return c.json({ auth_enabled: true, has_users: authStore!.getUserCount() > 0 });
    });
  } else {
    app.get("/api/auth/status", (c) => {
      return c.json({ auth_enabled: false });
    });
  }

  if (relayCallbacks) {
    app.use("/api/relay/*", async (c, next) => {
      const token = c.req.header("X-NyxRelay-Token")?.trim();
      const presentedBy = c.req.header(RELAY_PRESENTING_INSTANCE_HEADER)?.trim();
      if (!token) return c.json({ error: "Missing relay token" }, 401);
      if (!relayCallbacks.validate(token, presentedBy)) {
        return c.json({ error: "Invalid relay token" }, 401);
      }
      c.set("auth", { type: "api_key", role: "owner" } as AuthContext);
      await next();
    });
  }

  // --- Authentication middleware ---
  const apiKey = config.server.api_key;

  if (authEnabled && authStore) {
    // Dual auth: API key OR session token
    app.use("/api/*", async (c, next) => {
      if (c.get("auth")) return next();
      // Skip auth for register/login (handled by auth routes themselves)
      const path = c.req.path;
      if (path === "/api/auth/register" || path === "/api/auth/login" || path === "/api/auth/status") {
        return next();
      }

      const token = c.req.header("Authorization")?.replace("Bearer ", "");
      if (!token) {
        return c.json({ error: "Authentication required" }, 401);
      }

      // Check API key first (backward compatible)
      if (apiKey && token === apiKey) {
        c.set("auth", { type: "api_key", role: "owner" } as AuthContext);
        return next();
      }

      // Check session token (with IP binding)
      const clientIp = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
        || c.req.header("x-real-ip")
        || undefined;
      const user = authStore!.validateSession(token, { ip: clientIp });
      if (user) {
        c.set("auth", { type: "session", user, role: user.role } as AuthContext);
        return next();
      }

      return c.json({ error: "Invalid credentials" }, 401);
    });
  } else if (apiKey) {
    // Legacy: API key only
    app.use("/api/*", async (c, next) => {
      if (c.get("auth")) return next();
      const auth = c.req.header("Authorization");
      if (auth !== `Bearer ${apiKey}`) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      // Set auth context for legacy mode (owner-level access)
      c.set("auth", { type: "api_key", role: "owner" } as AuthContext);
      await next();
    });
  } else {
    // Read-only endpoints allowed in insecure mode
    const INSECURE_READ_ONLY_PREFIXES = [
      "/api/queue", "/api/agents", "/api/teams", "/api/status",
      "/api/briefing", "/api/logs", "/api/settings", "/api/theme",
      "/api/traces", "/api/usage", "/api/info", "/api/auth/status",
      "/api/events", "/api/threads", "/api/projects",
    ];

    if (process.env.NYXHIVE_INSECURE === "true") {
      logger.warn("[server] NYXHIVE_INSECURE=true — read-only API routes are unauthenticated. Do not expose this to the internet.");
      logger.warn("[server] Mutable endpoints (message, scheduler, proposals, dev, mcp) require auth even in insecure mode.");
      app.use("/api/*", async (c, next) => {
        if (c.get("auth")) return next();
        const path = c.req.path;
        const allowed = INSECURE_READ_ONLY_PREFIXES.some(p => path === p || path.startsWith(`${p}/`));
        if (!allowed) {
          return c.json({ error: "Endpoint not available in insecure mode. Set server.api_key or enable auth." }, 403);
        }
        c.set("auth", { type: "api_key", role: "viewer" } as AuthContext);
        await next();
      });
    } else {
      // No auth and no explicit insecure flag — block all API routes
      logger.error("[server] No authentication configured. Set server.api_key, enable auth, or set NYXHIVE_INSECURE=true for local dev.");
      app.use("/api/*", async (c, next) => {
        if (c.get("auth")) return next();
        return c.json({ error: "No authentication configured. Set server.api_key in config.toml, enable auth, or set NYXHIVE_INSECURE=true." }, 403);
      });
    }
  }

  // SSE — behind auth
  app.get("/api/events", () =>
    createSSEStream((listener) => processor.onEvent(listener)),
  );

  // Body size limit: 50MB for message route (file uploads), 1MB for everything else
  const messageBodyLimit = bodyLimit({ maxSize: 50 * 1024 * 1024 });
  const defaultBodyLimit = bodyLimit({ maxSize: 1024 * 1024 });
  app.use("/api/*", (c, next) => {
    if (usesLargeMessageBodyLimit(c.req.path)) {
      return messageBodyLimit(c, next);
    }
    return defaultBodyLimit(c, next);
  });
  const rpm = config?.server?.rate_limit_rpm ?? 60;
  app.use("/api/*", rateLimiter({ maxRequests: rpm }));

  // CSRF protection on state-changing API requests (session auth only, API keys exempt)
  if (authEnabled) {
    app.use("/api/*", csrfProtection());
  }

  // --- Auth routes (only when auth enabled) ---
  if (authStore) {
    app.route("/api/auth", authRoutes(authStore));
    app.use("/api/users/*", adminOnly);
    app.route("/api/users", userAdminRoutes(authStore));
  }

  // Core routes
  app.route("/api/message", messagesRoutes(processor, queue, {
    requestTimeoutMs: config?.server?.request_timeout_ms,
    crawlService,
    crawlSources,
    crawlIngest,
    runs: runs ?? undefined,
  }));
  if (relayCallbacks) {
    app.route("/api/relay", relayRoutes(processor, relayCallbacks));
  }
  app.route("/api/queue", queueRoutes(queue, runs ?? undefined));
  if (runs) {
    app.route("/api/runs", runsRoutes(runs));
  }
  app.route("/api/agents", agentsRoutes(config, registry, traces, instanceSoulsDir));
  app.route("/api/agents", btwSteerRoutes(processor));
  app.route("/api/teams", teamsRoutes(config));

  // Memory & knowledge
  if (memory) {
    app.route("/api/memory", memoryRoutes(memory));
    app.route("/api/usage", usageRoutes(memory, traces, registry));
  }
  if (knowledge) {
    app.route("/api/knowledge", knowledgeRoutes(knowledge, embedder, config, compiledKnowledge));
  }
  if (memory) {
    const feedbackStore = new FeedbackStore(memory.getDb());
    app.route("/api/feedback", feedbackRoutes(feedbackStore));
  }
  if (traces) {
    app.route("/api/traces", tracesRoutes(traces));
  }
  if (graphMemory) {
    app.route("/api/memory/graph", graphMemoryRoutes(graphMemory));
  }
  if (graphMemory && memory && knowledge) {
    app.route("/api/memory/bank", memoryBankRoutes(graphMemory, memory, knowledge));
  }
  if (scheduler) {
    app.route("/api/scheduler", schedulerRoutes(scheduler));
  }
  app.route("/api/status", statusRoutes(processor, traces, config, {
    config,
    startTime,
    queue,
    providerRouter: router,
    registry,
    scheduler,
    runs,
    connections: wsConnections,
    wsRouter,
  }));
  if (scheduler) {
    app.route("/api/briefing", briefingRoutes(scheduler));
  }

  // Dev loop
  if (memory && registry) {
    const devPlanStore = new DevPlanStore(memory.getDb());
    processor.setDevPlanStore(devPlanStore);
    app.route("/api/dev", devRoutes(devPlanStore, processor, registry, memory, config));
  }

  // Logs, settings, theme, tasks
  app.route("/api/logs", logsRoutes(config.daemon.data_dir, config.daemon.name));
  app.route("/api/settings", settingsRoutes(config));
  app.route("/api/config", configRoutes(config));
  app.route("/api/theme", themeRoutes(config));
  app.route("/api/channels", channelsRoutes(processor));
  if (opts.tradingDb) {
    app.route("/api/trading", tradingRoutes(opts.tradingDb));
  }
  if (iosChannel) {
    app.route("/api/channels/ios", iosChannelRoutes(iosChannel));
  }
  if (webhookChannel) {
    app.route("/webhooks", webhookRoutes(webhookChannel));
  }
  if (taskStore) {
    app.route("/api/tasks", tasksRoutes(taskStore));
  }
  if (proposalStore) {
    app.route("/api/proposals", proposalRoutes(proposalStore, processor, scheduler));
    app.route("/api/proposals/batch", proposalsBatchRoutes(proposalStore));
  }
  if (proceduralSkills) {
    app.route("/api/skills/procedural", proceduralSkillsRoutes(proceduralSkills));
  }

  // MCP server
  const logFileName = `${(config.daemon.name ?? "instance").toLowerCase()}.log`;
  const coordination = memory ? new CoordinationStore(memory.getDb()) : undefined;
  const slackBotToken = config.slack?.bot_token_env ? process.env[config.slack.bot_token_env] : undefined;
  app.route("/api/mcp", mcpRoutes({
    queue, processor, proposalStore, registry, traces,
    knowledge, embedder, threadDb, scheduler, memory, graph: graphMemory,
    logPath: join(config.daemon.data_dir, logFileName),
    vaultPath: config.vault?.path,
    projects: config.daemon.projects,
    coordination,
    routing: processor.getRouting(),
    activeDelegations: processor.getActiveDelegations(),
    instanceName: config.daemon.name,
    crawlService,
    crawlSources,
    crawlIngest,
    remotes: config.remotes,
    slackBotToken,
    tradingDb: opts.tradingDb,
  }));

  // Threads & projects
  const instanceName = config.daemon.name ?? "nyxhive";
  app.route("/api", threadRoutes(threadDb, processor, queue, instanceName, config, runtimeBaseDir));
  app.route("/api/sessions", sessionRoutes(threadDb, processor, instanceName, {
    runs: runs ?? undefined,
  }));
  app.route("/api", projectRoutes(threadDb));
  app.route("/api", threadEventRoutes(threadDb, processor));

  // Audit log query endpoint
  if (audit) {
    app.get("/api/audit", adminOnly, (c) => {
      const limit = clampInt(c.req.query("limit"), 100, 1, 1000);
      const channel = c.req.query("channel") || undefined;
      const event = c.req.query("event") || undefined;
      const since = c.req.query("since") ? Number(c.req.query("since")) : undefined;
      return c.json(audit.query({ limit, channel, event, since }));
    });
  }

  // Device management (gateway WebSocket devices)
  app.route("/api/devices", devicesRoutes(deviceStore, wsConnections));

  // Pairing
  if (pairing) {
    app.get("/api/pairing", adminOnly, (c) =>
      c.json({ approved: pairing.listApproved(), pending: pairing.listPending() }),
    );
    app.post("/api/pairing/approve", adminOnly, async (c) => {
      const { code } = await c.req.json<{ code: string }>();
      if (!code) return c.json({ error: "code is required" }, 400);
      const result = pairing.approve(code);
      if (!result) return c.json({ error: "invalid or expired code" }, 404);
      return c.json({ approved: result });
    });
    app.post("/api/pairing/revoke", adminOnly, async (c) => {
      const { channel, sender_id } = await c.req.json<{ channel: string; sender_id: string }>();
      if (!channel || !sender_id) return c.json({ error: "channel and sender_id required" }, 400);
      return c.json({ revoked: pairing.revoke(channel, sender_id) });
    });
  }

  // Graceful shutdown (admin only)
  app.post("/api/admin/shutdown", adminOnly, async (c) => {
    const caller = c.req.header("x-forwarded-for")
      ?? c.req.header("x-real-ip")
      ?? "unknown";
    recordShutdownRequest("api/admin/shutdown", `caller=${caller}`);
    logger.warn(`[shutdown] API shutdown requested by ${caller}`);
    // Send SIGTERM to self, which will trigger the signal handlers in index.ts
    const response = c.json({ status: "shutting down" });
    // Schedule shutdown after response is sent
    setTimeout(() => {
      process.kill(process.pid, "SIGTERM");
    }, 100);
    return response;
  });

  // Channel setup
  if (runtime) {
    app.post("/api/setup/discord", adminOnly, async (c) => {
      const { bot_token } = await c.req.json<{ bot_token: string }>();
      if (!bot_token) return c.json({ error: "bot_token is required" }, 400);

      const result = await attachDiscord(runtime, bot_token);
      if (!result.success) return c.json({ error: result.error }, 400);

      return c.json({
        status: "attached",
        tag: result.tag,
        invite_url: result.inviteUrl,
      });
    });

    app.get("/api/setup/status", canRead, (c) => {
      return c.json({
        channels: runtime.channels.map((ch) => ch.name),
        discord: !!runtime.config.discord,
        telegram: !!runtime.config.telegram,
      });
    });
  }

  // Response polling
  app.get("/api/responses/pending", canRead, (c) => {
    const channel = c.req.query("channel");
    const limit = clampInt(c.req.query("limit"), 50, 1, 200);
    const responses = channel
      ? queue.getResponsesForChannel(channel, limit)
      : queue.getPendingResponses(limit);
    return c.json(responses);
  });

  // The old gateway SPA is retired. Browser routes on the backend should point
  // to the workspace UI instead of serving stale dist/gateway assets.
  registerRetiredGatewayUiRoutes(app);

  // --- Register WebSocket method handlers ---
  registerHandlers(wsRouter, {
    threadDb,
    processor,
    queue,
    proposalStore,
    taskStore,
    registry,
    traces,
    knowledge,
    compiledKnowledge,
    embedder,
    memory,
    scheduler,
    connections: wsConnections,
    devices: deviceStore,
    audit,
    config,
    configPath: configPath ?? "",
    graphMemory,
    proceduralSkills,
    router,
    crawlService,
    crawlSources,
    crawlIngest,
    runs,
    startTime,
    wsRouter,
  });

  // Bridge processor events to WebSocket broadcasts
  processor.onEvent((event: SSEEvent) => {
    try {
      wsConnections.broadcast(event.type, event);
    } catch (err) {
      logger.warn(`[ws] Broadcast error: ${err}`);
    }
  });

  // Bridge thread-scoped events to WebSocket (e.g. thread:update for auto-generated titles)
  processor.onGlobalThreadEvent((event) => {
    try {
      wsConnections.broadcast(event.type, { threadId: event.thread_id, ...event.data });
    } catch (err) {
      logger.warn(`[ws] Thread event broadcast error: ${err}`);
    }
  });

  // Bridge logger to WebSocket for live log streaming
  logger.onLog((level, message, module) => {
    wsConnections.broadcastToSubscribed("log:entry", {
      level,
      message,
      module,
      timestamp: Date.now(),
    });
  });

  let serverInstance: ReturnType<typeof Bun.serve> | null = null;

  const start = () => {
    const port = config.server.port;
    const MAX_PORT_RETRIES = 5;
    const PORT_RETRY_DELAY_MS = 2000;

    const tryBind = (attempt: number): ReturnType<typeof Bun.serve> => {
      try {
        return Bun.serve({
          port,
          fetch(req, server) {
            // WebSocket upgrade for /ws path
            if (new URL(req.url).pathname === "/ws") {
              const success = server.upgrade(req, {
                data: { deviceId: null, deviceName: null, authenticated: false, nonce: null } satisfies WsData,
              });
              if (success) return undefined;
              return new Response("WebSocket upgrade failed", { status: 400 });
            }
            return app.fetch(req, server);
          },
          websocket: {
            ...wsHandler,
            maxPayloadLength: 50 * 1024 * 1024, // 50MB max WS message (file uploads)
          },
          idleTimeout: 30,
        });
      } catch (err) {
        const msg = String(err);
        if ((msg.includes("EADDRINUSE") || msg.includes("already in use") || msg.includes("Failed to start")) && attempt < MAX_PORT_RETRIES) {
          logger.warn(`[server] Port ${port} in use, retrying in ${PORT_RETRY_DELAY_MS}ms (attempt ${attempt + 1}/${MAX_PORT_RETRIES})`);
          Bun.sleepSync(PORT_RETRY_DELAY_MS);
          return tryBind(attempt + 1);
        }
        throw err;
      }
    };

    serverInstance = tryBind(0);
    logger.info(`[server] Listening on http://localhost:${port}`);
    if (config.server.public_url) {
      logger.info(`[server] Public URL: ${resolveServerBaseUrl(config)}`);
    }
    logger.info(`[server] MCP endpoint for agents: ${resolveMcpEndpointUrl(config)}`);
    logger.info(`[server] WebSocket endpoint: ws://localhost:${port}/ws`);

    // Periodic session cleanup (every 6 hours)
    if (authStore) {
      setInterval(() => {
        const purged = authStore!.purgeExpiredSessions();
        if (purged > 0) logger.info(`[auth] Purged ${purged} expired sessions`);
      }, 6 * 60 * 60 * 1000);
    }

    // Periodic WS buffer cleanup (every 10 minutes) — prevents memory leak from disconnected devices
    setInterval(() => {
      wsConnections.cleanupBuffers();
    }, 10 * 60 * 1000);

    // WS keepalive ping (every 20s) — prevents Bun idleTimeout from killing idle connections
    setInterval(() => {
      wsConnections.pingAll();
    }, 20_000);
  };

  const stop = () => {
    serverInstance?.stop(true);
    serverInstance = null;
  };

  return { app, start, stop, authStore, threadDb, connections: wsConnections };
}
