# Runtime Observability Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inspectable runtime authority traces, a one-command self-audit, and a model quality/cost ledger so Nyx can verify her runtime posture from live evidence.

**Architecture:** Make `codex-security.ts` the authority decision source and return a structured explanation with every sandbox decision. Persist runtime authority and model outcome metadata on trace events, then build audit/ledger readers over existing config, trace, run, and queue stores. Keep routing changes out of this plan; this builds the evidence layer first.

**Tech Stack:** Bun, TypeScript, SQLite, TOML config, existing `TraceStore`, `DelegationRunStore`, `nyxhive` CLI, `bun test`, `bun run typecheck`.

---

## File Structure

- `src/agents/codex-security.ts` — extend `CodexSecurityDecision` with structured authority rationale.
- `src/__tests__/codex-security.test.ts` — focused unit tests for authority rationale and directory filtering.
- `src/types.ts` — add runtime event payload typing and trace metadata typing.
- `src/harness/types.ts` — add `authority.resolved` harness event kind.
- `src/agents/invoke-codex-sdk.ts` — include authority event in returned runtime events.
- `src/harness/codex-app-server.ts` — emit authority event before Codex app-server turns.
- `src/memory/schema.sql` — add `metadata_json` to `trace_events`.
- `src/memory/store.ts` — migrate old `trace_events` tables to include `metadata_json`.
- `src/memory/traces.ts` — persist event metadata and expose model quality ledger queries.
- `src/queue/processor.ts` — pass authority/runtime metadata into primary trace event completion.
- `src/runtime/self-audit.ts` — pure runtime self-audit checks.
- `src/cli/audit.ts` — CLI entrypoint for `nyxhive audit runtime` and `nyxhive audit models`.
- `src/cli/index.ts` — register `audit`.
- Tests:
  - `src/__tests__/invoke-codex-sdk.test.ts`
  - `src/__tests__/codex-app-server-harness.test.ts`
  - `src/__tests__/traces-cost.test.ts`
  - `src/__tests__/schema-migration.test.ts`
  - `src/__tests__/runtime-self-audit.test.ts`
  - `src/__tests__/model-quality-ledger.test.ts`
  - `src/__tests__/cli-audit.test.ts`

---

## Task 1: Make Codex Authority Decisions Explain Themselves

**Files:**
- Modify: `src/agents/codex-security.ts`
- Create: `src/__tests__/codex-security.test.ts`

**Intent:** Every Codex sandbox decision should carry the executable reasons: role/capability, task type, external mutation request, and filtered directories.

- [ ] **Step 1: Write failing authority rationale tests**

Create `src/__tests__/codex-security.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { resolveCodexSecurityDecision } from "../agents/codex-security.js";

describe("Codex security decisions", () => {
  test("explains workspace-write coding authority", () => {
    const decision = resolveCodexSecurityDecision({
      agent: { name: "Nyx", capabilities: ["tool_use"], role: "lead", agentic_mode: "strict" },
      workingDirectory: "/home/user/dev/nyxhive",
      taskType: "coding",
      requireExecutableAuthority: true,
    });

    expect(decision.sandboxMode).toBe("workspace-write");
    expect(decision.authority).toMatchObject({
      agent: "Nyx",
      hasExecutableAuthority: true,
      taskType: "coding",
      nonMutatingTask: false,
      requiresExternalMutation: false,
      selectedReason: "mutating workspace task",
    });
  });

  test("records broad configured directories filtered from authority", () => {
    const decision = resolveCodexSecurityDecision({
      agent: { name: "Nyx", capabilities: ["tool_use"], role: "lead", agentic_mode: "strict" },
      workingDirectory: "/home/user/dev/nyxhive",
      configuredAdditionalDirectories: [
        "/home/user",
        "/Volumes",
        "/home/user/dev/obsidian/ExampleVault",
      ],
      taskType: "coding",
    });

    expect(decision.additionalDirectories).toEqual(["/home/user/dev/obsidian/ExampleVault"]);
    expect(decision.authority.filteredAdditionalDirectories).toEqual(["/home/user", "/Volumes"]);
  });
});
```

