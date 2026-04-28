import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "fs";
import { join } from "path";
import { resolveInstance, loadInstanceEnv, listInstances } from "../cli/resolve.js";
import { addBookmark } from "../cli/instance-registry.js";

const TEST_BASE = "/tmp/nyxhive-test-resolve";
const INSTANCES_DIR = join(TEST_BASE, ".nyxhive", "instances");

function writeMinimalConfig(dir: string, name: string, port: number) {
  const toml = `
[daemon]
name = "${name}"
data_dir = "${dir}/data"

[server]
port = ${port}

[agents.test]
name = "Test"
provider = "anthropic"
model = "claude-sonnet-4-6"
working_directory = "${dir}/workspace"

[providers.anthropic]
api_key_env = "ANTHROPIC_API_KEY"

[routing]
classifier_model = "deepseek/deepseek-v3.2"
classifier_provider = "openrouter"
cli_escalation_tasks = ["coding"]

[context]
`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), toml);
}

beforeEach(() => {
  mkdirSync(INSTANCES_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_BASE, { recursive: true, force: true });
});

describe("resolveInstance", () => {
  test("resolves instance by name from ~/.nyxhive/instances/", () => {
    const instDir = join(INSTANCES_DIR, "TestApp");
    writeMinimalConfig(instDir, "TestApp", 3777);

    const result = resolveInstance("TestApp", INSTANCES_DIR);
    expect(result.configPath).toBe(join(instDir, "config.toml"));
    expect(result.instanceDir).toBe(instDir);
  });

  test("throws for completely wrong name", () => {
    const instDir = join(INSTANCES_DIR, "MyApp");
    writeMinimalConfig(instDir, "MyApp", 3778);

    expect(() => resolveInstance("WrongName", INSTANCES_DIR)).toThrow(
      /Instance "WrongName" not found/,
    );
  });

  test("resolves explicit --config path", () => {
    const customDir = join(TEST_BASE, "custom");
    writeMinimalConfig(customDir, "Custom", 3779);
    const configPath = join(customDir, "config.toml");

    const result = resolveInstance(undefined, INSTANCES_DIR, configPath);
    expect(result.configPath).toBe(configPath);
    expect(result.instanceDir).toBe(customDir);
  });

  test("--config takes priority over instance name", () => {
    const instDir = join(INSTANCES_DIR, "TestApp");
    writeMinimalConfig(instDir, "TestApp", 3777);
    const customDir = join(TEST_BASE, "custom");
    writeMinimalConfig(customDir, "Custom", 3779);
    const configPath = join(customDir, "config.toml");

    const result = resolveInstance("TestApp", INSTANCES_DIR, configPath);
    expect(result.configPath).toBe(configPath);
  });

  test("resolves directory path containing config.toml", () => {
    const dirPath = join(TEST_BASE, "some-dir");
    writeMinimalConfig(dirPath, "DirApp", 3780);

    const result = resolveInstance(dirPath, INSTANCES_DIR);
    expect(result.configPath).toBe(join(dirPath, "config.toml"));
    expect(result.instanceDir).toBe(dirPath);
  });

  test("throws when instance name not found", () => {
    expect(() => resolveInstance("NonExistent", INSTANCES_DIR)).toThrow(
      /Instance "NonExistent" not found/,
    );
  });

  test("throws when no name and no config flag and no default config", () => {
    const origCwd = process.cwd();
    process.chdir(TEST_BASE);
    try {
      expect(() => resolveInstance(undefined, INSTANCES_DIR)).toThrow();
    } finally {
      process.chdir(origCwd);
    }
  });

  test("resolves .nyxhive/config.toml in CWD when no name given", () => {
    const nyxhiveDir = join(TEST_BASE, ".nyxhive");
    mkdirSync(nyxhiveDir, { recursive: true });
    writeMinimalConfig(nyxhiveDir, "WorkspaceApp", 3790);

    const origCwd = process.cwd();
    process.chdir(TEST_BASE);
    try {
      const realNyxhiveDir = realpathSync(nyxhiveDir);
      const result = resolveInstance(undefined, INSTANCES_DIR);
      expect(result.configPath).toBe(join(realNyxhiveDir, "config.toml"));
      expect(result.instanceDir).toBe(realNyxhiveDir);
    } finally {
      process.chdir(origCwd);
    }
  });

  test("instanceDir for .nyxhive/config.toml is the .nyxhive directory", () => {
    const nyxhiveDir = join(TEST_BASE, ".nyxhive");
    mkdirSync(nyxhiveDir, { recursive: true });
    writeMinimalConfig(nyxhiveDir, "WorkspaceApp", 3791);

    const origCwd = process.cwd();
    process.chdir(TEST_BASE);
    try {
      const realNyxhiveDir = realpathSync(nyxhiveDir);
      const result = resolveInstance(undefined, INSTANCES_DIR);
      // instanceDir must point into .nyxhive so loadInstanceEnv picks up .nyxhive/.env
      expect(result.instanceDir).toBe(realNyxhiveDir);
    } finally {
      process.chdir(origCwd);
    }
  });

  test("falls back to CWD/config.toml when .nyxhive/ does not exist", () => {
    writeMinimalConfig(TEST_BASE, "FlatApp", 3792);

    const origCwd = process.cwd();
    process.chdir(TEST_BASE);
    try {
      const realBase = realpathSync(TEST_BASE);
      const result = resolveInstance(undefined, INSTANCES_DIR);
      expect(result.configPath).toBe(join(realBase, "config.toml"));
      expect(result.instanceDir).toBe(realBase);
    } finally {
      process.chdir(origCwd);
    }
  });
});

