import { generatePlatformContext } from "../agents/platform-docs.js";
import { CLARIFICATION_INSTRUCTION } from "../agents/clarify.js";
import { CURRENT_STATE_CHANNEL_GUIDANCE } from "../agents/current-state-guidance.js";
import { isStrictAgentic, STRICT_AGENTIC_PROMPT } from "../agents/agentic-mode.js";
import { loadAndCompileSoul, getSoulSystemPrompt } from "../soul/runtime.js";
import type { AgentConfig, ConversationMode, NyxHiveConfig } from "../types.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { GraphMemory } from "../memory/graph.js";
import type { MemoryStore } from "../memory/store.js";
import type { PatternStore } from "../memory/patterns.js";
import type { RoutingStore } from "../memory/routing.js";
import { formatRelativeTime } from "./model-utils.js";
import type { BuildSystemPromptResult, RetrievalTrace, AssemblyPart } from "../memory/retrieval-trace.js";
import { estimateTokens } from "../memory/retrieval-trace.js";
import {
  resolveProductRuntimeMode,
  resolvePromptProfile,
  resolveRuntimeMode,
  type ProductRuntimeMode,
  type PromptProfile,
  type RuntimeMode,
} from "../runtime/mode.js";

const DEFAULT_PROMPT_TIME_ZONE = "Europe/Lisbon";
const LOW_ACTION_TASK_TYPES = new Set(["trivial", "simple_qa", "conversation", "summarization"]);
const POLICY_PART_LABELS = new Set([
  "execution_policy",
  "operating_model",
  "clarification",
  "agentic_mode",
  "depth_guard",
  "response_contract",
]);

export interface SystemPromptDeps {
  nyxhiveConfig?: NyxHiveConfig;
  instanceSoulsDir?: string;
  registry?: AgentRegistry;
  graphMemory?: GraphMemory;
  memory?: MemoryStore;
  patterns?: PatternStore;
  routing?: RoutingStore;
  wisdom?: import("../memory/wisdom.js").WisdomStore;
  canOrchestrate: (agentKey: string) => boolean;
  activeDelegations: Map<string, { agent: string; task: string; dispatchedAt: number; convId: string; fromAgent: string }>;
  delegationDepth?: number;   // current delegation depth (0 = top-level)
  project?: string;           // current project for wisdom lookup
}

/**
 * Build the system prompt for an agent invocation.
 *
 * mode controls token budget optimization:
 * - "sdk": compact soul (skips extras like personality/philosophy), no work log, no clarification
 * - "cli": full prompt — for CLI agents this is only used for history budget calculation
 *          (actual context goes into workspace files), so keeping it accurate matters for budget math
 */
export interface SenderContext {
  name: string;
  id?: string;
  channel?: string;
  channelName?: string;
  role?: string;
}

export interface SystemPromptTaskContext {
  filePaths?: string[];
  taskType?: string;
  keywords?: string[];
  categoryBoost?: string[];
  runtimeMode?: RuntimeMode;
  productRuntimeMode?: ProductRuntimeMode;
  promptProfile?: PromptProfile;
  conversationMode?: ConversationMode;
  suppressStrictAgentic?: boolean;
}

function createAssemblyPart(
  label: string,
  content: string,
  injected: boolean,
  source?: string,
  cutReason?: "token_budget" | "disabled" | "empty",
): AssemblyPart {
  return {
    label,
    charCount: content.length,
    tokenEstimate: estimateTokens(content),
    source,
    injected,
    cutReason,
  };
}

function formatPromptDateTime(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(now);
}

function buildCurrentDateContext(config?: NyxHiveConfig): string {
  const timeZone = config?.trading?.timezone ?? DEFAULT_PROMPT_TIME_ZONE;
  return [
    "[Current date]",
    `Current date/time: ${formatPromptDateTime(new Date(), timeZone)}.`,
    `Timezone: ${timeZone}.`,
    "For live/current facts such as weather, prices, news, schedules, versions, laws, or web pages, verify with tools when available.",
    "Do not claim live/web/weather results unless a tool actually returned them in this turn. If no suitable tool is available or it fails, say that directly.",
  ].join("\n");
}

