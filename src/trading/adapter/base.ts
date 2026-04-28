import type { TradeExecution, TradeIntent } from "../types.js";

export interface ExecutionRequest {
  intent: TradeIntent;
  suggestedSizeUsd?: number;
}

export interface ExecutionAdapter {
  readonly name: string;
  readonly mode: "paper" | "live";
  submit(request: ExecutionRequest): Promise<TradeExecution>;
}
