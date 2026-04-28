import { describe, it, expect } from "bun:test";
import { getExpectedArtifacts, getRequiredArtifacts, validateArtifacts } from "../proposals/artifacts.js";

describe("artifact registry", () => {
  it("returns expected artifacts for each category", () => {
    expect(getExpectedArtifacts("bugfix").length).toBeGreaterThan(0);
    expect(getExpectedArtifacts("feature").length).toBeGreaterThan(0);
    expect(getExpectedArtifacts("maintenance").length).toBeGreaterThan(0);
    expect(getExpectedArtifacts("improvement").length).toBeGreaterThan(0);
    expect(getExpectedArtifacts("new_instance").length).toBeGreaterThan(0);
  });

  it("bugfix and feature require commit, test_pass, type_check, pr", () => {
    for (const cat of ["bugfix", "feature"] as const) {
      const required = getRequiredArtifacts(cat).map(a => a.kind);
      expect(required).toContain("commit");
      expect(required).toContain("test_pass");
      expect(required).toContain("type_check");
      expect(required).toContain("pr");
    }
  });

  it("maintenance has no required artifacts", () => {
    const required = getRequiredArtifacts("maintenance");
    expect(required).toHaveLength(0);
  });

  it("improvement requires commit, test, type_check but not pr", () => {
    const required = getRequiredArtifacts("improvement").map(a => a.kind);
    expect(required).toContain("commit");
    expect(required).toContain("test_pass");
    expect(required).toContain("type_check");
    expect(required).not.toContain("pr");
  });
});

describe("validateArtifacts", () => {
  it("passes when all required artifacts are present", () => {
    const result = validateArtifacts("bugfix", {
      commit: true,
      test_pass: true,
      type_check: true,
      pr: true,
    });
    expect(result.passed).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it("fails when required artifact is missing", () => {
    const result = validateArtifacts("bugfix", {
      commit: true,
      test_pass: true,
      type_check: true,
      pr: false,
    });
    expect(result.passed).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].kind).toBe("pr");
  });

  it("fails when commit is missing for feature", () => {
    const result = validateArtifacts("feature", {
      commit: false,
      test_pass: true,
      type_check: true,
      pr: true,
    });
    expect(result.passed).toBe(false);
    expect(result.missing[0].kind).toBe("commit");
  });

  it("fails for maintenance when nothing is present (conditional floor)", () => {
    const result = validateArtifacts("maintenance", {});
    expect(result.passed).toBe(false);
    expect(result.missing.length).toBe(1);
  });

  it("passes for maintenance when at least one artifact is present", () => {
    const result = validateArtifacts("maintenance", { commit: true });
    expect(result.passed).toBe(true);
  });

  it("reports all checks including optional ones", () => {
    const result = validateArtifacts("maintenance", { commit: true });
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.find(c => c.kind === "commit")?.present).toBe(true);
  });

  it("treats missing artifacts as not present", () => {
    // Only pass commit — test_pass, type_check, pr are undefined
    const result = validateArtifacts("bugfix", { commit: true });
    expect(result.passed).toBe(false);
    expect(result.missing.length).toBe(3); // test_pass, type_check, pr
  });
});