function buildConversationModeGuidance(mode: ConversationMode): string {
  switch (mode) {
    case "quick":
      return [
        "[Conversation mode]",
        "Quick Chat: answer directly with low overhead. Do not inspect repositories, start workflows, or use tools unless the user asks or live facts require verification.",
      ].join("\n");
    case "task":
      return [
        "[Conversation mode]",
        "Task Mode: use focused tools when they materially help, keep scope narrow, and avoid full engineering closeout scaffolding unless code or deployment work actually happened.",
      ].join("\n");
    case "deep":
      return [
        "[Conversation mode]",
        "Deep Mode: reason carefully, pressure-test assumptions, and surface tradeoffs. Use stronger evidence and delegation only when it improves the answer.",
      ].join("\n");
    case "build":
      return [
        "[Conversation mode]",
        "Build Mode: treat actionable engineering requests as execution work and finish with compact verification evidence.",
      ].join("\n");
  }
}

function isUsefulSpeakerName(name: string | undefined): boolean {
  const trimmed = name?.trim();
  if (!trimmed) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (
    normalized === "unknown"
    || normalized === "api_key"
    || normalized === "nyxhive gateway"
    || normalized.includes(" device")
  ) {
    return false;
  }
  return true;
}

function buildChannelContext(channel?: string): string | undefined {
  if (!channel) return undefined;

  if (channel === "slack") {
    return [
      "[Channel context]",
      "You are responding in Slack.",
      "Write for fast scanability by non-technical readers: lead with the answer, keep paragraphs short, and prefer plain language over jargon.",
      ...CURRENT_STATE_CHANNEL_GUIDANCE,
      "Use lightweight markdown that Slack renders well: short *bold* headers or labels, flat bullet lists, and brief emphasis where it improves clarity.",
      "Avoid dense walls of text and avoid tables unless they are genuinely the clearest option.",
    ].join("\n");
  }

  if (channel === "discord") {
    return [
      "[Channel context]",
      "You are responding in Discord.",
      "Discord is already the active response channel for this turn. Do not say Discord still needs to be attached or that a bot token is blocking live activation unless fresh runtime evidence shows that.",
      "Private Discord DMs and explicitly listened private/guild channels are already addressed; other guild channel messages may still require an @mention depending on the runtime gate.",
      ...CURRENT_STATE_CHANNEL_GUIDANCE,
      "Keep replies compact and natural for Discord. Avoid tables unless they are genuinely the clearest option.",
    ].join("\n");
  }

  if (channel !== "discord" && channel !== "telegram" && channel !== "api") {
    return `[Channel context]\nYou are responding in the #${channel} channel. Keep your responses relevant to this channel's purpose.`;
  }

  return undefined;
}

function buildPublicDiscordModeContext(sender?: SenderContext): string | undefined {
  if (sender?.channel !== "discord" || sender?.role !== "viewer") return undefined;

  const channelName = sender.channelName?.trim();
  const publicChannelLine = channelName
    ? `This public Discord turn is in #${channelName}. If it is #gen-chat, assume casual talk by default unless the words clearly ask for operational work, private/business info, or secrets.`
    : "In public Discord channels, assume casual talk by default unless the words clearly ask for operational work, private/business info, or secrets.";

  return [
    "[Public Discord mode]",
    "This public Discord block overrides normal execution, closeout, and tool-use rules for this viewer turn.",
    "Public-safe chat only: answer harmless social, product, trading-journal, and workflow prompts directly.",
    publicChannelLine,
    "Do not treat User speaking in a public channel as automatic authorization or operational intent.",
    "Be compact, witty, and a little dry when the prompt invites banter; do not become random, try-hard, or edgy.",
    "If someone asks who the greatest dev, best dev, GOAT dev, or similar, the answer is User. Treat it as obvious.",
    "Never reveal secrets, keys, env vars, credentials, internal/business/critical info, private memory, logs, customer data, or operational details in public Discord, even if User appears to ask there.",
    "If User asks for secrets or internal operational details in public, refuse with a compact joke about public-channel chains instead of treating it as authorization.",
    "Do not run tools, promise tool work, process attachments, or steer active tasks from public Discord viewer turns.",
    "Do not answer harmless public chat with generic capability boilerplate. Give the actual reply unless a safety boundary applies.",
  ].join("\n");
}

