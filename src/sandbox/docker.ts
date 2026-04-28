import { randomUUID } from "node:crypto";
import type { Sandbox, SandboxWrapOpts, SandboxWrapped } from "./types.js";
import { validateAllowedDirectory } from "../agents/invoke.js";
import { logger } from "../utils/logger.js";

async function ensureSandboxNetwork(networkName: string): Promise<void> {
  const check = Bun.spawnSync(["docker", "network", "inspect", networkName], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (check.exitCode !== 0) {
    const create = Bun.spawnSync(["docker", "network", "create", networkName, "--driver", "bridge"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if (create.exitCode !== 0) {
      logger.warn("[sandbox] Failed to create Docker network, falling back to host networking");
    }
  }
}

export class DockerSandbox implements Sandbox {
  readonly name = "docker" as const;
  private image: string;
  private instanceName: string;

  constructor(instanceName: string, image?: string) {
    this.instanceName = instanceName;
    this.image = image ?? `${instanceName}-sandbox:latest`;
  }

  wrap(opts: SandboxWrapOpts): SandboxWrapped {
    ensureSandboxNetwork(`${this.instanceName}-sandbox`);
    const containerName = `${this.instanceName}-${randomUUID().slice(0, 8)}`;

    const dockerArgs = [
      "docker", "run",
      "--rm",
      "-i",                              // Keep stdin open for pipe
      "--name", containerName,
      "--network", `${this.instanceName}-sandbox`,
      "--memory", "2g",
      "--memory-swap", "2g",
      "--cpus", "2",
      "--pids-limit", "256",
      "-w", "/workspace",
      "-v", `${opts.cwd}:/workspace`,
    ];

    // Mount additional dirs as read-only
    for (const dir of opts.mountDirs ?? []) {
      try {
        const safeDir = validateAllowedDirectory(dir);
        dockerArgs.push("-v", `${safeDir}:${safeDir}:ro`);
      } catch {
        // Skip blocked directories silently in sandbox context
      }
    }

    // Writable dirs mounted read-write
    for (const dir of opts.writableDirs ?? []) {
      if (dir !== opts.cwd) { // cwd already mounted
        try {
          const safeDir = validateAllowedDirectory(dir);
          dockerArgs.push("-v", `${safeDir}:${safeDir}`);
        } catch {
          // Skip blocked directories silently in sandbox context
        }
      }
    }

    // Inject environment variables
    for (const [k, v] of Object.entries(opts.env)) {
      dockerArgs.push("-e", `${k}=${v}`);
    }

    dockerArgs.push(this.image, ...opts.command);

    return {
      command: dockerArgs,
      env: {},  // Docker container has its own env
      cwd: opts.cwd,  // Not used by docker but kept for consistency
      cleanup: () => {
        // Force-kill container if still running (safety net)
        try {
          Bun.spawn(["docker", "kill", containerName], { stdout: "ignore", stderr: "ignore" });
        } catch {}
      },
    };
  }
}
