// src/framework/stores.ts
// Assembles all stores into a single HiveStores bag.

import type { HiveStores } from "./types.js";
import type { QueueDB } from "../queue/db.js";
import type { MemoryStore } from "../memory/store.js";
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
import type { KnowledgeStore } from "../memory/knowledge.js";
import type { CrawlService } from "../crawl/index.js";
import type { AuditLog } from "../utils/audit.js";
import type { TradingDB } from "../trading/db.js";
import type { FeedbackStore } from "../memory/feedback.js";
import type { DelegationRunStore } from "../runs/store.js";
import type { ProceduralSkillDraftStore } from "../memory/procedural-skills.js";
import type { CompiledKnowledgeStore } from "../memory/compiled-knowledge.js";

export interface StoresInit {
  queue: QueueDB;
  memory: MemoryStore;
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
  trading?: TradingDB;
  feedback?: FeedbackStore;
  runs?: DelegationRunStore;
  proceduralSkills?: ProceduralSkillDraftStore;
  compiledKnowledge?: CompiledKnowledgeStore;
}

export function assembleStores(init: StoresInit): HiveStores {
  return {
    ...init,
    threads: undefined as unknown,
  };
}
