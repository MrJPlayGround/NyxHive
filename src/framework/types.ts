// src/framework/types.ts
// Public extension interfaces for the NyxHive framework API.

import type { Hono } from "hono";
import type { NyxHiveConfig, MessageData } from "../types.js";
import type { QueueDB } from "../queue/db.js";
import type { QueueProcessor } from "../queue/processor.js";
import type { MemoryStore } from "../memory/store.js";
import type { KnowledgeStore } from "../memory/knowledge.js";
import type { TraceStore } from "../memory/traces.js";
import type { GraphMemory } from "../memory/graph.js";
import type { PatternStore } from "../memory/patterns.js";
import type { OutcomeStore } from "../memory/outcomes.js";
import type { RoutingStore } from "../memory/routing.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { CredentialVault } from "../security/vault.js";
import type { ProposalStore } from "../proposals/store.js";
import type { TaskStore } from "../tasks/store.js";
import type { PairingStore } from "../pairing/pairing.js";
import type { FeedbackStore } from "../memory/feedback.js";
import type { CrawlService } from "../crawl/index.js";
import type { AuditLog } from "../utils/audit.js";
import type { ProviderRouter } from "../providers/router.js";
import type { Provider } from "../providers/types.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import type { Channel } from "../channels/types.js";
import type { SlackSurfaceRegistration } from "../channels/slack-types.js";
import type { Scheduler } from "../scheduler/index.js";
import type { DelegationRunStore } from "../runs/store.js";
import type { ProceduralSkillDraftStore } from "../memory/procedural-skills.js";
import type { CompiledKnowledgeStore } from "../memory/compiled-knowledge.js";

// --- Engine API Version ---

export const ENGINE_API_VERSION = 1;

// --- Core Interfaces ---

export interface HiveOptions {
  config: string | NyxHiveConfig;
  mainBrain?: string;

  channels?: ChannelFactory[];
  commands?: CommandDefinition[];
  routes?: RouteRegistrar[];
  tasks?: TaskDefinition[];
  tools?: AgentToolRegistration[];
  providers?: ProviderFactory[];
  embedders?: EmbeddingFactory[];
  middleware?: MessageMiddleware[];
  slackSurfaces?: SlackSurfaceRegistration[];

  onReady?: (hive: Hive) => Promise<void>;
  onShutdown?: (hive: Hive) => Promise<void>;
}

export interface Hive {
  start(): Promise<void>;
  stop(): Promise<void>;

  readonly processor: PublicProcessorAPI;
  readonly config: NyxHiveConfig;
  readonly server: Hono;
  readonly scheduler: Scheduler | undefined;
  readonly stores: HiveStores;
}

// --- Stores ---

export interface HiveStores {
  queue: QueueDB;
  memory: MemoryStore;
  threads: unknown; // ThreadDB is created inside server — typed later
  traces: TraceStore;
  graph: GraphMemory;
  patterns: PatternStore;
  outcomes: OutcomeStore;
  routing: RoutingStore;
  registry: AgentRegistry;
  vault: CredentialVault;
  proposals: ProposalStore;
  tasks: TaskStore;
  pairing: PairingStore;

  knowledge?: KnowledgeStore;
  crawl?: CrawlService;
  audit?: AuditLog;
  feedback?: FeedbackStore;
  trading?: import("../trading/db.js").TradingDB;
  runs?: DelegationRunStore;
  proceduralSkills?: ProceduralSkillDraftStore;
  compiledKnowledge?: CompiledKnowledgeStore;
}

// --- Channels ---

export interface ChannelFactory {
  name: string;
  create(deps: ChannelDeps): Promise<Channel>;
}

export interface ChannelDeps {
  config: NyxHiveConfig;
  queue: QueueDB;
  processor: QueueProcessor;
  stores: HiveStores;
  slackSurfaces?: SlackSurfaceRegistration[];
}

// --- Commands ---

export interface CommandDefinition {
  name: string;
  pattern: RegExp | string;
  description: string;
  handler: (ctx: CommandContext) => Promise<CommandResult>;
}

export interface CommandContext {
  message: MessageData;
  args: string[];
  processor: PublicProcessorAPI;
  config: NyxHiveConfig;
  stores: HiveStores;
}

export type CommandResult =
  | { handled: true; response?: string }
  | { handled: false };

// --- Routes ---

export type RouteRegistrar = (app: Hono, deps: RouteDeps) => void;

export interface RouteDeps {
  processor: PublicProcessorAPI;
  config: NyxHiveConfig;
  stores: HiveStores;
}

// --- Tasks ---

export interface TaskDefinition {
  name: string;
  schedule: string;
  handler: (ctx: TaskContext) => Promise<void>;
  enabled?: boolean | ((config: NyxHiveConfig) => boolean);
}

export interface TaskContext {
  processor: PublicProcessorAPI;
  config: NyxHiveConfig;
  stores: HiveStores;
  router: ProviderRouter;
}

// --- Tools ---

export interface AgentToolRegistration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: unknown, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  config: NyxHiveConfig;
  stores: HiveStores;
}

// --- Providers ---

export interface ProviderFactory {
  name: string;
  create(config: NyxHiveConfig): Provider;
}

export interface EmbeddingFactory {
  name: string;
  create(config: NyxHiveConfig): EmbeddingProvider;
}

// --- Middleware ---

export interface MessageMiddleware {
  name: string;
  phase: "before" | "after";
  handler: (
    message: MessageData,
    ctx: MiddlewareContext
  ) => Promise<MessageData | undefined>;
}

export interface MiddlewareContext {
  config: NyxHiveConfig;
  stores: HiveStores;
  processor: PublicProcessorAPI;
}

// --- Processor Public API ---

export interface PublicProcessorAPI {
  enqueue(message: EnqueueOptions): Promise<string>;
  onEvent(handler: (event: string, payload: unknown) => void): () => void;
  onResponse(handler: (response: ResponseData) => void): () => void;
  getStatus(): ProcessorStatus;
  getActiveAgents(): AgentStatus[];
}

export interface EnqueueOptions {
  content: string;
  sender?: string;
  threadId?: string;
  channel?: string;
  metadata?: Record<string, unknown>;
}

export interface ResponseData {
  messageId: string;
  response: string;
  threadId?: string;
  agent?: string;
}

export interface ProcessorStatus {
  running: boolean;
  queueLength: number;
  activeProcesses: number;
}

export interface AgentStatus {
  name: string;
  busy: boolean;
  currentTask?: string;
}
