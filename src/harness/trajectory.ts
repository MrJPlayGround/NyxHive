import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { HarnessRuntimeEvent, HarnessTurnResult } from "./types.js";
import { redactSecrets } from "../utils/redaction.js";

export interface HarnessTrajectoryEntry {
  schema: "nyxhive.harness.trajectory.v1";
  id: string;
  timestamp: string;
  runtime: string;
  provider: string;
  model?: string;
  taskType?: string;
  completed: boolean;
  sessionId?: string;
  turnId?: string;
  promptPreview?: string;
  responsePreview?: string;
  tokensIn?: number;
  tokensOut?: number;
  toolsUsed: string[];
  eventKinds: string[];
  events: HarnessRuntimeEvent[];
  error?: string;
}

export function defaultHarnessTrajectoryPath(env: Record<string, string | undefined> = process.env): string {
  return resolve(env.NYXHIVE_HARNESS_TRAJECTORY_PATH?.trim() || ".nyxhive/trajectories/harness.jsonl");
}

function preview(text: string | undefined, max = 1_500): string | undefined {
  const redacted = redactSecrets(text ?? "").trim();
  if (!redacted) return undefined;
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

export function buildHarnessTrajectoryEntry(params: {
  id: string;
  runtime: string;
  provider?: string;
  model?: string;
  taskType?: string;
  prompt?: string;
  result?: HarnessTurnResult;
  events?: HarnessRuntimeEvent[];
  error?: unknown;
  now?: Date;
}): HarnessTrajectoryEntry {
  const events = params.result?.events ?? params.events ?? [];
  const error = params.error instanceof Error ? params.error.message : params.error ? String(params.error) : undefined;
  return {
    schema: "nyxhive.harness.trajectory.v1",
    id: params.id,
    timestamp: (params.now ?? new Date()).toISOString(),
    runtime: params.runtime,
    provider: params.provider ?? params.result?.events[0]?.provider ?? "openai",
    ...(params.model ? { model: params.model } : {}),
    ...(params.taskType ? { taskType: params.taskType } : {}),
    completed: !error,
    ...(params.result?.providerThreadId ? { sessionId: params.result.providerThreadId } : {}),
    ...(params.result?.providerTurnId ? { turnId: params.result.providerTurnId } : {}),
    ...(preview(params.prompt) ? { promptPreview: preview(params.prompt) } : {}),
    ...(preview(params.result?.response) ? { responsePreview: preview(params.result?.response) } : {}),
    ...(params.result?.tokensIn !== undefined ? { tokensIn: params.result.tokensIn } : {}),
    ...(params.result?.tokensOut !== undefined ? { tokensOut: params.result.tokensOut } : {}),
    toolsUsed: unique(params.result?.toolsUsed ?? events.filter((event) => event.kind === "tool.started").map((event) => event.message)),
    eventKinds: unique(events.map((event) => event.kind)),
    events,
    ...(error ? { error: preview(error, 500) ?? "unknown error" } : {}),
  };
}

export function appendHarnessTrajectory(entry: HarnessTrajectoryEntry, path = defaultHarnessTrajectoryPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
}

export function recordHarnessTrajectoryIfEnabled(
  entry: HarnessTrajectoryEntry,
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.NYXHIVE_HARNESS_TRAJECTORIES !== "1") return;
  appendHarnessTrajectory(entry, defaultHarnessTrajectoryPath(env));
}
