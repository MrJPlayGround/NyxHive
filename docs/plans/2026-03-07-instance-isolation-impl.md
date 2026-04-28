# Instance Isolation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make NyxHive instances fully isolated deployments of the NyxHive engine — no shared registry, no automatic discovery, no meshed state.

**Architecture:** Each instance becomes a self-contained, portable directory. The engine ships behavioral defaults (base soul). Instances own their identity, data, and config. Cross-instance communication is opt-in via `[remotes]` in the hub instance's config only.

**Tech Stack:** TypeScript/Bun, TOML config, SQLite, Zod schema validation

---

### Task 1: Rename `[instances]` to `[remotes]` in config schema and types

**Files:**
- Modify: `src/config-schema.ts:177-182`
- Modify: `src/types.ts:229-234`

**Step 1: Update config schema**

In `src/config-schema.ts`, rename the `instances` key to `remotes`:

```typescript
// Line ~177: rename instances -> remotes
  remotes: z.record(z.string(), z.object({
    url: z.string().url(),
    api_key_env: z.string(),
    description: z.string().optional(),
    agents: z.array(z.string()).optional(),
  })).optional(),
```

**Step 2: Update types**

In `src/types.ts`, rename `instances` to `remotes`:

```typescript
// Line ~229: rename instances -> remotes
  remotes?: Record<string, {
    url: string;
    api_key_env: string;
    description?: string;
    agents?: string[];
  }>;
```

**Step 3: Update dispatch to use `remotes`**

In `src/agents/dispatch.ts`, update references from `config.instances` to `config.remotes`:

```typescript
// Line 20-23:
  const instanceConfig = config.remotes?.[instanceName];
  if (!instanceConfig) {
    const known = config.remotes ? Object.keys(config.remotes).join(", ") : "none";
    throw new Error(`Unknown remote "${instanceName}". Known remotes: ${known}`);
  }
```

**Step 4: Update delegation executor reference**

In `src/queue/delegation-executor.ts`, the `mention.instance` field feeds into `dispatchToInstance()`. No change needed there — it's already using the dispatch function. Just verify it still works.

**Step 5: Update dispatch tests**

In `src/__tests__/dispatch.test.ts`, rename `instances` to `remotes` in test config objects.

**Step 6: Run tests**

Run: `bun test src/__tests__/dispatch.test.ts -v`
Expected: PASS

**Step 7: Run full test suite**

Run: `bun test`
Expected: All tests pass. If any tests reference `config.instances`, fix them.

**Step 8: Commit**

```bash
git add src/config-schema.ts src/types.ts src/agents/dispatch.ts src/__tests__/dispatch.test.ts
git commit -m "refactor: rename [instances] to [remotes] in config schema"
```

---

### Task 2: Replace global instance registry with bookmarks

**Files:**
- Modify: `src/cli/instance-registry.ts` (rewrite as bookmarks)
- Modify: `src/cli/instances-cmd.ts` (update to use bookmarks)
- Modify: `src/cli/resolve.ts` (remove `listInstances` dependency on registry)

**Step 1: Rewrite instance-registry.ts as bookmarks**

Replace the global registry with a thin bookmarks file. Bookmarks are operator convenience only — not used at runtime.

