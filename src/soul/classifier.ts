// Complexity classifier — determines the appropriate model tier for a task
// Returns a relative tier (min/default/max) so resolveModel can bound it to the agent's soul range

import type { ComplexityResult, RelativeTier } from "./types.js"
import type { ClassifierFeedbackStore } from "./classifier-feedback.js"

// Keyword → tier mapping
// Highest matching tier wins if multiple signals fire
const KEYWORD_TIERS: Array<{ keywords: string[]; tier: RelativeTier; weight: number }> = [
  // Max tier — complex reasoning, architecture, broad scope
  {
    keywords: [
      "refactor", "architect", "architecture", "redesign", "migrate", "migration",
      "debug", "diagnose", "root cause", "root-cause", "investigate",
      "design", "system design", "trade-off", "trade off",
      "multi-file", "cross-cutting", "cross cutting", "overhaul",
      "security audit", "performance audit", "audit",
      "complex", "comprehensive", "thorough analysis",
    ],
    tier: "max",
    weight: 3,
  },
  // Default tier — standard implementation work
  {
    keywords: [
      "implement", "implementation", "build", "create", "add", "fix", "bug",
      "feature", "function", "class", "module", "component",
      "test", "write test", "unit test", "integration test",
      "update", "modify", "change", "edit", "improve",
      "review", "analyze", "explain", "document",
    ],
    tier: "default",
    weight: 2,
  },
  // Min tier — trivial/mechanical tasks
  {
    keywords: [
      "commit", "git commit", "bump version", "version bump", "bump",
      "rename", "format", "lint", "prettier",
      "lookup", "look up", "find file", "grep", "search",
      "list", "show", "display", "print", "echo",
      "status", "health", "ping", "check status",
      "readme", "changelog entry", "log entry",
      "typo", "typos", "spelling",
    ],
    tier: "min",
    weight: 1,
  },
]

// Estimate token count by word count proxy (rough: 1 word ≈ 1.3 tokens)
function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3)
}

// Token count → tier
function tokenTier(tokens: number): RelativeTier {
  if (tokens < 500) return "min"
  if (tokens < 3000) return "default"
  return "max"
}

// File count → tier
function fileTier(fileCount: number): RelativeTier {
  if (fileCount <= 1) return "min"
  if (fileCount <= 5) return "default"
  return "max"
}

// Compare two tiers — returns the higher one
const TIER_RANK: Record<RelativeTier, number> = { min: 0, default: 1, max: 2 }
function higherTier(a: RelativeTier, b: RelativeTier): RelativeTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b
}

// Classify task complexity and return the recommended relative tier
export function classifyComplexity(
  task: string,
  fileCount = 0,
  feedback?: ClassifierFeedbackStore,
): ComplexityResult {
  const lower = task.toLowerCase()
  const estimatedTokens = estimateTokens(task)
  const signals: string[] = []

  // --- Keyword signal ---
  let keywordTier: RelativeTier = "default"
  let keywordMatched = false

  for (const group of KEYWORD_TIERS) {
    const matched = group.keywords.find((kw) => lower.includes(kw))
    if (matched) {
      // Always bump up, never down — highest tier wins
      if (TIER_RANK[group.tier] >= TIER_RANK[keywordTier] || !keywordMatched) {
        keywordTier = group.tier
        keywordMatched = true
      }
      signals.push(`keyword:"${matched}"→${group.tier}`)
      // Don't break — let all matching keywords register signals, but keep highest tier
    }
  }
  if (!keywordMatched) signals.push("no matching keywords→default")

  // --- Token scope signal ---
  const tTier = tokenTier(estimatedTokens)
  signals.push(`~${estimatedTokens} tokens→${tTier}`)

  // --- File scope signal ---
  if (fileCount > 0) {
    const fTier = fileTier(fileCount)
    signals.push(`${fileCount} files→${fTier}`)
  }

  // --- Final tier: highest of all signals (bias toward quality on ambiguity) ---
  let tier: RelativeTier = keywordTier
  tier = higherTier(tier, tTier)
  if (fileCount > 0) {
    tier = higherTier(tier, fileTier(fileCount))
  }

  // --- Confidence: higher when signals agree ---
  const allTiers = [keywordTier, tTier, ...(fileCount > 0 ? [fileTier(fileCount)] : [])]
  const uniqueTiers = new Set(allTiers).size
  let confidence = uniqueTiers === 1 ? 0.9 : uniqueTiers === 2 ? 0.65 : 0.45

  // --- Feedback bias: override low-confidence classifications with learned data ---
  if (feedback) {
    // Extract meaningful keywords from the task for feedback lookup
    const taskKeywords = lower
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 10)
    try {
      const bias = feedback.getTierBias(taskKeywords)
      if (bias && bias !== tier) {
        signals.push(`feedback-bias:${bias}`)
        // Only override if heuristic confidence is low
        if (confidence < 0.7) {
          tier = bias
          confidence = 0.7 // Feedback gives moderate confidence
          signals.push(`feedback-override:${bias}`)
        }
      }
    } catch { /* non-critical — skip feedback on error */ }
  }

  return { tier, confidence, signals }
}
