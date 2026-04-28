import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import type { AgentConfig } from "../types.js";
import {
  getSkillsDir,
  getGeneratedSkillsDir,
  listAvailableSkills,
  loadSkillContent,
  loadAgentSkills,
  resolveAgentSkills,
  generatePluginJson,
  auditSkills,
  exportSkillCatalog,
} from "../agents/skill-loader.js";
import { readFileSync, existsSync } from "fs";
import { ProceduralSkillDraftStore } from "../memory/procedural-skills.js";

// --- AgentConfig type tests ---

describe("AgentConfig skills field", () => {
  test("accepts optional skills array", () => {
    const config: AgentConfig = {
      name: "test-agent",
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      working_directory: "/tmp",
      skills: ["verify", "debug"],
    };
    expect(config.skills).toEqual(["verify", "debug"]);
  });

  test("allows omitting skills", () => {
    const config: AgentConfig = {
      name: "test-agent",
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      working_directory: "/tmp",
    };
    expect(config.skills).toBeUndefined();
  });
});

// --- skill-loader function tests ---

describe("getSkillsDir", () => {
  test("returns path ending in /skills", () => {
    const dir = getSkillsDir();
    expect(dir.endsWith("/skills")).toBe(true);
  });
});

describe("listAvailableSkills", () => {
  test("returns core repo skills", () => {
    const skills = listAvailableSkills();
    expect(skills).toContain("verify");
    expect(skills).toContain("debug");
    expect(skills).toContain("codex-harness");
    expect(skills).toContain("security-review");
    expect(skills).toContain("search-first");
  });
});

describe("loadSkillContent", () => {
  test("rejects traversal-shaped skill names", () => {
    expect(loadSkillContent("../verify")).toBeNull();
    expect(loadSkillContent("verify/../../debug")).toBeNull();
  });

  test("reads verify SKILL.md content", () => {
    const content = loadSkillContent("verify");
    expect(content).not.toBeNull();
    expect(content).toContain("Verification Before Completion");
  });

  test("returns null for nonexistent skill", () => {
    const content = loadSkillContent("nonexistent-skill-xyz");
    expect(content).toBeNull();
  });

  test("works with multiple skills", () => {
    const verify = loadSkillContent("verify");
    const debug = loadSkillContent("debug");
    const codexHarness = loadSkillContent("codex-harness");
    expect(verify).not.toBeNull();
    expect(debug).not.toBeNull();
    expect(codexHarness).not.toBeNull();
    expect(verify).toContain("bun run typecheck");
    expect(debug).toContain("Systematic Debugging");
    expect(codexHarness).toContain("NyxHive runs on Codex");
  });
});

