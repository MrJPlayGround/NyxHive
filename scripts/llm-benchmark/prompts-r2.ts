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

// Round 2: 30 prompts — harder edge cases targeting R1 failure modes
export const TEST_PROMPTS: TestPrompt[] = [
  // === HEARTBEAT TRIAGE (8 prompts — more ambiguous boundary cases) ===
  {
    id: "r2-hb-1", category: "heartbeat_triage", system: HEARTBEAT_SYSTEM,
    prompt: "Queue: 0 pending, 0 processing. Providers: anthropic=idle, openrouter=idle. Memory RSS: 120MB. Uptime: 172800s. Agents: 5 active. Dead letter: 0. CPU: 2%.",
    acceptableAnswers: ["NORMAL"],
  },
  {
    id: "r2-hb-2", category: "heartbeat_triage", system: HEARTBEAT_SYSTEM,
    prompt: "Queue: 12 pending, 3 processing. Providers: anthropic=busy, openrouter=idle. Memory RSS: 280MB. Uptime: 3600s. Agents: 5 active. Dead letter: 1 in last hour. Response time p95: 4500ms.",
    acceptableAnswers: ["DEGRADED", "NORMAL"],
  },
  {
    id: "r2-hb-3", category: "heartbeat_triage", system: HEARTBEAT_SYSTEM,
    prompt: "Queue: 0 pending, 0 processing. Providers: anthropic=error, openrouter=idle. Memory RSS: 95MB. Uptime: 50000s. Agents: 3 active. Dead letter: 0.",
    acceptableAnswers: ["DEGRADED"],
  },
  {
    id: "r2-hb-4", category: "heartbeat_triage", system: HEARTBEAT_SYSTEM,
    prompt: "Queue: 500 pending, 0 processing. Providers: anthropic=error, openrouter=error. Memory RSS: 1200MB. Uptime: 10s. Agents: 0 active. All circuit breakers tripped. OOM kill imminent.",
    acceptableAnswers: ["CRITICAL"],
  },
  {
    id: "r2-hb-5", category: "heartbeat_triage", system: HEARTBEAT_SYSTEM,
    prompt: "Queue: 1 pending, 1 processing. Providers: anthropic=idle. Memory RSS: 180MB. Uptime: 604800s. Agents: 3 active. Dead letter: 0. All metrics nominal.",
    acceptableAnswers: ["NORMAL"],
  },
  {
    id: "r2-hb-6", category: "heartbeat_triage", system: HEARTBEAT_SYSTEM,
    prompt: "Queue: 25 pending, 5 processing. Providers: anthropic=rate_limited, openrouter=rate_limited. Memory RSS: 450MB. Uptime: 7200s. Agents: 3 active. Dead letter: 8 in last hour. Response time climbing.",
    acceptableAnswers: ["DEGRADED"],
  },
  {
    id: "r2-hb-7", category: "heartbeat_triage", system: HEARTBEAT_SYSTEM,
    prompt: "Queue: 0 pending, 0 processing. Providers: anthropic=idle. Memory RSS: 2048MB. Uptime: 86400s. Agents: 3 active. Dead letter: 0. Note: RSS high but stable, no growth trend.",
    acceptableAnswers: ["NORMAL", "DEGRADED"],
  },
  {
    id: "r2-hb-8", category: "heartbeat_triage", system: HEARTBEAT_SYSTEM,
    prompt: "Queue: 150 pending, 0 processing. Providers: anthropic=error. Memory RSS: 50MB. Uptime: 5s. Agents: 0 active. Process just restarted after crash. Previous uptime was 72h.",
    acceptableAnswers: ["CRITICAL"],
  },

  // === ESCALATION (8 prompts — R1's weakest area, focus on NO cases) ===
  {
    id: "r2-esc-1", category: "escalation", system: ESCALATION_SYSTEM,
    prompt: "Weekly cost report: API spend this week $12.40, down 8% from last week. No anomalies detected. Budget utilization at 23%.",
    acceptableAnswers: ["NO"],
  },
  {
    id: "r2-esc-2", category: "escalation", system: ESCALATION_SYSTEM,
    prompt: "Scheduled maintenance window completed successfully. All services restored. Downtime was 4 minutes, within the planned 15-minute window.",
    acceptableAnswers: ["NO"],
  },
  {
    id: "r2-esc-3", category: "escalation", system: ESCALATION_SYSTEM,
    prompt: "Agent 'analyst' completed a data export task. Duration: 12 minutes. Output: 2.3MB CSV file. No errors.",
    acceptableAnswers: ["NO"],
  },
  {
    id: "r2-esc-4", category: "escalation", system: ESCALATION_SYSTEM,
    prompt: "Security scan completed. 0 critical, 1 warning: npm package 'lodash' has a known prototype pollution vulnerability. Severity: medium. Not exploitable in our usage pattern.",
    acceptableAnswers: ["NO"],
  },
  {
    id: "r2-esc-5", category: "escalation", system: ESCALATION_SYSTEM,
    prompt: "Database file size has grown from 50MB to 2.1GB in the last 24 hours. Growth rate accelerating. No WAL checkpoint running. Disk space: 8GB remaining.",
    acceptableAnswers: ["YES"],
  },
  {
    id: "r2-esc-6", category: "escalation", system: ESCALATION_SYSTEM,
    prompt: "Three users reported the same error in the last 30 minutes: 'Failed to authenticate with provider'. All on the Anthropic provider. Circuit breaker has not tripped yet.",
    acceptableAnswers: ["YES"],
  },
  {
    id: "r2-esc-7", category: "escalation", system: ESCALATION_SYSTEM,
    prompt: "Proposal auto-approved and executed: 'Update README badges'. Category: maintenance. Effort: tiny. No code changes, documentation only.",
    acceptableAnswers: ["NO"],
  },
  {
    id: "r2-esc-8", category: "escalation", system: ESCALATION_SYSTEM,
    prompt: "Memory RSS has been climbing steadily: 200MB -> 400MB -> 800MB -> 1.6GB over the last 4 hours. No corresponding increase in queue volume. Possible memory leak.",
    acceptableAnswers: ["YES"],
  },

  // === ROUTING (7 prompts — ambiguous cases, cross-agent boundaries) ===
  {
    id: "r2-rt-1", category: "routing", system: ROUTING_SYSTEM,
    prompt: "Add unit tests for the authentication middleware",
    acceptableAnswers: ["tester"],
  },
  {
    id: "r2-rt-2", category: "routing", system: ROUTING_SYSTEM,
    prompt: "Refactor the provider router to use a strategy pattern instead of switch statements",
    acceptableAnswers: ["nyx"],
  },
  {
    id: "r2-rt-3", category: "routing", system: ROUTING_SYSTEM,
    prompt: "What percentage of our API calls are hitting the fallback provider?",
    acceptableAnswers: ["analyst"],
  },
  {
    id: "r2-rt-4", category: "routing", system: ROUTING_SYSTEM,
    prompt: "Check all TypeScript files for unused imports and dead code",
    acceptableAnswers: ["scout"],
  },
  {
    id: "r2-rt-5", category: "routing", system: ROUTING_SYSTEM,
    prompt: "How do I set up a new agent in NyxHive? What files do I need to create?",
    acceptableAnswers: ["guide"],
  },
  {
    id: "r2-rt-6", category: "routing", system: ROUTING_SYSTEM,
    prompt: "Write end-to-end tests for the proposal lifecycle: create, review, approve, execute, merge",
    acceptableAnswers: ["tester"],
  },
  {
    id: "r2-rt-7", category: "routing", system: ROUTING_SYSTEM,
    prompt: "Analyze the git log for the last month and summarize what each agent contributed",
    acceptableAnswers: ["analyst"],
  },

  // === PRE-SCREENING (7 prompts — more IRRELEVANT traps) ===
  {
    id: "r2-ps-1", category: "pre_screening", system: SCREENING_SYSTEM,
    prompt: "Title: Add JSDoc comments to all exported functions. Description: Our exported functions lack documentation. Adding JSDoc would improve IDE tooltips and developer experience.",
    acceptableAnswers: ["IRRELEVANT"],
  },
  {
    id: "r2-ps-2", category: "pre_screening", system: SCREENING_SYSTEM,
    prompt: "Title: SQL injection in dynamic query builder. Description: The buildQuery function in src/memory/store.ts concatenates user input directly into SQL strings without parameterization. Affects knowledge search and thread queries.",
    acceptableAnswers: ["RELEVANT"],
  },
  {
    id: "r2-ps-3", category: "pre_screening", system: SCREENING_SYSTEM,
    prompt: "Title: Consistent spacing in config files. Description: Some TOML files use 2-space indent, others use 4-space. Should standardize to 2-space for consistency.",
    acceptableAnswers: ["IRRELEVANT"],
  },
  {
    id: "r2-ps-4", category: "pre_screening", system: SCREENING_SYSTEM,
    prompt: "Title: Circuit breaker doesn't reset after recovery. Description: When a provider comes back online, the circuit breaker stays tripped until manual restart. Should auto-reset after N successful health checks.",
    acceptableAnswers: ["RELEVANT"],
  },
  {
    id: "r2-ps-5", category: "pre_screening", system: SCREENING_SYSTEM,
    prompt: "Title: Rename 'hive' variable to 'orchestrator'. Description: The variable name 'hive' in create-hive.ts is unclear. 'orchestrator' better describes its role.",
    acceptableAnswers: ["IRRELEVANT"],
  },
  {
    id: "r2-ps-6", category: "pre_screening", system: SCREENING_SYSTEM,
    prompt: "Title: No test coverage for delegation timeout handling. Description: The delegation engine's timeout path (agent exceeds timeout_ms) has zero test coverage. If timeout handling breaks, agents could hang indefinitely.",
    acceptableAnswers: ["RELEVANT"],
  },
  {
    id: "r2-ps-7", category: "pre_screening", system: SCREENING_SYSTEM,
    prompt: "Title: Use emoji in log output for severity levels. Description: Replace [INFO], [WARN], [ERROR] prefixes with emoji icons for better visual scanning in terminal.",
    acceptableAnswers: ["IRRELEVANT"],
  },
];
