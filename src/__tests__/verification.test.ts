import { describe, it, expect } from "bun:test";
import { runVerification, resolveVerifyConfig, type VerifyConfig } from "../proposals/verification.js";

describe("resolveVerifyConfig", () => {
  const projects = [
    { name: "NyxHive", repo_path: "/home/user/dev/nyxhive", verify: { test_command: "bun test", build_command: "bun run build" } },
    { name: "Trading Journal", repo_path: "/home/user/dev/example-app" },
    { name: "Deft Voice", repo_path: "/home/user/dev/example-voice", verify: { test_command: "bun test" } },
  ];

  it("returns verify config for matching project", () => {
    const config = resolveVerifyConfig("/home/user/dev/nyxhive", projects);
    expect(config).toEqual({ test_command: "bun test", build_command: "bun run build" });
  });

  it("matches subdirectory paths", () => {
    const config = resolveVerifyConfig("/home/user/dev/nyxhive/src/queue", projects);
    expect(config).toEqual({ test_command: "bun test", build_command: "bun run build" });
  });

  it("returns null for project without verify config", () => {
    const config = resolveVerifyConfig("/home/user/dev/example-app", projects);
    expect(config).toBeNull();
  });

  it("returns null for unknown repo path", () => {
    const config = resolveVerifyConfig("/home/user/dev/unknown", projects);
    expect(config).toBeNull();
  });

  it("returns null when no projects defined", () => {
    expect(resolveVerifyConfig("/any/path", undefined)).toBeNull();
    expect(resolveVerifyConfig("/any/path", [])).toBeNull();
  });

  it("handles trailing slashes", () => {
    const config = resolveVerifyConfig("/home/user/dev/nyxhive/", projects);
    expect(config).toEqual({ test_command: "bun test", build_command: "bun run build" });
  });
});

describe("runVerification", () => {
  it("passes when test command succeeds", async () => {
    const result = await runVerification("/tmp", { test_command: "echo ok" });
    expect(result.passed).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].name).toBe("test");
    expect(result.steps[0].passed).toBe(true);
  });

  it("fails when test command fails", async () => {
    const result = await runVerification("/tmp", { test_command: "exit 1" });
    expect(result.passed).toBe(false);
    expect(result.steps[0].passed).toBe(false);
  });

  it("skips test when build fails", async () => {
    const result = await runVerification("/tmp", {
      test_command: "echo tested",
      build_command: "exit 1",
    });
    expect(result.passed).toBe(false);
    expect(result.steps).toHaveLength(1); // Only build ran, test skipped
    expect(result.steps[0].name).toBe("build");
  });

  it("runs both build and test when build passes", async () => {
    const result = await runVerification("/tmp", {
      test_command: "echo tested",
      build_command: "echo built",
    });
    expect(result.passed).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].name).toBe("build");
    expect(result.steps[1].name).toBe("test");
  });

  it("passes with no commands configured", async () => {
    const result = await runVerification("/tmp", {});
    expect(result.passed).toBe(true);
    expect(result.steps).toHaveLength(0);
  });

  it("captures output from failed command", async () => {
    const result = await runVerification("/tmp", { test_command: "echo 'FAIL: something broke' && exit 1" });
    expect(result.passed).toBe(false);
    expect(result.steps[0].output).toContain("FAIL: something broke");
  });

  it("tracks duration", async () => {
    const result = await runVerification("/tmp", { test_command: "echo fast" });
    expect(result.steps[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.steps[0].duration_ms).toBeLessThan(5000);
  });
});
