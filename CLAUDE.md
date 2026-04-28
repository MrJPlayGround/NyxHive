# Nyx — NyxHive

@../agents.md
@souls/nyx/identity.md
@souls/nyx/personality.md
@souls/nyx/philosophy.md

---

# NyxHive

Multi-agent AI orchestrator. Delegates tasks across specialized agents via CLI subprocesses (Claude Code SDK). Supports Discord, Telegram, Slack, iMessage, iOS app, and REST API channels.

## Quick Start

```bash
bun install
bun run start          # or: bun run dev (watch mode)
bun test               # 2853 tests, ~26s
bun run lint           # biome
```

## Project Structure

```
src/
  index.ts             # Server entry point (Hono)
  types.ts             # Shared types (AgentConfig, DelegationContract, etc.)
  config.ts            # TOML config loader
  config-schema.ts     # Zod schema validation
  defaults.ts          # Default config values

  agents/              # Agent invocation, routing, registry, actor parsing
  auth/                # User auth (bcrypt, sessions, RBAC)
  browser/             # Browser launcher, per-instance profile management
  channels/            # Discord, Telegram, Slack, iMessage, iOS
  cli/                 # CLI entry (nyxhive start/stop/init/instances/bookmarks)
  config/              # Extended config helpers
  context/             # Context window management, token budgets, summarization
  development/         # Autonomous dev loop (plan, execute, commit)
  learning/            # [@learn:] tag processing, knowledge extraction from agent responses
  mcp/                 # MCP server (tool exposure for agents, coordination, Brave search)
  memory/              # Graph memory, conversation memory, knowledge store, traces, Obsidian integration
  pairing/             # Device pairing (iOS, chat channels)
  proposals/           # Autonomy gate, proposal lifecycle
  providers/           # LLM providers (Anthropic, OpenRouter, MiniMax)
  queue/               # Message queue, processor, delegation engine, conversation manager
  sandbox/             # Docker and macOS sandboxing
  scheduler/           # Cron + one-shot task scheduler
  security/            # Credential vault, command guard, delegation guard
  server/              # Hono routes, SSE streaming, middleware
  setup/               # Init wizard
  soul/                # Soul system (v2 directory compiler + v1 YAML fallback, runtime injection)
  tasks/               # Structured task tracking
  types/               # Thread types
  templates/           # Instance templates, config generation
  utils/               # Shared utilities

souls/                 # Soul definitions
  base.yaml            # Engine behavioral rules (shared across all instances)
  nyx/                 # Nyx agent soul (identity.md, personality.md, philosophy.md)
  _base/               # Shared defaults for v2 agents
plans/                 # Active plan files
plans/archive/         # Completed/superseded plans
docs/plans/            # Dated execution plans
templates/             # Instance templates (acme-engineering, etc.)
src/__tests__/         # All tests
```

## Architecture

### Core Loop
1. Message arrives on any channel
2. Classified (conversation, delegation, management, etc.)
3. Routed to appropriate agent via queue
4. Agent invoked as Claude Code CLI subprocess with soul-compiled system prompt
5. Response parsed for action tags (`[@agent: task]`, `[@learn:]`, `[@propose:]`, etc.)
6. Results returned through channel

### Key Decisions
- **Nyx as lead** — Nyx (lead role) implements code directly and delegates to specialist agents via `[@agent: task]` tags when their expertise is needed. Full tool access + management action rights.
- **Engine/instance separation** — NyxHive is the engine (globally installed CLI + runtime). Instances are self-contained deployments that use the engine. Each instance is a portable directory with its own `config.toml`, `.env`, `data/`, `workspace/`, and `souls/`. No global registry — instances are fully isolated.
- **Bookmarks for CLI convenience** — `~/.nyxhive/bookmarks.json` maps instance names to directory paths. CLI-only convenience, not runtime state. Instances work fine without being bookmarked.
- **Star topology** — NyxAI (dev instance) at center, optional outbound dispatch to leaf instances via `[remotes]` config key. Leaves don't know about each other.
- **Soul layering** — Engine `souls/base.yaml` (behavioral rules, shared across all instances) + instance `souls/instance.yaml` (identity/context, unique per deployment) + agent YAML/v2 directories.
- **Per-instance browser profile** — `data/browser-profile/` within each instance directory. No shared global browser state.
- **Multi-project routing** — Nyx adapts to each stack (Bun+TS, React+Supabase, SwiftUI). Projects: NyxHive, nyx-ios, Trading Journal.
- **Delegation contracts** — Structured extraction of file paths, verification hints, and output expectations from delegation envelopes. Zero LLM cost (heuristic-based).
- **Processor decomposition** — The monolithic processor was split into `DelegationEngine`, `ManagementActionExecutor`, and `ConversationManager` in `src/queue/`.
- **SQLite everywhere** — Queue, auth, memory, knowledge, proposals, tasks, traces all use SQLite. No external DB dependency.

### Notable Subsystems

