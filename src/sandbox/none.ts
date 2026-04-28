import type { Sandbox, SandboxWrapOpts, SandboxWrapped } from "./types.js";

export class NoneSandbox implements Sandbox {
  readonly name = "none" as const;

  wrap(opts: SandboxWrapOpts): SandboxWrapped {
    return {
      command: opts.command,
      env: opts.env,
      cwd: opts.cwd,
    };
  }
}