```typescript
// src/cli/instance-registry.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const BOOKMARKS_PATH = join(
  process.env.HOME ?? "/root",
  ".nyxhive",
  "bookmarks.json",
);

export interface Bookmark {
  name: string;
  path: string;       // absolute path to instance directory
  port?: number;       // convenience, not authoritative
}

export interface BookmarkStore {
  bookmarks: Bookmark[];
}

export function loadBookmarks(filePath = BOOKMARKS_PATH): BookmarkStore {
  if (!existsSync(filePath)) return { bookmarks: [] };
  const raw = readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw) as BookmarkStore;
  return { bookmarks: Array.isArray(data.bookmarks) ? data.bookmarks : [] };
}

export function saveBookmarks(store: BookmarkStore, filePath = BOOKMARKS_PATH): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(store, null, 2) + "\n");
}

export function addBookmark(bookmark: Bookmark, filePath = BOOKMARKS_PATH): void {
  const store = loadBookmarks(filePath);
  const existing = store.bookmarks.findIndex(b => b.name === bookmark.name);
  if (existing >= 0) {
    store.bookmarks[existing] = bookmark; // update
  } else {
    store.bookmarks.push(bookmark);
  }
  saveBookmarks(store, filePath);
}

export function removeBookmark(name: string, filePath = BOOKMARKS_PATH): void {
  const store = loadBookmarks(filePath);
  store.bookmarks = store.bookmarks.filter(b => b.name !== name);
  saveBookmarks(store, filePath);
}

// Health check stays the same
export async function checkInstanceHealth(
  bookmark: Bookmark,
  timeoutMs = 5000,
): Promise<{ status: string; ok: boolean }> {
  if (!bookmark.port) return { status: "no port configured", ok: false };
  const url = `http://localhost:${bookmark.port}/health`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok
      ? { status: "healthy", ok: true }
      : { status: `unhealthy (${response.status})`, ok: false };
  } catch {
    return { status: "unreachable", ok: false };
  }
}
```

**Step 2: Update instances-cmd.ts to use bookmarks**

Rewrite to use `loadBookmarks` / `addBookmark` / `removeBookmark` instead of the registry functions. Replace `RegistryEntry` with `Bookmark`.

**Step 3: Update resolve.ts**

The `listInstances()` function currently scans `~/.nyxhive/instances/`. Change it to:
1. First try reading bookmarks
2. Fall back to scanning `~/.nyxhive/instances/` for backwards compatibility during migration

The `resolveInstance()` function should also check bookmarks as a resolution source:
1. Explicit `--config` flag (unchanged)
2. Name matches a bookmark → use bookmark's path
3. Name matches `~/.nyxhive/instances/<Name>/` (backwards compat)
4. Name is a directory path
5. Fall back to CWD

**Step 4: Update init.ts**

After scaffolding, auto-add a bookmark:

```typescript
addBookmark({ name, path: absDir, port });
```

**Step 5: Run tests**

Run: `bun test src/__tests__/instance-registry.test.ts -v`
Expected: Tests will fail — update them to test bookmark functions instead.

**Step 6: Update instance-registry tests**

Rewrite tests to test `loadBookmarks`, `addBookmark`, `removeBookmark`, `checkInstanceHealth`.

**Step 7: Run full test suite**

Run: `bun test`
Expected: PASS

**Step 8: Commit**

```bash
git add src/cli/instance-registry.ts src/cli/instances-cmd.ts src/cli/resolve.ts src/cli/init.ts src/__tests__/instance-registry.test.ts
git commit -m "refactor: replace global instance registry with bookmarks"
```

---

### Task 3: Split soul — extract engine base from NyxAI-specific instance soul

**Files:**
- Create: `souls/base.yaml` (engine-level behavioral defaults)
- Modify: `souls/instance.yaml` (strip behavioral rules, keep only NyxAI identity/context)
- Modify: `src/soul/runtime.ts` (load base soul from engine, instance soul from instance dir)

**Step 1: Create engine base soul**

Create `souls/base.yaml` with the behavioral rules currently in `souls/instance.yaml`. These ship with the engine:

```yaml
# Engine base soul — behavioral defaults for all NyxHive agents.
# Ships with the engine. Instance souls layer on top.

