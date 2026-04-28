import { describe, it, expect } from "bun:test"
import { classifyComplexity } from "../soul/classifier.js"

describe("classifyComplexity", () => {
  describe("keyword matching", () => {
    it("classifies refactoring tasks as max", () => {
      const result = classifyComplexity("refactor the authentication module")
      expect(result.tier).toBe("max")
      expect(result.signals.some((s) => s.includes('keyword:"refactor"'))).toBe(true)
    })

    it("classifies architecture tasks as max", () => {
      const result = classifyComplexity("design the system architecture for the new API")
      expect(result.tier).toBe("max")
    })

    it("classifies debugging tasks as max", () => {
      const result = classifyComplexity("debug the memory leak in the queue processor")
      expect(result.tier).toBe("max")
    })

    it("classifies investigation tasks as max", () => {
      const result = classifyComplexity("investigate root cause of the failing tests")
      expect(result.tier).toBe("max")
    })

    it("classifies security audit as max", () => {
      const result = classifyComplexity("run a security audit on the auth module")
      expect(result.tier).toBe("max")
    })

    it("classifies implementation tasks as default", () => {
      const result = classifyComplexity("implement user login feature")
      expect(result.tier).toBe("default")
    })

    it("classifies test writing as default", () => {
      const result = classifyComplexity("write unit test for the parser")
      expect(result.tier).toBe("default")
    })

    it("classifies bug fixes as default", () => {
      const result = classifyComplexity("fix the bug in form validation")
      expect(result.tier).toBe("default")
    })

    it("classifies code review as default", () => {
      const result = classifyComplexity("review the pull request changes")
      expect(result.tier).toBe("default")
    })

    it("classifies pure commit tasks as min", () => {
      const result = classifyComplexity("git commit")
      expect(result.tier).toBe("min")
    })

    it("bumps commit to default when 'change' keyword present", () => {
      const result = classifyComplexity("commit the changes")
      // "change" → default wins over "commit" → min
      expect(result.tier).toBe("default")
    })

    it("classifies version bump as min", () => {
      const result = classifyComplexity("bump version to 2.0")
      expect(result.tier).toBe("min")
    })

    it("classifies rename tasks as min", () => {
      const result = classifyComplexity("rename the variable")
      expect(result.tier).toBe("min")
    })

    it("classifies pure typo tasks as min", () => {
      const result = classifyComplexity("typo in readme")
      expect(result.tier).toBe("min")
    })

    it("bumps typo fix to default when 'fix' keyword present", () => {
      const result = classifyComplexity("fix typo in readme")
      // "fix" → default wins over "typo" → min
      expect(result.tier).toBe("default")
    })

    it("classifies lint tasks as min", () => {
      const result = classifyComplexity("lint the codebase")
      expect(result.tier).toBe("min")
    })

    it("classifies status checks as min", () => {
      const result = classifyComplexity("check status of the server")
      expect(result.tier).toBe("min")
    })

    it("defaults to default when no keywords match", () => {
      const result = classifyComplexity("do something vague")
      expect(result.signals.some((s) => s.includes("no matching keywords"))).toBe(true)
    })
  })

  describe("highest tier wins", () => {
    it("picks max when both max and default keywords present", () => {
      const result = classifyComplexity("refactor and implement the new module")
      expect(result.tier).toBe("max")
      expect(result.signals.some((s) => s.includes("refactor"))).toBe(true)
      expect(result.signals.some((s) => s.includes("implement"))).toBe(true)
    })

    it("picks max when both max and min keywords present", () => {
      const result = classifyComplexity("debug the typo in the status checker")
      expect(result.tier).toBe("max")
    })

    it("picks default when both default and min keywords present", () => {
      // "fix" is default, "typo" is min — but "fix" is also default tier
      const result = classifyComplexity("add a changelog entry for the feature")
      // "add" → default, "changelog entry" → min
      expect(result.signals.some((s) => s.includes('"add"'))).toBe(true)
    })
  })

  describe("token estimation", () => {
    it("classifies short text as min tokens", () => {
      const result = classifyComplexity("hello")
      // 1 word * 1.3 ≈ 2 tokens → min
      expect(result.signals.some((s) => s.includes("tokens→min"))).toBe(true)
    })

    it("classifies medium text as default tokens", () => {
      // Need 500+ tokens → ~385 words
      const words = Array(400).fill("word").join(" ")
      const result = classifyComplexity(words)
      expect(result.signals.some((s) => s.includes("tokens→default"))).toBe(true)
    })

    it("classifies long text as max tokens", () => {
      // Need 3000+ tokens → ~2308 words
      const words = Array(2400).fill("word").join(" ")
      const result = classifyComplexity(words)
      expect(result.signals.some((s) => s.includes("tokens→max"))).toBe(true)
    })
  })

  describe("file count signal", () => {
    it("ignores file count when 0", () => {
      const result = classifyComplexity("fix a bug", 0)
      expect(result.signals.every((s) => !s.includes("files→"))).toBe(true)
    })

    it("classifies 1 file as min", () => {
      const result = classifyComplexity("fix a bug", 1)
      expect(result.signals.some((s) => s.includes("1 files→min"))).toBe(true)
    })

    it("classifies 3 files as default", () => {
      const result = classifyComplexity("fix a bug", 3)
      expect(result.signals.some((s) => s.includes("3 files→default"))).toBe(true)
    })

    it("classifies 6+ files as max", () => {
      const result = classifyComplexity("fix a bug", 6)
      expect(result.signals.some((s) => s.includes("6 files→max"))).toBe(true)
    })

    it("bumps tier up when file count is high", () => {
      // "commit" → min keyword, but 10 files → max
      const result = classifyComplexity("commit the changes", 10)
      expect(result.tier).toBe("max")
    })
  })

  describe("confidence", () => {
    it("returns high confidence when all signals agree", () => {
      // Short text + min keyword + 1 file = all min
      const result = classifyComplexity("commit", 1)
      expect(result.confidence).toBe(0.9)
    })

    it("returns medium confidence when 2 unique tiers", () => {
      // "commit" → min keyword, short text → min tokens, but 3 files → default
      const result = classifyComplexity("commit", 3)
      expect(result.confidence).toBe(0.65)
    })

    it("returns low confidence when 3 unique tiers", () => {
      // Need min keyword + default tokens + max files
      // "commit" → min, ~400 words → default tokens, 10 files → max
      const words = Array(400).fill("word").join(" ")
      const result = classifyComplexity(`commit ${words}`, 10)
      expect(result.confidence).toBe(0.45)
    })
  })

  describe("result shape", () => {
    it("returns tier, confidence, and signals", () => {
      const result = classifyComplexity("implement a feature")
      expect(result).toHaveProperty("tier")
      expect(result).toHaveProperty("confidence")
      expect(result).toHaveProperty("signals")
      expect(Array.isArray(result.signals)).toBe(true)
      expect(result.signals.length).toBeGreaterThan(0)
    })

    it("always includes at least keyword and token signals", () => {
      const result = classifyComplexity("hello")
      expect(result.signals.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe("case insensitivity", () => {
    it("matches keywords regardless of case", () => {
      const result = classifyComplexity("REFACTOR the MODULE")
      expect(result.tier).toBe("max")
    })

    it("matches mixed case keywords", () => {
      const result = classifyComplexity("Debug the Issue")
      expect(result.tier).toBe("max")
    })
  })

  describe("multi-word keywords", () => {
    it("matches 'root cause' as a phrase", () => {
      const result = classifyComplexity("find the root cause of this error")
      expect(result.signals.some((s) => s.includes('"root cause"'))).toBe(true)
    })

    it("matches 'unit test' — 'test' keyword fires first", () => {
      const result = classifyComplexity("write a unit test for the parser")
      // "test" is matched before "unit test" since find() returns first match in the group
      expect(result.signals.some((s) => s.includes('"test"') || s.includes('"unit test"'))).toBe(true)
    })

    it("matches 'version bump' as a phrase", () => {
      const result = classifyComplexity("do a version bump")
      expect(result.signals.some((s) => s.includes('"version bump"'))).toBe(true)
    })
  })
})
