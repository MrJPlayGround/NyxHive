export type SandboxType = "docker" | "macos" | "none";

export interface SandboxConfig {
  backend: SandboxType;
  docker_image?: string;
}

export interface SandboxWrapOpts {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  mountDirs?: string[];      // Read-only mounts (vault, etc.)
  writableDirs?: string[];   // Directories the process can write to
}

export interface SandboxWrapped {
  command: string[];
  env: Record<string, string>;
  cwd: string;
  cleanup?: () => void;  // Called after process completes (e.g. delete temp profile)
}

export interface Sandbox {
  readonly name: SandboxType;
  wrap(opts: SandboxWrapOpts): SandboxWrapped;
}
