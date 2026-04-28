import type { NyxHiveConfig } from "../types.js";

export type KernelRuntimeMode = "legacy" | "kernel";

export function resolveKernelRuntimeMode(
  config?: Pick<NyxHiveConfig, "runtime">,
  env: Record<string, string | undefined> = process.env,
): KernelRuntimeMode {
  const override = env.NYXHIVE_RUNTIME_MODE?.trim().toLowerCase();
  if (override === "kernel" || override === "legacy") return override;
  return config?.runtime?.mode ?? "legacy";
}