- [ ] **Step 2: Run the focused red test**

Run:

```bash
bun test src/__tests__/codex-security.test.ts
```

Expected: fail because `authority` is not present on `CodexSecurityDecision`.

- [ ] **Step 3: Add authority metadata to the resolver**

Update `src/agents/codex-security.ts`:

```ts
export type CodexAuthorityTrace = {
  agent?: string;
  role?: string;
  capabilities: string[];
  hasExecutableAuthority: boolean;
  taskType?: string;
  nonMutatingTask: boolean;
  requiresExternalMutation: boolean;
  workingDirectory: string;
  additionalDirectories: string[];
  filteredAdditionalDirectories: string[];
  selectedReason: "non-mutating task" | "mutating workspace task" | "external mutation required";
};

export type CodexSecurityDecision = {
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  additionalDirectories: string[];
  authority: CodexAuthorityTrace;
};
```

Change `sanitizeCodexAdditionalDirectories` to return `{ safe, filtered }`, and have `resolveCodexSecurityDecision()` populate `authority`.

- [ ] **Step 4: Verify Task 1**

Run:

```bash
bun test src/__tests__/codex-security.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/agents/codex-security.ts src/__tests__/codex-security.test.ts
git commit -m "feat(codex): explain authority decisions"
```

---

## Task 2: Emit Authority Trace Events From Codex Runtimes

**Files:**
- Modify: `src/types.ts`
- Modify: `src/harness/types.ts`
- Modify: `src/agents/invoke-codex-sdk.ts`
- Modify: `src/harness/codex-app-server.ts`
- Test: `src/__tests__/invoke-codex-sdk.test.ts`
- Test: `src/__tests__/codex-app-server-harness.test.ts`

**Intent:** Codex SDK and app-server runs should expose the selected sandbox and rationale in runtime events before work begins.

- [ ] **Step 1: Write failing SDK event test**

Add to `src/__tests__/invoke-codex-sdk.test.ts` near the sandbox assertions:

```ts
expect(result.runtime_events?.[0]).toMatchObject({
  kind: "authority.resolved",
  runtime: "codex_app_server",
  provider: "openai",
  payload: {
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    authority: {
      hasExecutableAuthority: true,
      selectedReason: "mutating workspace task",
    },
  },
});
```

- [ ] **Step 2: Write failing app-server event test**

Add to `src/__tests__/codex-app-server-harness.test.ts`:

```ts
expect(result.events[0]).toMatchObject({
  kind: "authority.resolved",
  runtime: "codex_app_server",
  provider: "openai",
  payload: {
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  },
});
```

- [ ] **Step 3: Run the focused red tests**

Run:

```bash
bun test src/__tests__/invoke-codex-sdk.test.ts src/__tests__/codex-app-server-harness.test.ts
```

Expected: fail because no authority event is emitted and `InvocationResult.runtime_events` cannot carry `payload`.

- [ ] **Step 4: Extend runtime event types**

Update `src/types.ts` runtime event shape:

```ts
runtime_events?: Array<{
  kind: string;
  runtime?: string;
  provider?: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  message?: string;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  payload?: unknown;
  timestamp?: number;
}>;
```

Update `src/harness/types.ts`:

```ts
export type HarnessEventKind =
  | "authority.resolved"
  | "connection.started"
  // keep existing entries
```

- [ ] **Step 5: Emit SDK authority event**

In `src/agents/invoke-codex-sdk.ts`, create:

```ts
const authorityEvent = {
  kind: "authority.resolved",
  runtime: "codex_app_server",
  provider: "openai",
  payload: security,
  timestamp: Date.now(),
};
```

Return it:

```ts
runtime_events: [authorityEvent],
```

- [ ] **Step 6: Emit app-server authority event**

In `src/harness/codex-app-server.ts`, make `mapRuntimeMode()` return both the protocol mode and the decision, then prepend:

