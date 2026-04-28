import { describe, it, expect } from "bun:test";
import { classifyAutonomy } from "../proposals/autonomy.js";
import type { ProposalCategory, ProposalEffort } from "../proposals/store.js";

describe("classifyAutonomy", () => {
  // ─── Category-based classification ───────────────────────────────

  describe("approval-required categories", () => {
    it("requires approval for features regardless of effort or files", () => {
      expect(classifyAutonomy("feature", "small", [])).toBe("requires_approval");
      expect(classifyAutonomy("feature", "small", ["src/utils.ts"])).toBe("requires_approval");
    });

    it("requires approval for improvements regardless of effort or files", () => {
      expect(classifyAutonomy("improvement", "small", [])).toBe("requires_approval");
      expect(classifyAutonomy("improvement", "small", ["src/utils.ts"])).toBe("requires_approval");
    });

    it("requires approval for new_instance regardless of effort or files", () => {
      expect(classifyAutonomy("new_instance", "small", [])).toBe("requires_approval");
      expect(classifyAutonomy("new_instance", "medium", [])).toBe("requires_approval");
      expect(classifyAutonomy("new_instance", "large", [])).toBe("requires_approval");
    });
  });

  describe("auto-eligible categories", () => {
    it("auto-approves maintenance with small effort and safe files", () => {
      expect(classifyAutonomy("maintenance", "small", [])).toBe("auto");
      expect(classifyAutonomy("maintenance", "small", ["src/utils.ts"])).toBe("auto");
      expect(classifyAutonomy("maintenance", "small", ["src/queue/processor.ts", "src/types.ts"])).toBe("auto");
    });

    it("auto-approves bugfix with small effort and safe files", () => {
      expect(classifyAutonomy("bugfix", "small", [])).toBe("auto");
      expect(classifyAutonomy("bugfix", "small", ["src/queue/processor.ts"])).toBe("auto");
    });
  });

  // ─── Effort thresholds ──────────────────────────────────────────

  describe("effort thresholds", () => {
    it("requires approval for medium effort even on auto-eligible categories", () => {
      expect(classifyAutonomy("maintenance", "medium", [])).toBe("requires_approval");
      expect(classifyAutonomy("bugfix", "medium", [])).toBe("requires_approval");
    });

    it("requires approval for large effort even on auto-eligible categories", () => {
      expect(classifyAutonomy("maintenance", "large", [])).toBe("requires_approval");
      expect(classifyAutonomy("bugfix", "large", [])).toBe("requires_approval");
    });
  });

  // ─── Protected path detection ───────────────────────────────────

  describe("protected paths", () => {
    const protectedFiles = [
      { desc: "auth directory", path: "src/auth/session.ts" },
      { desc: "auth in path segment", path: "src/Auth/provider.ts" },
      { desc: "security module", path: "src/security/vault.ts" },
      { desc: "rbac file", path: "src/auth/rbac.ts" },
      { desc: "middleware", path: "src/server/middleware.ts" },
      { desc: "config.toml", path: "config.toml" },
      { desc: "nested config.toml", path: "instances/dev/config.toml" },
      { desc: "schema.sql", path: "data/schema.sql" },
      { desc: "migration file", path: "src/migrations/001.ts" },
      { desc: ".env file", path: ".env" },
      { desc: ".env.local", path: ".env.local" },
      { desc: "credentials file", path: "src/credentials/store.ts" },
      { desc: "keychain module", path: "src/keychain/access.ts" },
      { desc: "package.json", path: "package.json" },
      { desc: "bun.lock", path: "bun.lock" },
      { desc: "secret in path", path: "src/secret/keys.ts" },
      { desc: "token file", path: "src/lib/tokenStore.ts" },
      { desc: "session file", path: "src/lib/sessionManager.ts" },
      { desc: "permission file", path: "src/permissionCheck.ts" },
      { desc: "rls policy", path: "supabase/rls_policies.sql" },
      { desc: "supabase dir", path: "supabase/migrations/001.sql" },
    ];

    for (const { desc, path } of protectedFiles) {
      it(`requires approval when touching ${desc} (${path})`, () => {
        expect(classifyAutonomy("maintenance", "small", [path])).toBe("requires_approval");
        expect(classifyAutonomy("bugfix", "small", [path])).toBe("requires_approval");
      });
    }

    it("requires approval if ANY file in the list is protected", () => {
      expect(
        classifyAutonomy("maintenance", "small", [
          "src/utils.ts",
          "src/queue/processor.ts",
          "src/auth/session.ts",
        ]),
      ).toBe("requires_approval");
    });

    it("auto-approves when no files are protected", () => {
      expect(
        classifyAutonomy("bugfix", "small", [
          "src/utils.ts",
          "src/queue/processor.ts",
          "src/proposals/store.ts",
        ]),
      ).toBe("auto");
    });
  });

  // ─── camelCase/PascalCase regression (the actual bug) ───────────

  describe("camelCase/PascalCase file matching (regression)", () => {
    it("catches AuthContext.tsx", () => {
      expect(classifyAutonomy("maintenance", "small", ["src/contexts/AuthContext.tsx"])).toBe("requires_approval");
    });

    it("catches authPersistence.ts", () => {
      expect(classifyAutonomy("maintenance", "small", ["src/lib/authPersistence.ts"])).toBe("requires_approval");
    });

    it("catches AuthPage.tsx", () => {
      expect(classifyAutonomy("bugfix", "small", ["src/components/AuthPage.tsx"])).toBe("requires_approval");
    });

    it("catches securityAudit.ts", () => {
      expect(classifyAutonomy("maintenance", "small", ["src/securityAudit.ts"])).toBe("requires_approval");
    });

    it("catches middlewareChain.ts", () => {
      expect(classifyAutonomy("bugfix", "small", ["src/middlewareChain.ts"])).toBe("requires_approval");
    });

    it("catches tokenRefresh.ts", () => {
      expect(classifyAutonomy("maintenance", "small", ["src/lib/tokenRefresh.ts"])).toBe("requires_approval");
    });

    it("catches sessionStorage.ts", () => {
      expect(classifyAutonomy("bugfix", "small", ["src/sessionStorage.ts"])).toBe("requires_approval");
    });
  });

  // ─── Case insensitivity ─────────────────────────────────────────

  describe("case insensitivity on protected paths", () => {
    it("catches AUTH in any casing", () => {
      expect(classifyAutonomy("maintenance", "small", ["src/AUTH/login.ts"])).toBe("requires_approval");
      expect(classifyAutonomy("maintenance", "small", ["src/Auth/login.ts"])).toBe("requires_approval");
    });

    it("catches SECURITY in any casing", () => {
      expect(classifyAutonomy("maintenance", "small", ["src/SECURITY/vault.ts"])).toBe("requires_approval");
    });

    it("catches Config.Toml in any casing", () => {
      expect(classifyAutonomy("maintenance", "small", ["Config.TOML"])).toBe("requires_approval");
    });
  });

  // ─── Edge cases ─────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles empty files array", () => {
      expect(classifyAutonomy("maintenance", "small", [])).toBe("auto");
      expect(classifyAutonomy("feature", "small", [])).toBe("requires_approval");
    });

    it("handles empty string in files array", () => {
      expect(classifyAutonomy("maintenance", "small", [""])).toBe("auto");
    });

    it("defaults to requires_approval for unknown categories", () => {
      expect(classifyAutonomy("unknown" as ProposalCategory, "small", [])).toBe("requires_approval");
    });

    it("defaults to requires_approval for unknown effort levels", () => {
      expect(classifyAutonomy("maintenance", "unknown" as ProposalEffort, [])).toBe("requires_approval");
    });
  });

  // ─── Combination matrix ─────────────────────────────────────────

  describe("combination matrix", () => {
    const categories: ProposalCategory[] = ["maintenance", "bugfix", "feature", "improvement", "new_instance"];
    const efforts: ProposalEffort[] = ["small", "medium", "large"];
    const filesSafe = ["src/utils.ts"];
    const filesProtected = ["src/auth/session.ts"];

    for (const cat of categories) {
      for (const effort of efforts) {
        for (const [label, files] of [
          ["safe", filesSafe],
          ["protected", filesProtected],
        ] as const) {
          const shouldAuto =
            (cat === "maintenance" || cat === "bugfix") && effort === "small" && label === "safe";

          it(`${cat} + ${effort} + ${label} files => ${shouldAuto ? "auto" : "requires_approval"}`, () => {
            expect(classifyAutonomy(cat, effort, [...files])).toBe(
              shouldAuto ? "auto" : "requires_approval",
            );
          });
        }
      }
    }
  });
});
