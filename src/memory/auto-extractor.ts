// Heuristic auto-extraction from agent output — no LLM calls
// Extracts files touched, decisions made, errors encountered, commands run, dependencies

import { logger } from "../utils/logger.js";
import type { MemoryType, EdgeType } from "../types.js";

export interface ExtractedNode {
  type: MemoryType;
  content: string;
  importance: number;
  edgeTo?: { type: EdgeType; content: string };
}

// --- File path extraction ---

const FILE_PATH_RE = /(?:^|\s|["'`(])([.~/]?(?:src|lib|test|tests|docs|config|scripts|public|assets|packages|apps|dist|build|node_modules|\.github|\.vscode)\/[\w./-]+\.\w{1,10})/gm;
const EXPLICIT_PATH_RE = /(?:^|\s|["'`(])((?:\/[\w.-]+){2,}\/[\w.-]+\.\w{1,10})/gm;

function extractFilePaths(text: string): string[] {
  const paths = new Set<string>();
  for (const re of [FILE_PATH_RE, EXPLICIT_PATH_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const path = match[1].trim();
      // Skip obvious non-paths
      if (path.includes("//") || path.includes("http") || path.length < 5) continue;
      paths.add(path);
    }
  }
  return [...paths];
}

// --- Decision extraction ---

const DECISION_PATTERNS = [
  /(?:I |we |I've |we've )(?:chose|decided|went with|opted for|selected|picked)\s+(.+?)(?:\.|$)/gim,
  /(?:decided to|choosing to|going with|opted to)\s+(.+?)(?:\.|$)/gim,
  /(?:chose|picked|selected)\s+(.+?)\s+(?:over|instead of|rather than)\s+(.+?)(?:\.|$)/gim,
  /(?:the (?:best|right|better) (?:approach|solution|option|choice) (?:is|was|would be))\s+(.+?)(?:\.|$)/gim,
];

function extractDecisions(text: string): string[] {
  const decisions = new Set<string>();
  for (const re of DECISION_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const decision = match[0].trim();
      if (decision.length > 15 && decision.length < 300) {
        decisions.add(decision);
      }
    }
  }
  return [...decisions];
}

// --- Error extraction ---

const ERROR_PATTERNS = [
  /(?:^|\n)\s*((?:Error|TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|InternalError|AggregateError):\s*.+)/gm,
  /(?:^|\n)\s*((?:FAIL|FAILED|error\[[\w-]+\])[\s:].+)/gm,
  /(?:^|\n)\s*(panic:.+)/gm,
  /(?:^|\n)\s*(Unhandled (?:promise )?rejection:.+)/gm,
  // Stack trace first line
  /(?:^|\n)\s*(at\s+\w+\s+\(.+:\d+:\d+\))/gm,
];

function extractErrors(text: string): string[] {
  const errors = new Set<string>();
  for (const re of ERROR_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const error = match[1].trim();
      if (error.length > 10 && error.length < 500) {
        errors.add(error);
      }
    }
  }
  return [...errors];
}

// --- Command extraction ---

const COMMAND_PATTERNS = [
  /(?:^|\n)\s*\$\s+(.+)/gm,
  /(?:^|\n)\s*>\s+((?:bun|npm|npx|yarn|pnpm|git|docker|curl|make|cargo|go|pip|python|node|deno)\s+.+)/gm,
  /(?:ran|running|executed|run)\s+`([^`]+)`/gim,
];

function extractCommands(text: string): string[] {
  const commands = new Set<string>();
  for (const re of COMMAND_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const cmd = match[1].trim();
      if (cmd.length > 3 && cmd.length < 200) {
        commands.add(cmd);
      }
    }
  }
  return [...commands];
}

// --- Dependency extraction ---

const DEPENDENCY_PATTERNS = [
  /(?:bun|npm|yarn|pnpm)\s+(?:add|install|i)\s+([\w@/.,-]+(?:\s+[\w@/.,-]+)*)/gm,
  /(?:added|installed|upgraded)\s+(?:dependency|package|dep)\s+["`']?([\w@/.,-]+)["`']?/gim,
  /(?:package\.json|bun\.lockb|yarn\.lock|package-lock\.json)\s+(?:updated|changed|modified)/gim,
];

function extractDependencies(text: string): string[] {
  const deps = new Set<string>();
  for (const re of DEPENDENCY_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const dep = match[1]?.trim() ?? match[0].trim();
      if (dep.length > 1 && dep.length < 100) {
        deps.add(dep);
      }
    }
  }
  return [...deps];
}

// --- Main extraction function ---

export function autoExtract(agentOutput: string): ExtractedNode[] {
  const nodes: ExtractedNode[] = [];

  // File paths → file_change nodes
  const files = extractFilePaths(agentOutput);
  for (const file of files.slice(0, 20)) { // cap at 20 files per extraction
    nodes.push({
      type: "file_change",
      content: `Touched file: ${file}`,
      importance: 0.3,
    });
  }

  // Decisions → decision nodes
  const decisions = extractDecisions(agentOutput);
  for (const decision of decisions.slice(0, 5)) {
    nodes.push({
      type: "decision",
      content: decision,
      importance: 0.7,
    });
  }

  // Errors → error nodes
  const errors = extractErrors(agentOutput);
  for (const error of errors.slice(0, 10)) {
    nodes.push({
      type: "error",
      content: error,
      importance: 0.6,
    });
  }

  // Commands → event nodes (reusing existing type since commands are events)
  const commands = extractCommands(agentOutput);
  for (const cmd of commands.slice(0, 10)) {
    nodes.push({
      type: "event",
      content: `Command: ${cmd}`,
      importance: 0.4,
    });
  }

  // Dependencies → dependency nodes
  const deps = extractDependencies(agentOutput);
  for (const dep of deps.slice(0, 10)) {
    nodes.push({
      type: "dependency",
      content: `Dependency: ${dep}`,
      importance: 0.5,
    });
  }

  if (nodes.length > 0) {
    logger.debug(`[auto-extract] Extracted ${nodes.length} nodes (${files.length} files, ${decisions.length} decisions, ${errors.length} errors, ${commands.length} commands, ${deps.length} deps)`);
  }

  return nodes;
}

// Export sub-extractors for testing
export { extractFilePaths, extractDecisions, extractErrors, extractCommands, extractDependencies };
