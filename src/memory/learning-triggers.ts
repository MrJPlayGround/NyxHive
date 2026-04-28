/**
 * learning-triggers.ts — Automatic knowledge extraction from high-value events.
 *
 * Detects patterns in agent output without requiring [@learn:] tags:
 * - Test failure resolved: agent encountered failing test, fixed it, tests pass
 * - Review gate issues: review gate found issues in the code
 * - Debugging resolution: agent explored an error through multiple steps before fixing
 *
 * Stores learned patterns as graph memory nodes with category "learned_pattern".
 */

import { logger } from "../utils/logger.js";
import type { MemoryType } from "../types.js";

export interface LearnedPattern {
  type: MemoryType;
  content: string;
  importance: number;
  trigger: "test_failure_resolved" | "review_gate_issue" | "debugging_resolution";
  metadata: {
    errorSignature?: string;
    resolution?: string;
    files?: string[];
    agent?: string;
  };
}

// --- Test failure resolved ---
// Detects: agent output mentions test failure, then later mentions tests passing

const TEST_FAIL_PATTERNS = [
  /(?:FAIL|FAILED|failing|test.*fail|failure)\s+(.+?)(?:\n|$)/gim,
  /(?:error|Error).*(?:test|spec|\.test\.)/gim,
];

const TEST_PASS_PATTERNS = [
  /(?:all\s+\d+\s+tests?\s+pass|tests?\s+(?:pass|passed|passing)|0\s+fail)/gim,
  /(?:\d+\s+pass[,\s]+\d+\s+fail|\d+\s+fail[,\s]+\d+\s+pass)/gim,
];

const ERROR_SIGNATURE_RE = /((?:TypeError|ReferenceError|SyntaxError|Error|FAIL):\s*.+?)(?:\n|$)/gm;

function detectTestFailureResolved(output: string): LearnedPattern | null {
  const hadFailure = TEST_FAIL_PATTERNS.some(re => {
    re.lastIndex = 0;
    return re.test(output);
  });

  const hadPass = TEST_PASS_PATTERNS.some(re => {
    re.lastIndex = 0;
    return re.test(output);
  });

  if (!hadFailure || !hadPass) return null;

  // Extract error signature
  ERROR_SIGNATURE_RE.lastIndex = 0;
  const errorMatch = ERROR_SIGNATURE_RE.exec(output);
  const errorSignature = errorMatch?.[1]?.trim().slice(0, 200);

  // Extract file paths from context around the error
  const fileRe = /(?:src|lib|test|tests)\/[\w./-]+\.\w{1,10}/g;
  const files = [...new Set([...output.matchAll(fileRe)].map(m => m[0]))].slice(0, 5);

  // Try to extract what fixed it — look for patterns after the failure
  const fixPatterns = [
    /(?:fixed|resolved|corrected|changed|updated|added|removed)\s+(.+?)(?:\.|$)/gim,
    /(?:the (?:fix|solution|issue) (?:was|is))\s+(.+?)(?:\.|$)/gim,
  ];

  let resolution: string | undefined;
  for (const re of fixPatterns) {
    re.lastIndex = 0;
    const match = re.exec(output);
    if (match?.[1] && match[1].length > 10) {
      resolution = match[1].trim().slice(0, 200);
      break;
    }
  }

  const content = errorSignature
    ? `Test failure resolved: ${errorSignature}${resolution ? ` — Fix: ${resolution}` : ""}${files.length ? ` (files: ${files.join(", ")})` : ""}`
    : `Test failure resolved during coding task${resolution ? `: ${resolution}` : ""}`;

  return {
    type: "pattern",
    content,
    importance: 0.7,
    trigger: "test_failure_resolved",
    metadata: {
      errorSignature,
      resolution,
      files: files.length > 0 ? files : undefined,
    },
  };
}

// --- Review gate issue detection ---
// Detects: review gate annotations in the response

const REVIEW_GATE_RE = /\*\*Review Gate \[(FAIL|WARN)\]:?\*\*:?\s*(.+?)(?:\n|$)/g;
const REVIEW_ISSUE_RE = />\s+-\s+(.+?)(?:\n|$)/g;

