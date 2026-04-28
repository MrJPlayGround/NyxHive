import type {
  BlockedPathReport,
  DelegationRun,
  DelegationRunFileTouch,
  DelegationRunOutcome,
  DelegationRunScratchpadManifest,
  DelegationRunStatus,
  InboundArtifactRecord,
} from "../types.js";

export type RunSpineUnresolvedStatus = "open" | "blocked" | "failed" | "closed";

export interface RunSpineV0 {
  schema: "run_spine.v0";
  run: {
    run_id: string;
    parent_run_id: string | null;
    task_id: string | null;
    message_id: string | null;
    trace_id: string | null;
    status: DelegationRunStatus;
    outcome: DelegationRunOutcome | null;
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
    brain: DelegationRun["brain"];
    mode: DelegationRun["mode"];
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
    status: DelegationRunStatus;
    outcome: DelegationRunOutcome | null;
    changed_files: DelegationRunFileTouch[];
    verification: string[];
  };
  unresolved: {
    status: RunSpineUnresolvedStatus;
    blockers: string[];
    blocked_path_ids: string[];
    artifact_failure_ids: string[];
    next_action: string | null;
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function artifactLabel(artifact: InboundArtifactRecord): string {
  return artifact.name || artifact.source || artifact.artifact_id;
}

function inferUnresolvedStatus(
  run: DelegationRun,
  blockedPaths: BlockedPathReport[],
  failedArtifacts: InboundArtifactRecord[],
): RunSpineUnresolvedStatus {
  if (run.result?.outcome === "blocked" || blockedPaths.length > 0 || failedArtifacts.length > 0) return "blocked";
  if (run.status === "failed" || run.result?.outcome === "failure") return "failed";
  if (run.status === "completed" && run.result?.outcome === "success") return "closed";
  if (run.status === "superseded" || run.result?.outcome === "superseded") return "closed";
  return "open";
}

export function buildRunSpineV0(input: {
  run: DelegationRun;
  blockedPaths?: BlockedPathReport[];
  artifacts?: InboundArtifactRecord[];
  scratchpadManifest?: DelegationRunScratchpadManifest | null;
}): RunSpineV0 {
  const run = input.run;
  const result = run.result ?? null;
  const usage = run.usage ?? null;
  const environment = run.environment ?? null;
  const blockedPaths = input.blockedPaths ?? [];
  const artifacts = input.artifacts ?? [];
  const failedArtifacts = artifacts.filter((artifact) => artifact.acquisition_status === "failed");
  const scratchpadFiles = input.scratchpadManifest?.files.map((file) => file.path) ?? [];

  const refs = unique([
    input.scratchpadManifest ? "scratchpad:manifest" : "",
    result?.verification?.length ? "result:verification" : "",
    result?.blockers?.length ? "result:blockers" : "",
    blockedPaths.length ? "blocked_path_reports" : "",
    artifacts.length ? "inbound_artifacts" : "",
  ]);

  const blockers = unique([
    ...(result?.blockers ?? []),
    ...blockedPaths.map((report) => `${report.failed_path}: ${report.missing_primitive}`),
    ...failedArtifacts.map((artifact) => `artifact:${artifactLabel(artifact)}: ${artifact.handler_status}`),
  ]);

  return {
    schema: "run_spine.v0",
    run: {
      run_id: run.run_id,
      parent_run_id: run.parent_run_id,
      task_id: run.task_id,
      message_id: run.message_id,
      trace_id: run.trace_id,
      status: run.status,
      outcome: result?.outcome ?? null,
      started_at: run.created_at,
      finished_at: run.completed_at ?? null,
      updated_at: run.updated_at,
    },
    intent: {
      task_id: run.task_id,
      task_description: run.task_description,
    },
    attempted_path: {
      agent: run.agent,
      brain: run.brain,
      mode: run.mode,
      delegation_depth: run.delegation_depth,
      provider: environment?.provider ?? null,
      model: environment?.model ?? null,
      working_directory: environment?.working_directory ?? null,
      cwd_override: environment?.cwd_override ?? null,
      tool_uses: usage?.tool_uses ?? [],
    },
    evidence: {
      refs,
      blocked_path_refs: blockedPaths.map((report) => report.id),
      inbound_artifact_refs: artifacts.map((artifact) => artifact.artifact_id),
      artifact_refs: result?.artifacts ?? [],
      scratchpad_files: scratchpadFiles,
    },
    outcome: {
      summary: result?.summary ?? null,
      status: run.status,
      outcome: result?.outcome ?? null,
      changed_files: result?.files_touched ?? [],
      verification: result?.verification ?? [],
    },
    unresolved: {
      status: inferUnresolvedStatus(run, blockedPaths, failedArtifacts),
      blockers,
      blocked_path_ids: blockedPaths.map((report) => report.id),
      artifact_failure_ids: failedArtifacts.map((artifact) => artifact.artifact_id),
      next_action: result?.next_action ?? null,
    },
  };
}
