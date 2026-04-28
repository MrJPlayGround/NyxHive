import type { ActorMention, DelegationContract, DelegationOutputType, DelegationPriority } from "../types.js";
import { extractFilePaths, extractVerificationHints } from "./actor.js";

/**
 * Extract a DelegationContract from an ActorMention using heuristic pattern matching.
 * Zero cost, always runs. This is Tier 1 of the hybrid extraction pipeline.
 *
 * Enriches the mention with structured metadata extracted from the natural language task:
 * input/output files, exclude files, constraints, verification, success criteria,
 * output type, commit intent, and priority.
 */
export function extractContractHeuristic(mention: ActorMention): DelegationContract {
  const task = mention.task;

  return {
    task,
    agent: mention.agent,
    inputFiles: extractInputFiles(task),
    outputFiles: extractOutputFiles(task),
    excludeFiles: extractExcludeFiles(task),
    constraints: extractConstraints(task),
    verification: extractVerification(task),
    successCriteria: extractSuccessCriteria(task),
    outputType: inferOutputType(task),
    shouldCommit: inferShouldCommit(task),
    priority: inferPriority(task),
    dependsOn: [],
    extractionMethod: "heuristic",
  };
}

/**
 * Run contract extraction on an array of mentions, attaching the contract to each.
 */
export function extractContracts(mentions: ActorMention[]): void {
  for (const mention of mentions) {
    mention.contract = extractContractHeuristic(mention);
  }
}

// --- Input Files ---

/**
 * Extract files the agent should read/modify.
 * Uses the existing extractFilePaths() as a baseline, then filters out
 * paths that appear in output-file contexts.
 */
function extractInputFiles(task: string): string[] {
  const allPaths = extractFilePaths(task);
  const outputPaths = new Set(extractOutputFiles(task));
  const excludePaths = new Set(extractExcludeFiles(task));

  // Paths that aren't outputs or excludes are inputs
  return allPaths.filter(p => !outputPaths.has(p) && !excludePaths.has(p));
}

// --- Output Files ---

/**
 * Extract files the agent should produce or write to.
 * Patterns: "write to", "save to", "output to", "produce", "create file" + path
 */
function extractOutputFiles(task: string): string[] {
  const files = new Set<string>();

  // "write to <path>", "save to <path>", "output to <path>"
  const writeToRegex = /(?:write|save|output|export)\s+(?:to|into|in)\s+(\S+\.[\w]+)/gi;
  let match: RegExpExecArray | null = writeToRegex.exec(task);
  while (match !== null) {
    files.add(match[1]);
    match = writeToRegex.exec(task);
  }

  // "write findings to <path>", "write results to <path>" — path may be longer
  const writeFindingsRegex = /(?:write|save|put|store)\s+\w+\s+(?:to|into|in)\s+((?:\/[\w.-]+)+(?:\/[\w.-]+\.\w+))/gi;
  match = writeFindingsRegex.exec(task);
  while (match !== null) {
    files.add(match[1]);
    match = writeFindingsRegex.exec(task);
  }

  // "create <path>", "create file <path>"
  const createRegex = /(?:create|generate)\s+(?:file\s+)?(?:at\s+)?((?:\/[\w.-]+)+(?:\/[\w.-]+\.\w+))/gi;
  match = createRegex.exec(task);
  while (match !== null) {
    files.add(match[1]);
    match = createRegex.exec(task);
  }

  return [...files];
}

// --- Exclude Files ---

/**
 * Extract files/directories the agent must NOT modify.
 * Patterns: "don't touch", "don't modify", "leave X alone", "don't change", "except" + path
 */
function extractExcludeFiles(task: string): string[] {
  const files = new Set<string>();

  // "don't touch/modify/change <path> [or <path>]" and "do not touch/modify/change <path>"
  const dontTouchRegex = /(?:don['']?t|do\s+not)\s+(?:touch|modify|change|edit|alter)\s+((?:[\w./-]+\/)?[\w.-]+\.[\w]+)(?:\s+or\s+((?:[\w./-]+\/)?[\w.-]+\.[\w]+))?/gi;
  let match: RegExpExecArray | null = dontTouchRegex.exec(task);
  while (match !== null) {
    files.add(match[1]);
    if (match[2]) files.add(match[2]);
    match = dontTouchRegex.exec(task);
  }

  // "leave <path> alone"
  const leaveAloneRegex = /leave\s+((?:[\w./-]+\/)?[\w.-]+\.[\w]+)\s+alone/gi;
  match = leaveAloneRegex.exec(task);
  while (match !== null) {
    files.add(match[1]);
    match = leaveAloneRegex.exec(task);
  }

  // "Don't touch the logout flow" — extract contextual references like "X flow" and try to match paths
  // "except <path>" or "excluding <path>"
  const exceptRegex = /(?:except|excluding|but\s+not)\s+((?:[\w./-]+\/)?[\w.-]+\.[\w]+)/gi;
  match = exceptRegex.exec(task);
  while (match !== null) {
    files.add(match[1]);
    match = exceptRegex.exec(task);
  }

  return [...files];
}

// --- Constraints ---

/**
 * Extract design constraints and requirements.
 * Patterns: "don't add", "keep", "use existing", "must be", "without", "backward compatible"
 */
