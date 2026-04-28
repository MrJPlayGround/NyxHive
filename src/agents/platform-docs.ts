import type { NyxHiveConfig, } from "../types.js";
import type { AgentRegistry } from "./registry.js";
import { getModelTier, } from "../defaults.js";
import type { Scheduler } from "../scheduler/index.js";
import type { MemoryStore } from "../memory/store.js";
import { VAULT_CURRENT_STATE_GUIDANCE } from "./current-state-guidance.js";

/**
 * Generate full platform documentation for an agent's workspace.
 * CLI-invoked agents can read this file to understand the platform.
 */
export function generateWorkspaceDocs(config: NyxHiveConfig, agentKey: string, registry?: AgentRegistry, scheduler?: Scheduler, memory?: MemoryStore): string {
  const agent = registry?.get(agentKey) ?? config.agents[agentKey];
  if (!agent) {
    // Runtime-created agent not in registry or config — generate minimal docs
    return `# Platform\n\nYou are **${agentKey}**, running on a NyxHive self-improving personal runtime.\n`;
  }
  const allAgents = registry
    ? Object.entries(registry.getAll())
    : Object.entries(config.agents);
  const teams = Object.entries(config.teams ?? {});
  const channels = getActiveChannels(config);

  return `# ${config.daemon.name} Platform

You are **${agent.name}**, running on **${config.daemon.name}** — a self-improving personal runtime with multi-agent lanes when delegation adds leverage.

## Your Configuration
- **Agent key:** ${agentKey}
- **Provider:** ${agent.provider}
- **Model:** ${agent.model}
- **Workspace:** ${agent.working_directory}
${agent.cli_fallback ? `- **CLI fallback:** ${agent.cli_fallback}` : ""}

## Platform Architecture

NyxHive is a single-process Bun + TypeScript self-improving personal runtime. Messages arrive from channels (Telegram, Discord, HTTP API), get routed through the runtime, and responses are sent back through the same channel. Delegation exists as a lane for specialist work, not as the product's only shape.

\`\`\`
Channels (Telegram / Discord / HTTP API)
  → SQLite Message Queue
    → Queue Processor (claims messages per agent)
      → Agent Invocation (Client SDK or CLI based on task complexity)
        → Response Queue
          → Channel delivers response
\`\`\`

### Invocation Strategy
- **Simple messages → Client SDK:** Greetings, Q&A, conversation — direct API calls, fast and cheap
- **Complex tasks → CLI:** Coding, analysis, expert tasks — Claude Code CLI with full tool access
- **Classification:** Messages are classified locally (regex) to pick the right path

## Active Channels
${channels.length > 0 ? channels.map((c) => `- **${c}**`).join("\n") : "- HTTP API only"}
${formatDiscordRuntimeNotes(config)}

### Trust Model
- One trusted operator boundary owns privileged runtime work.
- Paired DMs are the normal surface for memory writes, reminders, file changes, and other explicit side effects.
- Public channels stay public-safe: answer lightly, avoid privileged actions, and do not pretend public chat is a paired operator session.

### Chat Commands (available in Telegram/Discord/Slack)
- \`/start\` — Check if bot is online, list agents
- \`/agent\` — List all agents and their models
- \`/model\` — View current models for all agents
- \`/model <name>\` — Switch model (aliases: haiku, sonnet, opus, flash, pro)
- \`/model <agent>:<name>\` — Switch model for a specific agent
- \`/model reset\` — Revert to configured default model
- \`/crawl <url>\` — Crawl a site into knowledge (supports \`--save\`, \`--scope\`, \`--depth\`, \`--limit\`, \`--glob\`, \`--schedule\`)
- \`/cancel\` — Cancel the currently running task
- \`/usage\` — Queue statistics
- \`/reset\` — Clear conversation context
- \`/setup\` — Channel setup menu
- \`/setup discord\` — Discord setup instructions
- \`/setup discord <token>\` — Attach Discord with a bot token (validates, saves config, starts the bot)
- \`/setup status\` — Show active channels

### Setting Up Discord
If someone asks about Discord setup, guide them through these steps:
1. Go to https://discord.com/developers/applications
2. Click "New Application", name it, click Create
3. Go to "Bot" in the left sidebar, click "Reset Token", copy the token
4. Under "Privileged Gateway Intents", enable **Message Content Intent**
5. Run: \`/setup discord <the-bot-token>\`
6. The system validates the token, saves it to config, and starts the Discord channel live
7. Use the invite URL returned to add the bot to a Discord server
8. In Discord, @mention the bot or DM it to chat. Slash commands (/agent, /model, /usage, /reset) also work.

## Agents
${allAgents.map(([key, a]) => `- **${a.name}** (\`@${key}\`): ${a.provider}/${a.model}${a.capabilities?.length ? ` [${a.capabilities.join(", ")}]` : ""}${a.cli_fallback ? ` (CLI: ${a.cli_fallback})` : ""}`).join("\n")}

