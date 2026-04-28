import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Sandbox, SandboxWrapOpts, SandboxWrapped } from "./types.js";

/** Chars that could break sandbox profile scope if interpolated unescaped */
const UNSAFE_PATH_CHARS = /["();\\\n\r]/;

function validateSandboxPath(path: string, label: string): void {
  if (!path.startsWith("/")) {
    throw new Error(`Sandbox ${label} must be absolute: ${path}`);
  }
  if (UNSAFE_PATH_CHARS.test(path)) {
    throw new Error(`Sandbox ${label} contains unsafe characters: ${path}`);
  }
}

export class MacOSSandbox implements Sandbox {
  readonly name = "macos" as const;
  private instanceName: string;

  constructor(instanceName: string) {
    this.instanceName = instanceName;
  }

  wrap(opts: SandboxWrapOpts): SandboxWrapped {
    validateSandboxPath(opts.cwd, "cwd");
    for (const p of opts.writableDirs ?? []) validateSandboxPath(p, "writableDirs");
    for (const p of opts.mountDirs ?? []) validateSandboxPath(p, "mountDirs");

    const profile = this.generateProfile(opts);
    const profilePath = join(tmpdir(), `${this.instanceName}-sandbox-${randomUUID().slice(0, 8)}.sb`);
    writeFileSync(profilePath, profile);

    return {
      command: ["sandbox-exec", "-f", profilePath, ...opts.command],
      env: opts.env,
      cwd: opts.cwd,
      cleanup: () => {
        try { unlinkSync(profilePath); } catch {}
      },
    };
  }

  private generateProfile(opts: SandboxWrapOpts): string {
    const writablePaths = [opts.cwd, ...(opts.writableDirs ?? [])];
    const readOnlyPaths = opts.mountDirs ?? [];

    return `(version 1)
(deny default)

; Allow basic process execution
(allow process-exec)
(allow process-fork)
(allow signal)
(allow sysctl-read)
(allow mach-lookup)

; Allow network (needed for LLM API calls)
(allow network*)

; Allow read to system libraries and tools
(allow file-read* (subpath "/usr"))
(allow file-read* (subpath "/bin"))
(allow file-read* (subpath "/sbin"))
(allow file-read* (subpath "/Library"))
(allow file-read* (subpath "/System"))
(allow file-read* (subpath "/private/tmp"))
(allow file-read* (subpath "/private/var"))
(allow file-read* (subpath "/dev"))
(allow file-read* (subpath "/etc"))
(allow file-read* (subpath "/opt"))

; Allow read+write to agent workspace and writable dirs
${writablePaths.map(p => `(allow file-read* file-write* (subpath "${p}"))`).join("\n")}

; Allow read-only to mounted dirs (vault, etc.)
${readOnlyPaths.map(p => `(allow file-read* (subpath "${p}"))`).join("\n")}

; Allow temp files
(allow file-read* file-write* (subpath "/private/tmp"))
`;
  }
}
