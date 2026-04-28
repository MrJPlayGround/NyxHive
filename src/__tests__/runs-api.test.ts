import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AuthEnv } from "../auth/types.js";
import { DelegationRunStore } from "../runs/store.js";
import { runsRoutes } from "../server/routes/runs.js";

function withAuth(routes: Hono<AuthEnv>): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("/*", async (c, next) => {
    c.set("auth" as never, { type: "api_key", role: "owner" } as never);
    return next();
  });
  app.route("/", routes);
  return app;
}

function successResult(summary = "done") {
  return {
    summary,
    outcome: "success" as const,
    artifacts: [],
    files_touched: [],
    verification: [],
    blockers: [],
    next_action: null,
  };
}

function zeroUsage() {
  return {
    tokens_in: 0,
    tokens_out: 0,
    tool_uses: [],
    duration_ms: 0,
    cost_usd: 0,
  };
}

describe("runs routes", () => {
  let tmpDir: string;
  let runs: DelegationRunStore;
  let app: Hono<AuthEnv>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "runs-api-test-"));
    runs = new DelegationRunStore(tmpDir, "test");
    app = withAuth(runsRoutes(runs));
  });

  afterEach(() => {
    runs.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("lists and filters runs by task_id", async () => {
    const first = runs.createRun({
      task_id: "task-1",
      task_description: "first task",
      agent: "nyx",
      brain: "opus",
    });
    runs.completeRun(first.run_id, {
      status: "completed",
      result: successResult(),
      usage: { ...zeroUsage(), tokens_in: 1, tokens_out: 2, duration_ms: 3 },
    });
    runs.createRun({
      task_id: "task-2",
      task_description: "second task",
      agent: "tester",
      brain: "sdk",
    });

    const res = await app.request("/?task_id=task-1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].task_id).toBe("task-1");
  });

  test("filters runs by message_id", async () => {
    runs.createRun({
      message_id: "msg-aaa",
      task_description: "task aaa",
      agent: "nyx",
      brain: "opus",
    });
    runs.createRun({
      message_id: "msg-bbb",
      task_description: "task bbb",
      agent: "nyx",
      brain: "opus",
    });
    runs.createRun({
      task_description: "no message id",
      agent: "nyx",
      brain: "opus",
    });

    const res = await app.request("/?message_id=msg-aaa");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].message_id).toBe("msg-aaa");
  });

  test("returns run detail with scratchpad manifest", async () => {
    const run = runs.createRun({
      task_id: "task-7",
      task_description: "detail task",
      agent: "nyx",
      brain: "opus",
      environment: {
        provider: "anthropic",
        model: "claude-opus-4-6",
        working_directory: "/repo",
        cwd_override: null,
        allowed_tools: ["read_file"],
      },
    });

    const res = await app.request(`/${run.run_id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(run.run_id);
    expect(body.manifest.run_id).toBe(run.run_id);
    expect(body.manifest.task_id).toBe("task-7");
    expect(body.environment.model).toBe("claude-opus-4-6");
  });

  test("returns harness diagnostics for a run", async () => {
    const run = runs.createRun({
      task_id: "task-diag",
      message_id: "msg-diag",
      trace_id: "trace-diag",
      task_description: "diagnose task",
      agent: "forge",
      brain: "codex",
      mode: "default",
      environment: {
        provider: "openai",
        model: "gpt-5.4",
        working_directory: "/repo",
        cwd_override: "/repo/packages/app",
        allowed_tools: ["exec_command"],
        disallowed_tools: ["web_fetch"],
      },
    });
    runs.completeRun(run.run_id, {
      status: "completed",
      result: {
        ...successResult("diagnosed"),
        files_touched: [{ path: "src/app.ts", action: "edit" }],
        verification: ["bun test"],
      },
      usage: { ...zeroUsage(), tool_uses: ["exec_command"] },
      trace_id: "trace-diag",
    });
    const blockedPath = runs.recordBlockedPath({
      run_id: run.run_id,
      message_id: "msg-diag",
      trace_id: "trace-diag",
      channel: "api",
      area: "attachment",
      failed_path: "api.message.attachments.normalize",
      trigger: "Unsupported attachment MIME type: application/x-sh",
      inspected: ["request.files", "security.normalizeInboundAttachments", "providers.inferSupportedFileType"],
      available_artifacts: [],
      missing_primitive: "attachment.mime.supported_handler",
      impact: "Attachment request rejected before enqueue; no model run was started.",
      next_action: "fix",
      requires_approval: false,
    });

    const res = await app.request(`/${run.run_id}/diagnostics`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run_id).toBe(run.run_id);
    expect(body.replay_status).toBe("terminal");
    expect(body.environment.cwd_override).toBe("/repo/packages/app");
    expect(body.tool_uses).toEqual(["exec_command"]);
    expect(body.files_touched).toEqual([{ path: "src/app.ts", action: "edit" }]);
    expect(body.verification).toEqual(["bun test"]);
    expect(body.blocked_paths).toEqual([blockedPath]);
  });

  test("returns a run spine for completed runs", async () => {
    const run = runs.createRun({
      task_id: "task-spine-success",
      message_id: "msg-spine-success",
      trace_id: "trace-spine-success",
      task_description: "implement the run spine",
      agent: "nyx",
      brain: "codex",
      mode: "default",
      environment: {
        provider: "openai",
        model: "gpt-5.4",
        working_directory: "/repo",
      },
    });
    runs.completeRun(run.run_id, {
      status: "completed",
      result: {
        ...successResult("run spine implemented"),
        artifacts: ["commit:abc123"],
        files_touched: [{ path: "src/runs/spine.ts", action: "create" }],
        verification: ["bun test src/__tests__/runs-api.test.ts"],
      },
      usage: { ...zeroUsage(), tool_uses: ["exec_command"] },
    });

    const res = await app.request(`/${run.run_id}/spine`);
    expect(res.status).toBe(200);
    const spine = await res.json();

    expect(spine.schema).toBe("run_spine.v0");
    expect(spine.run).toMatchObject({
      run_id: run.run_id,
      message_id: "msg-spine-success",
      trace_id: "trace-spine-success",
      status: "completed",
      outcome: "success",
    });
    expect(spine.intent).toEqual({
      task_id: "task-spine-success",
      task_description: "implement the run spine",
    });
    expect(spine.attempted_path).toMatchObject({
      agent: "nyx",
      brain: "codex",
      mode: "default",
      provider: "openai",
      model: "gpt-5.4",
      working_directory: "/repo",
      tool_uses: ["exec_command"],
    });
    expect(spine.evidence.refs).toEqual(["scratchpad:manifest", "result:verification"]);
    expect(spine.evidence.artifact_refs).toEqual(["commit:abc123"]);
    expect(spine.outcome).toMatchObject({
      summary: "run spine implemented",
      status: "completed",
      outcome: "success",
      changed_files: [{ path: "src/runs/spine.ts", action: "create" }],
      verification: ["bun test src/__tests__/runs-api.test.ts"],
    });
    expect(spine.unresolved).toEqual({
      status: "closed",
      blockers: [],
      blocked_path_ids: [],
      artifact_failure_ids: [],
      next_action: null,
    });

    const diagnostics = await app.request(`/${run.run_id}/diagnostics`);
    expect(diagnostics.status).toBe(200);
    const diagnosticsBody = await diagnostics.json();
    expect(diagnosticsBody.spine).toEqual(spine);
  });

  test("run spine links blocked paths and failed artifact acquisitions", async () => {
    const run = runs.createRun({
      task_id: "task-spine-blocked",
      message_id: "msg-spine-blocked",
      trace_id: "trace-spine-blocked",
      task_description: "transcribe an uploaded audio file",
      agent: "nyx",
      brain: "codex",
    });
    runs.completeRun(run.run_id, {
      status: "completed",
      result: {
        summary: "audio could not be transcribed",
        outcome: "blocked",
        artifacts: [],
        files_touched: [],
        verification: [],
        blockers: ["missing transcription handler"],
        next_action: "Configure transcription support, then rerun.",
      },
      usage: zeroUsage(),
    });
    const blockedPath = runs.recordBlockedPath({
      run_id: run.run_id,
      message_id: "msg-spine-blocked",
      trace_id: "trace-spine-blocked",
      channel: "api",
      area: "media",
      failed_path: "media.audio.transcription",
      trigger: "audio/mpeg has no transcription handler",
      inspected: ["capabilities.primitives.media.audio.transcription"],
      available_artifacts: [],
      missing_primitive: "media.audio.transcription.handler",
      impact: "Audio content was unavailable to the model.",
      next_action: "configure",
      requires_approval: false,
    });
    const failedArtifact = runs.recordInboundArtifactFailure({
      run_id: run.run_id,
      message_id: "msg-spine-blocked",
      trace_id: "trace-spine-blocked",
      channel: "api",
      source: "api.message.files[0]",
      name: "voice.mp3",
      mime_type: "audio/mpeg",
      acquisition_error: "No transcription handler is configured.",
      handler_status: "unsupported",
    });

    const res = await app.request(`/${run.run_id}/spine`);
    expect(res.status).toBe(200);
    const spine = await res.json();

    expect(spine.schema).toBe("run_spine.v0");
    expect(spine.evidence.blocked_path_refs).toEqual([blockedPath.id]);
    expect(spine.evidence.inbound_artifact_refs).toEqual([failedArtifact.artifact_id]);
    expect(spine.evidence.refs).toContain("blocked_path_reports");
    expect(spine.evidence.refs).toContain("inbound_artifacts");
    expect(spine.unresolved).toEqual({
      status: "blocked",
      blockers: [
        "missing transcription handler",
        "media.audio.transcription: media.audio.transcription.handler",
        "artifact:voice.mp3: unsupported",
      ],
      blocked_path_ids: [blockedPath.id],
      artifact_failure_ids: [failedArtifact.artifact_id],
      next_action: "Configure transcription support, then rerun.",
    });
    expect(spine.outcome).toMatchObject({
      summary: "audio could not be transcribed",
      status: "completed",
      outcome: "blocked",
    });
  });

  test("persists acquired inbound file artifacts and exposes them in diagnostics", async () => {
    const run = runs.createRun({
      task_id: "task-artifact",
      message_id: "msg-artifact",
      trace_id: "trace-artifact",
      task_description: "inspect attachment",
      agent: "nyx",
      brain: "sdk",
    });

    const artifact = runs.recordInboundArtifact({
      run_id: run.run_id,
      message_id: "msg-artifact",
      trace_id: "trace-artifact",
      channel: "api",
      source: "api.message.files[0]",
      file: {
        name: "note.txt",
        mimeType: "text/plain",
        base64: Buffer.from("hello artifact").toString("base64"),
        size: 14,
      },
      handler_status: "unprocessed",
    });

    expect(artifact.acquisition_status).toBe("acquired");
    expect(artifact.handler_status).toBe("unprocessed");
    expect(artifact.storage_path).toBeString();
    expect(existsSync(artifact.storage_path!)).toBe(true);
    expect(readFileSync(artifact.storage_path!, "utf-8")).toBe("hello artifact");

    const res = await app.request(`/${run.run_id}/diagnostics`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]).toMatchObject({
      artifact_id: artifact.artifact_id,
      run_id: run.run_id,
      message_id: "msg-artifact",
      channel: "api",
      name: "note.txt",
      mime_type: "text/plain",
      size_bytes: 14,
      acquisition_status: "acquired",
      handler_status: "unprocessed",
    });
  });

  test("persists explicit inbound acquisition failures without payload storage", () => {
    const artifact = runs.recordInboundArtifactFailure({
      message_id: "msg-failed-artifact",
      channel: "api",
      source: "api.message.files[0]",
      name: "run.sh",
      mime_type: "application/x-sh",
      acquisition_error: "Unsupported attachment MIME type: application/x-sh",
      handler_status: "unsupported",
    });

    expect(artifact.acquisition_status).toBe("failed");
    expect(artifact.handler_status).toBe("unsupported");
    expect(artifact.storage_path).toBeNull();
    expect(artifact.acquisition_error).toContain("Unsupported attachment MIME type");

    const artifacts = runs.listArtifacts({ message_id: "msg-failed-artifact" });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toEqual(artifact);
  });

  test("classifies orphaned predecessor as superseded when a replacement completes", async () => {
    const stale = runs.createRun({
      message_id: "msg-retry",
      task_description: "original task",
      agent: "nyx",
      brain: "opus",
    });

    await new Promise((resolve) => setTimeout(resolve, 1));
    const reset = runs.resetOrphans(0, "orphaned_sweep");
    expect(reset).toEqual({ failed: 1, superseded: 0, total: 1 });
    expect(runs.getRun(stale.run_id)?.status).toBe("failed");

    const replacement = runs.createRun({
      message_id: "msg-retry",
      task_description: "replacement task",
      agent: "nyx",
      brain: "opus",
    });
    runs.completeRun(replacement.run_id, {
      status: "completed",
      result: successResult("replacement done"),
      usage: zeroUsage(),
    });

    const staleAfter = runs.getRun(stale.run_id);
    expect(staleAfter?.status).toBe("superseded");
    expect(staleAfter?.result?.outcome).toBe("superseded");

    const filtered = await app.request("/?status=superseded");
    expect(filtered.status).toBe(200);
    const filteredBody = await filtered.json();
    expect(filteredBody).toHaveLength(1);
    expect(filteredBody[0].run_id).toBe(stale.run_id);

    const detail = await app.request(`/${stale.run_id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.status).toBe("superseded");
    expect(detailBody.outcome).toBe("superseded");
  });

  test("rejects invalid run status filters", async () => {
    const res = await app.request("/?status=unknown");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid run status" });
  });
});