${allAgents.length > 1 ? `### Delegation (Actor Model)
You can delegate tasks to other agents using the mention syntax: \`[@agent_key: task description]\`

Example: \`[@analyst: Find documentation on React Server Components]\`

Multiple delegations can be included in a single response. Subtasks are processed automatically and results are assembled into the final response.` : ""}

${teams.length > 0 ? `## Teams\n${teams.map(([key, t]) => `- **${t.name}** (\`@${key}\`): ${t.agents.join(" → ")}${t.description ? ` — ${t.description}` : ""}`).join("\n")}

Teams process messages through a chain of agents in sequence, each building on the previous agent's output.` : ""}

## Built-in Systems

### Memory & Conversation History
- Conversations are tracked per-sender with sliding window context
- Memories can be stored and retrieved via FTS5 full-text search
- Usage and costs are tracked per-model, per-agent

### Knowledge Base (Obsidian Vault)
${config.vault?.path ? `- **Vault path:** \`${config.vault.path}\`
- You have full read/write access to this Obsidian vault — use it as your long-term memory
- Read notes with the Read tool, write/update notes with Write or Edit tools
- Search vault content with Grep or Glob (\`**/*.md\`)
- Relevant vault content is also automatically injected via RAG (vector search)

#### Vault Conventions
- **Structure:** Areas/, Projects/, Resources/, Learnings/, Daily/, Templates/
- **Format:** Markdown with YAML frontmatter, wikilinks (\`[[note]]\`) for cross-references
- **When you learn something worth remembering:** Write or update a note in the vault
${VAULT_CURRENT_STATE_GUIDANCE}
- **Daily notes:** \`Daily/YYYY-MM-DD.md\` — use for session logs, task tracking
- **New knowledge:** Create in the appropriate category folder with descriptive filenames` : `- Obsidian vault ingestion via \`nyxhive ingest <vault-path>\`
- Vector embeddings stored in SQLite with cosine similarity search
- Relevant knowledge is automatically injected into agent context`}

### Sender Pairing
${config.pairing?.enabled ? "- **Enabled** — new senders must be approved before they can chat\n- Approve via CLI: `nyxhive pairing approve <code>`\n- Or via API: `POST /api/pairing/approve { \"code\": \"<code>\" }`" : "- Disabled"}

## HTTP API
- Public probes: \`GET /health\`, \`GET /api/info\`, \`GET /api/auth/status\`
- Messaging: \`POST /api/message\`, \`GET /api/message/:id\`, \`GET /api/events\`, \`GET /api/responses/pending\`
- Coordination: \`/api/agents\`, \`/api/teams\`, \`/api/proposals\`, \`/api/tasks\`, \`/api/devices\`, \`/api/threads\`, \`/api/projects\`
- Memory and knowledge: \`/api/memory\`, \`/api/memory/graph\`, \`/api/memory/bank\`, \`/api/knowledge/search|federated-search|ingest|canvas\`
- Ops: \`/api/queue\`, \`/api/scheduler\`, \`/api/status\`, \`/api/logs\`, \`/api/usage\`, \`/api/traces\`, \`/api/settings\`, \`/api/channels\`, \`/api/setup/status\`
- Gateway WebSocket: \`ws://<host>/ws\` with typed RPC families like \`chat.*\`, \`threads.*\`, \`proposals.*\`, \`scheduler.*\`, and \`devices.*\`
- Server runs on port **${config.server.port}**

## CLI Management
- \`nyxhive start\` — Start the daemon
- \`nyxhive stop\` — Stop the daemon
- \`nyxhive status\` — Check if running
- \`nyxhive logs\` — Tail logs
- \`nyxhive list\` — List instances
- \`nyxhive pairing list/approve/reject\` — Manage sender pairing
- \`nyxhive ingest <vault-path>\` — Ingest Obsidian vault into knowledge base
- \`nyxhive setup\` — Interactive setup wizard

## Config Location
- Default instance: \`~/.nyxhive/config.toml\`
- Named instances: \`~/.nyxhive/instances/<name>/config.toml\`

## Adding Features
When asked to add features or modify the platform, the source code is a Bun + TypeScript project. Key directories:
- \`src/channels/\` — Channel implementations (Telegram, Discord)
- \`src/agents/\` — Agent invocation and routing
- \`src/queue/\` — SQLite message queue and processor
- \`src/providers/\` — LLM provider integrations (Anthropic, OpenRouter, MiniMax)
- \`src/memory/\` — Memory store, knowledge base, embeddings
- \`src/server/\` — HTTP API (Hono framework)
- \`src/pairing/\` — Sender approval system

${generateLeadContext(agentKey, registry, scheduler, memory, config)}
`;
}

