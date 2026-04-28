import { z } from "zod";

// --- Chat ---
export const chatSendRequest = z.object({
  message: z.string(),
  agent: z.string().optional(),
  threadId: z.string().nullable().optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  // Legacy image-only field (kept for iOS backward compat)
  images: z.array(z.object({
    type: z.string(),
    data: z.string().max(10 * 1024 * 1024),
  })).max(5).optional(),
  // New general file attachment field
  files: z.array(z.object({
    name: z.string(),
    type: z.string(),
    data: z.string().max(10 * 1024 * 1024),
  })).max(5).optional(),
});

export const chatSendResponse = z.object({
  messageId: z.string(),
  threadId: z.string(),
  runId: z.string(),
  status: z.enum(["started", "in_flight", "ok", "queued"]).default("started"),
  queued: z.boolean().optional(),
});

export const chatAbortRequest = z.object({
  threadId: z.string().optional(),
  runId: z.string().optional(),
});

export const chatHistoryRequest = z.object({
  threadId: z.string(),
  limit: z.number().optional().default(50),
  before: z.number().optional(),
});

export const chatModelRequest = z.object({
  threadId: z.string().nullable().optional(),
  agent: z.string().optional(),
});

export const chatModelSetRequest = chatModelRequest.extend({
  model: z.string().nullable().optional(),
});

export const chatModelResponse = z.object({
  agent: z.string(),
  model: z.string(),
  provider: z.string(),
  cliFallback: z.string().optional(),
  overridden: z.boolean(),
  warning: z.string().nullable().optional(),
});

export const chatRequestsListResponse = z.object({
  requests: z.array(z.object({
    requestId: z.string(),
    kind: z.enum(["proposal_approval", "user_input"]),
    title: z.string(),
    description: z.string().optional(),
    createdAt: z.number(),
    actions: z.array(z.object({
      id: z.string(),
      label: z.string(),
      variant: z.enum(["primary", "secondary", "danger"]).optional(),
    })),
    proposal: z.object({
      proposalId: z.string(),
      title: z.string(),
      description: z.string().optional(),
      category: z.string().optional(),
      priority: z.string().optional(),
      effort: z.string().optional(),
      filesAffected: z.array(z.string()).optional(),
    }).optional(),
  })),
});

export const chatRequestResolveRequest = z.object({
  requestId: z.string(),
  action: z.enum(["approve", "reject", "respond"]),
  response: z.string().optional(),
});

export const threadChangesRequest = z.object({
  id: z.string(),
});

export const threadChangesResponse = z.object({
  changes: z.array(z.object({
    id: z.string(),
    threadId: z.string(),
    messageId: z.string().optional(),
    filePath: z.string(),
    operation: z.enum(["write", "edit", "create", "delete"]),
    linesAdded: z.number(),
    linesRemoved: z.number(),
    diffSummary: z.string().optional(),
    timestamp: z.number(),
  })),
});

// --- BTW / Steer ---
export const chatBtwRequest = z.object({
  agent: z.string(),
  question: z.string().min(1).max(2000),
  threadId: z.string().optional(),
});

export const chatBtwResponse = z.object({
  answer: z.string(),
  model: z.string().optional(),
  cached: z.boolean().optional(),
});

export const chatSteerRequest = z.object({
  agent: z.string(),
  message: z.string().min(1).max(5000),
  threadId: z.string().optional(),
  priority: z.enum(["normal", "interrupt"]).default("normal"),
});

export const chatSteerResponse = z.object({
  steer_id: z.string(),
  status: z.string(),
});

// --- Agents ---
export const agentsListResponse = z.object({
  agents: z.array(z.object({
    id: z.string(),
    name: z.string(),
    role: z.string(),
    enabled: z.boolean(),
    status: z.enum(["idle", "running", "error"]),
    currentTask: z.string().nullable(),
    totalInvocations: z.number(),
    totalTokensIn: z.number(),
    totalTokensOut: z.number(),
    estimatedCostCents: z.number(),
    lastInvokedAt: z.number().nullable(),
  })),
});

// --- Threads ---
export const threadsListRequest = z.object({
  projectId: z.string().optional(),
  agent: z.string().optional(),
  status: z.string().optional(),
  limit: z.number().optional().default(50),
  offset: z.number().optional().default(0),
});

export const threadGetRequest = z.object({
  id: z.string(),
});

export const threadsSearchRequest = z.object({
  query: z.string(),
  limit: z.number().optional().default(20),
});