function extractConstraints(task: string): string[] {
  const constraints = new Set<string>();

  const patterns = [
    // "don't add/introduce <something>"
    /(?:don['']?t|do\s+not)\s+(?:add|introduce|create|install)\s+(.{5,80}?)(?:\.|,|$)/gi,
    // "don't change/break <something>" (design constraint, not file exclusion)
    /(?:don['']?t|do\s+not)\s+(?:change|break|alter|remove)\s+(?:the\s+)?(.{5,80}?)(?:\.|,|$)/gi,
    // "keep <something>" as constraint (e.g., "keep backward compatible")
    /(?:keep|maintain|preserve)\s+(.{5,60}?)(?:\.|,|$)/gi,
    // "use existing <something>" / "use the existing <something>"
    /use\s+(?:the\s+)?existing\s+(.{5,60}?)(?:\.|,|$)/gi,
    // "use <modifier> <thing>" (e.g., "use exponential backoff with jitter")
    /use\s+(\w+\s+\w+(?:\s+\w+){0,5}?)(?:\.|,|$)/gi,
    // "must be <constraint>"
    /must\s+be\s+(.{5,60}?)(?:\.|,|$)/gi,
    // "without <constraint>"
    /without\s+(.{5,60}?)(?:\.|,|$)/gi,
    // "backward compatible" / "backwards compatible"
    /(backwards?\s+compatible\b.*?)(?:\.|,|$)/gi,
    // "no new dependencies" / "no additional <something>"
    /no\s+(?:new|additional|extra)\s+(.{5,60}?)(?:\.|,|$)/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null = pattern.exec(task);
    while (match !== null) {
      const constraint = match[1]?.trim() || match[0].trim();
      if (constraint.length > 4) {
        constraints.add(constraint);
      }
      match = pattern.exec(task);
    }
  }

  return [...constraints];
}

// --- Verification ---

/**
 * Extract verification commands or checks.
 * Builds on existing extractVerificationHints() with additional patterns for
 * explicit commands like "bun test", "bun run typecheck", etc.
 */
function extractVerification(task: string): string[] {
  const hints = new Set<string>();

  // Start with existing verification hints
  for (const hint of extractVerificationHints(task)) {
    hints.add(hint);
  }

  // Explicit commands: "run <command>" where command looks like a CLI invocation
  const runCmdRegex = /(?:run|execute)\s+((?:bun|npm|npx|yarn|pnpm|make)\s+\S+(?:\s+\S+)?)/gi;
  let match: RegExpExecArray | null = runCmdRegex.exec(task);
  while (match !== null) {
    hints.add(match[1].trim());
    match = runCmdRegex.exec(task);
  }

  // Comma-separated verification like "bun test, bun run typecheck"
  // Only match when preceded by verification context
  const verifyListRegex = /(?:verify|verification|run|check)[:=]\s*(.+?)(?:\.|$)/gi;
  match = verifyListRegex.exec(task);
  while (match !== null) {
    const items = match[1].split(/,\s*/);
    for (const item of items) {
      const trimmed = item.trim();
      if (trimmed.length > 2) hints.add(trimmed);
    }
    match = verifyListRegex.exec(task);
  }

  return [...hints];
}

// --- Success Criteria ---

/**
 * Extract success criteria — what "done" looks like.
 * Patterns: "should work", "should be able to", "result in", "so that", "must" + assertion
 */
function extractSuccessCriteria(task: string): string[] {
  const criteria = new Set<string>();

  const patterns = [
    // "should <assertion>" (e.g., "should refresh on expiry")
    /(?:it\s+)?should\s+(.{10,100}?)(?:\.|,\s+(?:and|but)|$)/gi,
    // "so that <outcome>"
    /so\s+that\s+(.{10,100}?)(?:\.|$)/gi,
    // "result in <outcome>"
    /result\s+in\s+(.{10,80}?)(?:\.|$)/gi,
    // "must <assertion>" (stronger form)
    /(?:it\s+)?must\s+(.{10,100}?)(?:\.|,\s+(?:and|but)|$)/gi,
    // "needs to <assertion>"
    /needs?\s+to\s+(.{10,100}?)(?:\.|,\s+(?:and|but)|$)/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null = pattern.exec(task);
    while (match !== null) {
      const criterion = match[1].trim();
      if (criterion.length > 8) {
        criteria.add(criterion);
      }
      match = pattern.exec(task);
    }
  }

  return [...criteria];
}

// --- Output Type ---

/**
 * Infer the expected output type from task keywords.
 */
function inferOutputType(task: string): DelegationOutputType {
  const lower = task.toLowerCase();

  // Check specific types first (most → least specific)
  if (/\b(?:review|audit|check|inspect)\b/.test(lower)) return "review";
  if (/\b(?:spec|design|plan|blueprint|proposal)\b/.test(lower)) return "spec";
  if (/\b(?:research|analy[sz]e|investigate|study|compare|benchmark)\b/.test(lower)) return "analysis";
  if (/\b(?:config|configure|setup|settings|env)\b/.test(lower)) return "config";
  if (/\b(?:fix|implement|refactor|build|add|create|update|migrate|port|write code|code)\b/.test(lower)) return "code-change";

  return "unknown";
}

// --- Should Commit ---

/**
 * Infer whether the agent should commit changes.
 */
function inferShouldCommit(task: string): boolean {
  const lower = task.toLowerCase();

  // Explicit commit signals
  if (/\b(?:commit|land|ship|push|merge)\b/.test(lower)) return true;

  // Explicit non-commit signals
  if (/\b(?:draft|propose|analy[sz]e|research|review|investigate|report)\b/.test(lower)) return false;

  // Default: code-change tasks should commit
  const outputType = inferOutputType(task);
  return outputType === "code-change";
}

// --- Priority ---

/**
 * Infer task priority from language signals.
 */
function inferPriority(task: string): DelegationPriority {
  const lower = task.toLowerCase();

  // Check background first — "non-urgent" contains "urgent" so we need to exclude it
  if (/\b(?:when you (?:get|have) (?:a )?chance|low.?priority|background|eventually|non.?urgent)\b/.test(lower)) return "background";
  if (/\b(?:blocking|urgent|asap|immediately|critical|high.?priority)\b/.test(lower)) return "blocking";

  return "normal";
}