/**
 * Generate condensed platform context for SDK system prompt injection.
 * Kept short to save tokens — agents get the gist, not the full docs.
 */
export function generatePlatformContext(config: NyxHiveConfig, agentKey: string, registry?: AgentRegistry): string {
  const agent = registry?.get(agentKey) ?? config.agents[agentKey];
  if (!agent) {
    return `[Platform: ${config.daemon.name} — self-improving personal runtime (NyxHive), Bun + TypeScript]\n[You are ${agentKey}, running on ${config.daemon.name}]`;
  }
  const allAgents = registry
    ? Object.entries(registry.getAll())
    : Object.entries(config.agents);
  const channels = getActiveChannels(config);

  const otherAgents = allAgents
    .filter(([k]) => k !== agentKey)
    .map(([k, a]) => {
      const caps = a.capabilities?.length ? ` [${a.capabilities.join(", ")}]` : "";
      return `${a.name} (@${k})${caps}`;
    })
    .join(", ");

  const lines = [
    `[Platform: ${config.daemon.name} — self-improving personal runtime (NyxHive), Bun + TypeScript]`,
    `[You are ${agent.name} (${agent.provider}/${agent.model}), running on ${config.daemon.name}]`,
    `[Channels: ${channels.join(", ") || "HTTP API"}]`,
  ];

  if (otherAgents) {
    lines.push(`[Other agents: ${otherAgents}]`);
    if (allAgents.length > 1) {
      if (agent.role === "lead") {
        lines.push("[Delegation: use [@agent_key: task] when a specialist clearly adds leverage. As the repo lead, you keep the conversation, implementation ownership, and final call.]");
      } else if (agent.role === "orchestrator") {
        lines.push("[Delegation: use [@agent_key: task] to delegate. As a pure orchestrator, coordinate work through specialists and avoid direct implementation.]");
      } else {
        lines.push("[Delegation: use [@agent_key: task] when another agent clearly adds leverage on a bounded subtask.]");
      }
    }
  }

  if (config.vault?.path) {
    lines.push(`[Obsidian vault: ${config.vault.path} — your long-term memory. Read/write notes freely.]`);
  }

  lines.push(
    `[When asked about platform features, refer to NyxHive's built-in capabilities — don't suggest external tools or building from scratch]`,
  );
  lines.push(
    `[Trust model: one trusted operator boundary, paired DMs for explicit side effects, public channels stay public-safe]`,
  );

  return lines.join("\n");
}

/**
 * Generate lead operating context: agent management, team table, scheduling, alerts, budget.
 * Included for top-level leads and pure orchestrators.
 */
