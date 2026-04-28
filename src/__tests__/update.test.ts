import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getChangedDependencyFiles,
  resolveTrackingRef,
  updateEngine,
} from "../cli/update.js";

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || result.stdout.toString().trim() || `${command.join(" ")} failed`);
  }

  return result.stdout.toString().trim();
}

describe("engine update", () => {
  let root: string;
  let remoteDir: string;
  let seedDir: string;
  let cloneDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nyxhive-update-"));
    remoteDir = join(root, "remote.git");
    seedDir = join(root, "seed");
    cloneDir = join(root, "clone");

    run(["git", "init", "--bare", "--initial-branch=master", remoteDir], root);

    run(["git", "init", "--initial-branch=master", seedDir], root);
    run(["git", "-C", seedDir, "config", "user.name", "Nyx"], root);
    run(["git", "-C", seedDir, "config", "user.email", "nyx@example.com"], root);
    writeFileSync(join(seedDir, "README.md"), "# NyxHive\n");
    run(["git", "-C", seedDir, "add", "README.md"], root);
    run(["git", "-C", seedDir, "commit", "-m", "init"], root);
    run(["git", "-C", seedDir, "remote", "add", "origin", remoteDir], root);
    run(["git", "-C", seedDir, "push", "-u", "origin", "master"], root);

    run(["git", "clone", remoteDir, cloneDir], root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function commitToRemote(filename: string, content: string, message: string): string {
    writeFileSync(join(seedDir, filename), content);
    run(["git", "-C", seedDir, "add", filename], root);
    run(["git", "-C", seedDir, "commit", "-m", message], root);
    run(["git", "-C", seedDir, "push", "origin", "master"], root);
    return run(["git", "-C", seedDir, "rev-parse", "--short", "HEAD"], root);
  }

  test("falls back to origin/HEAD when upstream is unset", () => {
    run(["git", "-C", cloneDir, "branch", "--unset-upstream"], root);

    expect(resolveTrackingRef(cloneDir)).toBe("origin/master");
  });

  test("reports available updates without changing HEAD in dry-run mode", async () => {
    const targetVersion = commitToRemote("notes.txt", "new\n", "add notes");
    const startingVersion = run(["git", "-C", cloneDir, "rev-parse", "--short", "HEAD"], root);

    const result = await updateEngine({ repoDir: cloneDir, dryRun: true });

    expect(result.status).toBe("update-available");
    expect(result.startingVersion).toBe(startingVersion);
    expect(result.targetVersion).toBe(targetVersion);
    expect(result.finalVersion).toBe(startingVersion);
    expect(run(["git", "-C", cloneDir, "rev-parse", "--short", "HEAD"], root)).toBe(startingVersion);
  });

  test("allows dry-run on a dirty checkout because it does not write", async () => {
    const targetVersion = commitToRemote("notes.txt", "new\n", "add notes");
    writeFileSync(join(cloneDir, "local.txt"), "dirty\n");

    const result = await updateEngine({ repoDir: cloneDir, dryRun: true });

    expect(result.status).toBe("update-available");
    expect(result.targetVersion).toBe(targetVersion);
    expect(run(["git", "-C", cloneDir, "status", "--short"], root)).toContain("?? local.txt");
  });

  test("fast-forwards the engine checkout when updates exist", async () => {
    const targetVersion = commitToRemote("notes.txt", "new\n", "add notes");

    const result = await updateEngine({ repoDir: cloneDir });

    expect(result.status).toBe("updated");
    expect(result.finalVersion).toBe(targetVersion);
    expect(run(["git", "-C", cloneDir, "rev-parse", "--short", "HEAD"], root)).toBe(targetVersion);
    expect(result.dependenciesInstalled).toBe(false);
  });

  test("detects dependency file changes across revisions", () => {
    writeFileSync(join(seedDir, "package.json"), JSON.stringify({ name: "test" }, null, 2));
    run(["git", "-C", seedDir, "add", "package.json"], root);
    run(["git", "-C", seedDir, "commit", "-m", "add package"], root);

    const fromRef = run(["git", "-C", seedDir, "rev-parse", "--short", "HEAD~1"], root);
    const toRef = run(["git", "-C", seedDir, "rev-parse", "--short", "HEAD"], root);

    expect(getChangedDependencyFiles(seedDir, fromRef, toRef)).toEqual(["package.json"]);
  });

  test("refuses to apply updates to a dirty engine checkout without --stash", async () => {
    commitToRemote("notes.txt", "new\n", "add notes");
    writeFileSync(join(cloneDir, "local.txt"), "dirty\n");

    await expect(updateEngine({ repoDir: cloneDir })).rejects.toThrow("local changes");
  });

  test("auto-stashes and restores local changes when requested", async () => {
    const targetVersion = commitToRemote("notes.txt", "new\n", "add notes");
    writeFileSync(join(cloneDir, "README.md"), "# NyxHive\nlocal edit\n");
    writeFileSync(join(cloneDir, "local.txt"), "dirty\n");

    const result = await updateEngine({ repoDir: cloneDir, stash: true });

    expect(result.status).toBe("updated");
    expect(result.finalVersion).toBe(targetVersion);
    expect(result.usedStash).toBe(true);
    expect(await Bun.file(join(cloneDir, "README.md")).text()).toContain("local edit");
    expect(await Bun.file(join(cloneDir, "local.txt")).text()).toBe("dirty\n");
  });

  test("dirty but already up-to-date checkout reports success without stashing", async () => {
    writeFileSync(join(cloneDir, "local.txt"), "dirty\n");

    const result = await updateEngine({ repoDir: cloneDir });

    expect(result.status).toBe("up-to-date");
    expect(result.usedStash).toBe(false);
    expect(run(["git", "-C", cloneDir, "status", "--short"], root)).toContain("?? local.txt");
  });
});
