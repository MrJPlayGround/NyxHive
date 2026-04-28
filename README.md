# NyxHive

Self-improving personal runtime. Handles direct assistant work, engineering execution, and specialist delegation when it adds leverage. Supports Discord, Telegram, Slack, iMessage, iOS app, and REST API channels. SQLite everywhere, no external database dependencies.

Trust model:
- One trusted operator boundary owns privileged runtime work.
- Paired DMs are the normal surface for side effects such as memory writes, reminders, file changes, and external sends.
- Public channels stay public-safe. Nyx answers there, but does not treat them like a privileged paired session.

## Install

One line, fresh machine or existing:

```bash
curl -fsSL https://raw.githubusercontent.com/AgentNyxAI/NyxHive/master/scripts/remote-install.sh | bash
```

This will:
1. Check prerequisites (bun, git, claude CLI)
2. Clone the repo to `~/.nyxhive/app`
3. Install dependencies
4. Symlink `nyxhive` into your PATH
5. Launch the interactive setup wizard

### What the Setup Asks

```
NyxHive Setup
─────────────

  Setup type [fresh/move] (fresh):
```

**Fresh** — Creates a new, empty instance. Scaffolds config, env template, data directories. Good for spinning up a brand new agent team.

**Move** — Clones an existing project repo onto this machine. Picks a preset (e.g. `nyxlabs`) or accepts any git URL. Installs deps, detects env templates, and gets you to a working checkout.

### Manual Install (Dev)

```bash
git clone https://github.com/AgentNyxAI/NyxHive.git
cd NyxHive
bun install
bash scripts/install.sh   # symlink nyxhive to PATH
```

## Engine vs Instances

NyxHive separates **engine** (this repo) from **instances** (deployments).

**Engine** — The runtime, CLI, and soul base rules. Installed once, globally available as `nyxhive`.

**Instance** — A self-contained, portable directory:

```
my-workspace/
  .nyxhive/
    config.toml          # Agents, channels, server port, remotes
    souls/instance.yaml  # Instance identity and context
    .env                 # API keys, secrets (never committed)
    .env.template        # Required keys template (committed)
  .claude/
    CLAUDE.md            # Soul-compiled agent instructions
    settings.json        # Claude Code hooks
  .mcp.json              # MCP server config
  AGENTS.md              # Agent instructions
  PLATFORM.md            # Platform docs (auto-generated on boot)
  src/...                # Your actual code
```

Runtime state lives outside the workspace:

```
~/.nyxhive/
  app/                   # Engine installation (from remote-install)
  bookmarks.json         # Maps instance names to workspace paths
  data/{name}/           # SQLite DBs, PID file, browser profile
```

Instances are fully isolated. No shared state, no global registry. Move one to another machine and it just works.

## Multi-Instance Federation

Each instance runs independently with its own port, agents, databases, and MCP server. Instances communicate through federation relay, not shared state.

### Current Instances

| Instance | Role | Port |
|----------|------|------|
| NyxAI (Nyx) | Lead engineering, NyxHive development | 3777 |
| Acme (Morph) | Acme day-job workspace | 3779 |
| NyxLabs (Vortex) | Trading journal, NyxLabs projects | 3778 |

### Cross-Instance Dispatch

```toml
[remotes.acme]
url = "http://localhost:3779"
api_key_env = "OPTIPLY_REMOTE_API_KEY"
```

Star topology: a central instance dispatches outward via relay. Leaves don't know about each other.

When `server.public_url` is set, the instance advertises a reachable URL for remote delegation callbacks. Without it, relay falls back to `http://localhost:{port}`. For multi-machine setups, `public_url` is required.

### Remote Contract

Each instance exposes its addressability at:
- `GET /api/info` — advertised base URL, MCP URL, relay URL
- `GET /health` — health status with remote contract warnings
- `nyxhive status` — CLI view of the same

## Deploying to Another Machine

Two paths depending on what you're doing.

### Path 1: Fresh Instance (new agent team)

```bash
# On the target machine:
curl -fsSL https://raw.githubusercontent.com/AgentNyxAI/NyxHive/master/scripts/remote-install.sh | bash
# Choose "fresh" at setup prompt
# Edit .nyxhive/config.toml — set agents, channels, server.port, server.public_url
# Edit .nyxhive/.env — add API keys
nyxhive start
```

### Path 2: Move Existing Project

```bash
# On the target machine:
curl -fsSL https://raw.githubusercontent.com/AgentNyxAI/NyxHive/master/scripts/remote-install.sh | bash
# Choose "move" at setup prompt
# Pick a preset (nyxlabs) or paste a git URL
# The setup clones the repo, installs deps, detects env templates
cd ~/your-project
nyxhive start
```

### Path 3: Bootstrap (automated provisioning)

For scripted deployments or CI:

```bash
nyxhive bootstrap --target /opt/nyxhive-vortex \
  --git-url git@github.com:example-org/NyxLabs.git \
  --config .nyxhive/config.toml \
  --service --start
```

Flags: `--repo <dir>` (copy local), `--git-url <url>` (clone remote), `--git-ref <tag>`, `--env-file <path>`, `--service` (install OS service), `--start` (start after provision), `--dry-run`.

### After Deployment

1. Set `server.public_url` in config if the instance needs to be reachable from other instances
2. On the hub instance, add a `[remotes.name]` entry pointing to the new instance
3. Verify: `nyxhive health` on the remote, check `/api/info` shows correct URLs

