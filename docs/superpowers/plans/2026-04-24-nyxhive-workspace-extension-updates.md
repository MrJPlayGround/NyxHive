# NyxHive Instance Workspace Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NyxHive the upgradeable engine while Astra/Vortex live as separate isolated NyxHive instances that can see and acknowledge core engine updates.

**Architecture:** Add an instance workspace manifest and registry layer over the existing workspace-centric instance model. Agent instance workspaces declare their own NyxHive runtime config, souls, data namespace, port, agents, and engine dependency; product repos can declare update awareness without becoming agents. Engine update detection starts with local Git commits because all repos currently live on one machine, while the registry and engine source contract stay explicit enough for package or remote feeds later.

**Tech Stack:** TypeScript/Bun, citty CLI, TOML manifests, existing Nyx workspace UI, existing framework extension types.

---

## Scope

This plan implements the skeleton/application boundary User described:

- NyxHive core remains the skeleton and owns runtime, queue plumbing, context assembly, tool contracts, permissions, CLI/API, update checks, and the workspace shell.
- Astra Trading and Vortex/NyxLabs become separate NyxHive agent instance workspaces, each with its own repo, `.nyxhive/config.toml`, `.nyxhive/souls/`, runtime port, data namespace, and domain code.
- Deft Voice is treated as a product repo, not an agent. This plan does not move the Deft Voice repository. It only allows a product manifest if we want NyxHive update visibility there later.
- NyxHive update notices surface in Astra/Vortex workspaces when the engine repo advances beyond the workspace's recorded engine lock.
- Workspace discovery is registry-driven, not hardcoded to User's current folder layout. The local machine registry is the first source; remote/package discovery can be added behind the same contract later.

## Instance Isolation Rule

Astra and Vortex are not extensions installed inside NyxHive core. They are separate NyxHive instances that depend on the NyxHive engine.

The engine owns shared mechanics: provider routing, queueing, session execution, memory plumbing, tool permission contracts, workspace UI, CLI/API, and update detection.

Each agent instance owns its domain: agents, soul layers, domain prompts, tools, app-specific routes, evaluation data, runtime secrets, and tests. Astra owns trading. Vortex owns NyxLabs/product workflow. Neither ships domain behavior from the engine repo.

## Current Evidence

- `src/framework/types.ts` already exposes public extension interfaces and `ENGINE_API_VERSION`.
- `docs/superpowers/specs/2026-03-15-instance-isolation-design.md` already defines NyxHive as framework plus instance repos.
- `docs/superpowers/plans/2026-03-19-workspace-centric-isolation.md` already moves instance config toward per-workspace `.nyxhive/config.toml`.
- `src/nyx/lib/workspace-profiles.ts` still hardcodes NyxAI and Vortex workspace profiles.
- `src/nyx/commands/workspace.ts` already has the CLI surface to extend: `list`, `status`, `start`, `stop`, `command`, `doctor`.
- `src/nyx-workspace/src/server/gateway-capabilities.ts` already has a gateway capability check path where workspace update notices can be added.

## Target File Structure

### NyxHive Core

```text
/home/user/dev/nyxhive/
  .nyxhive/
    config.toml
    workspace.toml
    engine.lock
  src/
    workspaces/
      manifest.ts
      registry.ts
      registry-store.ts
      updates.ts
    nyx/
      commands/
        workspace.ts
        updates.ts
      lib/
        workspace-profiles.ts
    nyx-workspace/
      src/
        server/
          workspace-updates.ts
        routes/
          api/
            workspace/
              updates.ts
```

### Astra Trading Instance Workspace

```text
/home/user/dev/example-trading/
  .nyxhive/
    workspace.toml
    config.toml
    engine.lock
    .env
    souls/
      instance.yaml
  src/
    strategies/
    risk/
    tools/
    evals/
```

### Vortex/NyxLabs Instance Workspace

```text
/home/user/dev/example-labs/
  .nyxhive/
    workspace.toml
    config.toml
    engine.lock
    .env
    souls/
      instance.yaml
  src/
```

### Deft Voice Product Repo

```text
/home/user/dev/example-voice/
  .nyxhive/
    workspace.toml
    engine.lock
  src/
```

Deft Voice's manifest uses `kind = "product"`. It does not get `config.toml`, agents, souls, queue state, workspace start commands, or agent UI unless a future task explicitly adds a Deft agent instance. Do not move this repo in this implementation; moving products is a separate filesystem/project-organization task.

---

## Task 1: Add Workspace Manifest Types And Loader

**Files:**
- Create: `src/workspaces/manifest.ts`
- Test: `src/__tests__/workspace-manifest.test.ts`

- [ ] **Step 1: Write failing manifest tests**

Create `src/__tests__/workspace-manifest.test.ts`:

```typescript
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { loadWorkspaceManifest } from "../workspaces/manifest.js";

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "nyxhive-workspace-manifest-"));
}

describe("workspace manifest", () => {
  test("loads an agent instance manifest", () => {
    const root = tempWorkspace();
    mkdirSync(join(root, ".nyxhive"), { recursive: true });
    writeFileSync(join(root, ".nyxhive", "workspace.toml"), `
id = "astra-trading"
kind = "agent"
display_name = "Astra Trading"

[engine]
source = "local-git"
path = "/home/user/dev/nyxhive"
ref = "master"
constraint = ">=0.1 <0.2"

