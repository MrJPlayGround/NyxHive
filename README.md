# NyxHive

NyxHive was an experimental personal agent runtime for exploring what it takes to move from "chat with an AI" to a working, trust-bounded agent system.

It is archived now. This repository is preserved as a public snapshot of the project, not as an actively maintained product or a recommended production deployment.

## What it was

NyxHive was built around a simple idea: one lead assistant should be able to coordinate useful work across tools, channels, memory, and specialist workers without losing the human approval boundary.

The project explored a local-first runtime for:

- receiving requests from chat surfaces and APIs
- routing work through queues and agent workers
- keeping conversation, memory, and execution state separate
- delegating bounded tasks to specialist agents
- gating side effects behind trust rules and approval flows
- running multiple isolated instances for different workspaces
- exposing a small command-line/runtime layer around the whole system

In practice, it became a learning ground for real-world agent engineering: not just prompting, but orchestration, isolation, memory, queues, approvals, observability, and the messy operational glue agents need before they are actually useful.

## Why it existed

The goal was to understand how an AI assistant could become an operational partner instead of a stateless chatbot.

NyxHive tested questions like:

- How should an agent decide when to answer directly versus delegate?
- What should be remembered, and what should stay ephemeral?
- How do you keep private or privileged work out of public channels?
- How do you let agents touch files, repos, messages, and tools without turning them into chaos goblins?
- How do you make long-running agent work reviewable by a human?
- How do multiple agent instances communicate without sharing all state?

That exploration eventually fed into newer, cleaner agent workflows. NyxHive did its job: it taught the hard parts.

## What it explored

High-level areas in the codebase include:

- **Channel adapters** — Discord, Telegram, Slack, iMessage-style local messaging, iOS/gateway experiments, and REST endpoints.
- **Queue and conversation runtime** — message classification, conversation management, task routing, and response parsing.
- **Delegation** — a lead agent dispatching bounded work to specialist subprocesses.
- **Memory systems** — conversation memory, graph-style knowledge, execution traces, and knowledge ingestion experiments.
- **Trust boundaries** — paired/private contexts versus public channels, command guards, credential handling, and approval gates.
- **Instance isolation** — separating engine/runtime concerns from per-workspace configuration and state.
- **Federation experiments** — relaying work between isolated agent instances instead of sharing one global brain.
- **CLI and setup tooling** — commands for starting, stopping, inspecting, bootstrapping, and managing local agent instances.
- **Gateway/workspace UI experiments** — browser-facing control surfaces for monitoring and interacting with the runtime.

The stack was mostly TypeScript/Bun, SQLite, Hono, local config files, and CLI-driven workflows.

## What it was useful for

NyxHive was useful as a sandbox for learning how agent systems break in real life:

- ambiguous user intent
- missing context
- unsafe default actions
- overly broad tool access
- memory pollution
- channel-specific trust problems
- long-running work with weak feedback loops
- the gap between a good demo and a system you can safely live with

It helped turn those lessons into more practical patterns: smaller workers, clearer scopes, explicit handoffs, stronger verification, and stricter separation between personal, project, and production contexts.

## Current status

Archived / retired.

This repo is a sanitized public snapshot. The original development history is intentionally not included, because it contained private local context and operational details that do not belong in a public archive.

Expect rough edges:

- docs may describe experiments rather than stable behavior
- some flows were built for a specific local setup
- integrations may require credentials or services that are not included
- this is not maintained as an installable product

If you are reading it, the most useful lens is: **agent runtime research notebook with code attached**.

## Repository map

A rough guide to the major areas:

```text
src/
  agents/              agent invocation, routing, registry, actor parsing
  auth/                auth/session/RBAC experiments
  browser/             local browser/profile management
  channels/            chat and messaging adapters
  cli/                 nyxhive command-line interface
  context/             context assembly and token-budget experiments
  development/         autonomous development loop experiments
  federation/          cross-instance relay and remote dispatch
  learning/            knowledge extraction experiments
  mcp/                 MCP server/tooling experiments
  memory/              graph, conversation, knowledge, and trace memory
  proposals/           approval/proposal lifecycle
  providers/           LLM provider adapters
  queue/               message queue and conversation processor
  scheduler/           cron and one-shot task scheduling
  security/            command and delegation guards
  server/              Hono server routes and middleware
  setup/               init/setup/bootstrap flows
  soul/                prompt/persona compilation experiments

docs/                  design notes, plans, and retrospectives
plans/                 implementation ledgers and planning notes
souls/                 agent/persona configuration experiments
templates/             instance templates
config/                example runtime configuration
```

## Running it

This archive is not presented as a polished install path. If you still want to inspect it locally:

```bash
bun install
bun run typecheck
bun test
```

Those were the verification commands used when preparing the public snapshot.

## Relationship to newer work

NyxHive was a stepping stone. It helped clarify that the winning shape was less "one giant self-improving hive" and more:

- small scoped workers
- explicit delegation contracts
- profile/project isolation
- human-readable plans and summaries
- verification before claiming success
- conservative tool boundaries

That lesson carried forward into newer Hermes/Pi-style workflows.

## License

No license is currently declared. Treat this as source-available archival material unless a license is added later.
