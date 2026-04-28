import type {
  Provider,
  ProviderName,
  TaskType,
  ClassificationResult,
  RouteDecision,
  CompletionParams,
  ProviderResponse,
} from "./types.js";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";
import { resolveModelAlias } from "../queue/model-utils.js";
import {
  DEFAULT_CLASSIFICATION,
  DEFAULT_ROUTING_TABLE,
  DEFAULT_FALLBACK_ORDER,
  FEW_SHOT_EXAMPLES,
  getModelTier,
  CIRCUIT_BREAKER_WINDOW_MS,
  CIRCUIT_BREAKER_COOLDOWN_MS,
  CATEGORY_MODEL_MAP,
} from "../defaults.js";
import type { ModelCategory } from "../types.js";

interface RoutingConfig {
  orchestrator_model: string;
  orchestrator_provider: ProviderName;
  classifier_model: string;
  classifier_provider: ProviderName;
  coding_model: string;
  coding_provider: ProviderName;
  classification?: { trivial?: string; coding?: string; search?: string; summary?: string };
  tasks?: Record<string, { provider: ProviderName; model: string; max_tokens: number }>;
  fallback_order?: ProviderName[];
}

/**
 * Routes LLM requests to the best provider/model based on task classification.
 * Supports regex-based local classification, LLM-based classification with few-shot prompting,
 * tier-aware model upgrades/downgrades, circuit breaker failover, and ordered fallback chains.
 */
export class ProviderRouter {
  private providers: Map<ProviderName, Provider> = new Map();
  private routingConfig: RoutingConfig;
  private fallbackOrder: ProviderName[];

  // Instance-level regexes built from config (or defaults)
  private trivialPattern: RegExp;
  private codingPattern: RegExp;
  private researchPattern: RegExp;
  private searchPattern: RegExp;
  private summaryPattern: RegExp;
  private analysisPattern: RegExp;
  private expertPattern: RegExp;
  private orchestratorPattern: RegExp;

  // Merged routing table
  private routingTable: Record<TaskType, { provider: ProviderName; model: string; maxTokens: number; fallback?: { provider: ProviderName; model: string } }>;

  // Circuit breaker state per provider
  private circuitState = new Map<string, {
    state: "idle" | "error" | "recovering";
    failures: number;
    lastFailure: number;
    lastStateChange: number;
  }>();

  private readonly circuitThreshold = 3;                          // failures to trip
  private readonly circuitWindowMs = CIRCUIT_BREAKER_WINDOW_MS;   // failure window
  private readonly circuitCooldownMs = CIRCUIT_BREAKER_COOLDOWN_MS; // how long to stay open

  constructor(routingConfig: RoutingConfig) {
    this.routingConfig = routingConfig;
    this.fallbackOrder = routingConfig.fallback_order ?? DEFAULT_FALLBACK_ORDER;

    // Build classification regexes from config or defaults
    const cls = routingConfig.classification ?? {};
    this.trivialPattern = new RegExp(cls.trivial ?? DEFAULT_CLASSIFICATION.trivial, "i");
    this.codingPattern = new RegExp(cls.coding ?? DEFAULT_CLASSIFICATION.coding, "i");
    this.researchPattern = new RegExp(DEFAULT_CLASSIFICATION.research, "i");
    this.searchPattern = new RegExp(cls.search ?? DEFAULT_CLASSIFICATION.search, "i");
    this.summaryPattern = new RegExp(cls.summary ?? DEFAULT_CLASSIFICATION.summary, "i");
    this.analysisPattern = new RegExp(DEFAULT_CLASSIFICATION.analysis, "i");
    this.expertPattern = new RegExp(DEFAULT_CLASSIFICATION.expert, "i");
    this.orchestratorPattern = new RegExp(DEFAULT_CLASSIFICATION.orchestrator, "i");

    // Build routing table: start with defaults, override orchestrator model, then merge config tasks
    this.routingTable = { ...DEFAULT_ROUTING_TABLE };
    this.routingTable.orchestrator = {
      ...this.routingTable.orchestrator,
      model: routingConfig.orchestrator_model,
    };

    if (routingConfig.tasks) {
      for (const [key, entry] of Object.entries(routingConfig.tasks)) {
        const taskType = key as TaskType;
        if (taskType in this.routingTable) {
          this.routingTable[taskType] = {
            provider: entry.provider,
            model: entry.model,
            maxTokens: entry.max_tokens,
          };
        }
      }
    }
  }