- **Instance layout** — Each workspace repo is a self-contained instance:
  ```
  my-workspace/
    .nyxhive/
      config.toml          # Instance configuration (agents, channels, server, remotes)
      souls/instance.yaml  # Instance identity and context
      .env                 # Environment variables (gitignored)
      .env.template        # Required keys template (committed)
    .claude/
      CLAUDE.md            # Soul-compiled agent instructions (committed, updated on boot)
      settings.json        # Claude Code hooks (committed)
    .claude-plugin/
      plugin.json          # Skills plugin (committed, updated on boot)
    .mcp.json              # MCP server config (committed)
    AGENTS.md              # Agent instructions (committed)
    PLATFORM.md            # Platform docs (committed, updated on boot)
    src/...                # Actual code

  ~/.nyxhive/
    bookmarks.json         # Maps instance names to workspace paths (CLI convenience)
    data/{name}/           # Runtime state: SQLite DBs, PID, browser profile
  ```
- **MCP server** (`src/mcp/server.ts`) — 35 tools exposed to agents: `send_message`, `search_knowledge`, `search_obsidian`, `write_obsidian_note`, `list_proposals`, `get_proposal`, `create_proposal`, `approve_proposal`, `reject_proposal`, `delete_proposal`, `start_review`, `list_threads`, `get_thread`, `get_agent_status`, `get_usage`, `get_routing_stats`, `get_queue_status`, `get_logs`, `claim_work`, `release_work`, `post_progress`, `request_input`, `trigger_scan`, `list_scheduled_tasks`, `list_agents`, `git_status`, `git_log`, `list_projects`, Brave Search (web/news/images/videos/local), browser management. Coordination store tracks active delegations. Routing store provides learned delegation statistics.
- **Review gate** (`src/queue/review-gate.ts`) — Post-coding auto-review: captures git diff, runs cheap LLM review (PASS/WARN/FAIL), appends verdict to delegation result.
- **Proposal PR pipeline** (`src/proposals/`) — Full lifecycle: `proposed → reviewing → reviewed → approved → executing → completed → merged`. Auto-creates GitHub PRs on execution completion. Jaccard similarity deduplication. Autonomy classification: maintenance+small+safe = auto-approve, features+protected paths = require approval.
- **Autonomous dev loop** (`src/development/loop.ts`) — Decomposes a feature into stories, executes each in a fresh CLI session, runs quality checks, commits on pass, retries on fail. Max 4-hour wall time.
- **Traces** (`src/memory/traces.ts`) — Execution traces with per-agent cost, token usage, and duration tracking.
- **Learned routing** (`src/memory/routing.ts`) — Logs every delegation decision, links outcomes (success/failure with cost and duration), computes per-(agent, task_type) success rates, injects routing suggestions into orchestrator system prompts.
- **Provider router** (`src/providers/router.ts`) — Task-type classification, routes to appropriate provider+model, circuit breaker per provider, retry logic.

### Security Layers
1. Credential vault (env sanitization)
2. Command guard (blocked/approval/allowed tiers)
3. Delegation guard (trust levels)
4. Path traversal protection
5. Auth rate limiting
6. Admin endpoint lockdown

## Testing

```bash
bun test                    # Run all
bun test --watch            # Watch mode
bun test src/__tests__/actor.test.ts  # Single file
```

- All tests in `src/__tests__/`, 130 files, 2853 tests
- Tests use `describe`/`it`/`expect` (bun:test)
- No mocking frameworks — tests use manual stubs and in-memory SQLite
- Test files mirror source modules (e.g., `delegation.test.ts` tests delegation engine)

## Conventions

- **TypeScript + Bun** — no Node.js, no npm
- **No `any`** — use proper types, no escape hatches
- **Minimal dependencies** — prefer built-in over npm packages
- **Commit style** — `type: description` (feat, fix, chore, docs, test, security)
- **No over-engineering** — build what's needed now
- **Action tags** — orchestrator communicates via parseable tags: `[@agent:]`, `[@learn:]`, `[@propose:]`, `[@hire:]`, `[@fire:]`, `[@reassign:]`, `[@team:]`, `[@schedule:]`, `[@unschedule:]`, `[@alert:]`, `[@develop:]`, `[@dev-pause:]`, `[@dev-resume:]`, `[@dev-skip:]`

## Gotchas

- Pure orchestrators are in `MUST_DELEGATE` — they cannot self-execute. SDK tools are stripped from orchestrator invocations. Lead agents (like Nyx) have full tool access.
- Soul v2 directories use Markdown with YAML frontmatter. The v2 compiler (`src/soul/compiler-v2.ts`) builds the system prompt. V1 YAML fallback via `src/soul/compiler.ts`.
- Soul runtime loads three layers: engine `base.yaml` (from engine installation dir), instance `souls/instance.yaml` (from instance dir), then agent YAML/v2.
- The queue processor (`src/queue/processor.ts`) is the central hub — delegation, management actions, and conversation all flow through it.
- Agent timeout defaults to 30 minutes (`AGENT_TIMEOUT_MS`). Configurable per-agent via `timeout_ms`.
- Config is TOML (`config.toml` at instance root), validated by Zod schema on load. Legacy path `config/nyxhive.toml` still supported.
- Cross-instance dispatch uses `[remotes]` config key (not `[instances]`). Each remote has name, url, and optional api_key.
- CLI resolution order: `--config` flag > bookmark name > `$CWD/.nyxhive/config.toml` > `~/.nyxhive/instances/<Name>/` (legacy, deprecated) > CWD `config.toml` > CWD `config/nyxhive.toml`.
