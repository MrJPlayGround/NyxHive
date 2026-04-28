// --- Agent Configuration ---

import type { SoulContextStrategy } from "./soul/types.js";
export type { SoulContextStrategy } from "./soul/types.js";
import type { RelativeTier } from "./soul/types.js";
import type { EffortLevel } from "./providers/types.js";
export type { EffortLevel } from "./providers/types.js";
import type { FileAttachment } from "./providers/types.js";
import type { CLIProgress } from "./agents/invoke.js";
import type { TrustOrigin } from "./security/input-sanitizer.js";

export type ConversationMode = "quick" | "task" | "build" | "deep";

export interface AgentConfig {
  name: string;
  provider: string;
  model: string;
  min_model?: string;
  max_model?: string;  // Model ceiling — routing will never exceed this tier
  companion_mode?: boolean; // General-purpose chat companion: keep full default model, decide tools per turn
  agentic_mode?: "standard" | "strict"; // Strict = Codex-style execution contract with evidence-backed completion
  always_cli?: boolean;
  cli_fallback?: string;
  anthropic_runtime?: string;
  working_directory: string;
  system_prompt?: string;
  soul?: string;  // Path to soul YAML file, or agent key to look up in souls/ dir
  capabilities?: string[];
  sandbox?: "docker" | "macos" | "none";  // Override global default
  role?: "orchestrator" | "lead" | "coder" | "reviewer" | "expert" | "worker" | "heartbeat";
  allowed_directories?: string[];  // Extra runtime paths local tools may access
  allowed_tools?: string[];        // Whitelist exposed local runtime tools
  disallowed_tools?: string[];     // Blacklist exposed local runtime tools
  toolset?: "default" | "read_only" | "coding" | "proposal_exec" | "chat_safe" | "off"; // Named runtime tool profile
  mcp_tools?: string[];            // MCP tools this agent can access via --mcp-config
  context_strategy?: SoulContextStrategy;
  timeout_ms?: number;             // Per-agent processor timeout (default: AGENT_TIMEOUT_MS)
  credentials?: string[];          // Env var names this agent is allowed to receive from vault
  approved_commands?: string[];    // Commands pre-approved for this agent (bypasses approval tier)
  max_tool_turns?: number;         // Max CLI turns per invocation (default: 50). Controls cost.
  effort?: EffortLevel;            // Effort level for Claude API calls (low/medium/high/max). Defaults by role.
  skills?: string[];               // Available skills for this agent. Omit = all skills.
  identity?: {
    slack_username?: string;
    slack_emoji?: string;
    slack_icon_url?: string;
    ack_reaction?: string;
    done_reaction?: string;
    error_reaction?: string;
    typing_reaction?: string;
  };
}

// --- Team Configuration ---

export interface TeamConfig {
  name: string;
  agents: string[];
  description?: string;
}

export interface RelayOriginContext {
  originInstance: string;
  callbackUrl: string;
  callbackToken: string;
}

export interface CrawlSourceConfig {
  name: string;
  url: string;
  schedule: string;
  depth?: number;
  page_limit?: number;
  path_glob?: string;
  scope?: string;
  enabled?: boolean;
}

export interface CrawlConfig {
  enabled?: boolean;
  default_depth?: number;
  default_page_limit?: number;
  timeout_ms?: number;
  sources?: CrawlSourceConfig[];
}

// --- Message Data ---

export interface InputRequestOption {
  key: string;
  description?: string;
}

export interface InputRequest {
  question: string;
  options?: InputRequestOption[];
  timeout_ms?: number;
  context_hint?: string;
}