[runtime]
instance_id = "astra-trading"
data_namespace = "astra-trading"
config = ".nyxhive/config.toml"
api_url = "http://127.0.0.1:3782"
agents = ["astra"]
`);

    const manifest = loadWorkspaceManifest(root);

    expect(manifest.id).toBe("astra-trading");
    expect(manifest.kind).toBe("agent");
    expect(manifest.engine.source).toBe("local-git");
    expect(manifest.runtime?.instance_id).toBe("astra-trading");
    expect(manifest.runtime?.data_namespace).toBe("astra-trading");
    expect(manifest.runtime?.agents).toEqual(["astra"]);
  });

  test("loads a product manifest without runtime config", () => {
    const root = tempWorkspace();
    mkdirSync(join(root, ".nyxhive"), { recursive: true });
    writeFileSync(join(root, ".nyxhive", "workspace.toml"), `
id = "deft-voice"
kind = "product"
display_name = "Deft Voice"

[engine]
source = "local-git"
path = "/home/user/dev/nyxhive"
ref = "master"
constraint = ">=0.1 <0.2"
`);

    const manifest = loadWorkspaceManifest(root);

    expect(manifest.kind).toBe("product");
    expect(manifest.runtime).toBeUndefined();
  });

  test("rejects agent manifests without isolated instance identity", () => {
    const root = tempWorkspace();
    mkdirSync(join(root, ".nyxhive"), { recursive: true });
    writeFileSync(join(root, ".nyxhive", "workspace.toml"), `
id = "astra-trading"
kind = "agent"
display_name = "Astra Trading"

[engine]
source = "local-git"
path = "/home/user/dev/nyxhive"
ref = "master"
constraint = ">=0.1 <0.2"

[runtime]
config = ".nyxhive/config.toml"
api_url = "http://127.0.0.1:3782"
agents = ["astra"]
`);

    expect(() => loadWorkspaceManifest(root)).toThrow("Agent instances must declare runtime.instance_id and runtime.data_namespace");
  });

  test("rejects product manifests that declare runtime agents", () => {
    const root = tempWorkspace();
    mkdirSync(join(root, ".nyxhive"), { recursive: true });
    writeFileSync(join(root, ".nyxhive", "workspace.toml"), `
id = "deft-voice"
kind = "product"
display_name = "Deft Voice"

[engine]
source = "local-git"
path = "/home/user/dev/nyxhive"
ref = "master"
constraint = ">=0.1 <0.2"

[runtime]
agents = ["deft"]
`);

    expect(() => loadWorkspaceManifest(root)).toThrow("Product workspaces cannot declare runtime agents");
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run:

```bash
bun test src/__tests__/workspace-manifest.test.ts
```

Expected: fail because `src/workspaces/manifest.ts` does not exist.

- [ ] **Step 3: Implement manifest loader**

Create `src/workspaces/manifest.ts`:

```typescript
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import TOML from "@iarna/toml";
import { z } from "zod";

const engineSchema = z.object({
  source: z.enum(["local-git", "git", "package"]).default("local-git"),
  path: z.string().optional(),
  ref: z.string().default("master"),
  constraint: z.string().default(">=0.1 <0.2"),
});

const runtimeSchema = z.object({
  instance_id: z.string().min(1).optional(),
  data_namespace: z.string().min(1).optional(),
  config: z.string().optional(),
  api_url: z.string().optional(),
  agents: z.array(z.string()).default([]),
}).optional();

const workspaceManifestSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["core", "agent", "product"]),
  display_name: z.string().min(1),
  engine: engineSchema,
  runtime: runtimeSchema,
});

export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema> & {
  root: string;
  manifestPath: string;
};

export function workspaceManifestPath(root: string): string {
  return resolve(root, ".nyxhive", "workspace.toml");
}

