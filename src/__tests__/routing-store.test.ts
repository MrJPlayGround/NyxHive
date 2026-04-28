import { describe, it, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { RoutingStore } from "../memory/routing.js"
import { getSelfHandlingNudge } from "../queue/delegation-executor.js"

describe("RoutingStore", () => {
  let store: RoutingStore
  let db: Database

  beforeEach(() => {
    db = new Database(":memory:")
    store = new RoutingStore(db)
  })

  describe("logDecision", () => {
    it("logs a routing decision and returns an id", () => {
      const id = store.logDecision({
        traceId: "trace-1",
        fromAgent: "nyx",
        toAgent: "analyst",
        taskType: "analysis",
        taskExcerpt: "research caching strategies",
      })
      expect(id).toBeGreaterThan(0)
    })

    it("stores all fields correctly", () => {
      const id = store.logDecision({
        traceId: "trace-1",
        fromAgent: "nyx",
        toAgent: "tester",
        taskType: "code-change",
        taskExcerpt: "write tests for auth module",
        modelUsed: "claude-sonnet-4-6",
      })
      const record = store.getById(id)
      expect(record).not.toBeNull()
      expect(record!.trace_id).toBe("trace-1")
      expect(record!.from_agent).toBe("nyx")
      expect(record!.to_agent).toBe("tester")
      expect(record!.task_type).toBe("code-change")
      expect(record!.task_excerpt).toBe("write tests for auth module")
      expect(record!.model_used).toBe("claude-sonnet-4-6")
      expect(record!.outcome).toBeNull()
      expect(record!.resolved_at).toBeNull()
    })

    it("truncates task excerpt to 500 chars", () => {
      const longExcerpt = "x".repeat(600)
      const id = store.logDecision({
        traceId: "t",
        fromAgent: "a",
        toAgent: "b",
        taskType: "t",
        taskExcerpt: longExcerpt,
      })
      const record = store.getById(id)
      expect(record!.task_excerpt.length).toBe(500)
    })
  })

  describe("resolveDecision", () => {
    it("links outcome to decision by id", () => {
      const id = store.logDecision({
        traceId: "trace-1",
        fromAgent: "nyx",
        toAgent: "analyst",
        taskType: "analysis",
        taskExcerpt: "task",
      })

      store.resolveDecision(id, "success", 15.5, 30000)

      const record = store.getById(id)
      expect(record!.outcome).toBe("success")
      expect(record!.cost_cents).toBe(15.5)
      expect(record!.duration_ms).toBe(30000)
      expect(record!.resolved_at).not.toBeNull()
    })

    it("handles failed outcomes", () => {
      const id = store.logDecision({
        traceId: "trace-1",
        fromAgent: "nyx",
        toAgent: "tester",
        taskType: "code-change",
        taskExcerpt: "task",
      })

      store.resolveDecision(id, "failed", 5.0, 10000)

      const record = store.getById(id)
      expect(record!.outcome).toBe("failed")
    })
  })

  describe("resolveByTrace", () => {
    it("resolves by trace ID and agent name", () => {
      store.logDecision({
        traceId: "trace-abc",
        fromAgent: "nyx",
        toAgent: "analyst",
        taskType: "analysis",
        taskExcerpt: "task",
      })

      store.resolveByTrace("trace-abc", "analyst", "success", 10, 5000)

      const recent = store.getRecent(1)
      expect(recent[0].outcome).toBe("success")
    })

    it("only resolves unresolved decisions", () => {
      const id = store.logDecision({
        traceId: "trace-abc",
        fromAgent: "nyx",
        toAgent: "analyst",
        taskType: "analysis",
        taskExcerpt: "task",
      })

      store.resolveDecision(id, "success", 10, 5000)
      store.resolveByTrace("trace-abc", "analyst", "failed") // should not override

      const record = store.getById(id)
      expect(record!.outcome).toBe("success") // still success
    })
  })

  describe("getRecent", () => {
    it("returns recent decisions in reverse chronological order", () => {
      store.logDecision({ traceId: "t1", fromAgent: "nyx", toAgent: "a", taskType: "t", taskExcerpt: "first" })
      store.logDecision({ traceId: "t2", fromAgent: "nyx", toAgent: "b", taskType: "t", taskExcerpt: "second" })

      const recent = store.getRecent(10)
      expect(recent).toHaveLength(2)
      expect(recent[0].task_excerpt).toBe("second")
      expect(recent[1].task_excerpt).toBe("first")
    })

    it("respects limit", () => {
      for (let i = 0; i < 5; i++) {
        store.logDecision({ traceId: `t${i}`, fromAgent: "nyx", toAgent: "a", taskType: "t", taskExcerpt: `task-${i}` })
      }
      expect(store.getRecent(3)).toHaveLength(3)
    })
  })

  describe("getSkillMatrix", () => {
    function seedDecisions() {
      // Analyst: 3 analysis tasks (2 success, 1 failed)
      for (let i = 0; i < 3; i++) {
        const id = store.logDecision({
          traceId: `t-analyst-${i}`,
          fromAgent: "nyx",
          toAgent: "analyst",
          taskType: "analysis",
          taskExcerpt: `analysis task ${i}`,
        })
        store.resolveDecision(id, i < 2 ? "success" : "failed", 5, 10000)
      }

      // Tester: 4 code-change tasks (4 success)
      for (let i = 0; i < 4; i++) {
        const id = store.logDecision({
          traceId: `t-tester-${i}`,
          fromAgent: "nyx",
          toAgent: "tester",
          taskType: "code-change",
          taskExcerpt: `test task ${i}`,
        })
        store.resolveDecision(id, "success", 10, 20000)
      }

      // Single unresolved decision (should not appear in matrix)
      store.logDecision({
        traceId: "t-pending",
        fromAgent: "nyx",
        toAgent: "analyst",
        taskType: "review",
        taskExcerpt: "pending review",
      })
    }

    it("returns (agent, task_type) aggregates", () => {
      seedDecisions()
      const matrix = store.getSkillMatrix(30, 2)
      expect(matrix.length).toBeGreaterThanOrEqual(2)

      const testerCode = matrix.find(e => e.agent === "tester" && e.task_type === "code-change")
      expect(testerCode).toBeDefined()
      expect(testerCode!.total).toBe(4)
      expect(testerCode!.success).toBe(4)
      expect(testerCode!.success_rate).toBe(100)

      const analystAnalysis = matrix.find(e => e.agent === "analyst" && e.task_type === "analysis")
      expect(analystAnalysis).toBeDefined()
      expect(analystAnalysis!.total).toBe(3)
      expect(analystAnalysis!.success).toBe(2)
      expect(analystAnalysis!.failed).toBe(1)
    })

    it("respects minTrials filter", () => {
      seedDecisions()
      // With minTrials=5, nothing should qualify
      const matrix = store.getSkillMatrix(30, 5)
      expect(matrix).toHaveLength(0)
    })

    it("excludes unresolved decisions", () => {
      seedDecisions()
      const matrix = store.getSkillMatrix(30, 1)
      const pendingReview = matrix.find(e => e.agent === "analyst" && e.task_type === "review")
      expect(pendingReview).toBeUndefined()
    })
  })

  describe("getBestAgentForTaskType", () => {
    it("returns best agent for a task type", () => {
      // Analyst: 3 analysis tasks, 100% success
      for (let i = 0; i < 3; i++) {
        const id = store.logDecision({
          traceId: `t${i}`,
          fromAgent: "nyx",
          toAgent: "analyst",
          taskType: "analysis",
          taskExcerpt: "task",
        })
        store.resolveDecision(id, "success", 5, 10000)
      }

      // Tester: 3 analysis tasks, 33% success
      for (let i = 0; i < 3; i++) {
        const id = store.logDecision({
          traceId: `tt${i}`,
          fromAgent: "nyx",
          toAgent: "tester",
          taskType: "analysis",
          taskExcerpt: "task",
        })
        store.resolveDecision(id, i === 0 ? "success" : "failed", 5, 10000)
      }

      const best = store.getBestAgentForTaskType("analysis")
      expect(best).not.toBeNull()
      expect(best!.agent).toBe("analyst")
      expect(best!.success_rate).toBe(100)
    })

    it("returns null when no data exists", () => {
      expect(store.getBestAgentForTaskType("nonexistent")).toBeNull()
    })

    it("returns null when not enough trials", () => {
      const id = store.logDecision({
        traceId: "t1",
        fromAgent: "nyx",
        toAgent: "analyst",
        taskType: "analysis",
        taskExcerpt: "task",
      })
      store.resolveDecision(id, "success")
      // Default minTrials is 3, we only have 1
      expect(store.getBestAgentForTaskType("analysis")).toBeNull()
    })
  })

  describe("getSuggestions", () => {
    const seedWithCostDuration = (
      agent: string,
      taskType: string,
      successes: number,
      failures: number,
      costCents: number,
      durationMs: number,
    ) => {
      for (let i = 0; i < successes; i++) {
        const id = store.logDecision({
          traceId: `t-${agent}-${taskType}-s${i}`,
          fromAgent: "nyx",
          toAgent: agent,
          taskType,
          taskExcerpt: "task",
        })
        store.resolveDecision(id, "success", costCents, durationMs)
      }
      for (let i = 0; i < failures; i++) {
        const id = store.logDecision({
          traceId: `t-${agent}-${taskType}-f${i}`,
          fromAgent: "nyx",
          toAgent: agent,
          taskType,
          taskExcerpt: "task",
        })
        store.resolveDecision(id, "failed", costCents, durationMs)
      }
    }

    it("returns best agent per task type", () => {
      seedWithCostDuration("analyst", "analysis", 5, 0, 10, 10000)   // 100%
      seedWithCostDuration("tester", "analysis", 2, 3, 10, 10000)     // 40%
      seedWithCostDuration("tester", "code-change", 4, 1, 10, 10000)  // 80%

      const suggestions = store.getSuggestions(30, 3)
      expect(suggestions.length).toBeGreaterThanOrEqual(2)

      const analysisSuggestion = suggestions.find(s => s.task_type === "analysis")
      expect(analysisSuggestion!.agent).toBe("analyst")

      const codeSuggestion = suggestions.find(s => s.task_type === "code-change")
      expect(codeSuggestion!.agent).toBe("tester")
    })

    it("uses composite score — cheap agent can beat expensive one", () => {
      // Agent A: 95% success but expensive and slow
      // 19 success + 1 failed = 95%, cost=50, duration=60000
      for (let i = 0; i < 19; i++) {
        const id = store.logDecision({
          traceId: `t-agentA-analysis-s${i}`,
          fromAgent: "nyx",
          toAgent: "agentA",
          taskType: "analysis",
          taskExcerpt: "task",
        })
        store.resolveDecision(id, "success", 50, 60000)
      }
      const idF = store.logDecision({
        traceId: "t-agentA-analysis-f0",
        fromAgent: "nyx",
        toAgent: "agentA",
        taskType: "analysis",
        taskExcerpt: "task",
      })
      store.resolveDecision(idF, "failed", 50, 60000)

      // Agent B: 85% success but cheap and fast
      // 17 success + 3 failed = 85%, cost=2, duration=5000
      for (let i = 0; i < 17; i++) {
        const id = store.logDecision({
          traceId: `t-agentB-analysis-s${i}`,
          fromAgent: "nyx",
          toAgent: "agentB",
          taskType: "analysis",
          taskExcerpt: "task",
        })
        store.resolveDecision(id, "success", 2, 5000)
      }
      for (let i = 0; i < 3; i++) {
        const id = store.logDecision({
          traceId: `t-agentB-analysis-f${i}`,
          fromAgent: "nyx",
          toAgent: "agentB",
          taskType: "analysis",
          taskExcerpt: "task",
        })
        store.resolveDecision(id, "failed", 2, 5000)
      }

      const suggestions = store.getSuggestions(30, 3)
      const analysis = suggestions.find(s => s.task_type === "analysis")
      expect(analysis).toBeDefined()
      // Agent B should win: 85*0.6 + 100*0.25 + 100*0.15 = 51+25+15 = 91
      // Agent A:            95*0.6 + 0*0.25   + 0*0.15   = 57+0+0   = 57
      expect(analysis!.agent).toBe("agentB")
    })

    it("composite_score is present and is a number", () => {
      seedWithCostDuration("analyst", "analysis", 5, 0, 10, 10000)

      const suggestions = store.getSuggestions(30, 3)
      expect(suggestions.length).toBeGreaterThanOrEqual(1)
      for (const s of suggestions) {
        expect(typeof s.composite_score).toBe("number")
        expect(Number.isNaN(s.composite_score)).toBe(false)
      }
    })

    it("single agent per task_type gets max efficiency scores", () => {
      seedWithCostDuration("analyst", "analysis", 5, 0, 10, 10000)

      const suggestions = store.getSuggestions(30, 3)
      const analysis = suggestions.find(s => s.task_type === "analysis")
      expect(analysis).toBeDefined()
      // Single agent: costRank=0, speedRank=0 → costEfficiency=100, speedFactor=100
      // score = 100*0.6 + 100*0.25 + 100*0.15 = 60+25+15 = 100
      expect(analysis!.composite_score).toBe(100)
    })

    it("handles agents with zero cost and duration", () => {
      seedWithCostDuration("analyst", "analysis", 5, 0, 0, 0)
      seedWithCostDuration("tester", "analysis", 4, 1, 0, 0)

      const suggestions = store.getSuggestions(30, 3)
      expect(suggestions.length).toBeGreaterThanOrEqual(1)
      for (const s of suggestions) {
        expect(Number.isNaN(s.composite_score)).toBe(false)
        expect(Number.isFinite(s.composite_score)).toBe(true)
      }
    })
  })

  describe("formatForInjection", () => {
    it("returns null when no data", () => {
      expect(store.formatForInjection()).toBeNull()
    })

    it("formats routing intelligence for system prompt", () => {
      // Seed enough data
      for (let i = 0; i < 5; i++) {
        const id = store.logDecision({
          traceId: `t${i}`,
          fromAgent: "nyx",
          toAgent: "analyst",
          taskType: "analysis",
          taskExcerpt: "task",
        })
        store.resolveDecision(id, "success", 5, 10000)
      }

      const text = store.formatForInjection(30, 3)
      expect(text).not.toBeNull()
      expect(text).toContain("## Agent Routing Intelligence")
      expect(text).toContain("@analyst")
      expect(text).toContain("analysis")
      expect(text).toContain("100%")
    })

    it("includes cost and duration in formatted output", () => {
      for (let i = 0; i < 5; i++) {
        const id = store.logDecision({
          traceId: `t-fmt-${i}`,
          fromAgent: "nyx",
          toAgent: "analyst",
          taskType: "analysis",
          taskExcerpt: "task",
        })
        store.resolveDecision(id, "success", 8.5, 15000)
      }

      const text = store.formatForInjection(30, 3)
      expect(text).not.toBeNull()
      expect(text).toContain("c/task")
      expect(text).toContain("s avg")
    })

    it("flags underperforming agent-task pairs", () => {
      // Seed a low-performing pair
      for (let i = 0; i < 5; i++) {
        const id = store.logDecision({
          traceId: `t${i}`,
          fromAgent: "nyx",
          toAgent: "tester",
          taskType: "analysis",
          taskExcerpt: "task",
        })
        store.resolveDecision(id, i < 1 ? "success" : "failed", 5, 10000)
      }

      const text = store.formatForInjection(30, 3)
      expect(text).toContain("Watch out")
      expect(text).toContain("@tester")
      expect(text).toContain("struggles")
    })
  })

  describe("getStale", () => {
    it("returns unresolved decisions older than threshold", () => {
      store.logDecision({
        traceId: "t1",
        fromAgent: "nyx",
        toAgent: "analyst",
        taskType: "analysis",
        taskExcerpt: "task",
      })
      // Since we just created it, it's not stale yet (< 60 min)
      expect(store.getStale(60)).toHaveLength(0)
      // Backdate to make it stale
      db.run("UPDATE routing_decisions SET created_at = datetime('now', '-2 hours')")
      expect(store.getStale(60)).toHaveLength(1)
    })

    it("excludes resolved decisions", () => {
      const id = store.logDecision({
        traceId: "t1",
        fromAgent: "nyx",
        toAgent: "analyst",
        taskType: "analysis",
        taskExcerpt: "task",
      })
      store.resolveDecision(id, "success")
      expect(store.getStale(0)).toHaveLength(0)
    })
  })

  describe("prune", () => {
    it("removes old resolved decisions", () => {
      const id = store.logDecision({
        traceId: "t1",
        fromAgent: "nyx",
        toAgent: "analyst",
        taskType: "analysis",
        taskExcerpt: "task",
      })
      store.resolveDecision(id, "success")

      // Won't prune recent decisions
      expect(store.prune(90)).toBe(0)

      // Force old timestamp for testing
      db.run("UPDATE routing_decisions SET created_at = datetime('now', '-100 days') WHERE id = ?", [id])
      expect(store.prune(90)).toBe(1)
    })

    it("keeps unresolved decisions regardless of age", () => {
      store.logDecision({
        traceId: "t1",
        fromAgent: "nyx",
        toAgent: "analyst",
        taskType: "analysis",
        taskExcerpt: "task",
      })
      db.run("UPDATE routing_decisions SET created_at = datetime('now', '-200 days')")
      expect(store.prune(1)).toBe(0) // unresolved = not pruned
    })
  })

  describe("logReviewOutcome", () => {
    it("stores review result on routing decision", () => {
      const id = store.logDecision({
        traceId: "trace-review-1",
        fromAgent: "nyx",
        toAgent: "tester",
        taskType: "code-change",
        taskExcerpt: "implement feature",
      })
      store.resolveDecision(id, "success", 10, 5000)
      store.logReviewOutcome("trace-review-1", "pass")

      const row = db.prepare("SELECT review_outcome FROM routing_decisions WHERE id = ?").get(id) as { review_outcome: string }
      expect(row.review_outcome).toBe("pass")
    })

    it("getSkillMatrix includes review_pass_rate", () => {
      // 3 decisions: 2 pass + 1 warn
      for (let i = 0; i < 3; i++) {
        const id = store.logDecision({
          traceId: `trace-rev-${i}`,
          fromAgent: "nyx",
          toAgent: "coder",
          taskType: "code-change",
          taskExcerpt: `task ${i}`,
        })
        store.resolveDecision(id, "success", 5, 10000)
        store.logReviewOutcome(`trace-rev-${i}`, i < 2 ? "pass" : "warn")
      }

      const matrix = store.getSkillMatrix(30, 2)
      const entry = matrix.find(e => e.agent === "coder" && e.task_type === "code-change")
      expect(entry).toBeDefined()
      expect(entry!.review_pass_rate).toBeCloseTo(66.7, 0)
    })

    it("review_pass_rate is null when no review outcomes exist", () => {
      for (let i = 0; i < 3; i++) {
        const id = store.logDecision({
          traceId: `trace-norev-${i}`,
          fromAgent: "nyx",
          toAgent: "analyst",
          taskType: "analysis",
          taskExcerpt: `task ${i}`,
        })
        store.resolveDecision(id, "success", 5, 10000)
      }

      const matrix = store.getSkillMatrix(30, 2)
      const entry = matrix.find(e => e.agent === "analyst" && e.task_type === "analysis")
      expect(entry).toBeDefined()
      expect(entry!.review_pass_rate).toBeNull()
    })

    it("formatForInjection includes clean reviews percentage", () => {
      for (let i = 0; i < 5; i++) {
        const id = store.logDecision({
          traceId: `trace-fmt-rev-${i}`,
          fromAgent: "nyx",
          toAgent: "coder",
          taskType: "code-change",
          taskExcerpt: "task",
        })
        store.resolveDecision(id, "success", 5, 10000)
        store.logReviewOutcome(`trace-fmt-rev-${i}`, "pass")
      }

      const text = store.formatForInjection(30, 3)
      expect(text).not.toBeNull()
      expect(text).toContain("clean reviews")
    })

    it("flags low review pass rate in warnings", () => {
      // 5 decisions, all succeed, but only 1 out of 5 passes review (20%)
      for (let i = 0; i < 5; i++) {
        const id = store.logDecision({
          traceId: `trace-lowrev-${i}`,
          fromAgent: "nyx",
          toAgent: "sloppy",
          taskType: "code-change",
          taskExcerpt: "task",
        })
        store.resolveDecision(id, "success", 5, 10000)
        store.logReviewOutcome(`trace-lowrev-${i}`, i === 0 ? "pass" : "fail")
      }

      const text = store.formatForInjection(30, 3)
      expect(text).not.toBeNull()
      expect(text).toContain("Watch out")
      expect(text).toContain("@sloppy")
      expect(text).toContain("low review quality")
    })

    it("formatForInjection omits review info when no reviews", () => {
      for (let i = 0; i < 5; i++) {
        const id = store.logDecision({
          traceId: `trace-fmt-norev-${i}`,
          fromAgent: "nyx",
          toAgent: "analyst",
          taskType: "analysis",
          taskExcerpt: "task",
        })
        store.resolveDecision(id, "success", 5, 10000)
      }

      const text = store.formatForInjection(30, 3)
      expect(text).not.toBeNull()
      expect(text).not.toContain("clean reviews")
    })
  })

  describe("getAgentSuccessRate", () => {
    it("returns rate for agent with enough trials", () => {
      // 5 decisions: 4 success + 1 failed = 80%
      for (let i = 0; i < 5; i++) {
        const id = store.logDecision({
          traceId: `t-rate-${i}`,
          fromAgent: "nyx",
          toAgent: "coder",
          taskType: "code-change",
          taskExcerpt: `task ${i}`,
        })
        store.resolveDecision(id, i < 4 ? "success" : "failed", 5, 10000)
      }

      const rate = store.getAgentSuccessRate("coder", "code-change")
      expect(rate).toBe(80)
    })

    it("returns null when fewer than 2 trials", () => {
      const id = store.logDecision({
        traceId: "t-single",
        fromAgent: "nyx",
        toAgent: "coder",
        taskType: "code-change",
        taskExcerpt: "only task",
      })
      store.resolveDecision(id, "success", 5, 10000)

      const rate = store.getAgentSuccessRate("coder", "code-change")
      expect(rate).toBeNull()
    })

    it("returns null for unknown agent/task", () => {
      const rate = store.getAgentSuccessRate("nonexistent", "unknown-type")
      expect(rate).toBeNull()
    })

    it("excludes unresolved decisions", () => {
      // 2 resolved success + 1 unresolved
      for (let i = 0; i < 2; i++) {
        const id = store.logDecision({
          traceId: `t-resolved-${i}`,
          fromAgent: "nyx",
          toAgent: "coder",
          taskType: "code-change",
          taskExcerpt: `task ${i}`,
        })
        store.resolveDecision(id, "success", 5, 10000)
      }
      store.logDecision({
        traceId: "t-unresolved",
        fromAgent: "nyx",
        toAgent: "coder",
        taskType: "code-change",
        taskExcerpt: "pending task",
      })

      const rate = store.getAgentSuccessRate("coder", "code-change")
      expect(rate).toBe(100) // only resolved ones count
    })

    it("respects sinceDays parameter", () => {
      for (let i = 0; i < 3; i++) {
        const id = store.logDecision({
          traceId: `t-old-${i}`,
          fromAgent: "nyx",
          toAgent: "coder",
          taskType: "code-change",
          taskExcerpt: `old task ${i}`,
        })
        store.resolveDecision(id, "success", 5, 10000)
      }
      // Backdate all to 60 days ago
      db.run("UPDATE routing_decisions SET created_at = datetime('now', '-60 days')")

      // Within 30 days: no data
      expect(store.getAgentSuccessRate("coder", "code-change", 30)).toBeNull()
      // Within 90 days: data present
      expect(store.getAgentSuccessRate("coder", "code-change", 90)).toBe(100)
    })
  })

  describe("getSelfHandlingNudge", () => {
    it("returns nudge for simple task with high success rate", () => {
      // Seed 5 decisions: 5 success = 100%
      for (let i = 0; i < 5; i++) {
        const id = store.logDecision({
          traceId: `t-nudge-${i}`,
          fromAgent: "nyx",
          toAgent: "nyx",
          taskType: "code-change",
          taskExcerpt: `task ${i}`,
        })
        store.resolveDecision(id, "success", 5, 10000)
      }

      const nudge = getSelfHandlingNudge(store, "nyx", "code-change", "Fix the typo in routing.ts")
      expect(nudge).not.toBeNull()
      expect(nudge).toContain("100%")
      expect(nudge).toContain("code-change")
      expect(nudge).toContain("Consider handling this directly")
    })

    it("returns null for complex tasks (> 200 chars)", () => {
      for (let i = 0; i < 5; i++) {
        const id = store.logDecision({
          traceId: `t-long-${i}`,
          fromAgent: "nyx",
          toAgent: "nyx",
          taskType: "code-change",
          taskExcerpt: `task ${i}`,
        })
        store.resolveDecision(id, "success", 5, 10000)
      }

      const longTask = "a".repeat(201)
      const nudge = getSelfHandlingNudge(store, "nyx", "code-change", longTask)
      expect(nudge).toBeNull()
    })

    it("returns null for tasks with many file refs (3+)", () => {
      for (let i = 0; i < 5; i++) {
        const id = store.logDecision({
          traceId: `t-files-${i}`,
          fromAgent: "nyx",
          toAgent: "nyx",
          taskType: "code-change",
          taskExcerpt: `task ${i}`,
        })
        store.resolveDecision(id, "success", 5, 10000)
      }

      const taskWith3Files = "Update routing.ts, processor.ts, and delegation.ts"
      const nudge = getSelfHandlingNudge(store, "nyx", "code-change", taskWith3Files)
      expect(nudge).toBeNull()
    })

    it("returns null when success rate < 80%", () => {
      // 3 success + 2 failed = 60%
      for (let i = 0; i < 5; i++) {
        const id = store.logDecision({
          traceId: `t-low-${i}`,
          fromAgent: "nyx",
          toAgent: "nyx",
          taskType: "code-change",
          taskExcerpt: `task ${i}`,
        })
        store.resolveDecision(id, i < 3 ? "success" : "failed", 5, 10000)
      }

      const nudge = getSelfHandlingNudge(store, "nyx", "code-change", "Fix the typo in routing.ts")
      expect(nudge).toBeNull()
    })

    it("returns null when no routing data exists", () => {
      const nudge = getSelfHandlingNudge(store, "nyx", "code-change", "Fix the typo")
      expect(nudge).toBeNull()
    })

    it("allows tasks with 1-2 file refs", () => {
      for (let i = 0; i < 5; i++) {
        const id = store.logDecision({
          traceId: `t-2files-${i}`,
          fromAgent: "nyx",
          toAgent: "nyx",
          taskType: "code-change",
          taskExcerpt: `task ${i}`,
        })
        store.resolveDecision(id, "success", 5, 10000)
      }

      const taskWith2Files = "Update routing.ts and processor.ts"
      const nudge = getSelfHandlingNudge(store, "nyx", "code-change", taskWith2Files)
      expect(nudge).not.toBeNull()
    })

    it("returns nudge at exactly 80% success rate", () => {
      // 4 success + 1 failed = 80%
      for (let i = 0; i < 5; i++) {
        const id = store.logDecision({
          traceId: `t-80-${i}`,
          fromAgent: "nyx",
          toAgent: "nyx",
          taskType: "analysis",
          taskExcerpt: `task ${i}`,
        })
        store.resolveDecision(id, i < 4 ? "success" : "failed", 5, 10000)
      }

      const nudge = getSelfHandlingNudge(store, "nyx", "analysis", "Quick analysis task")
      expect(nudge).not.toBeNull()
      expect(nudge).toContain("80%")
    })
  })
})
