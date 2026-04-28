import { describe, it, expect } from "bun:test"
import { extractContractHeuristic, extractContracts } from "../agents/contract-extractor.js"
import type { ActorMention } from "../types.js"

function mention(task: string, agent = "test-agent"): ActorMention {
  return { agent, task }
}

describe("extractContractHeuristic", () => {
  describe("metadata", () => {
    it("preserves task and agent", () => {
      const contract = extractContractHeuristic(mention("do something", "nyx"))
      expect(contract.task).toBe("do something")
      expect(contract.agent).toBe("nyx")
    })

    it("sets extraction method to heuristic", () => {
      const contract = extractContractHeuristic(mention("do something"))
      expect(contract.extractionMethod).toBe("heuristic")
    })

    it("sets empty dependsOn", () => {
      const contract = extractContractHeuristic(mention("do something"))
      expect(contract.dependsOn).toEqual([])
    })
  })

  describe("output files", () => {
    it("extracts 'write to <path>'", () => {
      const contract = extractContractHeuristic(mention("write to /tmp/output.json"))
      expect(contract.outputFiles).toContain("/tmp/output.json")
    })

    it("extracts 'save to <path>'", () => {
      const contract = extractContractHeuristic(mention("save to results.csv"))
      expect(contract.outputFiles).toContain("results.csv")
    })

    it("extracts 'output to <path>'", () => {
      const contract = extractContractHeuristic(mention("output to /data/report.md"))
      expect(contract.outputFiles).toContain("/data/report.md")
    })

    it("extracts 'create <path>'", () => {
      const contract = extractContractHeuristic(mention("create /src/utils/helper.ts"))
      expect(contract.outputFiles).toContain("/src/utils/helper.ts")
    })

    it("extracts 'generate file at <path>'", () => {
      const contract = extractContractHeuristic(mention("generate file at /docs/api.md"))
      expect(contract.outputFiles).toContain("/docs/api.md")
    })
  })

  describe("exclude files", () => {
    it("extracts 'don't touch <path>'", () => {
      const contract = extractContractHeuristic(mention("fix the auth but don't touch config.ts"))
      expect(contract.excludeFiles).toContain("config.ts")
    })

    it("extracts 'do not modify <path>'", () => {
      const contract = extractContractHeuristic(mention("do not modify schema.sql"))
      expect(contract.excludeFiles).toContain("schema.sql")
    })

    it("extracts 'leave <path> alone'", () => {
      const contract = extractContractHeuristic(mention("leave index.ts alone"))
      expect(contract.excludeFiles).toContain("index.ts")
    })

    it("extracts 'except <path>'", () => {
      const contract = extractContractHeuristic(mention("refactor everything except types.ts"))
      expect(contract.excludeFiles).toContain("types.ts")
    })

    it("extracts 'excluding <path>'", () => {
      const contract = extractContractHeuristic(mention("update all files excluding test.ts"))
      expect(contract.excludeFiles).toContain("test.ts")
    })
  })

  describe("constraints", () => {
    it("extracts 'don't add' constraints", () => {
      const contract = extractContractHeuristic(mention("don't add any new npm dependencies"))
      expect(contract.constraints.length).toBeGreaterThan(0)
    })

    it("extracts 'keep backward compatible'", () => {
      const contract = extractContractHeuristic(mention("must be backward compatible with v1"))
      expect(contract.constraints.length).toBeGreaterThan(0)
    })

    it("extracts 'use existing' constraints", () => {
      const contract = extractContractHeuristic(mention("use existing SQLite database"))
      expect(contract.constraints.length).toBeGreaterThan(0)
    })

    it("extracts 'no new dependencies'", () => {
      const contract = extractContractHeuristic(mention("no new dependencies needed"))
      expect(contract.constraints.length).toBeGreaterThan(0)
    })

    it("extracts 'without' constraints", () => {
      const contract = extractContractHeuristic(mention("implement without breaking the API"))
      expect(contract.constraints.length).toBeGreaterThan(0)
    })
  })

  describe("verification", () => {
    it("extracts 'run bun test'", () => {
      const contract = extractContractHeuristic(mention("fix the bug. run bun test"))
      expect(contract.verification.some(v => v.includes("bun test"))).toBe(true)
    })

    it("extracts 'run npm test'", () => {
      const contract = extractContractHeuristic(mention("update the module. run npm test"))
      expect(contract.verification.some(v => v.includes("npm test"))).toBe(true)
    })
  })

  describe("success criteria", () => {
    it("extracts 'should' assertions", () => {
      const contract = extractContractHeuristic(mention("it should handle reconnection gracefully"))
      expect(contract.successCriteria.length).toBeGreaterThan(0)
    })

    it("extracts 'so that' outcomes", () => {
      const contract = extractContractHeuristic(mention("refactor the queue so that messages process in order"))
      expect(contract.successCriteria.length).toBeGreaterThan(0)
    })

    it("extracts 'must' assertions", () => {
      const contract = extractContractHeuristic(mention("the response must include pagination metadata"))
      expect(contract.successCriteria.length).toBeGreaterThan(0)
    })

    it("extracts 'needs to' assertions", () => {
      const contract = extractContractHeuristic(mention("the API needs to return within 200ms for cached queries"))
      expect(contract.successCriteria.length).toBeGreaterThan(0)
    })
  })

  describe("output type inference", () => {
    it("infers code-change for fix tasks", () => {
      const contract = extractContractHeuristic(mention("fix the memory leak in queue"))
      expect(contract.outputType).toBe("code-change")
    })

    it("infers code-change for implement tasks", () => {
      const contract = extractContractHeuristic(mention("implement user authentication"))
      expect(contract.outputType).toBe("code-change")
    })

    it("infers code-change for refactor tasks", () => {
      const contract = extractContractHeuristic(mention("refactor the processor module"))
      expect(contract.outputType).toBe("code-change")
    })

    it("infers review for audit tasks", () => {
      const contract = extractContractHeuristic(mention("audit the security module"))
      expect(contract.outputType).toBe("review")
    })

    it("infers review for review tasks", () => {
      const contract = extractContractHeuristic(mention("review the pull request"))
      expect(contract.outputType).toBe("review")
    })

    it("infers analysis for research tasks", () => {
      const contract = extractContractHeuristic(mention("research the best approach for caching"))
      expect(contract.outputType).toBe("analysis")
    })

    it("infers analysis for investigate tasks", () => {
      const contract = extractContractHeuristic(mention("investigate why tests are flaky"))
      expect(contract.outputType).toBe("analysis")
    })

    it("infers spec for design tasks", () => {
      const contract = extractContractHeuristic(mention("design the API schema"))
      expect(contract.outputType).toBe("spec")
    })

    it("infers config for configure tasks", () => {
      const contract = extractContractHeuristic(mention("configure the deployment settings"))
      expect(contract.outputType).toBe("config")
    })

    it("returns unknown for ambiguous tasks", () => {
      const contract = extractContractHeuristic(mention("do the thing"))
      expect(contract.outputType).toBe("unknown")
    })
  })

  describe("commit inference", () => {
    it("true for explicit commit keywords", () => {
      expect(extractContractHeuristic(mention("commit the changes")).shouldCommit).toBe(true)
      expect(extractContractHeuristic(mention("ship the feature")).shouldCommit).toBe(true)
    })

    it("false for analysis tasks", () => {
      expect(extractContractHeuristic(mention("analyze the performance")).shouldCommit).toBe(false)
    })

    it("false for research tasks", () => {
      expect(extractContractHeuristic(mention("research caching strategies")).shouldCommit).toBe(false)
    })

    it("false for review tasks", () => {
      expect(extractContractHeuristic(mention("review the code")).shouldCommit).toBe(false)
    })

    it("true for code-change tasks by default", () => {
      expect(extractContractHeuristic(mention("fix the bug")).shouldCommit).toBe(true)
    })

    it("false for draft/propose tasks", () => {
      expect(extractContractHeuristic(mention("draft a migration plan")).shouldCommit).toBe(false)
    })
  })

  describe("priority inference", () => {
    it("blocking for urgent tasks", () => {
      expect(extractContractHeuristic(mention("fix this urgent production bug")).priority).toBe("blocking")
    })

    it("blocking for ASAP tasks", () => {
      expect(extractContractHeuristic(mention("deploy asap")).priority).toBe("blocking")
    })

    it("blocking for critical tasks", () => {
      expect(extractContractHeuristic(mention("critical security vulnerability")).priority).toBe("blocking")
    })

    it("background for low priority tasks", () => {
      expect(extractContractHeuristic(mention("when you get a chance, clean up the utils")).priority).toBe("background")
    })

    it("background for non-urgent tasks", () => {
      expect(extractContractHeuristic(mention("non-urgent: add logging")).priority).toBe("background")
    })

    it("normal for regular tasks", () => {
      expect(extractContractHeuristic(mention("add user validation")).priority).toBe("normal")
    })
  })
})

describe("extractContracts", () => {
  it("attaches contracts to all mentions", () => {
    const mentions = [
      mention("fix the bug"),
      mention("review the code"),
    ]
    extractContracts(mentions)
    expect(mentions[0].contract).toBeDefined()
    expect(mentions[1].contract).toBeDefined()
  })

  it("sets correct output types on each", () => {
    const mentions = [
      mention("fix the bug"),
      mention("review the code"),
    ]
    extractContracts(mentions)
    expect(mentions[0].contract?.outputType).toBe("code-change")
    expect(mentions[1].contract?.outputType).toBe("review")
  })
})