  private getCircuitState(provider: string) {
    if (!this.circuitState.has(provider)) {
      this.circuitState.set(provider, { state: "idle", failures: 0, lastFailure: 0, lastStateChange: Date.now() });
    }
    const circuit = this.circuitState.get(provider)!;

    // If error and cooldown expired, move to recovering
    if (circuit.state === "error" && Date.now() - circuit.lastStateChange > this.circuitCooldownMs) {
      circuit.state = "recovering";
      circuit.lastStateChange = Date.now();
      logger.info(`[router] ${provider} circuit RECOVERING (cooldown expired)`);
    }

    return circuit;
  }

  private recordSuccess(provider: string) {
    const circuit = this.getCircuitState(provider);
    if (circuit.state !== "idle") {
      logger.info(`[router] ${provider} circuit IDLE (probe succeeded)`);
    }
    circuit.state = "idle";
    circuit.failures = 0;
    circuit.lastStateChange = Date.now();
  }

  private recordFailure(provider: string, isRateLimit = false) {
    const circuit = this.getCircuitState(provider);
    const now = Date.now();

    // Rate limits (429) are transient and should NOT trip the circuit breaker.
    // The API is working fine — we're just sending too many requests.
    if (isRateLimit) {
      logger.info(`[router] ${provider} rate-limited (429) — not counting as circuit failure`);
      return;
    }

    // Decay: if last failure was outside the window, reset the counter.
    // Without this, transient errors hours apart accumulate and trip the breaker.
    if (circuit.lastFailure > 0 && now - circuit.lastFailure > this.circuitWindowMs) {
      circuit.failures = 0;
    }

    circuit.failures++;
    circuit.lastFailure = now;

    if (circuit.failures >= this.circuitThreshold) {
      circuit.state = "error";
      circuit.lastStateChange = now;
      logger.warn(`[router] ${provider} circuit ERROR (${circuit.failures} failures in ${this.circuitWindowMs}ms)`);
    }
  }

  /** Return circuit breaker state ("idle" | "error" | "recovering") for each registered provider. */
  getHealthStatus(): Record<string, string> {
    const status: Record<string, string> = {};
    for (const [name] of this.providers) {
      const circuit = this.getCircuitState(name);
      status[name] = circuit.state;
    }
    return status;
  }

  /** Return registered provider names, model lists, and circuit states for runtime introspection. */
  listRegisteredProviders(): Array<{ name: ProviderName; models: string[]; circuit: string }> {
    const health = this.getHealthStatus();
    return Array.from(this.providers.entries()).map(([name, provider]) => ({
      name,
      models: provider.listModels(),
      circuit: health[name] ?? "unknown",
    }));
  }

  /** Number of registered providers. */
  getProviderCount(): number {
    return this.providers.size;
  }

  /** Returns true if at least one provider is registered and available for AI operations. */
  isAvailable(): boolean {
    return this.providers.size > 0;
  }

  /** Check if a provider is registered by name. */
  hasProvider(name: string): boolean {
    return this.providers.has(name as ProviderName);
  }

  /** Register a provider implementation for routing and fallback. */
  registerProvider(name: ProviderName, provider: Provider): void {
    this.providers.set(name, provider);
  }

  /** Retrieve a registered provider by name. */
  getProvider(name: ProviderName): Provider | undefined {
    return this.providers.get(name);
  }

