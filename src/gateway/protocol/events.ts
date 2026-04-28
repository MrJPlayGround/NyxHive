import { z } from "zod";

export const agentProgressEvent = z.object({
  agent: z.string(),
  messageId: z.string(),
  text: z.string(),
  done: z.boolean().default(false),
});

export const agentStatusEvent = z.object({
  agent: z.string(),
  status: z.enum(["idle", "running", "error"]),
  task: z.string().nullable(),
});

export const threadUpdateEvent = z.object({
  threadId: z.string(),
  status: z.string(),
  agent: z.string().optional(),
});

export const proposalUpdateEvent = z.object({
  proposalId: z.string(),
  status: z.string(),
  prUrl: z.string().nullable().optional(),
  verdict: z.string().optional(),
});

export const logEntryEvent = z.object({
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
  module: z.string().optional(),
  agent: z.string().optional(),
  timestamp: z.number(),
});

export const devicePendingEvent = z.object({
  deviceId: z.string(),
  deviceName: z.string(),
});

export const deviceApprovedEvent = z.object({
  deviceId: z.string(),
  deviceName: z.string(),
});

export const deviceRevokedEvent = z.object({
  deviceId: z.string(),
});

export const activityEventSchema = z.object({
  id: z.string(),
  type: z.enum(["completion", "proposal", "delegation", "watchdog", "system", "error"]),
  agent: z.string(),
  action: z.string(),
  subject: z.string(),
  detail: z.string().optional(),
  timestamp: z.number(),
});

// --- Chat streaming lifecycle ---

export const chatResponseEvent = z.object({
  text: z.string(),
  done: z.boolean(),
  agent: z.string().optional(),
  channel: z.string().optional(),
  threadId: z.string().optional(),
  tokensIn: z.number().optional(),
  tokensOut: z.number().optional(),
  cost: z.number().optional(),
  durationMs: z.number().optional(),
});

const assistantOutputDirectiveSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("replyTo"), messageId: z.string(), text: z.string().optional() }),
  z.object({ type: z.literal("attachments"), items: z.array(z.object({
    name: z.string(),
    url: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().optional(),
  })) }),
  z.object({ type: z.literal("embed"), title: z.string().optional(), body: z.string().optional(), url: z.string().optional() }),
  z.object({ type: z.literal("voiceHint"), text: z.string(), voice: z.string().optional() }),
  z.object({ type: z.literal("ephemeral"), text: z.string() }),
  z.object({ type: z.literal("actionCard"), title: z.string(), body: z.string().optional(), actions: z.array(z.object({
    id: z.string(),
    label: z.string(),
    variant: z.enum(["primary", "secondary", "danger"]).optional(),
  })).optional() }),
]);

export const assistantOutputSchema = z.object({
  directives: z.array(assistantOutputDirectiveSchema),
});

export const chatHeartbeatEvent = z.object({
  agent: z.string(),
  channel: z.string(),
  threadId: z.string(),
  runId: z.string().optional(),
  turn: z.number().optional(),
  startedAt: z.number().optional(),
  timestamp: z.number().optional(),
});

export const runHeartbeatEvent = chatHeartbeatEvent.extend({
  runId: z.string(),
});

export const chatExecutionEvent = z.object({
  id: z.string(),
  kind: z.enum(["command", "file_change", "mcp_tool", "web_search", "status"]),
  phase: z.enum(["started", "updated", "completed", "failed"]),
  title: z.string(),
  subtitle: z.string().optional(),
  details: z.string().optional(),
  command: z.string().optional(),
  outputPreview: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  changes: z.array(z.object({
    path: z.string(),
    kind: z.enum(["add", "delete", "update"]),
  })).optional(),
  turn: z.number().optional(),
  message_id: z.string().optional(),
  threadId: z.string().optional(),
  timestamp: z.number().optional(),
});

export const chatActiveEvent = z.object({
  agent: z.string(),
  startedAt: z.number(),
  threadId: z.string(),
  runId: z.string().optional(),
});

export const contextMetricsEvent = z.object({
  utilizationPct: z.number().optional(),
  estimated: z.boolean().optional(),
  channel: z.string().optional(),
  threadId: z.string().optional(),
});

// --- Typed gateway runtime events ---

const runtimeChangeSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  messageId: z.string().optional(),
  filePath: z.string(),
  operation: z.enum(["write", "edit", "create", "delete"]),
  linesAdded: z.number(),
  linesRemoved: z.number(),
  diffSummary: z.string().optional(),
  timestamp: z.number(),
});

const runtimeItemSchema = z.object({
  id: z.string(),
  type: z.enum(["command", "file_change", "mcp_tool", "web_search", "status", "agent_message"]),
  status: z.enum(["started", "updated", "completed", "failed"]),
  title: z.string(),
  subtitle: z.string().optional(),
  details: z.string().optional(),
  command: z.string().optional(),
  outputPreview: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  changes: z.array(z.object({
    path: z.string(),
    kind: z.enum(["add", "delete", "update"]),
  })).optional(),
  timestamp: z.number(),
});

const runtimeRequestActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  variant: z.enum(["primary", "secondary", "danger"]).optional(),
});

const runtimeProposalRequestSchema = z.object({
  proposalId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  priority: z.string().optional(),
  effort: z.string().optional(),
  filesAffected: z.array(z.string()).optional(),
});

export const runtimeThreadStartedEvent = z.object({
  threadId: z.string(),
  agent: z.string(),
  startedAt: z.number(),
  created: z.boolean().optional(),
});