### Sharing with a Collaborator

Your coworker can use NyxHive against their own project repo:

```bash
# Install engine
curl -fsSL https://raw.githubusercontent.com/AgentNyxAI/NyxHive/master/scripts/remote-install.sh | bash

# Choose "move", paste the project git URL
# They get the repo + engine, configure their own .env and agents
nyxhive start
```

They pull engine updates with:
```bash
nyxhive update
```

## CLI Reference

```
nyxhive <command> [instance] [options]

Core:
  init [dir]                  Create a new instance
  start [name] [-d]           Start instance (daemon mode with -d)
  stop [name] [--force]       Stop instance
  restart [name] [-d]         Restart instance
  status [name]               Show instance status + remote contract
  health [name]               Validate config, DBs, API keys
  logs [name] [-f] [-n]       Tail instance logs
  list                        List all instances

Setup:
  setup                       Interactive setup (fresh or move)
  update [--check] [--dry-run] Update the installed engine checkout
  deploy [name]               Deploy updates to running instance
  bootstrap --target <dir>    Provision a clean host/directory
  rollback [name]             Rollback a deploy
  service install|uninstall   OS service (launchd/systemd)

Access:
  devices [list|approve|revoke]    Manage gateway devices
  pairing [list|approve|revoke]    Manage channel pairing
  workspace [list|start|stop|status|doctor]
                                   Manage workspace control-plane profiles

Data:
  ingest [vault-path]              Ingest knowledge base
  backup [list]                    Database backups
  migrate [--status|--dry-run]     Database migrations
  config [name]                    Show resolved config
  instances [list|add|remove]      Manage instance registry
  templates [list|validate|save]   Manage templates
```

Instance resolution: `--config` flag > bookmark name > CWD `.nyxhive/config.toml` > legacy paths.

## Architecture

```
Channel (Discord/Telegram/Slack/iMessage/iOS/API)
  |
  v
Message Classifier
  |
  v
Queue Processor
  |--- conversation --> Conversation Manager
  |--- operations ----> Workspace control plane (/operations, jobs, tasks, profiles, memory)
  |--- delegation ----> Delegation Engine --> Agent subprocess (Claude Code SDK)
  |--- management ----> Management Action Executor
  |
  v
Response Parser (action tags: [@agent:], [@learn:], [@propose:], etc.)
  |
  v
Channel (reply)
```

### Soul System

Three-layer compilation:

1. **Engine `souls/base.yaml`** — Behavioral rules shared across all instances
2. **Instance `souls/instance.yaml`** — Identity and context per deployment
3. **Agent souls** — Per-agent personality (v2 Markdown directories in `souls/<agent>/` or v1 YAML)

### Core Concepts

**Agents** — Specialized AI workers invoked as CLI subprocesses. Nyx (lead, codes directly + delegates), Analyst (research), Tester (QA).

**Delegation** — Nyx dispatches via `[@agent: task]` tags. Contracts extract file paths, verification hints, and output expectations. Zero LLM cost (heuristic-based).

**Proposals** — Autonomy gate. Lifecycle: proposed > reviewing > reviewed > approved > executing > completed > merged. Auto-creates GitHub PRs. Maintenance+small+safe = auto-approve; features+protected paths = require approval.

**Memory** — Graph memory, conversation memory, knowledge store, execution traces, Obsidian integration. `[@learn:]` tags extract knowledge from agent responses.

**Federation** — Durable bidirectional relay between instances. Relay tokens persist in SQLite, survive restarts, and support long-running cross-instance tasks.

## Project Structure

```
src/
  index.ts             Server entry point (Hono)
  types.ts             Shared types
  config.ts            TOML config loader
  config-schema.ts     Zod schema validation

  agents/              Invocation, routing, registry, actor parsing
  auth/                User auth (bcrypt, sessions, RBAC)
  browser/             Browser launcher, per-instance profile management
  channels/            Discord, Telegram, Slack, iMessage, iOS
  cli/                 CLI (start/stop/init/setup/bootstrap/deploy)
  context/             Context window management, token budgets
  development/         Autonomous dev loop
  federation/          Cross-instance relay, remote dispatch
  learning/            Knowledge extraction from agent responses
  mcp/                 MCP server (tools, coordination, Brave search)
  memory/              Graph, conversation, knowledge, traces, Obsidian
  proposals/           Autonomy gate, proposal lifecycle
  providers/           LLM providers (Anthropic, OpenRouter, MiniMax)
  queue/               Message queue, delegation engine, conversation manager
  scheduler/           Cron + one-shot task scheduler
  security/            Credential vault, command guard, delegation guard
  server/              Hono routes, SSE streaming, middleware
  setup/               Init wizard
  soul/                Soul compiler (v2 directories + v1 YAML), runtime

scripts/
  install.sh           Local CLI installer (symlink + PATH)
  remote-install.sh    One-line remote installer
  uninstall.sh         Remove CLI symlink

souls/
  base.yaml            Engine behavioral rules (shared across all instances)
  nyx/                 Nyx agent soul (identity, personality, philosophy)
  _base/               Shared defaults for v2 agents

templates/             Instance templates
```

## Links

- [CLAUDE.md](./CLAUDE.md) — Detailed architecture reference, conventions, gotchas
- [docs/what-is-nyxhive.md](./docs/what-is-nyxhive.md) — Product overview
