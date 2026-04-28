# Instance Isolation: NyxHive as a Framework

**Date**: 2026-03-15
**Status**: Draft
**Author**: Nyx

## Problem

NyxHive instances (NyxAI, Acme) share a single codebase. Data isolation is solid — separate processes, databases, vaults, browser profiles. But **code isolation does not exist**. An instance cannot:

- Add custom commands (e.g., `morph:api-drift-review`)
- Add custom channels or integrations
- Add custom scheduled tasks with custom logic
- Add custom API routes
- Add custom agent tools
- Extend the platform in any way without modifying NyxHive source

This blocks the multi-tenant vision. Each instance will eventually run on a separate machine. Instance developers (including User working on Acme) should never need to touch NyxHive core to build domain-specific functionality.

## Solution

Split NyxHive into **engine** (framework) and **instance** (application).

- **Engine** (`nyxhive` package): Exports a composable runtime. All current functionality becomes opt-in registrations rather than hardcoded wiring.
- **Instance** (separate repo per deployment): Imports the engine, registers what it needs, adds its own extensions, and starts.

Engine upgrades flow down via dependency updates (`bun update nyxhive`). Instance-specific code never touches the engine repo.

## Architecture

### createHive — The Public API

The engine's main export. Replaces the current monolithic `main()` in `src/index.ts`.

```typescript
import { createHive } from "nyxhive";

const hive = await createHive(options);
await hive.start();
```

### HiveOptions

```typescript
export interface HiveOptions {
  // Required
  config: string | NyxHiveConfig;     // path to config.toml, resolved relative to CWD

  // Extension points — all optional, all additive
  channels?: ChannelFactory[];         // inbound/outbound integrations
  commands?: CommandDefinition[];      // message-triggered actions (new concept)
  routes?: RouteRegistrar[];           // custom HTTP endpoints
  tasks?: TaskDefinition[];            // custom scheduled tasks
  tools?: AgentToolRegistration[];     // custom agent tools
  providers?: ProviderFactory[];       // custom LLM providers
  embedders?: EmbeddingFactory[];     // custom embedding providers
  middleware?: MessageMiddleware[];    // message pre/post processing

  // Lifecycle hooks
  onReady?: (hive: Hive) => Promise<void>;    // after all subsystems initialized
  onShutdown?: (hive: Hive) => Promise<void>; // before shutdown begins
}
```

When `config` is a string path, it is resolved relative to CWD (the instance repo root). All paths inside `config.toml` (data_dir, souls, workspace, vault) are resolved relative to the config file location, matching current behavior.

### Hive (Return Type)

```typescript
export interface Hive {
  start(): Promise<void>;
  stop(): Promise<void>;

  // Typed access for advanced use
  readonly processor: PublicProcessorAPI;
  readonly config: NyxHiveConfig;
  readonly server: HonoApp;
  readonly scheduler: Scheduler;
  readonly stores: HiveStores;
}
```

### Extension Interfaces

#### Channels

Channels are inbound/outbound message integrations. Built-in channels (Slack, Telegram, Discord, Webhook, iOS, iMessage) ship with the engine and are registered via factory functions.

```typescript
export interface ChannelFactory {
  name: string;
  create(deps: ChannelDeps): Promise<Channel>;
}

export interface ChannelDeps {
  config: NyxHiveConfig;
  queue: QueueDB;
  processor: PublicProcessorAPI;
  stores: HiveStores;                  // full store access (pairing, crawl, etc.)
}

// Built-in usage:
import { slackChannel, telegramChannel } from "nyxhive/channels";

// Custom channel:
const gitlabWebhook: ChannelFactory = {
  name: "gitlab",
  async create(deps) {
    return new GitLabWebhookChannel(deps);
  },
};
```

#### Commands (New Concept)

Commands are pattern-matched message handlers that execute before LLM routing. They enable instance-specific actions triggered by chat messages.

```typescript
export interface CommandDefinition {
  name: string;                              // e.g., "morph:api-drift-review"
  pattern: RegExp | string;                  // match against incoming message
  description: string;                       // for help/discovery
  handler: (ctx: CommandContext) => Promise<CommandResult>;
}

export interface CommandContext {
  message: MessageData;
  args: string[];                            // captured groups or split args
  processor: PublicProcessorAPI;
  config: NyxHiveConfig;
  stores: HiveStores;
}

export type CommandResult =
  | { handled: true; response?: string }     // command consumed the message
  | { handled: false };                      // pass through to normal routing
```

Commands are checked in the queue processor before classification/routing. If a command matches and returns `handled: true`, the message is not sent to an LLM.

#### Routes

Custom HTTP endpoints added to the Hono server.

```typescript
export type RouteRegistrar = (app: HonoApp, deps: RouteDeps) => void;

export interface RouteDeps {
  processor: PublicProcessorAPI;
  config: NyxHiveConfig;
  stores: HiveStores;
  auth: AuthMiddleware;
}
```

#### Tasks

Custom scheduled tasks registered alongside built-in ones.

