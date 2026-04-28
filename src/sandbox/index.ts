import { NoneSandbox } from "./none.js";
import { DockerSandbox } from "./docker.js";
import { MacOSSandbox } from "./macos.js";
import { logger } from "../utils/logger.js";
import type { SandboxType } from "./types.js";

export type { Sandbox, SandboxType, SandboxConfig, SandboxWrapOpts, SandboxWrapped } from "./types.js";

export async function detectSandbox(preferred?: SandboxType, dockerImage?: string, required?: boolean, instanceName?: string): Promise<import("./types.js").Sandbox> {
  if (preferred === "none") return new NoneSandbox();

  if (preferred === "docker" || !preferred) {
    try {
      const proc = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
      if (await proc.exited === 0) {
        logger.info("[sandbox] Docker available");
        if (preferred === "docker") return new DockerSandbox(instanceName ?? "nyxhive", dockerImage);
        // Auto-detected but not preferred -- continue checking
      }
    } catch {}
    if (preferred === "docker") {
      throw new Error("Docker sandbox requested but Docker is not available");
    }
  }

  if (preferred === "macos" || !preferred) {
    if (process.platform === "darwin") {
      try {
        const proc = Bun.spawn(["which", "sandbox-exec"], { stdout: "ignore", stderr: "ignore" });
        if (await proc.exited === 0) {
          logger.info("[sandbox] macOS sandbox-exec available");
          if (preferred === "macos") return new MacOSSandbox(instanceName ?? "nyxhive");
        }
      } catch {}
      if (preferred === "macos") {
        throw new Error("macOS sandbox requested but sandbox-exec is not available");
      }
    }
  }

  if (required) {
    throw new Error("Sandbox required but none available. Install Docker or run on macOS with sandbox-exec.");
  }

  if (!preferred) {
    logger.info("[sandbox] No sandbox backend detected, using none");
  }
  return new NoneSandbox();
}