```ts
collector.events.push({
  kind: "authority.resolved",
  runtime: "codex_app_server",
  provider: "openai",
  payload: decision,
  timestamp: this.now(),
});
```

- [ ] **Step 7: Verify Task 2**

Run:

```bash
bun test src/__tests__/invoke-codex-sdk.test.ts src/__tests__/codex-app-server-harness.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/types.ts src/harness/types.ts src/agents/invoke-codex-sdk.ts src/harness/codex-app-server.ts src/__tests__/invoke-codex-sdk.test.ts src/__tests__/codex-app-server-harness.test.ts
git commit -m "feat(runtime): emit authority trace events"
```

---

## Task 3: Persist Runtime Metadata On Trace Events

**Files:**
- Modify: `src/memory/schema.sql`
- Modify: `src/memory/store.ts`
- Modify: `src/memory/traces.ts`
- Modify: `src/queue/processor.ts`
- Test: `src/__tests__/schema-migration.test.ts`
- Test: `src/__tests__/traces-cost.test.ts`

**Intent:** Authority and model outcome metadata must survive after the run, not only stream live.

- [ ] **Step 1: Write failing trace metadata tests**

Add to `src/__tests__/traces-cost.test.ts`:

```ts
test("completeEvent persists metadata_json", () => {
  const store = new TraceStore(db);
  store.startTrace({ id: "t-meta", channel: "test", sender: "User", inputMessage: "test" });
  const eventId = store.startEvent("t-meta", "nyx", "coding");

  store.completeEvent(eventId, {
    model: "gpt-5.5",
    taskType: "coding",
    metadata: {
      authority: {
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
      },
    },
  });

  const row = db.query("SELECT metadata_json FROM trace_events WHERE id = ?").get(eventId) as { metadata_json: string };
  expect(JSON.parse(row.metadata_json)).toEqual({
    authority: {
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
    },
  });
});
```

Add to `src/__tests__/schema-migration.test.ts`:

```ts
expect(getColumnNames(storeDb, "trace_events")).toContain("metadata_json");
```

- [ ] **Step 2: Run the focused red tests**

Run:

```bash
bun test src/__tests__/traces-cost.test.ts src/__tests__/schema-migration.test.ts
```

Expected: fail because `metadata_json` and `metadata` are not supported.

- [ ] **Step 3: Add schema and migration column**

In `src/memory/schema.sql`, add to `trace_events`:

```sql
  metadata_json TEXT,
```

In `src/memory/store.ts`, add `metadata_json` to the `trace_events` `required` list and:

```ts
metadata_json: "TEXT",
```

- [ ] **Step 4: Persist metadata in TraceStore**

In `src/memory/traces.ts`, extend `completeEvent()`:

```ts
metadata?: Record<string, unknown>;
```

Add `metadata_json = ?` to the SQL and pass:

```ts
data.metadata ? JSON.stringify(data.metadata) : null,
```

- [ ] **Step 5: Attach authority metadata from processor completions**

In both primary `this.config.traces.completeEvent(primaryEventId, ...)` calls in `src/queue/processor.ts`, add:

```ts
metadata: {
  runtimeEvents: result.runtime_events ?? [],
  authority: result.runtime_events?.find((event) => event.kind === "authority.resolved")?.payload ?? null,
},
```

- [ ] **Step 6: Verify Task 3**

Run:

```bash
bun test src/__tests__/traces-cost.test.ts src/__tests__/schema-migration.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/memory/schema.sql src/memory/store.ts src/memory/traces.ts src/queue/processor.ts src/__tests__/schema-migration.test.ts src/__tests__/traces-cost.test.ts
git commit -m "feat(traces): persist runtime metadata"
```

---

## Task 4: Add Runtime Self-Audit

**Files:**
- Create: `src/runtime/self-audit.ts`
- Create: `src/__tests__/runtime-self-audit.test.ts`
- Create: `src/cli/audit.ts`
- Modify: `src/cli/index.ts`
- Create: `src/__tests__/cli-audit.test.ts`

**Intent:** Provide one command that answers whether the live runtime can be trusted right now.

