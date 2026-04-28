const INTERNAL_FRAMEWORK_TERMS = [
  "runtime mode",
  "prompt profile",
  "execution policy",
  "operating model",
  "routing explanation",
  "workflow lane",
  "tool-use narration",
  "orchestration layer",
];

const ACTION_FRAMING_PATTERN = /^(i('|’)ll|i will|i('|’)m going to|here('|’)s the plan|plan:|first, i('|’)ll|let me)/i;
const GENERIC_FILLER_OPENINGS = [
  "absolutely",
  "certainly",
  "great question",
  "thanks for sharing",
  "thank you for sharing",
  "i'd be happy to",
  "i would be happy to",
  "happy to help",
];
const SUMMARY_OPENING_PATTERN = /^\s*(?:#{1,4}\s*)?(?:\*\*)?(?:summary|short version|tl;dr|tldr|recap|bottom line)(?:\*\*)?\s*:/i;
const SETUP_OPENING_PATTERNS = [
  "there are a few things",
  "there are several",
  "at a high level",
  "the short version is",
  "here's the short version",
  "here are",
  "let's break it down",
  "to answer that",
  "it depends",
];
const SELF_FLATTENING_TERMS = [
  "as an ai",
  "i don't have feelings",
  "i do not have feelings",
  "i don't have preferences",
  "i do not have preferences",
  "i don't have opinions",
  "i do not have opinions",
  "feelings or preferences",
  "just a tool",
  "only a tool",
];

export interface ReplyShapeDiagnostics {
  wordCount: number;
  paragraphCount: number;
  bulletCount: number;
  headingCount: number;
  internalFrameworkTerms: string[];
  startsWithActionFraming: boolean;
  fillerOpening: string | null;
  summaryOpening: boolean;
  setupOpening: string | null;
  repeatedLineCount: number;
  machineChatterTerms: string[];
  selfFlatteningTerms: string[];
  footerClutter: boolean;
  duplicatedEvidence: boolean;
  overstructured: boolean;
  overexplained: boolean;
}

export function inspectReplyShape(response: string): ReplyShapeDiagnostics {
  const lines = response.split(/\r?\n/);
  const words = response.match(/\S+/g) ?? [];
  const paragraphCount = response.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean).length;
  const bulletCount = lines.filter((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line)).length;
  const headingCount = lines.filter((line) => /^\s*(?:#{1,4}\s+\S|\*\*[^*\n]{1,48}:\*\*)/.test(line)).length;
  const normalized = response.toLowerCase();
  const opening = normalized.trimStart();
  const nonEmptyLines = lines.map((line) => line.trim().toLowerCase()).filter(Boolean);
  const repeatedLineCount = nonEmptyLines.length - new Set(nonEmptyLines).size;
  const overstructured = headingCount >= 2 || bulletCount >= 4;
  const overexplained = words.length > 120 || paragraphCount > 4;
  return {
    wordCount: words.length,
    paragraphCount,
    bulletCount,
    headingCount,
    internalFrameworkTerms: INTERNAL_FRAMEWORK_TERMS.filter((term) => normalized.includes(term)),
    startsWithActionFraming: ACTION_FRAMING_PATTERN.test(response.trim()),
    fillerOpening: GENERIC_FILLER_OPENINGS.find((phrase) => opening.startsWith(phrase)) ?? null,
    summaryOpening: SUMMARY_OPENING_PATTERN.test(response.trim()),
    setupOpening: SETUP_OPENING_PATTERNS.find((phrase) => opening.startsWith(phrase)) ?? null,
    repeatedLineCount,
    machineChatterTerms: ["tool call", "runtime trace", "internal state", "raw event", "json payload"].filter((term) => normalized.includes(term)),
    selfFlatteningTerms: collectSelfFlatteningTerms(normalized),
    footerClutter: /\b(let me know if|feel free to|happy to help|hope this helps)\b/i.test(response),
    duplicatedEvidence: /\bverification\b[\s\S]{0,120}\bverification\b/i.test(response)
      || /\bchanged files?\b[\s\S]{0,120}\bchanged files?\b/i.test(response),
    overstructured,
    overexplained,
  };
}

function collectSelfFlatteningTerms(normalized: string): string[] {
  return SELF_FLATTENING_TERMS.filter((term) => {
    if (!normalized.includes(term)) return false;
    if (term === "just a tool" && /\bnot\s+just a tool\b/.test(normalized)) return false;
    if (term === "only a tool" && /\bnot\s+only a tool\b/.test(normalized)) return false;
    return true;
  });
}

export function isLowActionReplyShape(response: string): boolean {
  const diagnostics = inspectReplyShape(response);
  return diagnostics.bulletCount <= 1
    && diagnostics.internalFrameworkTerms.length === 0
    && !diagnostics.startsWithActionFraming
    && diagnostics.fillerOpening === null
    && !diagnostics.summaryOpening
    && diagnostics.setupOpening === null
    && diagnostics.repeatedLineCount === 0
    && diagnostics.machineChatterTerms.length === 0
    && diagnostics.selfFlatteningTerms.length === 0
    && !diagnostics.footerClutter
    && !diagnostics.duplicatedEvidence
    && !diagnostics.overstructured
    && !diagnostics.overexplained;
}
