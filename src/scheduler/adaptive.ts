/**
 * Adaptive scheduling — tasks self-adjust their cron frequency based on outcomes.
 * If a scan finds nothing for 3 cycles, double the interval.
 * If it finds something critical, halve the interval.
 *
 * Supports common NyxHive cron patterns:
 *   - `0 H * * *`     = daily at hour H
 *   - `0 H *​/N * *`   = every N days at hour H
 *   - `0 *​/N * * *`   = every N hours
 *   - `0 H * * D`     = weekly on day D
 * Complex patterns (minute-based, offsets like `30 *​/2`) are returned unchanged.
 */

import type { Database } from "bun:sqlite";

// ─── Interval helpers ──────────────────────────────────────────────

/** Parse a cron into its 5 fields. Returns null if not exactly 5 fields. */
function parseCronFields(cron: string): string[] | null {
  const parts = cron.trim().split(/\s+/);
  return parts.length === 5 ? parts : null;
}

/**
 * Classify a cron expression into a manageable pattern.
 * Returns the pattern type and relevant parameters, or null if too complex.
 */
type CronPattern =
  | { type: "hourly-step"; step: number; minute: string }    // 0 */N * * *
  | { type: "daily"; hour: string; minute: string }          // 0 H * * *
  | { type: "day-step"; step: number; hour: string; minute: string }  // 0 H */N * *
  | { type: "weekly"; hour: string; minute: string; dow: string };    // 0 H * * D

function classifyCron(cron: string): CronPattern | null {
  const fields = parseCronFields(cron);
  if (!fields) return null;

  const [minute, hour, dom, , dow] = fields;

  // Only handle patterns with minute = "0" to avoid complex offsets
  if (minute !== "0") return null;

  // Weekly: 0 H * * D (D is a specific day number)
  if (dom === "*" && dow !== "*" && !dow.includes("/")) {
    return { type: "weekly", hour, minute, dow };
  }

  // Every-N-hours: 0 */N * * *
  if (hour.startsWith("*/") && dom === "*" && dow === "*") {
    const step = Number.parseInt(hour.slice(2), 10);
    if (!Number.isNaN(step)) return { type: "hourly-step", step, minute };
  }

  // Every-N-days: 0 H */N * *
  if (dom.startsWith("*/") && dow === "*" && !hour.includes("/")) {
    const step = Number.parseInt(dom.slice(2), 10);
    if (!Number.isNaN(step)) return { type: "day-step", step, hour, minute };
  }

  // Daily: 0 H * * * (H is a plain number)
  if (!hour.includes("/") && dom === "*" && dow === "*") {
    return { type: "daily", hour, minute };
  }

  return null;
}

function buildCron(minute: string, hour: string, dom: string, month: string, dow: string): string {
  return `${minute} ${hour} ${dom} ${month} ${dow}`;
}

/**
 * Double the interval of a cron expression.
 * daily -> every-2-days, every-2-days -> every-4-days, etc.
 * Caps at weekly. Returns unchanged if too complex or already at cap.
 */
export function doubleInterval(cron: string): string {
  const pattern = classifyCron(cron);
  if (!pattern) return cron;

  switch (pattern.type) {
    case "weekly":
      // Already at cap
      return cron;

    case "daily":
      // daily -> every 2 days
      return buildCron("0", pattern.hour, "*/2", "*", "*");

    case "day-step": {
      const newStep = pattern.step * 2;
      if (newStep >= 7) {
        // Cap at weekly (Monday)
        return buildCron("0", pattern.hour, "*", "*", "1");
      }
      return buildCron("0", pattern.hour, `*/${newStep}`, "*", "*");
    }

    case "hourly-step": {
      const newStep = pattern.step * 2;
      if (newStep >= 24) {
        // Promote to daily
        return buildCron("0", "0", "*", "*", "*");
      }
      return buildCron("0", `*/${newStep}`, "*", "*", "*");
    }
  }
}

/**
 * Halve the interval of a cron expression.
 * every-2-days -> daily, weekly -> every-4-days, etc.
 * Floors at every-4-hours. Returns unchanged if too complex or already at floor.
 */
export function halveInterval(cron: string): string {
  const pattern = classifyCron(cron);
  if (!pattern) return cron;

  const FLOOR_HOURS = 4;

  switch (pattern.type) {
    case "weekly":
      // weekly -> every 4 days (approximate halving of 7)
      return buildCron("0", pattern.hour, "*/4", "*", "*");

    case "daily":
      // daily -> every 12 hours
      return buildCron("0", "*/12", "*", "*", "*");

    case "day-step": {
      const newStep = Math.floor(pattern.step / 2);
      if (newStep < 2) {
        // Promote to daily
        return buildCron("0", pattern.hour, "*", "*", "*");
      }
      return buildCron("0", pattern.hour, `*/${newStep}`, "*", "*");
    }

    case "hourly-step": {
      const newStep = Math.floor(pattern.step / 2);
      if (newStep < FLOOR_HOURS) {
        // Floor at 4 hours
        return buildCron("0", `*/${FLOOR_HOURS}`, "*", "*", "*");
      }
      return buildCron("0", `*/${newStep}`, "*", "*", "*");
    }
  }
}

// ─── Main adjustment logic ─────────────────────────────────────────

const EMPTY_THRESHOLD = 3;

/**
 * Adjust a scheduled task's cron frequency based on outcome.
 *
 * - hadFindings=true: reset consecutive_empty to 0.
 *   If findingPriority === "high", halve the interval.
 *   Otherwise, reset to original_cron.
 * - hadFindings=false: increment consecutive_empty.
 *   If >= EMPTY_THRESHOLD, double the interval.
 */
export function adjustScheduleFrequency(
  db: Database,
  taskName: string,
  hadFindings: boolean,
  findingPriority?: string,
): void {
  const row = db.query(
    "SELECT id, cron_expression, original_cron, consecutive_empty FROM scheduled_tasks WHERE name = ?",
  ).get(taskName) as {
    id: string;
    cron_expression: string;
    original_cron: string | null;
    consecutive_empty: number;
  } | null;

  if (!row) return;

  const originalCron = row.original_cron ?? row.cron_expression;

  if (hadFindings) {
    if (findingPriority === "high") {
      // Halve from original (not current adjusted) to avoid runaway shrinking
      const halved = halveInterval(originalCron);
      db.run(
        `UPDATE scheduled_tasks SET
          consecutive_empty = 0,
          cron_expression = ?,
          adjusted_cron = ?,
          updated_at = ?
        WHERE id = ?`,
        [halved, halved, Date.now(), row.id],
      );
    } else {
      // Reset to original
      db.run(
        `UPDATE scheduled_tasks SET
          consecutive_empty = 0,
          cron_expression = ?,
          adjusted_cron = NULL,
          updated_at = ?
        WHERE id = ?`,
        [originalCron, Date.now(), row.id],
      );
    }
  } else {
    const newEmpty = row.consecutive_empty + 1;
    if (newEmpty >= EMPTY_THRESHOLD) {
      // Double from current cron (progressive widening)
      const doubled = doubleInterval(row.cron_expression);
      db.run(
        `UPDATE scheduled_tasks SET
          consecutive_empty = ?,
          cron_expression = ?,
          adjusted_cron = ?,
          updated_at = ?
        WHERE id = ?`,
        [newEmpty, doubled, doubled, Date.now(), row.id],
      );
    } else {
      db.run(
        `UPDATE scheduled_tasks SET
          consecutive_empty = ?,
          updated_at = ?
        WHERE id = ?`,
        [newEmpty, Date.now(), row.id],
      );
    }
  }
}
