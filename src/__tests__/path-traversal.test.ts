import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { validateFilePath } from "../agents/tools.js";
import { validateAllowedDirectory } from "../agents/invoke.js";

// ---------------------------------------------------------------------------
// validateFilePath
// ---------------------------------------------------------------------------

describe("validateFilePath", () => {
  // Resolve workDir to its real path so that realpathSync(resolved).startsWith(workDir)
  // comparisons work on macOS where /var/folders → /private/var/folders.
  const workDir = realpathSync(mkdtempSync(join(tmpdir(), "nyx-vfp-")));

  afterAll(() => {
    try { rmSync(workDir, { recursive: true }); } catch {}
  });

  describe("traversal attacks", () => {
    test("rejects ../../../etc/passwd style traversal", () => {
      const result = validateFilePath("../../../etc/passwd", workDir);
      expect(result.valid).toBe(false);
      expect(result.error).toBeTruthy();
    });

    test("rejects absolute path outside workDir", () => {
      const result = validateFilePath("/tmp/outside-file.txt", workDir);
      expect(result.valid).toBe(false);
    });

    test("rejects sibling path that shares the workDir prefix", () => {
      const siblingDir = join(dirname(workDir), `${basename(workDir)}-escape`);
      mkdirSync(siblingDir);

      try {
        const result = validateFilePath(`../${basename(siblingDir)}/secret.txt`, workDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("outside allowed directories");
      } finally {
        rmSync(siblingDir, { recursive: true });
      }
    });

    test("rejects path with null byte", () => {
      const result = validateFilePath("file\0.txt", workDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("null byte");
    });
  });

  describe("valid paths", () => {
    test("accepts relative path within workDir", () => {
      const result = validateFilePath("subdir/file.txt", workDir);
      expect(result.valid).toBe(true);
      expect(result.resolved).toContain(workDir);
    });

    test("non-existent but safe path resolves correctly", () => {
      const result = validateFilePath("nonexistent/nested/file.txt", workDir);
      expect(result.valid).toBe(true);
    });

    test("accepts path within an allowedDirectories entry", () => {
      const extraDir = mkdtempSync(join(tmpdir(), "nyx-allowed-"));
      try {
        const result = validateFilePath(join(extraDir, "file.txt"), workDir, [extraDir]);
        expect(result.valid).toBe(true);
      } finally {
        rmSync(extraDir, { recursive: true });
      }
    });

    test("rejects sibling path that only shares an allowedDirectory prefix", () => {
      const allowedDir = mkdtempSync(join(tmpdir(), "nyx-allowed-base-"));
      const siblingDir = `${allowedDir}-escape`;
      mkdirSync(siblingDir);

      try {
        const result = validateFilePath(join(siblingDir, "file.txt"), workDir, [allowedDir]);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("outside allowed directories");
      } finally {
        rmSync(allowedDir, { recursive: true });
        rmSync(siblingDir, { recursive: true });
      }
    });

    test("rejects path outside workDir with empty allowedDirectories", () => {
      const otherDir = mkdtempSync(join(tmpdir(), "nyx-other-"));
      try {
        const result = validateFilePath(join(otherDir, "file.txt"), workDir, []);
        expect(result.valid).toBe(false);
      } finally {
        rmSync(otherDir, { recursive: true });
      }
    });
  });

  describe("symlinks", () => {
    test("rejects symlink pointing outside workDir", () => {
      const linkPath = join(workDir, "evil-link");
      try {
        symlinkSync("/tmp", linkPath);
        const result = validateFilePath("evil-link", workDir);
        expect(result.valid).toBe(false);
      } finally {
        try { rmSync(linkPath); } catch {}
      }
    });

    test("accepts symlink pointing inside workDir", () => {
      const targetDir = join(workDir, "real");
      const linkPath = join(workDir, "safe-link");
      try {
        mkdirSync(targetDir);
        symlinkSync(targetDir, linkPath);
        const result = validateFilePath("safe-link", workDir);
        expect(result.valid).toBe(true);
      } finally {
        try { rmSync(linkPath); } catch {}
        try { rmSync(targetDir, { recursive: true }); } catch {}
      }
    });
  });
});

// ---------------------------------------------------------------------------
// validateAllowedDirectory
// ---------------------------------------------------------------------------

describe("validateAllowedDirectory", () => {
  // Dirs that exist on macOS as real paths (not symlinks) and should be blocked
  const BLOCKED_REAL = ["/root", "/boot", "/sys", "/proc", "/usr/bin", "/usr/sbin", "/bin", "/sbin"];
  // /dev exists on macOS and /dev itself is not a symlink
  const BLOCKED_WITH_DEV = [...BLOCKED_REAL, "/dev", "/run"];

  describe("blocked system directories (exact match)", () => {
    for (const dir of BLOCKED_WITH_DEV) {
      test(`rejects ${dir}`, () => {
        expect(() => validateAllowedDirectory(dir)).toThrow(/Blocked system directory/);
      });
    }

    test("/etc is blocked on all platforms (macOS symlink bypass fixed)", () => {
      expect(() => validateAllowedDirectory("/etc")).toThrow(/Blocked system directory/);
    });
  });

  describe("subdirectories of blocked dirs", () => {
    test("rejects /proc/self", () => {
      // /proc doesn't exist on macOS → normalize falls back, /proc/self starts with /proc/
      expect(() => validateAllowedDirectory("/proc/self")).toThrow(/Blocked system directory/);
    });

    test("rejects /dev/null", () => {
      expect(() => validateAllowedDirectory("/dev/null")).toThrow(/Blocked system directory/);
    });

    test("rejects /usr/bin/env", () => {
      expect(() => validateAllowedDirectory("/usr/bin/env")).toThrow(/Blocked system directory/);
    });

    test("rejects /sys/kernel", () => {
      expect(() => validateAllowedDirectory("/sys/kernel")).toThrow(/Blocked system directory/);
    });
  });

  describe("null byte injection", () => {
    test("rejects path with null byte", () => {
      expect(() => validateAllowedDirectory("/home/user\0/project")).toThrow(/null byte/);
    });

    test("rejects /tmp\0/safe-looking", () => {
      expect(() => validateAllowedDirectory("/tmp\0/safe-looking")).toThrow(/null byte/);
    });
  });

  describe("valid directories", () => {
    test("accepts a temp directory", () => {
      const dir = mkdtempSync(join(tmpdir(), "nyx-allowed-"));
      try {
        const result = validateAllowedDirectory(dir);
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    test("accepts non-existent path under tmpdir (falls back to normalize)", () => {
      const dir = join(tmpdir(), "nyx-nonexistent-" + Date.now());
      const result = validateAllowedDirectory(dir);
      expect(result).toContain("nyx-nonexistent");
    });

    test("accepts a home-like path not in blocked list", () => {
      // /home/user/project is not in BLOCKED_DIRS
      expect(() => validateAllowedDirectory("/home/user/project")).not.toThrow();
    });

    test("returns normalized/resolved path string", () => {
      const dir = mkdtempSync(join(tmpdir(), "nyx-ret-"));
      try {
        const result = validateAllowedDirectory(dir);
        expect(typeof result).toBe("string");
      } finally {
        rmSync(dir, { recursive: true });
      }
    });
  });
});