describe("loadInstanceEnv", () => {
  test("loads env vars from instance env file", () => {
    const instDir = join(TEST_BASE, "env-test");
    mkdirSync(instDir, { recursive: true });
    writeFileSync(join(instDir, "env"), "TEST_RESOLVE_A=hello\nTEST_RESOLVE_B=world\n");

    const loaded = loadInstanceEnv(instDir);
    expect(loaded).toBe(2);
    expect(process.env.TEST_RESOLVE_A).toBe("hello");
    expect(process.env.TEST_RESOLVE_B).toBe("world");

    delete process.env.TEST_RESOLVE_A;
    delete process.env.TEST_RESOLVE_B;
  });

  test("skips comments and empty lines", () => {
    const instDir = join(TEST_BASE, "env-comments");
    mkdirSync(instDir, { recursive: true });
    writeFileSync(join(instDir, "env"), "# A comment\n\nTEST_RESOLVE_C=value\n\n# Another\n");

    const loaded = loadInstanceEnv(instDir);
    expect(loaded).toBe(1);
    expect(process.env.TEST_RESOLVE_C).toBe("value");

    delete process.env.TEST_RESOLVE_C;
  });

  test("does not override already-set env vars", () => {
    const instDir = join(TEST_BASE, "env-no-override");
    mkdirSync(instDir, { recursive: true });
    writeFileSync(join(instDir, "env"), "TEST_RESOLVE_D=from-file\n");

    process.env.TEST_RESOLVE_D = "from-shell";
    const loaded = loadInstanceEnv(instDir);
    expect(loaded).toBe(0);
    expect(process.env.TEST_RESOLVE_D).toBe("from-shell");

    delete process.env.TEST_RESOLVE_D;
  });

  test("returns 0 when no env file exists", () => {
    const instDir = join(TEST_BASE, "env-missing");
    mkdirSync(instDir, { recursive: true });

    const loaded = loadInstanceEnv(instDir);
    expect(loaded).toBe(0);
  });

  test("handles values with equals signs", () => {
    const instDir = join(TEST_BASE, "env-equals");
    mkdirSync(instDir, { recursive: true });
    writeFileSync(join(instDir, "env"), "TEST_RESOLVE_E=a=b=c\n");

    const loaded = loadInstanceEnv(instDir);
    expect(loaded).toBe(1);
    expect(process.env.TEST_RESOLVE_E).toBe("a=b=c");

    delete process.env.TEST_RESOLVE_E;
  });

  test("trims whitespace from keys and values", () => {
    const instDir = join(TEST_BASE, "env-trim");
    mkdirSync(instDir, { recursive: true });
    writeFileSync(join(instDir, "env"), "  TEST_RESOLVE_F = spaced  \n");

    const loaded = loadInstanceEnv(instDir);
    expect(loaded).toBe(1);
    expect(process.env.TEST_RESOLVE_F).toBe("spaced");

    delete process.env.TEST_RESOLVE_F;
  });

  test("strips surrounding quotes from env values", () => {
    const instDir = join(TEST_BASE, "env-quotes");
    mkdirSync(instDir, { recursive: true });
    writeFileSync(
      join(instDir, "env"),
      'TEST_RESOLVE_DQ="double-quoted"\nTEST_RESOLVE_SQ=\'single-quoted\'\nTEST_RESOLVE_NQ=no-quotes\n',
    );

    const loaded = loadInstanceEnv(instDir);
    expect(loaded).toBe(3);
    expect(process.env.TEST_RESOLVE_DQ).toBe("double-quoted");
    expect(process.env.TEST_RESOLVE_SQ).toBe("single-quoted");
    expect(process.env.TEST_RESOLVE_NQ).toBe("no-quotes");

    delete process.env.TEST_RESOLVE_DQ;
    delete process.env.TEST_RESOLVE_SQ;
    delete process.env.TEST_RESOLVE_NQ;
  });

  test("loads both .env and env, with .env taking precedence while env fills missing keys", () => {
    const instDir = join(TEST_BASE, "env-merge");
    mkdirSync(instDir, { recursive: true });
    writeFileSync(join(instDir, ".env"), "TEST_RESOLVE_PRIMARY=from-dotenv\nTEST_RESOLVE_SHARED=dotenv\n");
    writeFileSync(join(instDir, "env"), "TEST_RESOLVE_FALLBACK=from-env\nTEST_RESOLVE_SHARED=env\n");

    delete process.env.TEST_RESOLVE_PRIMARY;
    delete process.env.TEST_RESOLVE_FALLBACK;
    delete process.env.TEST_RESOLVE_SHARED;

    const loaded = loadInstanceEnv(instDir);
    expect(loaded).toBe(3);
    expect(process.env.TEST_RESOLVE_PRIMARY!).toBe("from-dotenv");
    expect(process.env.TEST_RESOLVE_FALLBACK!).toBe("from-env");
    expect(process.env.TEST_RESOLVE_SHARED!).toBe("dotenv");

    delete process.env.TEST_RESOLVE_PRIMARY;
    delete process.env.TEST_RESOLVE_FALLBACK;
    delete process.env.TEST_RESOLVE_SHARED;
  });
});