export const threadSetCategoryRequest = z.object({
  id: z.string(),
  category: z.string().nullable(),
});

// --- Proposals ---
export const proposalsListRequest = z.object({
  status: z.string().optional(),
  category: z.string().optional(),
  limit: z.number().optional().default(50),
});

export const proposalActionRequest = z.object({
  proposalId: z.string(),
  notes: z.string().optional(),
});

export const proposalMergeRequest = z.object({
  proposalId: z.string(),
  mergedBy: z.string().optional(),
});

// --- Tasks ---
export const tasksListResponse = z.object({
  tasks: z.array(z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    status: z.enum(["backlog", "in_progress", "review", "done"]),
    assignee: z.string(),
    assigneeType: z.string(),
    position: z.number(),
  })),
});

export const taskUpdateRequest = z.object({
  id: z.string(),
  status: z.enum(["backlog", "in_progress", "review", "done"]).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  assignee: z.string().optional(),
  position: z.number().optional(),
});

// --- Logs ---
export const logsSubscribeRequest = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  agent: z.string().optional(),
  module: z.string().optional(),
});

// --- Config ---
export const configGetResponse = z.object({
  content: z.string(),
  path: z.string(),
});

export const configPatchRequest = z.object({
  content: z.string(),
});

export const configValidateRequest = z.object({
  content: z.string(),
});

export const configValidateResponse = z.object({
  valid: z.boolean(),
  errors: z.array(z.object({
    path: z.string(),
    message: z.string(),
  })),
});

// --- Memory ---
export const memorySearchRequest = z.object({
  query: z.string(),
  limit: z.number().optional().default(10),
});

// --- Knowledge ---
export const knowledgeSearchRequest = z.object({
  query: z.string(),
  limit: z.number().optional().default(10),
});

export const knowledgeDigestsListRequest = z.object({
  query: z.string().optional(),
  limit: z.number().optional().default(50),
  stale: z.boolean().optional(),
});

export const knowledgeDigestCompileRequest = z.object({
  sourcePath: z.string().min(1),
});

export const knowledgeDigestStaleRequest = z.object({
  id: z.number(),
  stale: z.boolean().optional(),
});

// --- Procedural Skills ---
export const proceduralSkillsListRequest = z.object({
  status: z.enum(["draft", "published", "rejected"]).optional(),
  agent: z.string().optional(),
  query: z.string().optional(),
  audit: z.boolean().optional(),
  sort: z.enum(["newest", "most_used", "best_outcomes", "needs_audit"]).optional(),
  limit: z.number().optional(),
});

export const proceduralSkillsPublishRequest = z.object({
  id: z.number(),
  skill_name: z.string().optional(),
});

export const proceduralSkillsRejectRequest = z.object({
  id: z.number(),
  reason: z.string(),
});

export const proceduralSkillsRejectAuditRequest = z.object({
  ids: z.array(z.number()),
  reason: z.string().optional(),
});

// --- Scheduler ---
export const schedulerListResponse = z.object({
  jobs: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    schedule: z.string(),
    agent: z.string(),
    category: z.string(),
    enabled: z.boolean(),
    lastRun: z.number().nullable(),
    nextRun: z.number().nullable(),
    lastStatus: z.string().nullable(),
    runCount: z.number(),
    consecutiveFailures: z.number(),
  })),
});

// --- Channels ---
export const channelsListResponse = z.object({
  channels: z.array(z.object({
    id: z.string(),
    type: z.string(),
    status: z.enum(["connected", "disconnected", "error"]),
    messageCount: z.number(),
    lastActivity: z.number().nullable(),
  })),
});

// --- Traces ---
export const tracesListRequest = z.object({
  status: z.enum(["running", "completed", "failed"]).optional(),
  limit: z.number().optional().default(20),
});

export const tracesGetRequest = z.object({
  id: z.string(),
});

// --- Usage ---
export const usageRoutingRequest = z.object({
  hours: z.number().optional().default(168),
});

// --- Audit ---
export const auditListRequest = z.object({
  limit: z.number().optional(),
  event: z.string().optional(),
  eventPrefix: z.string().optional(),
  channel: z.string().optional(),
  agent: z.string().optional(),
  since: z.number().optional(),
  host: z.string().optional(),
  method: z.string().optional(),
  status: z.number().optional(),
  outcome: z.string().optional(),
  pathContains: z.string().optional(),
  minDurationMs: z.number().optional(),
});

export const auditSummaryRequest = z.object({
  limit: z.number().optional(),
  since: z.number().optional(),
});