function generateLeadContext(agentKey: string, registry?: AgentRegistry, scheduler?: Scheduler, memory?: MemoryStore, config?: NyxHiveConfig): string {
  if (!registry) return "";

  const entry = registry.getEntry(agentKey);
  if (!entry || (entry.role !== "orchestrator" && entry.role !== "lead")) return "";
  const isLead = entry.role === "lead";

  const sections: string[] = [];

  // Agent Management
  sections.push(`## Agent Management

You manage the agent team. Use these actions in your responses:

| Action | Syntax | Example |
|--------|--------|---------|
| Hire | \`[@hire: key=<k> name="<n>" prompt="<p>"]\` | \`[@hire: key=data name="Data Analyst" prompt="You analyze data..."]\` |
| Fire | \`[@fire: <key>]\` | \`[@fire: data]\` |
| Reassign | \`[@reassign: <key> model=<m>]\` | \`[@reassign: data model=qwen/qwen3-235b-a22b-2507]\` |
| Team | \`[@team: <name> agents=<a,b,c>]\` | \`[@team: research agents=analyst,data]\` |

New agents default to deepseek/deepseek-v3.2 via OpenRouter (cheap). Upgrade only if quality is insufficient.
Config-defined agents (created_by=config) cannot be fired.`);

  // Delegation Policy
  sections.push(`## Delegation Policy

**${isLead
    ? "You are the lead for this instance. Own the conversation and final call. Delegate specialist work when it adds leverage; do not hide behind routing."
    : "You are the coordinator for this instance. Keep the conversation and routing layer clear, and delegate implementation to the right specialist."}**

### Routing Table
| Task Type | Delegate To | When to Handle Yourself |
|-----------|-------------|------------------------|
| ${isLead ? "Code in your home repo" : "Code (write/debug/review/refactor)"} | ${isLead ? "—" : "@coder / specialist"} | ${isLead ? "Usually you implement it directly" : "Delegate unless the response is pure coordination"} |
| Research (look up, explore, find) | @analyst | Delegate when source-gathering depth adds value |
| Data analysis (metrics, reports) | @analyst | Delegate when the work is broad or evidence-heavy |
| Testing (run tests, validate) | @tester | Delegate for broad QA, explicit verification asks, or large change sets |
| Conversation with User | — | Always — repo leads keep the relationship layer |
| Planning / decomposition | — | Always — you set direction and sequence |
| Multi-agent coordination | — | When the task genuinely needs multiple agents |

### Delegation Patterns
- **Single task:** \`[@analyst: research best auth patterns for Bun APIs]\`
- **Multi-agent:** \`[@analyst: find best auth patterns] [@tester: validate the JWT implementation]\`
- **Sequential:** ${isLead ? "Research first, then implement the repo-owned change yourself" : "Research first, then hand implementation to the right specialist"}

### Anti-Patterns (Don't Do This)
- ${isLead ? "Delegating the whole request just to avoid owning it" : "Pretending to own repo decisions that belong to a lead or specialist"}
- Acting like a neutral router with no repo opinion
- Creating a fake chain of command above other leads`);

  // Current Team Table
  const allEntries = registry.getAllEntries(true);
  const teamRows: string[] = [];

  for (const [key, e] of allEntries) {
    const tier = getModelTier(e.model);
    const tierLabel = tier === 4 ? "top" : tier === 3 ? "premium" : tier === 2 ? "mid" : "cheap";
    const status = !e.enabled ? "disabled" : !e.last_invoked_at ? "idle" : "active";
    const delegationRate = e.delegation_expected > 0
      ? `${Math.round((e.delegation_actual / e.delegation_expected) * 100)}%`
      : "N/A";
    teamRows.push(`| ${key} | ${e.model} | ${tier} (${tierLabel}) | ${e.role} | ${e.total_invocations} | ${delegationRate} | ${status} |`);
  }

  sections.push(`## Current Team

| Agent | Model | Tier | Role | Invocations | Delegation Rate | Status |
|-------|-------|------|------|-------------|-----------------|--------|
${teamRows.join("\n")}`);

  // Available Models
  sections.push(`## Available Models

| Tier | Model | Cost/M | Good For |
|------|-------|--------|----------|
| Cheap | deepseek/deepseek-v3.2 | $0.26/$0.38 | Classification, summarization, research |
| Cheap | openai/gpt-oss-120b | $0.039/$0.19 | Memory extraction, general tasks |
| Cheap | qwen3-235b | $0.07/$0.10 | Conversation, general tasks |
| Mid | xiaomi/mimo-v2-flash | $0.15/$0.60 | Moderate analysis, long context |
| Premium | claude-sonnet-4-6 | $3/$15 | Coding, analysis, review |
| Top | claude-opus-4-6 | $5/$25 | Expert, orchestration |

## Cost Guidelines
- Reserve premium+ models for leads and hard reasoning tasks
- Default new hires to gemini-2.5-flash-lite via OpenRouter — cheap and handles most tasks
- If an agent is idle for 7+ days, consider firing it
- If a cheap agent keeps failing, consider upgrading its model before firing`);

  // Scheduling
  sections.push(`## Scheduling

You can create and manage scheduled tasks. Use these in your responses:

### Schedule a recurring task
\`[@schedule: name="<name>" cron="<cron>" agent=<key> prompt="<what to do>"]\`

### Schedule a one-time task
\`[@schedule: name="<name>" run_at=<timestamp_ms> agent=<key> prompt="<what to do>"]\`

### Remove a schedule
\`[@unschedule: <name>]\`

### Cron syntax (5-field)
minute hour day-of-month month day-of-week
Examples:
- \`0 9 * * *\` - daily at 9 AM
- \`*/30 * * * *\` - every 30 minutes
- \`0 9 * * 1\` - every Monday at 9 AM`);

  // Active schedules from scheduler
  if (scheduler) {
    const tasks = scheduler.listTasks(false);
    if (tasks.length > 0) {
      const scheduleRows = tasks.map(t => {
        const lastRun = t.last_run_at ? new Date(t.last_run_at).toISOString().slice(0, 16).replace("T", " ") : "never";
        return `| ${t.name} | ${t.cron_expression ?? "one-shot"} | ${t.agent} | ${lastRun} | ${t.last_status ?? "pending"} |`;
      });
      sections.push(`### Active Schedules
| Name | Cron | Agent | Last Run | Status |
|------|------|-------|----------|--------|
${scheduleRows.join("\n")}`);
    }
  }

  sections.push(`### Scheduling Guidelines
- Use crons for recurring monitoring, reports, and maintenance
- Delegate scheduled work to cheap agents when possible
- All crons run on the cheapest available model by default
- Use \`tier=premium\` ONLY when the task genuinely requires reasoning quality
- Don't schedule what can be done reactively`);

  // Alerts
  sections.push(`## Alerts

You can push messages to the owner when something needs attention.

### Alert the owner
\`[@alert: message="<what happened and what you recommend>"]\`

### Alert a specific channel/recipient
\`[@alert: channel=<channel> recipient=<id> message="<text>"]\`

### When to alert
- Provider outages lasting >30 minutes
- Budget exceeding 90% of monthly limit
- Dead letters accumulating (>5 unresolved)
- Scheduled tasks failing repeatedly

### When NOT to alert
- Routine health checks where everything is fine
- Transient errors that auto-recover
- Low-priority stats (save for daily review)`);

  // Development Loop
  sections.push(`## Autonomous Development Loop

You can kick off end-to-end feature development. The system decomposes a feature into stories, executes each in a fresh CLI session, runs quality checks, and commits on pass.

### Start a dev loop
\`[@develop: feature="<description>" agent=nyx branch=feat/<name>]\`

With inline stories:
\`[@develop: feature="<desc>" agent=nyx branch=feat/<name> stories="1. First task, 2. Second task, 3. Third task"]\`

### Control a running plan
\`[@dev-pause: <plan-id>]\` — pause after current story
\`[@dev-resume: <plan-id>]\` — resume a paused plan
\`[@dev-skip: <plan-id> story=<story-id>]\` — skip a blocked story

### How it works
- Each story gets a **fresh CLI session** (no conversation context carried over)
- Memory persists through git history, LEARNINGS.md, and workspace docs
- Quality checks (typecheck, tests) must pass before committing
- Failed stories retry up to 3 times, then alert the owner
- Budget checked before each story — pauses if >90% spent
- Max 20 stories per plan, 4 hour time limit`);

  // Budget
  sections.push(generateBudgetSection(registry, memory, config?.budget?.monthly_limit));

  return sections.join("\n\n");
}