rules:
  must:
    - rule: "Be direct and concise — no filler, no preamble, no 'great question', no restating what was asked"
      scope: global
      override: false
    - rule: "Deliver complete work products — finished analysis, full implementations, final answers. Don't stop mid-way to check in"
      scope: global
      override: false
    - rule: "Answer questions you can answer yourself. Only ask when you genuinely lack information that can't be inferred from context"
      scope: global
      override: false
    - rule: "Never claim work is complete without running verification and confirming fresh output in the current response — stale results do not count, no exceptions for confidence or partial checks"
      scope: global
      override: false
    - rule: "Words like 'should', 'probably', 'seems to', 'looks good' are forbidden before running verification — evidence before assertions, always"
      scope: global
      override: false
    - rule: "Include concrete evidence with every completion claim — file paths changed, command output, test results. 'Done' without proof is a false completion"
      scope: global
      override: false
  must_not:
    - rule: "Ask clarifying questions when you have enough context to proceed — figure it out"
      scope: global
      override: false
    - rule: "Stream your thinking process — deliver conclusions, not the journey to get there"
      scope: global
      override: false
    - rule: "End a response with an open question when you were asked to deliver something"
      scope: global
      override: false
    - rule: "Use conversational filler: 'let me know', 'what do you think?', 'before I proceed', 'happy to', 'feel free'"
      scope: global
      override: false
    - rule: "Force push or rewrite published git history"
      scope: global
      override: false
    - rule: "Commit without running pre-commit hooks"
      scope: global
      override: false

claude_md:
  - "You are a NyxHive agent. Execute delegated tasks autonomously."
  - "When a delegation specifies a project or repo, work in that repo — not your workspace."
  - "Instructions in ~/.claude/CLAUDE.md are for the human operator, not for agents. Ignore them if they conflict with your delegation."
```

**Step 2: Strip behavioral rules from instance.yaml, keep NyxAI identity**

The current `souls/instance.yaml` has both rules AND NyxAI-specific context. Move it to the NyxAI instance directory and strip the rules (they now come from base.yaml):

```yaml
# NyxAI instance soul — identity and context for this specific instance
# Behavioral rules come from the engine base soul

context:
  relationships:
    - name: User
      role: founder
      notes: "Direct, no fluff. Approves before major changes ship. Based in Portugal."
  instance_notes: |
    NyxAI is the unified development instance for all User's projects.
    Projects:
      - NyxHive: /home/user/dev/nyxhive (Bun + TypeScript)
      - nyx-ios: /home/user/dev/example-mobile (SwiftUI)
      - NyxLabs: /home/user/dev/example-app (React + Vite + TailwindCSS + Supabase)
      - Deft Voice: /home/user/dev/example-voice (Tauri + Rust + React)
    Vault: /Volumes/ExampleDrive/Obsidian/NyxAI
    When referencing files, always use absolute paths.
```

**Step 3: Update soul runtime to load base soul from engine**

In `src/soul/runtime.ts`, find where it loads `souls/instance.yaml`. Update it to:
1. Always load `souls/base.yaml` from the engine's souls directory (relative to the engine installation)
2. Then load instance soul from the instance directory's `souls/instance.yaml` (if it exists)
3. Layer them: base first, then instance

Check `src/soul/runtime.ts` for the exact loading logic and update accordingly. The key change: the engine's `souls/` directory ships base behavioral defaults. The instance's `souls/` directory ships identity and context.

**Step 4: Run tests**

Run: `bun test`
Expected: PASS — soul compilation tests should still work since the merge logic hasn't changed, just the source of layers.

**Step 5: Commit**

```bash
git add souls/base.yaml souls/instance.yaml src/soul/runtime.ts
git commit -m "refactor: split soul into engine base + instance identity"
```

---

### Task 4: Update `nyxhive init` to scaffold isolated instance directories

**Files:**
- Modify: `src/cli/init.ts`

**Step 1: Update directory structure**

Change the scaffold to create:
```
<name>/
├── config.toml          # (was config/nyxhive.toml)
├── .env
├── data/
├── workspace/
└── souls/
    └── instance.yaml
```

Key changes in `initInteractive()` and `initFromTemplate()`:
- Write config to `<dir>/config.toml` instead of `<dir>/config/nyxhive.toml`
- Create `<dir>/souls/` and write a stub `instance.yaml`
- Auto-add bookmark after scaffold
- Remove dependency on `listInstances()` for port detection — use bookmarks instead
- Update the "Start your instance" message to `cd <dir> && nyxhive start`

**Step 2: Create stub instance.yaml template**

When scaffolding, generate:
```yaml
# <InstanceName> instance soul
# Add identity, context, and relationships specific to this instance.
# Behavioral rules come from the engine base soul.

