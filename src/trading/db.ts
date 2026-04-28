// src/trading/db.ts
// Trading desk database — watchlist, signals, positions, risk, todos, alerts, journal

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import type {
  WatchlistItem, TradeSignal, Position, RiskState,
  MarketNote, DailyJournal, Todo, Alert,
  RiskCheckResult, TradingConfig, TradeExecution,
  TradeIntent, TradeIntentInput, TradeIntentStatus,
  TradingLaneMode, TradingLaneState,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watchlist (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,
  direction_bias TEXT,
  timeframe TEXT,
  notes TEXT,
  key_levels TEXT,
  priority INTEGER DEFAULT 0,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_symbol ON watchlist(symbol, market) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS trade_signals (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,
  direction TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  confluences TEXT,
  entry_zone_low REAL,
  entry_zone_high REAL,
  stop_loss REAL,
  tp1 REAL,
  tp2 REAL,
  tp3 REAL,
  risk_reward REAL,
  confidence INTEGER,
  rationale TEXT NOT NULL,
  source TEXT,
  status TEXT DEFAULT 'active',
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_status ON trade_signals(status, created_at);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  signal_id TEXT,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry_price REAL NOT NULL,
  current_price REAL,
  stop_loss REAL,
  take_profit REAL,
  position_size REAL,
  leverage REAL DEFAULT 1,
  risk_amount REAL,
  risk_percent REAL,
  status TEXT DEFAULT 'open',
  pnl_usd REAL,
  pnl_percent REAL,
  entry_time INTEGER NOT NULL,
  exit_time INTEGER,
  exit_price REAL,
  notes TEXT,
  grade TEXT,
  confluences TEXT,
  exchange TEXT,
  nyxlabs_trade_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status, entry_time);

CREATE TABLE IF NOT EXISTS risk_state (
  id TEXT PRIMARY KEY DEFAULT 'current',
  daily_pnl REAL DEFAULT 0,
  daily_trades INTEGER DEFAULT 0,
  daily_loss_limit REAL DEFAULT -500,
  weekly_pnl REAL DEFAULT 0,
  max_position_size REAL DEFAULT 5000,
  max_concurrent INTEGER DEFAULT 3,
  max_daily_trades INTEGER DEFAULT 6,
  account_balance REAL,
  risk_per_trade_percent REAL DEFAULT 1,
  last_reset_date TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS market_notes (
  id TEXT PRIMARY KEY,
  symbol TEXT,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  valid_until INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_notes_symbol ON market_notes(symbol, category);

CREATE TABLE IF NOT EXISTS daily_journal (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,
  market_summary TEXT,
  trades_taken INTEGER DEFAULT 0,
  total_pnl REAL DEFAULT 0,
  lessons TEXT,
  emotional_state TEXT,
  plan_adherence TEXT,
  tomorrow_plan TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  priority INTEGER DEFAULT 0,
  due_at INTEGER,
  reminder_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_pending ON todos(completed_at) WHERE completed_at IS NULL;

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  condition TEXT NOT NULL,
  message TEXT,
  triggered_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_pending ON alerts(triggered_at) WHERE triggered_at IS NULL;

CREATE TABLE IF NOT EXISTS lane_state (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'disabled',
  active_adapter TEXT NOT NULL DEFAULT 'paper',
  agent_key TEXT,
  notes TEXT,
  last_mode_change_reason TEXT,
  last_mode_change_at INTEGER,
  last_halt_reason TEXT,
  halted_at INTEGER,
  last_approval_at INTEGER,
  last_intent_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_intents (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  direction TEXT NOT NULL,
  thesis TEXT NOT NULL,
  invalidation TEXT NOT NULL,
  entry_price REAL NOT NULL,
  stop_loss REAL NOT NULL,
  take_profit REAL NOT NULL,
  risk_percent REAL NOT NULL,
  confidence INTEGER NOT NULL,
  evidence TEXT NOT NULL,
  execution_mode TEXT NOT NULL,
  entry_model TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  rejection_reason TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trade_intents_status ON trade_intents(status, created_at);

CREATE TABLE IF NOT EXISTS trade_executions (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  adapter TEXT NOT NULL,
  mode TEXT NOT NULL,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_entry_price REAL NOT NULL,
  filled_entry_price REAL,
  requested_size_usd REAL,
  filled_size_usd REAL,
  stop_loss REAL,
  take_profit REAL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(intent_id) REFERENCES trade_intents(id)
);
CREATE INDEX IF NOT EXISTS idx_trade_executions_intent ON trade_executions(intent_id, created_at);
`;

export class TradingDB {
  private db: Database;

  constructor(dataDir: string, instanceName: string, tradingConfig?: TradingConfig) {
    const dbPath = join(dataDir, `${instanceName}_trading.db`);
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);

    // Ensure risk_state singleton exists with config defaults
    const existing = this.db.query("SELECT id FROM risk_state WHERE id = 'current'").get();
    if (!existing) {
      const now = Date.now();
      this.db.run(
        `INSERT INTO risk_state (id, daily_loss_limit, max_position_size, max_concurrent, max_daily_trades, risk_per_trade_percent, updated_at)
         VALUES ('current', ?, ?, ?, ?, ?, ?)`,
        [
          -(tradingConfig?.daily_loss_limit ?? 500),
          tradingConfig?.max_position_size ?? 5000,
          tradingConfig?.max_concurrent_positions ?? 3,
          tradingConfig?.max_daily_trades ?? 6,
          tradingConfig?.risk_per_trade_percent ?? 1,
          now,
        ],
      );
    }

    const laneExisting = this.db.query("SELECT id FROM lane_state WHERE id = 'primary'").get();
    if (!laneExisting) {
      const now = Date.now();
      this.db.run(
        `INSERT INTO lane_state (id, mode, active_adapter, agent_key, updated_at)
         VALUES ('primary', 'disabled', 'paper', 'astra', ?)`,
        [now],
      );
    }

    logger.info(`[trading] DB opened at ${dbPath}`);
  }

  close(): void {
    this.db.close();
  }

  // --- Watchlist ---

  getWatchlist(market?: string): WatchlistItem[] {
    if (market) {
      return this.db.query("SELECT * FROM watchlist WHERE removed_at IS NULL AND market = ? ORDER BY priority DESC, added_at DESC").all(market) as WatchlistItem[];
    }
    return this.db.query("SELECT * FROM watchlist WHERE removed_at IS NULL ORDER BY priority DESC, added_at DESC").all() as WatchlistItem[];
  }

  addToWatchlist(item: { symbol: string; market: string; direction_bias?: string; timeframe?: string; notes?: string; key_levels?: string; priority?: number }): WatchlistItem {
    const now = Date.now();
    const id = randomUUID().slice(0, 8);
    const symbol = item.symbol.toUpperCase();

    // Re-activate if soft-deleted
    const existing = this.db.query("SELECT id FROM watchlist WHERE symbol = ? AND market = ? AND removed_at IS NOT NULL").get(symbol, item.market) as { id: string } | null;
    if (existing) {
      this.db.run(
        "UPDATE watchlist SET removed_at = NULL, direction_bias = ?, timeframe = ?, notes = ?, key_levels = ?, priority = ?, updated_at = ? WHERE id = ?",
        [item.direction_bias ?? null, item.timeframe ?? null, item.notes ?? null, item.key_levels ?? null, item.priority ?? 0, now, existing.id],
      );
      return this.db.query("SELECT * FROM watchlist WHERE id = ?").get(existing.id) as WatchlistItem;
    }

    this.db.run(
      "INSERT INTO watchlist (id, symbol, market, direction_bias, timeframe, notes, key_levels, priority, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, symbol, item.market, item.direction_bias ?? null, item.timeframe ?? null, item.notes ?? null, item.key_levels ?? null, item.priority ?? 0, now, now],
    );
    return this.db.query("SELECT * FROM watchlist WHERE id = ?").get(id) as WatchlistItem;
  }

  removeFromWatchlist(symbolOrId: string): boolean {
    const now = Date.now();
    const upper = symbolOrId.toUpperCase();
    const result = this.db.run(
      "UPDATE watchlist SET removed_at = ?, updated_at = ? WHERE (id = ? OR symbol = ?) AND removed_at IS NULL",
      [now, now, symbolOrId, upper],
    );
    return result.changes > 0;
  }

  // --- Signals ---

  getSignals(opts?: { status?: string; symbol?: string; since?: number; limit?: number }): TradeSignal[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts?.status) { conditions.push("status = ?"); params.push(opts.status); }
    if (opts?.symbol) { conditions.push("symbol = ?"); params.push(opts.symbol.toUpperCase()); }
    if (opts?.since) { conditions.push("created_at >= ?"); params.push(opts.since); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts?.limit ?? 50;
    params.push(limit);
    return this.db.query(`SELECT * FROM trade_signals ${where} ORDER BY created_at DESC LIMIT ?`).all(...params) as TradeSignal[];
  }

  createSignal(signal: Omit<TradeSignal, "id" | "status" | "created_at" | "updated_at">): TradeSignal {
    const now = Date.now();
    const id = `sig-${randomUUID().slice(0, 8)}`;
    this.db.run(
      `INSERT INTO trade_signals (id, symbol, market, direction, signal_type, timeframe, confluences, entry_zone_low, entry_zone_high, stop_loss, tp1, tp2, tp3, risk_reward, confidence, rationale, source, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      [id, signal.symbol.toUpperCase(), signal.market, signal.direction, signal.signal_type, signal.timeframe,
       signal.confluences, signal.entry_zone_low ?? null, signal.entry_zone_high ?? null, signal.stop_loss ?? null,
       signal.tp1 ?? null, signal.tp2 ?? null, signal.tp3 ?? null, signal.risk_reward ?? null,
       signal.confidence ?? null, signal.rationale, signal.source ?? null,
       signal.expires_at ?? (now + 48 * 60 * 60 * 1000), now, now],
    );
    return this.db.query("SELECT * FROM trade_signals WHERE id = ?").get(id) as TradeSignal;
  }

  updateSignalStatus(id: string, status: string, reason?: string): boolean {
    const now = Date.now();
    const result = this.db.run("UPDATE trade_signals SET status = ?, updated_at = ? WHERE id = ?", [status, now, id]);
    return result.changes > 0;
  }

  expireStaleSignals(): number {
    const now = Date.now();
    const result = this.db.run(
      "UPDATE trade_signals SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at <= ?",
      [now, now],
    );
    return result.changes;
  }

  getSignalById(id: string): TradeSignal | null {
    return (this.db.query("SELECT * FROM trade_signals WHERE id = ?").get(id) as TradeSignal) ?? null;
  }

  // --- Positions ---

  getPositions(status?: string): Position[] {
    if (status) {
      return this.db.query("SELECT * FROM positions WHERE status = ? ORDER BY entry_time DESC").all(status) as Position[];
    }
    return this.db.query("SELECT * FROM positions ORDER BY entry_time DESC LIMIT 50").all() as Position[];
  }

  openPosition(pos: {
    signal_id?: string; symbol: string; market: string; direction: string;
    entry_price: number; stop_loss?: number; take_profit?: number;
    position_size?: number; leverage?: number; risk_amount?: number;
    risk_percent?: number; exchange?: string; confluences?: string; notes?: string;
  }): Position {
    const now = Date.now();
    const id = `pos-${randomUUID().slice(0, 8)}`;
    this.db.run(
      `INSERT INTO positions (id, signal_id, symbol, market, direction, entry_price, stop_loss, take_profit, position_size, leverage, risk_amount, risk_percent, status, entry_time, exchange, confluences, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
      [id, pos.signal_id ?? null, pos.symbol.toUpperCase(), pos.market, pos.direction,
       pos.entry_price, pos.stop_loss ?? null, pos.take_profit ?? null,
       pos.position_size ?? null, pos.leverage ?? 1, pos.risk_amount ?? null,
       pos.risk_percent ?? null, now, pos.exchange ?? null,
       pos.confluences ?? null, pos.notes ?? null, now, now],
    );

    // Update risk state
    this.db.run("UPDATE risk_state SET daily_trades = daily_trades + 1, updated_at = ? WHERE id = 'current'", [now]);

    return this.db.query("SELECT * FROM positions WHERE id = ?").get(id) as Position;
  }

  closePosition(id: string, exitPrice: number, opts?: { grade?: string; notes?: string }): Position | null {
    const pos = this.db.query("SELECT * FROM positions WHERE id = ?").get(id) as Position | null;
    if (!pos || pos.status !== "open") return null;

    const now = Date.now();
    const dir = pos.direction === "long" ? 1 : -1;
    const pnlPercent = ((exitPrice - pos.entry_price) / pos.entry_price) * 100 * dir;
    const pnlUsd = pos.position_size ? (pos.position_size * (pnlPercent / 100)) : null;

    this.db.run(
      `UPDATE positions SET status = 'closed', exit_price = ?, exit_time = ?, pnl_usd = ?, pnl_percent = ?, grade = ?, notes = COALESCE(?, notes), updated_at = ? WHERE id = ?`,
      [exitPrice, now, pnlUsd, pnlPercent, opts?.grade ?? null, opts?.notes ?? null, now, id],
    );

    // Update risk state P&L
    if (pnlUsd !== null) {
      this.db.run("UPDATE risk_state SET daily_pnl = daily_pnl + ?, weekly_pnl = weekly_pnl + ?, updated_at = ? WHERE id = 'current'", [pnlUsd, pnlUsd, now]);
    }

    return this.db.query("SELECT * FROM positions WHERE id = ?").get(id) as Position;
  }

  updatePosition(id: string, updates: { stop_loss?: number; take_profit?: number; current_price?: number; notes?: string }): boolean {
    const sets: string[] = [];
    const params: (string | number)[] = [];

    if (updates.stop_loss !== undefined) { sets.push("stop_loss = ?"); params.push(updates.stop_loss); }
    if (updates.take_profit !== undefined) { sets.push("take_profit = ?"); params.push(updates.take_profit); }
    if (updates.current_price !== undefined) { sets.push("current_price = ?"); params.push(updates.current_price); }
    if (updates.notes !== undefined) { sets.push("notes = ?"); params.push(updates.notes); }
    if (sets.length === 0) return false;

    sets.push("updated_at = ?");
    params.push(Date.now());
    params.push(id);

    const result = this.db.run(`UPDATE positions SET ${sets.join(", ")} WHERE id = ? AND status = 'open'`, params);
    return result.changes > 0;
  }

  // --- Risk ---

  getRiskState(): RiskState {
    const state = this.db.query("SELECT * FROM risk_state WHERE id = 'current'").get() as RiskState & { id: string };
    const openCount = (this.db.query("SELECT COUNT(*) as c FROM positions WHERE status = 'open'").get() as { c: number }).c;
    return { ...state, daily_pnl: state.daily_pnl, max_concurrent: state.max_concurrent, _open_positions: openCount } as RiskState & { _open_positions: number };
  }

  updateRiskState(updates: Partial<Pick<RiskState, "daily_loss_limit" | "max_position_size" | "max_concurrent" | "max_daily_trades" | "risk_per_trade_percent" | "account_balance">>): void {
    const sets: string[] = [];
    const params: (string | number)[] = [];

    for (const [key, val] of Object.entries(updates)) {
      if (val !== undefined) { sets.push(`${key} = ?`); params.push(val as number); }
    }
    if (sets.length === 0) return;

    sets.push("updated_at = ?");
    params.push(Date.now());

    this.db.run(`UPDATE risk_state SET ${sets.join(", ")} WHERE id = 'current'`, params);
  }

  checkRisk(direction: string, entryPrice: number, stopLoss: number): RiskCheckResult {
    const state = this.getRiskState() as RiskState & { _open_positions: number };
    const reasons: string[] = [];

    // Daily loss limit
    if (state.daily_pnl <= state.daily_loss_limit) {
      reasons.push(`Daily loss limit hit ($${state.daily_pnl.toFixed(2)} / $${state.daily_loss_limit})`);
    }

    // Max daily trades
    if (state.daily_trades >= state.max_daily_trades) {
      reasons.push(`Max daily trades reached (${state.daily_trades}/${state.max_daily_trades})`);
    }

    // Max concurrent positions
    if (state._open_positions >= state.max_concurrent) {
      reasons.push(`Max concurrent positions (${state._open_positions}/${state.max_concurrent})`);
    }

    // Calculate suggested size
    let suggestedSize: number | undefined;
    if (state.account_balance && stopLoss && entryPrice) {
      const riskDistance = Math.abs(entryPrice - stopLoss) / entryPrice;
      if (riskDistance > 0) {
        suggestedSize = Math.min(
          (state.risk_per_trade_percent / 100) * state.account_balance / riskDistance,
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

  resetDailyRisk(): void {
    const today = new Date().toISOString().slice(0, 10);
    this.db.run(
      "UPDATE risk_state SET daily_pnl = 0, daily_trades = 0, last_reset_date = ?, updated_at = ? WHERE id = 'current'",
      [today, Date.now()],
    );
  }

  // --- Lane state ---

  getLaneState(): TradingLaneState {
    return this.db.query("SELECT * FROM lane_state WHERE id = 'primary'").get() as TradingLaneState;
  }

  setLaneMode(
    mode: TradingLaneMode,
    reason: string,
    opts?: {
      activeAdapter?: string;
      notes?: string | null;
      agentKey?: string | null;
      halted?: boolean;
      approvedAt?: number | null;
    },
  ): TradingLaneState {
    const now = Date.now();
    const haltedAt = opts?.halted ? now : null;
    this.db.run(
      `UPDATE lane_state
       SET mode = ?,
           active_adapter = COALESCE(?, active_adapter),
           agent_key = COALESCE(?, agent_key),
           notes = COALESCE(?, notes),
           last_mode_change_reason = ?,
           last_mode_change_at = ?,
           last_halt_reason = ?,
           halted_at = ?,
           last_approval_at = COALESCE(?, last_approval_at),
           updated_at = ?
       WHERE id = 'primary'`,
      [
        mode,
        opts?.activeAdapter ?? null,
        opts?.agentKey ?? null,
        opts?.notes ?? null,
        reason,
        now,
        opts?.halted ? reason : null,
        haltedAt,
        opts?.approvedAt ?? null,
        now,
      ],
    );
    return this.getLaneState();
  }

  noteLaneIntentActivity(at = Date.now()): void {
    this.db.run(
      "UPDATE lane_state SET last_intent_at = ?, updated_at = ? WHERE id = 'primary'",
      [at, at],
    );
  }

  // --- Trade intents ---

  createTradeIntent(
    intent: TradeIntentInput,
    opts?: { status?: TradeIntentStatus; rejectionReason?: string | null },
  ): TradeIntent {
    const now = Date.now();
    const id = `intent-${randomUUID().slice(0, 8)}`;
    this.db.run(
      `INSERT INTO trade_intents
       (id, symbol, market, timeframe, direction, thesis, invalidation, entry_price, stop_loss, take_profit, risk_percent, confidence, evidence, execution_mode, entry_model, source, status, rejection_reason, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        intent.symbol.toUpperCase(),
        intent.market,
        intent.timeframe,
        intent.direction,
        intent.thesis,
        intent.invalidation,
        intent.entry_price,
        intent.stop_loss,
        intent.take_profit,
        intent.risk_percent,
        intent.confidence,
        JSON.stringify(intent.evidence),
        intent.execution_mode,
        intent.entry_model ?? null,
        intent.source ?? null,
        opts?.status ?? "pending",
        opts?.rejectionReason ?? null,
        intent.expires_at ?? null,
        now,
        now,
      ],
    );
    this.noteLaneIntentActivity(now);
    return this.getTradeIntentById(id) as TradeIntent;
  }

  getTradeIntentById(id: string): TradeIntent | null {
    return (this.db.query("SELECT * FROM trade_intents WHERE id = ?").get(id) as TradeIntent) ?? null;
  }

  listTradeIntents(opts?: { status?: TradeIntentStatus; limit?: number }): TradeIntent[] {
    if (opts?.status) {
      return this.db.query(
        "SELECT * FROM trade_intents WHERE status = ? ORDER BY created_at DESC LIMIT ?",
      ).all(opts.status, opts.limit ?? 20) as TradeIntent[];
    }
    return this.db.query(
      "SELECT * FROM trade_intents ORDER BY created_at DESC LIMIT ?",
    ).all(opts?.limit ?? 20) as TradeIntent[];
  }

  updateTradeIntentStatus(
    id: string,
    status: TradeIntentStatus,
    rejectionReason?: string | null,
  ): TradeIntent | null {
    const now = Date.now();
    this.db.run(
      "UPDATE trade_intents SET status = ?, rejection_reason = ?, updated_at = ? WHERE id = ?",
      [status, rejectionReason ?? null, now, id],
    );
    return this.getTradeIntentById(id);
  }

  // --- Trade executions ---

  createTradeExecution(execution: Omit<TradeExecution, "id" | "created_at" | "updated_at">): TradeExecution {
    const now = Date.now();
    const id = `exec-${randomUUID().slice(0, 8)}`;
    this.db.run(
      `INSERT INTO trade_executions
       (id, intent_id, adapter, mode, symbol, market, direction, status, requested_entry_price, filled_entry_price, requested_size_usd, filled_size_usd, stop_loss, take_profit, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        execution.intent_id,
        execution.adapter,
        execution.mode,
        execution.symbol.toUpperCase(),
        execution.market,
        execution.direction,
        execution.status,
        execution.requested_entry_price,
        execution.filled_entry_price ?? null,
        execution.requested_size_usd ?? null,
        execution.filled_size_usd ?? null,
        execution.stop_loss ?? null,
        execution.take_profit ?? null,
        execution.notes ?? null,
        now,
        now,
      ],
    );
    return this.db.query("SELECT * FROM trade_executions WHERE id = ?").get(id) as TradeExecution;
  }

  listTradeExecutions(limit = 20): TradeExecution[] {
    return this.db.query(
      "SELECT * FROM trade_executions ORDER BY created_at DESC LIMIT ?",
    ).all(limit) as TradeExecution[];
  }

  // --- Market Notes ---

  addMarketNote(note: { symbol?: string; category: string; content: string; source?: string; valid_until?: number }): MarketNote {
    const now = Date.now();
    const id = randomUUID().slice(0, 8);
    this.db.run(
      "INSERT INTO market_notes (id, symbol, category, content, source, valid_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, note.symbol?.toUpperCase() ?? null, note.category, note.content, note.source ?? null, note.valid_until ?? null, now],
    );
    return this.db.query("SELECT * FROM market_notes WHERE id = ?").get(id) as MarketNote;
  }

  getMarketNotes(opts?: { symbol?: string; category?: string; limit?: number }): MarketNote[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts?.symbol) { conditions.push("symbol = ?"); params.push(opts.symbol.toUpperCase()); }
    if (opts?.category) { conditions.push("category = ?"); params.push(opts.category); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(opts?.limit ?? 20);
    return this.db.query(`SELECT * FROM market_notes ${where} ORDER BY created_at DESC LIMIT ?`).all(...params) as MarketNote[];
  }

  // --- Journal ---

  saveJournalEntry(entry: { date: string; market_summary?: string; trades_taken?: number; total_pnl?: number; lessons?: string; emotional_state?: string; plan_adherence?: string; tomorrow_plan?: string }): DailyJournal {
    const now = Date.now();
    const id = randomUUID().slice(0, 8);
    this.db.run(
      `INSERT INTO daily_journal (id, date, market_summary, trades_taken, total_pnl, lessons, emotional_state, plan_adherence, tomorrow_plan, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         market_summary = COALESCE(excluded.market_summary, market_summary),
         trades_taken = COALESCE(excluded.trades_taken, trades_taken),
         total_pnl = COALESCE(excluded.total_pnl, total_pnl),
         lessons = COALESCE(excluded.lessons, lessons),
         emotional_state = COALESCE(excluded.emotional_state, emotional_state),
         plan_adherence = COALESCE(excluded.plan_adherence, plan_adherence),
         tomorrow_plan = COALESCE(excluded.tomorrow_plan, tomorrow_plan),
         updated_at = excluded.updated_at`,
      [id, entry.date, entry.market_summary ?? null, entry.trades_taken ?? 0, entry.total_pnl ?? 0,
       entry.lessons ?? null, entry.emotional_state ?? null, entry.plan_adherence ?? null,
       entry.tomorrow_plan ?? null, now, now],
    );
    return this.db.query("SELECT * FROM daily_journal WHERE date = ?").get(entry.date) as DailyJournal;
  }

  getJournalEntries(opts?: { from?: string; to?: string; limit?: number }): DailyJournal[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts?.from) { conditions.push("date >= ?"); params.push(opts.from); }
    if (opts?.to) { conditions.push("date <= ?"); params.push(opts.to); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(opts?.limit ?? 30);
    return this.db.query(`SELECT * FROM daily_journal ${where} ORDER BY date DESC LIMIT ?`).all(...params) as DailyJournal[];
  }

  // --- Todos ---

  addTodo(todo: { title: string; category?: string; priority?: number; due_at?: number; reminder_at?: number }): Todo {
    const now = Date.now();
    const id = randomUUID().slice(0, 8);
    this.db.run(
      "INSERT INTO todos (id, title, category, priority, due_at, reminder_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, todo.title, todo.category ?? "general", todo.priority ?? 0, todo.due_at ?? null, todo.reminder_at ?? null, now],
    );
    return this.db.query("SELECT * FROM todos WHERE id = ?").get(id) as Todo;
  }

  getTodos(includeCompleted?: boolean): Todo[] {
    if (includeCompleted) {
      return this.db.query("SELECT * FROM todos ORDER BY completed_at IS NULL DESC, priority DESC, created_at DESC LIMIT 50").all() as Todo[];
    }
    return this.db.query("SELECT * FROM todos WHERE completed_at IS NULL ORDER BY priority DESC, due_at ASC, created_at DESC").all() as Todo[];
  }

  completeTodo(id: string): boolean {
    const result = this.db.run("UPDATE todos SET completed_at = ? WHERE id = ? AND completed_at IS NULL", [Date.now(), id]);
    return result.changes > 0;
  }

  deleteTodo(id: string): boolean {
    const result = this.db.run("DELETE FROM todos WHERE id = ?", [id]);
    return result.changes > 0;
  }

  // --- Alerts ---

  createAlert(alert: { symbol: string; condition: string; message?: string }): Alert {
    const now = Date.now();
    const id = randomUUID().slice(0, 8);
    this.db.run(
      "INSERT INTO alerts (id, symbol, condition, message, created_at) VALUES (?, ?, ?, ?, ?)",
      [id, alert.symbol.toUpperCase(), alert.condition, alert.message ?? null, now],
    );
    return this.db.query("SELECT * FROM alerts WHERE id = ?").get(id) as Alert;
  }

  getAlerts(pendingOnly = true): Alert[] {
    if (pendingOnly) {
      return this.db.query("SELECT * FROM alerts WHERE triggered_at IS NULL ORDER BY created_at DESC").all() as Alert[];
    }
    return this.db.query("SELECT * FROM alerts ORDER BY created_at DESC LIMIT 50").all() as Alert[];
  }

  triggerAlert(id: string): boolean {
    const result = this.db.run("UPDATE alerts SET triggered_at = ? WHERE id = ? AND triggered_at IS NULL", [Date.now(), id]);
    return result.changes > 0;
  }

  deleteAlert(id: string): boolean {
    const result = this.db.run("DELETE FROM alerts WHERE id = ?", [id]);
    return result.changes > 0;
  }

  // --- Stats (for context injection) ---

  getTradingContext(): string {
    const watchlist = this.getWatchlist();
    const openPositions = this.getPositions("open");
    const risk = this.getRiskState() as RiskState & { _open_positions: number };
    const activeSignals = this.getSignals({ status: "active", limit: 5 });
    const lane = this.getLaneState();
    const recentIntents = this.listTradeIntents({ limit: 5 });
    const pendingAlerts = this.getAlerts(true);
    const pendingTodos = this.getTodos(false);

    const lines: string[] = [];

    lines.push("## Trading Lane");
    lines.push(`- Mode: ${lane.mode}`);
    lines.push(`- Adapter: ${lane.active_adapter}`);
    if (lane.last_mode_change_reason) {
      lines.push(`- Last mode change: ${lane.last_mode_change_reason}`);
    }

    // Watchlist
    if (watchlist.length > 0) {
      lines.push("## Watchlist");
      for (const w of watchlist) {
        const bias = w.direction_bias ? ` (${w.direction_bias})` : "";
        const tf = w.timeframe ? ` ${w.timeframe}` : "";
        const levels = w.key_levels ? ` | levels: ${w.key_levels}` : "";
        lines.push(`- ${w.symbol}${bias}${tf}${levels}`);
      }
    }

    // Open positions
    if (openPositions.length > 0) {
      lines.push("\n## Open Positions");
      for (const p of openPositions) {
        const pnl = p.pnl_usd !== null ? ` | P&L: $${p.pnl_usd.toFixed(2)}` : "";
        const sl = p.stop_loss ? ` | SL: ${p.stop_loss}` : "";
        const tp = p.take_profit ? ` | TP: ${p.take_profit}` : "";
        lines.push(`- ${p.symbol} ${p.direction} @ ${p.entry_price}${sl}${tp}${pnl}`);
      }
    }

    // Risk state
    lines.push("\n## Risk Status");
    lines.push(`- Daily P&L: $${risk.daily_pnl.toFixed(2)} (limit: $${risk.daily_loss_limit})`);
    lines.push(`- Daily trades: ${risk.daily_trades}/${risk.max_daily_trades}`);
    lines.push(`- Open positions: ${risk._open_positions}/${risk.max_concurrent}`);
    if (risk.account_balance) lines.push(`- Account balance: $${risk.account_balance.toFixed(2)}`);

    // Active signals
    if (activeSignals.length > 0) {
      lines.push("\n## Active Signals");
      for (const s of activeSignals) {
        lines.push(`- [${s.id}] ${s.symbol} ${s.direction} (${s.confidence}/10) — ${s.signal_type}`);
      }
    }

    if (recentIntents.length > 0) {
      lines.push("\n## Recent Trade Intents");
      for (const intent of recentIntents) {
        lines.push(`- [${intent.id}] ${intent.symbol} ${intent.direction} ${intent.status} (${intent.confidence}/10)`);
      }
    }

    // Alerts
    if (pendingAlerts.length > 0) {
      lines.push("\n## Pending Alerts");
      for (const a of pendingAlerts) {
        lines.push(`- ${a.symbol}: ${a.condition}${a.message ? ` — ${a.message}` : ""}`);
      }
    }

    // Todos
    if (pendingTodos.length > 0) {
      lines.push("\n## Pending Todos");
      for (const t of pendingTodos) {
        const due = t.due_at ? ` (due: ${new Date(t.due_at).toLocaleDateString()})` : "";
        const overdue = t.due_at && t.due_at < Date.now() ? " [OVERDUE]" : "";
        lines.push(`- ${t.title}${due}${overdue}`);
      }
    }

    return lines.join("\n");
  }

  getTradingLaneSnapshot(): {
    lane: TradingLaneState;
    risk: RiskState & { _open_positions: number };
    open_positions: Position[];
    intents: TradeIntent[];
    executions: TradeExecution[];
  } {
    return {
      lane: this.getLaneState(),
      risk: this.getRiskState() as RiskState & { _open_positions: number },
      open_positions: this.getPositions("open"),
      intents: this.listTradeIntents({ limit: 10 }),
      executions: this.listTradeExecutions(10),
    };
  }
}