export interface ParsedChannelInputRequest {
  messageId: string;
  question: string;
  options: InputRequestOption[];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function isInputRequestOption(value: unknown): value is InputRequestOption {
  if (!isObjectRecord(value)) return false;
  if (typeof value.key !== "string" || value.key.trim().length === 0) return false;
  return value.description === undefined || typeof value.description === "string";
}

export function parseChannelInputRequest(data: unknown): ParsedChannelInputRequest | null {
  if (!isObjectRecord(data)) return null;
  const messageId = typeof data.message_id === "string" ? data.message_id : null;
  const question = typeof data.question === "string" ? data.question.trim() : "";
  if (!messageId || !question) return null;
  const options = Array.isArray(data.options)
    ? data.options.flatMap((option) => {
        if (!isInputRequestOption(option)) return [];
        const key = option.key.trim();
        const description = option.description?.trim();
        return key ? [{ key, description: description || undefined }] : [];
      })
    : [];
  return { messageId, question, options };
}

export interface ProcessImmediateOpts {
  channel: string;
  channel_name?: string;
  sender: string;
  sender_id?: string;
  sender_role?: string;
  thread_id?: string;
  task_id?: string;
  message: string;
  agent?: string;
  is_group?: boolean;
  files?: FileAttachment[];
  benchmark?: boolean;
  onProgress?: (info: CLIProgress) => void;
  onEvent?: (event: SSEEvent) => void;
  timeout_ms?: number;
  cwdOverride?: string;
  trust?: TrustOrigin;
  modelOverride?: string;
  reasoningEffort?: EffortLevel;
  conversationMode?: ConversationMode;
  modelHint?: RelativeTier;
  mode?: "default" | "ralph";
  relay?: RelayOriginContext;
}

export interface ProcessImmediateResult {
  message_id: string;
  response: string;
  agent: string;
  trace_id?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost?: number;
  duration_ms?: number;
}

export interface SuspendedProcessHandle {
  session_id: string;
  session_runtime?: SessionRuntime;
}

export interface SuspendedMessage {
  message_id: string;
  request_id: string;
  channel: string;
  sender: string;
  sender_id?: string;
  task_id?: string;
  agent?: string;
  thread_id?: string;
  original_message: string;
  request: InputRequest;
  response_text: string;
  reply?: string;
  process_handle?: SuspendedProcessHandle;
  suspended_at: number;
  timeout_at: number;
  resumed_at?: number;
}

export type MessageStatus = "pending" | "processing" | "suspended" | "completed" | "failed" | "dead_letter";

export interface MessageData {
  message_id: string;
  task_id?: string;
  channel: string;
  sender: string;
  sender_id?: string;
  message: string;
  agent?: string;
  files?: string;
  images?: Array<{ type: string; data: string }>;
  conversation_id?: string;
  from_agent?: string;
  thread_id?: string;
  relay_origin_instance?: string;
  relay_callback_url?: string;
  relay_callback_token?: string;
  status: MessageStatus;
  retry_count: number;
  last_error?: string;
  last_activity?: string;
  last_progress_text?: string;
  last_progress_at?: number;
  claimed_by?: string;
  created_at: number;
  updated_at: number;
}

export interface ResponseData {
  id?: number;
  message_id: string;
  channel: string;
  sender: string;
  sender_id?: string;
  message: string;
  original_message: string;
  agent?: string;
  files?: string;
  status: "pending" | "sent" | "failed";
  created_at: number;
  acked_at?: number;
}

// --- Inbound Artifacts ---

export type ArtifactAcquisitionStatus = "acquired" | "failed";
export type ArtifactHandlerStatus = "unprocessed" | "unsupported" | "pending" | "processed" | "failed";

export interface InboundArtifactRecord {
  artifact_id: string;
  run_id: string | null;
  message_id: string | null;
  trace_id: string | null;
  channel: string | null;
  source: string;
  name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  storage_path: string | null;
  acquisition_status: ArtifactAcquisitionStatus;
  acquisition_error: string | null;
  handler_status: ArtifactHandlerStatus;
  handler: string | null;
  created_at: number;
  updated_at: number;
}

// --- BTW (Side Query) ---

/** BTW — ephemeral question to a running agent */
export interface BtwRequest {
  question: string;
  conversation_id?: string;
  source: string; // "human" or agent key
}

export interface BtwResponse {
  answer: string;
  context_tokens: number;
  model: string;
}

// --- Steering ---

/** Steering — mid-task context injection */
export interface SteerRequest {
  message: string;
  conversation_id?: string;
  priority: "normal" | "interrupt";
  source: string;
  ttl_seconds?: number;
  on_expire?: "discard";
}

export interface SteerResponse {
  steer_id: string;
  status: "queued";
  target_message_id: string;
  estimated_delivery: "next_checkpoint" | "next_turn";
}

export interface SteerRecord {
  id: number;
  steer_id: string;
  target_message_id: string | null;
  target_agent: string;
  conversation_id: string;
  source: string;
  channel: string | null;
  message: string;
  priority: "normal" | "interrupt";
  status: "pending" | "delivered" | "expired";
  ttl_seconds: number | null;
  on_expire: "discard";
  created_at: number;
  delivered_at: number | null;
  expired_at: number | null;
}

/** Active task info for target resolution */
export interface ActiveTask {
  message_id: string;
  conversation_id: string;
  activity: string;
  started_at: number;
}

// --- Task Types (re-export from providers for single source of truth) ---

import type { TaskType as _TaskType } from "./providers/types.js";
export type TaskType = _TaskType;

// --- Config ---

/** Single target or array of targets for multi-channel notifications. */
export type NotificationTargetConfig =
  | { channel: string; recipient: string }
  | Array<{ channel: string; recipient: string }>;

export interface NyxHiveConfig {
  daemon: {
    name: string;
    log_level: "debug" | "info" | "warn" | "error";
    data_dir: string;
    claude_config_dir?: string; // Path to .claude config dir (for Keychain hash + CLI env)
    codex_home?: string;        // Path to .codex home dir (for auth + session isolation)
    primary_agent?: string;     // Agent key that receives main-brain overrides
    main_brain?: string;         // Default brain override (anthropic|codex|opus), CLI --brain takes precedence
    workflow_mode?: "direct" | "proposal_first";
    owner_channel?: string;    // Preferred alert channel (e.g., "telegram")
    owner_id?: string;         // Owner's ID on that channel
    webhook_url?: string;      // Global webhook URL — fired on every delegation completion
    webhook_secret?: string;   // Shared secret sent as Authorization: Bearer <secret>
    projects?: Array<{
      name: string;
      repo_path: string;
      default?: boolean;
      verify?: {
        test_command?: string;
        build_command?: string;
        timeout_ms?: number;
      };
    }>;
  };
  notifications?: {
    proposals?: NotificationTargetConfig;
    alerts?: NotificationTargetConfig;
    reports?: NotificationTargetConfig;
    activity?: NotificationTargetConfig;
    trades?: NotificationTargetConfig;
  };
  server: {
    port: number;
    api_key?: string;
    api_key_env?: string;
    public_url?: string;
    allowed_origins?: string[];
    require_auth?: boolean;
    rate_limit_rpm?: number;
    request_timeout_ms?: number;
  };
  agents: Record<string, AgentConfig>;
  teams?: Record<string, TeamConfig>;
  providers: Record<string, {
    api_key_env?: string;
    auth_mode?: "api_key" | "codex";
    runtime?: "cli" | "codex_app_server";
    fallback?: "none" | "openrouter";
    default_model?: string;
    url?: string;
    model?: string;
  }>;
  routing: {
    classifier_model: string;
    classifier_provider: string;
    cli_escalation_tasks: string[];
    tasks?: Record<string, { provider: string; model: string; max_tokens?: number }>;
    overrides?: Record<string, { provider: string; model: string; max_tokens?: number }>;
    fallback_order?: string[];
  };
  context: {
    max_history: number;
    summary_threshold: number;
    summary_max_tokens?: number;
    history_budget_ratio?: number;
  };
  budget?: {
    monthly_limit?: number;
    warning_threshold?: number;
    daily_limit?: number;
    per_conversation_warn?: number;
    autonomous_ceiling?: number;
  };
  memory?: {
    extraction_interval?: number;
    graph_briefing_max_nodes?: number;
    graph_decay_interval_ms?: number;
    graph_prune_min_importance?: number;
  };
  runtime?: {
    mode?: "legacy" | "kernel";
  };
  models?: {
    cost_rates_file?: string;
    tiers_file?: string;
  };
  telegram?: {
    bot_token_env: string;
  };
  discord?: {
    bot_token_env: string;
    reply_surface?: "same_surface" | "prefer_thread" | "thread_only";
    require_mention?: boolean;
    privileged_user_ids?: string[];
    privileged_user_id_env?: string;
  };
  slack?: {
    bot_token_env: string;
    app_token_env: string;
    auto_approve_role?: "operator" | "engineer" | "support" | "viewer";
    user_roles?: Record<string, "operator" | "engineer" | "support" | "viewer">;
    channel_agents?: Record<string, string>;
    monitor_channels?: string[];
    auto_thread?: boolean;
    interactive_replies?: boolean;
    mode?: "socket" | "http";
    signing_secret_env?: string;
    webhook_path?: string;
    accounts?: Record<string, {
      bot_token_env: string;
      app_token_env: string;
      channel_agents?: Record<string, string>;
      monitor_channels?: string[];
    }>;
    streaming?: {
      enabled?: boolean;
      update_interval_ms?: number;
      max_preview_chars?: number;
    };
    channels?: Record<string, {
      agent?: string;
      require_mention?: boolean;
      system_prompt?: string;
      allowed_users?: string[];
      tools?: string[];
      allow_bots?: boolean;
      history_limit?: number;
      dm_history_limit?: number;
    }>;
    chunk_limit?: number;
  };
  imessage?: {
    db_path?: string;
    poll_interval_ms?: number;
    allowed_numbers?: string[];
  };
  webhook?: {
    enabled: boolean;
    sources?: Record<string, {
      secret_env: string;
      events: string[];
      agent?: string;
      repos?: string[];
    }>;
  };
  crawl?: CrawlConfig;
  vault?: {
    path: string;
    skip_dirs?: string[];
    auto_ingest_interval_hours?: number;
    watch?: boolean;
    generate_canvas?: boolean;
  };
  pairing?: {
    enabled: boolean;
  };
  sandbox?: {
    backend: "docker" | "macos" | "none";
    docker_image?: string;
    required?: boolean;
  };
  queue?: {
    response_ttl_days?: number;
  };
  auth?: {
    enabled?: boolean;
    session_ttl_days?: number;
    max_sessions_per_user?: number;
    require_invite?: boolean;
  };
  apns?: {
    key_id: string;
    team_id: string;
    key_path: string;
    bundle_id: string;
    production: boolean;
  };
  scheduler?: {
    enabled?: boolean;
    automations?: boolean;
    seed_defaults?: boolean;
    task_profile?: "full" | "dev" | "trading" | "monitor" | "none";
    tick_interval_ms?: number;
    idle_discovery_enabled?: boolean;
    idle_threshold_minutes?: number;
    idle_cooldown_minutes?: number;
    notify_channels?: string[];
    tasks?: Array<{
      name: string;
      description?: string;
      cron?: string;
      run_at?: number;
      agent: string;
      prompt: string;
      channel?: string;
      recipient?: string;
      notify_channels?: string[];
      timeout_ms?: number;
      authority_profile?: "scheduled" | "system" | "interactive";
      category?: string;
      chain_to?: {
        task_name: string;
        inject_result?: boolean;
        only_if?: string | string[];
      };
    }>;
  };
  proposals?: {
    max_concurrent_executions?: number;
    archive_after_days?: number;
  };
  review_gate?: {
    enabled: boolean;
    model?: string;
    provider?: string;
    max_tokens?: number;
    max_diff_lines?: number;
    timeout_ms?: number;
    max_retries?: number;
    roles?: string[];
  };
  orchestration?: {
    agents_sdk?: {
      enabled?: boolean;
    };
  };
  allowed_directories?: string[];
  remotes?: Record<string, {
    url: string;
    api_key_env: string;
    description?: string;
    agents?: string[];
  }>;
  threads?: {
    max_concurrent?: number;
    timeout_ms?: number;
  };
  trading?: {
    enabled?: boolean;
    timezone?: string;
    default_market?: string;
    risk_per_trade_percent?: number;
    daily_loss_limit?: number;
    max_position_size?: number;
    max_concurrent_positions?: number;
    max_daily_trades?: number;
  };
}

// --- Invocation Result ---

export type InvocationTaskType = TaskType | "nyx_direct";

export interface InvocationResult {
  response: string;
  agent: string;
  method: "cli" | "sdk" | "api";
  input_request?: InputRequest;
  task_type?: InvocationTaskType;
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost?: number;
  duration_ms: number;
  toolsUsed?: string[];
  runtime_events?: Array<{
    kind: string;
    runtime?: string;
    provider?: string;
    threadId?: string;
    turnId?: string;
    itemId?: string;
    message?: string;
    tokensIn?: number;
    tokensOut?: number;
    durationMs?: number;
    payload?: unknown;
    timestamp?: number;
  }>;
  hitMaxTurns?: boolean;  // CLI agent hit --max-turns cap (may need continuation)
  session_id?: string;    // Runtime-specific resume token (Claude CLI session)
  session_runtime?: SessionRuntime; // Backend that minted session_id; must match before reuse
  last_turn_tokens_in?: number;  // Input tokens from the last turn (= actual context window usage)
  context_budget?: {
    mcp_profile?: string;
    mcp_requested_tools?: number;
    mcp_exposed_tools?: number;
    mcp_dropped_tools?: string[];
    estimated_mcp_schema_tokens?: number;
    estimated_mcp_saved_tokens?: number;
  };
  run_result?: Partial<DelegationRunResult>;
}

export type SessionRuntime = "claude_cli" | "native_api" | "codex_app_server";

// --- Actor Model ---

export type DelegationMode = "default" | "ralph";

export interface ActorMention {
  agent: string;
  task: string;
  instance?: string;         // Remote instance name (undefined = local)
  modelHint?: string;        // Orchestrator model hint e.g. "light", "sonnet", "opus"
  mode?: DelegationMode;     // Delegation mode: "ralph" enables autonomous iteration loop
  filePaths?: string[];
  verifyHints?: string[];
  contract?: DelegationContract;
}

// --- Delegation Contracts ---

export type DelegationOutputType = "code-change" | "analysis" | "spec" | "review" | "config" | "unknown";
export type DelegationPriority = "blocking" | "normal" | "background";

export interface DelegationContract {
  /** The raw natural language task (unchanged from ActorMention.task) */
  task: string;

