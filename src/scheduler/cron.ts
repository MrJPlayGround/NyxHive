/**
 * Minimal 5-field cron expression parser.
 * Supports: *, specific values, lists (1,3,5), ranges (1-5), steps (asterisk/15).
 * No external dependencies.
 */

export interface CronExpression {
  minutes: Set<number>;     // 0-59
  hours: Set<number>;       // 0-23
  daysOfMonth: Set<number>; // 1-31
  months: Set<number>;      // 1-12
  daysOfWeek: Set<number>;  // 0-6 (0=Sunday)
}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    // Step: */N or range/N
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const step = Number.parseInt(stepMatch[2], 10);
      const base = stepMatch[1];
      let start = min;
      let end = max;

      if (base !== "*") {
        const rangeMatch = base.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
          start = Number.parseInt(rangeMatch[1], 10);
          end = Number.parseInt(rangeMatch[2], 10);
        } else {
          start = Number.parseInt(base, 10);
        }
      }

      for (let i = start; i <= end; i += step) {
        if (i >= min && i <= max) values.add(i);
      }
      continue;
    }

    // Range: N-M
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      for (let i = start; i <= end; i++) {
        if (i >= min && i <= max) values.add(i);
      }
      continue;
    }

    // Single value
    const val = Number.parseInt(part, 10);
    if (!Number.isNaN(val) && val >= min && val <= max) {
      values.add(val);
    }
  }

  return values;
}

export function parseCron(expr: string): CronExpression {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${fields.length}`);
  }

  return {
    minutes: parseField(fields[0], 0, 59),
    hours: parseField(fields[1], 0, 23),
    daysOfMonth: parseField(fields[2], 1, 31),
    months: parseField(fields[3], 1, 12),
    daysOfWeek: parseField(fields[4], 0, 6),
  };
}

export function matches(expr: CronExpression, date: Date): boolean {
  return (
    expr.minutes.has(date.getMinutes()) &&
    expr.hours.has(date.getHours()) &&
    expr.daysOfMonth.has(date.getDate()) &&
    expr.months.has(date.getMonth() + 1) &&
    expr.daysOfWeek.has(date.getDay())
  );
}

export function nextOccurrence(expr: CronExpression, after?: Date): Date {
  const start = after ? new Date(after.getTime() + 60_000) : new Date();
  // Zero out seconds/ms
  start.setSeconds(0, 0);

  // Search up to 2 years ahead
  const maxIterations = 365 * 24 * 60 * 2;
  const candidate = new Date(start);

  for (let i = 0; i < maxIterations; i++) {
    if (matches(expr, candidate)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  // Should never reach here with valid expressions
  throw new Error("No next occurrence found within 2 years");
}
