# Instance Isolation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor NyxHive from a monolithic application into an importable framework with a `createHive()` API, enabling instances to be separate repos that extend the engine.

**Architecture:** Extract the current `main()` boot sequence into a composable `createHive(options)` factory. Convert hardcoded channel/task/route wiring into registries driven by extension interfaces. The existing `src/index.ts` becomes a thin caller of `createHive()` with all built-in extensions — zero behavioral change.

**Tech Stack:** TypeScript, Bun, Hono, SQLite (better-sqlite3)

**Spec:** `docs/superpowers/specs/2026-03-15-instance-isolation-design.md`

---

## Chunk 1: Extension Interfaces & Types

Define all the types that form the public API contract. No behavioral changes — just type definitions.

### Task 1: Create the extension type definitions file

**Files:**
- Create: `src/framework/types.ts`

- [ ] **Step 1: Create the framework directory and types file**

```typescript
// src/framework/types.ts
// Public extension interfaces for the NyxHive framework API.

import type { Hono } from "hono";
import type { NyxHiveConfig, AgentConfig } from "../config-schema.js";
import type { QueueDB } from "../queue/db.js";
import type { MemoryStore } from "../memory/store.js";
import type { KnowledgeStore } from "../memory/knowledge.js";
import type { TraceStore } from "../memory/traces.js";
import type { GraphMemory } from "../memory/graph.js";
import type { PatternStore } from "../memory/patterns.js";
import type { OutcomeStore } from "../memory/outcomes.js";
import type { RoutingStore } from "../memory/routing.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { CredentialVault } from "../security/vault.js";
import type { ProposalStore } from "../proposals/store.js";
import type { TaskStore } from "../tasks/store.js";
import type { PairingStore } from "../pairing/pairing.js";
import type { CrawlService } from "../crawl/index.js";
import type { ProviderRouter } from "../providers/router.js";
import type { Provider } from "../providers/types.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import type { Channel } from "../channels/types.js";
import type { Scheduler } from "../scheduler/index.js";
import type { MessageData } from "../types.js";

// --- Engine API Version ---

export const ENGINE_API_VERSION = 1;

// --- Core Interfaces ---

export interface HiveOptions {
  config: string | NyxHiveConfig;

  channels?: ChannelFactory[];
  commands?: CommandDefinition[];
  routes?: RouteRegistrar[];
  tasks?: TaskDefinition[];
  tools?: AgentToolRegistration[];
  providers?: ProviderFactory[];
  embedders?: EmbeddingFactory[];
  middleware?: MessageMiddleware[];

  onReady?: (hive: Hive) => Promise<void>;
  onShutdown?: (hive: Hive) => Promise<void>;
}

export interface Hive {
  start(): Promise<void>;
  stop(): Promise<void>;

  readonly processor: PublicProcessorAPI;
  readonly config: NyxHiveConfig;
  readonly server: Hono;
  readonly scheduler: Scheduler | undefined;
  readonly stores: HiveStores;
}

// --- Stores ---

export interface HiveStores {
  queue: QueueDB;
  memory: MemoryStore;
  threads: unknown; // ThreadDB is created inside server — typed later
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

  knowledge?: KnowledgeStore;
  crawl?: CrawlService;
}

// --- Channels ---

export interface ChannelFactory {
  name: string;
  create(deps: ChannelDeps): Promise<Channel>;
}

export interface ChannelDeps {
  config: NyxHiveConfig;
  queue: QueueDB;
  processor: PublicProcessorAPI;
  stores: HiveStores;
}

// --- Commands ---

export interface CommandDefinition {
  name: string;
  pattern: RegExp | string;
  description: string;
  handler: (ctx: CommandContext) => Promise<CommandResult>;
}

export interface CommandContext {
  message: MessageData;
  args: string[];
  processor: PublicProcessorAPI;
  config: NyxHiveConfig;
  stores: HiveStores;
}

export type CommandResult =
  | { handled: true; response?: string }
  | { handled: false };

// --- Routes ---

export type RouteRegistrar = (app: Hono, deps: RouteDeps) => void;

export interface RouteDeps {
  processor: PublicProcessorAPI;
  config: NyxHiveConfig;
  stores: HiveStores;
}

// --- Tasks ---

export interface TaskDefinition {
  name: string;
  schedule: string;
  handler: (ctx: TaskContext) => Promise<void>;
  enabled?: boolean | ((config: NyxHiveConfig) => boolean);
}

export interface TaskContext {
  processor: PublicProcessorAPI;
  config: NyxHiveConfig;
  stores: HiveStores;
  router: ProviderRouter;
}

// --- Tools ---

export interface AgentToolRegistration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: unknown, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  config: NyxHiveConfig;
  stores: HiveStores;
}

// --- Providers ---

export interface ProviderFactory {
  name: string;
  create(config: NyxHiveConfig): Provider;
}

export interface EmbeddingFactory {
  name: string;
  create(config: NyxHiveConfig): EmbeddingProvider;
}

// --- Middleware ---

export interface MessageMiddleware {
  name: string;
  phase: "before" | "after";
  handler: (
    message: MessageData,
    ctx: MiddlewareContext
  ) => Promise<MessageData | void>;
}

export interface MiddlewareContext {
  config: NyxHiveConfig;
  stores: HiveStores;
  processor: PublicProcessorAPI;
}

// --- Processor Public API ---

export interface PublicProcessorAPI {
  enqueue(message: EnqueueOptions): Promise<string>;
  onEvent(handler: (event: string, payload: unknown) => void): () => void;
  onResponse(handler: (response: ResponseData) => void): () => void;
  getStatus(): ProcessorStatus;
  getActiveAgents(): AgentStatus[];
}

export interface EnqueueOptions {
  content: string;
  sender?: string;
  threadId?: string;
  channel?: string;
  metadata?: Record<string, unknown>;
}

export interface ResponseData {
  messageId: string;
  response: string;
  threadId?: string;
  agent?: string;
}

export interface ProcessorStatus {
  running: boolean;
  queueLength: number;
  activeProcesses: number;
}

export interface AgentStatus {
  name: string;
  busy: boolean;
  currentTask?: string;
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd /home/user/dev/nyxhive && bunx tsc --noEmit`
Expected: No errors. (tsc must check the whole project since module resolution requires tsconfig context.)

