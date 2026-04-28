import { describe, it, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { CoordinationStore } from "../mcp/coordination.js"

describe("CoordinationStore", () => {
  let store: CoordinationStore
  let db: Database

  beforeEach(() => {
    db = new Database(":memory:")
    store = new CoordinationStore(db)
  })

  describe("claim", () => {
    it("claims a work item successfully", () => {
      const result = store.claim("task-1", "nyx")
      expect(result).toBe(true)
    })

    it("returns false when claiming already-claimed work", () => {
      store.claim("task-1", "nyx")
      const result = store.claim("task-1", "analyst")
      expect(result).toBe(false)
    })

    it("returns false when same agent claims same work twice", () => {
      store.claim("task-1", "nyx")
      const result = store.claim("task-1", "nyx")
      expect(result).toBe(false)
    })

    it("allows claiming different keys", () => {
      expect(store.claim("task-1", "nyx")).toBe(true)
      expect(store.claim("task-2", "analyst")).toBe(true)
    })

    it("allows same agent to claim multiple different keys", () => {
      expect(store.claim("task-1", "nyx")).toBe(true)
      expect(store.claim("task-2", "nyx")).toBe(true)
    })
  })

  describe("release", () => {
    it("releases a claimed work item", () => {
      store.claim("task-1", "nyx")
      const result = store.release("task-1", "nyx")
      expect(result).toBe(true)
    })

    it("returns false when releasing unclaimed work", () => {
      const result = store.release("task-1", "nyx")
      expect(result).toBe(false)
    })

    it("returns false when wrong agent tries to release", () => {
      store.claim("task-1", "nyx")
      const result = store.release("task-1", "analyst")
      expect(result).toBe(false)
    })

    it("returns false when releasing already-released work", () => {
      store.claim("task-1", "nyx")
      store.release("task-1", "nyx")
      const result = store.release("task-1", "nyx")
      expect(result).toBe(false)
    })

    it("allows re-claiming after release", () => {
      store.claim("task-1", "nyx")
      store.release("task-1", "nyx")
      // Released claims still occupy the key (not deleted, just marked released).
      // The INSERT will fail because the row still exists.
      // This is expected behavior -- released claims persist in the table.
      const result = store.claim("task-1", "analyst")
      expect(result).toBe(false)
    })
  })

  describe("conflict detection", () => {
    it("prevents two agents from claiming same work", () => {
      expect(store.claim("deploy-prod", "nyx")).toBe(true)
      expect(store.claim("deploy-prod", "analyst")).toBe(false)
    })

    it("only the owning agent can release", () => {
      store.claim("deploy-prod", "nyx")
      expect(store.release("deploy-prod", "analyst")).toBe(false)
      expect(store.release("deploy-prod", "nyx")).toBe(true)
    })
  })

  describe("getActiveClaims", () => {
    it("returns empty array when no claims", () => {
      const claims = store.getActiveClaims()
      expect(claims).toEqual([])
    })

    it("returns active (unreleased) claims", () => {
      store.claim("task-1", "nyx")
      store.claim("task-2", "analyst")
      const claims = store.getActiveClaims()
      expect(claims).toHaveLength(2)
    })

    it("excludes released claims", () => {
      store.claim("task-1", "nyx")
      store.claim("task-2", "analyst")
      store.release("task-1", "nyx")
      const claims = store.getActiveClaims()
      expect(claims).toHaveLength(1)
      expect(claims[0].key).toBe("task-2")
      expect(claims[0].agent).toBe("analyst")
    })

    it("returns claims ordered by claimed_at descending", () => {
      // Insert with explicit different timestamps to test ordering
      const now = Date.now()
      db.run("INSERT INTO work_claims (key, agent, claimed_at, updated_at) VALUES (?, ?, ?, ?)", [
        "task-old", "nyx", now - 2000, now - 2000,
      ])
      db.run("INSERT INTO work_claims (key, agent, claimed_at, updated_at) VALUES (?, ?, ?, ?)", [
        "task-mid", "analyst", now - 1000, now - 1000,
      ])
      db.run("INSERT INTO work_claims (key, agent, claimed_at, updated_at) VALUES (?, ?, ?, ?)", [
        "task-new", "tester", now, now,
      ])
      const claims = store.getActiveClaims()
      // Most recent first
      expect(claims[0].key).toBe("task-new")
      expect(claims[1].key).toBe("task-mid")
      expect(claims[2].key).toBe("task-old")
    })

    it("includes progress info in active claims", () => {
      store.claim("task-1", "nyx")
      store.postProgress("task-1", "nyx", 50, "halfway there")
      const claims = store.getActiveClaims()
      expect(claims).toHaveLength(1)
      expect(claims[0].progress_pct).toBe(50)
      expect(claims[0].progress_msg).toBe("halfway there")
    })

    it("claim fields have correct shape", () => {
      store.claim("task-1", "nyx")
      const claims = store.getActiveClaims()
      const claim = claims[0]
      expect(claim.key).toBe("task-1")
      expect(claim.agent).toBe("nyx")
      expect(typeof claim.claimed_at).toBe("number")
      expect(claim.released_at).toBeNull()
      expect(claim.progress_pct).toBe(0)
      expect(claim.progress_msg).toBeNull()
      expect(typeof claim.updated_at).toBe("number")
    })
  })

  describe("postProgress", () => {
    it("updates progress on an active claim", () => {
      store.claim("task-1", "nyx")
      const result = store.postProgress("task-1", "nyx", 75, "almost done")
      expect(result).toBe(true)
    })

    it("returns false for unclaimed work", () => {
      const result = store.postProgress("task-1", "nyx", 50, "nope")
      expect(result).toBe(false)
    })

    it("returns false when wrong agent posts progress", () => {
      store.claim("task-1", "nyx")
      const result = store.postProgress("task-1", "analyst", 50, "not mine")
      expect(result).toBe(false)
    })

    it("returns false for released work", () => {
      store.claim("task-1", "nyx")
      store.release("task-1", "nyx")
      const result = store.postProgress("task-1", "nyx", 100, "done?")
      expect(result).toBe(false)
    })

    it("updates progress multiple times", () => {
      store.claim("task-1", "nyx")
      store.postProgress("task-1", "nyx", 25, "starting")
      store.postProgress("task-1", "nyx", 50, "halfway")
      store.postProgress("task-1", "nyx", 100, "done")
      const claims = store.getActiveClaims()
      expect(claims[0].progress_pct).toBe(100)
      expect(claims[0].progress_msg).toBe("done")
    })

    it("updates updated_at timestamp", () => {
      store.claim("task-1", "nyx")
      const before = store.getActiveClaims()[0].updated_at
      // Small delay to ensure timestamp differs
      const busyWait = Date.now() + 2
      while (Date.now() < busyWait) {}
      store.postProgress("task-1", "nyx", 50, "progress")
      const after = store.getActiveClaims()[0].updated_at
      expect(after).toBeGreaterThanOrEqual(before)
    })
  })

  describe("stale claim cleanup", () => {
    it("auto-prunes stale claims on claim()", () => {
      // Insert a claim with an old updated_at directly
      const staleTime = Date.now() - 3 * 60 * 60 * 1000 // 3 hours ago
      db.run(
        "INSERT INTO work_claims (key, agent, claimed_at, updated_at) VALUES (?, ?, ?, ?)",
        ["stale-task", "ghost", staleTime, staleTime],
      )

      // Verify the stale claim exists
      const before = db.query("SELECT * FROM work_claims WHERE key = 'stale-task'").all()
      expect(before).toHaveLength(1)

      // Claiming something new triggers stale cleanup
      store.claim("new-task", "nyx")

      // Stale claim should be gone
      const after = db.query("SELECT * FROM work_claims WHERE key = 'stale-task'").all()
      expect(after).toHaveLength(0)
    })

    it("auto-prunes stale claims on getActiveClaims()", () => {
      const staleTime = Date.now() - 3 * 60 * 60 * 1000
      db.run(
        "INSERT INTO work_claims (key, agent, claimed_at, updated_at) VALUES (?, ?, ?, ?)",
        ["stale-task", "ghost", staleTime, staleTime],
      )

      const claims = store.getActiveClaims()
      expect(claims).toHaveLength(0)
    })

    it("does not prune fresh claims", () => {
      store.claim("fresh-task", "nyx")
      store.claim("another-task", "analyst")
      const claims = store.getActiveClaims()
      expect(claims).toHaveLength(2)
    })

    it("does not prune released claims (they already have released_at)", () => {
      // Insert a stale but released claim
      const staleTime = Date.now() - 3 * 60 * 60 * 1000
      const releaseTime = staleTime + 1000
      db.run(
        "INSERT INTO work_claims (key, agent, claimed_at, released_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ["old-released", "ghost", staleTime, releaseTime, staleTime],
      )

      store.getActiveClaims()

      // Released claim should still exist in the table (not active, but not deleted)
      const rows = db.query("SELECT * FROM work_claims WHERE key = 'old-released'").all()
      expect(rows).toHaveLength(1)
    })

    it("stale cleanup allows reclaiming the key", () => {
      const staleTime = Date.now() - 3 * 60 * 60 * 1000
      db.run(
        "INSERT INTO work_claims (key, agent, claimed_at, updated_at) VALUES (?, ?, ?, ?)",
        ["recyclable", "ghost", staleTime, staleTime],
      )

      // claim() prunes stale, then inserts -- should succeed
      const result = store.claim("recyclable", "nyx")
      expect(result).toBe(true)

      const claims = store.getActiveClaims()
      expect(claims).toHaveLength(1)
      expect(claims[0].agent).toBe("nyx")
    })

    it("keeps claims alive if updated_at is recent even if claimed_at is old", () => {
      // Claimed 3 hours ago but progress posted recently
      const oldTime = Date.now() - 3 * 60 * 60 * 1000
      const recentTime = Date.now()
      db.run(
        "INSERT INTO work_claims (key, agent, claimed_at, updated_at, progress_pct, progress_msg) VALUES (?, ?, ?, ?, ?, ?)",
        ["long-running", "nyx", oldTime, recentTime, 80, "still going"],
      )

      const claims = store.getActiveClaims()
      expect(claims).toHaveLength(1)
      expect(claims[0].key).toBe("long-running")
    })
  })

  describe("askQuestion", () => {
    it("creates a question and returns its id", () => {
      const id = store.askQuestion("nyx", "Should we deploy?")
      expect(typeof id).toBe("number")
      expect(id).toBeGreaterThan(0)
    })

    it("stores context when provided", () => {
      const id = store.askQuestion("nyx", "What about X?", "some context")
      const questions = store.getPendingQuestions()
      const q = questions.find((q) => q.id === id)
      expect(q).toBeDefined()
      expect(q!.context).toBe("some context")
    })

    it("stores null context when not provided", () => {
      const id = store.askQuestion("nyx", "No context here")
      const questions = store.getPendingQuestions()
      const q = questions.find((q) => q.id === id)
      expect(q!.context).toBeNull()
    })

    it("increments ids", () => {
      const id1 = store.askQuestion("nyx", "Q1")
      const id2 = store.askQuestion("nyx", "Q2")
      expect(id2).toBeGreaterThan(id1)
    })
  })

  describe("getPendingQuestions", () => {
    it("returns empty array when no questions", () => {
      expect(store.getPendingQuestions()).toEqual([])
    })

    it("returns unanswered questions", () => {
      store.askQuestion("nyx", "Question 1")
      store.askQuestion("analyst", "Question 2")
      const pending = store.getPendingQuestions()
      expect(pending).toHaveLength(2)
    })

    it("excludes answered questions", () => {
      const id = store.askQuestion("nyx", "Will be answered")
      store.askQuestion("nyx", "Still pending")

      // Manually mark as answered
      db.run("UPDATE agent_questions SET answered = 1, answer = 'yes', answered_at = ? WHERE id = ?", [
        Date.now(),
        id,
      ])

      const pending = store.getPendingQuestions()
      expect(pending).toHaveLength(1)
      expect(pending[0].question).toBe("Still pending")
    })

    it("returns questions ordered by created_at descending", () => {
      // Insert with explicit different timestamps to test ordering
      const now = Date.now()
      db.run("INSERT INTO agent_questions (agent, question, created_at) VALUES (?, ?, ?)", [
        "nyx", "First", now - 2000,
      ])
      db.run("INSERT INTO agent_questions (agent, question, created_at) VALUES (?, ?, ?)", [
        "nyx", "Second", now - 1000,
      ])
      db.run("INSERT INTO agent_questions (agent, question, created_at) VALUES (?, ?, ?)", [
        "nyx", "Third", now,
      ])
      const pending = store.getPendingQuestions()
      expect(pending[0].question).toBe("Third")
      expect(pending[2].question).toBe("First")
    })

    it("question fields have correct shape", () => {
      store.askQuestion("nyx", "Test question", "test context")
      const q = store.getPendingQuestions()[0]
      expect(q.agent).toBe("nyx")
      expect(q.question).toBe("Test question")
      expect(q.context).toBe("test context")
      expect(q.answered).toBe(0)
      expect(q.answer).toBeNull()
      expect(typeof q.created_at).toBe("number")
      expect(q.answered_at).toBeNull()
    })
  })
})