  /**
   * Classify a message into a TaskType using regex pattern matching (no LLM call).
   * Checks patterns in priority order: trivial > short > orchestrator > expert > coding > analysis > research > search > summary.
   * Falls back to "conversation" if no pattern matches.
   */
  classifyLocal(message: string): TaskType {
    const trimmed = message.trim();

    if (this.trivialPattern.test(trimmed)) { logger.debug("[router] Local classify: trivial (pattern: trivial)"); return "trivial"; }
    if (this.orchestratorPattern.test(trimmed)) { logger.debug("[router] Local classify: orchestrator (pattern: orchestrator)"); return "orchestrator"; }
    if (this.expertPattern.test(trimmed)) { logger.debug("[router] Local classify: expert (pattern: expert)"); return "expert"; }
    if (this.codingPattern.test(trimmed)) { logger.debug("[router] Local classify: coding (pattern: coding)"); return "coding"; }
    if (this.analysisPattern.test(trimmed)) { logger.debug("[router] Local classify: analysis (pattern: analysis)"); return "analysis"; }
    if (this.researchPattern.test(trimmed)) { logger.debug("[router] Local classify: research (pattern: research)"); return "research"; }
    if (this.searchPattern.test(trimmed)) { logger.debug("[router] Local classify: simple_qa (pattern: search)"); return "simple_qa"; }
    if (this.summaryPattern.test(trimmed)) { logger.debug("[router] Local classify: summarization (pattern: summary)"); return "summarization"; }
    if (trimmed.length < 20) { logger.debug(`[router] Local classify: simple_qa (short message, ${trimmed.length} chars)`); return "simple_qa"; }
    if (trimmed.length > 500) {
      if (this.codingPattern.test(trimmed)) { logger.debug(`[router] Local classify: coding (long message + coding pattern, ${trimmed.length} chars)`); return "coding"; }
      logger.debug(`[router] Local classify: analysis (long message, ${trimmed.length} chars)`); return "analysis";
    }

    logger.debug("[router] Local classify: conversation (no pattern match)");
    return "conversation";
  }

  private buildFewShotPrompt(message: string, conversationContext?: string): string {
    const examples = FEW_SHOT_EXAMPLES.map(
      (ex) => `Prompt: "${ex.prompt}"\n→ {"task_type": "${ex.task_type}", "tier": ${ex.tier}}`
    ).join("\n\n");

    const contextBlock = conversationContext
      ? `\n<conversation_context>\n${conversationContext.slice(0, 500)}\n</conversation_context>\n\nThe user's prompt below is a follow-up to the conversation above. Classify based on the FULL context, not just the short prompt.\n`
      : "";

    return `You are a task classifier for an AI coding agent orchestrator. Given a user prompt, classify it into:
1. task_type: one of [trivial, simple_qa, conversation, analysis, coding, code_review, expert, research, summarization, long_context, worker_subtask, orchestrator]
2. tier: 1 (cheap/fast), 2 (mid), 3 (strong), 4 (top)

CRITICAL: When in doubt, route UP not down. Under-routing (sending complex tasks to cheap models) costs more than over-routing because failed tasks get retried on expensive models anyway.

CRITICAL: Short/vague prompts like "continue", "do it", "same for discord" are context-dependent — they inherit the task type and tier of the previous message in the conversation. If no conversation context is provided, default to tier 2 conversation.

CRITICAL: User minimization ("quick fix", "tiny change", "this should be easy") does NOT determine the tier. Classify based on what the task ACTUALLY requires, not how the user frames it.

<examples>
${examples}
</examples>

Respond with ONLY JSON: {"task_type": "...", "tier": N}
${contextBlock}
Prompt: "${message.slice(0, 500)}"`;
  }

  private static readonly VALID_TASK_TYPES: TaskType[] = [
    "trivial", "simple_qa", "conversation", "analysis",
    "coding", "code_review", "expert", "research",
    "summarization", "orchestrator", "long_context",
    "worker_subtask",
  ];