- [ ] **Step 3: Commit**

```bash
git add src/framework/types.ts
git commit -m "feat: add framework extension type definitions"
```

---

### Task 2: Create the barrel export file

**Files:**
- Create: `src/framework/index.ts`

- [ ] **Step 1: Create barrel export**

```typescript
// src/framework/index.ts
// Public API surface for NyxHive as a framework.

export { ENGINE_API_VERSION } from "./types.js";
export type {
  HiveOptions,
  Hive,
  HiveStores,
  ChannelFactory,
  ChannelDeps,
  CommandDefinition,
  CommandContext,
  CommandResult,
  RouteRegistrar,
  RouteDeps,
  TaskDefinition,
  TaskContext,
  AgentToolRegistration,
  ToolContext,
  ProviderFactory,
  EmbeddingFactory,
  MessageMiddleware,
  MiddlewareContext,
  PublicProcessorAPI,
  EnqueueOptions,
  ResponseData,
  ProcessorStatus,
  AgentStatus,
} from "./types.js";
```

- [ ] **Step 2: Verify compilation**

Run: `cd /home/user/dev/nyxhive && bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Commit**

```bash
git add src/framework/index.ts
git commit -m "feat: add framework barrel export"
```

---

## Chunk 2: Prerequisite Refactors

Clean up tight couplings that block the `createHive` extraction. Each task is a mechanical refactor with no behavioral change.

### Task 3: Refactor createServer to accept an options object

**Files:**
- Modify: `src/server/index.ts:75-98` (createServer signature)
- Modify: `src/index.ts:378-401` (createServer call site)

- [ ] **Step 1: Define ServerOptions interface in src/server/index.ts**

Add above the `createServer` function (around line 73):

```typescript
export interface ServerOptions {
  config: NyxHiveConfig;
  processor: QueueProcessor;
  queue: QueueDB;
  pairing: PairingStore | undefined;
  memory: MemoryStore | undefined;
  knowledge: KnowledgeStore | undefined;
  embedder: EmbeddingProvider | undefined;
  traces: TraceStore | undefined;
  graphMemory: GraphMemory | undefined;
  runtime: DaemonRuntime;
  scheduler: Scheduler | undefined;
  taskStore: TaskStore | undefined;
  audit: AuditLog | undefined;
  router: ProviderRouter | undefined;
  registry: AgentRegistry | undefined;
  iosChannel: iOSChannel | undefined;
  proposalStore: ProposalStore | undefined;
  webhookChannel: WebhookChannel | undefined;
  crawlService: CrawlService | undefined;
  crawlSources: CrawlSourceStore | undefined;
  crawlIngest: CrawlIngestBridge | undefined;
  configPath?: string;
  customRoutes?: RouteRegistrar[];
}
```

Note: `DaemonRuntime` from `../setup/discord.js`, `CrawlIngestBridge` from `../crawl/index.js`, `iOSChannel` from `../channels/ios.js`. Match the types used in the current 21-param call site exactly.

- [ ] **Step 2: Change createServer to accept ServerOptions**

Replace the function signature (lines 75-98) with:

```typescript
export async function createServer(opts: ServerOptions) {
```

Then destructure at the top of the function body:

```typescript
const {
  config, processor, queue, pairing, memory, knowledge, embedder,
  traces, graphMemory, runtime, scheduler, taskStore, audit, router,
  registry, iosChannel, proposalStore, webhookChannel,
  crawlService, crawlSources, crawlIngest, options: extraOptions,
} = opts;
```

All existing references to these variables in the function body remain unchanged.

- [ ] **Step 3: Update the call site in src/index.ts**

Replace the createServer call (lines 378-401) with:

```typescript
const serverResult = await createServer({
  config,
  processor,
  queue,
  pairing,
  memory,
  knowledge,
  embedder,
  traces,
  graphMemory,
  runtime,
  scheduler,
  taskStore,
  audit,
  router,
  registry,
  iosChannel,
  proposalStore,
  webhookChannel,
  crawlService,
  crawlSources,
  crawlIngest,
  configPath,
});
```

- [ ] **Step 4: Run the full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All tests pass. This is a pure signature refactor.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts src/index.ts
git commit -m "refactor: createServer accepts options object instead of 21 positional params"
```

---

### Task 4: Create HiveStores bag and wire it through

**Files:**
- Create: `src/framework/stores.ts`
- Modify: `src/index.ts` (create stores bag after all stores initialized)

- [ ] **Step 1: Create stores assembly helper**

```typescript
// src/framework/stores.ts
import type { HiveStores } from "./types.js";
import type { QueueDB } from "../queue/db.js";
import type { MemoryStore } from "../memory/store.js";
import type { TraceStore } from "../memory/trace-store.js";
import type { GraphMemory } from "../memory/graph-memory.js";
import type { PatternStore } from "../memory/pattern-store.js";
import type { OutcomeStore } from "../memory/outcome-store.js";
import type { RoutingStore } from "../memory/routing-store.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { CredentialVault } from "../credentials/vault.js";
import type { ProposalStore } from "../proposals/store.js";
import type { TaskStore } from "../tasks/store.js";
import type { PairingStore } from "../pairing/store.js";
import type { KnowledgeStore } from "../memory/knowledge.js";
import type { CrawlService } from "../crawl/index.js";

export interface StoresInit {
  queue: QueueDB;
  memory: MemoryStore;
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
  knowledge?: KnowledgeStore;
  crawl?: CrawlService;
}

export function assembleStores(init: StoresInit): HiveStores {
  return {
    ...init,
    threads: undefined as unknown, // populated by server later
  };
}
```

- [ ] **Step 2: Wire stores bag in src/index.ts**

After all stores are created (around line 240), add:

```typescript
import { assembleStores } from "./framework/stores.js";

const stores = assembleStores({
  queue,
  memory,
  traces,
  graph: graphMemory,
  patterns: patternStore,
  outcomes: outcomeStore,
  routing: routingStore,
  registry,
  vault,
  proposals: proposalStore,
  tasks: taskStore,
  pairing: pairingStore,
  knowledge,
  crawl: crawlService,
});
```

This is additive — the individual variables still exist and are still used everywhere. The `stores` bag is just an aggregation point for now.

- [ ] **Step 3: Verify compilation and tests**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/framework/stores.ts src/index.ts
git commit -m "feat: add HiveStores assembly — aggregates all stores into single bag"
```

---

## Chunk 3: Channel Registry

Convert the hardcoded channel if-blocks into a registry pattern.

### Task 5: Create built-in channel factories

**Files:**
- Create: `src/framework/channels/index.ts`
- Create: `src/framework/channels/ios.ts`
- Create: `src/framework/channels/webhook.ts`
- Create: `src/framework/channels/telegram.ts`
- Create: `src/framework/channels/discord.ts`
- Create: `src/framework/channels/slack.ts`
- Create: `src/framework/channels/imessage.ts`

- [ ] **Step 1: Write test for channel factory pattern**

Create `src/__tests__/framework/channel-registry.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import type { ChannelFactory, ChannelDeps } from "../../framework/types.js";
import type { Channel } from "../../channels/types.js";

describe("Channel Registry", () => {
  it("should call create on each factory and collect channels", async () => {
    const created: string[] = [];

    const mockFactory: ChannelFactory = {
      name: "test",
      async create(_deps: ChannelDeps): Promise<Channel> {
        created.push("test");
        return {
          name: "test",
          start: async () => {},
          stop: async () => {},
          isConnected: () => true,
          getStats: () => ({ messagesReceived: 0, messagesSent: 0, errors: 0 }),
        };
      },
    };

    // Simulate registry loop
    const factories: ChannelFactory[] = [mockFactory];
    const channels: Channel[] = [];
    for (const factory of factories) {
      try {
        const channel = await factory.create({} as ChannelDeps);
        channels.push(channel);
      } catch {
        // skip failed channels
      }
    }

    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe("test");
    expect(created).toEqual(["test"]);
  });

  it("should skip factories that throw without crashing", async () => {
    const failFactory: ChannelFactory = {
      name: "broken",
      async create(): Promise<Channel> {
        throw new Error("channel init failed");
      },
    };

    const okFactory: ChannelFactory = {
      name: "ok",
      async create(): Promise<Channel> {
        return {
          name: "ok",
          start: async () => {},
          stop: async () => {},
          isConnected: () => true,
          getStats: () => ({ messagesReceived: 0, messagesSent: 0, errors: 0 }),
        };
      },
    };

    const factories = [failFactory, okFactory];
    const channels: Channel[] = [];
    for (const factory of factories) {
      try {
        const channel = await factory.create({} as ChannelDeps);
        channels.push(channel);
      } catch {
        // skip
      }
    }

    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe("ok");
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/framework/channel-registry.test.ts`
Expected: 2 tests pass

- [ ] **Step 3: Create the channel factory barrel**

Create `src/framework/channels/index.ts`:

```typescript
// src/framework/channels/index.ts
// Built-in channel factories. Import individually or use allBuiltinChannels().

export { iosChannel } from "./ios.js";
export { webhookChannel } from "./webhook.js";
export { telegramChannel } from "./telegram.js";
export { discordChannel } from "./discord.js";
export { slackChannel } from "./slack.js";
export { imessageChannel } from "./imessage.js";

import type { ChannelFactory } from "../types.js";
import { iosChannel } from "./ios.js";
import { webhookChannel } from "./webhook.js";
import { telegramChannel } from "./telegram.js";
import { discordChannel } from "./discord.js";
import { slackChannel } from "./slack.js";
import { imessageChannel } from "./imessage.js";

/** Returns all built-in channel factories. Each factory checks config to decide if it should activate. */
export function allBuiltinChannels(): ChannelFactory[] {
  return [iosChannel, webhookChannel, telegramChannel, discordChannel, slackChannel, imessageChannel];
}
```

- [ ] **Step 4: Create each channel factory wrapper**

Each factory wraps the existing channel class constructor. The factory checks config to decide whether to activate (matching the current if-blocks in `src/index.ts:360-484`). Factories receive `ChannelDeps` which includes `stores: HiveStores` — extract what each channel needs from there.

**Critical**: Channel constructors take the full `QueueProcessor`, not `PublicProcessorAPI`. During the factory phase, the `processor` field in `ChannelDeps` is typed as `PublicProcessorAPI` for the public interface, but internally `createHive` will pass the real `QueueProcessor` (cast via `as any`). This is a known trade-off — channels are engine-internal consumers that need the full processor.

`src/framework/channels/ios.ts`:
```typescript
import type { ChannelFactory } from "../types.js";
export const iosChannel: ChannelFactory = {
  name: "ios",
  async create(deps) {
    const { iOSChannel } = await import("../../channels/ios.js");
    return new iOSChannel({ config: deps.config, dataDir: deps.config.daemon.data_dir });
  },
};
```

`src/framework/channels/webhook.ts`:
```typescript
import type { ChannelFactory } from "../types.js";
export const webhookChannel: ChannelFactory = {
  name: "webhook",
  async create(deps) {
    if (!deps.config.webhook?.enabled) throw new Error("Webhook not configured");
    const { WebhookChannel } = await import("../../channels/webhook.js");
    return new WebhookChannel({ config: deps.config, queue: deps.queue, processor: deps.processor as any });
  },
};
```

`src/framework/channels/telegram.ts`:
```typescript
import type { ChannelFactory } from "../types.js";
import { resolveEnvKey } from "../../config.js";
export const telegramChannel: ChannelFactory = {
  name: "telegram",
  async create(deps) {
    if (!deps.config.telegram) throw new Error("Telegram not configured");
    const botToken = resolveEnvKey(deps.config.telegram.bot_token_env);
    const { TelegramChannel } = await import("../../channels/telegram.js");
    return new TelegramChannel({
      botToken,
      config: deps.config,
      queue: deps.queue,
      processor: deps.processor as any,
      pairing: deps.stores.pairing,
      crawlService: deps.stores.crawl,
      crawlSources: undefined, // CrawlSourceStore not on HiveStores — passed via stores.crawl internals
      crawlIngest: undefined,  // CrawlIngestBridge same
    });
  },
};
```

`src/framework/channels/discord.ts` — same pattern as Telegram with `deps.config.discord`.

`src/framework/channels/slack.ts`:
```typescript
import type { ChannelFactory } from "../types.js";
import { resolveEnvKey } from "../../config.js";
export const slackChannel: ChannelFactory = {
  name: "slack",
  async create(deps) {
    if (!deps.config.slack) throw new Error("Slack not configured");
    const botToken = resolveEnvKey(deps.config.slack.bot_token_env);
    const appToken = resolveEnvKey(deps.config.slack.app_token_env);
    const { SlackChannel } = await import("../../channels/slack.js");
    return new SlackChannel({
      botToken,
      appToken,
      config: deps.config,
      queue: deps.queue,
      processor: deps.processor as any,
      pairing: deps.stores.pairing,
      crawlService: deps.stores.crawl,
      crawlSources: undefined,
      crawlIngest: undefined,
    });
  },
};
```

`src/framework/channels/imessage.ts`:
```typescript
import type { ChannelFactory } from "../types.js";
export const imessageChannel: ChannelFactory = {
  name: "imessage",
  async create(deps) {
    if (!deps.config.imessage) throw new Error("iMessage not configured");
    const { IMessageChannel } = await import("../../channels/imessage.js");
    return new IMessageChannel({
      config: deps.config,
      queue: deps.queue,
      processor: deps.processor as any,
      pairing: deps.stores.pairing,
      crawlService: deps.stores.crawl,
      crawlSources: undefined,
      crawlIngest: undefined,
    });
  },
};
```

**Note on CrawlSourceStore/CrawlIngestBridge**: These are currently passed as separate params to channels. To keep the factory interface clean, we have two options: (a) add them to `ChannelDeps` explicitly, or (b) pass `undefined` for now and add them to `HiveStores` later. Option (b) is shown above — the crawl subsystem needs minor refactoring to be fully integrated. For the initial migration, channels that need crawl will get `undefined` for crawlSources/crawlIngest, which matches behavior when crawl is not configured. A follow-up task should wire these through properly.

All factories use dynamic imports so unused channels don't load their dependencies.

- [ ] **Step 5: Commit**

```bash
git add src/framework/channels/ src/__tests__/framework/
git commit -m "feat: channel factory wrappers for all built-in channels"
```

---

### Task 6: Wire channel factories into main()

**Files:**
- Modify: `src/index.ts:361-487` (replace inline channel init with factory loop)

- [ ] **Step 1: Replace channel initialization block**

Replace lines 361-487 (the entire channel initialization section) with:

```typescript
import { allBuiltinChannels } from "./framework/channels/index.js";

// Initialize channels via factory pattern
const channelFactories = allBuiltinChannels();
const channels: Channel[] = [];
const channelRefs: Record<string, Channel> = {};

for (const factory of channelFactories) {
  try {
    const channel = await factory.create({
      config,
      queue,
      processor,
      stores,
    });
    await channel.start();
    channels.push(channel);
    channelRefs[factory.name] = channel;
    log.info(`Channel started: ${factory.name}`);
  } catch (err) {
    // Channel not configured or failed — skip silently (matches current behavior)
    log.debug(`Channel skipped: ${factory.name} — ${(err as Error).message}`);
  }
}

processor.setChannels(channels);
```

Note: The server still needs references to specific channels (iosChannel, webhookChannel) for dedicated routes. These can be pulled from `channelRefs`:

```typescript
const iosRef = channelRefs.ios as IOSChannel | undefined;
const webhookRef = channelRefs.webhook as WebhookChannel | undefined;
```

Update the createServer call to use these refs instead of the previous direct variables.

- [ ] **Step 2: Run the full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All pass. Behavioral parity with previous inline init.

- [ ] **Step 3: Manual smoke test**

Start the NyxAI instance and verify channels connect:
Run: `cd /home/user/dev/nyxhive && bun run src/index.ts --config ~/.nyxhive/instances/NyxAI/config.toml`
Expected: Same channels start as before.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "refactor: channel init uses factory registry instead of inline if-blocks"
```

---

## Chunk 4: Command Handler System

Add the new command dispatch pipeline to the processor.

### Task 7: Add command matching to the processor pipeline

**Files:**
- Create: `src/framework/commands.ts`
- Modify: `src/queue/processor.ts` (add command check before classification)

- [ ] **Step 1: Write tests for command matching**

Create `src/__tests__/framework/commands.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { matchCommand } from "../../framework/commands.js";
import type { CommandDefinition } from "../../framework/types.js";

describe("matchCommand", () => {
  const commands: CommandDefinition[] = [
    {
      name: "drift-review",
      pattern: /^morph:api-drift-review$/,
      description: "Run API drift review",
      handler: async () => ({ handled: true, response: "Review started" }),
    },
    {
      name: "status",
      pattern: "status",
      description: "Show status",
      handler: async () => ({ handled: true, response: "OK" }),
    },
  ];

  it("matches regex pattern and extracts no args", () => {
    const result = matchCommand("morph:api-drift-review", commands);
    expect(result).not.toBeNull();
    expect(result!.command.name).toBe("drift-review");
    expect(result!.args).toEqual([]);
  });

  it("matches string pattern (exact)", () => {
    const result = matchCommand("status", commands);
    expect(result).not.toBeNull();
    expect(result!.command.name).toBe("status");
  });

  it("returns null for no match", () => {
    const result = matchCommand("hello world", commands);
    expect(result).toBeNull();
  });

  it("matches regex with capture groups as args", () => {
    const cmds: CommandDefinition[] = [
      {
        name: "deploy",
        pattern: /^deploy\s+(\S+)\s+(\S+)$/,
        description: "Deploy a service",
        handler: async () => ({ handled: true }),
      },
    ];
    const result = matchCommand("deploy api production", cmds);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["api", "production"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/framework/commands.test.ts`
Expected: FAIL — matchCommand doesn't exist yet

- [ ] **Step 3: Implement matchCommand**

```typescript
// src/framework/commands.ts
import type { CommandDefinition } from "./types.js";

export interface CommandMatch {
  command: CommandDefinition;
  args: string[];
}

export function matchCommand(
  content: string,
  commands: CommandDefinition[]
): CommandMatch | null {
  const trimmed = content.trim();

  for (const command of commands) {
    if (typeof command.pattern === "string") {
      if (trimmed === command.pattern) {
        return { command, args: [] };
      }
    } else {
      const match = trimmed.match(command.pattern);
      if (match) {
        return { command, args: match.slice(1) };
      }
    }
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/framework/commands.test.ts`
Expected: 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/framework/commands.ts src/__tests__/framework/commands.test.ts
git commit -m "feat: command matching engine with regex and string patterns"
```

---

### Task 8: Integrate command dispatch into processor

**Files:**
- Modify: `src/queue/processor.ts` (add commands property + dispatch before classification)

- [ ] **Step 1: Add commands to ProcessorConfig**

In `src/queue/processor.ts`, add to the `ProcessorConfig` interface (around line 42):

```typescript
commands?: CommandDefinition[];
```

Add import at top:

```typescript
import type { CommandDefinition, PublicProcessorAPI, HiveStores } from "../framework/types.js";
import { matchCommand } from "../framework/commands.js";
```

- [ ] **Step 2: Add command dispatch in the processing pipeline**

Find the method that processes individual messages (the main dispatch point where messages are classified and routed). Before the classification call, add:

```typescript
// Check commands before LLM classification
if (this.config.commands?.length) {
  const match = matchCommand(message.content, this.config.commands);
  if (match) {
    try {
      const result = await match.command.handler({
        message,
        args: match.args,
        processor: this.getPublicAPI(),
        config: this.config.nyxhiveConfig!,
        stores: this.stores!,
      });
      if (result.handled) {
        // Command handled — enqueue response and skip LLM routing
        if (result.response) {
          // QueueDB.enqueueResponse({ message_id, channel, sender, message, agent })
          this.queue.enqueueResponse({
            message_id: message.id,
            channel: message.channel ?? "command",
            sender: match.command.name,
            message: result.response,
            agent: match.command.name,
          });
        }
        return;
      }
    } catch (err) {
      log.error(`Command ${match.command.name} failed:`, err);
      // Fall through to normal routing
    }
  }
}
```

Note: The exact insertion point depends on the processor's message handling method. Find the method that calls `classifyTask` or `routeMessage` and insert the command check before it.

- [ ] **Step 3: Add stores and getPublicAPI() to QueueProcessor**

Add a `stores` property to the class and a `setStores(stores: HiveStores)` method. Add `getPublicAPI()` method that returns a `PublicProcessorAPI`:

```typescript
private _stores?: HiveStores;

setStores(stores: HiveStores): void {
  this._stores = stores;
}

get stores(): HiveStores | undefined {
  return this._stores;
}

getPublicAPI(): PublicProcessorAPI {
  return {
    enqueue: async (opts) => {
      // QueueDB.enqueueMessage signature: { channel, sender, sender_id?, message, agent?, thread_id?, ... }
      const id = this.queue.enqueueMessage({
        channel: opts.channel ?? "api",
        sender: opts.sender ?? "system",
        message: opts.content,
        thread_id: opts.threadId,
      });
      return id;
    },
    onEvent: (handler) => {
      // EventBus.onEvent returns an unsubscribe function
      return this.eventBus.onEvent((event) => {
        handler(event.type ?? "unknown", event);
      });
    },
    onResponse: (handler) => {
      // Use onGlobalThreadEvent to catch responses across all threads
      return this.eventBus.onGlobalThreadEvent((event) => {
        if (event.type === "response") {
          handler(event as any);
        }
      });
    },
    getStatus: () => ({
      running: this.running,
      queueLength: this.queue.getPendingCountAll(),
      activeProcesses: this.activeProcesses.size,
    }),
    getActiveAgents: () => {
      return Array.from(this.activeProcesses.entries()).map(([name, _]) => ({
        name,
        busy: true,
      }));
    },
  };
}
```

**Important:** Verify the exact EventBus and QueueDB method signatures against the actual source before implementing. The above uses:
- `QueueDB.enqueueMessage()` (not `enqueue()`)
- `QueueDB.getPendingCountAll()` (not `getPendingCount()`)
- `EventBus.onEvent()` (not `.on()`)
- `EventBus.onGlobalThreadEvent()` for response listening

- [ ] **Step 4: Wire stores into processor in src/index.ts**

After creating the stores bag and processor (around line 280):

```typescript
processor.setStores(stores);
```

- [ ] **Step 5: Run the full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All existing tests pass. Command dispatch is only active if commands are provided.

- [ ] **Step 6: Commit**

```bash
git add src/queue/processor.ts src/index.ts
git commit -m "feat: command dispatch in processor — checks commands before LLM classification"
```

---

## Chunk 5: createHive Factory

The main event — extract the boot sequence into a composable factory.

### Task 9: Extract createHive from main()

**Files:**
- Create: `src/framework/create-hive.ts`
- Modify: `src/framework/index.ts` (add createHive export)
- Modify: `src/index.ts` (thin out main to call createHive)

- [ ] **Step 1: Create createHive function**

Create `src/framework/create-hive.ts`. This is the largest task — it **moves** the entire `main()` body from `src/index.ts` into a factory function. This is NOT a rewrite. It is a cut-and-paste of the 580-line `main()` body with these modifications:

**Approach: Copy `main()` body, then modify.**

1. Copy the entire body of `main()` from `src/index.ts` (lines 53-626) into `createHive(options: HiveOptions)`.
2. Copy all imports from `src/index.ts` (lines 1-50) to the top of `create-hive.ts`.
3. Apply these modifications:

**Config loading (replaces lines 53-54):**
```typescript
const configPath = typeof options.config === "string"
  ? resolveConfigPath(options.config)
  : undefined;
const config = typeof options.config === "string"
  ? loadConfig(configPath!)
  : options.config;
```

**After processor creation (after line 276), add commands:**
```typescript
// Wire commands from options
if (options.commands?.length) {
  processor.config.commands = options.commands;
}
processor.setStores(stores);
```

**Channel initialization (replaces lines 335-487):**
Replace with the factory loop from Task 6. If `options.channels` is provided, use it. Otherwise use `allBuiltinChannels()`:
```typescript
const channelFactories = options.channels ?? allBuiltinChannels();
// ... factory loop from Task 6
```

**Server creation (around line 378), add custom routes:**
Pass `options.routes` through to `createServer`:
```typescript
const serverResult = createServer({
  // ... all existing params ...
  customRoutes: options.routes,
});
```

**After server start, add lifecycle hook:**
```typescript
if (options.onReady) {
  try { await options.onReady(hive); }
  catch (err) { logger.error("onReady hook failed:", err); }
}
```

**Shutdown handler (replaces lines 577-618), add onShutdown hook:**
Add at start of shutdown:
```typescript
if (options.onShutdown) {
  try { await options.onShutdown(hive); }
  catch (err) { logger.error("onShutdown hook failed:", err); }
}
```

**Return the Hive object instead of setting up signal handlers inline.** The signal handlers are set up inside `hive.start()`:

```typescript
const hive: Hive = {
  async start() {
    // Start server (calls Bun.serve)
    start();

    // Wire activity stream
    if (connections) {
      initActivityStream((event, payload) => connections.broadcast(event, payload));
    }

    // Start channels (already done above in factory loop)

    // Lifecycle hook
    if (options.onReady) {
      try { await options.onReady(hive); }
      catch (err) { logger.error("onReady hook failed:", err); }
    }

    // Signal handlers
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("SIGHUP", () => {
      logger.warn("Terminal closing — use nyxhive stop or Ctrl+C");
    });

    logger.info("All systems online");
  },

  async stop() {
    await shutdown();
  },

  processor: processor.getPublicAPI(),
  config,
  server: serverResult.app,
  scheduler,
  stores,
};

return hive;
```

**Subsystems that must be preserved (do NOT skip these during the move):**
- Lines 59-65: claude_config_dir / codex_home env inheritance
- Lines 73-81: Main brain override (`applyMainBrainOverride`)
- Lines 83-98: Logger setup, PID file, data dir
- Lines 101-103: Database init (QueueDB, MemoryStore, KnowledgeStore)
- Lines 106-185: Provider registration (Anthropic, OpenRouter, OpenAI)
- Lines 187-194: Sandbox detection
- Lines 196-231: Store creation (traces, graph, audit, registry, vault, pairing, patterns, outcomes, routing)
- Lines 235-255: ArtifactQueue, CrawlService, CrawlSourceStore, CrawlIngestBridge
- Lines 257-279: QueueProcessor creation + start
- Lines 281-317: TaskStore, ProposalStore, ProposalExecutor, worktree cleanup
- Lines 319-332: Scheduler, learning listeners
- Lines 337-358: Runtime context, startup validation
- Lines 489-565: Vault auto-ingestion + VaultWatcher
- Lines 567-626: Status logging, shutdown handler, signal handlers
- Lines 629-636: Global error handlers (uncaughtException, unhandledRejection) — these should stay in `src/index.ts`, NOT move into `createHive`

**Total: ~580 lines moved, ~30 lines of new framework wiring added.**

- [ ] **Step 2: Update main() to call createHive**

Replace the body of `main()` in `src/index.ts` with:

```typescript
import { createHive } from "./framework/create-hive.js";
import { allBuiltinChannels } from "./framework/channels/index.js";

async function main() {
  const configPath = process.argv.includes("--config")
    ? process.argv[process.argv.indexOf("--config") + 1]
    : undefined;

  const hive = await createHive({
    config: configPath ?? ".",
    channels: allBuiltinChannels(),
  });

  await hive.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 3: Add createHive to barrel export**

In `src/framework/index.ts`, add:

```typescript
export { createHive } from "./create-hive.js";
```

- [ ] **Step 4: Run the full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All pass. Behavioral parity.

- [ ] **Step 5: Manual smoke test**

Start both instances and verify they boot identically:

```bash
cd /home/user/dev/nyxhive && bun run src/index.ts --config ~/.nyxhive/instances/NyxAI/config.toml
```

Verify: same port, same channels, same agents, messages flow.

- [ ] **Step 6: Commit**

```bash
git add src/framework/create-hive.ts src/framework/index.ts src/index.ts
git commit -m "feat: createHive factory — NyxHive is now importable as a framework"
```

---

### Task 10: Add package.json exports

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add exports field**

Add to `package.json`:

```json
{
  "exports": {
    ".": "./src/framework/index.ts",
    "./channels": "./src/framework/channels/index.ts"
  }
}
```

This makes the following imports work from instance repos:

```typescript
import { createHive, ENGINE_API_VERSION } from "nyxhive";
import { slackChannel, telegramChannel } from "nyxhive/channels";
```

- [ ] **Step 2: Verify imports resolve**

Create a temporary test:

```bash
cd /tmp && mkdir hive-test && cd hive-test
echo '{ "dependencies": { "nyxhive": "file:///home/user/dev/nyxhive" } }' > package.json
bun install
echo 'import { createHive, ENGINE_API_VERSION } from "nyxhive"; console.log("API version:", ENGINE_API_VERSION);' > test.ts
bun run test.ts
```

Expected: Prints `API version: 1`

- [ ] **Step 3: Clean up temp dir and commit**

```bash
rm -rf /tmp/hive-test
cd /home/user/dev/nyxhive
git add package.json
git commit -m "feat: add package.json exports — nyxhive is now importable"
```

---

## Chunk 6: First Instance Repo (Acme)

Create the Acme instance as its own repo to validate the framework.

### Task 11: Scaffold acme-hive repo

**Files:**
- Create: `/home/user/dev/acme-hive/package.json`
- Create: `/home/user/dev/acme-hive/tsconfig.json`
- Create: `/home/user/dev/acme-hive/src/index.ts`
- Create: `/home/user/dev/acme-hive/.gitignore`

- [ ] **Step 1: Create the repo directory**

```bash
mkdir -p /home/user/dev/acme-hive/src
cd /home/user/dev/acme-hive
git init
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "acme-hive",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "dependencies": {
    "nyxhive": "file:///home/user/dev/nyxhive"
  },
  "scripts": {
    "start": "bun run src/index.ts",
    "dev": "bun --watch run src/index.ts"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
data/
dist/
.env
```

- [ ] **Step 5: Create src/index.ts**

```typescript
import { createHive, ENGINE_API_VERSION } from "nyxhive";
import { slackChannel } from "nyxhive/channels";

console.log(`Acme Hive — Engine API v${ENGINE_API_VERSION}`);

const hive = await createHive({
  config: "./config.toml",
  channels: [slackChannel],
});

await hive.start();
```

- [ ] **Step 6: Copy Acme config and souls**

```bash
cp ~/.nyxhive/instances/Acme/config.toml /home/user/dev/acme-hive/
cp -r ~/.nyxhive/instances/Acme/souls /home/user/dev/acme-hive/ 2>/dev/null || true
# Note: Acme env file is named 'env', not '.env'
cp ~/.nyxhive/instances/Acme/env /home/user/dev/acme-hive/.env
```

Note: `data_dir` in config.toml should stay pointing to `~/.nyxhive/instances/Acme/data/` (absolute path) so existing databases are preserved.

- [ ] **Step 7: Install and verify boot**

```bash
cd /home/user/dev/acme-hive
bun install
bun run start
```

Expected: Acme instance boots, connects channels, responds to messages. Same behavior as before.

- [ ] **Step 8: Initial commit**

```bash
cd /home/user/dev/acme-hive
git add .
git commit -m "init: Acme instance — imports nyxhive as framework dependency"
```

---

### Task 12: Add a custom command to validate extensibility

**Files:**
- Create: `/home/user/dev/acme-hive/src/commands/ping.ts`
- Modify: `/home/user/dev/acme-hive/src/index.ts`

- [ ] **Step 1: Create a simple custom command**

```typescript
// src/commands/ping.ts
import type { CommandDefinition } from "nyxhive";

export const pingCommand: CommandDefinition = {
  name: "ping",
  pattern: /^ping$/i,
  description: "Simple ping-pong to verify custom commands work",
  handler: async () => ({
    handled: true,
    response: "pong — custom command from Acme instance",
  }),
};
```

- [ ] **Step 2: Register in index.ts**

```typescript
import { createHive, ENGINE_API_VERSION } from "nyxhive";
import { slackChannel } from "nyxhive/channels";
import { pingCommand } from "./commands/ping.js";

console.log(`Acme Hive — Engine API v${ENGINE_API_VERSION}`);

const hive = await createHive({
  config: "./config.toml",
  channels: [slackChannel],
  commands: [pingCommand],
});

await hive.start();
```

- [ ] **Step 3: Test it**

Start the instance and send "ping" as a message.
Expected: Receives "pong — custom command from Acme instance" without going through LLM.

- [ ] **Step 4: Commit**

```bash
cd /home/user/dev/acme-hive
git add src/commands/ping.ts src/index.ts
git commit -m "feat: add ping command — validates custom command extensibility"
```

---

## Summary

| Chunk | Tasks | What it delivers |
|-------|-------|-----------------|
| 1: Extension Interfaces | 1-2 | All type definitions for the public API |
| 2: Prerequisite Refactors | 3-4 | createServer options object, HiveStores bag |
| 3: Channel Registry | 5-6 | Factory pattern for channels, replaces inline if-blocks |
| 4: Command System | 7-8 | New command dispatch pipeline in processor |
| 5: createHive Factory | 9-10 | The main extraction — NyxHive becomes importable |
| 6: First Instance | 11-12 | Acme as separate repo, validates everything works |

**Total: 12 tasks across 6 chunks.**

Phase 1 (engine work) = Chunks 1-5. Phase 2 (first instance) = Chunk 6.

After this plan is complete, Morph can add `morph:api-drift-review` as a command in the Acme repo without touching NyxHive.
