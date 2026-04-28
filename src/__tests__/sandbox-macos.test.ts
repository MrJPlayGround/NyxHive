import { describe, it, expect } from "bun:test";
import { MacOSSandbox } from "../sandbox/macos.js";

describe("MacOSSandbox", () => {
  describe("path validation", () => {
    const sandbox = new MacOSSandbox("test");
    const baseOpts = {
      command: ["echo", "hi"],
      env: {},
    };

    it("rejects cwd with double quotes", () => {
      expect(() =>
        sandbox.wrap({
          ...baseOpts,
          cwd: '/tmp/evil" (allow file-write* (subpath "/',
        })
      ).toThrow();
    });

    it("rejects cwd with parentheses", () => {
      expect(() =>
        sandbox.wrap({
          ...baseOpts,
          cwd: "/tmp/evil) (allow file-write* (subpath /",
        })
      ).toThrow();
    });

    it("rejects cwd with semicolons", () => {
      expect(() =>
        sandbox.wrap({
          ...baseOpts,
          cwd: "/tmp/evil; rm -rf /",
        })
      ).toThrow();
    });

    it("rejects relative cwd", () => {
      expect(() =>
        sandbox.wrap({
          ...baseOpts,
          cwd: "relative/path",
        })
      ).toThrow();
    });

    it("rejects writableDirs with sandbox metacharacters", () => {
      expect(() =>
        sandbox.wrap({
          ...baseOpts,
          cwd: "/tmp/safe",
          writableDirs: ['/tmp/evil"'],
        })
      ).toThrow();
    });

    it("rejects mountDirs with sandbox metacharacters", () => {
      expect(() =>
        sandbox.wrap({
          ...baseOpts,
          cwd: "/tmp/safe",
          mountDirs: ["/tmp/evil)"],
        })
      ).toThrow();
    });

    it("rejects mountDirs with relative paths", () => {
      expect(() =>
        sandbox.wrap({
          ...baseOpts,
          cwd: "/tmp/safe",
          mountDirs: ["relative/mount"],
        })
      ).toThrow();
    });

    it("allows valid absolute paths", () => {
      // Should not throw — valid paths with normal chars
      expect(() =>
        sandbox.wrap({
          ...baseOpts,
          cwd: "/home/user/dev/project",
          writableDirs: ["/tmp/workspace"],
          mountDirs: ["/Volumes/ExampleDrive/vault"],
        })
      ).not.toThrow();
    });

    it("allows paths with spaces, hyphens, underscores, dots", () => {
      expect(() =>
        sandbox.wrap({
          ...baseOpts,
          cwd: "/home/user/my project/sub-dir/v1.0_final",
        })
      ).not.toThrow();
    });
  });
});
