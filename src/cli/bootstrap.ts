import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { platform } from "node:os";
import { loadConfig } from "../config.js";
import { installService } from "./service.js";
import { pollHealthCheck } from "./deploy.js";
import { loadInstanceEnv, resolveInstance } from "./resolve.js";
import { logger } from "../utils/logger.js";

export interface BootstrapOptions {
  instanceName?: string;
  configPath?: string;
  repoSource?: string;
  gitUrl?: string;
  gitRef?: string;
  envFile?: string;
  targetDir: string;
  installService?: boolean;
  start?: boolean;
  dryRun?: boolean;
}

export interface BootstrapPlan {
  sourceConfigPath: string;
  sourceRepoDir: string;
  sourceEnvPath?: string;
  targetDir: string;
  targetConfigPath: string;
  targetEnvPath?: string;
  instanceName: string;
  port: number;
  steps: string[];
}

export interface BootstrapResult {
  success: boolean;
  plan: BootstrapPlan;
  steps: string[];
  servicePath?: string;
}

function findEnvFile(searchRoots: string[], explicit?: string): string | undefined {
  if (explicit) {
    const abs = resolve(explicit);
    if (!existsSync(abs)) throw new Error(`Env file not found: ${abs}`);
    return abs;
  }

  for (const root of searchRoots) {
    for (const candidate of [join(root, ".env"), join(root, "env")]) {
      if (existsSync(candidate)) return candidate;
    }
  }

  return undefined;
}

function isDirectoryEmpty(dir: string): boolean {
  if (!existsSync(dir)) return true;
  return readdirSync(dir).length === 0;
}

