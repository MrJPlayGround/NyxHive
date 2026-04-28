import { Hono } from "hono";
import type { AuthEnv } from "../../auth/types.js";
import type { DelegationRunStore } from "../../runs/store.js";
import { canRead } from "../middleware/rbac.js";
import { clampInt } from "../../utils/parse.js";
import type { DelegationRun, DelegationRunStatus } from "../../types.js";
import { buildRunSpineV0 } from "../../runs/spine.js";

const RUN_STATUSES: readonly DelegationRunStatus[] = ["pending", "running", "completed", "failed", "killed", "superseded"];

function parseRunStatus(value: string | undefined): DelegationRunStatus | undefined | null {
  if (value === undefined) return undefined;
  return (RUN_STATUSES as readonly string[]).includes(value) ? value as DelegationRunStatus : null;
}

function buildRunDiagnostics(run: DelegationRun, runs: DelegationRunStore) {
  const manifest = runs.getScratchpadManifest(run.run_id);
  const ageMs = Date.now() - run.updated_at;
  const blockedPaths = runs.listBlockedPaths({
    run_id: run.run_id,
    message_id: run.message_id,
  });
  const artifacts = runs.listArtifacts({
    run_id: run.run_id,
    message_id: run.message_id,
  });
  const spine = buildRunSpineV0({
    run,
    blockedPaths,
    artifacts,
    scratchpadManifest: manifest,
  });
  return {
    run_id: run.run_id,
    parent_run_id: run.parent_run_id,
    task_id: run.task_id,
    message_id: run.message_id,
    trace_id: run.trace_id,
    status: run.status,
    outcome: run.result?.outcome ?? null,
    agent: run.agent,
    brain: run.brain,
    mode: run.mode,
    delegation_depth: run.delegation_depth,
    environment: run.environment,
    scratchpad_dir: run.scratchpad_dir,
    scratchpad_manifest: manifest,
    scratchpad_files: manifest?.files ?? [],
    tool_uses: run.usage?.tool_uses ?? [],
    files_touched: run.result?.files_touched ?? [],
    verification: run.result?.verification ?? [],
    blockers: run.result?.blockers ?? [],
    blocked_paths: blockedPaths,
    artifacts,
    spine,
    replay_status: run.completed_at ? "terminal" : run.status === "running" ? "active" : "pending",
    stale: run.status === "running" && ageMs > 30 * 60 * 1000,
    updated_age_ms: ageMs,
    started_at: run.created_at,
    finished_at: run.completed_at ?? null,
  };
}

export function runsRoutes(runs: DelegationRunStore): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/", canRead, (c) => {
    const status = parseRunStatus(c.req.query("status"));
    if (status === null) return c.json({ error: "Invalid run status" }, 400);
    const taskId = c.req.query("task_id");
    const messageId = c.req.query("message_id");
    const limit = clampInt(c.req.query("limit"), 100, 1, 500);
    return c.json(runs.listRuns({
      status,
      task_id: taskId ?? undefined,
      message_id: messageId ?? undefined,
      limit,
    }));
  });

  app.get("/stream", canRead, (c) => {
    const encoder = new TextEncoder();
    let heartbeat: ReturnType<typeof setInterval>;
    let unsubscribe: (() => void) | undefined;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));

        unsubscribe = runs.onEvent((event) => {
          try {
            const data = JSON.stringify({
              type: event.type,
              run: event.run,
              manifest: runs.getScratchpadManifest(event.run.run_id),
              timestamp: Date.now(),
            });
            controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${data}\n\n`));
          } catch {
            if (unsubscribe) unsubscribe();
          }
        });

        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            clearInterval(heartbeat);
            if (unsubscribe) unsubscribe();
          }
        }, 15_000);

        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(heartbeat);
          if (unsubscribe) unsubscribe();
        });
      },
      cancel() {
        clearInterval(heartbeat);
        if (unsubscribe) unsubscribe();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  app.get("/:runId", canRead, (c) => {
    const runId = c.req.param("runId");
    const run = runs.getRun(runId);
    if (!run) return c.json({ error: "Run not found" }, 404);
    return c.json({
      id: run.run_id,
      status: run.status,
      outcome: run.result?.outcome ?? null,
      summary: run.result?.summary ?? null,
      result: run.result ?? null,
      environment: run.environment,
      started_at: run.created_at,
      finished_at: run.completed_at ?? null,
      agent: run.agent,
      task_id: run.task_id ?? null,
      message_id: run.message_id ?? null,
      manifest: runs.getScratchpadManifest(runId),
    });
  });

  app.get("/:runId/diagnostics", canRead, (c) => {
    const runId = c.req.param("runId");
    const run = runs.getRun(runId);
    if (!run) return c.json({ error: "Run not found" }, 404);
    return c.json(buildRunDiagnostics(run, runs));
  });

  app.get("/:runId/spine", canRead, (c) => {
    const runId = c.req.param("runId");
    const run = runs.getRun(runId);
    if (!run) return c.json({ error: "Run not found" }, 404);
    return c.json(buildRunSpineV0({
      run,
      blockedPaths: runs.listBlockedPaths({
        run_id: run.run_id,
        message_id: run.message_id,
      }),
      artifacts: runs.listArtifacts({
        run_id: run.run_id,
        message_id: run.message_id,
      }),
      scratchpadManifest: runs.getScratchpadManifest(run.run_id),
    }));
  });

  return app;
}
