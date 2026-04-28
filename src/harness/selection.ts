import type { AgentConfig, NyxHiveConfig } from "../types.js";
import type { AgentHarness, HarnessRuntime } from "./types.js";
import { selectHarnessForRuntime } from "./registry.js";
import "./codex-app-server.js";

export interface HarnessRuntimeSelectionInput {
  agent: Pick<AgentConfig, "cli_fallback" | "provider">;
  config?: Pick<NyxHiveConfig, "providers">;
  env?: Record<string, string | undefined>;
  override?: "cli" | "app_server";
}

export function resolveRequestedHarnessRuntime(input: HarnessRuntimeSelectionInput): HarnessRuntime | null {
  if (input.agent.cli_fallback !== "codex") return null;
  if (input.override === "cli") return null;
  const configuredRuntime = input.config?.providers?.[input.agent.provider]?.runtime;
  const requestedAppServer =
    input.override === "app_server" || configuredRuntime === "codex_app_server";
  if (!requestedAppServer) return null;
  if (configuredRuntime !== "codex_app_server" && input.env?.NYXHIVE_CODEX_APP_SERVER !== "1") return null;
  return "codex_app_server";
}

export function shouldUseHarnessRuntime(input: HarnessRuntimeSelectionInput): boolean {
  return resolveRequestedHarnessRuntime(input) !== null;
}

export function selectAgentHarness(input: HarnessRuntimeSelectionInput): AgentHarness | null {
  const runtime = resolveRequestedHarnessRuntime(input);
  return runtime ? selectHarnessForRuntime(runtime) ?? null : null;
}