function copyRepo(sourceDir: string, targetDir: string): void {
  const source = sourceDir.endsWith("/") ? sourceDir : `${sourceDir}/`;
  const target = targetDir.endsWith("/") ? targetDir : `${targetDir}/`;
  const result = Bun.spawnSync([
    "rsync", "-a", "--delete",
    "--exclude", ".git/",
    "--exclude", "data/",
    "--exclude", "node_modules/",
    "--exclude", "workspace/",
    "--exclude", ".env",
    "--exclude", "env",
    source,
    target,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(`rsync failed: ${result.stderr.toString().trim()}`);
  }
}

function syncGitRepo(targetDir: string, gitUrl: string, gitRef?: string): void {
  if (existsSync(join(targetDir, ".git"))) {
    const fetchResult = Bun.spawnSync(["git", "-C", targetDir, "fetch", "--all", "--tags"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (fetchResult.exitCode !== 0) {
      throw new Error(`git fetch failed: ${fetchResult.stderr.toString().trim()}`);
    }

    if (gitRef) {
      const checkoutResult = Bun.spawnSync(["git", "-C", targetDir, "checkout", gitRef], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (checkoutResult.exitCode !== 0) {
        throw new Error(`git checkout failed: ${checkoutResult.stderr.toString().trim()}`);
      }
    }

    const pullResult = Bun.spawnSync(["git", "-C", targetDir, "pull", "--ff-only"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (pullResult.exitCode !== 0) {
      throw new Error(`git pull failed: ${pullResult.stderr.toString().trim()}`);
    }
    return;
  }

  mkdirSync(dirname(targetDir), { recursive: true });
  const args = ["git", "clone"];
  if (gitRef) args.push("--branch", gitRef);
  args.push(gitUrl, targetDir);
  const cloneResult = Bun.spawnSync(args, {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (cloneResult.exitCode !== 0) {
    throw new Error(`git clone failed: ${cloneResult.stderr.toString().trim()}`);
  }
}

function runBunInstall(targetDir: string): void {
  const installResult = Bun.spawnSync(["bun", "install"], {
    cwd: targetDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (installResult.exitCode !== 0) {
    throw new Error(`bun install failed: ${installResult.stderr.toString().trim()}`);
  }
}

function copyFile(sourcePath: string, targetPath: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, readFileSync(sourcePath));
}

function startInstance(targetDir: string, targetConfigPath: string): void {
  const startResult = Bun.spawnSync(
    ["bun", "run", "src/cli/index.ts", "start", "--config", targetConfigPath, "--daemon"],
    {
      cwd: targetDir,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  if (startResult.exitCode !== 0) {
    throw new Error(`nyxhive start failed: ${startResult.stderr.toString().trim()}`);
  }
}

function maybeLoadService(servicePath: string): void {
  if (platform() === "darwin") {
    const result = Bun.spawnSync(["launchctl", "load", servicePath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(`launchctl load failed: ${result.stderr.toString().trim()}`);
    }
  }
}

export function buildBootstrapPlan(options: BootstrapOptions): BootstrapPlan {
  const targetDir = resolve(options.targetDir);
  const sourceRepoDir = resolve(options.repoSource ?? process.cwd());
  const { configPath: sourceConfigPath, instanceDir } = resolveInstance(
    options.instanceName,
    undefined,
    options.configPath,
  );
  loadInstanceEnv(instanceDir);
  const config = loadConfig(sourceConfigPath);
  const relativeConfigPath = relative(sourceRepoDir, sourceConfigPath);
  const targetConfigPath = relativeConfigPath && !relativeConfigPath.startsWith("..")
    ? join(targetDir, relativeConfigPath)
    : join(targetDir, ".nyxhive", "config.toml");
  const envSourcePath = findEnvFile([sourceRepoDir, instanceDir], options.envFile);
  const relativeEnvPath = envSourcePath ? relative(sourceRepoDir, envSourcePath) : undefined;
  const targetEnvPath = envSourcePath
    ? relativeEnvPath && !relativeEnvPath.startsWith("..")
      ? join(targetDir, relativeEnvPath)
      : join(targetDir, ".env")
    : undefined;

  const steps = [
    options.gitUrl ? "git" : "repo",
    "config",
    "dependencies",
    ...(targetEnvPath ? ["env"] : []),
    ...(options.installService ? ["service"] : []),
    ...(options.start ? ["start", "health-check"] : []),
  ];

  return {
    sourceConfigPath,
    sourceRepoDir,
    sourceEnvPath: envSourcePath,
    targetDir,
    targetConfigPath,
    targetEnvPath,
    instanceName: config.daemon.name,
    port: config.server.port,
    steps,
  };
}

export async function bootstrapLocal(options: BootstrapOptions): Promise<BootstrapResult> {
  const plan = buildBootstrapPlan(options);
  const steps: string[] = [];

  if (options.dryRun) {
    return { success: true, plan, steps: plan.steps.slice() };
  }

  mkdirSync(plan.targetDir, { recursive: true });

  if (options.gitUrl) {
    steps.push("git");
    syncGitRepo(plan.targetDir, options.gitUrl, options.gitRef);
  } else {
    if (!existsSync(plan.sourceRepoDir)) {
      throw new Error(`Repo source not found: ${plan.sourceRepoDir}`);
    }
    steps.push("repo");
    copyRepo(plan.sourceRepoDir, plan.targetDir);
  }

  steps.push("config");
  copyFile(plan.sourceConfigPath, plan.targetConfigPath);

  if (plan.targetEnvPath) {
    if (plan.sourceEnvPath) {
      steps.push("env");
      copyFile(plan.sourceEnvPath, plan.targetEnvPath);
    }
  }

  steps.push("dependencies");
  runBunInstall(plan.targetDir);

  let servicePath: string | undefined;
  if (options.installService) {
    steps.push("service");
    const serviceResult = installService({
      instanceName: plan.instanceName,
      instancePath: plan.targetDir,
      configPath: plan.targetConfigPath,
      port: plan.port,
    });
    if (!serviceResult.success) throw new Error(serviceResult.message);
    servicePath = serviceResult.path;
    if (platform() === "darwin") {
      maybeLoadService(serviceResult.path);
    }
  }

  if (options.start) {
    steps.push("start");
    startInstance(plan.targetDir, plan.targetConfigPath);
    steps.push("health-check");
    const healthy = await pollHealthCheck("127.0.0.1", plan.port);
    if (!healthy) {
      throw new Error(`Health check failed on port ${plan.port}`);
    }
  }

  return { success: true, plan, steps, servicePath };
}

function parseArgs(argv: string[]): BootstrapOptions {
  let instanceName: string | undefined;
  let configPath: string | undefined;
  let repoSource: string | undefined;
  let gitUrl: string | undefined;
  let gitRef: string | undefined;
  let envFile: string | undefined;
  let targetDir: string | undefined;
  let installServiceFlag = false;
  let start = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config" && argv[i + 1]) configPath = argv[++i];
    else if (arg === "--repo" && argv[i + 1]) repoSource = argv[++i];
    else if (arg === "--git-url" && argv[i + 1]) gitUrl = argv[++i];
    else if (arg === "--git-ref" && argv[i + 1]) gitRef = argv[++i];
    else if (arg === "--env-file" && argv[i + 1]) envFile = argv[++i];
    else if (arg === "--target" && argv[i + 1]) targetDir = argv[++i];
    else if (arg === "--service") installServiceFlag = true;
    else if (arg === "--start") start = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (!arg.startsWith("--") && !instanceName) instanceName = arg;
  }

  if (!targetDir) {
    throw new Error("Usage: nyxhive bootstrap [instance] --target <dir> [--repo <dir>|--git-url <url>] [--start] [--service] [--dry-run]");
  }

  return {
    instanceName,
    configPath,
    repoSource,
    gitUrl,
    gitRef,
    envFile,
    targetDir,
    installService: installServiceFlag,
    start,
    dryRun,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(3));
  const result = await bootstrapLocal(options);
  const mode = options.dryRun ? "Bootstrap plan" : "Bootstrap complete";

  logger.info(`
  ${mode}
  ─────────────────
  Instance: ${result.plan.instanceName}
  Target:   ${result.plan.targetDir}
  Config:   ${result.plan.targetConfigPath}
  Port:     ${result.plan.port}
  Steps:    ${result.steps.join(", ") || "none"}
`);
  if (result.plan.targetEnvPath) logger.info(`  Env:      ${result.plan.targetEnvPath}`);
  if (result.servicePath) logger.info(`  Service:  ${result.servicePath}`);
  if (options.dryRun && isDirectoryEmpty(resolve(options.targetDir))) {
    logger.info("  Dry run only — target directory was not modified.");
  }
}

if (process.argv[2] === "bootstrap") {
  main().catch((err) => {
    logger.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
