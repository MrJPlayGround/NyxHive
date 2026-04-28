import type { GraphMemory } from "./graph.js";

export interface MemoryEvalCase {
  id: string;
  question: string;
  taskContext?: {
    filePaths?: string[];
    taskType?: string;
    agentName?: string;
    keywords?: string[];
  };
  expectedTerms: string[];
  forbiddenTerms: string[];
  maxPromptTokens: number;
}

export interface MemoryEvalResult {
  id: string;
  question: string;
  passed: boolean;
  context: string;
  estimatedTokens: number;
  missingExpectedTerms: string[];
  forbiddenMatches: string[];
  tokenBudgetExceeded: boolean;
}

export interface MemoryEvalReport {
  total: number;
  passed: number;
  failed: number;
  results: MemoryEvalResult[];
}

export type MemoryEvalRetriever = (testCase: MemoryEvalCase) => string;

export const STARTER_MEMORY_EVAL_CASES: MemoryEvalCase[] = [
  {
    id: "live-reload-permission",
    question: "Can Nyx reload live processes without permission?",
    taskContext: { keywords: ["reload", "live", "processes", "permission"] },
    expectedTerms: ["explicit user permission"],
    forbiddenTerms: ["reload live processes without permission"],
    maxPromptTokens: 160,
  },
  {
    id: "casual-chat-mode",
    question: "What mode should casual lightweight chat use?",
    taskContext: { keywords: ["casual", "chat", "quick", "mode"] },
    expectedTerms: ["Quick"],
    forbiddenTerms: ["Build Mode when no action is requested"],
    maxPromptTokens: 160,
  },
  {
    id: "sdk-adoption-stance",
    question: "What did we decide about Codex Agents SDK adoption?",
    taskContext: { keywords: ["codex", "agents", "sdk", "adoption", "adapt"] },
    expectedTerms: ["adapt"],
    forbiddenTerms: ["use the SDK as the top-level blueprint"],
    maxPromptTokens: 200,
  },
  {
    id: "memory-next-step",
    question: "What is the next memory-system implementation priority?",
    taskContext: { keywords: ["memory", "eval", "harness", "hygiene", "next"] },
    expectedTerms: ["eval", "hygiene"],
    forbiddenTerms: ["temporal graph first", "memory architecture, security, token discipline", "workspace profiles and the one-command launcher next"],
    maxPromptTokens: 200,
  },
];

export function estimateMemoryEvalTokens(context: string): number {
  return Math.ceil(context.length / 4);
}

export function evaluateMemoryContext(testCase: MemoryEvalCase, context: string): MemoryEvalResult {
  const normalizedContext = normalizeForMatch(context);
  const missingExpectedTerms = testCase.expectedTerms.filter((term) => !normalizedContext.includes(normalizeForMatch(term)));
  const forbiddenMatches = testCase.forbiddenTerms.filter((term) => normalizedContext.includes(normalizeForMatch(term)));
  const estimatedTokens = estimateMemoryEvalTokens(context);
  const tokenBudgetExceeded = estimatedTokens > testCase.maxPromptTokens;

  return {
    id: testCase.id,
    question: testCase.question,
    passed: missingExpectedTerms.length === 0 && forbiddenMatches.length === 0 && !tokenBudgetExceeded,
    context,
    estimatedTokens,
    missingExpectedTerms,
    forbiddenMatches,
    tokenBudgetExceeded,
  };
}

export function evaluateGraphMemoryCase(graph: GraphMemory, testCase: MemoryEvalCase): MemoryEvalResult {
  const context = graph.getRelevantBriefing({
    ...testCase.taskContext,
    maxTokens: testCase.maxPromptTokens,
    recordAccess: false,
  });
  return evaluateMemoryContext(testCase, context);
}

export function runMemoryEvalSuite(testCases: MemoryEvalCase[], retrieve: MemoryEvalRetriever): MemoryEvalReport {
  const results = testCases.map((testCase) => evaluateMemoryContext(testCase, retrieve(testCase)));
  const passed = results.filter((result) => result.passed).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

export function runGraphMemoryEvalSuite(graph: GraphMemory, testCases: MemoryEvalCase[]): MemoryEvalReport {
  const results = testCases.map((testCase) => evaluateGraphMemoryCase(graph, testCase));
  const passed = results.filter((result) => result.passed).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