// --- Scheduler (mutations) ---
export const schedulerUpdateRequest = z.object({
  id: z.string(),
  enabled: z.boolean().optional(),
  cron_expression: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  agent: z.string().optional(),
  prompt: z.string().optional(),
});

export const schedulerRunRequest = z.object({
  id: z.string(),
});

// --- Devices (mutations) ---
export const deviceActionRequest = z.object({
  deviceId: z.string(),
});

// --- Devices ---
export const devicesListResponse = z.object({
  devices: z.array(z.object({
    id: z.string(),
    name: z.string(),
    approved: z.boolean(),
    lastSeen: z.number().nullable(),
    createdAt: z.number(),
  })),
});

// --- Connect (handshake) ---
export const connectChallengePayload = z.object({
  nonce: z.string(),
  protocolVersion: z.number(),
});

export const connectAuthenticatePayload = z.object({
  deviceId: z.string(),
  deviceName: z.string(),
  signature: z.string(),
  protocolVersion: z.number(),
});

export const connectAuthenticatedPayload = z.object({
  sessionToken: z.string(),
  scopes: z.array(z.string()),
  serverVersion: z.string(),
  bufferedMessages: z.number().optional(),
});

// --- System ---
export const systemHealthResponse = z.object({
  uptime: z.number(),
  queueDepth: z.number(),
  activeConnections: z.number(),
  agents: z.number(),
  memoryUsage: z.number(),
  status: z.enum(["ok", "degraded", "error"]).optional(),
  instanceName: z.string().optional(),
  leadAgent: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  errors: z.array(z.string()).optional(),
  providers: z.record(z.string(), z.string()).optional(),
  queue: z.unknown().optional(),
  connections: z.unknown().optional(),
  checks: z.array(z.unknown()).optional(),
});

export const systemCapabilitiesResponse = z.object({
  version: z.literal(1),
  serverVersion: z.string(),
  instanceName: z.string().optional(),
  leadAgent: z.string().nullable().optional(),
  auth: z.object({
    mode: z.enum(["session", "api_key", "insecure_read_only", "blocked"]),
  }),
  methods: z.array(z.string()),
  events: z.array(z.string()),
  features: z.object({
    chat: z.boolean(),
    cockpit: z.boolean(),
    traces: z.boolean(),
    proposals: z.boolean(),
    proceduralSkills: z.boolean(),
    knowledge: z.boolean(),
    memory: z.boolean(),
    scheduler: z.boolean(),
    devices: z.boolean(),
    logs: z.boolean(),
    audit: z.boolean(),
    runtimeLifecycle: z.boolean(),
    activeRunReplay: z.boolean(),
  }),
});

