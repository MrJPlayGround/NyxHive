import type { InputRequest } from "../types.js";

export type HarnessRuntime = "codex_app_server";

export type HarnessRuntimeMode = "strict" | "supervised" | "read_only";

export type HarnessEventKind =
  | "authority.resolved"
  | "connection.started"
  | "connection.reused"
  | "session.started"
  | "session.resumed"
  | "account.updated"
  | "model.listed"
  | "turn.started"
  | "content.delta"
  | "tool.started"
  | "tool.completed"
  | "approval.requested"
  | "user_input.requested"
  | "usage.updated"
  | "turn.completed"
  | "turn.failed"
  | "session.closed";


export interface HarnessSupportContext {
  runtime: HarnessRuntime;
}

export type HarnessSupport =
  | { supported: true; priority?: number; reason?: string }
  | { supported: false; reason?: string };

export interface AgentHarness<DiscoveryInput = unknown, RunInput = unknown> {
  id: string;
  runtime: HarnessRuntime;
  provider: "openai";
  supports(ctx: HarnessSupportContext): HarnessSupport;
  discover(input: DiscoveryInput): Promise<HarnessDiscovery>;
  runTurn(input: RunInput): Promise<HarnessTurnResult>;
  closeAll?(): void | Promise<void>;
}

export interface HarnessRuntimeEvent {
  kind: HarnessEventKind;
  runtime: HarnessRuntime;
  provider: "openai";
  threadId?: string;
  turnId?: string;
  itemId?: string;
  message?: string;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  payload?: unknown;
  timestamp: number;
}

export interface HarnessDiscovery {
  runtime: HarnessRuntime;
  provider: "openai";
  authenticated: boolean;
  accountType: "apiKey" | "chatgpt" | "unknown";
  planType?: string;
  models: string[];
}

export interface HarnessTurnResult {
  runtime: HarnessRuntime;
  providerThreadId: string;
  providerTurnId?: string;
  response: string;
  tokensIn?: number;
  tokensOut?: number;
  toolsUsed?: string[];
  inputRequest?: InputRequest;
  events: HarnessRuntimeEvent[];
}