- [ ] **Step 1: Write failing pure audit tests**

Create `src/__tests__/runtime-self-audit.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { runRuntimeSelfAudit } from "../runtime/self-audit.js";

describe("runtime self-audit", () => {
  test("passes GPT-5.5 strict Nyx config with bounded Codex authority", () => {
    const report = runRuntimeSelfAudit({
      agents: {
        Nyx: {
          name: "Nyx",
          provider: "openai",
          model: "gpt-5.5",
          working_directory: "/home/user/dev/nyxhive",
          capabilities: ["tool_use"],
          agentic_mode: "strict",
          allowed_directories: ["/home/user/dev/obsidian/ExampleVault"],
        },
      },
      queue: { pending: 0, processing: 0, deadLetters: 0, staleRunning: 0 },
      git: { clean: true, branch: "master", ahead: 0 },
      modelMetadata: {
        hasCostRate: true,
        hasContextWindow: true,
        tier: 4,
      },
    });

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.id)).toContain("codex-authority");
  });

  test("fails broad Codex authority roots", () => {
    const report = runRuntimeSelfAudit({
      agents: {
        Nyx: {
          name: "Nyx",
          provider: "openai",
          model: "gpt-5.5",
          working_directory: "/home/user/dev/nyxhive",
          capabilities: ["tool_use"],
          agentic_mode: "strict",
          allowed_directories: ["/home/user"],
        },
      },
      queue: { pending: 0, processing: 0, deadLetters: 0, staleRunning: 0 },
      git: { clean: true, branch: "master", ahead: 0 },
      modelMetadata: {
        hasCostRate: true,
        hasContextWindow: true,
        tier: 4,
      },
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "codex-authority")?.severity).toBe("fail");
  });
});
```

- [ ] **Step 2: Run red audit tests**

Run:

```bash
bun test src/__tests__/runtime-self-audit.test.ts
```

Expected: fail because `src/runtime/self-audit.ts` does not exist.

- [ ] **Step 3: Implement pure audit module**

Create `src/runtime/self-audit.ts`:

```ts
import { getContextWindow, getModelTier, DEFAULT_COST_RATES } from "../defaults.js";
import { resolveCodexSecurityDecision } from "../agents/codex-security.js";
import type { AgentConfig } from "../types.js";

export type RuntimeAuditCheck = {
  id: string;
  label: string;
  severity: "pass" | "warn" | "fail";
  detail: string;
};

export type RuntimeSelfAuditInput = {
  agents: Record<string, AgentConfig>;
  queue: { pending: number; processing: number; deadLetters: number; staleRunning: number };
  git: { clean: boolean; branch: string; ahead: number };
  modelMetadata?: { hasCostRate: boolean; hasContextWindow: boolean; tier: number };
};

export type RuntimeSelfAuditReport = {
  ok: boolean;
  checks: RuntimeAuditCheck[];
};

export function runRuntimeSelfAudit(input: RuntimeSelfAuditInput): RuntimeSelfAuditReport {
  const checks: RuntimeAuditCheck[] = [];
  const nyx = input.agents.Nyx ?? input.agents.nyx;
  const model = nyx?.model ?? "";
  const metadata = input.modelMetadata ?? {
    hasCostRate: Boolean(DEFAULT_COST_RATES[model]),
    hasContextWindow: getContextWindow(model) > 0,
    tier: getModelTier(model),
  };

  checks.push({
    id: "model-default",
    label: "Nyx model",
    severity: model === "gpt-5.5" ? "pass" : "fail",
    detail: model || "missing",
  });
  checks.push({
    id: "model-metadata",
    label: "Model metadata",
    severity: metadata.hasCostRate && metadata.hasContextWindow && metadata.tier >= 4 ? "pass" : "fail",
    detail: `cost=${metadata.hasCostRate} context=${metadata.hasContextWindow} tier=${metadata.tier}`,
  });

  if (nyx) {
    const decision = resolveCodexSecurityDecision({
      agent: nyx,
      workingDirectory: nyx.working_directory,
      configuredAdditionalDirectories: nyx.allowed_directories,
      taskType: "coding",
      requireExecutableAuthority: true,
    });
    checks.push({
      id: "codex-authority",
      label: "Codex authority",
      severity: decision.authority.filteredAdditionalDirectories.length === 0 ? "pass" : "fail",
      detail: `${decision.sandboxMode}; filtered=${decision.authority.filteredAdditionalDirectories.join(",") || "none"}`,
    });
  } else {
    checks.push({ id: "codex-authority", label: "Codex authority", severity: "fail", detail: "Nyx agent missing" });
  }

  checks.push({
    id: "queue-health",
    label: "Queue health",
    severity: input.queue.deadLetters === 0 && input.queue.staleRunning === 0 ? "pass" : "fail",
    detail: `pending=${input.queue.pending} processing=${input.queue.processing} dead=${input.queue.deadLetters} stale=${input.queue.staleRunning}`,
  });
  checks.push({
    id: "git-state",
    label: "Git state",
    severity: input.git.clean ? "pass" : "warn",
    detail: `${input.git.branch}; ahead=${input.git.ahead}; clean=${input.git.clean}`,
  });

  return { ok: checks.every((check) => check.severity !== "fail"), checks };
}
```