function detectReviewGateIssue(output: string): LearnedPattern | null {
  REVIEW_GATE_RE.lastIndex = 0;
  const gateMatch = REVIEW_GATE_RE.exec(output);
  if (!gateMatch) return null;

  const verdict = gateMatch[1]; // FAIL or WARN
  const summary = gateMatch[2]?.trim();

  // Extract specific issues
  const issues: string[] = [];
  REVIEW_ISSUE_RE.lastIndex = 0;
  let issueMatch: RegExpExecArray | null;
  while ((issueMatch = REVIEW_ISSUE_RE.exec(output)) !== null) {
    if (issueMatch[1].length > 5) {
      issues.push(issueMatch[1].trim());
    }
  }

  if (!summary && issues.length === 0) return null;

  const content = `Review gate ${verdict}: ${summary}${issues.length > 0 ? ` — Issues: ${issues.join("; ")}` : ""}`;

  return {
    type: "pattern",
    content,
    importance: verdict === "FAIL" ? 0.8 : 0.5,
    trigger: "review_gate_issue",
    metadata: {
      resolution: summary,
    },
  };
}

// --- Debugging resolution ---
// Detects: output shows exploration (multiple error mentions, tool calls) then a fix

const EXPLORATION_INDICATORS = [
  /(?:investigating|exploring|checking|looking at|examining|debugging)/gim,
  /(?:tried|attempted|tested|experimented)/gim,
  /(?:root cause|found the issue|the problem (?:is|was))/gim,
];

function detectDebuggingResolution(output: string): LearnedPattern | null {
  // Need at least 2 exploration indicators
  let explorationCount = 0;
  for (const re of EXPLORATION_INDICATORS) {
    re.lastIndex = 0;
    if (re.test(output)) explorationCount++;
  }
  if (explorationCount < 2) return null;

  // Need an error signature
  ERROR_SIGNATURE_RE.lastIndex = 0;
  const errorMatch = ERROR_SIGNATURE_RE.exec(output);
  if (!errorMatch) return null;
  const errorSignature = errorMatch[1]?.trim().slice(0, 200);

  // Need evidence of resolution
  const resolutionRe = /(?:root cause|the (?:fix|solution|problem|issue) (?:was|is)|resolved by|fixed by)\s+(.+?)(?:\.|$)/gim;
  resolutionRe.lastIndex = 0;
  const resMatch = resolutionRe.exec(output);
  if (!resMatch) return null;
  const resolution = resMatch[1]?.trim().slice(0, 200);

  const fileRe = /(?:src|lib|test|tests)\/[\w./-]+\.\w{1,10}/g;
  const files = [...new Set([...output.matchAll(fileRe)].map(m => m[0]))].slice(0, 5);

  const content = `Debugging resolution: ${errorSignature} — ${resolution}${files.length ? ` (files: ${files.join(", ")})` : ""}`;

  return {
    type: "pattern",
    content,
    importance: 0.8,
    trigger: "debugging_resolution",
    metadata: {
      errorSignature,
      resolution,
      files: files.length > 0 ? files : undefined,
    },
  };
}

// --- Main extraction function ---

/**
 * Extract learning triggers from agent output.
 * Returns learned patterns that should be stored in graph memory.
 */
export function extractLearningTriggers(
  agentOutput: string,
  agentName?: string,
): LearnedPattern[] {
  const patterns: LearnedPattern[] = [];

  const testPattern = detectTestFailureResolved(agentOutput);
  if (testPattern) {
    testPattern.metadata.agent = agentName;
    patterns.push(testPattern);
  }

  const reviewPattern = detectReviewGateIssue(agentOutput);
  if (reviewPattern) {
    reviewPattern.metadata.agent = agentName;
    patterns.push(reviewPattern);
  }

  const debugPattern = detectDebuggingResolution(agentOutput);
  if (debugPattern) {
    debugPattern.metadata.agent = agentName;
    patterns.push(debugPattern);
  }

  if (patterns.length > 0) {
    logger.debug(`[learning-triggers] Extracted ${patterns.length} patterns from ${agentName ?? "unknown"} output`);
  }

  return patterns;
}
