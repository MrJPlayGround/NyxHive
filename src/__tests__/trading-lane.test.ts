import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TradingDB } from "../trading/db.js";
import { PaperExecutionAdapter } from "../trading/adapter/paper.js";
import { TradingLane } from "../trading/lane.js";

describe("trading lane", () => {
  let dataDir: string;
  let trading: TradingDB;
  let lane: TradingLane;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "nyx-trading-lane-"));
    trading = new TradingDB(dataDir, "test", {
      risk_per_trade_percent: 1,
      max_position_size: 5000,
      max_concurrent_positions: 3,
      max_daily_trades: 6,
    });
    lane = new TradingLane(trading, {
      paper: new PaperExecutionAdapter(trading),
    });
  });

  afterEach(() => {
    trading.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("rejects trade intents while the lane is disabled", async () => {
    const result = await lane.submitIntent({
      symbol: "BTCUSD",
      market: "crypto",
      timeframe: "4h",
      direction: "long",
      thesis: "Sweep into reclaim above weekly support.",
      invalidation: "Lose 61800 reclaim.",
      entry_price: 62500,
      stop_loss: 61800,
      take_profit: 64100,
      risk_percent: 0.5,
      confidence: 7,
      evidence: ["weekly support reclaim", "bullish displacement"],
      execution_mode: "paper",
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("Lane mode disabled");
    expect(trading.listTradeIntents()).toHaveLength(0);
  });

  test("executes paper intents end to end when paper mode is armed", async () => {
    const modeResult = lane.setMode("paper", "User enabled paper trading");
    expect(modeResult.ok).toBe(true);

    trading.updateRiskState({ account_balance: 10000 });

    const result = await lane.submitIntent({
      symbol: "ETHUSD",
      market: "crypto",
      timeframe: "1h",
      direction: "long",
      thesis: "Opening range reclaim with trend continuation.",
      invalidation: "Lose the session low.",
      entry_price: 3100,
      stop_loss: 3050,
      take_profit: 3210,
      risk_percent: 0.8,
      confidence: 8,
      evidence: ["session reclaim", "higher low", "volume expansion"],
      execution_mode: "paper",
    });

    expect(result.status).toBe("executed");
    expect(result.intent).toBeDefined();
    expect(result.intent!.status).toBe("executed");
    expect(result.execution?.status).toBe("filled");
    expect(trading.getPositions("open")).toHaveLength(1);
    expect(trading.listTradeExecutions()).toHaveLength(1);
  });

  test("rejects intents that exceed the configured risk budget", async () => {
    lane.setMode("paper", "User enabled paper trading");
    trading.updateRiskState({
      account_balance: 10000,
      risk_per_trade_percent: 0.5,
    });

    const result = await lane.submitIntent({
      symbol: "SOLUSD",
      market: "crypto",
      timeframe: "15m",
      direction: "long",
      thesis: "Momentum continuation after reclaim.",
      invalidation: "Lose reclaim candle low.",
      entry_price: 140,
      stop_loss: 134,
      take_profit: 154,
      risk_percent: 1.25,
      confidence: 6,
      evidence: ["momentum continuation"],
      execution_mode: "paper",
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("Risk percent 1.25 exceeds lane limit 0.5");
    expect(trading.listTradeIntents()).toHaveLength(1);
    expect(trading.listTradeIntents()[0]?.status).toBe("rejected");
    expect(trading.getPositions("open")).toHaveLength(0);
  });
});