export function loadWorkspaceManifest(root: string): WorkspaceManifest {
  const manifestPath = workspaceManifestPath(root);
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing workspace manifest: ${manifestPath}`);
  }

  const raw = readFileSync(manifestPath, "utf8");
  const parsed = JSON.parse(JSON.stringify(TOML.parse(raw)));
  const manifest = workspaceManifestSchema.parse(parsed);

  if (manifest.kind === "product" && manifest.runtime?.agents.length) {
    throw new Error("Product workspaces cannot declare runtime agents");
  }

  if (manifest.kind === "agent" && (!manifest.runtime?.instance_id || !manifest.runtime?.data_namespace)) {
    throw new Error("Agent instances must declare runtime.instance_id and runtime.data_namespace");
  }

  return { ...manifest, root: resolve(root), manifestPath };
}
```

- [ ] **Step 4: Run manifest tests**

Run:

```bash
bun test src/__tests__/workspace-manifest.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/workspaces/manifest.ts src/__tests__/workspace-manifest.test.ts
git commit -m "feat: add NyxHive workspace manifests"
```

---

## Task 2: Add Workspace Registry Store And Discovery

**Files:**
- Create: `src/workspaces/registry.ts`
- Create: `src/workspaces/registry-store.ts`
- Modify: `src/nyx/lib/workspace-profiles.ts`
- Test: `src/__tests__/workspace-registry.test.ts`

- [ ] **Step 1: Write failing registry tests**

Create `src/__tests__/workspace-registry.test.ts`:

```typescript
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { discoverWorkspaceManifests } from "../workspaces/registry.js";
import { loadWorkspaceRegistry, saveWorkspaceRegistry } from "../workspaces/registry-store.js";

function writeManifest(root: string, body: string): void {
  mkdirSync(join(root, ".nyxhive"), { recursive: true });
  writeFileSync(join(root, ".nyxhive", "workspace.toml"), body);
}

describe("workspace registry", () => {
  test("discovers manifests from explicit roots", () => {
    const astra = mkdtempSync(join(tmpdir(), "astra-workspace-"));
    const deft = mkdtempSync(join(tmpdir(), "deft-workspace-"));

    writeManifest(astra, `
id = "astra-trading"
kind = "agent"
display_name = "Astra Trading"
[engine]
source = "local-git"
path = "/home/user/dev/nyxhive"
ref = "master"
[runtime]
instance_id = "astra-trading"
data_namespace = "astra-trading"
agents = ["astra"]
api_url = "http://127.0.0.1:3782"
`);

    writeManifest(deft, `
id = "deft-voice"
kind = "product"
display_name = "Deft Voice"
[engine]
source = "local-git"
path = "/home/user/dev/nyxhive"
ref = "master"
`);

    const manifests = discoverWorkspaceManifests([astra, deft]);

    expect(manifests.map((manifest) => manifest.id)).toEqual(["astra-trading", "deft-voice"]);
  });

  test("loads workspace roots from a registry file", () => {
    const registryRoot = mkdtempSync(join(tmpdir(), "nyxhive-registry-"));
    const registryFile = join(registryRoot, "workspaces.toml");
    const astra = mkdtempSync(join(tmpdir(), "astra-workspace-"));

    saveWorkspaceRegistry(registryFile, {
      workspaces: [
        { id: "astra-trading", path: astra },
      ],
    });

    const registry = loadWorkspaceRegistry(registryFile);

    expect(registry.workspaces).toEqual([{ id: "astra-trading", path: astra }]);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run:

```bash
bun test src/__tests__/workspace-registry.test.ts
```

Expected: fail because `src/workspaces/registry.ts` and `src/workspaces/registry-store.ts` do not exist.

- [ ] **Step 3: Implement registry file parsing**

Create `src/workspaces/registry-store.ts`:

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import TOML from "@iarna/toml";
import { z } from "zod";

const registrySchema = z.object({
  workspaces: z.array(z.object({
    id: z.string().min(1),
    path: z.string().min(1),
  })).default([]),
});

export type WorkspaceRegistry = z.infer<typeof registrySchema>;

export function workspaceRegistryPath(): string {
  const home = process.env.HOME ?? "/home/user";
  return process.env.NYXHIVE_WORKSPACE_REGISTRY ?? `${home}/.nyxhive/workspaces.toml`;
}

export function loadWorkspaceRegistry(path = workspaceRegistryPath()): WorkspaceRegistry {
  if (!existsSync(path)) return { workspaces: [] };
  const parsed = JSON.parse(JSON.stringify(TOML.parse(readFileSync(path, "utf8"))));
  return registrySchema.parse(parsed);
}

export function saveWorkspaceRegistry(path: string, registry: WorkspaceRegistry): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, TOML.stringify(JSON.parse(JSON.stringify(registry))));
}
```

- [ ] **Step 4: Implement registry discovery**

Create `src/workspaces/registry.ts`:

```typescript
import { existsSync } from "node:fs";
import { loadWorkspaceManifest, workspaceManifestPath, type WorkspaceManifest } from "./manifest.js";
import { loadWorkspaceRegistry } from "./registry-store.js";

export function discoverWorkspaceManifests(roots: string[]): WorkspaceManifest[] {
  const manifests: WorkspaceManifest[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (!existsSync(workspaceManifestPath(root))) continue;
    const manifest = loadWorkspaceManifest(root);
    if (seen.has(manifest.id)) continue;
    seen.add(manifest.id);
    manifests.push(manifest);
  }

  return manifests;
}

export function discoverRegisteredWorkspaceManifests(): WorkspaceManifest[] {
  return discoverWorkspaceManifests(loadWorkspaceRegistry().workspaces.map((workspace) => workspace.path));
}
```

- [ ] **Step 5: Update workspace profile generation**

Modify `src/nyx/lib/workspace-profiles.ts` so hardcoded profiles remain as compatibility fallback, but manifest-backed profiles come from `~/.nyxhive/workspaces.toml`. Keep `WORKSPACE_PROFILES` exported for compatibility.

Add this helper:

```typescript
import { discoverRegisteredWorkspaceManifests } from "../../workspaces/registry.js";

export function listWorkspaceManifests() {
  return discoverRegisteredWorkspaceManifests();
}
```

Do not delete `WORKSPACE_PROFILES` in this task. The CLI moves gradually in Task 3.

- [ ] **Step 6: Run registry tests**

Run:

```bash
bun test src/__tests__/workspace-registry.test.ts src/__tests__/workspace-manifest.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/workspaces/registry.ts src/workspaces/registry-store.ts src/nyx/lib/workspace-profiles.ts src/__tests__/workspace-registry.test.ts
git commit -m "feat: discover NyxHive workspace manifests"
```

---

## Task 3: Add Engine Lock And Update Detection

**Files:**
- Create: `src/workspaces/updates.ts`
- Test: `src/__tests__/workspace-updates.test.ts`

- [ ] **Step 1: Write failing update detection tests**

Create `src/__tests__/workspace-updates.test.ts`:

```typescript
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { compareEngineLock, readEngineLock } from "../workspaces/updates.js";

describe("workspace engine updates", () => {
  test("reports current when lock commit matches engine commit", () => {
    const root = mkdtempSync(join(tmpdir(), "engine-lock-current-"));
    mkdirSync(join(root, ".nyxhive"), { recursive: true });
    writeFileSync(join(root, ".nyxhive", "engine.lock"), `
version = "0.1.0"
commit = "abc123"
api_version = 1
`);

    const lock = readEngineLock(root);
    const status = compareEngineLock(lock, { version: "0.1.0", commit: "abc123", apiVersion: 1 });

    expect(status.state).toBe("current");
  });

  test("reports update_available when engine commit differs", () => {
    const root = mkdtempSync(join(tmpdir(), "engine-lock-stale-"));
    mkdirSync(join(root, ".nyxhive"), { recursive: true });
    writeFileSync(join(root, ".nyxhive", "engine.lock"), `
version = "0.1.0"
commit = "abc123"
api_version = 1
`);

    const lock = readEngineLock(root);
    const status = compareEngineLock(lock, { version: "0.1.0", commit: "def456", apiVersion: 1 });

    expect(status.state).toBe("update_available");
    expect(status.currentCommit).toBe("abc123");
    expect(status.availableCommit).toBe("def456");
  });

  test("reports action_required when engine api version changes", () => {
    const root = mkdtempSync(join(tmpdir(), "engine-lock-api-"));
    mkdirSync(join(root, ".nyxhive"), { recursive: true });
    writeFileSync(join(root, ".nyxhive", "engine.lock"), `
version = "0.1.0"
commit = "abc123"
api_version = 1
`);

    const lock = readEngineLock(root);
    const status = compareEngineLock(lock, { version: "0.2.0", commit: "def456", apiVersion: 2 });

    expect(status.state).toBe("action_required");
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run:

```bash
bun test src/__tests__/workspace-updates.test.ts
```

Expected: fail because `src/workspaces/updates.ts` does not exist.

- [ ] **Step 3: Implement engine lock parsing and comparison**

Create `src/workspaces/updates.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { z } from "zod";

const engineLockSchema = z.object({
  version: z.string(),
  commit: z.string(),
  api_version: z.number().int(),
});

export interface EngineIdentity {
  version: string;
  commit: string;
  apiVersion: number;
}

export interface EngineLock {
  version: string;
  commit: string;
  apiVersion: number;
}

export type EngineUpdateState = "unknown" | "current" | "update_available" | "action_required";

export interface EngineUpdateStatus {
  state: EngineUpdateState;
  currentCommit?: string;
  availableCommit?: string;
  currentVersion?: string;
  availableVersion?: string;
  reason: string;
}

export function engineLockPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".nyxhive", "engine.lock");
}