- [ ] **Step 4: Add CLI command**

Create `src/cli/audit.ts` that loads config with `loadConfig()`, gathers queue health when the server is running, reads `git status --porcelain --branch`, calls `runRuntimeSelfAudit()`, prints compact text by default, and supports `--json`.

Register it in `src/cli/index.ts`:

```ts
case "audit":
  await import("./audit.js");
  break;
```

Add help line:

```text
    audit runtime [--json]           Audit live runtime trust posture
```

- [ ] **Step 5: Verify Task 4**

Run:

```bash
bun test src/__tests__/runtime-self-audit.test.ts src/__tests__/cli-audit.test.ts
bun run src/cli/index.ts audit runtime --config .nyxhive/config.toml
```

Expected: tests pass and CLI exits `0` on current config.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/runtime/self-audit.ts src/cli/audit.ts src/cli/index.ts src/__tests__/runtime-self-audit.test.ts src/__tests__/cli-audit.test.ts
git commit -m "feat(runtime): add self-audit command"
```

---

## Task 5: Add Model Quality/Cost Ledger

**Files:**
- Modify: `src/memory/traces.ts`
- Create: `src/__tests__/model-quality-ledger.test.ts`
- Modify: `src/cli/audit.ts`

**Intent:** Turn trace/run history into per-model evidence: volume, success rate, failure rate, duration, cost, token use, and verification signal.

- [ ] **Step 1: Write failing ledger tests**

Create `src/__tests__/model-quality-ledger.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MemoryStore } from "../memory/store.js";
import { TraceStore } from "../memory/traces.js";

describe("model quality ledger", () => {
  let store: MemoryStore;
  let db: Database;
  let traces: TraceStore;

  beforeEach(() => {
    store = new MemoryStore(mkdtempSync(join(tmpdir(), "model-ledger-")));
    db = store.getDb();
    traces = new TraceStore(db);
  });

  afterEach(() => store.close());

  test("aggregates quality and cost per model", () => {
    traces.startTrace({ id: "t-ledger", channel: "api", sender: "User", inputMessage: "test" });
    const ok = traces.startEvent("t-ledger", "nyx", "implement");
    traces.completeEvent(ok, {
      model: "gpt-5.5",
      taskType: "coding",
      tokensIn: 1000,
      tokensOut: 500,
      cost: 0.02,
      durationMs: 12_000,
      metadata: { verification: { passed: true } },
    });
    const failed = traces.startEvent("t-ledger", "nyx", "empty");
    traces.failEvent(failed, "Codex SDK completed without an assistant response");
    db.prepare("UPDATE trace_events SET model = ?, task_type = ?, duration_ms = ? WHERE id = ?")
      .run("gpt-5.5", "coding", 3000, failed);

    const ledger = traces.getModelQualityLedger({ sinceMs: 0 });

    expect(ledger[0]).toMatchObject({
      model: "gpt-5.5",
      runs: 2,
      completed: 1,
      failed: 1,
      emptyRuns: 1,
      cost: 0.02,
      tokensIn: 1000,
      tokensOut: 500,
    });
  });
});
```

- [ ] **Step 2: Run the red ledger test**

Run:

```bash
bun test src/__tests__/model-quality-ledger.test.ts
```

Expected: fail because `getModelQualityLedger()` does not exist.

- [ ] **Step 3: Implement ledger query**

Add to `src/memory/traces.ts`:

```ts
export interface ModelQualityLedgerRow {
  model: string;
  taskType: string | null;
  runs: number;
  completed: number;
  failed: number;
  emptyRuns: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  avgDurationMs: number;
}

