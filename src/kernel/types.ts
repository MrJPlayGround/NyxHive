import type { AgentConfig, NyxHiveConfig, SSEEvent } from "../types.js";
import type { FileAttachment } from "../providers/types.js";
import type { KernelEvent } from "./events.js";

export interface KernelRequest {
  message: string;
  agentKey: string;
  agent: AgentConfig;
  channel?: string;
  sender?: string;
  senderId?: string;
  threadId?: string;
  conversationId?: string;
  mode?: string;
  attachments?: FileAttachment[];
  metadata?: Record<string, unknown>;
}

export interface KernelContextAssembly {
  systemPrompt?: string;
  memoryContext?: string;
  knowledgeContext?: string;
  files?: string[];
  metadata?: Record<string, unknown>;
}

export interface KernelRuntimeDeps {
  config?: NyxHiveConfig;
  baseDir: string;
}

export interface AgentKernelRuntime {
  stream(request: KernelRequest): AsyncIterable<KernelEvent>;
}

export type KernelEventMapper = (event: KernelEvent) => SSEEvent;