export const runtimeTurnStartedEvent = z.object({
  threadId: z.string(),
  turn: z.number(),
  runId: z.string().optional(),
  agent: z.string(),
  startedAt: z.number(),
});

export const runtimeTurnCompletedEvent = z.object({
  threadId: z.string(),
  turn: z.number(),
  runId: z.string().optional(),
  agent: z.string().optional(),
  status: z.enum(["completed", "failed", "aborted"]),
  finishedAt: z.number(),
  text: z.string().optional(),
  tokensIn: z.number().optional(),
  tokensOut: z.number().optional(),
  cost: z.number().optional(),
  durationMs: z.number().optional(),
  output: assistantOutputSchema.or(assistantOutputDirectiveSchema).optional(),
});

export const runtimeItemEvent = z.object({
  threadId: z.string(),
  turn: z.number().optional(),
  item: runtimeItemSchema,
});

export const runtimeContextUpdatedEvent = z.object({
  threadId: z.string(),
  utilizationPct: z.number().optional(),
  estimated: z.boolean().optional(),
});

export const runtimeDiffUpdatedEvent = z.object({
  threadId: z.string(),
  changes: z.array(runtimeChangeSchema),
});

export const runtimeRequestOpenedEvent = z.object({
  requestId: z.string(),
  kind: z.enum(["proposal_approval", "user_input"]),
  title: z.string(),
  description: z.string().optional(),
  threadId: z.string().optional(),
  createdAt: z.number(),
  actions: z.array(runtimeRequestActionSchema),
  proposal: runtimeProposalRequestSchema.optional(),
});

export const runtimeRequestResolvedEvent = z.object({
  requestId: z.string(),
  kind: z.enum(["proposal_approval", "user_input"]),
  resolution: z.string(),
  resolvedAt: z.number(),
});

export const runtimeUserInputRequestedEvent = z.object({
  requestId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  placeholder: z.string().optional(),
  threadId: z.string().optional(),
  createdAt: z.number(),
});

export const runtimeUserInputResolvedEvent = z.object({
  requestId: z.string(),
  resolvedAt: z.number(),
  response: z.string().optional(),
});

// --- Streaming deltas (emitted via processor event bus) ---

export const responseDeltaEvent = z.object({
  message_id: z.string().optional(),
  text_delta: z.string().optional(),
  text_so_far: z.string().optional(),
  agent: z.string().optional(),
  channel: z.string().optional(),
  sender_id: z.string().optional(),
});

export const responseCompleteEvent = z.object({
  message_id: z.string().optional(),
  agent: z.string().optional(),
  channel: z.string().optional(),
  sender_id: z.string().optional(),
  trace_id: z.string().optional(),
  tokens_in: z.number().optional(),
  tokens_out: z.number().optional(),
  cost: z.number().optional(),
  duration_ms: z.number().optional(),
  text_so_far: z.string().optional(),
});

// --- Scheduler scan lifecycle (emitted via processor event bus) ---

export const scanStartedEvent = z.object({
  task_id: z.string(),
  task_name: z.string(),
  agent: z.string().optional(),
});

export const scanCompletedEvent = z.object({
  task_id: z.string(),
  task_name: z.string(),
  agent: z.string().optional(),
  status: z.string().optional(),
  result_preview: z.string().optional(),
  error: z.string().optional(),
});

// --- Event catalog ---
// Every WS event emitted by the backend MUST be declared here.
// Protocol alignment tests enforce this at CI time.

export const eventSchemas = {
  // Agent lifecycle
  "agent:progress": agentProgressEvent,
  "agent:status": agentStatusEvent,

  // Chat streaming
  "chat:response": chatResponseEvent,
  "chat:heartbeat": chatHeartbeatEvent,
  "run.heartbeat": runHeartbeatEvent,
  "chat:execution": chatExecutionEvent,
  "chat:active": chatActiveEvent,
  "context:metrics": contextMetricsEvent,
  "response:delta": responseDeltaEvent,
  "response:complete": responseCompleteEvent,
  "thread.started": runtimeThreadStartedEvent,
  "turn.started": runtimeTurnStartedEvent,
  "turn.completed": runtimeTurnCompletedEvent,
  "item.started": runtimeItemEvent,
  "item.updated": runtimeItemEvent,
  "item.completed": runtimeItemEvent,
  "context.updated": runtimeContextUpdatedEvent,
  "diff.updated": runtimeDiffUpdatedEvent,
  "request.opened": runtimeRequestOpenedEvent,
  "request.resolved": runtimeRequestResolvedEvent,
  "user-input.requested": runtimeUserInputRequestedEvent,
  "user-input.resolved": runtimeUserInputResolvedEvent,

  // Thread lifecycle
  "thread:update": threadUpdateEvent,

  // Proposals
  "proposal:update": proposalUpdateEvent,

  // Scheduler scans
  "scan:started": scanStartedEvent,
  "scan:completed": scanCompletedEvent,

  // Logs
  "log:entry": logEntryEvent,

  // Device pairing
  "device:pending": devicePendingEvent,
  "device:approved": deviceApprovedEvent,
  "device:revoked": deviceRevokedEvent,

  // Auth handshake
  "connect.challenge": z.object({ nonce: z.string(), protocolVersion: z.number() }),

  // Activity feed
  "activity:event": activityEventSchema,
} as const;

export type EventName = keyof typeof eventSchemas;
