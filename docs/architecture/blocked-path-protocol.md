# Blocked Path Protocol

Blocked path reports turn a failed runtime path into evidence NyxHive can inspect later. They are for concrete failures where the system knows what path was attempted and what primitive is missing or invalid.

## When To Record

Record a blocked path when work stops before the expected processing path can run, especially for:

- attachment validation or unsupported media
- provider capability gaps
- missing tools, storage, scheduler, queue, or runtime primitives
- approval boundaries that pause protected work

Do not record a blocked path for normal user-facing validation without operational value, speculative concerns, or raw exception dumps that do not name an inspected path.

## Shape

```ts
interface BlockedPathReport {
  id: string;
  run_id: string | null;
  message_id: string | null;
  trace_id: string | null;
  channel: string | null;
  area: "attachment" | "media" | "provider" | "tool" | "runtime" | "storage" | "scheduler" | "queue" | "memory" | "approval";
  failed_path: string;
  trigger: string;
  inspected: string[];
  available_artifacts: string[];
  missing_primitive: string;
  impact: string;
  next_action: "fix" | "proposal" | "configure" | "retry" | "ignore";
  requires_approval: boolean;
  created_at: number;
}
```

## Current v0 Path

Phase 1 records API message and session message attachment normalization failures. Unsupported attachment MIME types now return a `blocked_path` object in the 400 response and persist the same report in `blocked_path_reports`.

Telegram attachment failures now also record structured blockers for unsupported MIME types, oversized files, and download failures before a model run starts.

Discord attachment failures now record structured blockers for unsupported MIME types, excessive attachment counts, oversized files, rejected hosts, and download failures before a model run starts.

Provider handoff failures now record structured blockers when NyxHive has already accepted a file but the selected runtime/provider path explicitly omits or cannot preserve that file class. Current high-confidence cases are native API attachment omission and SDK provider binary/media capability gaps such as audio sent through text/image-only paths.

Run diagnostics expose persisted reports through `blocked_paths`.

Capability Snapshot v0 exposes runtime/config capability evidence at `GET /api/status/capabilities`. The snapshot is generated from config providers, registered provider runtime state, channel runtime state, supported file-type constants, and blocked-path store availability. It deliberately reports only high-confidence support, missing primitives, and unknowns; it is not a hand-maintained universal truth table.

Artifact Pipeline v0 stores accepted inbound files as durable records in `inbound_artifacts` with file bytes under the run data directory. It also records explicit acquisition failures for high-confidence rejection/download paths before a model run exists. Run diagnostics expose linked artifacts through `artifacts`, and pre-run failures are inspectable at `GET /api/status/artifacts`.

Continuity Run Spine v0 exposes one composed inspection object at `GET /api/runs/:runId/spine` and embeds the same object in run diagnostics as `spine`. It is generated from durable run storage, blocked-path reports, inbound artifact records, scratchpad manifests, and stored run results; it does not create a separate memory layer or promote summaries automatically.

```ts
interface RunSpineV0 {
  schema: "run_spine.v0";
  run: {
    run_id: string;
    parent_run_id: string | null;
    task_id: string | null;
    message_id: string | null;
    trace_id: string | null;
    status: "pending" | "running" | "completed" | "failed" | "killed" | "superseded";
    outcome: "success" | "partial" | "failure" | "blocked" | "superseded" | null;
    started_at: number;
    finished_at: number | null;
    updated_at: number;
  };
  intent: {
    task_id: string | null;
    task_description: string;
  };
  attempted_path: {
    agent: string;
    brain: "codex" | "opus" | "sdk" | "anthropic";
    mode: string;
    delegation_depth: number;
    provider: string | null;
    model: string | null;
    working_directory: string | null;
    cwd_override: string | null;
    tool_uses: string[];
  };
  evidence: {
    refs: string[];
    blocked_path_refs: string[];
    inbound_artifact_refs: string[];
    artifact_refs: string[];
    scratchpad_files: string[];
  };
  outcome: {
    summary: string | null;
    status: string;
    outcome: string | null;
    changed_files: { path: string; action: string }[];
    verification: string[];
  };
  unresolved: {
    status: "open" | "blocked" | "failed" | "closed";
    blockers: string[];
    blocked_path_ids: string[];
    artifact_failure_ids: string[];
    next_action: string | null;
  };
}
```

Current snapshot primitives cover:

- attachment ingest limits and supported MIME classes
- image, document, and audio ingest support
- missing transcription handler support
- provider file-support gaps aligned with provider blocked-path classifiers
- channel attachment ingest quirks for Telegram and Discord
- async queue, blocked-path report availability, and inbound artifact storage

## Rules

- Store metadata and evidence, not raw payloads.
- Store artifact payload bytes on disk, not in API responses or blocked-path records.
- Keep existing string `blockers` compatible.
- Prefer stable `missing_primitive` IDs over prose.
- Use `requires_approval: true` only when the next action crosses an authority boundary.
- A blocked path should change a future decision. If nothing consumes it, it is noise.