getModelQualityLedger(opts: { sinceMs: number; limit?: number }): ModelQualityLedgerRow[] {
  const rows = this.db.prepare(`
    SELECT
      COALESCE(model, 'unknown') AS model,
      task_type AS taskType,
      COUNT(*) AS runs,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN error LIKE '%completed without an assistant response%' THEN 1 ELSE 0 END) AS emptyRuns,
      COALESCE(SUM(tokens_in), 0) AS tokensIn,
      COALESCE(SUM(tokens_out), 0) AS tokensOut,
      COALESCE(SUM(cost), 0) AS cost,
      COALESCE(AVG(duration_ms), 0) AS avgDurationMs
    FROM trace_events
    WHERE started_at >= ? AND model IS NOT NULL
    GROUP BY model, task_type
    ORDER BY runs DESC, cost DESC
    LIMIT ?
  `).all(opts.sinceMs, opts.limit ?? 50) as ModelQualityLedgerRow[];
  return rows;
}
```

- [ ] **Step 4: Add `nyxhive audit models`**

Extend `src/cli/audit.ts`:

```text
nyxhive audit models --since 7d
```

It should open the configured memory DB read-only, call `TraceStore.getModelQualityLedger()`, and print:

```text
model       task      runs  pass  fail  empty  cost    avg
gpt-5.5     coding    42    39    3     1      $3.12   48s
```

Support `--json` for machine-readable output.

- [ ] **Step 5: Verify Task 5**

Run:

```bash
bun test src/__tests__/model-quality-ledger.test.ts src/__tests__/cli-audit.test.ts
bun run src/cli/index.ts audit models --config .nyxhive/config.toml --since 7d
```

Expected: tests pass and CLI prints ledger rows or a clear “no model runs found” message.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/memory/traces.ts src/cli/audit.ts src/__tests__/model-quality-ledger.test.ts src/__tests__/cli-audit.test.ts
git commit -m "feat(models): add quality ledger"
```

---

## Final Verification

- [ ] Run targeted suite:

```bash
bun test \
  src/__tests__/codex-security.test.ts \
  src/__tests__/invoke-codex-sdk.test.ts \
  src/__tests__/codex-app-server-harness.test.ts \
  src/__tests__/traces-cost.test.ts \
  src/__tests__/schema-migration.test.ts \
  src/__tests__/runtime-self-audit.test.ts \
  src/__tests__/model-quality-ledger.test.ts \
  src/__tests__/cli-audit.test.ts
```

- [ ] Run typecheck:

```bash
bun run typecheck
```

- [ ] Run full test suite:

```bash
bun test
```

- [ ] Run live smoke checks:

```bash
bun run src/cli/index.ts audit runtime --config .nyxhive/config.toml
bun run src/cli/index.ts audit models --config .nyxhive/config.toml --since 7d
git status --short
```

- [ ] Commit final fixes if any:

```bash
git add .
git commit -m "feat(runtime): add observability audits"
```

## Notes

- Do not let the audit command mutate config or databases.
- Do not make routing adaptive in this plan. The ledger is evidence; routing policy can consume it in a later change.
- Treat `danger-full-access` as a fail unless the persisted authority event proves executable authority plus external mutation need.
- Keep CLI output compact; `--json` is the detailed interface.