```typescript
export interface TaskDefinition {
  name: string;
  schedule: string;                          // cron expression
  handler: (ctx: TaskContext) => Promise<void>;
  enabled?: boolean | ((config: NyxHiveConfig) => boolean);
}

export interface TaskContext {
  processor: PublicProcessorAPI;
  config: NyxHiveConfig;
  stores: HiveStores;
  router: ProviderRouter;
}
```

#### Tools

Custom agent tools available during invocation.

```typescript
// Named AgentToolRegistration to avoid collision with existing ToolDefinition (schema-only type)
export interface AgentToolRegistration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;       // JSON Schema
  handler: (args: unknown, ctx: ToolContext) => Promise<unknown>;
}
```

#### Providers

Custom LLM providers and embedding providers.

```typescript
export interface ProviderFactory {
  name: string;
  create(config: NyxHiveConfig): Provider;     // matches existing Provider interface
}

export interface EmbeddingFactory {
  name: string;
  create(config: NyxHiveConfig): EmbeddingProvider;
}
```

Built-in providers (Anthropic, OpenRouter, OpenAI) are registered by default. Custom providers are additive — they do not replace built-ins unless they share the same name.

#### Middleware

Message pre/post processing hooks.

```typescript
export interface MessageMiddleware {
  name: string;
  phase: "before" | "after";
  handler: (message: MessageData, ctx: MiddlewareContext) => Promise<MessageData | void>;
}
```

### PublicProcessorAPI

Narrowed interface for the QueueProcessor. Hides internal state, exposes typed methods.

```typescript
export interface PublicProcessorAPI {
  enqueue(message: EnqueueOptions): Promise<string>;
  onEvent(handler: (event: string, payload: unknown) => void): () => void;
  onResponse(handler: (response: ResponseData) => void): () => void;
  getStatus(): ProcessorStatus;
  getActiveAgents(): AgentStatus[];
}
```

### HiveStores

Typed access to all data stores. Some stores are optional — they require subsystems that may not be configured (e.g., knowledge requires an embedder).

```typescript
export interface HiveStores {
  // Always available
  queue: QueueDB;
  memory: MemoryStore;
  threads: ThreadDB;
  traces: TraceStore;
  graph: GraphMemory;
  patterns: PatternStore;
  outcomes: OutcomeStore;
  routing: RoutingStore;
  registry: AgentRegistry;
  vault: CredentialVault;
  proposals: ProposalStore;
  tasks: TaskStore;
  pairing: PairingStore;

  // Available when configured
  knowledge?: KnowledgeStore;          // requires embedder
  crawl?: CrawlService;               // requires crawl config
}
```

## Instance Repo Structure

Each instance is its own repository:

```
acme-hive/
├── package.json              # depends on "nyxhive" (git dep or npm)
├── tsconfig.json
├── src/
│   ├── index.ts              # createHive + custom extensions + start
│   ├── commands/             # instance-specific command handlers
│   │   └── drift-review.ts
│   ├── channels/             # instance-specific integrations
│   ├── tasks/                # instance-specific scheduled tasks
│   ├── routes/               # instance-specific API endpoints
│   └── tools/                # instance-specific agent tools
├── souls/                    # instance-specific soul configurations
├── config.toml               # instance configuration
├── .env                      # instance secrets
└── data/                     # runtime data (gitignored)
    ├── acme.db
    ├── memory.db
    ├── acme_knowledge.db
    └── browser-profile/
```

Example `src/index.ts`:

```typescript
import { createHive, slackChannel } from "nyxhive";
import { driftReviewCommand } from "./commands/drift-review";
import { gitlabChannel } from "./channels/gitlab";
import { weeklyDigestTask } from "./tasks/weekly-digest";

const hive = await createHive({
  config: "./config.toml",
  channels: [slackChannel(), gitlabChannel],
  commands: [driftReviewCommand],
  tasks: [weeklyDigestTask],
});

await hive.start();
```

## NyxAI Instance

NyxAI (the default/primary instance) also becomes an instance repo. It uses all built-in channels and may add NyxAI-specific extensions (evolution scans, proposal workflows, etc.).

This can live at `/home/user/dev/nyxai-hive/` or stay as a default instance within the nyxhive repo during development. Decision deferred — does not block Phase 1.

## Migration Path

### Phase 1: Make NyxHive Exportable

All work in the nyxhive repo. Nothing breaks.

1. **Define extension interfaces** — `ChannelFactory`, `CommandDefinition`, `TaskDefinition`, `ToolDefinition`, `RouteRegistrar`, `MessageMiddleware`, `PublicProcessorAPI`, `HiveStores`
2. **Extract `createHive()`** — Wrap current `main()` logic into a factory function that accepts `HiveOptions`
3. **Convert channels to factories** — Replace inline if-checks with a channel registry loop. Built-in channels become exported factories.
4. **Convert scheduler tasks to registry** — Replace hardcoded `bootstrap.ts` with a task registry. Built-in tasks become exported definitions.
5. **Narrow QueueProcessor API** — Create `PublicProcessorAPI` interface. Internal methods stay private. Routes and channels use the public API.
6. **Add command handler system** — Insert command matching into the processor pipeline before LLM classification.
7. **Make routes extensible** — Add a `routes` callback hook in server creation.
8. **Export everything** — Add `exports` field to `package.json`. Barrel exports for types, factories, and `createHive`.
9. **Thin out `main()`** — Current `src/index.ts` becomes a thin caller of `createHive()` with all built-in extensions. Existing behavior is identical.

