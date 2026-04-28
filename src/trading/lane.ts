import type { TradingDB } from "./db.js";
import { parseTradeIntentInput } from "./intent.js";
import { evaluateTradeIntentRisk } from "./risk-engine.js";
import type { TradeExecution, TradeIntent, TradeIntentInput, TradingLaneMode } from "./types.js";
import type { ExecutionAdapter } from "./adapter/base.js";

const ALLOWED_TRANSITIONS: Record<TradingLaneMode, TradingLaneMode[]> = {
  disabled: ["research", "paper", "halted"],
  research: ["disabled", "paper", "halted"],
  paper: ["disabled", "research", "halted"],
  live_armed: ["disabled", "paper", "halted"],
  halted: ["disabled", "research"],
};

export interface TradingLaneResult {
  status: "executed" | "rejected";
  reason?: string;
  intent?: TradeIntent;
  execution?: TradeExecution;
}

export class TradingLane {
  constructor(
    private readonly trading: TradingDB,
    private readonly adapters: { paper: ExecutionAdapter },
  ) {}

  setMode(mode: TradingLaneMode, reason: string): {
    ok: boolean;
    reason?: string;
  } {
    const current = this.trading.getLaneState();
    if (current.mode === mode) {
      return { ok: true };
    }

    if (mode === "live_armed") {
      return {
        ok: false,
        reason: "Live trading is not implemented in this slice",
      };
    }

    const allowed = ALLOWED_TRANSITIONS[current.mode] ?? [];
    if (!allowed.includes(mode)) {
      return {
        ok: false,
        reason: `Cannot move trading lane from ${current.mode} to ${mode}`,
      };
    }

    this.trading.setLaneMode(mode, reason, {
      activeAdapter: "paper",
      agentKey: current.agent_key ?? "astra",
      halted: mode === "halted",
    });
    return { ok: true };
  }

  getSnapshot() {
    return this.trading.getTradingLaneSnapshot();
  }

  async submitIntent(input: TradeIntentInput): Promise<TradingLaneResult> {
    const lane = this.trading.getLaneState();
    if (lane.mode === "disabled" || lane.mode === "research" || lane.mode === "halted") {
      return {
        status: "rejected",
        reason: `Lane mode ${lane.mode} does not allow execution intents`,
      };
    }

    const parsed = parseTradeIntentInput(input);
    if (!parsed.ok) {
      return {
        status: "rejected",
        reason: parsed.errors.join("; "),
      };
    }

    if (parsed.value.execution_mode !== "paper") {
      const rejectedIntent = this.trading.createTradeIntent(parsed.value, {
        status: "rejected",
        rejectionReason: "Only paper execution is implemented in this slice",
      });
      return {
        status: "rejected",
        reason: "Only paper execution is implemented in this slice",
        intent: rejectedIntent,
      };
    }

    const risk = evaluateTradeIntentRisk(
      this.trading.getRiskState() as ReturnType<TradingDB["getRiskState"]>,
      parsed.value,
    );

    if (!risk.allowed) {
      const rejectedIntent = this.trading.createTradeIntent(parsed.value, {
        status: "rejected",
        rejectionReason: risk.reason ?? "Risk rejected",
      });
      return {
        status: "rejected",
        reason: risk.reason ?? "Risk rejected",
        intent: rejectedIntent,
      };
    }

    const intent = this.trading.createTradeIntent(parsed.value, {
      status: "approved",
    });

    try {
      const execution = await this.adapters.paper.submit({
        intent,
        suggestedSizeUsd: risk.suggested_size,
      });
      const executedIntent = this.trading.updateTradeIntentStatus(
        intent.id,
        "executed",
      ) ?? intent;
      return {
        status: "executed",
        intent: executedIntent,
        execution,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rejectedIntent = this.trading.updateTradeIntentStatus(
        intent.id,
        "rejected",
        message,
      ) ?? intent;
      this.trading.setLaneMode("halted", `Paper execution failed: ${message}`, {
        activeAdapter: "paper",
        halted: true,
      });
      return {
        status: "rejected",
        reason: message,
        intent: rejectedIntent,
      };
    }
  }
}
