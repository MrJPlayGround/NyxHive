// src/trading/types.ts
// Trading desk type definitions

export interface WatchlistItem {
  id: string;
  symbol: string;
  market: "crypto" | "forex" | "stocks" | "futures";
  direction_bias: "long" | "short" | "neutral" | null;
  timeframe: string | null;
  notes: string | null;
  key_levels: string | null; // JSON: [{price, label}]
  priority: number;
  added_at: number;
  updated_at: number;
  removed_at: number | null;
}

export interface TradeSignal {
  id: string;
  symbol: string;
  market: string;
  direction: "long" | "short";
  signal_type: string;
  timeframe: string;
  confluences: string | null; // JSON array
  entry_zone_low: number | null;
  entry_zone_high: number | null;
  stop_loss: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  risk_reward: number | null;
  confidence: number | null;
  rationale: string;
  source: string | null;
  status: "active" | "triggered" | "expired" | "invalidated" | "passed";
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface Position {
  id: string;
  signal_id: string | null;
  symbol: string;
  market: string;
  direction: "long" | "short";
  entry_price: number;
  current_price: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  position_size: number | null;
  leverage: number;
  risk_amount: number | null;
  risk_percent: number | null;
  status: "open" | "closed" | "cancelled";
  pnl_usd: number | null;
  pnl_percent: number | null;
  entry_time: number;
  exit_time: number | null;
  exit_price: number | null;
  notes: string | null;
  grade: string | null;
  confluences: string | null;
  exchange: string | null;
  nyxlabs_trade_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface RiskState {
  daily_pnl: number;
  daily_trades: number;
  daily_loss_limit: number;
  weekly_pnl: number;
  max_position_size: number;
  max_concurrent: number;
  max_daily_trades: number;
  account_balance: number | null;
  risk_per_trade_percent: number;
  last_reset_date: string | null;
  updated_at: number;
}

export interface MarketNote {
  id: string;
  symbol: string | null;
  category: "level" | "bias" | "observation" | "news" | "session_recap";
  content: string;
  source: string | null;
  valid_until: number | null;
  created_at: number;
}

export interface DailyJournal {
  id: string;
  date: string;
  market_summary: string | null;
  trades_taken: number;
  total_pnl: number;
  lessons: string | null;
  emotional_state: string | null;
  plan_adherence: string | null;
  tomorrow_plan: string | null;
  created_at: number;
  updated_at: number;
}

export interface Todo {
  id: string;
  title: string;
  category: string;
  priority: number;
  due_at: number | null;
  reminder_at: number | null;
  completed_at: number | null;
  created_at: number;
}

export interface Alert {
  id: string;
  symbol: string;
  condition: string;
  message: string | null;
  triggered_at: number | null;
  created_at: number;
}

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  suggested_size?: number;
}

export interface TradingConfig {
  enabled?: boolean;
  timezone?: string;
  default_market?: string;
  risk_per_trade_percent?: number;
  daily_loss_limit?: number;
  max_position_size?: number;
  max_concurrent_positions?: number;
  max_daily_trades?: number;
}

export type TradingLaneMode =
  | "disabled"
  | "research"
  | "paper"
  | "live_armed"
  | "halted";

export type TradingExecutionMode = "paper" | "live";

export type TradeIntentStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executed"
  | "cancelled";

export interface TradingLaneState {
  id: string;
  mode: TradingLaneMode;
  active_adapter: string;
  agent_key: string | null;
  notes: string | null;
  last_mode_change_reason: string | null;
  last_mode_change_at: number | null;
  last_halt_reason: string | null;
  halted_at: number | null;
  last_approval_at: number | null;
  last_intent_at: number | null;
  updated_at: number;
}

export interface TradeIntentInput {
  symbol: string;
  market: "crypto" | "forex" | "stocks" | "futures";
  timeframe: string;
  direction: "long" | "short";
  thesis: string;
  invalidation: string;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  risk_percent: number;
  confidence: number;
  evidence: string[];
  execution_mode: TradingExecutionMode;
  entry_model?: string | null;
  source?: string | null;
  expires_at?: number | null;
}

export interface TradeIntent extends Omit<TradeIntentInput, "evidence"> {
  id: string;
  evidence: string;
  status: TradeIntentStatus;
  rejection_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface TradeExecution {
  id: string;
  intent_id: string;
  adapter: string;
  mode: TradingExecutionMode;
  symbol: string;
  market: string;
  direction: "long" | "short";
  status: "filled" | "rejected" | "cancelled";
  requested_entry_price: number;
  filled_entry_price: number | null;
  requested_size_usd: number | null;
  filled_size_usd: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}
