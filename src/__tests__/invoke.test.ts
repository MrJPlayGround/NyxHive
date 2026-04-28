import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  validateAllowedDirectory,
  cleanupTempFiles,
  pendingTempDirs,
  ANTHROPIC_MODEL_PATTERN,
  formatInvocationLogLabel,
  buildClassificationLogPayload,
} from "../agents/invoke.js";

describe("validateAllowedDirectory", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "invoke-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("accepts a valid directory", () => {
    const result = validateAllowedDirectory(tempDir);
    // On macOS, realpath resolves /var → /private/var
    expect(result).toContain("invoke-test-");
  });

  it("rejects null bytes in path", () => {
    expect(() => validateAllowedDirectory("/tmp/test\0hack")).toThrow("null byte");
  });

  it("blocks /etc", () => {
    expect(() => validateAllowedDirectory("/etc")).toThrow("Blocked system directory");
  });

  it("blocks /etc subdirectory", () => {
    expect(() => validateAllowedDirectory("/etc/passwd")).toThrow("Blocked system directory");
  });

  it("blocks /root", () => {
    expect(() => validateAllowedDirectory("/root")).toThrow("Blocked system directory");
  });

  it("blocks /proc", () => {
    expect(() => validateAllowedDirectory("/proc")).toThrow("Blocked system directory");
  });

  it("blocks /usr/bin", () => {
    expect(() => validateAllowedDirectory("/usr/bin")).toThrow("Blocked system directory");
  });

  it("resolves non-existent directory to absolute path without error", () => {
    const result = validateAllowedDirectory("/tmp/nonexistent-dir-12345");
    expect(result).toBe("/tmp/nonexistent-dir-12345");
  });

  it("normalizes path segments", () => {
    const result = validateAllowedDirectory(join(tempDir, "a", "..", "b"));
    // Should normalize away the ".."
    expect(result).toContain(tempDir);
  });
});

describe("cleanupTempFiles", () => {
  it("removes all tracked temp directories", () => {
    const dir1 = mkdtempSync(join(tmpdir(), "cleanup-test-1-"));
    const dir2 = mkdtempSync(join(tmpdir(), "cleanup-test-2-"));

    pendingTempDirs.add(dir1);
    pendingTempDirs.add(dir2);

    expect(existsSync(dir1)).toBe(true);
    expect(existsSync(dir2)).toBe(true);

    cleanupTempFiles();

    expect(existsSync(dir1)).toBe(false);
    expect(existsSync(dir2)).toBe(false);
    expect(pendingTempDirs.size).toBe(0);
  });

  it("handles already-deleted directories gracefully", () => {
    pendingTempDirs.add("/tmp/nonexistent-cleanup-test-dir");
    // Should not throw
    cleanupTempFiles();
    expect(pendingTempDirs.size).toBe(0);
  });

  it("clears the set even on empty", () => {
    pendingTempDirs.clear();
    cleanupTempFiles();
    expect(pendingTempDirs.size).toBe(0);
  });
});

describe("ANTHROPIC_MODEL_PATTERN", () => {
  it("matches claude-* models", () => {
    expect(ANTHROPIC_MODEL_PATTERN.test("claude-sonnet-4-6")).toBe(true);
    expect(ANTHROPIC_MODEL_PATTERN.test("claude-opus-4-6")).toBe(true);
    expect(ANTHROPIC_MODEL_PATTERN.test("claude-haiku-4-5-20251001")).toBe(true);
  });

  it("matches anthropic/ prefixed models", () => {
    expect(ANTHROPIC_MODEL_PATTERN.test("anthropic/claude-sonnet-4-6")).toBe(true);
  });

  it("does not match non-claude models", () => {
    expect(ANTHROPIC_MODEL_PATTERN.test("gpt-4")).toBe(false);
    expect(ANTHROPIC_MODEL_PATTERN.test("google/gemini-2.5-flash")).toBe(false);
  });
});

describe("invoke log helpers", () => {
  it("formats a compact invocation label with correlation fields", () => {
    const label = formatInvocationLogLabel("Nyx", {
      messageId: "12345678-90ab-cdef-1234-567890abcdef",
      channel: "gateway",
      senderName: "User Founder",
    });

    expect(label).toBe("[msg=12345678 ch=gateway from=User_Founder agent=Nyx]");
  });

  it("builds classification payloads with invocation metadata", () => {
    const payload = buildClassificationLogPayload("hello there", "Nyx", {
      messageId: "abc123456789",
      channel: "gateway",
      senderName: "User",
    }, {
      type: "analysis",
      invocation: "cli",
    });

    expect(payload).toEqual({
      type: "analysis",
      invocation: "cli",
      agent: "Nyx",
      message_id: "abc123456789",
      channel: "gateway",
      sender: "User",
      message: "hello there",
    });
  });
});