describe("loadAgentSkills", () => {
  test("loads all skills when no filter", () => {
    const result = loadAgentSkills();
    expect(result).toContain("--- SKILL: verify ---");
    expect(result).toContain("--- SKILL: debug ---");
  });

  test("loads only filtered skills", () => {
    const result = loadAgentSkills(["verify"]);
    expect(result).toContain("--- SKILL: verify ---");
    expect(result).not.toContain("--- SKILL: debug ---");
  });

  test("loads Codex workflow skills by filter", () => {
    const result = loadAgentSkills(["codex-harness", "security-review"]);
    expect(result).toContain("--- SKILL: codex-harness ---");
    expect(result).toContain("--- SKILL: security-review ---");
    expect(result).not.toContain("--- SKILL: debug ---");
  });

  test("returns empty string for empty filter", () => {
    const result = loadAgentSkills([]);
    expect(result).toBe("");
  });

  test("does not load generated auto skills by default but can load them explicitly", () => {
    const generatedRoot = mkdtempSync(join(tmpdir(), "nyxhive-generated-skills-"));
    const previous = process.env.NYXHIVE_GENERATED_SKILLS_DIR;
    process.env.NYXHIVE_GENERATED_SKILLS_DIR = generatedRoot;
    try {
      const skillDir = join(generatedRoot, "auto-focused-runbook");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "# Generated runbook\n\nDo not load by default.\n");

      expect(getGeneratedSkillsDir()).toBe(generatedRoot);
      expect(listAvailableSkills()).not.toContain("auto-focused-runbook");
      expect(loadAgentSkills()).not.toContain("Generated runbook");
      expect(loadAgentSkills(["auto-focused-runbook"])).toContain("Generated runbook");
    } finally {
      if (previous === undefined) delete process.env.NYXHIVE_GENERATED_SKILLS_DIR;
      else process.env.NYXHIVE_GENERATED_SKILLS_DIR = previous;
      rmSync(generatedRoot, { recursive: true, force: true });
    }
  });

  test("loads only relevant published auto skills for the task", () => {
    const store = new ProceduralSkillDraftStore(new Database(":memory:"));
    const relevant = store.create({
      sourceHash: "hash-relevant",
      agentKey: "nyx",
      title: "Workflow: Fix fleet reconnect churn",
      summary: "Repair the gateway websocket reconnect path and verify it stays green.",
      draftMarkdown: "Reconnect churn in src/gateway/src/hooks/useFleetConnections.ts\nVerify with bun test and bun run gateway:build.",
    });
    const irrelevant = store.create({
      sourceHash: "hash-irrelevant",
      agentKey: "nyx",
      title: "Workflow: Update Discord onboarding copy",
      summary: "Tighten channel copy for invites.",
      draftMarkdown: "Touch docs/discord.md and onboarding copy only.",
    });
    store.publish(relevant.id, "auto-fleet-reconnect");
    store.publish(irrelevant.id, "auto-discord-copy");

    const result = loadAgentSkills({
      agentKey: "nyx",
      taskMessage: "Fix reconnect churn in src/gateway/src/hooks/useFleetConnections.ts and verify the gateway websocket path.",
      proceduralSkills: store,
    });

    expect(result).toContain("--- AUTO SKILL: auto-fleet-reconnect ---");
    expect(result).not.toContain("--- AUTO SKILL: auto-discord-copy ---");
    expect(store.getById(relevant.id)?.usage_count).toBe(1);
    expect(store.getById(irrelevant.id)?.usage_count).toBe(0);
  });

  test("loads refined published procedural skill content from its published path", () => {
    const generatedRoot = mkdtempSync(join(tmpdir(), "nyxhive-refined-auto-skill-"));
    const previous = process.env.NYXHIVE_GENERATED_SKILLS_DIR;
    process.env.NYXHIVE_GENERATED_SKILLS_DIR = generatedRoot;
    try {
      const store = new ProceduralSkillDraftStore(new Database(":memory:"));
      const skillDir = join(generatedRoot, "auto-relay-refined");
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, "SKILL.md");
      writeFileSync(skillPath, "# Refined relay skill\n\nUse the reviewed refinement, not stale draft text.\n");
      const draft = store.create({
        sourceHash: "hash-refined-path",
        agentKey: "nyx",
        title: "Workflow: relay callback identity",
        summary: "Verify relay callback identity and nonce dedup.",
        draftMarkdown: "# Stale draft text\n",
      });
      store.publish(draft.id, "auto-relay-refined", skillPath);

      const result = loadAgentSkills({
        agentKey: "nyx",
        taskMessage: "Verify relay callback identity and nonce dedup.",
        proceduralSkills: store,
        maxAutoSkills: 1,
      });

      expect(result).toContain("# Refined relay skill");
      expect(result).not.toContain("# Stale draft text");
    } finally {
      if (previous === undefined) delete process.env.NYXHIVE_GENERATED_SKILLS_DIR;
      else process.env.NYXHIVE_GENERATED_SKILLS_DIR = previous;
      rmSync(generatedRoot, { recursive: true, force: true });
    }
  });

  test("returns selected auto-skill metadata for downstream outcome tracking", () => {
    const store = new ProceduralSkillDraftStore(new Database(":memory:"));
    const draft = store.create({
      sourceHash: "hash-selected",
      agentKey: "nyx",
      conversationId: "conv-7",
      title: "Workflow: stabilize relay callback identity",
      summary: "Audit relay nonce dedup and sender preservation.",
      draftMarkdown: "Inspect src/server/routes/relay.ts and verify nonce dedup.",
    });
    store.publish(draft.id, "auto-relay-success");

    const resolved = resolveAgentSkills({
      agentKey: "nyx",
      taskMessage: "Audit relay callback identity and verify nonce dedup in src/server/routes/relay.ts.",
      conversationId: "conv-7",
      proceduralSkills: store,
      maxAutoSkills: 1,
    });

    expect(resolved.content).toContain("--- AUTO SKILL: auto-relay-success ---");
    expect(resolved.selectedAutoSkills.map((entry) => entry.id)).toEqual([draft.id]);
    expect(store.getById(draft.id)?.usage_count).toBe(1);
  });

  test("prefers exact repo path matches over generic overlap when maxAutoSkills is limited", () => {
    const store = new ProceduralSkillDraftStore(new Database(":memory:"));
    const pathExact = store.create({
      sourceHash: "hash-path-exact",
      agentKey: "nyx",
      title: "Workflow: repair fleet websocket reconnect path",
      summary: "Fix src/gateway/src/hooks/useFleetConnections.ts and verify reconnect stability.",
      draftMarkdown: "Touch src/gateway/src/hooks/useFleetConnections.ts and gateway websocket reconnect handling.",
    });
    const generic = store.create({
      sourceHash: "hash-path-generic",
      agentKey: "nyx",
      title: "Workflow: generic verification checklist",
      summary: "Fix regressions and verify tests/build.",
      draftMarkdown: "Run bun test and bun run gateway:build after a code fix.",
    });
    store.publish(pathExact.id, "auto-fleet-path");
    store.publish(generic.id, "auto-generic-verify");

    const result = loadAgentSkills({
      agentKey: "nyx",
      taskMessage: "Fix reconnect churn in src/gateway/src/hooks/useFleetConnections.ts and confirm the websocket path is stable.",
      proceduralSkills: store,
      maxAutoSkills: 1,
    });

    expect(result).toContain("--- AUTO SKILL: auto-fleet-path ---");
    expect(result).not.toContain("--- AUTO SKILL: auto-generic-verify ---");
  });

  test("prefers published skills from the active conversation when relevance is otherwise tied", () => {
    const store = new ProceduralSkillDraftStore(new Database(":memory:"));
    const sameConversation = store.create({
      sourceHash: "hash-same-conversation",
      agentKey: "nyx",
      conversationId: "conv-123",
      title: "Workflow: audit relay callback identity",
      summary: "Verify nonce dedup and sender preservation in relay callbacks.",
      draftMarkdown: "Inspect src/server/routes/relay.ts and src/federation/relay.ts for callback identity regressions.",
    });
    const otherConversation = store.create({
      sourceHash: "hash-other-conversation",
      agentKey: "nyx",
      conversationId: "conv-999",
      title: "Workflow: audit relay callback identity",
      summary: "Verify nonce dedup and sender preservation in relay callbacks.",
      draftMarkdown: "Inspect src/server/routes/relay.ts and src/federation/relay.ts for callback identity regressions.",
    });
    store.publish(sameConversation.id, "auto-relay-same");
    store.publish(otherConversation.id, "auto-relay-other");

    const result = loadAgentSkills({
      agentKey: "nyx",
      taskMessage: "Audit relay callback identity and verify nonce dedup in the relay routes.",
      conversationId: "conv-123",
      proceduralSkills: store,
      maxAutoSkills: 1,
    });

    expect(result).toContain("--- AUTO SKILL: auto-relay-same ---");
    expect(result).not.toContain("--- AUTO SKILL: auto-relay-other ---");
  });

  test("penalizes weak audited skills even when generic token overlap is strong", () => {
    const store = new ProceduralSkillDraftStore(new Database(":memory:"));
    const weak = store.create({
      sourceHash: "hash-weak-audit",
      agentKey: "nyx",
      title: "Workflow: verify build and test after every fix",
      summary: "Generic verification loop for any task.",
      draftMarkdown: "Run bun test and bun run gateway:build after every fix.",
    });
    const healthy = store.create({
      sourceHash: "hash-healthy-precise",
      agentKey: "nyx",
      title: "Workflow: repair relay callback identity regressions",
      summary: "Target relay callback identity and nonce dedup in src/server/routes/relay.ts.",
      draftMarkdown: "Inspect src/server/routes/relay.ts and src/federation/relay.ts, then verify nonce dedup.",
    });
    store.publish(weak.id, "auto-generic-verify");
    store.publish(healthy.id, "auto-relay-precise");
    store.recordUsage(weak.id);
    store.recordUsage(weak.id);
    store.recordUsage(weak.id);
    store.recordUsage(healthy.id);
    store.recordSuccess(healthy.id);

    const result = loadAgentSkills({
      agentKey: "nyx",
      taskMessage: "Repair relay callback identity in src/server/routes/relay.ts and verify nonce dedup.",
      proceduralSkills: store,
      maxAutoSkills: 1,
    });

    expect(result).toContain("--- AUTO SKILL: auto-relay-precise ---");
    expect(result).not.toContain("--- AUTO SKILL: auto-generic-verify ---");
  });
});

