import { describe, it, expect } from "bun:test"
import { parseCron, matches, nextOccurrence } from "../scheduler/cron.js"

describe("parseCron", () => {
  it("throws on wrong number of fields", () => {
    expect(() => parseCron("* * *")).toThrow(/expected 5 fields/)
    expect(() => parseCron("* * * * * *")).toThrow(/expected 5 fields/)
  })

  it("parses every minute (* * * * *)", () => {
    const expr = parseCron("* * * * *")
    expect(expr.minutes.size).toBe(60)
    expect(expr.hours.size).toBe(24)
    expect(expr.daysOfMonth.size).toBe(31)
    expect(expr.months.size).toBe(12)
    expect(expr.daysOfWeek.size).toBe(7)
  })

  it("parses specific values", () => {
    const expr = parseCron("30 14 1 6 3")
    expect(expr.minutes).toEqual(new Set([30]))
    expect(expr.hours).toEqual(new Set([14]))
    expect(expr.daysOfMonth).toEqual(new Set([1]))
    expect(expr.months).toEqual(new Set([6]))
    expect(expr.daysOfWeek).toEqual(new Set([3]))
  })

  it("parses lists (comma-separated)", () => {
    const expr = parseCron("0,15,30,45 * * * *")
    expect(expr.minutes).toEqual(new Set([0, 15, 30, 45]))
  })

  it("parses ranges", () => {
    const expr = parseCron("* 9-17 * * *")
    expect(expr.hours).toEqual(new Set([9, 10, 11, 12, 13, 14, 15, 16, 17]))
  })

  it("parses steps (*/N)", () => {
    const expr = parseCron("*/15 * * * *")
    expect(expr.minutes).toEqual(new Set([0, 15, 30, 45]))
  })

  it("parses range steps (1-10/3)", () => {
    const expr = parseCron("1-10/3 * * * *")
    expect(expr.minutes).toEqual(new Set([1, 4, 7, 10]))
  })

  it("parses complex cron expression", () => {
    const expr = parseCron("0,30 9-17 1,15 1-6 1-5")
    expect(expr.minutes).toEqual(new Set([0, 30]))
    expect(expr.hours).toEqual(new Set([9, 10, 11, 12, 13, 14, 15, 16, 17]))
    expect(expr.daysOfMonth).toEqual(new Set([1, 15]))
    expect(expr.months).toEqual(new Set([1, 2, 3, 4, 5, 6]))
    expect(expr.daysOfWeek).toEqual(new Set([1, 2, 3, 4, 5]))
  })

  it("handles whitespace trimming", () => {
    const expr = parseCron("  0 12 * * *  ")
    expect(expr.minutes).toEqual(new Set([0]))
    expect(expr.hours).toEqual(new Set([12]))
  })

  it("ignores out-of-range values", () => {
    const expr = parseCron("99 * * * *")
    expect(expr.minutes.has(99)).toBe(false)
  })

  it("clamps range to field bounds", () => {
    const expr = parseCron("50-70 * * * *")
    // Only 50-59 are valid for minutes
    expect(expr.minutes.has(59)).toBe(true)
    expect(expr.minutes.has(60)).toBe(false)
  })
})

describe("matches", () => {
  it("matches every minute expression against any date", () => {
    const expr = parseCron("* * * * *")
    expect(matches(expr, new Date())).toBe(true)
  })

  it("matches specific time", () => {
    const expr = parseCron("30 14 * * *")
    const date = new Date(2026, 2, 7, 14, 30) // March 7, 2026 14:30
    expect(matches(expr, date)).toBe(true)
  })

  it("does not match wrong minute", () => {
    const expr = parseCron("30 14 * * *")
    const date = new Date(2026, 2, 7, 14, 31)
    expect(matches(expr, date)).toBe(false)
  })

  it("does not match wrong hour", () => {
    const expr = parseCron("30 14 * * *")
    const date = new Date(2026, 2, 7, 15, 30)
    expect(matches(expr, date)).toBe(false)
  })

  it("matches day of week (0=Sunday)", () => {
    const expr = parseCron("* * * * 0")
    const sunday = new Date(2026, 2, 8) // March 8, 2026 is a Sunday
    expect(matches(expr, sunday)).toBe(true)
    const monday = new Date(2026, 2, 9)
    expect(matches(expr, monday)).toBe(false)
  })

  it("matches month field", () => {
    const expr = parseCron("* * * 3 *")
    const march = new Date(2026, 2, 7) // March (month index 2 = month 3)
    expect(matches(expr, march)).toBe(true)
    const april = new Date(2026, 3, 7)
    expect(matches(expr, april)).toBe(false)
  })

  it("matches day of month", () => {
    const expr = parseCron("* * 15 * *")
    const fifteenth = new Date(2026, 2, 15)
    expect(matches(expr, fifteenth)).toBe(true)
    const sixteenth = new Date(2026, 2, 16)
    expect(matches(expr, sixteenth)).toBe(false)
  })
})

describe("nextOccurrence", () => {
  it("finds next minute for every-minute expression", () => {
    const expr = parseCron("* * * * *")
    const now = new Date(2026, 2, 7, 14, 30, 0, 0)
    const next = nextOccurrence(expr, now)
    expect(next.getMinutes()).toBe(31) // next minute
  })

  it("finds next specific time", () => {
    const expr = parseCron("0 12 * * *")
    const now = new Date(2026, 2, 7, 13, 0, 0, 0)
    const next = nextOccurrence(expr, now)
    expect(next.getHours()).toBe(12)
    expect(next.getMinutes()).toBe(0)
    // Should be next day's noon if past 13:00
    // Actually, now is 13:00, next noon is March 8
    expect(next.getDate()).toBe(8)
  })

  it("wraps to next day if time has passed", () => {
    const expr = parseCron("0 9 * * *")
    const now = new Date(2026, 2, 7, 10, 0, 0, 0) // 10:00, past 9:00
    const next = nextOccurrence(expr, now)
    expect(next.getDate()).toBe(8)
    expect(next.getHours()).toBe(9)
  })

  it("finds occurrence on specific day of week", () => {
    const expr = parseCron("0 9 * * 1") // Monday at 9:00
    const friday = new Date(2026, 2, 6, 10, 0, 0, 0) // Friday March 6
    const next = nextOccurrence(expr, friday)
    expect(next.getDay()).toBe(1) // Monday
    expect(next.getHours()).toBe(9)
  })

  it("returns a date with zeroed seconds", () => {
    const expr = parseCron("* * * * *")
    const next = nextOccurrence(expr, new Date())
    expect(next.getSeconds()).toBe(0)
    expect(next.getMilliseconds()).toBe(0)
  })
})