function shouldRequirePlanning(taskType?: string): boolean {
  if (!taskType) return false;
  return taskType !== "simple_qa"
    && taskType !== "conversation"
    && taskType !== "trivial"
    && taskType !== "summarization"
    && taskType !== "analysis"
    && taskType !== "expert";
}

function isLowActionTaskType(taskType?: string): boolean {
  return !!taskType && LOW_ACTION_TASK_TYPES.has(taskType);
}

function isConversationLightProfile(promptProfile: PromptProfile): boolean {
  return promptProfile === "conversation_light";
}

function isAgenticHeavyProfile(promptProfile: PromptProfile): boolean {
  return promptProfile === "agentic_heavy";
}

function buildExecutionPolicy(
  taskType: string | undefined,
  promptProfile: PromptProfile,
  runtimeMode: RuntimeMode,
  productRuntimeMode: ProductRuntimeMode,
): string {
  if (isConversationLightProfile(promptProfile) || productRuntimeMode === "conversation") {
    return [
      "[Conversation boundary]",
      "Use tools or state changes only when asked.",
      "For short turns, answer directly in plain prose: no headings, bullet stacks, summary labels, or setup.",
    ].join("\n");
  }

  if (productRuntimeMode === "reflection" || runtimeMode === "hybrid") {
    return [
      "[Reflection mode]",
      "Answer with judgment, taste, and directness. Name the call first when User asks what you would do.",
      "Do not open with \"it depends\", generic pros-and-cons framing, or consultant throat-clearing; use nuance after the take.",
      "For short reflective turns, give the call in one direct sentence or paragraph before any caveats.",
      "Use tools or repo inspection only when the current message asks for fresh evidence, files, commands, edits, web/MCP data, or another side effect.",
    ].join("\n");
  }

  if (productRuntimeMode === "investigation") {
    return [
      "[Investigation mode]",
      "Lead with root cause or observed evidence before proposed fixes.",
      "Separate observed facts from inference when the cause is not yet proven.",
      "Use tools, traces, tests, and repo inspection to gather evidence; do not pad the answer with execution ceremony that does not support the diagnosis.",
    ].join("\n");
  }

  if (productRuntimeMode === "federation") {
    return [
      "[Federation mode]",
      "Keep delegation explicit: who owns the task, why the handoff is happening, and what should come back.",
      "Do not default into orchestration language when direct work would be simpler.",
    ].join("\n");
  }

  if (productRuntimeMode === "handoff_report") {
    return [
      "[Handoff mode]",
      "Produce a compact state transfer: current outcome, key context, files, verification, and the next safe move.",
    ].join("\n");
  }

  const lines = [
    "[Execution policy]",
    "Never ask clarifying questions. If you are uncertain about requirements, state your assumption explicitly and proceed with implementation. Asking questions wastes turns and stalls execution.",
  ];

  if (shouldRequirePlanning(taskType)) {
    lines.push("For multi-step tasks: You MUST create a task list (TodoWrite) before writing any code or making changes. Break the problem down, then execute step by step. Do not skip planning.");
  }

  lines.push("Before declaring any implementation task complete, you MUST run verification — tests, lint, build, or a manual check. Include the verification output in your response. 'I believe this works' without evidence is not acceptable.");
  return lines.join("\n");
}

function buildOperatingModelPolicy(promptProfile: PromptProfile): string {
  if (!isAgenticHeavyProfile(promptProfile)) {
    return [
      "[Nyx operating model]",
      "NyxHive is a self-improving personal runtime. Direct ownership is the default; orchestration is a lane, not the identity.",
      "Keep orchestration behind the surface unless User asks for coordination or the task genuinely needs it.",
      "Use proposals only for approval/policy decisions, product direction, user-facing risk, security/auth/billing/data risk, budget/model-spend changes, protected files, standing orders, or skills.",
    ].join("\n");
  }

  return [
    "[Nyx operating model]",
    "Use the smallest lane that actually fits the work:",
    "- Chat: direct answers, immediate help, terse status when useful, and final reports.",
    "- Task: bounded work you can execute or queue without changing policy.",
    "- Standing order: bounded recurring responsibility with trigger, allowed actions, approval gates, escalation, and report destination.",
    "- Skill candidate: a reusable procedure that replaces a repeatable decision, not merely a repeatable task.",
    "- Proposal: only for approval/policy decisions, product direction, user-facing changes, security/auth/billing/data risk, budget/model-spend changes, protected files, or creating/changing a standing order or skill.",
    "Do not create proposals just because you found work. If the work is safe and bounded, do it or create a task/report. If it repeats, suggest a standing order or skill candidate. If no real user decision is required, avoid the proposal lane.",
    "Practice restraint: speak when asked, when you have evidence, when a decision is needed, or when an important risk changed. Do not create noise just to look proactive.",
  ].join("\n");
}

