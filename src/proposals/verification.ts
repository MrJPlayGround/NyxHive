/**
 * Post-execution verification for proposals.
 * Runs build/typecheck and test commands in the proposal's repo to verify changes.
 */

import { logger } from "../utils/logger.js";

export interface VerifyConfig {
  test_command?: string;
  build_command?: string;
  timeout_ms?: number;
}

export interface VerifyResult {
  passed: boolean;
  steps: VerifyStepResult[];
  /** Directory verification ran in — proves scope */
  cwd: string;
}

export interface VerifyStepResult {
  name: string;
  command: string;
  passed: boolean;
  output: string;
  duration_ms: number;
  /** Directory the command ran in — provenance for artifact validation */
  cwd: string;
  /** Process exit code — 0 = success, non-zero = failure */
  exit_code: number;
}

const DEFAULT_TIMEOUT = 120_000; // 2 minutes
const MAX_OUTPUT = 4000; // Truncate captured output

/**
 * Run verification steps (test, build) in the given repo directory.
 * Returns a result with pass/fail per step and captured output.
 */
export async function runVerification(
  repoPath: string,
  config: VerifyConfig,
): Promise<VerifyResult> {
  const timeout = config.timeout_ms ?? DEFAULT_TIMEOUT;
  const steps: VerifyStepResult[] = [];

  // Run build/typecheck first. If code does not compile, tests are usually noise.
  if (config.build_command) {
    const result = await runStep("build", config.build_command, repoPath, timeout);
    steps.push(result);
    if (!result.passed) {
      return { passed: false, steps, cwd: repoPath };
    }
  }

  if (config.test_command) {
    const result = await runStep("test", config.test_command, repoPath, timeout);
    steps.push(result);
    if (!result.passed) {
      return { passed: false, steps, cwd: repoPath };
    }
  }

  // No commands configured = pass (nothing to verify)
  return { passed: true, steps, cwd: repoPath };
}

async function runStep(
  name: string,
  command: string,
  cwd: string,
  timeout: number,
): Promise<VerifyStepResult> {
  const start = Date.now();
  logger.info(`[verify] Running ${name}: ${command} in ${cwd}`);

  try {
    const proc = Bun.spawn(["sh", "-c", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
    });

    const timer = setTimeout(() => proc.kill(), timeout);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);

    const duration_ms = Date.now() - start;
    const output = truncateOutput(stdout, stderr);
    const passed = exitCode === 0;

    logger.info(`[verify] ${name} ${passed ? "PASSED" : "FAILED"} (exit ${exitCode}, ${duration_ms}ms)`);

    return { name, command, passed, output, duration_ms, cwd, exit_code: exitCode };
  } catch (err) {
    const duration_ms = Date.now() - start;
    logger.error(`[verify] ${name} error: ${err}`);
    return {
      name,
      command,
      passed: false,
      output: `Error: ${String(err)}`,
      duration_ms,
      cwd,
      exit_code: -1,
    };
  }
}

function truncateOutput(stdout: string, stderr: string): string {
  const combined = stderr.trim()
    ? `${stdout.trim()}\n\n--- stderr ---\n${stderr.trim()}`
    : stdout.trim();

  if (combined.length <= MAX_OUTPUT) return combined;

  // Keep last N chars (tail is more useful for errors)
  return `...(truncated)\n${combined.slice(-MAX_OUTPUT)}`;
}

/**
 * Resolve verify config for a repo path from the project definitions.
 * Falls back to auto-detecting test/build commands from package.json if no
 * explicit verify config is set — so verification always runs for recognizable projects.
 */
export function resolveVerifyConfig(
  repoPath: string,
  projects?: Array<{ name: string; repo_path: string; default?: boolean; verify?: VerifyConfig }>,
): VerifyConfig | null {
  if (projects) {
    for (const proj of projects) {
      const projPath = proj.repo_path.replace(/\/+$/, "");
      const repo = repoPath.replace(/\/+$/, "");
      if (repo === projPath || repo.startsWith(`${projPath}/`)) {
        if (proj.verify) return proj.verify;
        break; // matched project but no verify — fall through to auto-detect
      }
    }
  }

  return autoDetectVerifyConfig(repoPath);
}

/**
 * Auto-detect verification commands from the repo's package.json.
 * Returns null if the repo doesn't have recognizable tooling.
 */
function autoDetectVerifyConfig(repoPath: string): VerifyConfig | null {
  try {
    const fs = require("node:fs");
    const pkgPath = `${repoPath}/package.json`;
    if (!fs.existsSync(pkgPath)) return null;

    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

    // Skip monorepo roots — we can't reliably guess which workspace to verify.
    // Projects should set explicit verify config in their project definition.
    if (pkg.workspaces || fs.existsSync(`${repoPath}/turbo.json`) || fs.existsSync(`${repoPath}/pnpm-workspace.yaml`)) {
      logger.info(`[verify] Skipping auto-detect for monorepo root: ${repoPath}`);
      return null;
    }

    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const scripts = pkg.scripts ?? {};

    let test_command: string | undefined;
    let build_command: string | undefined;

    // Detect test runner
    if (scripts.test) {
      test_command = deps["bun-types"] || deps.bun ? "bun test" : "npm test";
    }

    // Detect TypeScript type-checking
    if (deps.typescript || deps["bun-types"]) {
      build_command = scripts.typecheck ? "bun run typecheck" : "bun x tsc --noEmit";
    }

    if (!test_command && !build_command) return null;

    logger.info(`[verify] Auto-detected verification for ${repoPath}: test=${test_command ?? "none"}, build=${build_command ?? "none"}`);
    return { test_command, build_command };
  } catch {
    return null;
  }
}
