import { describe, test, expect } from "bun:test";
import { parseCron, matches, nextOccurrence } from "../scheduler/cron.js";
import type { CronExpression } from "../scheduler/cron.js";

describe("parseCron", () => {
  test("parses every-minute wildcard (* * * * *)", () => {
    const expr = parseCron("* * * * *");
    expect(expr.minutes.size).toBe(60);
    expect(expr.hours.size).toBe(24);
    expect(expr.daysOfMonth.size).toBe(31);
    expect(expr.months.size).toBe(12);
    expect(expr.daysOfWeek.size).toBe(7);
  });

  test("parses specific values (0 9 1 1 0)", () => {
    const expr = parseCron("0 9 1 1 0");
    expect(expr.minutes).toEqual(new Set([0]));
    expect(expr.hours).toEqual(new Set([9]));
    expect(expr.daysOfMonth).toEqual(new Set([1]));
    expect(expr.months).toEqual(new Set([1]));
    expect(expr.daysOfWeek).toEqual(new Set([0]));
  });

  test("parses lists (1,15,30 9,17 * * *)", () => {
    const expr = parseCron("1,15,30 9,17 * * *");
    expect(expr.minutes).toEqual(new Set([1, 15, 30]));
    expect(expr.hours).toEqual(new Set([9, 17]));
  });

  test("parses ranges (0 8-18 * * 1-5)", () => {
    const expr = parseCron("0 8-18 * * 1-5");
    expect(expr.minutes).toEqual(new Set([0]));
    expect(expr.hours).toEqual(new Set([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]));
    expect(expr.daysOfWeek).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  test("parses steps with wildcard (*/15 * * * *)", () => {
    const expr = parseCron("*/15 * * * *");
    expect(expr.minutes).toEqual(new Set([0, 15, 30, 45]));
  });

  test("parses steps with range (10-30/5 * * * *)", () => {
    const expr = parseCron("10-30/5 * * * *");
    expect(expr.minutes).toEqual(new Set([10, 15, 20, 25, 30]));
  });

  test("parses step from a specific value (5/10 * * * *)", () => {
    const expr = parseCron("5/10 * * * *");
    expect(expr.minutes).toEqual(new Set([5, 15, 25, 35, 45, 55]));
  });

  test("parses Monday at 9am (0 9 * * 1)", () => {
    const expr = parseCron("0 9 * * 1");
    expect(expr.minutes).toEqual(new Set([0]));
    expect(expr.hours).toEqual(new Set([9]));
    expect(expr.daysOfWeek).toEqual(new Set([1]));
  });

  test("parses complex mixed expression (0,30 9-17 1,15 1-6 1-5)", () => {
    const expr = parseCron("0,30 9-17 1,15 1-6 1-5");
    expect(expr.minutes).toEqual(new Set([0, 30]));
    expect(expr.hours).toEqual(new Set([9, 10, 11, 12, 13, 14, 15, 16, 17]));
    expect(expr.daysOfMonth).toEqual(new Set([1, 15]));
    expect(expr.months).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(expr.daysOfWeek).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  test("trims whitespace from expression", () => {
    const expr = parseCron("  0 9 * * 1  ");
    expect(expr.minutes).toEqual(new Set([0]));
    expect(expr.hours).toEqual(new Set([9]));
  });

  test("handles */1 as equivalent to *", () => {
    const expr = parseCron("*/1 * * * *");
    expect(expr.minutes.size).toBe(60);
  });

  test("clamps out-of-range values", () => {
    // Value 70 is out of range for minutes (0-59) — should be ignored
    const expr = parseCron("70 * * * *");
    expect(expr.minutes.size).toBe(0);
  });

  test("throws on too few fields", () => {
    expect(() => parseCron("* * *")).toThrow("expected 5 fields, got 3");
  });

  test("throws on too many fields", () => {
    expect(() => parseCron("* * * * * *")).toThrow("expected 5 fields, got 6");
  });

  test("throws on empty string", () => {
    expect(() => parseCron("")).toThrow("expected 5 fields");
  });
});

describe("matches", () => {
  test("every-minute matches any date", () => {
    const expr = parseCron("* * * * *");
    expect(matches(expr, new Date(2026, 0, 1, 0, 0))).toBe(true);
    expect(matches(expr, new Date(2026, 5, 15, 12, 30))).toBe(true);
    expect(matches(expr, new Date(2026, 11, 31, 23, 59))).toBe(true);
  });

  test("specific time matches correctly", () => {
    const expr = parseCron("30 14 * * *");
    // 2026-03-03 14:30 (Tuesday)
    expect(matches(expr, new Date(2026, 2, 3, 14, 30))).toBe(true);
    expect(matches(expr, new Date(2026, 2, 3, 14, 31))).toBe(false);
    expect(matches(expr, new Date(2026, 2, 3, 15, 30))).toBe(false);
  });

  test("day-of-week filter works (Monday only)", () => {
    const expr = parseCron("0 9 * * 1");
    // 2026-03-02 is a Monday
    expect(matches(expr, new Date(2026, 2, 2, 9, 0))).toBe(true);
    // 2026-03-03 is a Tuesday
    expect(matches(expr, new Date(2026, 2, 3, 9, 0))).toBe(false);
  });

  test("month filter works", () => {
    const expr = parseCron("0 0 1 6 *");
    // June 1st
    expect(matches(expr, new Date(2026, 5, 1, 0, 0))).toBe(true);
    // July 1st
    expect(matches(expr, new Date(2026, 6, 1, 0, 0))).toBe(false);
  });

  test("day-of-month filter works", () => {
    const expr = parseCron("0 0 15 * *");
    expect(matches(expr, new Date(2026, 2, 15, 0, 0))).toBe(true);
    expect(matches(expr, new Date(2026, 2, 16, 0, 0))).toBe(false);
  });

  test("weekday range 1-5 excludes weekends", () => {
    const expr = parseCron("0 9 * * 1-5");
    // 2026-03-01 is Sunday (day 0)
    expect(matches(expr, new Date(2026, 2, 1, 9, 0))).toBe(false);
    // 2026-03-02 is Monday
    expect(matches(expr, new Date(2026, 2, 2, 9, 0))).toBe(true);
    // 2026-03-07 is Saturday (day 6)
    expect(matches(expr, new Date(2026, 2, 7, 9, 0))).toBe(false);
  });

  test("step minutes match at correct intervals", () => {
    const expr = parseCron("*/15 * * * *");
    expect(matches(expr, new Date(2026, 0, 1, 0, 0))).toBe(true);
    expect(matches(expr, new Date(2026, 0, 1, 0, 15))).toBe(true);
    expect(matches(expr, new Date(2026, 0, 1, 0, 30))).toBe(true);
    expect(matches(expr, new Date(2026, 0, 1, 0, 45))).toBe(true);
    expect(matches(expr, new Date(2026, 0, 1, 0, 10))).toBe(false);
  });
});

describe("nextOccurrence", () => {
  test("finds next minute for every-minute expression", () => {
    const expr = parseCron("* * * * *");
    const after = new Date(2026, 2, 3, 10, 30, 0);
    const next = nextOccurrence(expr, after);
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(2);
    expect(next.getDate()).toBe(3);
    expect(next.getHours()).toBe(10);
    expect(next.getMinutes()).toBe(31);
    expect(next.getSeconds()).toBe(0);
    expect(next.getMilliseconds()).toBe(0);
  });

  test("skips to next matching minute", () => {
    const expr = parseCron("0 * * * *");
    const after = new Date(2026, 2, 3, 10, 15, 0);
    const next = nextOccurrence(expr, after);
    expect(next.getHours()).toBe(11);
    expect(next.getMinutes()).toBe(0);
  });

  test("skips to next day when no more matches today", () => {
    const expr = parseCron("0 9 * * *");
    const after = new Date(2026, 2, 3, 9, 0, 0); // exactly at 9:00
    const next = nextOccurrence(expr, after);
    // Should be next day since after advances by 1 minute
    expect(next.getDate()).toBe(4);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  test("skips to correct day of week", () => {
    const expr = parseCron("0 9 * * 1"); // Monday 9am
    // 2026-03-03 is Tuesday
    const after = new Date(2026, 2, 3, 0, 0, 0);
    const next = nextOccurrence(expr, after);
    // Next Monday is 2026-03-09
    expect(next.getDate()).toBe(9);
    expect(next.getDay()).toBe(1); // Monday
    expect(next.getHours()).toBe(9);
  });

  test("skips to correct month", () => {
    const expr = parseCron("0 0 1 6 *"); // midnight, June 1st
    const after = new Date(2026, 5, 1, 0, 0, 0); // June 1st 00:00
    const next = nextOccurrence(expr, after);
    // Should be June 1st next year since after advances by 1 minute
    expect(next.getFullYear()).toBe(2027);
    expect(next.getMonth()).toBe(5); // June
    expect(next.getDate()).toBe(1);
  });

  test("zeroes out seconds and milliseconds", () => {
    const expr = parseCron("* * * * *");
    const after = new Date(2026, 2, 3, 10, 30, 45, 123);
    const next = nextOccurrence(expr, after);
    expect(next.getSeconds()).toBe(0);
    expect(next.getMilliseconds()).toBe(0);
  });

  test("advances at least 1 minute from 'after'", () => {
    const expr = parseCron("30 10 * * *");
    const after = new Date(2026, 2, 3, 10, 30, 0);
    const next = nextOccurrence(expr, after);
    // Should skip to next day's 10:30, not return the same time
    expect(next.getDate()).toBe(4);
    expect(next.getHours()).toBe(10);
    expect(next.getMinutes()).toBe(30);
  });

  test("handles step expression for next occurrence", () => {
    const expr = parseCron("*/15 * * * *");
    const after = new Date(2026, 2, 3, 10, 16, 0);
    const next = nextOccurrence(expr, after);
    expect(next.getMinutes()).toBe(30);
  });
});