describe("listInstances", () => {
  const bookmarksPath = join(TEST_BASE, "bookmarks.json");

  test("lists instances from bookmarks", () => {
    const inst1 = join(INSTANCES_DIR, "AppOne");
    const inst2 = join(INSTANCES_DIR, "AppTwo");
    writeMinimalConfig(inst1, "AppOne", 3777);
    writeMinimalConfig(inst2, "AppTwo", 3778);
    addBookmark({ name: "AppOne", path: inst1, port: 3777 }, bookmarksPath);
    addBookmark({ name: "AppTwo", path: inst2, port: 3778 }, bookmarksPath);

    const instances = listInstances(bookmarksPath);
    expect(instances.length).toBe(2);
    expect(instances.map((i) => i.name).sort()).toEqual(["AppOne", "AppTwo"]);
    expect(instances.find((i) => i.name === "AppOne")?.port).toBe(3777);
    expect(instances.find((i) => i.name === "AppTwo")?.port).toBe(3778);
  });

  test("resolves relative data_dir from the bookmarked instance directory", () => {
    const inst = join(TEST_BASE, "workspace", ".nyxhive");
    mkdirSync(inst, { recursive: true });
    writeFileSync(join(inst, "config.toml"), `
[daemon]
name = "WorkspaceApp"
data_dir = "./data"

[server]
port = 3799
`);
    addBookmark({ name: "WorkspaceApp", path: inst, port: 3799 }, bookmarksPath);

    const instances = listInstances(bookmarksPath);

    expect(instances).toHaveLength(1);
    expect(instances[0].dataDir).toBe(join(inst, "data"));
  });

  test("skips bookmarks without config.toml", () => {
    const inst1 = join(INSTANCES_DIR, "Good");
    writeMinimalConfig(inst1, "Good", 3777);
    mkdirSync(join(INSTANCES_DIR, "Bad"), { recursive: true });
    addBookmark({ name: "Good", path: inst1, port: 3777 }, bookmarksPath);
    addBookmark({ name: "Bad", path: join(INSTANCES_DIR, "Bad") }, bookmarksPath);

    const instances = listInstances(bookmarksPath);
    expect(instances.length).toBe(1);
    expect(instances[0].name).toBe("Good");
  });

  test("returns empty array when no bookmarks exist", () => {
    const instances = listInstances(bookmarksPath);
    expect(instances).toEqual([]);
  });

  test("returns empty array for nonexistent bookmarks file", () => {
    const instances = listInstances("/tmp/nonexistent-bookmarks.json");
    expect(instances).toEqual([]);
  });
});