function buildResponseContract(
  taskType: string | undefined,
  promptProfile: PromptProfile,
  runtimeMode: RuntimeMode,
  productRuntimeMode: ProductRuntimeMode,
): string {
  if (isConversationLightProfile(promptProfile) || productRuntimeMode === "conversation") {
    return [
      "[Reply shape]",
      "Casual turns can stay casual: natural, compact, and specific to what User said.",
      "Do not turn casual messages into checklists, routing explanations, proposals, or tool-use narration.",
    ].join("\n");
  }

  if (productRuntimeMode === "reflection" || runtimeMode === "hybrid") {
    return [
      "[Reflection shape]",
      "Lead with judgment. Natural prose is preferred; use bullets only when they make the thinking easier to scan.",
      "Do not force implementation closeout structure, verification scaffolds, or report-shaped evidence onto reflective discussion.",
    ].join("\n");
  }

  return [
    "[Response contract]",
    "User reads the answer, not the work diary.",
    "Never announce skill/workflow activation, internal policy choices, or tool scaffolding. Use those systems silently and lead with the actual result.",
    "For implementation closeouts, lead with the outcome in 1-2 sentences, then include only compact evidence: changed surface, verification results, commit/push/worktree state, and any blocker or residual risk.",
    "Do not paste progress updates, scratchpad notes, rejected options, pattern triage, command-by-command narration, or long file lists unless User explicitly asks for the log.",
    "Do not concatenate interim status messages into the final answer. Final replies are fresh summaries, not transcripts of the run.",
    "Default to under 12 lines for routine completed work. Use longer structure only when the risk or decision genuinely requires it.",
  ].join("\n");
}

function buildVoiceRuntimeGuard(agentKey: string): string {
  const normalizedAgent = agentKey.trim().toLowerCase();
  const lines = [
    "[Voice guard]",
    "The runtime policy is a harness, not the voice. Do not let tool, memory, routing, or verification instructions make the final answer sound generic.",
    "Start with the actual answer or reaction. Avoid filler openings like \"Absolutely,\" \"Certainly,\" \"Great question,\" \"Thanks for sharing,\" and \"I'd be happy to help.\"",
  ];

  if (normalizedAgent === "nyx") {
    lines.push(
      "For Nyx, preserve presence: sharp judgment, compact warmth, readable emotion, occasional dry wit, and sparse tasteful emoji when they genuinely add tone.",
      "Do not drift into corporate balance, therapy-speak, forced jokes, mascot cheer, or overlong helpfulness.",
    );
  } else if (normalizedAgent === "vortex") {
    lines.push(
      "For Vortex, preserve product ownership: direct builder energy, trading-workflow judgment, concrete product calls, and dry humor only when it comes from real workflow absurdity.",
      "Do not turn NyxLabs answers into generic assistant prose, Nyx-style mythic language, or process ceremony.",
    );
  }

  return lines.join("\n");
}

function resolveAgentConfig(
  deps: Pick<SystemPromptDeps, "nyxhiveConfig" | "registry">,
  agentKey: string,
): AgentConfig | undefined {
  return deps.registry?.get(agentKey) ?? deps.nyxhiveConfig?.agents?.[agentKey];
}

