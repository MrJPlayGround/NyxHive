import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { logger } from "../utils/logger.js";

interface RepoPreset {
  key: string;
  label: string;
  url: string;
  aliases: string[];
}

export interface ResolvedRepo {
  key: string;
  label: string;
  url: string;
  preset: boolean;
}

const PROJECT_ROOT = resolve(import.meta.dir, "../..");

const REPO_PRESETS: RepoPreset[] = [
  {
    key: "nyxlabs",
    label: "NyxLabs",
    url: "git@github.com:example-org/NyxLabs.git",
    aliases: ["nyxlabs", "nyx-labs"],
  },
];

function trimAnswer(value: string): string {
  return value.trim();
}

export function inferRepoSlug(repoUrl: string): string {
  const cleaned = repoUrl.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const tail = cleaned.split(/[:/]/).pop() ?? "project";
  return tail || "project";
}

export function resolveRepoChoice(input: string): ResolvedRepo | null {
  const value = trimAnswer(input);
  if (!value) return null;

  const lowered = value.toLowerCase();
  const preset = REPO_PRESETS.find(entry => entry.aliases.includes(lowered));
  if (preset) {
    return {
      key: preset.key,
      label: preset.label,
      url: preset.url,
      preset: true,
    };
  }

  if (/^(?:git@|ssh:\/\/|https?:\/\/|git:\/\/)/i.test(value) || value.endsWith(".git")) {
    const slug = inferRepoSlug(value);
    return {
      key: slug.toLowerCase(),
      label: slug,
      url: value,
      preset: false,
    };
  }

  return null;
}

function runCommand(command: string[], cwd = PROJECT_ROOT): void {
  const result = Bun.spawnSync(command, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${command.join(" ")}), exit code ${result.exitCode}`);
  }
}

function cloneOrUpdateRepo(targetDir: string, repoUrl: string, gitRef?: string): void {
  const gitDir = join(targetDir, ".git");

  if (existsSync(gitDir)) {
    runCommand(["git", "-C", targetDir, "fetch", "--all", "--tags"]);
    if (gitRef) {
      runCommand(["git", "-C", targetDir, "checkout", gitRef]);
    }
    runCommand(["git", "-C", targetDir, "pull", "--ff-only"]);
    return;
  }

  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new Error(`Target directory is not empty: ${targetDir}`);
  }

  mkdirSync(dirname(targetDir), { recursive: true });

  const args = ["git", "clone"];
  if (gitRef) args.push("--branch", gitRef);
  args.push(repoUrl, targetDir);
  runCommand(args);
}

function findEnvTemplate(targetDir: string): string | undefined {
  const candidates = [
    ".env.example",
    ".env.local.example",
    ".env.sample",
    ".env.template",
  ];

  return candidates.find(candidate => existsSync(join(targetDir, candidate)));
}

async function promptMode(): Promise<"fresh" | "move"> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = trimAnswer(
        await rl.question("  Setup type [fresh/move] (fresh): "),
      ).toLowerCase();

      if (!answer || answer === "fresh" || answer === "f") return "fresh";
      if (answer === "move" || answer === "m") return "move";

      logger.warn("  Enter `fresh` or `move`.");
    }
  } finally {
    rl.close();
  }
}

async function runFreshSetup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const defaultDir = join(homedir(), "nyxhive");
    const targetDir = resolve(
      trimAnswer(await rl.question(`  Instance directory [${defaultDir}]: `)) || defaultDir,
    );

    rl.close();

    logger.info(`
  Fresh install
  ─────────────
  Target: ${targetDir}
`);

    runCommand(["bun", "run", "src/cli/index.ts", "init", targetDir]);
  } finally {
    rl.close();
  }
}

async function runMoveSetup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    logger.info(`
  Move an existing repo
  ─────────────────────
  Presets: nyxlabs
  Or paste any git URL.
`);

    let repo: ResolvedRepo | null = null;
    while (!repo) {
      const choice = trimAnswer(await rl.question("  Repo preset or git URL: "));
      repo = resolveRepoChoice(choice);
      if (!repo) {
        logger.warn("  Unknown preset. Use `nyxlabs` or paste a full git URL.");
      }
    }

    const defaultDir = join(homedir(), inferRepoSlug(repo.url));
    const targetDir = resolve(
      trimAnswer(await rl.question(`  Clone into [${defaultDir}]: `)) || defaultDir,
    );
    const gitRef = trimAnswer(await rl.question("  Branch/tag [default]: ")) || undefined;
    const installDepsAnswer = trimAnswer(await rl.question("  Run `bun install` after clone? [Y/n]: "));
    const installDeps = !/^(?:n|no)$/i.test(installDepsAnswer);

    rl.close();

    logger.info(`
  Repo move
  ─────────
  Repo:   ${repo.label}
  URL:    ${repo.url}
  Target: ${targetDir}
`);

    cloneOrUpdateRepo(targetDir, repo.url, gitRef);

    if (installDeps && existsSync(join(targetDir, "package.json"))) {
      logger.info("  Installing dependencies...");
      runCommand(["bun", "install"], targetDir);
    }

    const envTemplate = findEnvTemplate(targetDir);

    logger.info(`
  Ready
  ─────
  Repo available at ${targetDir}
`);

    if (envTemplate && !existsSync(join(targetDir, ".env"))) {
      logger.info(`  Env template detected: ${envTemplate}`);
    }

    logger.info(`  Next: cd ${targetDir}`);
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  logger.info(`
  NyxHive Setup
  ─────────────
`);

  const mode = await promptMode();
  if (mode === "fresh") {
    await runFreshSetup();
    return;
  }

  await runMoveSetup();
}

if (process.argv[2] === "setup") {
  main().catch((err) => {
    logger.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
