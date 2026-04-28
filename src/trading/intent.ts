import { z } from "zod/v4";
import type { TradeIntentInput } from "./types.js";

const tradeIntentInputSchema = z.object({
  symbol: z.string().trim().min(1),
  market: z.enum(["crypto", "forex", "stocks", "futures"]),
  timeframe: z.string().trim().min(1),
  direction: z.enum(["long", "short"]),
  thesis: z.string().trim().min(10),
  invalidation: z.string().trim().min(3),
  entry_price: z.number().positive(),
  stop_loss: z.number().positive(),
  take_profit: z.number().positive(),
  risk_percent: z.number().positive().max(10),
  confidence: z.number().int().min(1).max(10),
  evidence: z.array(z.string().trim().min(1)).min(1),
  execution_mode: z.enum(["paper", "live"]),
  entry_model: z.string().trim().min(1).optional().nullable(),
  source: z.string().trim().min(1).optional().nullable(),
  expires_at: z.number().int().positive().optional().nullable(),
}).superRefine((value, ctx) => {
  if (value.direction === "long") {
    if (value.stop_loss >= value.entry_price) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stop_loss"],
        message: "Long intents require stop_loss below entry_price",
      });
    }
    if (value.take_profit <= value.entry_price) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["take_profit"],
        message: "Long intents require take_profit above entry_price",
      });
    }
  } else {
    if (value.stop_loss <= value.entry_price) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stop_loss"],
        message: "Short intents require stop_loss above entry_price",
      });
    }
    if (value.take_profit >= value.entry_price) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["take_profit"],
        message: "Short intents require take_profit below entry_price",
      });
    }
  }

  if (value.expires_at && value.expires_at <= Date.now()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expires_at"],
      message: "Trade intents must expire in the future",
    });
  }
});

export function parseTradeIntentInput(input: TradeIntentInput): {
  ok: true;
  value: TradeIntentInput;
} | {
  ok: false;
  errors: string[];
} {
  const parsed = tradeIntentInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => issue.message),
    };
  }

  return {
    ok: true,
    value: {
      ...parsed.data,
      symbol: parsed.data.symbol.toUpperCase(),
      evidence: parsed.data.evidence.map((item) => item.trim()),
    },
  };
}