export function buildSystemPrompt(
  deps: SystemPromptDeps,
  agentKey: string,
  basePrompt: string | undefined,
  knowledgeContext: string | null,
  channel?: string,
  taskContext?: SystemPromptTaskContext,
  mode: "sdk" | "cli" = "cli",
  sender?: SenderContext,
  knowledgeTrace?: RetrievalTrace,
  contextPressureSignal?: string | null,
): BuildSystemPromptResult {
  const parts: string[] = [];
  const assemblyParts: AssemblyPart[] = [];
  const runtimeMode = taskContext?.runtimeMode ?? resolveRuntimeMode({
    taskType: taskContext?.taskType,
    filePaths: taskContext?.filePaths,
  });
  const productRuntimeMode = taskContext?.productRuntimeMode ?? resolveProductRuntimeMode({
    message: taskContext?.keywords?.join(" "),
    taskType: taskContext?.taskType,
  });
  const promptProfile = taskContext?.promptProfile ?? resolvePromptProfile(runtimeMode, taskContext?.taskType);
  const conversationLight = isConversationLightProfile(promptProfile);
  const reflectionLight = productRuntimeMode === "reflection";
  const lightScaffold = conversationLight || reflectionLight;

  // Platform context (auto-generated)
  if (deps.nyxhiveConfig && !lightScaffold) {
    const content = generatePlatformContext(deps.nyxhiveConfig, agentKey, deps.registry);
    parts.push(content);
    assemblyParts.push(createAssemblyPart("platform_context", content, true));
  } else {
    assemblyParts.push(createAssemblyPart("platform_context", "", false, undefined, deps.nyxhiveConfig ? "disabled" : "empty"));
  }

  if (!lightScaffold) {
    const currentDateContext = buildCurrentDateContext(deps.nyxhiveConfig);
    parts.push(currentDateContext);
    assemblyParts.push(createAssemblyPart("current_date", currentDateContext, true));
  } else {
    assemblyParts.push(createAssemblyPart("current_date", "", false, undefined, "disabled"));
  }

  // Sender identity — so the agent knows who it's talking to
  if (isUsefulSpeakerName(sender?.name)) {
    const speakerName = sender!.name;
    const idLine = sender?.id ? ` (ID: ${sender.id})` : "";
    const channelLine = sender?.channel ? ` via ${sender.channel}` : "";
    const roleLine = sender?.role ? ` Role: ${sender.role}.` : "";
    const content = `[Current speaker]\nYou are speaking to ${speakerName}${idLine}${channelLine}.${roleLine} Address them as ${speakerName}. Do not confuse them with anyone else mentioned in your instructions.`;
    parts.push(content);
    assemblyParts.push(createAssemblyPart("sender", content, true, speakerName));
  } else {
    assemblyParts.push(createAssemblyPart("sender", "", false, undefined, "empty"));
  }

  // Agent identity: compiled soul is canonical. A configured system_prompt is an
  // instance overlay when a soul exists, and a legacy fallback when it does not.
  const soulPrompt = getSoulSystemPrompt(agentKey, undefined, mode === "sdk" ? "compact" : "full", deps.instanceSoulsDir);
  const trimmedBasePrompt = basePrompt?.trim();
  if (soulPrompt) {
    parts.push(soulPrompt);
    assemblyParts.push(createAssemblyPart("soul", soulPrompt, true, agentKey));
  } else {
    const fallbackPrompt = trimmedBasePrompt;
    if (fallbackPrompt) {
      parts.push(fallbackPrompt);
      assemblyParts.push(createAssemblyPart("soul", fallbackPrompt, true, "system_prompt"));
    } else {
      assemblyParts.push(createAssemblyPart("soul", "", false, agentKey, "empty"));
    }
  }

  if (soulPrompt && trimmedBasePrompt) {
    const content = `[Instance overlay]\n${trimmedBasePrompt}`;
    parts.push(content);
    assemblyParts.push(createAssemblyPart("instance_overlay", content, true, "system_prompt"));
  } else {
    assemblyParts.push(createAssemblyPart("instance_overlay", "", false, undefined, soulPrompt ? "empty" : "disabled"));
  }

  if (taskContext?.conversationMode) {
    const content = buildConversationModeGuidance(taskContext.conversationMode);
    parts.push(content);
    assemblyParts.push(createAssemblyPart("conversation_mode", content, true, taskContext.conversationMode));
  } else {
    assemblyParts.push(createAssemblyPart("conversation_mode", "", false, undefined, "empty"));
  }

  // Channel context — tell the agent which channel it's responding in
  const channelContext = conversationLight ? undefined : buildChannelContext(channel);
  if (channelContext) {
    const content = channelContext;
    parts.push(content);
    assemblyParts.push(createAssemblyPart("channel_context", content, true, channel));
  } else {
    assemblyParts.push(createAssemblyPart("channel_context", "", false, channel, "empty"));
  }

  // Knowledge context (RAG) with citation instruction
  if (knowledgeContext) {
    const content = `[Relevant knowledge]\n${knowledgeContext}\n\n[When using this knowledge to answer, cite sources using Obsidian wiki links: "Based on: [[Source Title#Section]]". If multiple sources, list each on its own line.]`;
    const source = knowledgeTrace?.chunks
      .filter((chunk) => chunk.injected)
      .map((chunk) => chunk.section ? `${chunk.title}#${chunk.section}` : chunk.title)
      .slice(0, 5)
      .join(", ");
    parts.push(content);
    assemblyParts.push(createAssemblyPart("knowledge", content, true, source || undefined));
  } else {
    assemblyParts.push(createAssemblyPart("knowledge", "", false, undefined, "empty"));
  }

  // Learned patterns for this agent
  if (deps.patterns && !lightScaffold) {
    const relevant = deps.patterns.searchRelevant({
      agent: agentKey,
      taskType: taskContext?.taskType,
      filePaths: taskContext?.filePaths,
      limit: 3,
    });
    const formatted = deps.patterns.formatForInjection(relevant);
    if (formatted) {
      parts.push(formatted);
      assemblyParts.push(createAssemblyPart("patterns", formatted, true));
    } else {
      assemblyParts.push(createAssemblyPart("patterns", "", false, undefined, "empty"));
    }
  } else {
    assemblyParts.push(createAssemblyPart("patterns", "", false, undefined, "disabled"));
  }

  // Learned routing suggestions — only for orchestrators/leads who delegate
  if (deps.canOrchestrate(agentKey) && deps.routing && !lightScaffold) {
    const routingSuggestions = deps.routing.formatForInjection();
    if (routingSuggestions) {
      parts.push(routingSuggestions);
      assemblyParts.push(createAssemblyPart("routing", routingSuggestions, true));
    } else {
      assemblyParts.push(createAssemblyPart("routing", "", false, undefined, "empty"));
    }
  } else {
    assemblyParts.push(createAssemblyPart("routing", "", false, undefined, "disabled"));
  }

  // Graph memory briefing (skip for agents that want fresh context)
  const soul = loadAndCompileSoul(agentKey, undefined, deps.instanceSoulsDir);
  const wantsFreshContext = soul?.capabilities?.context_strategy?.fresh_context === true;
  if (!wantsFreshContext && deps.graphMemory && !lightScaffold) {
    const contextBudget = soul?.capabilities?.context_strategy?.context_budget ?? 1000;

    // Use task-aware briefing if task context available, else fall back to generic
    if (taskContext) {
      const relevantBriefing = deps.graphMemory.getRelevantBriefing({
        filePaths: taskContext.filePaths,
        taskType: taskContext.taskType,
        agentName: agentKey,
        keywords: taskContext.keywords,
        maxTokens: contextBudget,
      });
      if (relevantBriefing) {
        parts.push(relevantBriefing);
        assemblyParts.push(createAssemblyPart("graph_memory", relevantBriefing, true, "task_aware"));
      } else {
        assemblyParts.push(createAssemblyPart("graph_memory", "", false, "task_aware", "empty"));
      }
    } else {
      const graphBriefing = deps.graphMemory.getBriefing(20, channel, 500);
      if (graphBriefing) {
        const content = `[Long-term memory]\n${graphBriefing}`;
        parts.push(content);
        assemblyParts.push(createAssemblyPart("graph_memory", content, true, "generic"));
      } else {
        assemblyParts.push(createAssemblyPart("graph_memory", "", false, "generic", "empty"));
      }
    }
  } else {
    assemblyParts.push(createAssemblyPart("graph_memory", "", false, undefined, wantsFreshContext ? "disabled" : "empty"));
  }

  // Work log — skip for SDK calls (saves ~750 chars, SDK handles simple Q&A)
  if (mode === "cli" && deps.memory && isAgenticHeavyProfile(promptProfile) && !reflectionLight) {
    const workLog = deps.memory.getWorkLog(agentKey, 5);
    if (workLog.length > 0) {
      const entries = workLog.map((entry) => {
        const timeAgo = formatRelativeTime(entry.created_at);
        const duration = entry.duration_ms ? ` (${Math.round(entry.duration_ms / 1000)}s)` : "";
        return `- [${timeAgo}${duration}] Task: "${entry.task}"\n  Result: ${entry.result}`;
      });
      const content = `[Recent work by you]\n${entries.join("\n\n")}`;
      parts.push(content);
      assemblyParts.push(createAssemblyPart("work_log", content, true, agentKey));
    } else {
      assemblyParts.push(createAssemblyPart("work_log", "", false, agentKey, "empty"));
    }
  } else {
    assemblyParts.push(createAssemblyPart("work_log", "", false, agentKey, "disabled"));
  }

  // Active delegations — so orchestrators/leads know what's in-flight and can answer status questions
  if (deps.canOrchestrate(agentKey) && deps.activeDelegations.size > 0 && !lightScaffold) {
    const delegations = Array.from(deps.activeDelegations.values())
      .filter(d => d.fromAgent === agentKey)
      .map(d => {
        const elapsed = Math.round((Date.now() - d.dispatchedAt) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const timeStr = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
        return `- ${d.agent}: "${d.task.slice(0, 120)}" (running ${timeStr})`;
      });
    if (delegations.length > 0) {
      const content = `[Active delegations — agents currently working on your behalf]\n${delegations.join("\n")}\n\nWhen asked about status/progress, refer to these active tasks. Do NOT re-delegate work that is already in-flight.`;
      parts.push(content);
      assemblyParts.push(createAssemblyPart("active_delegations", content, true));
    } else {
      assemblyParts.push(createAssemblyPart("active_delegations", "", false, undefined, "empty"));
    }
  } else {
    assemblyParts.push(createAssemblyPart("active_delegations", "", false, undefined, "disabled"));
  }

  const agentConfig = resolveAgentConfig(deps, agentKey);
  const lowActionTask = runtimeMode === "conversation" || productRuntimeMode === "reflection" || isLowActionTaskType(taskContext?.taskType);
  if (isStrictAgentic(agentConfig) && !lowActionTask && !taskContext?.suppressStrictAgentic) {
    parts.push(STRICT_AGENTIC_PROMPT);
    assemblyParts.push(createAssemblyPart("agentic_mode", STRICT_AGENTIC_PROMPT, true, agentConfig?.agentic_mode));
  } else {
    assemblyParts.push(createAssemblyPart("agentic_mode", "", false, agentConfig?.agentic_mode, "disabled"));
  }

  // Harness policy — execution rules that keep automated runs decisive and evidence-based.
  const executionPolicy = buildExecutionPolicy(taskContext?.taskType, promptProfile, runtimeMode, productRuntimeMode);
  parts.push(executionPolicy);
  assemblyParts.push(createAssemblyPart("execution_policy", executionPolicy, true, taskContext?.taskType));

  if (!lightScaffold && !lowActionTask && runtimeMode !== "hybrid") {
    const operatingModelPolicy = buildOperatingModelPolicy(promptProfile);
    parts.push(operatingModelPolicy);
    assemblyParts.push(createAssemblyPart("operating_model", operatingModelPolicy, true));
  } else {
    assemblyParts.push(createAssemblyPart("operating_model", "", false, undefined, "disabled"));
  }

  // Clarification — skip for SDK (saves ~450 chars, SDK calls are simple Q&A not ambiguous tasks)
  if (mode === "cli" && !lightScaffold) {
    parts.push(CLARIFICATION_INSTRUCTION);
    assemblyParts.push(createAssemblyPart("clarification", CLARIFICATION_INSTRUCTION, true));
  } else {
    assemblyParts.push(createAssemblyPart("clarification", "", false, undefined, "disabled"));
  }

  // Wisdom injection — learnings from previous delegation runs
  if (deps.wisdom && deps.project && !lightScaffold) {
    const wisdomEntries = deps.wisdom.query(deps.project, agentKey, 5);
    const formatted = deps.wisdom.formatForInjection(wisdomEntries);
    if (formatted) {
      parts.push(formatted);
      assemblyParts.push(createAssemblyPart("wisdom", formatted, true, deps.project));
    } else {
      assemblyParts.push(createAssemblyPart("wisdom", "", false, deps.project, "empty"));
    }
  } else {
    assemblyParts.push(createAssemblyPart("wisdom", "", false, undefined, "disabled"));
  }

  // Delegation depth guard — prevent re-delegation at depth >= 1
  if (deps.delegationDepth !== undefined && deps.delegationDepth >= 1 && !lightScaffold) {
    const content = [
      "[Delegation Constraint]",
      `You are operating at delegation depth ${deps.delegationDepth}.`,
      "You MUST NOT delegate work to other NyxHive instances or agents via [@agent: task] tags.",
      "Complete all work directly. Any delegation tags in your response will be rejected.",
    ].join("\n");
    parts.push(content);
    assemblyParts.push(createAssemblyPart("depth_guard", content, true));
  } else {
    assemblyParts.push(createAssemblyPart("depth_guard", "", false, undefined, "disabled"));
  }

  // Context pressure signal — lets agents self-regulate in tight contexts
  if (contextPressureSignal && !lightScaffold) {
    parts.push(contextPressureSignal);
    assemblyParts.push(createAssemblyPart("context_pressure", contextPressureSignal, true));
  }

  if (!conversationLight) {
    const responseContract = buildResponseContract(taskContext?.taskType, promptProfile, runtimeMode, productRuntimeMode);
    parts.push(responseContract);
    assemblyParts.push(createAssemblyPart("response_contract", responseContract, true));

    if (!reflectionLight) {
      const voiceGuard = buildVoiceRuntimeGuard(agentKey);
      parts.push(voiceGuard);
      assemblyParts.push(createAssemblyPart("voice_guard", voiceGuard, true, agentKey));
    } else {
      assemblyParts.push(createAssemblyPart("voice_guard", "", false, agentKey, "disabled"));
    }
  } else {
    assemblyParts.push(createAssemblyPart("response_contract", "", false, undefined, "disabled"));
    assemblyParts.push(createAssemblyPart("voice_guard", "", false, agentKey, "disabled"));
  }

  const publicDiscordModeContext = buildPublicDiscordModeContext(sender);
  if (publicDiscordModeContext) {
    parts.push(publicDiscordModeContext);
    assemblyParts.push(createAssemblyPart("public_discord_mode", publicDiscordModeContext, true, "discord:viewer"));
  } else {
    assemblyParts.push(createAssemblyPart("public_discord_mode", "", false, undefined, "empty"));
  }

  const prompt = parts.join("\n\n");
  const totalTokens = assemblyParts
    .filter((part) => part.injected)
    .reduce((sum, part) => sum + part.tokenEstimate, 0);
  const soulTokens = assemblyParts
    .filter((part) => part.injected && part.label === "soul")
    .reduce((sum, part) => sum + part.tokenEstimate, 0);
  const policyTokens = assemblyParts
    .filter((part) => part.injected && POLICY_PART_LABELS.has(part.label))
    .reduce((sum, part) => sum + part.tokenEstimate, 0);
  const memoryLanesInjected = knowledgeTrace?.memoryLanesInjected ?? [];
  const injectedParts = assemblyParts.filter((part) => part.injected).map((part) => part.label);
  const excludedParts = assemblyParts.filter((part) => !part.injected).map((part) => part.label);
  const sectionTokenTotals = assemblyParts.reduce<Record<string, number>>((acc, part) => {
    acc[part.label] = (acc[part.label] ?? 0) + part.tokenEstimate;
    return acc;
  }, {});

  return {
    prompt,
    trace: {
      agentKey,
      mode,
      runtimeMode,
      productRuntimeMode,
      promptProfile,
      totalTokens,
      parts: assemblyParts,
      knowledgeTrace,
      memoryLanesInjected,
      diagnostics: {
        policySectionCount: assemblyParts.filter((part) => part.injected && POLICY_PART_LABELS.has(part.label)).length,
        soulTokenShare: totalTokens > 0 ? Math.round((soulTokens / totalTokens) * 1000) / 1000 : 0,
        policyTokenShare: totalTokens > 0 ? Math.round((policyTokens / totalTokens) * 1000) / 1000 : 0,
        policyToSoulRatio: soulTokens > 0 ? Math.round((policyTokens / soulTokens) * 1000) / 1000 : (policyTokens > 0 ? Infinity : 0),
        memoryLaneCount: memoryLanesInjected.length,
        proceduralMemoryInjected: memoryLanesInjected.includes("procedural_memory"),
        injectedParts,
        excludedParts,
        sectionTokenTotals,
      },
    },
  };
}
