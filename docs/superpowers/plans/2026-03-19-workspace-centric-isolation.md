# Workspace-Centric Instance Isolation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each workspace repo a fully self-contained NyxHive instance — clone the repo, fill in `.env`, run `nyxhive start`, everything works.

**Architecture:** Move instance config (config.toml, souls, .env) from `~/.nyxhive/instances/{name}/` into each workspace repo under `.nyxhive/`. The `~/.nyxhive/` directory becomes purely runtime state (SQLite DBs, PIDs, browser profiles). Config resolution gains a new priority: `$CWD/.nyxhive/config.toml`. Workspace files (CLAUDE.md, PLATFORM.md, AGENTS.md) become committed artifacts that the engine updates on boot rather than creates from scratch.

**Tech Stack:** TypeScript/Bun, TOML config, Zod validation

---

## Current State (What's Wrong)

```
~/.nyxhive/instances/Acme/     ← Instance identity lives HERE
  config.toml
  souls/instance.yaml
  .env
  data/                           ← Runtime state

/home/user/work/acme-agentic-workspace/   ← Workspace lives HERE
  .mcp.json                       ← Just added
  src/...                         ← Actual code
  (CLAUDE.md, PLATFORM.md)       ← Generated at boot, ephemeral
```

**Problems:**
1. Clone workspace on new machine → bare shell, no config, no identity
2. Workspace files vanish if NyxHive doesn't boot
3. Skills/plugins resolve to dev machine path via `import.meta.dir`
4. `NYXHIVE_API_KEY` stripped by `sanitizeEnv`, breaks `.mcp.json` auth (already fixed)
5. **Pre-existing bug:** Soul loader always reads `instance.yaml` from `ENGINE_SOULS_DIR` — Acme and NyxLabs instance souls at `~/.nyxhive/instances/{name}/souls/` are never loaded. All instances get NyxAI's identity.

