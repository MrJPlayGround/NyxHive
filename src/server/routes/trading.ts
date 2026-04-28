import { Hono } from "hono";
import type { TradingDB } from "../../trading/db.js";
import { canRead } from "../middleware/rbac.js";

export function tradingRoutes(trading: TradingDB): Hono {
  const app = new Hono();

  app.get("/lane", canRead, (c) => {
    return c.json(trading.getTradingLaneSnapshot());
  });

  return app;
}