export function readEngineLock(workspaceRoot: string): EngineLock | undefined {
  const file = engineLockPath(workspaceRoot);
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(JSON.stringify(TOML.parse(readFileSync(file, "utf8"))));
  const lock = engineLockSchema.parse(parsed);
  return { version: lock.version, commit: lock.commit, apiVersion: lock.api_version };
}

export function writeEngineLock(workspaceRoot: string, identity: EngineIdentity): void {
  writeFileSync(engineLockPath(workspaceRoot), TOML.stringify({
    version: identity.version,
    commit: identity.commit,
    api_version: identity.apiVersion,
  }));
}

export function compareEngineLock(lock: EngineLock | undefined, available: EngineIdentity): EngineUpdateStatus {
  if (!lock) {
    return {
      state: "unknown",
      availableCommit: available.commit,
      availableVersion: available.version,
      reason: "Workspace has no .nyxhive/engine.lock",
    };
  }

  if (lock.apiVersion !== available.apiVersion) {
    return {
      state: "action_required",
      currentCommit: lock.commit,
      availableCommit: available.commit,
      currentVersion: lock.version,
      availableVersion: available.version,
      reason: "NyxHive engine API version changed",
    };
  }

  if (lock.commit !== available.commit) {
    return {
      state: "update_available",
      currentCommit: lock.commit,
      availableCommit: available.commit,
      currentVersion: lock.version,
      availableVersion: available.version,
      reason: "NyxHive engine commit changed",
    };
  }

  return {
    state: "current",
    currentCommit: lock.commit,
    availableCommit: available.commit,
    currentVersion: lock.version,
    availableVersion: available.version,
    reason: "Workspace engine lock matches current engine",
  };
}
```

- [ ] **Step 4: Run update tests**

Run:

```bash
bun test src/__tests__/workspace-updates.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/workspaces/updates.ts src/__tests__/workspace-updates.test.ts
git commit -m "feat: track NyxHive workspace engine locks"
```

---

## Task 4: Add Current Engine Identity From Local Git

**Files:**
- Modify: `src/workspaces/updates.ts`
- Test: `src/__tests__/workspace-updates.test.ts`

- [ ] **Step 1: Add tests for local Git identity fallback**

Append to `src/__tests__/workspace-updates.test.ts`:

```typescript
import { getCurrentEngineIdentity } from "../workspaces/updates.js";

test("returns package version and unknown commit outside git repo", () => {
  const root = mkdtempSync(join(tmpdir(), "not-a-git-repo-"));
  const identity = getCurrentEngineIdentity(root, { version: "0.1.0", apiVersion: 1 });

  expect(identity.version).toBe("0.1.0");
  expect(identity.apiVersion).toBe(1);
  expect(identity.commit).toBe("unknown");
});
```

- [ ] **Step 2: Implement local Git identity**

Modify `src/workspaces/updates.ts`:

```typescript
import { execFileSync } from "node:child_process";

export interface EngineIdentityDefaults {
  version: string;
  apiVersion: number;
}

