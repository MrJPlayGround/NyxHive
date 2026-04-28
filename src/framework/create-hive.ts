// src/framework/create-hive.ts
// Factory function that assembles and returns a Hive instance.

import { Database } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync, readFileSync, existsSync } from "node:fs";
import { loadConfig, resolveEnvKey } from "../config.js";
import { logger } from "../utils/logger.js";
import { QueueDB } from "../queue/db.js";
import { QueueProcessor } from "../queue/processor.js";
import { createServer } from "../server/index.js";
import { PairingStore } from "../pairing/pairing.js";
import { MemoryStore } from "../memory/store.js";
import { KnowledgeStore } from "../memory/knowledge.js";
import { TraceStore } from "../memory/traces.js";
import { GraphMemory } from "../memory/graph.js";
import { OpenRouterEmbedding } from "../memory/embeddings.js";
import { ProviderRouter } from "../providers/router.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { OpenRouterProvider } from "../providers/openrouter.js";
import { resolveFromKeychain } from "../utils/anthropic-auth.js";
import type { Channel } from "../channels/types.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import type { ProviderName } from "../providers/types.js";
import { Scheduler } from "../scheduler/index.js";
import { TaskStore } from "../tasks/store.js";
import { ProposalStore } from "../proposals/store.js";
import { registerLearningListeners } from "../learning/index.js";
import { PatternStore } from "../memory/patterns.js";
import { OutcomeStore } from "../memory/outcomes.js";
import { RoutingStore } from "../memory/routing.js";
import { ProposalExecutor } from "../proposals/executor.js";
import { runReviewGate } from "../queue/review-gate.js";
import { ArtifactQueue } from "../queue/artifact-queue.js";
import type { DaemonRuntime } from "../setup/discord.js";
import { detectSandbox } from "../sandbox/index.js";
import { AuditLog } from "../utils/audit.js";
import { cleanupTempFiles } from "../agents/invoke.js";
import { closeSharedCodexAppServerHarness } from "../harness/codex-app-server.js";
import { cleanupStaleWorktrees } from "../agents/worktree.js";
import { cleanupBrowser, initBrowserProfile } from "../browser/launcher.js";
import { AgentRegistry } from "../agents/registry.js";
import { resolveCodexWritableDirectoryGrants } from "../agents/codex-directory-grants.js";
import { ingestVault, ingestFile } from "../memory/ingest.js";
import { VaultWatcher } from "../memory/watcher.js";
import { generateKnowledgeCanvas } from "../memory/obsidian.js";
import { CrawlIngestBridge, CrawlService, CrawlSourceStore } from "../crawl/index.js";
import { NotificationBatcher } from "../notifications/batcher.js";
import { ClassifierFeedbackStore } from "../soul/classifier-feedback.js";
import { FeedbackStore } from "../memory/feedback.js";
import { applyMainBrainOverride, resolvePrimaryAgentKey } from "../agents/primary.js";
import { initActivityStream } from "../activity/ring-buffer.js";
import { resolveNotificationTargets } from "../notifications/routing.js";
import { DEFAULT_LOCAL_CLASSIFIER_MODEL, DEFAULT_OLLAMA_URL } from "../defaults.js";
import { RelayCallbackManager } from "../federation/relay.js";
import { DelegationRunStore } from "../runs/store.js";
import { ProceduralSkillDraftStore } from "../memory/procedural-skills.js";
import { CompiledKnowledgeStore } from "../memory/compiled-knowledge.js";
import { primeSoulCache } from "../soul/runtime.js";
import { resolveConfiguredRemoteMcpEndpoints } from "../server/urls.js";
import { describeShutdownCause, noteShutdownSignal, resetShutdownTracking } from "../utils/shutdown.js";
import { ingestRestartProvenance } from "../runtime/restart-provenance.js";
import {
  buildAnthropicBootstrapWarning,
  resolveAnthropicBootstrapMethod,
  resolveClaudeConfigDir,
} from "./anthropic-auth-policy.js";

import type { HiveOptions, Hive, ChannelDeps } from "./types.js";
import type { NyxHiveConfig } from "../types.js";
import { assembleStores } from "./stores.js";
import { registerExtensionProviders, registerExtensionRoutes, resolveExtensionEmbedder } from "./extensions.js";

export function resolveOpenAIRestProviderMissingAuthLog(
  openaiConfig: NyxHiveConfig["providers"][string],
): { level: "info" | "warn"; message: string } {
  if (openaiConfig.auth_mode === "codex") {
    return {
      level: "info",
      message: "OpenAI REST provider skipped (auth_mode=codex; Codex CLI handles OpenAI runtime)",
    };
  }
  const keyName = openaiConfig.api_key_env ?? "OPENAI_API_KEY";
  return { level: "warn", message: `OpenAI not available: set ${keyName}.` };
}