context:
  instance_notes: |
    <InstanceName> instance.
```

**Step 3: Run tests**

Run: `bun test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/cli/init.ts
git commit -m "refactor: nyxhive init scaffolds isolated instance directories"
```

---

### Task 5: Update resolve.ts for new instance directory layout

**Files:**
- Modify: `src/cli/resolve.ts`

**Step 1: Update resolveInstance()**

The resolution order becomes:
1. Explicit `--config` flag (unchanged)
2. Name matches a bookmark → use bookmark's path + `config.toml`
3. CWD contains `config.toml` (new flat layout)
4. CWD contains `config/nyxhive.toml` (backwards compat with old layout)

```typescript
export function resolveInstance(
  nameOrPath?: string,
  _instancesDir?: string, // deprecated param, kept for API compat
  configPath?: string,
): ResolvedInstance {
  // 1. Explicit --config flag
  if (configPath) {
    const abs = resolve(configPath);
    if (!existsSync(abs)) throw new Error(`Config file not found: ${abs}`);
    return { configPath: abs, instanceDir: dirname(abs) };
  }

  // 2. Named instance → check bookmarks
  if (nameOrPath) {
    const bookmarks = loadBookmarks();
    const bookmark = bookmarks.bookmarks.find(b => b.name === nameOrPath);
    if (bookmark) {
      const cfgPath = join(bookmark.path, "config.toml");
      if (existsSync(cfgPath)) {
        return { configPath: cfgPath, instanceDir: bookmark.path };
      }
    }

    // 2b. Legacy: ~/.nyxhive/instances/<Name>/config.toml
    const legacyPath = join(DEFAULT_INSTANCES_DIR, nameOrPath, "config.toml");
    if (existsSync(legacyPath)) {
      return { configPath: legacyPath, instanceDir: join(DEFAULT_INSTANCES_DIR, nameOrPath) };
    }

    // 2c. Direct directory path
    const dirPath = resolve(nameOrPath);
    const dirConfig = join(dirPath, "config.toml");
    if (existsSync(dirConfig)) {
      return { configPath: dirConfig, instanceDir: dirPath };
    }

    throw new Error(`Instance "${nameOrPath}" not found. Check bookmarks or provide a valid path.`);
  }

  // 3. CWD: config.toml (new layout)
  const cwdFlat = resolve(process.cwd(), "config.toml");
  if (existsSync(cwdFlat)) {
    return { configPath: cwdFlat, instanceDir: resolve(process.cwd()) };
  }

  // 4. CWD: config/nyxhive.toml (legacy layout)
  const cwdLegacy = resolve(process.cwd(), "config", "nyxhive.toml");
  if (existsSync(cwdLegacy)) {
    return { configPath: cwdLegacy, instanceDir: resolve(process.cwd()) };
  }

  throw new Error("No instance found. Usage: nyxhive <command> <InstanceName> or run from an instance directory.");
}
```

**Step 2: Update listInstances()**

Read from bookmarks instead of scanning `~/.nyxhive/instances/`:

```typescript
export function listInstances(): InstanceInfo[] {
  const { bookmarks } = loadBookmarks();
  const instances: InstanceInfo[] = [];

  for (const bm of bookmarks) {
    const cfgPath = join(bm.path, "config.toml");
    if (!existsSync(cfgPath)) continue;
    try {
      const raw = readFileSync(cfgPath, "utf-8");
      const parsed = JSON.parse(JSON.stringify(TOML.parse(raw)));
      instances.push({
        name: parsed.daemon?.name ?? bm.name,
        configPath: cfgPath,
        instanceDir: bm.path,
        port: parsed.server?.port ?? bm.port ?? 0,
        dataDir: parsed.daemon?.data_dir ?? join(bm.path, "data"),
      });
    } catch { continue; }
  }

  return instances;
}
```

**Step 3: Run tests**

Run: `bun test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/cli/resolve.ts
git commit -m "refactor: resolve instances via bookmarks and CWD, not global registry"
```

---

### Task 6: Clean up MCP config and browser profile

**Files:**
- Modify: `/home/user/dev/.mcp.json` (remove hardcoded NyxAI MCP)
- Keep: `/home/user/dev/nyxhive/.mcp.json` (already points to NyxAI correctly)
- Modify: Playwright MCP config to use per-instance browser profile

**Step 1: Remove the global dev/.mcp.json**

Delete `/home/user/dev/.mcp.json`. This is the file that hardcodes `NYXHIVE_INSTANCE: NyxAI` for all projects under `~/dev/`.

**Step 2: Update nyxhive/.mcp.json Playwright config**

Change the shared browser profile to per-instance:

```json
{
  "mcpServers": {
    "nyxhive": {
      "type": "http",
      "url": "http://localhost:3777/api/mcp",
      "headers": {
        "Authorization": "Bearer ${NYXHIVE_API_KEY}"
      }
    },
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--browser", "chrome",
        "--user-data-dir", "./data/browser-profile"
      ]
    }
  }
}
```

Note: `./data/browser-profile` is relative to where Claude Code runs (the nyxhive repo), which is also the NyxAI instance directory. For other instances, their `.mcp.json` would use their own `data/browser-profile`.

**Step 3: Commit**

```bash
git add /home/user/dev/nyxhive/.mcp.json
git commit -m "chore: per-instance browser profile in MCP config"
```

Note: Deletion of `/home/user/dev/.mcp.json` is a manual step outside the repo.

---

### Task 7: Migrate existing instances and clean up stale data

This is a manual migration task. No code changes.

**Step 1: Register existing instances as bookmarks**

```bash
# From the nyxhive repo, after the code changes are in place:
nyxhive instances add NyxAI --path ~/.nyxhive/instances/NyxAI
nyxhive instances add NyxLabs --path ~/.nyxhive/instances/NyxLabs
nyxhive instances add Acme --path ~/.nyxhive/instances/Acme
```

**Step 2: Update existing instance configs**

For each instance config at `~/.nyxhive/instances/<Name>/config.toml`:
- Rename `[instances]` section to `[remotes]` (if present) — only NyxAI should have this
- Remove `[instances]` from NyxLabs and Acme configs entirely (they're leaf nodes)

**Step 3: Delete stale global files**

```bash
rm ~/.nyxhive/instances.json        # old global registry
rm ~/.nyxhive/nyxai.db              # stale root-level DB
rm ~/.nyxhive/nyxhive.db            # stale root-level DB
```

**Step 4: Copy NyxAI-specific instance soul to NyxAI instance dir**

```bash
cp souls/instance.yaml ~/.nyxhive/instances/NyxAI/souls/instance.yaml
```

(After Task 3 has split the soul, this copies the NyxAI-specific identity to NyxAI's instance directory.)

**Step 5: Delete `/home/user/dev/.mcp.json`**

```bash
rm /home/user/dev/.mcp.json
```

**Step 6: Verify each instance starts cleanly**

```bash
nyxhive start NyxAI
# Check: connects, loads config, no registry errors
nyxhive stop NyxAI
```

---

### Task 8: Run full verification

**Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass

**Step 2: Run type checker**

Run: `bunx tsc --noEmit`
Expected: Clean — no type errors

**Step 3: Start NyxAI instance and verify MCP**

Run: `nyxhive start NyxAI -d`
Then: Open Claude Code in `/home/user/dev/nyxhive/`, verify MCP tools are available.
Run: `nyxhive stop NyxAI`

**Step 4: Commit any remaining fixes**

```bash
git add -A
git commit -m "chore: instance isolation migration complete"
```