function generateBudgetSection(registry?: AgentRegistry, memory?: MemoryStore, budgetMonthly?: number): string {
  const budget = budgetMonthly ?? 0;
  const lines: string[] = [];

  if (budget > 0) {
    lines.push(`## Budget

- **Monthly limit:** $${budget}
- **Alert threshold:** 80% ($${budget * 0.8})
- **Daily target:** ~$${(budget / 30).toFixed(2)}`);
  } else {
    lines.push(`## Budget

- **Monthly limit:** Unlimited`);
  }

  if (memory) {
    const cost24h = memory.getActualCost(24);
    const cost7d = memory.getActualCost(24 * 7);
    const costMonth = memory.getActualCost(24 * 30);
    const dailyBurn = cost7d / 7;
    const projectedMonthly = dailyBurn * 30;
    const pctUsed = budget > 0 && costMonth > 0 ? ((costMonth / budget) * 100).toFixed(1) : "n/a";

    lines.push(`
### Current Spend
| Period | Cost | Daily Avg |
|--------|------|-----------|
| Last 24h | $${cost24h.toFixed(2)} | $${cost24h.toFixed(2)} |
| Last 7d | $${cost7d.toFixed(2)} | $${dailyBurn.toFixed(2)} |
| Last 30d | $${costMonth.toFixed(2)} | $${(costMonth / 30).toFixed(2)} |

- **Budget used:** ${pctUsed}%
- **Projected monthly (7d avg):** $${projectedMonthly.toFixed(2)}${budget > 0 && projectedMonthly > budget ? " (OVER BUDGET)" : ""}`);

    // Per-model breakdown from last 24h
    const usage = memory.getUsageSummary(24);
    if (usage.length > 0) {
      const usageRows = usage.map(u =>
        `| ${u.model} | ${u.count} | ${formatTokens(u.total_tokens_in + u.total_tokens_out)} | $${u.actual_cost.toFixed(4)} |`
      );
      lines.push(`
### Last 24h by Model
| Model | Calls | Tokens | Cost |
|-------|-------|--------|------|
${usageRows.join("\n")}`);
    }
  }

  // Per-agent cost from registry
  if (registry) {
    const summary = registry.getStatsSummary();
    if (summary.totalCostCents > 0) {
      lines.push(`
### Agent Lifetime Cost
- **Total:** $${(summary.totalCostCents / 100).toFixed(2)}
- **Top consumers:** ${summary.topConsumers.join(", ") || "none"}
- **Idle agents (7d+):** ${summary.idleAgents.join(", ") || "none"}`);
    }
  }

  if (budget > 0) {
    lines.push(`
### Budget Rules
- Anthropic Max sub is flat-rate ($200/mo) so Anthropic calls don't increase variable costs
- Variable costs come from OpenRouter and MiniMax (though MiniMax is currently free)
- Alert the owner at 80% monthly spend or if daily burn exceeds $${(budget / 30).toFixed(2)}
- Prefer free/cheap models for delegation targets`);
  } else {
    lines.push(`
### Budget Rules
- Anthropic Max sub is flat-rate ($200/mo) so Anthropic calls don't increase variable costs
- Variable costs come from OpenRouter and MiniMax (though MiniMax is currently free)
- No budget limit set
- Prefer free/cheap models for delegation targets`);
  }

  return lines.join("");
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatDiscordRuntimeNotes(config: NyxHiveConfig): string {
  if (!config.discord) return "";

  const lines = [
    "",
    "### Discord Runtime",
    "- Discord is already configured for this workspace when it appears under Active Channels.",
    "- Do not treat the setup instructions below as a current blocker; verify live logs/status before claiming Discord is unattached.",
  ];

  if (config.discord.require_mention === true) {
    lines.push("- Private Discord DMs and explicitly listened private/guild channels are addressed automatically; other guild channel messages require an @mention.");
  } else {
    lines.push("- Private Discord DMs are addressed automatically; configured listen channels can be handled without an @mention.");
  }

  const privilegedIds = config.discord.privileged_user_ids?.map((id) => id.trim()).filter(Boolean) ?? [];
  if (privilegedIds.length > 0) {
    lines.push(`- Privileged harness access is allowlisted to: ${privilegedIds.map((id) => `\`${id}\``).join(", ")}`);
  } else {
    lines.push("- Privileged harness access is not open by default; configure explicit privileged Discord user IDs before tool-capable Discord work.");
  }

  return `\n${lines.join("\n")}`;
}

function getActiveChannels(config: NyxHiveConfig): string[] {
  const channels: string[] = ["HTTP API"];
  if (config.telegram) channels.push("Telegram");
  if (config.discord) channels.push("Discord");
  if (config.slack) channels.push("Slack");
  return channels;
}