**Gotchas discovered during review:**
- `normalizeConfigPaths()` resolves relative paths from `dirname(configPath)`. When config moves to `.nyxhive/config.toml`, relative paths resolve from `.nyxhive/`, not the workspace root. This is fine for `data_dir` (convention-based default handles it) but document for future config authors.
- `create-hive.ts` has its own `.env` loader (lines 65-92) separate from `loadInstanceEnv()` in `resolve.ts`. Both will find `.nyxhive/.env` correctly, but they have different override semantics (CLI loader doesn't override, create-hive does).
- `listInstances()` in `resolve.ts:142-163` reads raw TOML for display — won't apply convention-based `data_dir` default. Non-blocking (display-only).

## Target State

```
acme-agentic-workspace/
  .nyxhive/
    config.toml                  ← Instance config (moved from ~/.nyxhive/)
    souls/
      instance.yaml              ← Instance identity
    .env                         ← Credentials (gitignored)
    .env.template                ← Required keys (committed)
  .claude/
    CLAUDE.md                    ← Committed, updated on boot
    settings.json                ← Committed
  .claude-plugin/
    plugin.json                  ← Committed, updated on boot
  .mcp.json                      ← Committed
  AGENTS.md                      ← Committed
  PLATFORM.md                    ← Committed, updated on boot
  src/...

~/.nyxhive/
  bookmarks.json                 ← Points to workspace repos now
  data/
    acme/                     ← Runtime: SQLite DBs, PID, browser profile
    nyxai/
    nyxlabs/
```

---

## Task 1: Add `.nyxhive/config.toml` to Config Resolution

**Files:**
- Modify: `src/cli/resolve.ts:28-86` — add `.nyxhive/` subdirectory check
- Modify: `src/config.ts:8-20` — add `.nyxhive/` to foreground resolution
- Test: `src/__tests__/resolve.test.ts` (or create if missing)

The config resolution already checks `$CWD/config.toml`. We add `$CWD/.nyxhive/config.toml` as a higher-priority check, since the `.nyxhive/` convention is the new standard.

- [ ] **Step 1: Write failing test — `.nyxhive/config.toml` resolution**

```typescript
// In resolve test file
it("resolves .nyxhive/config.toml in CWD before config.toml", () => {
  // Create temp dir with both .nyxhive/config.toml and config.toml
  // Verify .nyxhive/config.toml wins
});

it("falls back to config.toml when .nyxhive/ doesn't exist", () => {
  // Only config.toml present, verify it still works
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/resolve.test.ts -v`
Expected: FAIL — `.nyxhive/` path not checked

- [ ] **Step 3: Update `resolveInstance()` in `src/cli/resolve.ts`**

Add after the named instance checks (line 69) and before the CWD flat check (line 71):

```typescript
// 3. CWD: .nyxhive/config.toml (workspace-centric layout)
const cwdNyxhive = resolve(process.cwd(), ".nyxhive", "config.toml");
if (existsSync(cwdNyxhive)) {
  return { configPath: cwdNyxhive, instanceDir: resolve(process.cwd(), ".nyxhive") };
}
```

Renumber existing steps 3→4, 4→5.

- [ ] **Step 4: Update `resolveConfigPath()` in `src/config.ts`**

Add `.nyxhive/config.toml` check before the existing `./config.toml` check:

```typescript
// .nyxhive/config.toml (workspace-centric)
const nyxhivePath = resolve(process.cwd(), ".nyxhive", "config.toml");
if (existsSync(nyxhivePath)) return nyxhivePath;
```

- [ ] **Step 5: Update `loadInstanceEnv()` in `src/cli/resolve.ts`**

The `.env` file now lives in `.nyxhive/` alongside `config.toml`. `loadInstanceEnv(instanceDir)` already looks in `instanceDir` for `.env` / `env`, so this works automatically since `instanceDir` will be `.nyxhive/`.

No code change needed — just verify the test confirms it.

- [ ] **Step 6: Run tests, verify pass**

Run: `bun test src/__tests__/resolve.test.ts -v`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `bun test`
Expected: All pass, no regressions

- [ ] **Step 8: Commit**

```bash
git add src/cli/resolve.ts src/config.ts src/__tests__/resolve.test.ts
git commit -m "feat: add .nyxhive/config.toml to config resolution chain"
```

---

## Task 2: Fix Soul Loader — Instance Souls from `instanceDir`

**Files:**
- Modify: `src/soul/runtime.ts:49-53` — accept and use instance souls directory
- Modify: `src/soul/runtime.ts:104-108` — look for instance.yaml in instance souls dir
- Modify: `src/framework/create-hive.ts` — pass instance souls dir to soul system
- Modify: `src/agents/workspace.ts:77` — pass instance souls dir to `loadAndCompileSoul()`
- Test: `src/__tests__/soul-runtime.test.ts`

**Pre-existing bug:** `loadAndCompileSoul(agentKey)` always looks for `instance.yaml` in `ENGINE_SOULS_DIR` (the engine's `souls/` directory). This means ALL instances load NyxAI's `instance.yaml` — Acme's access control rules, NyxLabs' trading journal context, etc. are never injected.

The fix: the soul runtime needs to know the instance's souls directory (`.nyxhive/souls/`) separately from the engine's souls directory. Engine souls provide base.yaml + agent definitions. Instance souls provide instance.yaml (identity/context).

- [ ] **Step 1: Write failing test — instance soul loaded from custom dir**

```typescript
it("loads instance.yaml from instanceSoulsDir when provided", () => {
  // Create temp dir with instance.yaml containing unique content
  // Call loadAndCompileSoul with instanceSoulsDir
  // Verify instance.yaml content is in the compiled soul
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/soul-runtime.test.ts -v`
Expected: FAIL — no `instanceSoulsDir` parameter exists

- [ ] **Step 3: Add `instanceSoulsDir` parameter to soul loader**

In `src/soul/runtime.ts`, update `loadAndCompileSoul()`:

```typescript
export function loadAndCompileSoul(
  agentKey: string,
  soulsDir?: string,
  instanceSoulsDir?: string,  // NEW: instance-specific souls (for instance.yaml)
): ComposedSoul | undefined {
```

In the v1 YAML path (line 104-108), change instance.yaml resolution:

```typescript
// Instance layer (identity and context) — check instance dir first, fall back to engine
const instanceDirs = [instanceSoulsDir, dir].filter(Boolean) as string[];
for (const iDir of instanceDirs) {
  const instanceFile = resolve(iDir, "instance.yaml");
  if (existsSync(instanceFile)) {
    layers.push(loadSoulFile(instanceFile));
    break;
  }
}
```

Do the same for v2 path if applicable.

Also update `getSoulSystemPrompt()` to accept and forward `instanceSoulsDir`.

- [ ] **Step 4: Wire instance souls dir through create-hive**

In `src/framework/create-hive.ts`, after config is loaded, resolve the instance souls directory:

```typescript
const instanceSoulsDir = resolve(instanceDir, "souls");
```

Pass this to the agent registry, workspace generator, and anywhere `loadAndCompileSoul` is called.

- [ ] **Step 5: Update workspace.ts to pass instanceSoulsDir**

In `src/agents/workspace.ts:77`:

```typescript
const soul = loadAndCompileSoul(agentKey, undefined, instanceSoulsDir);
```

- [ ] **Step 6: Update invoke-cli.ts:450 to pass instanceSoulsDir**

```typescript
const soul = loadAndCompileSoul(opts.agentKey, undefined, opts.instanceSoulsDir);
```

Add `instanceSoulsDir` to `InvokeOpts` type.

- [ ] **Step 7: Run tests, verify pass**

Run: `bun test`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add src/soul/runtime.ts src/framework/create-hive.ts src/agents/workspace.ts src/agents/invoke-cli.ts src/__tests__/soul-runtime.test.ts
git commit -m "fix: load instance.yaml from instance souls dir, not engine souls dir"
```

---

## Task 3: Centralize Runtime Data Directory (was Task 2)

**Files:**
- Modify: `src/framework/create-hive.ts:120-131` — data dir defaults
- Modify: `src/config-schema.ts` — make `data_dir` optional with convention-based default

Currently each `config.toml` has an absolute `data_dir` path pointing to `~/.nyxhive/instances/{name}/data/`. When config moves into the workspace, we need a convention-based default: `~/.nyxhive/data/{instance_name}/`.

- [ ] **Step 1: Write failing test — default data_dir resolution**

```typescript
it("defaults data_dir to ~/.nyxhive/data/{name}/ when not specified", () => {
  const config = loadConfig(configWithoutDataDir);
  expect(config.daemon.data_dir).toBe(
    join(homedir(), ".nyxhive", "data", "testinstance")
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/config.test.ts -v`
Expected: FAIL — data_dir is required

- [ ] **Step 3: Make `data_dir` optional in schema**

In `src/config-schema.ts`, change `data_dir` from required to optional:

```typescript
data_dir: z.string().optional(),
```

- [ ] **Step 4: Add default data_dir resolution BEFORE `normalizeConfigPaths()`**

In `src/config.ts`, **before** the call to `normalizeConfigPaths()` (critical — the `!` non-null assertion in `normalizeConfigPaths` will crash if `data_dir` is still undefined):

```typescript
// Convention-based default: ~/.nyxhive/data/{instance_name}/
if (!config.daemon.data_dir) {
  const name = config.daemon.name?.toLowerCase().replace(/[^a-z0-9]+/g, "_") ?? "default";
  config.daemon.data_dir = join(homedir(), ".nyxhive", "data", name);
}

// Now safe to normalize (data_dir is guaranteed to be set)
normalizeConfigPaths(config, instanceDir);
```

Also update the `!` assertion in `normalizeConfigPaths()` to a proper fallback for safety:

```typescript
data_dir: resolveFromInstanceDir(instanceDir, config.daemon.data_dir ?? join(homedir(), ".nyxhive", "data", "default")),
```

- [ ] **Step 5: Run tests, verify pass**

Run: `bun test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/config-schema.ts src/config.ts src/__tests__/config.test.ts
git commit -m "feat: convention-based data_dir defaults to ~/.nyxhive/data/{name}"
```

---

## Task 4: Migrate Instance Configs to Workspace Repos

**Files:**
- Create: `/home/user/work/acme-agentic-workspace/.nyxhive/config.toml`
- Create: `/home/user/work/acme-agentic-workspace/.nyxhive/souls/instance.yaml`
- Create: `/home/user/work/acme-agentic-workspace/.nyxhive/.env`
- Create: `/home/user/work/acme-agentic-workspace/.nyxhive/.env.template`
- Create: `/home/user/dev/nyxlabs-hive/.nyxhive/config.toml` (NyxLabs uses its own repo as workspace)
- Create: `/home/user/dev/nyxlabs-hive/.nyxhive/souls/instance.yaml`
- Create: `/home/user/dev/nyxlabs-hive/.nyxhive/.env`
- Create: `/home/user/dev/nyxlabs-hive/.nyxhive/.env.template`
- NyxAI: stays in `/home/user/dev/nyxhive` — config already in the repo (it IS the engine)

This is a file migration — no code changes. Each workspace gets its config copied from `~/.nyxhive/instances/`.

- [ ] **Step 1: Create `.nyxhive/` directory in Acme workspace**

```bash
mkdir -p /home/user/work/acme-agentic-workspace/.nyxhive/souls
```

- [ ] **Step 2: Copy Acme config.toml**

```bash
cp /home/user/.nyxhive/instances/Acme/config.toml \
   /home/user/work/acme-agentic-workspace/.nyxhive/config.toml
```

- [ ] **Step 3: Edit Acme config.toml — remove absolute `data_dir`**

Remove or comment out the `data_dir` line. The convention-based default from Task 3 will resolve to `~/.nyxhive/data/acme/`.

- [ ] **Step 4: Copy Acme souls**

```bash
cp /home/user/.nyxhive/instances/Acme/souls/instance.yaml \
   /home/user/work/acme-agentic-workspace/.nyxhive/souls/instance.yaml
```

- [ ] **Step 5: Copy Acme .env**

```bash
cp /home/user/.nyxhive/instances/Acme/env \
   /home/user/work/acme-agentic-workspace/.nyxhive/.env
```

- [ ] **Step 6: Create Acme .env.template**

```env
# Required credentials for Acme instance
OPENROUTER_API_KEY=
BRAVE_SEARCH_API_KEY=
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
NYXHIVE_API_KEY=
```

- [ ] **Step 7: Add `.nyxhive/.env` to Acme's `.gitignore`**

```
.nyxhive/.env
```

- [ ] **Step 8: Repeat steps 1-7 for NyxLabs**

Target: `/home/user/dev/nyxlabs-hive/.nyxhive/`
Source: `/home/user/.nyxhive/instances/NyxLabs/`

- [ ] **Step 9: Handle NyxAI**

NyxAI is special — the workspace IS the NyxHive repo. Options:
- Move NyxAI config to `/home/user/dev/nyxhive/.nyxhive/config.toml`
- This keeps the same pattern: engine repo doubles as NyxAI's workspace

```bash
mkdir -p /home/user/dev/nyxhive/.nyxhive/souls
cp /home/user/.nyxhive/instances/NyxAI/config.toml /home/user/dev/nyxhive/.nyxhive/config.toml
cp /home/user/.nyxhive/instances/NyxAI/souls/instance.yaml /home/user/dev/nyxhive/.nyxhive/souls/instance.yaml
cp /home/user/.nyxhive/instances/NyxAI/.env /home/user/dev/nyxhive/.nyxhive/.env
```

**Important:** Add `.nyxhive/.env` to the NyxHive repo's `.gitignore` — the engine repo is shared/public and the `.env` contains secrets:

```bash
echo ".nyxhive/.env" >> /home/user/dev/nyxhive/.gitignore
```

- [ ] **Step 10: Update bookmarks to point to workspace repos**

Use `nyxhive instances add` (there is no `bookmark update` command — `add` overwrites existing entries):

```bash
nyxhive instances add Acme --path /home/user/work/acme-agentic-workspace/.nyxhive --port 3779
nyxhive instances add NyxLabs --path /home/user/dev/nyxlabs-hive/.nyxhive --port 3778
nyxhive instances add NyxAI --path /home/user/dev/nyxhive/.nyxhive --port 3777
```

Or edit `~/.nyxhive/bookmarks.json` directly.

- [ ] **Step 11: Verify — boot each instance from workspace**

```bash
cd /home/user/work/acme-agentic-workspace && nyxhive start
cd /home/user/dev/nyxlabs-hive && nyxhive start
cd /home/user/dev/nyxhive && nyxhive start
```

Each should find `.nyxhive/config.toml` and boot normally.

- [ ] **Step 12: Migrate data directories**

Move data from old location to convention-based location:

```bash
mv /home/user/.nyxhive/instances/Acme/data /home/user/.nyxhive/data/acme
mv /home/user/.nyxhive/instances/NyxLabs/data /home/user/.nyxhive/data/nyxlabs
mv /home/user/.nyxhive/instances/NyxAI/data /home/user/.nyxhive/data/nyxai
```

- [ ] **Step 13: Commit config migration (per workspace repo)**

Each workspace repo gets its own commit:
```bash
git add .nyxhive/ .gitignore
git commit -m "feat: add NyxHive instance config for workspace-centric isolation"
```

---

## Task 5: Commit Workspace Files

**Files:**
- Modify: `src/agents/workspace.ts:19-107` — change to update-not-create for committed files
- Per workspace: commit existing AGENTS.md, PLATFORM.md, .claude/CLAUDE.md, .claude/settings.json, .claude-plugin/plugin.json

Currently `ensureWorkspace()` overwrites CLAUDE.md, PLATFORM.md, and plugin.json on every boot. Once these are committed, the engine should still update them (config/soul may change), but the files exist even without NyxHive running.

- [ ] **Step 1: Commit existing workspace files in each repo**

For each workspace that already has generated files, commit them as-is:

```bash
# In each workspace repo:
git add AGENTS.md PLATFORM.md .claude/CLAUDE.md .claude/settings.json .claude-plugin/plugin.json .mcp.json
git commit -m "chore: commit workspace files for standalone operation"
```

- [ ] **Step 2: No code changes needed in workspace.ts**

The current behavior (overwrite on boot) is actually correct — it ensures committed files stay in sync with config/soul changes. The difference is now the files exist even if NyxHive hasn't booted (from the git commit).

The only change: `ensureWorkspace()` should log at `debug` level instead of `info` when files already exist, to reduce noise.

- [ ] **Step 3: Run tests, verify pass**

Run: `bun test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/agents/workspace.ts
git commit -m "chore: reduce workspace file regeneration log noise"
```

---

## Task 6: Make Skills Path Portable

**Files:**
- Modify: `src/agents/skill-loader.ts:4-6` — resolve skills from engine installation, not dev path
- Modify: `src/agents/skill-loader.ts:37-42` — plugin.json uses engine-relative path

Currently `getSkillsDir()` uses `import.meta.dir` which resolves relative to the running source file. This works when running from the dev directory (`/home/user/dev/nyxhive/src/agents/` → `../../skills` → `/home/user/dev/nyxhive/skills/`).

When NyxHive is installed globally (e.g., `bun install -g`), `import.meta.dir` would point to the global install location, which is correct. So the current code is actually portable — it resolves relative to wherever NyxHive is installed.

- [ ] **Step 1: Verify — no change needed**

The `import.meta.dir` approach is already portable. When NyxHive is:
- Run from dev: resolves to `/home/user/dev/nyxhive/skills/`
- Installed globally: resolves to `{global_install}/skills/`

The path in `plugin.json` will always point to the engine's skills directory, wherever it is.

- [ ] **Step 2: Document this in CLAUDE.md**

Add a note to the project structure docs explaining that skills are bundled with the engine.

- [ ] **Step 3: Commit if any doc changes**

---

## Task 7: Update CLAUDE.md Documentation

**Files:**
- Modify: `/home/user/dev/nyxhive/CLAUDE.md` — update instance layout docs and resolution order

The CLAUDE.md already documents instance layout. Update it to reflect the new workspace-centric structure.

- [ ] **Step 1: Update instance layout section**

Change the instance layout documentation to show the `.nyxhive/` directory living inside the workspace:

```markdown
- **Instance layout** — Each workspace repo is a self-contained instance:
  \`\`\`
  my-workspace/
    .nyxhive/
      config.toml          # Instance configuration
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
  \`\`\`
```

- [ ] **Step 2: Update CLI resolution order**

```markdown
- CLI resolution order: `--config` flag > bookmark name > `$CWD/.nyxhive/config.toml` > `~/.nyxhive/instances/<Name>/` (legacy) > CWD `config.toml` > CWD `config/nyxhive.toml`.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update instance layout for workspace-centric isolation"
```

---

## Task 8: Legacy Compatibility — Deprecation Path

**Files:**
- Modify: `src/cli/resolve.ts` — add deprecation warning for `~/.nyxhive/instances/` resolution

The old `~/.nyxhive/instances/{name}/config.toml` path should still work but log a deprecation warning pointing users to the workspace-centric layout.

- [ ] **Step 1: Add deprecation warning**

In `resolveInstance()`, after the legacy path check (line 54-56):

```typescript
const legacyPath = join(instancesDir, nameOrPath, "config.toml");
if (existsSync(legacyPath)) {
  logger.warn(`[config] Using legacy path ~/.nyxhive/instances/${nameOrPath}/ — migrate to workspace .nyxhive/ directory`);
  return { configPath: legacyPath, instanceDir: join(instancesDir, nameOrPath) };
}
```

- [ ] **Step 2: Run tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/cli/resolve.ts
git commit -m "chore: add deprecation warning for legacy instance directory"
```

---

## Task 9: Verify End-to-End

No code changes — pure verification.

- [ ] **Step 1: Boot NyxAI from workspace**

```bash
cd /home/user/dev/nyxhive
bun run start --brain opus
```

Verify: Loads `.nyxhive/config.toml`, boots normally, all agents register.

- [ ] **Step 2: Boot Acme from workspace**

```bash
cd /home/user/work/acme-agentic-workspace
nyxhive start
```

Verify: Loads `.nyxhive/config.toml`, Morph responds, Slack connects.

- [ ] **Step 3: Boot NyxLabs from workspace**

```bash
cd /home/user/dev/nyxlabs-hive
nyxhive start
```

Verify: Loads `.nyxhive/config.toml`, Vortex responds, Telegram connects.

- [ ] **Step 4: Verify MCP tools work**

From each Claude Code session in each workspace, confirm NyxHive MCP tools are available (the `.mcp.json` + `NYXHIVE_API_KEY` injection from the earlier fix).

- [ ] **Step 5: Verify workspace files survive without NyxHive**

```bash
# Kill all instances
# Open Claude Code in each workspace
# Confirm CLAUDE.md, PLATFORM.md, AGENTS.md, .mcp.json all exist and contain correct content
```

- [ ] **Step 6: Simulate new machine**

```bash
# Clone workspace to /tmp, fill in .env from template, boot
cd /tmp
git clone /home/user/work/acme-agentic-workspace test-acme
cd test-acme
cp .nyxhive/.env.template .nyxhive/.env
# Fill in credentials
nyxhive start
```

---

## Execution Order & Dependencies

```
Task 1 (config resolution)   ─┐
Task 2 (soul loader fix)      ├── Code changes (engine)
Task 3 (data_dir defaults)    │
Task 8 (deprecation warning)  ─┘
         │
Task 4 (migrate configs)      ← Depends on Tasks 1+2+3
         │
Task 5 (commit workspace files) ← Depends on Task 4
Task 6 (skills path — verify only)
Task 7 (docs update)
         │
Task 9 (end-to-end verify)    ← Depends on all above
```

Tasks 1, 2, 3, 8 can be done in parallel (independent code changes).
Tasks 6, 7 can be done in parallel with Task 5.

---

## Rollback

If anything breaks:
- Old configs in `~/.nyxhive/instances/` are untouched until Task 3 step 12 (data move)
- Legacy resolution still works (Task 7 just adds a warning, doesn't remove)
- Bookmarks can be pointed back to `~/.nyxhive/instances/`
- Data move is the only destructive step — backup first

## What This Doesn't Cover

- **Global NyxHive installation** — NyxHive as `bun install -g nyxhive`. Separate concern, not blocking.
- **Per-instance NyxHive versioning** — pinning each instance to a specific engine version. Future work.
- **Federation config migration** — remotes still use hardcoded `localhost` ports. Fine for single machine, needs revisiting for multi-machine.