// Method registry — maps method names to request/response schemas
// Every registered WS method MUST have a request schema here for payload validation.
export const methodSchemas = {
  "chat.send": { request: chatSendRequest, response: chatSendResponse },
  "chat.abort": { request: chatAbortRequest, response: z.object({}) },
  "chat.reset": { request: z.object({}), response: z.object({}) },
  "chat.status": { request: z.object({}), response: z.unknown() },
  "chat.history": { request: chatHistoryRequest, response: z.unknown() },
  "chat.model.get": { request: chatModelRequest, response: chatModelResponse },
  "chat.model.set": { request: chatModelSetRequest, response: chatModelResponse },
  "chat.requests.list": { request: z.object({}), response: chatRequestsListResponse },
  "chat.request.resolve": { request: chatRequestResolveRequest, response: z.unknown() },
  "chat.btw": { request: chatBtwRequest, response: chatBtwResponse },
  "chat.steer": { request: chatSteerRequest, response: chatSteerResponse },
  "chat.usage": { request: z.object({}), response: z.unknown() },
  "chat.context": { request: z.object({ threadId: z.string().optional() }), response: z.unknown() },
  "chat.forget": { request: z.object({ threadId: z.string().optional(), exchanges: z.number().optional() }), response: z.unknown() },
  "chat.trim": { request: z.object({ threadId: z.string().optional(), keep: z.number().optional() }), response: z.unknown() },
  "chat.setup.status": { request: z.object({}), response: z.unknown() },
  "agents.list": { request: z.object({}), response: agentsListResponse },
  "threads.list": { request: threadsListRequest, response: z.unknown() },
  "threads.search": { request: threadsSearchRequest, response: z.unknown() },
  "threads.get": { request: threadGetRequest, response: z.unknown() },
  "threads.changes": { request: threadChangesRequest, response: threadChangesResponse },
  "threads.rename": { request: z.object({ id: z.string(), title: z.string() }), response: z.unknown() },
  "threads.delete": { request: z.object({ id: z.string() }), response: z.unknown() },
  "threads.archive": { request: z.object({ id: z.string() }), response: z.unknown() },
  "threads.setCategory": { request: threadSetCategoryRequest, response: z.unknown() },
  "proposals.list": { request: proposalsListRequest, response: z.unknown() },
  "proposals.approve": { request: proposalActionRequest, response: z.unknown() },
  "proposals.reject": { request: proposalActionRequest, response: z.unknown() },
  "proposals.startReview": { request: proposalActionRequest.extend({ model: z.string().optional() }), response: z.unknown() },
  "proposals.createPr": { request: proposalActionRequest, response: z.unknown() },
  "proposals.merge": { request: proposalMergeRequest, response: z.unknown() },
  "proposals.delete": { request: proposalActionRequest, response: z.unknown() },
  "proposals.execute": { request: proposalActionRequest, response: z.unknown() },
  "proposals.executeAll": { request: z.object({ bundlePr: z.boolean().optional() }), response: z.unknown() },
  "proposals.retry": { request: proposalActionRequest, response: z.unknown() },
  "proposals.requeue": { request: proposalActionRequest, response: z.unknown() },
  "proposals.deleteTerminal": { request: z.object({}), response: z.unknown() },
  "tasks.list": { request: z.object({}), response: tasksListResponse },
  "tasks.update": { request: taskUpdateRequest, response: z.unknown() },
  "logs.subscribe": { request: logsSubscribeRequest, response: z.object({}) },
  "logs.unsubscribe": { request: z.object({}), response: z.object({}) },
  "logs.recent": { request: z.object({ limit: z.number().optional() }), response: z.unknown() },
  "config.get": { request: z.object({}), response: configGetResponse },
  "config.patch": { request: configPatchRequest, response: z.object({}) },
  "config.validate": { request: configValidateRequest, response: configValidateResponse },
  "memory.search": { request: memorySearchRequest, response: z.unknown() },
  "knowledge.search": { request: knowledgeSearchRequest, response: z.unknown() },
  "knowledge.stats": { request: z.object({}), response: z.unknown() },
  "knowledge.recent": { request: z.object({ limit: z.number().optional() }), response: z.unknown() },
  "knowledge.digests.list": { request: knowledgeDigestsListRequest, response: z.unknown() },
  "knowledge.digests.compile": { request: knowledgeDigestCompileRequest, response: z.unknown() },
  "knowledge.digests.stale": { request: knowledgeDigestStaleRequest, response: z.unknown() },
  "knowledge.digests.audit": { request: z.object({}), response: z.unknown() },
  "proceduralSkills.list": { request: proceduralSkillsListRequest, response: z.unknown() },
  "proceduralSkills.publish": { request: proceduralSkillsPublishRequest, response: z.unknown() },
  "proceduralSkills.reject": { request: proceduralSkillsRejectRequest, response: z.unknown() },
  "proceduralSkills.rejectAudit": { request: proceduralSkillsRejectAuditRequest, response: z.unknown() },
  "scheduler.list": { request: z.object({}), response: schedulerListResponse },
  "scheduler.update": { request: schedulerUpdateRequest, response: z.unknown() },
  "scheduler.run": { request: schedulerRunRequest, response: z.unknown() },
  "channels.list": { request: z.object({}), response: channelsListResponse },
  "traces.list": { request: tracesListRequest, response: z.unknown() },
  "traces.get": { request: tracesGetRequest, response: z.unknown() },
  "usage.routing": { request: usageRoutingRequest, response: z.unknown() },
  "audit.list": { request: auditListRequest, response: z.unknown() },
  "audit.summary": { request: auditSummaryRequest, response: z.unknown() },
  "scheduler.core": { request: z.object({}), response: z.unknown() },
  "devices.list": { request: z.object({}), response: devicesListResponse },
  "devices.approve": { request: deviceActionRequest, response: z.unknown() },
  "devices.revoke": { request: deviceActionRequest, response: z.unknown() },
  "system.health": { request: z.object({}), response: systemHealthResponse },
  "system.capabilities": { request: z.object({}), response: systemCapabilitiesResponse },
  "system.doctor": { request: z.object({}), response: z.unknown() },
  "activity.recent": { request: z.object({}), response: z.unknown() },
  "connect.authenticate": { request: connectAuthenticatePayload, response: connectAuthenticatedPayload },
} as const;

export type MethodName = keyof typeof methodSchemas;
