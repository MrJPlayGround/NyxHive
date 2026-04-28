import type { TradingDB } from "../db.js";
import type { TradeExecution } from "../types.js";
import type { ExecutionAdapter, ExecutionRequest } from "./base.js";

export class PaperExecutionAdapter implements ExecutionAdapter {
  readonly name = "paper";
  readonly mode = "paper" as const;

  constructor(private readonly trading: TradingDB) {}

  async submit(request: ExecutionRequest): Promise<TradeExecution> {
    const { intent, suggestedSizeUsd } = request;
    const sizeUsd = suggestedSizeUsd ?? null;

    this.trading.openPosition({
      signal_id: intent.id,
      symbol: intent.symbol,
      market: intent.market,
      direction: intent.direction,
      entry_price: intent.entry_price,
      stop_loss: intent.stop_loss,
      take_profit: intent.take_profit,
      position_size: sizeUsd ?? undefined,
      risk_percent: intent.risk_percent,
      exchange: "paper",
      notes: `Paper execution from ${intent.id}`,
    });

    return this.trading.createTradeExecution({
      intent_id: intent.id,
      adapter: this.name,
      mode: this.mode,
      symbol: intent.symbol,
      market: intent.market,
      direction: intent.direction,
      status: "filled",
      requested_entry_price: intent.entry_price,
      filled_entry_price: intent.entry_price,
      requested_size_usd: sizeUsd,
      filled_size_usd: sizeUsd,
      stop_loss: intent.stop_loss,
      take_profit: intent.take_profit,
      notes: "Filled immediately by the paper adapter",
    });
  }
}