describe("generatePluginJson", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-skill-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates .claude-plugin/plugin.json with absolute skills path", () => {
    generatePluginJson(tmpDir);
    const pluginJsonPath = join(tmpDir, ".claude-plugin", "plugin.json");
    expect(existsSync(pluginJsonPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(pluginJsonPath, "utf-8"));
    expect(parsed.skillsPath).toBe(getSkillsDir());
    expect(parsed.skillsPath.startsWith("/")).toBe(true);
    expect(parsed.nyxhiveSkills.generatedSkillsPath).toBe(getGeneratedSkillsDir());
    expect(parsed.nyxhiveSkills.roots.some((root: { kind: string; path: string }) => root.kind === "generated")).toBe(true);
  });
});

describe("skill portability audit", () => {
  test("audits SKILL.md frontmatter and exports a portable catalog", () => {
    const root = mkdtempSync(join(tmpdir(), "nyxhive-skill-audit-"));
    const previous = process.env.NYXHIVE_SKILLS_DIR;
    process.env.NYXHIVE_SKILLS_DIR = root;
    try {
      mkdirSync(join(root, "good-skill"), { recursive: true });
      writeFileSync(join(root, "good-skill", "SKILL.md"), [
        "---",
        "name: good-skill",
        "description: Use when doing focused good work.",
        "---",
        "",
        "# Good Skill",
        "",
        "Do the thing.",
      ].join("\n"));

      mkdirSync(join(root, "bad-skill"), { recursive: true });
      writeFileSync(join(root, "bad-skill", "SKILL.md"), [
        "---",
        "name: wrong-name",
        "---",
        "",
        "# Bad Skill",
      ].join("\n"));

      const report = auditSkills();

      expect(report.ok).toBe(false);
      expect(report.skills).toHaveLength(2);
      expect(report.skills.find((skill) => skill.name === "good-skill")?.status).toBe("pass");
      const bad = report.skills.find((skill) => skill.name === "bad-skill");
      expect(bad?.status).toBe("fail");
      expect(bad?.issues).toContain("frontmatter.name must match directory name");
      expect(bad?.issues).toContain("frontmatter.description is required");

      const catalog = exportSkillCatalog(report);
      expect(catalog.skills).toEqual([
        {
          name: "good-skill",
          description: "Use when doing focused good work.",
          path: join(root, "good-skill", "SKILL.md"),
          rootKind: "curated",
          portable: true,
        },
        {
          name: "bad-skill",
          description: "",
          path: join(root, "bad-skill", "SKILL.md"),
          rootKind: "curated",
          portable: false,
        },
      ]);
    } finally {
      if (previous === undefined) delete process.env.NYXHIVE_SKILLS_DIR;
      else process.env.NYXHIVE_SKILLS_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
