// src/mcp/trading-tools.ts
// MCP tool registrations for the trading desk

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TradingDB } from "../trading/db.js";
import { PaperExecutionAdapter } from "../trading/adapter/paper.js";
import { TradingLane } from "../trading/lane.js";

export function registerTradingTools(server: McpServer, trading: TradingDB): void {
  const lane = new TradingLane(trading, {
    paper: new PaperExecutionAdapter(trading),
  });

  // --- Watchlist ---

  server.registerTool(
    "get_trading_lane_state",
    {
      description: "Inspect the bounded trading lane: mode, risk posture, recent intents, executions, and open positions.",
      inputSchema: {},
    },
    async () => {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(lane.getSnapshot()) }],
      };
    },
  );

  server.registerTool(
    "set_trading_lane_mode",
    {
      description: "Change the trading lane mode. Use this only for deliberate private control-plane changes.",
      inputSchema: {
        mode: z.enum(["disabled", "research", "paper", "live_armed", "halted"]).describe("Target lane mode"),
        reason: z.string().describe("Short reason for the mode change"),
      },
    },
    async ({ mode, reason }) => {
      const result = lane.setMode(mode, reason);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.reason ?? "Lane mode change rejected" }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(trading.getLaneState()) }],
      };
    },
  );

  server.registerTool(
    "create_trade_intent",
    {
      description: "Create a structured trade intent. In paper mode the lane validates risk and executes it through the paper adapter.",
      inputSchema: {
        symbol: z.string().describe("Trading pair/symbol"),
        market: z.enum(["crypto", "forex", "stocks", "futures"]).describe("Market type"),
        timeframe: z.string().describe("Analysis timeframe"),
        direction: z.enum(["long", "short"]).describe("Trade direction"),
        thesis: z.string().describe("Why the setup exists"),
        invalidation: z.string().describe("What invalidates the trade"),
        entry_price: z.number().describe("Planned entry price"),
        stop_loss: z.number().describe("Planned stop loss"),
        take_profit: z.number().describe("Primary take profit"),
        risk_percent: z.number().positive().describe("Account risk percentage"),
        confidence: z.number().int().min(1).max(10).describe("Confidence score"),
        evidence: z.array(z.string()).min(1).describe("Structured evidence list"),
        execution_mode: z.enum(["paper", "live"]).describe("Execution target"),
        entry_model: z.string().optional().describe("Entry model label"),
        source: z.string().optional().describe("Signal source"),
        expires_at: z.number().optional().describe("Intent expiry timestamp"),
      },
    },
    async (input) => {
      const result = await lane.submitIntent({
        ...input,
        entry_model: input.entry_model ?? null,
        source: input.source ?? null,
        expires_at: input.expires_at ?? null,
      });
      if (result.status === "rejected") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "get_trade_intents",
    {
      description: "List recent structured trade intents and their lane status.",
      inputSchema: {
        status: z.enum(["pending", "approved", "rejected", "executed", "cancelled"]).optional().describe("Optional status filter"),
        limit: z.number().int().positive().optional().describe("Max results"),
      },
    },
    async ({ status, limit }) => {
      const intents = trading.listTradeIntents({ status, limit });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(intents) }],
      };
    },
  );

  server.registerTool(
    "get_trade_executions",
    {
      description: "List recent paper or live execution records for the trading lane.",
      inputSchema: {
        limit: z.number().int().positive().optional().describe("Max results"),
      },
    },
    async ({ limit }) => {
      const executions = trading.listTradeExecutions(limit);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(executions) }],
      };
    },
  );

  server.registerTool(
    "get_watchlist",
    {
      description: "Get User's current trading watchlist. Returns all actively watched symbols with bias, timeframe, key levels, and notes.",
      inputSchema: {
        market: z.enum(["crypto", "forex", "stocks", "futures"]).optional().describe("Filter by market type"),
      },
    },
    async ({ market }) => {
      const items = trading.getWatchlist(market);
      return { content: [{ type: "text" as const, text: JSON.stringify(items) }] };
    },
  );

  server.registerTool(
    "add_to_watchlist",
    {
      description: "Add a symbol to User's trading watchlist",
      inputSchema: {
        symbol: z.string().describe("Trading pair/symbol (e.g., BTCUSDT, EURUSD)"),
        market: z.enum(["crypto", "forex", "stocks", "futures"]).describe("Market type"),
        direction_bias: z.enum(["long", "short", "neutral"]).optional().describe("Directional bias"),
        timeframe: z.string().optional().describe("Primary analysis timeframe (e.g., 4h, 1d)"),
        notes: z.string().optional().describe("Analysis notes or context"),
        key_levels: z.string().optional().describe("JSON array of key price levels: [{price, label}]"),
        priority: z.number().int().min(0).max(2).optional().describe("0=normal, 1=high, 2=critical"),
      },
    },
    async (input) => {
      const item = trading.addToWatchlist(input);
      return { content: [{ type: "text" as const, text: JSON.stringify(item) }] };
    },
  );

  server.registerTool(
    "remove_from_watchlist",
    {
      description: "Remove a symbol from User's watchlist (by symbol name or ID)",
      inputSchema: {
        symbol_or_id: z.string().describe("Symbol name (e.g., BTCUSDT) or watchlist item ID"),
      },
    },
    async ({ symbol_or_id }) => {
      const removed = trading.removeFromWatchlist(symbol_or_id);
      return { content: [{ type: "text" as const, text: JSON.stringify({ removed }) }] };
    },
  );

  // --- Signals ---

  server.registerTool(
    "get_signals",
    {
      description: "List trade signals. By default shows active signals. Use to check existing signals before creating new ones (avoid duplicates).",
      inputSchema: {
        status: z.enum(["active", "triggered", "expired", "invalidated", "passed"]).optional().describe("Filter by signal status (default: all)"),
        symbol: z.string().optional().describe("Filter by symbol"),
        limit: z.number().int().positive().optional().describe("Max results (default: 50)"),
      },
    },
    async ({ status, symbol, limit }) => {
      const signals = trading.getSignals({ status, symbol, limit });
      return { content: [{ type: "text" as const, text: JSON.stringify(signals) }] };
    },
  );

  server.registerTool(
    "create_signal",
    {
      description: "Create a new trade signal. Only create signals with RR >= 1:2 and confidence >= 6. Check existing signals first to avoid duplicates.",
      inputSchema: {
        symbol: z.string().describe("Trading pair (e.g., BTCUSDT)"),
        market: z.enum(["crypto", "forex", "stocks", "futures"]).describe("Market type"),
        direction: z.enum(["long", "short"]).describe("Trade direction"),
        signal_type: z.string().describe("Setup type: ob_retest, fvg_fill, liquidity_sweep, bos, choch, wyckoff_spring, wyckoff_upthrust, etc."),
        timeframe: z.string().describe("Timeframe (e.g., 4h, 1d)"),
        confluences: z.string().optional().describe("JSON array of confluence tags: Order Block, Fair Value Gap, Liquidity Sweep, Break of Structure, Change of Character, Displacement, SFP, Accumulation, Distribution, Spring, Upthrust, Support/Resistance, Fibonacci, Trend"),
        entry_zone_low: z.number().optional().describe("Lower bound of entry zone"),
        entry_zone_high: z.number().optional().describe("Upper bound of entry zone"),
        stop_loss: z.number().optional().describe("Stop loss price"),
        tp1: z.number().optional().describe("Take profit target 1"),
        tp2: z.number().optional().describe("Take profit target 2"),
        tp3: z.number().optional().describe("Take profit target 3"),
        risk_reward: z.number().optional().describe("Risk:Reward ratio (e.g., 2.5 for 1:2.5)"),
        confidence: z.number().int().min(1).max(10).optional().describe("Confidence score 1-10"),
        rationale: z.string().describe("Why this signal was generated — key reasoning"),
        source: z.string().optional().describe("Which scan/task produced this signal"),
        expires_at: z.number().optional().describe("Signal expiry timestamp (default: 48h from now)"),
      },
    },
    async (input) => {
      const signal = trading.createSignal({
        ...input,
        confluences: input.confluences ?? null,
        entry_zone_low: input.entry_zone_low ?? null,
        entry_zone_high: input.entry_zone_high ?? null,
        stop_loss: input.stop_loss ?? null,
        tp1: input.tp1 ?? null,
        tp2: input.tp2 ?? null,
        tp3: input.tp3 ?? null,
        risk_reward: input.risk_reward ?? null,
        confidence: input.confidence ?? null,
        source: input.source ?? null,
        expires_at: input.expires_at ?? null,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(signal) }] };
    },
  );

  server.registerTool(
    "update_signal_status",
    {
      description: "Update a signal's status (triggered when User takes the trade, invalidated when setup breaks, expired when time runs out, passed when dismissed)",
      inputSchema: {
        id: z.string().describe("Signal ID (e.g., sig-abc12345)"),
        status: z.enum(["triggered", "invalidated", "expired", "passed"]).describe("New status"),
      },
    },
    async ({ id, status }) => {
      const updated = trading.updateSignalStatus(id, status);
      return { content: [{ type: "text" as const, text: JSON.stringify({ updated }) }] };
    },
  );

  // --- Positions ---

  server.registerTool(
    "get_positions",
    {
      description: "List trading positions. Defaults to showing all recent positions.",
      inputSchema: {
        status: z.enum(["open", "closed", "cancelled"]).optional().describe("Filter by status"),
      },
    },
    async ({ status }) => {
      const positions = trading.getPositions(status);
      return { content: [{ type: "text" as const, text: JSON.stringify(positions) }] };
    },
  );

  server.registerTool(
    "open_position",
    {
      description: "Log a new trading position. Automatically updates risk state. Use check_risk first to validate.",
      inputSchema: {
        symbol: z.string().describe("Trading pair"),
        market: z.enum(["crypto", "forex", "stocks", "futures"]).describe("Market type"),
        direction: z.enum(["long", "short"]).describe("Trade direction"),
        entry_price: z.number().describe("Entry price"),
        stop_loss: z.number().optional().describe("Stop loss price"),
        take_profit: z.number().optional().describe("Take profit price"),
        position_size: z.number().optional().describe("Position size in USD"),
        leverage: z.number().optional().describe("Leverage (default: 1)"),
        risk_amount: z.number().optional().describe("USD amount at risk"),
        risk_percent: z.number().optional().describe("Account % at risk"),
        exchange: z.string().optional().describe("Exchange name (bybit, hyperliquid, etc.)"),
        confluences: z.string().optional().describe("JSON array of confluences"),
        notes: z.string().optional().describe("Trade notes"),
        signal_id: z.string().optional().describe("Originating signal ID"),
      },
    },
    async (input) => {
      const position = trading.openPosition(input);
      return { content: [{ type: "text" as const, text: JSON.stringify(position) }] };
    },
  );

  server.registerTool(
    "close_position",
    {
      description: "Close an open position with exit price. Calculates P&L automatically and updates risk state.",
      inputSchema: {
        id: z.string().describe("Position ID (e.g., pos-abc12345)"),
        exit_price: z.number().describe("Exit/close price"),
        grade: z.string().optional().describe("Trade grade (A+, A, B, C, D)"),
        notes: z.string().optional().describe("Post-trade notes"),
      },
    },
    async ({ id, exit_price, grade, notes }) => {
      const position = trading.closePosition(id, exit_price, { grade, notes });
      if (!position) return { content: [{ type: "text" as const, text: "Position not found or already closed" }], isError: true };
      return { content: [{ type: "text" as const, text: JSON.stringify(position) }] };
    },
  );

  server.registerTool(
    "update_position",
    {
      description: "Update an open position (move SL, update TP, add notes)",
      inputSchema: {
        id: z.string().describe("Position ID"),
        stop_loss: z.number().optional().describe("New stop loss"),
        take_profit: z.number().optional().describe("New take profit"),
        current_price: z.number().optional().describe("Current market price"),
        notes: z.string().optional().describe("Updated notes"),
      },
    },
    async ({ id, ...updates }) => {
      const updated = trading.updatePosition(id, updates);
      return { content: [{ type: "text" as const, text: JSON.stringify({ updated }) }] };
    },
  );

  // --- Risk ---

  server.registerTool(
    "get_risk_state",
    {
      description: "Get current risk management state: daily P&L, trade count, limits, open positions count, account balance",
      inputSchema: {},
    },
    async () => {
      const state = trading.getRiskState();
      return { content: [{ type: "text" as const, text: JSON.stringify(state) }] };
    },
  );

  server.registerTool(
    "update_risk_state",
    {
      description: "Update risk management limits",
      inputSchema: {
        daily_loss_limit: z.number().optional().describe("Daily loss limit in USD (negative number, e.g., -500)"),
        max_position_size: z.number().optional().describe("Max position size in USD"),
        max_concurrent: z.number().int().optional().describe("Max concurrent open positions"),
        max_daily_trades: z.number().int().optional().describe("Max trades per day"),
        risk_per_trade_percent: z.number().optional().describe("Risk per trade as % of account"),
        account_balance: z.number().optional().describe("Current account balance in USD"),
      },
    },
    async (updates) => {
      trading.updateRiskState(updates);
      const state = trading.getRiskState();
      return { content: [{ type: "text" as const, text: JSON.stringify(state) }] };
    },
  );

  server.registerTool(
    "check_risk",
    {
      description: "Check if a proposed trade is allowed by current risk limits. Returns pass/fail with reason and suggested position size.",
      inputSchema: {
        direction: z.enum(["long", "short"]).describe("Trade direction"),
        entry_price: z.number().describe("Planned entry price"),
        stop_loss: z.number().describe("Planned stop loss"),
      },
    },
    async ({ direction, entry_price, stop_loss }) => {
      const result = trading.checkRisk(direction, entry_price, stop_loss);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  // --- Market Notes ---

  server.registerTool(
    "add_market_note",
    {
      description: "Log a market observation, key level, bias, or news item",
      inputSchema: {
        symbol: z.string().optional().describe("Symbol (null for general market notes)"),
        category: z.enum(["level", "bias", "observation", "news", "session_recap"]).describe("Note category"),
        content: z.string().describe("Note content"),
        source: z.string().optional().describe("Source (manual, scan, briefing)"),
        valid_until: z.number().optional().describe("Expiry timestamp (e.g., for session-specific levels)"),
      },
    },
    async (input) => {
      const note = trading.addMarketNote(input);
      return { content: [{ type: "text" as const, text: JSON.stringify(note) }] };
    },
  );

  server.registerTool(
    "get_market_notes",
    {
      description: "Retrieve market notes filtered by symbol and/or category",
      inputSchema: {
        symbol: z.string().optional().describe("Filter by symbol"),
        category: z.enum(["level", "bias", "observation", "news", "session_recap"]).optional().describe("Filter by category"),
        limit: z.number().int().positive().optional().describe("Max results (default: 20)"),
      },
    },
    async ({ symbol, category, limit }) => {
      const notes = trading.getMarketNotes({ symbol, category, limit });
      return { content: [{ type: "text" as const, text: JSON.stringify(notes) }] };
    },
  );

  // --- Journal ---

  server.registerTool(
    "save_journal_entry",
    {
      description: "Save or update a daily trading journal entry",
      inputSchema: {
        date: z.string().describe("Date in YYYY-MM-DD format"),
        market_summary: z.string().optional().describe("Market summary for the day"),
        trades_taken: z.number().int().optional().describe("Number of trades"),
        total_pnl: z.number().optional().describe("Total P&L in USD"),
        lessons: z.string().optional().describe("Lessons learned"),
        emotional_state: z.string().optional().describe("Emotional state during trading"),
        plan_adherence: z.string().optional().describe("How well the plan was followed"),
        tomorrow_plan: z.string().optional().describe("Plan for tomorrow"),
      },
    },
    async (input) => {
      const entry = trading.saveJournalEntry(input);
      return { content: [{ type: "text" as const, text: JSON.stringify(entry) }] };
    },
  );

  server.registerTool(
    "get_journal_entries",
    {
      description: "Retrieve daily trading journal entries",
      inputSchema: {
        from: z.string().optional().describe("Start date (YYYY-MM-DD)"),
        to: z.string().optional().describe("End date (YYYY-MM-DD)"),
        limit: z.number().int().positive().optional().describe("Max results (default: 30)"),
      },
    },
    async ({ from, to, limit }) => {
      const entries = trading.getJournalEntries({ from, to, limit });
      return { content: [{ type: "text" as const, text: JSON.stringify(entries) }] };
    },
  );

  // --- Todos ---

  server.registerTool(
    "add_todo",
    {
      description: "Add a todo/task for User",
      inputSchema: {
        title: z.string().describe("Todo description"),
        category: z.enum(["general", "trading", "personal", "work"]).optional().describe("Category (default: general)"),
        priority: z.number().int().min(0).max(2).optional().describe("0=normal, 1=high, 2=urgent"),
        due_at: z.number().optional().describe("Due date timestamp"),
        reminder_at: z.number().optional().describe("Reminder timestamp"),
      },
    },
    async (input) => {
      const todo = trading.addTodo(input);
      return { content: [{ type: "text" as const, text: JSON.stringify(todo) }] };
    },
  );

  server.registerTool(
    "get_todos",
    {
      description: "List pending todos for User",
      inputSchema: {
        include_completed: z.boolean().optional().describe("Include completed todos (default: false)"),
      },
    },
    async ({ include_completed }) => {
      const todos = trading.getTodos(include_completed);
      return { content: [{ type: "text" as const, text: JSON.stringify(todos) }] };
    },
  );

  server.registerTool(
    "complete_todo",
    {
      description: "Mark a todo as completed",
      inputSchema: {
        id: z.string().describe("Todo ID"),
      },
    },
    async ({ id }) => {
      const completed = trading.completeTodo(id);
      return { content: [{ type: "text" as const, text: JSON.stringify({ completed }) }] };
    },
  );

  // --- Alerts ---

  server.registerTool(
    "create_alert",
    {
      description: "Set a price alert for a symbol",
      inputSchema: {
        symbol: z.string().describe("Symbol (e.g., BTCUSDT)"),
        condition: z.string().describe("Alert condition (e.g., above:100000, below:1.0800)"),
        message: z.string().optional().describe("Custom alert message"),
      },
    },
    async (input) => {
      const alert = trading.createAlert(input);
      return { content: [{ type: "text" as const, text: JSON.stringify(alert) }] };
    },
  );

  server.registerTool(
    "get_alerts",
    {
      description: "List price alerts",
      inputSchema: {
        pending_only: z.boolean().optional().describe("Only show untriggered alerts (default: true)"),
      },
    },
    async ({ pending_only }) => {
      const alerts = trading.getAlerts(pending_only ?? true);
      return { content: [{ type: "text" as const, text: JSON.stringify(alerts) }] };
    },
  );

  server.registerTool(
    "trigger_alert",
    {
      description: "Mark a price alert as triggered",
      inputSchema: {
        id: z.string().describe("Alert ID"),
      },
    },
    async ({ id }) => {
      const triggered = trading.triggerAlert(id);
      return { content: [{ type: "text" as const, text: JSON.stringify({ triggered }) }] };
    },
  );

  server.registerTool(
    "get_trading_context",
    {
      description: "Get a formatted summary of current trading state: watchlist, open positions, risk status, active signals, pending alerts, and todos. Use this at the start of trading-related tasks.",
      inputSchema: {},
    },
    async () => {
      const context = trading.getTradingContext();
      return { content: [{ type: "text" as const, text: context }] };
    },
  );
}