### Phase 2: First Instance Repo (Acme)

1. Create `acme-hive/` repo
2. `package.json` depends on `nyxhive` via git dependency
3. Move Acme config, souls, .env into repo
4. Write `src/index.ts` using `createHive`
5. Morph can now add `morph:api-drift-review` as a command in his own repo
6. Verify boot, data paths, all channels work

### Phase 3: NyxAI Instance Repo

1. Same pattern as Phase 2
2. NyxAI-specific extensions (evolution, proposals) move here
3. `~/.nyxhive/instances/` becomes runtime data only

### Phase 4: Separate Machines (Future)

1. Instance repos are self-contained — clone, install, configure, start
2. Engine updates via `bun update nyxhive`
3. No cross-machine dependencies

## Dependency Strategy

- **During development**: Git dependency (`"nyxhive": "github:user/nyxhive"`) or local path
- **When stable**: Publish to npm/jsr with semver
- **No premature packaging infrastructure**

## Data Path Convention

Runtime data (`data/`) stays on disk, referenced by `config.toml`. Not bundled in the repo. Instance repos contain code + config + souls; `data/` is gitignored.

Current `~/.nyxhive/instances/<name>/data/` paths continue working. The `data_dir` in `config.toml` can point anywhere — relative to the instance repo or absolute.

## What This Enables

- Morph adds `morph:api-drift-review` in the Acme repo without touching NyxHive
- User works on Acme-specific integrations (GitLab, Jira, custom APIs) in the Acme repo
- NyxHive engine upgrades flow to all instances via dependency update
- Each instance on a separate machine with full autonomy
- Custom agent tools per instance
- Custom middleware per instance (approval flows, rate limiting, formatting)
- No ceiling on what an instance can build

## Error Handling

Extensions run inside the engine's process. The engine must be resilient to extension failures:

- **Channel factory fails**: Log error, skip channel, continue boot. Matches current behavior (channels are optional).
- **Command handler throws**: Catch, log, return error response to user. Do not crash the processor loop.
- **Route handler throws**: Standard Hono error handling (500 response). No special treatment needed.
- **Task handler throws**: Catch, log, mark task execution as failed. Scheduler continues.
- **Middleware throws**: Catch, log, skip the middleware, continue processing the message.
- **Lifecycle hook throws**: Log error. `onReady` failure is non-fatal (boot continues). `onShutdown` failure is logged but shutdown proceeds.

General principle: extension failures are isolated. They degrade the instance, never crash it.

## Trust Model

Extensions are fully trusted. They run in the same process, have access to all stores including `CredentialVault`, and can call any engine API.

This is appropriate for the current model where User controls all instances. If third-party extensions ever become a thing, sandboxing would require a process-boundary isolation model (separate worker processes, IPC). That's a different architecture and explicitly out of scope.

## CLI

The `nyxhive` CLI ships with the engine package. It provides operational tooling: `start`, `stop`, `instances`, `bookmarks`, `init`.

When an instance repo has `nyxhive` as a dependency, `bunx nyxhive start` works from the instance directory (CWD resolution finds `config.toml`). No changes to CLI resolution logic needed — the existing "CWD config.toml" path handles it.

Instance repos can add their own CLI commands via `package.json` bin scripts if needed, but the engine CLI covers operational basics.

## Versioning

During development (git dependency phase): no formal versioning. Instances pin to a git commit or branch. Breaking changes are communicated via commit messages and the NyxAI thread.

When stable: publish to npm/jsr with semver. Breaking changes to extension interfaces (`HiveOptions`, `ChannelFactory`, `CommandDefinition`, etc.) are major version bumps. Additive changes (new optional fields, new exports) are minor.

The engine exports an `ENGINE_API_VERSION` constant. Instances can check it at boot if they depend on specific engine features:

```typescript
import { ENGINE_API_VERSION, createHive } from "nyxhive";
if (ENGINE_API_VERSION < 2) throw new Error("This instance requires engine API v2+");
```

## Prerequisites

Before Phase 1 implementation begins, one internal refactor is required:

- **`createServer` parameter cleanup**: The current `createServer` function takes 21 positional parameters. This must be refactored to accept an options object before routes can be made extensible. This is a mechanical change (group params into an object) with no behavioral change.

## Open Questions

1. **NyxAI as instance**: Keep in-repo as default during dev, or separate repo from the start? Recommendation: keep in-repo during Phase 1, extract in Phase 3.
2. **Soul system**: Souls are already per-instance. No changes needed. The compiler/loader exports from the engine.
3. **MCP server**: Built-in MCP tools (35 currently) ship with engine. Instances can add more via `tools` extension point.