  /** Target agent key */
  agent: string;

  /** What "done" looks like. Testable assertions when possible. */
  successCriteria: string[];

  /** Files the agent should read/modify (input scope) */
  inputFiles: string[];

  /** Files/paths the agent should produce or write to (output artifacts) */
  outputFiles: string[];

  /** Directories or files the agent must NOT modify */
  excludeFiles: string[];

  /** Design constraints and requirements beyond the task description */
  constraints: string[];

  /** Verification commands or checks to run (superset of verifyHints) */
  verification: string[];

  /** Expected output type */
  outputType: DelegationOutputType;

  /** Should the agent commit its changes? */
  shouldCommit: boolean;

  /** Task priority — affects timeout and retry behavior */
  priority: DelegationPriority;

  /** Keys of other agents whose results this task depends on */
  dependsOn: string[];

  /** Which extraction tier produced this contract */
  extractionMethod: "heuristic" | "template" | "llm" | "hybrid";
}

// --- Execution Traces ---

export interface ExecutionTrace {
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

// --- Delegation Runs ---

export type DelegationRunBrain = "codex" | "opus" | "sdk" | "anthropic";
export type DelegationRunStatus = "pending" | "running" | "completed" | "failed" | "killed" | "superseded";
export type DelegationRunOutcome = "success" | "partial" | "failure" | "blocked" | "superseded";

/** Category for intent-based model routing. */
export type ModelCategory = "frontier" | "deep" | "quick" | "visual";

/** A single Ralph loop iteration record. */
export interface RalphIteration {
  round: number;
  action: string;
  verification_result: "pass" | "fail" | "error";
  error?: string;
  next_action: string | null;
  duration_ms: number;
  tokens_in?: number;
  tokens_out?: number;
}

export interface DelegationRunFileTouch {
  path: string;
  action: string;
}

export type BlockedPathArea =
  | "attachment"
  | "media"
  | "provider"
  | "tool"
  | "runtime"
  | "storage"
  | "scheduler"
  | "queue"
  | "memory"
  | "approval";

export type BlockedPathNextAction =
  | "fix"
  | "proposal"
  | "configure"
  | "retry"
  | "ignore";

export interface BlockedPathReport {
  id: string;
  run_id: string | null;
  message_id: string | null;
  trace_id: string | null;
  channel: string | null;
  area: BlockedPathArea;
  failed_path: string;
  trigger: string;
  inspected: string[];
  available_artifacts: string[];
  missing_primitive: string;
  impact: string;
  next_action: BlockedPathNextAction;
  requires_approval: boolean;
  created_at: number;
}

export interface DelegationRunResult {
  summary: string;
  outcome: DelegationRunOutcome;
  artifacts: string[];
  files_touched: DelegationRunFileTouch[];
  verification: string[];
  blockers: string[];
  next_action: string | null;
  iterations?: RalphIteration[];  // Ralph loop iteration history
}

export interface DelegationRunUsage {
  tokens_in: number;
  tokens_out: number;
  tool_uses: string[];
  duration_ms: number;
  cost_usd: number;
}

export interface DelegationRunEnvironment {
  provider: string;
  model: string;
  effort?: EffortLevel;
  working_directory: string | null;
  cwd_override?: string | null;
  sandbox?: AgentConfig["sandbox"];
  agentic_mode?: AgentConfig["agentic_mode"];
  allowed_tools?: string[];
  disallowed_tools?: string[];
  mcp_tools?: string[];
  approved_commands?: string[];
}

export interface DelegationRun {
  run_id: string;
  parent_run_id: string | null;
  task_id: string | null;
  message_id: string | null;
  trace_id: string | null;
  task_description: string;
  agent: string;
  brain: DelegationRunBrain;
  status: DelegationRunStatus;
  mode: DelegationMode;              // "default" or "ralph"
  delegation_depth: number;           // 0 = top-level dispatch, >= 1 = sub-delegation
  result: DelegationRunResult | null;
  usage: DelegationRunUsage | null;
  environment: DelegationRunEnvironment | null;
  scratchpad_dir: string;
  created_at: number;
  completed_at: number | null;
  updated_at: number;
}

export interface DelegationRunScratchpadFile {
  path: string;
  author: string;
  timestamp: number;
  description: string;
}

export interface DelegationRunScratchpadManifest {
  run_id: string;
  parent_run_id: string | null;
  task_id: string | null;
  agent: string;
  task_description?: string;
  created_at: number;
  archived_at: number | null;
  files: DelegationRunScratchpadFile[];
}

// --- Graph Memory ---

export type MemoryType = "fact" | "preference" | "decision" | "identity" | "event" | "observation" | "goal" | "task" | "error" | "pattern" | "dependency" | "file_change";
export type EdgeType = "related_to" | "updates" | "contradicts" | "caused_by" | "part_of" | "resolved_by" | "depends_on" | "supersedes" | "relates_to";

export interface MemoryNode {
  id: number;
  type: MemoryType;
  content: string;
  source_conversation: string | null;
  source_channel: string | null;
  importance: number;
  access_count: number;
  mention_count: number;
  created_at: number;
  accessed_at: number;
  expires_at: number | null;
}

export interface MemoryEdge {
  id: number;
  source_id: number;
  target_id: number;
  type: EdgeType;
  created_at: number;
}

export interface ExtractedMemory {
  type: MemoryType;
  content: string;
  importance: number;
  updates?: string;
}

// --- iOS Channel ---

export interface iOSChannelDef {
  id: string;
  name: string;
  type: "agent" | "team" | "system";
  agentKey?: string;
  teamKey?: string;
}

export interface OutboundMessage {
  id: string;
  channel: string;
  agent: string | null;
  message: string;
  timestamp: number;
}

// --- SSE Event ---

export interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

// --- Thread Event ---

export interface ThreadEvent {
  type: string;
  thread_id: string;
  data: Record<string, unknown>;
  timestamp: number;
}