  private static extractClassificationJson(raw: string): { task_type: string; tier: number } | null {
    const trimmed = raw.trim();
    const candidates = [trimmed, ...(trimmed.match(/\{[\s\S]*\}/g) ?? [])];

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as { task_type: string; tier: number };
        if (typeof parsed.task_type === "string" && typeof parsed.tier === "number") {
          return parsed;
        }
      } catch {
        // Ignore non-JSON wrappers and keep scanning.
      }
    }

    return null;
  }

  /**
   * Classify a message using a lightweight LLM call with few-shot examples.
   * Returns task type + tier (1-4). Falls back to local classification on failure.
   * Optionally accepts conversation context to classify short follow-ups accurately.
   */
  async classifyWithLLM(message: string, conversationContext?: string): Promise<ClassificationResult> {
    const provider = this.providers.get(this.routingConfig.classifier_provider);
    if (!provider) {
      logger.info(`[router] LLM classifier provider ${this.routingConfig.classifier_provider} not available, using local`);
      return { taskType: this.classifyLocal(message), tier: 2 };
    }

    const prompt = this.buildFewShotPrompt(message, conversationContext);

    logger.info(`[router] LLM classify via ${this.routingConfig.classifier_provider}/${this.routingConfig.classifier_model}: "${message.slice(0, 60)}…"`);

    const classifierModel = resolveModelAlias(this.routingConfig.classifier_model);
    const startMs = performance.now();

    try {
      const response = await provider.complete({
        model: classifierModel,
        maxTokens: 50,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      });

      const classifierLatencyMs = Math.round(performance.now() - startMs);
      const raw = response.content.trim();
      const parsed = ProviderRouter.extractClassificationJson(raw);
      if (!parsed) {
        throw new Error(`classifier returned non-JSON content: ${raw.slice(0, 120)}`);
      }
      const taskType = parsed.task_type as TaskType;
      const tier = Math.max(1, Math.min(4, Math.round(parsed.tier)));

      if (ProviderRouter.VALID_TASK_TYPES.includes(taskType)) {
        logger.info(`[router] LLM classified as: ${taskType} T${tier} (raw: "${raw}", ${classifierLatencyMs}ms)`);
        return { taskType, tier, classifierLatencyMs, classifierModel };
      }

      logger.warn(`[router] LLM classified as unknown type: "${raw}", falling back to local`);
      return { taskType: this.classifyLocal(message), tier: 2, classifierLatencyMs, classifierModel };
    } catch (err) {
      const classifierLatencyMs = Math.round(performance.now() - startMs);
      logger.warn(`[router] LLM classification failed, falling back to local: ${err}`);
      return { taskType: this.classifyLocal(message), tier: 2, classifierLatencyMs, classifierModel };
    }
  }

  /** Look up the default provider/model/maxTokens for a task type from the routing table. */
  route(taskType: TaskType): RouteDecision {
    const entry = this.routingTable[taskType];
    logger.debug(`[router] Route: ${taskType} → ${entry.provider}/${entry.model} (max_tokens=${entry.maxTokens}${entry.fallback ? `, fallback=${entry.fallback.provider}/${entry.fallback.model}` : ""})`);
    return { ...entry, taskType };
  }

  /**
   * Route with tier-aware model upgrade/downgrade.
   * 1. Get default route from routing table
   * 2. Compare classified tier vs default model's tier
   * 3. Upgrade if classified tier is higher, downgrade if lower
   * 4. Apply min_model / max_model guardrails if provided
   */
  routeWithTier(
    classification: ClassificationResult,
    guardrails?: { minModel?: string; maxModel?: string; preferredProvider?: ProviderName },
  ): RouteDecision {
    const { taskType, tier } = classification;
    const defaultRoute = this.routingTable[taskType];

    // Short-circuit: if min_model === max_model, agent is pinned — skip tier routing entirely
    if (guardrails?.minModel && guardrails?.maxModel && guardrails.minModel === guardrails.maxModel) {
      const resolvedModel = resolveModelAlias(guardrails.minModel);
      const provider = this.findProviderForModel(resolvedModel) ?? guardrails.preferredProvider ?? defaultRoute.provider;
      logger.debug(`[router] RouteWithTier: min_model === max_model → ${provider}/${resolvedModel} (tier routing bypassed)`);
      return {
        provider,
        model: resolvedModel,
        taskType,
        maxTokens: defaultRoute.maxTokens,
        fallback: defaultRoute.fallback,
      };
    }

    const defaultModelTier = getModelTier(defaultRoute.model);

    // Find the best model for the classified tier
    let targetModel = defaultRoute.model;
    let targetProvider = defaultRoute.provider;

    if (tier === defaultModelTier) {
      logger.debug(`[router] RouteWithTier: ${taskType} T${tier} → ${defaultRoute.provider}/${defaultRoute.model} (tier matches default)`);
    } else if (tier > defaultModelTier) {
      // Upgrade: find cheapest model at the classified tier
      const upgrade = this.findModelForTier(tier, taskType);
      if (upgrade) {
        targetModel = upgrade.model;
        targetProvider = upgrade.provider;
        logger.info(`[router] RouteWithTier: ${taskType} T${tier} — UPGRADE ${defaultRoute.model}(T${defaultModelTier}) → ${targetModel}(T${tier})`);
      }
    } else {
      // Downgrade: find model at the classified tier (cost saving)
      const downgrade = this.findModelForTier(tier, taskType);
      if (downgrade) {
        targetModel = downgrade.model;
        targetProvider = downgrade.provider;
        logger.info(`[router] RouteWithTier: ${taskType} T${tier} — DOWNGRADE ${defaultRoute.model}(T${defaultModelTier}) → ${targetModel}(T${tier})`);
      }
    }

    // Apply guardrails (must run unconditionally — agent min/max_model overrides route tier)
    if (guardrails?.minModel) {
      const resolvedMin = resolveModelAlias(guardrails.minModel);
      const minTier = getModelTier(resolvedMin);
      if (getModelTier(targetModel) < minTier) {
        targetModel = resolvedMin;
        targetProvider = this.findProviderForModel(resolvedMin) ?? guardrails.preferredProvider ?? targetProvider;
        logger.info(`[router] RouteWithTier: min_model FLOOR applied → ${targetModel}(T${minTier})`);
      }
    }
    if (guardrails?.maxModel) {
      const resolvedMax = resolveModelAlias(guardrails.maxModel);
      const maxTier = getModelTier(resolvedMax);
      if (getModelTier(targetModel) > maxTier) {
        targetModel = resolvedMax;
        targetProvider = this.findProviderForModel(resolvedMax) ?? guardrails.preferredProvider ?? targetProvider;
        logger.info(`[router] RouteWithTier: max_model CEILING applied → ${targetModel}(T${maxTier})`);
      }
    }

    return {
      provider: targetProvider,
      model: targetModel,
      taskType,
      maxTokens: defaultRoute.maxTokens,
      fallback: defaultRoute.fallback,
    };
  }

  /** Find the best model at a given tier, preferring models already in the routing table */
  private findModelForTier(tier: number, _taskType: TaskType): { model: string; provider: ProviderName } | null {
    // Tier → preferred model mapping (cheapest viable at each tier)
    // Benchmarked 2026-03-01: MiMo v2 Flash (4.9/5) > Qwen3 (3.9/5) at tier 2
    const tierModels: Record<number, { model: string; provider: ProviderName }> = {
      1: { model: "deepseek/deepseek-v3.2", provider: "openrouter" },
      2: { model: "xiaomi/mimo-v2-flash", provider: "openrouter" },
      3: { model: "claude-sonnet-4-6", provider: "anthropic" },
      4: { model: "claude-opus-4-6", provider: "anthropic" },
    };
    return tierModels[tier] ?? null;
  }

  /** Find which provider serves a given model, checking routing table then registered providers */
  /** Resolve a model category to a concrete provider+model. */
  routeByCategory(category: ModelCategory): { provider: ProviderName; model: string } {
    const mapping = CATEGORY_MODEL_MAP[category];
    logger.info(`[router] Category route: ${category} → ${mapping.provider}/${mapping.model}`);
    return mapping;
  }

  private findProviderForModel(model: string): ProviderName | null {
    for (const entry of Object.values(this.routingTable)) {
      if (entry.model === model) return entry.provider;
      if (entry.fallback?.model === model) return entry.fallback.provider;
    }
    // Check registered providers (handles local models like ollama)
    for (const [name, provider] of this.providers) {
      if (provider.listModels().includes(model)) return name as ProviderName;
    }
    return null;
  }

  /**
   * Send a completion request with automatic failover. Tries the preferred provider first,
   * then the route-specific fallback (if provided), then walks the generic fallback chain
   * (skipping circuit-broken providers). Drops model preference on generic fallback so each
   * provider uses its default. Throws if all providers fail.
   */
  async complete(
    params: CompletionParams,
    preferredProvider?: ProviderName,
    preferredModel?: string,
    routeFallback?: { provider: ProviderName; model: string },
  ): Promise<ProviderResponse> {
    if (this.providers.size === 0) {
      throw new Error("no_provider: No AI providers are configured. Set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or OPENROUTER_API_KEY, or boot with Claude login available.");
    }

    const providerName = preferredProvider ?? "anthropic";
    const provider = this.providers.get(providerName);
    const resolvedModel = resolveModelAlias(preferredModel ?? params.model ?? "");
    let primaryRateLimited: ProviderName | null = null;

    const primaryCircuit = this.getCircuitState(providerName);
    if (primaryCircuit.state === "error") {
      logger.warn(`[router] ${providerName} circuit is ERROR, skipping to fallback chain`);
    } else if (provider) {
      try {
        const result = await withRetry(() => provider.complete({
          ...params,
          model: resolvedModel,
        }));
        this.recordSuccess(providerName);
        return result;
      } catch (err) {
        const isRateLimit = (err as any)?.status === 429;
        logger.warn(`[router] ${providerName} failed after retries: ${err}, entering fallback chain`);
        this.recordFailure(providerName, isRateLimit);
        // If rate-limited, skip fallbacks on the same provider (same API key = same rate limit)
        if (isRateLimit) {
          logger.warn(`[router] ${providerName} rate-limited — skipping same-provider fallbacks`);
        }
        primaryRateLimited = isRateLimit ? providerName : null;
      }
    } else {
      logger.warn(`[router] Provider ${providerName} not registered, entering fallback chain`);
    }

    // Route-specific fallback — try the configured fallback provider+model for this task type
    const tried: string[] = [providerName];
    if (routeFallback) {
      // Skip if the fallback is on the same provider that just got rate-limited
      if (primaryRateLimited && routeFallback.provider === primaryRateLimited) {
        logger.info(`[router] Route fallback skipped — ${routeFallback.provider} is rate-limited`);
      } else {
        const rfProvider = this.providers.get(routeFallback.provider);
        const rfCircuit = this.getCircuitState(routeFallback.provider);
        if (rfProvider && rfCircuit.state !== "error") {
          try {
            logger.info(`[router] Route fallback → ${routeFallback.provider}/${routeFallback.model}`);
            const result = await withRetry(() => rfProvider.complete({
              ...params,
              model: routeFallback.model,
            }));
            this.recordSuccess(routeFallback.provider);
            return result;
          } catch (err) {
            const isRL = (err as any)?.status === 429;
            logger.warn(`[router] Route fallback ${routeFallback.provider}/${routeFallback.model} failed: ${err}`);
            this.recordFailure(routeFallback.provider, isRL);
          }
        }
      }
      tried.push(`${routeFallback.provider}/${routeFallback.model}`);
    }

    // Generic fallback chain — drop the model so each provider uses its own default
    const { model: _drop, ...fallbackParams } = params;
    const candidates = this.fallbackOrder.filter((f) => f !== providerName);
    const total = candidates.length;

    for (let i = 0; i < candidates.length; i++) {
      const fallback = candidates[i];
      const fallbackCircuit = this.getCircuitState(fallback);
      if (fallbackCircuit.state === "error") {
        logger.info(`[router] Fallback [${i + 1}/${total}] ${fallback} — circuit ERROR, skipping`);
        continue;
      }
      if (primaryRateLimited && fallback === primaryRateLimited) {
        logger.info(`[router] Fallback [${i + 1}/${total}] ${fallback} — rate-limited, skipping`);
        continue;
      }
      const fb = this.providers.get(fallback);
      if (!fb) {
        logger.info(`[router] Fallback [${i + 1}/${total}] ${fallback} — not registered, skipping`);
        continue;
      }
      try {
        logger.info(`[router] Fallback [${i + 1}/${total}] trying ${fallback}${fallbackCircuit.state === "recovering" ? " (recovering probe)" : ""}`);
        const result = await withRetry(() => fb.complete(fallbackParams));
        this.recordSuccess(fallback);
        return result;
      } catch (err) {
        const isRL = (err as any)?.status === 429;
        logger.warn(`[router] Fallback [${i + 1}/${total}] ${fallback} failed after retries: ${err}`);
        this.recordFailure(fallback, isRL);
      }
      tried.push(fallback);
    }

    throw new Error(`All providers failed (tried: ${tried.join(", ")})`);
  }
}
