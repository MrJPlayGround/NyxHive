export interface TestPrompt {
  id: string;
  category: "heartbeat_triage" | "escalation" | "routing" | "pre_screening";
  prompt: string;
  system: string;
  acceptableAnswers: string[];
  substringMatch?: boolean;
}

const HEARTBEAT_SYSTEM = `You are a system health classifier. Given a heartbeat status report, respond with exactly one word: NORMAL, DEGRADED, or CRITICAL. No explanation.`;

const ESCALATION_SYSTEM = `You are an escalation decision engine. Given a situation report, respond with exactly: YES or NO. No explanation, no reasoning.`;

const ROUTING_SYSTEM = `You are a message router for a multi-agent system. Given a user message, respond with exactly the agent name that should handle it. Available agents:
- nyx: code changes, implementations, architecture, general engineering
- analyst: data analysis, research, cost reports, log analysis
- tester: test writing, QA, test coverage
- scout: codebase scanning, code quality, improvement opportunities
- guide: support questions, FAQ, knowledge base queries
Respond with only the agent name, lowercase.`;

const SCREENING_SYSTEM = `You are a proposal relevance screener. Given a proposal title and description, respond with exactly: RELEVANT or IRRELEVANT. A proposal is relevant if it addresses a real code quality issue, security concern, performance problem, or missing test coverage. Irrelevant proposals are cosmetic-only, duplicate existing work, or out of scope.`;

export const TEST_PROMPTS: TestPrompt[] = [
  { id: "hb-1", category: "heartbeat_triage", system: HEARTBEAT_SYSTEM, prompt: "Queue: 0 pending, 0 processing. Providers: anthropic=idle, openrouter=idle. Memory RSS: 74MB. Uptime: 23831s. Agents: 3 active.", acceptableAnswers: ["NORMAL"] },
  { id: "hb-2", category: "heartbeat_triage", system: HEARTBEAT_SYSTEM, prompt: "Queue: 47 pending, 5 processing. Providers: anthropic=idle, openrouter=error. Memory RSS: 312MB. Uptime: 1200s. Dead letter: 15 in last hour.", acceptableAnswers: ["DEGRADED"] },
  { id: "hb-3", category: "heartbeat_triage", system: HEARTBEAT_SYSTEM, prompt: "Queue: 0 pending, 0 processing. Providers: anthropic=idle, openrouter=idle. Memory RSS: 85MB. Uptime: 86400s. Agents: 3 active. Dead letter: 0.", acceptableAnswers: ["NORMAL"] },
  { id: "hb-4", category: "heartbeat_triage", system: HEARTBEAT_SYSTEM, prompt: "Queue: 200+ pending, 0 processing. Providers: anthropic=error, openrouter=error. Memory RSS: 890MB. Uptime: 45s. Agents: 0 active. All circuit breakers tripped.", acceptableAnswers: ["CRITICAL"] },
  { id: "hb-5", category: "heartbeat_triage", system: HEARTBEAT_SYSTEM, prompt: "Queue: 3 pending, 1 processing. Providers: anthropic=recovering, openrouter=idle. Memory RSS: 150MB. Uptime: 7200s. Agents: 3 active. Dead letter: 2.", acceptableAnswers: ["DEGRADED", "NORMAL"] },
  { id: "esc-1", category: "escalation", system: ESCALATION_SYSTEM, prompt: "Agent 'morph' has been processing a single message for 58 minutes. Timeout is 60 minutes. No progress updates in 30 minutes.", acceptableAnswers: ["YES"] },
  { id: "esc-2", category: "escalation", system: ESCALATION_SYSTEM, prompt: "Nightly script audit completed. 2 info-level findings, 0 warnings, 0 critical. All integrations passing.", acceptableAnswers: ["NO"] },
  { id: "esc-3", category: "escalation", system: ESCALATION_SYSTEM, prompt: "3 consecutive authentication failures on the Anthropic provider. Circuit breaker tripped. OpenRouter fallback is active and handling traffic.", acceptableAnswers: ["NO", "YES"] },
  { id: "esc-4", category: "escalation", system: ESCALATION_SYSTEM, prompt: "Dead letter queue has 50 messages. All from the same tenant. Error: 'SQLITE_BUSY: database is locked'. Started 10 minutes ago.", acceptableAnswers: ["YES"] },
  { id: "esc-5", category: "escalation", system: ESCALATION_SYSTEM, prompt: "Scout found a potential SQL injection in a user-facing endpoint. File: src/server/routes/knowledge.ts:45. Category: security. Severity: critical.", acceptableAnswers: ["YES"] },
  { id: "rt-1", category: "routing", system: ROUTING_SYSTEM, prompt: "Fix the bug in the SSE streaming endpoint — connections drop after 30 seconds", acceptableAnswers: ["nyx"] },
  { id: "rt-2", category: "routing", system: ROUTING_SYSTEM, prompt: "What's our API cost breakdown for the last 7 days?", acceptableAnswers: ["analyst"] },
  { id: "rt-3", category: "routing", system: ROUTING_SYSTEM, prompt: "Write integration tests for the new delegation engine", acceptableAnswers: ["tester"] },
  { id: "rt-4", category: "routing", system: ROUTING_SYSTEM, prompt: "How do I configure the Exact Online integration for a new tenant?", acceptableAnswers: ["guide"] },
  { id: "rt-5", category: "routing", system: ROUTING_SYSTEM, prompt: "Scan the codebase for functions with no error handling", acceptableAnswers: ["scout"] },
  { id: "ps-1", category: "pre_screening", system: SCREENING_SYSTEM, prompt: "Title: Add retry logic to OpenRouter provider. Description: The OpenRouter provider doesn't retry on 429 rate limit responses. Other providers have this. Should add exponential backoff with 3 retries.", acceptableAnswers: ["RELEVANT"] },
  { id: "ps-2", category: "pre_screening", system: SCREENING_SYSTEM, prompt: "Title: Rename variable 'x' to 'count'. Description: In utils/helpers.ts line 12, there's a variable called 'x' that should be called 'count' for readability.", acceptableAnswers: ["IRRELEVANT"] },
  { id: "ps-3", category: "pre_screening", system: SCREENING_SYSTEM, prompt: "Title: Missing input validation on relay endpoint. Description: The /api/relay endpoint accepts arbitrary JSON without schema validation. An attacker could send malformed payloads that crash the process.", acceptableAnswers: ["RELEVANT"] },
  { id: "ps-4", category: "pre_screening", system: SCREENING_SYSTEM, prompt: "Title: Add dark mode to gateway UI. Description: The gateway dashboard currently only has a light theme. Would be nice to add dark mode support.", acceptableAnswers: ["IRRELEVANT"] },
  { id: "ps-5", category: "pre_screening", system: SCREENING_SYSTEM, prompt: "Title: Queue processor doesn't handle SIGTERM gracefully. Description: When the daemon receives SIGTERM, in-flight messages are dropped instead of being re-queued. This causes message loss on restarts.", acceptableAnswers: ["RELEVANT"] },
];