export async function createHive(options: HiveOptions): Promise<Hive> {
  // --- Config ---
  const configPath = typeof options.config === "string"
    ? options.config
    : undefined;
  const config = typeof options.config === "string"
    ? loadConfig(options.config)
    : options.config;

  const name = config.daemon.name;
  const nameLower = name.toLowerCase();
  const instanceDir = configPath ? dirname(configPath) : process.cwd();
  const instanceSoulsDir = resolve(instanceDir, "souls");
  config.allowed_directories = resolveCodexWritableDirectoryGrants({
    baseDir: instanceDir,
    configuredDirectories: config.allowed_directories,
  });
  primeSoulCache(Object.keys(config.agents), undefined, instanceSoulsDir);

  // Load instance .env file — instance-specific tokens, keys, etc.
  const envPath = resolve(instanceDir, ".env");
  if (existsSync(envPath)) {
    try {
      const envContent = readFileSync(envPath, "utf-8");
      let loaded = 0;
      for (const line of envContent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        // Instance .env takes precedence — this is the whole point
        process.env[key] = value;
        loaded++;
      }
      if (loaded > 0) {
        logger.info(`[boot] Loaded ${loaded} env vars from ${envPath}`);
      }
    } catch (err) {
      logger.warn(`[boot] Failed to read .env at ${envPath}: ${err}`);
    }
  }

  // Resolve Claude login bootstrap from explicit config, env, or the instance's isolated profile.
  if (!config.daemon.claude_config_dir) {
    config.daemon.claude_config_dir = resolveClaudeConfigDir(config, process.env);
  }
  if (config.daemon.claude_config_dir) {
    logger.info(`Claude config: ${config.daemon.claude_config_dir}`);
  }

  // CLI mainBrain option takes precedence, then config.daemon.main_brain, then env var (handled inside applyMainBrainOverride)
  const effectiveBrain = options.mainBrain ?? config.daemon.main_brain;
  const brainOverride = applyMainBrainOverride(config.agents, config.daemon, effectiveBrain);
  config.agents = brainOverride.agents;
  if (brainOverride.primaryAgent && brainOverride.mainBrain) {
    const agent = config.agents[brainOverride.primaryAgent];
    const affected = brainOverride.affectedAgents?.filter((key) => key !== brainOverride.primaryAgent) ?? [];
    logger.info(
      `Main brain override: ${brainOverride.primaryAgent} -> ${brainOverride.mainBrain} (${agent.provider}/${agent.model}, cli=${agent.cli_fallback ?? "none"})${affected.length ? `; routed subagents: ${affected.join(", ")}` : ""}`,
    );
  }

  // --- Logging/PID ---
  logger.setLevel(config.daemon.log_level);
  const dataDir = config.daemon.data_dir;
  mkdirSync(dataDir, { recursive: true });
  initBrowserProfile(dataDir);
  logger.setLogFile(dataDir, nameLower);
  logger.setPrefix(nameLower);

  const pidFile = resolve(dataDir, "nyxhive.pid");

  // --- Stale PID notice ---
  // Never kill global Claude CLI processes here. A previous version matched
  // every `claude --dangerously-skip-permissions` process on the machine,
  // which also caught manual user sessions outside NyxHive workspaces.
  try {
    if (existsSync(pidFile)) {
      const oldPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        logger.warn(`[reaper] Found stale PID file from previous run (old PID ${oldPid}). Skipping global Claude cleanup on startup.`);
      }
    }
  } catch (err) {
    logger.warn(`[reaper] Stale PID check failed (non-fatal): ${err}`);
  }

  writeFileSync(pidFile, String(process.pid));

  logger.info(`${name} starting...`);
  logger.info(`${name} v0.1.0`);
  logger.info(`Data directory: ${dataDir}`);
  logger.info(`PID: ${process.pid}`);

  // --- Databases ---
  const queue = new QueueDB(dataDir, nameLower, { resetOrphansOnStartup: false });
  const runs = new DelegationRunStore(dataDir, nameLower);
  const memory = new MemoryStore(dataDir, "memory");
  const knowledge = new KnowledgeStore(dataDir, nameLower);
  const compiledKnowledge = new CompiledKnowledgeStore(new Database(resolve(dataDir, `${nameLower}_compiled_knowledge.db`)));

  // --- Trading DB ---
  let tradingDb: import("../trading/db.js").TradingDB | undefined;
  if (config.trading?.enabled) {
    const { TradingDB } = await import("../trading/db.js");
    tradingDb = new TradingDB(dataDir, nameLower, config.trading);
    logger.info("[boot] Trading desk enabled");
  }

  // --- Providers ---
  const router = new ProviderRouter({
    orchestrator_model: "claude-sonnet-4-6",
    orchestrator_provider: "anthropic",
    classifier_model: config.routing.classifier_model,
    classifier_provider: config.routing.classifier_provider as ProviderName,
    coding_model: "claude-sonnet-4-6",
    coding_provider: "anthropic",
    tasks: config.routing.tasks
      ? Object.fromEntries(
          Object.entries(config.routing.tasks).map(([taskType, route]) => [
            taskType,
            {
              provider: route.provider as ProviderName,
              model: route.model,
              max_tokens: route.max_tokens ?? 4096,
            },
          ]),
        )
      : undefined,
    fallback_order: config.routing.fallback_order as ProviderName[] | undefined,
  });

  // Anthropic
  try {
    const anthropicConfig = config.providers.anthropic;
    if (anthropicConfig) {
      const bootstrapMethod = resolveAnthropicBootstrapMethod(config, process.env);
      const supportedModels = ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-6"];

      if (bootstrapMethod === "api_key") {
        const apiKey = process.env[anthropicConfig.api_key_env!];
        router.registerProvider("anthropic", new AnthropicProvider(apiKey!, supportedModels, "apiKey"));
        logger.info("Anthropic provider registered (API key)");
      } else if (bootstrapMethod === "auth_token") {
        const authToken = process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN;
        router.registerProvider("anthropic", new AnthropicProvider(authToken!, supportedModels, "authToken"));
        logger.info("Anthropic provider registered (auth token)");
      } else if (bootstrapMethod === "keychain") {
        const claudeConfigDir = config.daemon.claude_config_dir!;
        const auth = await resolveFromKeychain(claudeConfigDir);
        router.registerProvider("anthropic", new AnthropicProvider(auth.authToken, supportedModels, "authToken"));
        logger.info("Anthropic provider registered (keychain internal fallback)");
      } else {
        logger.warn(buildAnthropicBootstrapWarning(config, process.env));
      }
    }
  } catch (err) {
    logger.warn(`Anthropic not available: ${err}`);
  }

  // OpenRouter
  try {
    const orConfig = config.providers.openrouter;
    if (orConfig) {
      const apiKey = resolveEnvKey(orConfig.api_key_env!);
      const models = ["deepseek/deepseek-v3.2", "xiaomi/mimo-v2-flash", "mistralai/mistral-medium-3", "qwen/qwen3-235b-a22b-2507", "meta-llama/llama-4-maverick", "openai/gpt-oss-120b"];
      router.registerProvider("openrouter", new OpenRouterProvider(apiKey, models, name));
      logger.info("OpenRouter provider registered");
    }
  } catch (err) {
    logger.warn(`OpenRouter not available: ${err}`);
  }

  // OpenAI REST provider
  try {
    const openaiConfig = config.providers.openai;
    if (openaiConfig) {
      const apiKey = openaiConfig.api_key_env ? process.env[openaiConfig.api_key_env] : undefined;
      if (apiKey) {
        const { OpenAIProvider } = await import("../providers/openai.js");
        const models = ["gpt-5.5", "gpt-5.4", "gpt-5.4-pro", "gpt-5-mini", "gpt-5-nano"];
        router.registerProvider("openai", new OpenAIProvider(apiKey, models));
        logger.info("OpenAI provider registered (API key)");
      } else {
        const missingAuthLog = resolveOpenAIRestProviderMissingAuthLog(openaiConfig);
        logger[missingAuthLog.level](missingAuthLog.message);
      }
    }
  } catch (err) {
    logger.warn(`OpenAI not available: ${err}`);
  }

  // Ollama (local inference — classification, heartbeat, escalation)
  try {
      const ollamaConfig = config.providers.ollama;
    if (ollamaConfig) {
      const { OllamaProvider } = await import("../providers/ollama.js");
      const url = ollamaConfig.url ?? DEFAULT_OLLAMA_URL;
      const model = ollamaConfig.model ?? DEFAULT_LOCAL_CLASSIFIER_MODEL;

      const health = await fetch(`${url}/api/tags`).catch(() => null);
      if (health?.ok) {
        const tags = await health.json().catch(() => null) as { models?: { name: string }[] } | null;
        const availableModels = tags?.models?.map((m) => m.name) ?? [model];
        router.registerProvider("ollama", new OllamaProvider(url, model, availableModels));
        logger.info(`Ollama provider registered (${availableModels.join(", ")} @ ${url})`);
      } else {
        logger.warn("Ollama not available: daemon not running");
      }
    }
  } catch (err) {
    logger.warn(`Ollama not available: ${err}`);
  }

  registerExtensionProviders(router, config, options.providers);

  // Embeddings
  let embedder: EmbeddingProvider | undefined;
  if (config.providers.openrouter) {
    try {
      const apiKey = resolveEnvKey(config.providers.openrouter.api_key_env!);
      embedder = new OpenRouterEmbedding(apiKey);
      logger.info("Embeddings available");
    } catch {
      logger.warn("Embeddings unavailable (no OpenRouter key)");
    }
  }
  embedder = resolveExtensionEmbedder(config, embedder, options.embedders);

  // Log dual-brain status
  if (brainOverride.dualBrain) {
    logger.info(`[boot] Dual-brain active: coding=${brainOverride.dualBrain.coding.provider}/${brainOverride.dualBrain.coding.model}, conversation=${brainOverride.dualBrain.conversation.provider}/${brainOverride.dualBrain.conversation.model}`);
  } else if (brainOverride.mainBrain) {
    logger.info("[boot] Single-brain mode");
  }

  // --- Sandbox ---
  const sandbox = await detectSandbox(
    config.sandbox?.backend,
    config.sandbox?.docker_image,
    config.sandbox?.required,
    nameLower
  );
  logger.info(`Sandbox: ${sandbox.name}`);

  // --- Stores ---
  const traces = new TraceStore(memory.getDb());
  const graphMemory = new GraphMemory(memory.getDb());
  const audit = new AuditLog(memory.getDb());
  try {
    const restartAudit = ingestRestartProvenance(undefined, audit);
    if (restartAudit.ingested > 0) {
      logger.info(`[boot] Ingested ${restartAudit.ingested} restart provenance record(s)`);
    }
  } catch (err) {
    logger.warn(`[boot] Failed to ingest restart provenance: ${err}`);
  }
  const registry = new AgentRegistry(
    memory.getDb(),
    config.agents,
    undefined,
    config.allowed_directories,
    instanceDir,
    instanceSoulsDir,
  );

  const knowledgeStats = knowledge.getStats();
  if (knowledgeStats.totalChunks > 0) {
    logger.info(`Knowledge: ${knowledgeStats.totalChunks} chunks from ${knowledgeStats.totalFiles} files`);
  }

  // Credential vault
  const { CredentialVault } = await import("../security/vault.js");
  const vaultSecrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && /api[_-]?key|secret|password|token|credential/i.test(k)) {
      vaultSecrets[k] = v;
    }
  }
  const vault = new CredentialVault(vaultSecrets);
  logger.info(`Security: credential vault loaded (${Object.keys(vaultSecrets).length} secrets)`);

  // Pairing
  const pairing = config.pairing?.enabled ? new PairingStore(dataDir, nameLower) : undefined;
  if (pairing) logger.info("Pairing enabled");

  // Pattern + outcome + routing stores
  const patternStore = new PatternStore(memory.getDb());
  const outcomeStore = new OutcomeStore(memory.getDb());
  const routingStore = new RoutingStore(memory.getDb());
  const proceduralSkillDrafts = new ProceduralSkillDraftStore(memory.getDb());
  const prunedRouting = routingStore.prune(90);
  if (prunedRouting > 0) logger.info(`[startup] Pruned ${prunedRouting} old routing decisions`);
  const classifierFeedback = new ClassifierFeedbackStore(memory.getDb());
  const feedbackStore = new FeedbackStore(memory.getDb());
  const relayCallbacks = new RelayCallbackManager(config);

  // --- Crawl ---
  const artifactQueue = new ArtifactQueue(memory, knowledge, router, embedder);
  memory.setArtifactQueue(artifactQueue);
  knowledge.setContextMetadataStore(memory);
  artifactQueue.start();

  let crawlService: CrawlService | undefined;
  let crawlSources: CrawlSourceStore | undefined;
  let crawlIngest: CrawlIngestBridge | undefined;
  const crawlAvailable = !!config.crawl || (!!process.env.CLOUDFLARE_ACCOUNT_ID && !!process.env.CLOUDFLARE_API_TOKEN);
  if (crawlAvailable) {
    crawlSources = new CrawlSourceStore(memory.getDb(), config.crawl);
    crawlSources.upsertFromConfig(config.crawl?.sources ?? []);
    try {
      crawlService = new CrawlService({ timeoutMs: config.crawl?.timeout_ms });
      logger.info("[crawl] Cloudflare Browser Rendering available");
    } catch (err) {
      logger.warn(`[crawl] Cloudflare Browser Rendering unavailable: ${err}`);
    }

    if (crawlService && embedder) crawlIngest = new CrawlIngestBridge(knowledge, embedder);
  }

  // --- Processor ---
  const processor = new QueueProcessor(queue, {
    agents: config.agents,
    teams: config.teams ?? {},
    baseDir: instanceDir,
    defaultAgent: resolvePrimaryAgentKey(config.agents, config.daemon) ?? Object.keys(config.agents)[0],
    router,
    memory,
    knowledge,
    embedder,
    patterns: patternStore,
    outcomes: outcomeStore,
    proceduralSkills: proceduralSkillDrafts,
    compiledKnowledge,
    routing: routingStore,
    classifierFeedback,
    cliEscalationTasks: config.routing.cli_escalation_tasks,
    nyxhiveConfig: config,
    relayCallbacks,
    runs,
    traces,
    graphMemory,
    sandbox,
    registry,
    vault,
    dualBrain: brainOverride.dualBrain,
    instanceSoulsDir,
  });

  // --- Tasks/Proposals ---
  const taskStore = new TaskStore(dataDir, nameLower);
  const proposalStore = new ProposalStore(dataDir, nameLower);
  processor.setProposalStore(proposalStore);
  processor.setClassifierFeedback(classifierFeedback);

  // Clean up stale worktrees
  const defaultProject = config.daemon.projects?.find(p => p.default) ?? config.daemon.projects?.[0];
  if (defaultProject) {
    const activeProposals = proposalStore.list({ status: "executing" });
    const activeIds = new Set(activeProposals.map(p => p.proposal_id));
    cleanupStaleWorktrees(defaultProject.repo_path, activeIds);
  }

  // Proposal executor
  const proposalExecutor = new ProposalExecutor(proposalStore, {
    processImmediate: (opts) => processor.processImmediate(opts),
    resolveProposalAgent: (category, files) => processor.resolveProposalAgent(category, files),
    resolveProposalRepoPath: (files) => processor.resolveProposalRepoPath(files),
    emit: (type, data) => processor.emitEvent(type, data),
    outcomes: outcomeStore,
    projects: config.daemon.projects,
    patterns: patternStore,
    runReview: config.review_gate?.enabled ? async (opts) => {
      const agentConfig = config.agents[opts.agent];
      if (!agentConfig) return null;
      return runReviewGate(
        { router, config: config.review_gate, baseDir: instanceDir, traces },
        agentConfig,
        opts.task,
        { response: opts.response, agent: opts.agent, method: "sdk", duration_ms: 0, tokens_in: 0, tokens_out: 0, cost: 0, model: agentConfig.model },
      );
    } : undefined,
  }, {
    maxConcurrent: 1,
    maxRetries: config.review_gate?.max_retries ?? 1,
  });
  processor.setProposalExecutor(proposalExecutor);

  // --- Assemble stores ---
  const stores = assembleStores({
    queue,
    memory,
    traces,
    graph: graphMemory,
    patterns: patternStore,
    outcomes: outcomeStore,
    routing: routingStore,
    registry,
    vault,
    proposals: proposalStore,
    tasks: taskStore,
    pairing: pairing ?? new PairingStore(dataDir, nameLower),
    knowledge,
    crawl: crawlService,
    audit,
    trading: tradingDb,
    feedback: feedbackStore,
    runs,
    proceduralSkills: proceduralSkillDrafts,
    compiledKnowledge,
  });
  processor.setStores(stores);

  // Wire commands from options
  if (options.commands?.length) {
    (processor as any).config.commands = options.commands;
  }

  // --- Scheduler ---
  let scheduler: Scheduler | undefined;
  if (config.scheduler?.enabled !== false) {
    scheduler = new Scheduler(memory.getDb(), processor, config, router, registry);
    processor.setScheduler(scheduler);
    scheduler.setCrawlRuntime({ service: crawlService, sources: crawlSources, ingest: crawlIngest });
    scheduler.setProposalStore(proposalStore);
    // NOTE: scheduler.start() is deferred until after channels are registered,
    // so deliverToNotifyChannels() can find Discord/Telegram/etc.
  }

  // --- Learning ---
  if (knowledge && embedder) {
    registerLearningListeners(processor, knowledge, embedder, config);
  }

  // --- Channels ---
  const channels: Channel[] = [];
  const startedChannelNames = new Set<string>();
  const channelFactories = options.channels ?? [];
  const channelDeps: ChannelDeps = {
    config,
    queue,
    processor,
    stores,
    slackSurfaces: options.slackSurfaces,
  };

  for (const factory of channelFactories) {
    try {
      const channel = await factory.create(channelDeps);
      channels.push(channel);
    } catch (err) {
      logger.warn(`Channel ${factory.name} not created: ${err}`);
    }
  }
  processor.setChannels(channels);

  // Notification batcher — coalesces non-critical notifications into digests
  const batcher = new NotificationBatcher();
  batcher.setChannels(channels);
  processor.setBatcher(batcher);
  if (scheduler) {
    scheduler.setBatcher(batcher);
  }

  const reportMissingConfiguredChannels = () => {
    const configuredChannelNames: string[] = [];
    if (config.discord) configuredChannelNames.push("discord");
    if (config.telegram) configuredChannelNames.push("telegram");
    if (config.slack) configuredChannelNames.push("slack");
    if (config.imessage) configuredChannelNames.push("imessage");

    const missingChannels = configuredChannelNames.filter(name => !startedChannelNames.has(name));
    if (missingChannels.length === 0) return;

    const envHints: Record<string, string> = {
      discord: config.discord?.bot_token_env ?? "DISCORD_BOT_TOKEN",
      telegram: config.telegram?.bot_token_env ?? "TELEGRAM_BOT_TOKEN",
      slack: config.slack?.bot_token_env ?? "SLACK_BOT_TOKEN",
    };
    const details = missingChannels
      .map(ch => `${ch} (check ${envHints[ch] ?? "token env"} in .env)`)
      .join(", ");
    logger.warn(`[boot] Configured channels failed to start: ${details}`);

    setTimeout(() => {
      const warning = `[Boot Warning] Configured channels failed to start: ${details}. Check your .env file.`;
      const alertTargets = resolveNotificationTargets(config, "alerts");
      for (const target of alertTargets) {
        const ch = channels.find((channel) => channel.name.toLowerCase() === target.channel.toLowerCase());
        if (ch?.sendOutbound) {
          try {
            ch.sendOutbound(target.recipient, warning);
          } catch { /* best effort */ }
        }
      }
    }, 5000);
  };

  // ── Proposal completion → chat notification ──
  // Close the loop: when a proposal executes successfully, route a summary to the
  // owner's channel so the response reaches the user without requiring a dashboard visit.
  processor.onEvent((event) => {
    if (event.type !== "proposal:completed") return;
    const data = event.data as {
      proposal_id?: string;
      title?: string;
      executed_by?: string;
      pr_url?: string | null;
      review_verdict?: string | null;
    };
    const title = data.title ?? data.proposal_id ?? "(unknown)";
    const parts: string[] = [data.pr_url ? `Proposal PR ready for approval: ${title}` : `Proposal completed without PR: ${title}`];
    if (data.pr_url) parts.push(`PR: ${data.pr_url}`);
    if (data.review_verdict) parts.push(`Review: ${data.review_verdict}`);
    if (data.executed_by) parts.push(`Agent: ${data.executed_by}`);
    const msg = parts.join(" — ");

    const targets = resolveNotificationTargets(config, "proposals");
    for (const target of targets) {
      const ch = channels.find((c) => c.name.toLowerCase() === target.channel.toLowerCase());
      if (ch?.sendOutbound) {
        ch.sendOutbound(target.recipient, msg).catch((err: unknown) => {
          logger.warn(`[hive] proposal:completed notification failed (${target.channel}): ${err}`);
        });
      }
    }
  });

  {
    const remotes = resolveConfiguredRemoteMcpEndpoints(config);
    if (remotes.length > 0) {
      const REMOTE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
      const sendRemoteAlert = (message: string) => {
        const alertTargets = resolveNotificationTargets(config, "alerts");
        for (const target of alertTargets) {
          const ch = channels.find((c) => c.name.toLowerCase() === target.channel.toLowerCase());
          if (ch?.sendOutbound) {
            ch.sendOutbound(target.recipient, message).catch(() => {});
          }
        }
      };

      const checkRemoteHealth = async () => {
        await Promise.all(remotes.map(async (remote) => {
          const healthUrl = `${remote.url.replace(/\/api\/mcp$/, "").replace(/\/+$/, "")}/instance`;
          try {
            const response = await fetch(healthUrl, {
              headers: { Authorization: `Bearer ${process.env[remote.api_key_env] ?? ""}` },
              signal: AbortSignal.timeout(5_000),
            });
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
            const changed = processor.recordRemoteMcpHealth(remote.slug, remote.url, "up");
            if (changed) {
              logger.info(`[hive] Remote ${remote.name} recovered`);
            }
          } catch (err) {
            const reason = String(err);
            const changed = processor.recordRemoteMcpHealth(remote.slug, remote.url, "down", reason);
            if (changed) {
              logger.warn(`[hive] Remote ${remote.name} down: ${reason}`);
              sendRemoteAlert(`Remote instance down: ${remote.name} at ${remote.url}. ${reason}`);
            }
          }
        }));
      };

      void checkRemoteHealth();
      setInterval(() => {
        void checkRemoteHealth();
      }, REMOTE_CHECK_INTERVAL_MS);
    }
  }

  // ── Stale processing watcher ──
  // Detects messages stuck in "processing" state — a sign the agent hung, crashed,
  // or was lost without completing. Alerts the owner channel so the loop doesn't
  // silently fail.
  {
    const STALE_PROCESSING_THRESHOLD_MS = 15 * 60 * 1000; // 15 min
    const STALE_CHECK_INTERVAL_MS = 5 * 60 * 1000;       // check every 5 min
    const alertedStaleIds = new Set<string>();

    setInterval(() => {
      try {
        const health = queue.getQueueHealth({ staleProcessingMs: STALE_PROCESSING_THRESHOLD_MS, stalePendingMs: 60 * 60 * 1000 });
        const stale = health.stale_processing.filter((m) => !alertedStaleIds.has(m.message_id));
        if (stale.length === 0) return;

        for (const m of stale) {
          alertedStaleIds.add(m.message_id);
          const ageMin = Math.round(m.age_ms / 60_000);
          const label = m.agent ? ` (agent: ${m.agent})` : "";
          const msg = `[Stale Task] ${m.message_id}${label} stuck in processing for ${ageMin}m — may need investigation`;
          logger.warn(`[hive] ${msg}`);

          const alertTargets = resolveNotificationTargets(config, "alerts");
          for (const target of alertTargets) {
            const ch = channels.find((c) => c.name.toLowerCase() === target.channel.toLowerCase());
            if (ch?.sendOutbound) {
              ch.sendOutbound(target.recipient, msg).catch(() => {});
            }
          }
        }

        // Prune alerted set so it doesn't grow unboundedly across restarts
        if (alertedStaleIds.size > 500) {
          const currentIds = new Set(health.stale_processing.map((m) => m.message_id));
          for (const id of alertedStaleIds) {
            if (!currentIds.has(id)) alertedStaleIds.delete(id);
          }
        }
      } catch (err) {
        logger.debug(`[hive] stale watcher error: ${err}`);
      }
    }, STALE_CHECK_INTERVAL_MS);
  }

  // Runtime context
  const runtime: DaemonRuntime = {
    config,
    configPath: configPath ?? "",
    queue,
    processor,
    pairing,
    channels,
  };

  // Startup validation
  if (router.getProviderCount() === 0) {
    logger.warn("No AI providers registered. AI-dependent features (chat, classification, summarization) will return 503. Non-AI routes (proposals, traces, memory, scheduler, devices) remain available.");
  }

  // Resolve api_key from env var if api_key_env is set and api_key is not
  if (!config.server.api_key && config.server.api_key_env) {
    const resolved = process.env[config.server.api_key_env];
    if (resolved) {
      config.server.api_key = resolved;
      logger.info(`[server] api_key resolved from env var ${config.server.api_key_env}`);
    } else {
      logger.warn(`[server] api_key_env=${config.server.api_key_env} is set but the env var is empty or missing`);
    }
  }

  if (!config.server.api_key) {
    if (config.auth?.enabled) {
      logger.error("[server] auth.enabled=true but no api_key configured. Set server.api_key or server.api_key_env in config.");
      process.exit(1);
    }
    logger.warn("[server] No api_key configured. API endpoints are unauthenticated. Set server.api_key or server.api_key_env for production use.");
  }

  // Find iOS and webhook channels for server
  const iosChannel = channels.find(c => c.name === "ios") as import("../channels/ios.js").iOSChannel | undefined;
  const webhookChannel = channels.find(c => c.name === "webhook") as import("../channels/webhook.js").WebhookChannel | undefined;

  // --- Server ---
  const { app: serverApp, start: startServer, stop: stopServer, threadDb, connections } = createServer({
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
    tradingDb,
    configPath,
    instanceSoulsDir,
    relayCallbacks,
    runs,
    proceduralSkills: proceduralSkillDrafts,
    compiledKnowledge,
  });
  if (threadDb) {
    stores.threads = threadDb;
    processor.setThreadDb(threadDb);
  }

  if (scheduler && options.tasks?.length) {
    scheduler.registerTaskDefinitions(options.tasks, stores);
  }

  registerExtensionRoutes(serverApp, {
    processor: processor.getPublicAPI(),
    config,
    stores,
  }, options.routes);

  // --- Vault ingestion ---
  const ingestHours = config.vault?.auto_ingest_interval_hours;
  if (ingestHours && config.vault?.path && embedder) {
    const intervalMs = ingestHours * 60 * 60 * 1000;
    logger.info(`[knowledge] Auto-ingestion enabled: every ${ingestHours}h for ${config.vault.path}`);
    let isIngesting = false;
    setInterval(async () => {
      if (isIngesting) {
        logger.debug("[knowledge] Auto-ingestion skipped: previous run still active");
        return;
      }
      isIngesting = true;
      try {
        logger.info("[knowledge] Auto-ingestion starting...");
        const result = await ingestVault(
          { path: config.vault!.path, skipDirs: config.vault!.skip_dirs },
          knowledge,
          embedder!,
        );
        logger.info(`[knowledge] Auto-ingestion done: ${result.newChunks} new, ${result.updatedChunks} updated, ${result.skippedChunks} skipped`);

        if (config.vault!.generate_canvas !== false) {
          try {
            const { writeFileSync: writeFileSyncFs } = await import("node:fs");
            const { join } = await import("node:path");
            const allChunks = knowledge.getAllChunks();
            if (allChunks.length > 0) {
              const canvas = generateKnowledgeCanvas(allChunks, {
                title: `${name} Knowledge Map`,
                groupByCategory: true,
                maxNodes: 100,
              });
              writeFileSyncFs(join(config.vault!.path, "Knowledge Map.canvas"), canvas, "utf-8");
              logger.info(`[knowledge] Generated knowledge canvas with ${allChunks.length} nodes`);
            }
          } catch (canvasErr) {
            logger.warn(`[knowledge] Canvas generation failed: ${canvasErr}`);
          }
        }
      } catch (err) {
        logger.error(`[knowledge] Auto-ingestion failed: ${err}`);
      } finally {
        isIngesting = false;
      }
    }, intervalMs);
  }

  // Vault file watcher
  let vaultWatcher: VaultWatcher | null = null;
  if (config.vault?.path && config.vault?.watch !== false && embedder) {
    const skipDirs = config.vault.skip_dirs ?? [".obsidian", ".trash", ".git", "node_modules"];
    vaultWatcher = new VaultWatcher(
      config.vault.path,
      skipDirs,
      async (filePath, event) => {
        const { join } = await import("node:path");
        const { existsSync } = await import("node:fs");
        const fullPath = join(config.vault!.path, filePath);

        if (event === "delete" || !existsSync(fullPath)) {
          const deleted = knowledge.deleteBySourcePath(filePath);
          if (deleted > 0) logger.info(`[watcher] Removed: ${filePath} (${deleted} chunks)`);
        } else {
          try {
            const result = await ingestFile(fullPath, config.vault!.path, knowledge, embedder!);
            if (result.chunksUpdated > 0) {
              logger.info(`[watcher] Re-ingested: ${filePath} (${result.chunksUpdated} chunks)`);
            }
          } catch (err) {
            logger.warn(`[watcher] Failed to re-ingest ${filePath}: ${err}`);
          }
        }
      },
    );
    vaultWatcher.start();
  }

  // --- Status ---
  const agentNames = Object.entries(config.agents)
    .map(([key, a]) => `${a.name} (${key})`)
    .join(", ");
  logger.info(`Agents: ${agentNames}`);

  const channelNames = channels.map((c) => c.name).join(", ") || "none";
  logger.info(`Channels configured: ${channelNames}`);
  logger.info(`Server: http://localhost:${config.server.port}`);

  // --- Shutdown ---
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = async (signal?: NodeJS.Signals) => {
    if (signal) {
      noteShutdownSignal(signal);
    }

    if (shutdownPromise) {
      logger.warn(`[shutdown] Duplicate shutdown request ignored (${describeShutdownCause()})`);
      return shutdownPromise;
    }

    logger.warn(`[shutdown] Starting graceful shutdown (${describeShutdownCause()})`);
    shutdownPromise = (async () => {
      const timer = setTimeout(() => {
        logger.error("Shutdown timed out after 15s, forcing exit");
        process.exit(1);
      }, 15_000);

      try {
        if (options.onShutdown) {
          try { await options.onShutdown(hive); }
          catch (err) { logger.error(`onShutdown hook failed: ${err}`); }
        }
        vaultWatcher?.stop();
        scheduler?.stop();
        await batcher.flushAll();
        const { drained, inflight } = await processor.drain(10_000);
        if (!drained) {
          logger.warn(`Shutdown with ${inflight} task(s) still in-flight -- will be retried on restart`);
        }
        cleanupTempFiles();
        closeSharedCodexAppServerHarness();
        cleanupBrowser();
        // Kill any claude child processes spawned by this instance
        try {
          const result = Bun.spawnSync(["pgrep", "-P", String(process.pid)]);
          const childPids = result.stdout.toString().trim().split("\n").filter(Boolean).map(Number);
          if (childPids.length > 0) {
            logger.info(`[shutdown] Killing ${childPids.length} child process(es): ${childPids.join(", ")}`);
            for (const pid of childPids) {
              try { process.kill(pid, "SIGKILL"); } catch {}
            }
          }
        } catch {}
        await Promise.allSettled(channels.map(ch => ch.stop()));
        taskStore?.close();
        proposalStore?.close();
        artifactQueue.stop();
        tradingDb?.close();
        knowledge.close();
        memory.close();
        queue.close();
        stopServer();
        try { unlinkSync(pidFile); } catch {}
      } catch (err) {
        logger.error(`Error during shutdown: ${err}`);
      }

      clearTimeout(timer);
      resetShutdownTracking();
      process.exit(0);
    })();

    return shutdownPromise;
  };

  // --- Build Hive ---
  // Use `let` so shutdown closure can reference hive for onShutdown hook
  let hive: Hive;

  hive = {
    async start() {
      startServer();
      processor.start();

      for (const channel of channels) {
        try {
          await channel.start();
          startedChannelNames.add(channel.name);
        } catch (err) {
          logger.warn(`Channel ${channel.name} not started: ${err}`);
        }
      }

      if (scheduler) {
        await scheduler.start();
      }
      reportMissingConfiguredChannels();

      logger.info(`Channels: ${Array.from(startedChannelNames).join(", ") || "none"}`);

      if (connections) {
        initActivityStream((event, payload) => connections.broadcast(event, payload));
      }

      if (options.onReady) {
        try { await options.onReady(hive); }
        catch (err) { logger.error(`onReady hook failed: ${err}`); }
      }

      process.on("SIGINT", () => { void shutdown("SIGINT"); });
      process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
      process.on("SIGHUP", () => {
        logger.warn("Terminal closing -- use nyxhive stop or Ctrl+C");
      });

      logger.info(`${name} is running in FOREGROUND mode. Close this pane/window to stop, or use: nyxhive kill ${name.toLowerCase()}. To run in background: nyxhive start ${name.toLowerCase()} --daemon`);
      logger.info("All systems online");
    },

    async stop() {
      await shutdown();
    },

    get processor() { return processor.getPublicAPI(); },
    config,
    server: serverApp as any,
    scheduler,
    stores,
  };

  return hive;
}