function runGit(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

export function getCurrentEngineIdentity(engineRoot: string, defaults: EngineIdentityDefaults): EngineIdentity {
  return {
    version: defaults.version,
    apiVersion: defaults.apiVersion,
    commit: runGit(engineRoot, ["rev-parse", "--short=12", "HEAD"]) || "unknown",
  };
}
```

- [ ] **Step 3: Run tests**

Run:

```bash
bun test src/__tests__/workspace-updates.test.ts
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src/workspaces/updates.ts src/__tests__/workspace-updates.test.ts
git commit -m "feat: read NyxHive engine identity from git"
```

---

## Task 5: Add `nyx updates` CLI

**Files:**
- Create: `src/nyx/commands/updates.ts`
- Modify: `src/nyx/index.ts`
- Test: `src/__tests__/nyx-updates-command.test.ts`

- [ ] **Step 1: Write command tests**

Create `src/__tests__/nyx-updates-command.test.ts` with unit tests around command helpers rather than spawning the full CLI:

```typescript
import { describe, expect, test } from "bun:test";
import { formatEngineUpdateStatus } from "../nyx/commands/updates.js";

describe("nyx updates command", () => {
  test("formats update_available compactly", () => {
    const line = formatEngineUpdateStatus("Astra Trading", {
      state: "update_available",
      currentCommit: "abc123",
      availableCommit: "def456",
      currentVersion: "0.1.0",
      availableVersion: "0.1.0",
      reason: "NyxHive engine commit changed",
    });

    expect(line).toContain("Astra Trading");
    expect(line).toContain("update_available");
    expect(line).toContain("abc123");
    expect(line).toContain("def456");
  });
});
```

- [ ] **Step 2: Implement command**

Create `src/nyx/commands/updates.ts`:

```typescript
import { defineCommand } from "citty";
import pc from "picocolors";
import { ENGINE_API_VERSION } from "../../framework/types.js";
import { NYX_VERSION } from "../lib/version.js";
import { listWorkspaceManifests } from "../lib/workspace-profiles.js";
import { compareEngineLock, getCurrentEngineIdentity, readEngineLock, writeEngineLock, type EngineUpdateStatus } from "../../workspaces/updates.js";

export function formatEngineUpdateStatus(name: string, status: EngineUpdateStatus): string {
  const color = status.state === "current" ? pc.green : status.state === "action_required" ? pc.red : pc.yellow;
  const commits = status.currentCommit && status.availableCommit
    ? ` ${status.currentCommit} -> ${status.availableCommit}`
    : "";
  return `  ${pc.bold(name)} ${color(status.state)}${commits} ${pc.dim(status.reason)}`;
}

const check = defineCommand({
  meta: { name: "check", description: "Check NyxHive engine updates for workspaces" },
  run() {
  const engineRoot = process.env.NYXHIVE_ENGINE_ROOT ?? process.cwd();
    const identity = getCurrentEngineIdentity(engineRoot, {
      version: NYX_VERSION,
      apiVersion: ENGINE_API_VERSION,
    });

    for (const manifest of listWorkspaceManifests()) {
      const status = compareEngineLock(readEngineLock(manifest.root), identity);
      console.log(formatEngineUpdateStatus(manifest.display_name, status));
    }
  },
});

const acknowledge = defineCommand({
  meta: { name: "ack", description: "Record current NyxHive engine identity for a workspace" },
  args: {
    workspace: { type: "positional", required: true, description: "Workspace id" },
  },
  run({ args }) {
    const manifest = listWorkspaceManifests().find((item) => item.id === args.workspace);
    if (!manifest) throw new Error(`Unknown workspace: ${args.workspace}`);

    const identity = getCurrentEngineIdentity(process.env.NYXHIVE_ENGINE_ROOT ?? process.cwd(), {
      version: NYX_VERSION,
      apiVersion: ENGINE_API_VERSION,
    });
    writeEngineLock(manifest.root, identity);
    console.log(`  ${pc.green("acknowledged")} ${manifest.display_name} ${identity.commit}`);
  },
});

export default defineCommand({
  meta: { name: "updates", description: "Check and acknowledge NyxHive engine updates" },
  subCommands: { check, ack: acknowledge },
});
```

Modify `src/nyx/index.ts`:

```typescript
import updates from "./commands/updates.js";
```

Add `updates` to `subCommands`.

- [ ] **Step 3: Run command tests**

Run:

```bash
bun test src/__tests__/nyx-updates-command.test.ts src/__tests__/workspace-updates.test.ts
```

Expected: pass.

- [ ] **Step 4: Smoke check CLI**

Run:

```bash
bun run src/nyx/index.ts updates check
```

Expected: prints one line per registered workspace manifest. With no registry file, it should still exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/nyx/commands/updates.ts src/nyx/index.ts src/__tests__/nyx-updates-command.test.ts
git commit -m "feat: add NyxHive workspace update CLI"
```

---

## Task 6: Surface Updates In Workspace CLI Doctor

**Files:**
- Modify: `src/nyx/commands/workspace.ts`
- Test: `src/__tests__/workspace-profiles.test.ts` or create `src/__tests__/workspace-command.test.ts`

- [ ] **Step 1: Add formatter test**

Create `src/__tests__/workspace-command.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { formatWorkspaceKind } from "../nyx/commands/workspace.js";

describe("workspace command formatting", () => {
  test("labels products separately from agent instances", () => {
    expect(formatWorkspaceKind("product")).toBe("product");
    expect(formatWorkspaceKind("agent")).toBe("agent instance");
  });
});
```

- [ ] **Step 2: Export formatter and include manifests in `list`**

Modify `src/nyx/commands/workspace.ts`:

```typescript
import { listWorkspaceManifests } from "../lib/workspace-profiles.js";

export function formatWorkspaceKind(kind: string): string {
  return kind === "agent" ? "agent instance" : kind;
}
```

In the `list` command, after existing profile output:

```typescript
for (const manifest of listWorkspaceManifests()) {
  console.log(`  ${pc.bold(manifest.display_name)} ${pc.dim(`(${manifest.id}, ${formatWorkspaceKind(manifest.kind)})`)}`);
}
```

- [ ] **Step 3: Include update state in `doctor`**

In `doctor`, after existing hardcoded profile health, add manifest update status:

```typescript
  const identity = getCurrentEngineIdentity(process.env.NYXHIVE_ENGINE_ROOT ?? repoRoot, {
  version: NYX_VERSION,
  apiVersion: ENGINE_API_VERSION,
});

for (const manifest of listWorkspaceManifests()) {
  const update = compareEngineLock(readEngineLock(manifest.root), identity);
  console.log(formatEngineUpdateStatus(manifest.display_name, update));
}
```

Import the helpers from `src/workspaces/updates.ts`, `src/framework/types.ts`, `src/nyx/lib/version.ts`, and `src/nyx/commands/updates.ts`.

- [ ] **Step 4: Run tests and CLI smoke check**

Run:

```bash
bun test src/__tests__/workspace-command.test.ts src/__tests__/nyx-updates-command.test.ts
bun run src/nyx/index.ts workspace list
bun run src/nyx/index.ts workspace doctor
```

Expected: tests pass; CLI exits 0 and shows existing workspace profiles plus manifest-backed workspaces when their manifests are registered.

- [ ] **Step 5: Commit**

```bash
git add src/nyx/commands/workspace.ts src/__tests__/workspace-command.test.ts
git commit -m "feat: show NyxHive updates in workspace doctor"
```

---

## Task 7: Add Workspace UI Update API

**Files:**
- Create: `src/nyx-workspace/src/server/workspace-updates.ts`
- Create: `src/nyx-workspace/src/routes/api/workspace/updates.ts`
- Test: `src/nyx-workspace/src/server/workspace-updates.test.ts`

- [ ] **Step 1: Write workspace update server test**

Create `src/nyx-workspace/src/server/workspace-updates.test.ts`:

```typescript
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { readWorkspaceUpdateSummary } from "./workspace-updates";

describe("workspace update summary", () => {
  test("returns unknown when engine lock is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-ui-updates-"));
    mkdirSync(join(root, ".nyxhive"), { recursive: true });

    const summary = readWorkspaceUpdateSummary(root, {
      version: "0.1.0",
      commit: "abc123",
      apiVersion: 1,
    });

    expect(summary.state).toBe("unknown");
  });

  test("reports update available when live engine commit differs from lock", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-ui-updates-lock-"));
    mkdirSync(join(root, ".nyxhive"), { recursive: true });
    writeFileSync(join(root, ".nyxhive", "engine.lock"), `
version = "0.1.0"
commit = "abc123"
api_version = 1
`);

    const summary = readWorkspaceUpdateSummary(root, {
      version: "0.1.0",
      commit: "def456",
      apiVersion: 1,
    });

    expect(summary.state).toBe("update_available");
    expect(summary.currentCommit).toBe("abc123");
    expect(summary.availableCommit).toBe("def456");
  });
});
```

- [ ] **Step 2: Implement workspace update reader**

Create `src/nyx-workspace/src/server/workspace-updates.ts`:

```typescript
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import TOML from "@iarna/toml";

export interface WorkspaceUpdateSummary {
  state: "unknown" | "current" | "update_available" | "action_required";
  currentCommit?: string;
  availableCommit?: string;
  currentVersion?: string;
  availableVersion?: string;
  reason: string;
}

interface EngineIdentity {
  version: string;
  commit: string;
  apiVersion: number;
}

function gitCommit(root: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function liveEngineIdentity(): EngineIdentity {
  return {
    version: "0.1.0",
  commit: gitCommit(process.env.NYXHIVE_ENGINE_ROOT || process.cwd()),
    apiVersion: 1,
  };
}

export function readWorkspaceUpdateSummary(
  workspaceHome = process.env.NYX_WORKSPACE_HOME || ".nyxhive",
  available = liveEngineIdentity(),
): WorkspaceUpdateSummary {
  const lockPath = join(workspaceHome, "engine.lock");
  if (!existsSync(lockPath)) {
    return {
      state: "unknown",
      availableCommit: available.commit,
      availableVersion: available.version,
      reason: "No engine lock has been recorded for this workspace",
    };
  }

  const parsed = JSON.parse(JSON.stringify(TOML.parse(readFileSync(lockPath, "utf8")))) as {
    version?: string;
    commit?: string;
    api_version?: number;
  };

  if (parsed.api_version !== available.apiVersion) {
    return {
      state: "action_required",
      currentCommit: parsed.commit,
      availableCommit: available.commit,
      currentVersion: parsed.version,
      availableVersion: available.version,
      reason: "NyxHive engine API version changed",
    };
  }

  if (parsed.commit !== available.commit) {
    return {
      state: "update_available",
      currentCommit: parsed.commit,
      availableCommit: available.commit,
      currentVersion: parsed.version,
      availableVersion: available.version,
      reason: "NyxHive engine commit changed",
    };
  }

  return {
    state: "current",
    currentCommit: parsed.commit,
    availableCommit: available.commit,
    currentVersion: parsed.version,
    availableVersion: available.version,
    reason: "Workspace engine lock matches current engine",
  };
}
```

- [ ] **Step 3: Add API route**

Create `src/nyx-workspace/src/routes/api/workspace/updates.ts`:

```typescript
import type { APIRoute } from "astro";
import { readWorkspaceUpdateSummary } from "../../../server/workspace-updates";

export const GET: APIRoute = async () => {
  return Response.json(readWorkspaceUpdateSummary());
};
```

- [ ] **Step 4: Run workspace tests**

Run:

```bash
bun test src/nyx-workspace/src/server/workspace-updates.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/nyx-workspace/src/server/workspace-updates.ts src/nyx-workspace/src/routes/api/workspace/updates.ts src/nyx-workspace/src/server/workspace-updates.test.ts
git commit -m "feat: expose workspace engine update status"
```

---

## Task 8: Show Update Banner In Workspace UI

**Files:**
- Modify: `src/nyx-workspace/src/screens/chat/components/connection-status-message.tsx`
- Test: existing component test if present, otherwise add focused render-free utility test.

- [ ] **Step 1: Add display utility test**

Create `src/nyx-workspace/src/screens/chat/components/workspace-update-banner.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { shouldShowWorkspaceUpdateBanner } from "./workspace-update-banner";

describe("workspace update banner", () => {
  test("shows when update is available or action is required", () => {
    expect(shouldShowWorkspaceUpdateBanner("update_available")).toBe(true);
    expect(shouldShowWorkspaceUpdateBanner("action_required")).toBe(true);
    expect(shouldShowWorkspaceUpdateBanner("current")).toBe(false);
    expect(shouldShowWorkspaceUpdateBanner("unknown")).toBe(false);
  });
});
```

- [ ] **Step 2: Add utility**

Create `src/nyx-workspace/src/screens/chat/components/workspace-update-banner.ts`:

```typescript
export type WorkspaceUpdateState = "unknown" | "current" | "update_available" | "action_required";

export function shouldShowWorkspaceUpdateBanner(state: WorkspaceUpdateState): boolean {
  return state === "update_available" || state === "action_required";
}
```

- [ ] **Step 3: Integrate banner into status component**

Modify `src/nyx-workspace/src/screens/chat/components/connection-status-message.tsx` to fetch `/api/workspace/updates` on mount and render a restrained warning line when `shouldShowWorkspaceUpdateBanner(state)` is true.

Use existing component styling patterns from the same file. Text should be direct:

```text
NyxHive update available
```

For `action_required`, use:

```text
NyxHive update needs migration
```

Do not make this a modal. It should be visible but not block work.

- [ ] **Step 4: Run workspace UI tests**

Run:

```bash
bun test src/nyx-workspace/src/screens/chat/components/workspace-update-banner.test.ts
bun run workspace:build
```

Expected: test passes and workspace build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/nyx-workspace/src/screens/chat/components/connection-status-message.tsx src/nyx-workspace/src/screens/chat/components/workspace-update-banner.ts src/nyx-workspace/src/screens/chat/components/workspace-update-banner.test.ts
git commit -m "feat: show NyxHive update banner in workspace"
```

---

## Task 9: Add Core, Astra, Vortex, And Deft Manifest Templates

**Files:**
- Create: `templates/workspaces/core/workspace.toml`
- Create: `templates/workspaces/agent/workspace.toml`
- Create: `templates/workspaces/product/workspace.toml`
- Modify: `README.md`

- [ ] **Step 1: Create core template**

Create `templates/workspaces/core/workspace.toml`:

```toml
id = "nyxai"
kind = "core"
display_name = "Nyx Workspace"

[engine]
source = "local-git"
path = "/home/user/dev/nyxhive"
ref = "master"
constraint = ">=0.1 <0.2"

[runtime]
instance_id = "nyxai"
data_namespace = "nyxai"
config = ".nyxhive/config.toml"
api_url = "http://127.0.0.1:3779"
agents = ["nyx"]
```

- [ ] **Step 2: Create agent instance workspace template**

Create `templates/workspaces/agent/workspace.toml`:

```toml
id = "astra-trading"
kind = "agent"
display_name = "Astra Trading"

[engine]
source = "local-git"
path = "/home/user/dev/nyxhive"
ref = "master"
constraint = ">=0.1 <0.2"

[runtime]
instance_id = "astra-trading"
data_namespace = "astra-trading"
config = ".nyxhive/config.toml"
api_url = "http://127.0.0.1:3782"
agents = ["astra"]
```

- [ ] **Step 3: Create product workspace template**

Create `templates/workspaces/product/workspace.toml`:

```toml
id = "deft-voice"
kind = "product"
display_name = "Deft Voice"

[engine]
source = "local-git"
path = "/home/user/dev/nyxhive"
ref = "master"
constraint = ">=0.1 <0.2"
```

- [ ] **Step 4: Document the boundary in README**

Add a short section to `README.md`:

```markdown
### Engine, Agent Workspaces, Product Repos

NyxHive is the engine. It owns runtime mechanics, queueing, context assembly, tool contracts, permissions, memory plumbing, CLI/API, update detection, and the workspace shell.

Agent instance workspaces such as Astra Trading and Vortex/NyxLabs are full NyxHive instances. They live in their own repos with `.nyxhive/workspace.toml`, `.nyxhive/config.toml`, `.nyxhive/souls/`, instance identity, runtime port, data namespace, tools, and domain tests.

Product repos such as Deft Voice may include `.nyxhive/workspace.toml` for NyxHive update awareness, but they are not agent instances unless they are intentionally converted from `kind = "product"` to `kind = "agent"` and given runtime config. The first implementation does not move product repositories.
```

- [ ] **Step 5: Verify docs and templates**

Run:

```bash
test -f templates/workspaces/core/workspace.toml
test -f templates/workspaces/agent/workspace.toml
test -f templates/workspaces/product/workspace.toml
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add templates/workspaces README.md
git commit -m "docs: define NyxHive workspace boundaries"
```

---

## Task 10: Migrate Local Workspace Manifests

**Files:**
- Create: `/home/user/dev/nyxhive/.nyxhive/workspace.toml`
- Create: `/home/user/dev/nyxhive/.nyxhive/engine.lock`
- Modify: `/home/user/.nyxhive/workspaces.toml`
- Create in the Astra repo implementation task: `/home/user/dev/example-trading/.nyxhive/workspace.toml`
- Create in the Vortex/NyxLabs repo implementation task: `/home/user/dev/example-labs/.nyxhive/workspace.toml`
- Optional product-repo task if update awareness is wanted there: `/home/user/dev/example-voice/.nyxhive/workspace.toml`

- [ ] **Step 1: Add NyxHive core manifest**

Create `/home/user/dev/nyxhive/.nyxhive/workspace.toml`:

```toml
id = "nyxai"
kind = "core"
display_name = "Nyx Workspace"

[engine]
source = "local-git"
path = "/home/user/dev/nyxhive"
ref = "master"
constraint = ">=0.1 <0.2"

[runtime]
instance_id = "nyxai"
data_namespace = "nyxai"
config = ".nyxhive/config.toml"
api_url = "http://127.0.0.1:3779"
agents = ["nyx"]
```

- [ ] **Step 2: Record current engine lock for core**

Run:

```bash
bun run src/nyx/index.ts updates ack nyxai
```

Expected: prints `acknowledged Nyx Workspace` and writes `.nyxhive/engine.lock`.

- [ ] **Step 3: Register NyxHive core workspace locally**

Update `/home/user/.nyxhive/workspaces.toml`:

```toml
[[workspaces]]
id = "nyxai"
path = "/home/user/dev/nyxhive"
```

If the registry already contains entries, preserve them and append missing workspaces only.

- [ ] **Step 4: Prepare Astra instance workspace manifest when repo exists**

Create `/home/user/dev/example-trading/.nyxhive/workspace.toml`:

```toml
id = "astra-trading"
kind = "agent"
display_name = "Astra Trading"

[engine]
source = "local-git"
path = "/home/user/dev/nyxhive"
ref = "master"
constraint = ">=0.1 <0.2"

[runtime]
instance_id = "astra-trading"
data_namespace = "astra-trading"
config = ".nyxhive/config.toml"
api_url = "http://127.0.0.1:3782"
agents = ["astra"]
```

- [ ] **Step 5: Prepare Vortex instance workspace manifest when repo path is finalized**

Create `/home/user/dev/example-labs/.nyxhive/workspace.toml`:

```toml
id = "nyxlabs"
kind = "agent"
display_name = "Vortex Workspace"

[engine]
source = "local-git"
path = "/home/user/dev/nyxhive"
ref = "master"
constraint = ">=0.1 <0.2"

[runtime]
instance_id = "nyxlabs"
data_namespace = "nyxlabs"
config = ".nyxhive/config.toml"
api_url = "http://127.0.0.1:3778"
agents = ["vortex"]
```

- [ ] **Step 6: Prepare Deft Voice product manifest only if product update awareness is useful**

Create `/home/user/dev/example-voice/.nyxhive/workspace.toml`:

```toml
id = "deft-voice"
kind = "product"
display_name = "Deft Voice"

[engine]
source = "local-git"
path = "/home/user/dev/nyxhive"
ref = "master"
constraint = ">=0.1 <0.2"
```

This does not start NyxHive, add agents, or change Deft Voice's product architecture.

- [ ] **Step 7: Register Astra, Vortex, and Deft locally only after their manifests exist**

Update `/home/user/.nyxhive/workspaces.toml`:

```toml
[[workspaces]]
id = "astra-trading"
path = "/home/user/dev/example-trading"

[[workspaces]]
id = "nyxlabs"
path = "/home/user/dev/example-labs"

[[workspaces]]
id = "deft-voice"
path = "/home/user/dev/example-voice"
```

Register only workspaces whose manifest files exist. Do not create missing product repos as part of this plan.

- [ ] **Step 8: Verify update checks**

Run:

```bash
bun run src/nyx/index.ts updates check
bun run src/nyx/index.ts workspace doctor
```

Expected: manifests appear and update states are visible.

- [ ] **Step 9: Commit core manifest only**

```bash
git add .nyxhive/workspace.toml .nyxhive/engine.lock
git commit -m "chore: register NyxHive core workspace manifest"
```

Do not commit Astra, Vortex, Deft, or `/home/user/.nyxhive/workspaces.toml` in the NyxHive repo. Domain manifests belong to their own repos. The local registry is machine state.

---

## Task 11: Full Verification

**Files:**
- No file changes.

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun test src/__tests__/workspace-manifest.test.ts src/__tests__/workspace-registry.test.ts src/__tests__/workspace-updates.test.ts src/__tests__/nyx-updates-command.test.ts src/__tests__/workspace-command.test.ts src/nyx-workspace/src/server/workspace-updates.test.ts src/nyx-workspace/src/screens/chat/components/workspace-update-banner.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: exits 0.

- [ ] **Step 3: Run full test suite**

Run:

```bash
bun test
```

Expected: exits 0.

- [ ] **Step 4: Check status**

Run:

```bash
git status --short --branch
git log --oneline --decorate -5
```

Expected: branch is ahead by the implementation commits; no unrelated dirty files.

---

## Execution Order

1. Manifest loader.
2. Registry store and manifest discovery.
3. Engine lock/update comparison.
4. Local Git engine identity.
5. `nyx updates` CLI.
6. Workspace doctor update surfacing.
7. Workspace UI update API.
8. Workspace UI banner.
9. Templates and docs.
10. Local manifest migration.
11. Full verification.

## Decisions Locked By This Plan

- Astra and Vortex are separate NyxHive agent instances, not engine extensions.
- Each agent instance has its own repo, `.nyxhive/config.toml`, `.nyxhive/souls/`, runtime port, data namespace, tools, tests, and domain code.
- Deft Voice is a product repo unless a future feature explicitly creates an agent instance for it.
- Deft Voice is not moved by this implementation.
- Workspace discovery uses a local registry file now, not hardcoded personal paths.
- Update detection starts local-first using the NyxHive Git commit and `ENGINE_API_VERSION`.
- `engine.lock` is per workspace and records the last acknowledged engine identity.
- API version changes are treated as `action_required`, not a passive update.
- The first UI surface is a non-blocking banner, not a modal or forced migration flow.

## Future Work Not In This Plan

- Package-published NyxHive update feeds.
- Remote multi-machine update relay.
- Automatic migration execution.
- Third-party extension sandboxing.
- Moving Astra trading code into its own repo.
- Moving or renaming Deft Voice's repository.
