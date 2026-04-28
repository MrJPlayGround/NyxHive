import type { RiskCheckResult, RiskState, TradeIntentInput } from "./types.js";

type LaneRiskState = RiskState & { _open_positions?: number };

export function evaluateTradeIntentRisk(
  state: LaneRiskState,
  intent: TradeIntentInput,
): RiskCheckResult {
  const reasons: string[] = [];

  if (state.daily_pnl <= state.daily_loss_limit) {
    reasons.push(`Daily loss limit hit ($${state.daily_pnl.toFixed(2)} / $${state.daily_loss_limit})`);
  }

  if (state.daily_trades >= state.max_daily_trades) {
    reasons.push(`Max daily trades reached (${state.daily_trades}/${state.max_daily_trades})`);
  }

  const openPositions = state._open_positions ?? 0;
  if (openPositions >= state.max_concurrent) {
    reasons.push(`Max concurrent positions (${openPositions}/${state.max_concurrent})`);
  }

  if (intent.risk_percent > state.risk_per_trade_percent) {
    reasons.push(
      `Risk percent ${intent.risk_percent} exceeds lane limit ${state.risk_per_trade_percent}`,
    );
  }

  let suggestedSize: number | undefined;
  if (state.account_balance) {
    const riskDistance = Math.abs(intent.entry_price - intent.stop_loss) / intent.entry_price;
    if (riskDistance > 0) {
      suggestedSize = Math.min(
        (intent.risk_percent / 100) * state.account_balance / riskDistance,
        state.max_position_size,
      );
    }
  }

  return {
    allowed: reasons.length === 0,
    reason: reasons.length > 0 ? reasons.join("; ") : undefined,
    suggested_size: suggestedSize,
  };
}
