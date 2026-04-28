import { describe, it, expect } from "bun:test"
import { formatScoutReport } from "../learning/analysis.js"
import type { ScoutReport, ScoutTypeStats } from "../learning/analysis.js"

function makeReport(overrides: Partial<ScoutReport> = {}): ScoutReport {
  return {
    period: "2026-W10",
    since: Date.now() - 7 * 24 * 60 * 60 * 1000,
    until: Date.now(),
    stats: [],
    totalProposed: 0,
    totalApproved: 0,
    totalRejected: 0,
    overallAcceptanceRate: 0,
    ...overrides,
  }
}

function makeStat(overrides: Partial<ScoutTypeStats> = {}): ScoutTypeStats {
  return {
    scoutSource: "test-scout",
    total: 10,
    approved: 5,
    rejected: 3,
    expired: 1,
    autoExecuted: 2,
    pending: 1,
    acceptanceRate: 63,
    ...overrides,
  }
}

describe("formatScoutReport", () => {
  it("includes period in header", () => {
    const md = formatScoutReport(makeReport({ period: "2026-W10" }))
    expect(md).toContain("# Weekly Scout Report (2026-W10)")
  })

  it("shows 'No proposals' when stats empty", () => {
    const md = formatScoutReport(makeReport({ stats: [] }))
    expect(md).toContain("No proposals in this period.")
  })

  it("shows per-source breakdown", () => {
    const md = formatScoutReport(makeReport({
      stats: [makeStat({ scoutSource: "code-quality", total: 5, approved: 3, rejected: 1, acceptanceRate: 75 })],
      totalProposed: 5,
      totalApproved: 3,
      totalRejected: 1,
      overallAcceptanceRate: 75,
    }))
    expect(md).toContain("**code-quality:**")
    expect(md).toContain("5 proposed")
    expect(md).toContain("3 approved")
    expect(md).toContain("1 rejected")
    expect(md).toContain("75%")
  })

  it("includes expired count when > 0", () => {
    const md = formatScoutReport(makeReport({
      stats: [makeStat({ expired: 2 })],
      totalProposed: 10,
    }))
    expect(md).toContain("2 expired")
  })

  it("omits expired when 0", () => {
    const md = formatScoutReport(makeReport({
      stats: [makeStat({ expired: 0 })],
      totalProposed: 10,
    }))
    expect(md).not.toContain("expired")
  })

  it("includes pending count when > 0", () => {
    const md = formatScoutReport(makeReport({
      stats: [makeStat({ pending: 3 })],
      totalProposed: 10,
    }))
    expect(md).toContain("3 pending")
  })

  it("includes auto-executed count when > 0", () => {
    const md = formatScoutReport(makeReport({
      stats: [makeStat({ autoExecuted: 4 })],
      totalProposed: 10,
    }))
    expect(md).toContain("4 auto-executed")
  })

  it("shows total line", () => {
    const md = formatScoutReport(makeReport({
      stats: [makeStat()],
      totalProposed: 10,
      totalApproved: 5,
      totalRejected: 3,
      overallAcceptanceRate: 63,
    }))
    expect(md).toContain("**Total:** 10 proposed, 5 approved, 3 rejected")
    expect(md).toContain("63% acceptance")
  })

  it("handles multiple sources", () => {
    const md = formatScoutReport(makeReport({
      stats: [
        makeStat({ scoutSource: "alpha" }),
        makeStat({ scoutSource: "beta" }),
      ],
      totalProposed: 20,
    }))
    expect(md).toContain("**alpha:**")
    expect(md).toContain("**beta:**")
  })
})
