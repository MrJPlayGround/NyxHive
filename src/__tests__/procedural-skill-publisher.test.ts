import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProceduralSkillDraftStore } from "../memory/procedural-skills.js";
import { publishProceduralSkillDraft } from "../agents/procedural-skills.js";

describe("publishProceduralSkillDraft", () => {
  let skillsDir: string;

  beforeEach(() => {
    skillsDir = mkdtempSync(join(tmpdir(), "nyxhive-auto-skill-"));
  });

  afterEach(() => {
    rmSync(skillsDir, { recursive: true, force: true });
  });

  test("publishes a draft to an auto skill directory and marks it published", () => {
    const store = new ProceduralSkillDraftStore(new Database(":memory:"));
    const draft = store.create({
      sourceHash: "publish-hash-1",
      agentKey: "nyx",
      title: "Workflow: Stabilize cockpit reconnect path",
      summary: "Reconnect path with verification commands.",
      draftMarkdown: "# Workflow: Stabilize cockpit reconnect path\n\n## Candidate procedure\n1. Reproduce reconnect churn.\n2. Verify with `bun test`.\n",
    });

    const published = publishProceduralSkillDraft(store, draft.id, { skillsDir });
    const written = readFileSync(published.skillPath, "utf-8");

    expect(published.skillName).toBe("auto-stabilize-cockpit-reconnect-path");
    expect(written).toContain("Generated from NyxHive procedural skill draft");
    expect(written).toContain("name: auto-stabilize-cockpit-reconnect-path");
    expect(written).toContain("## Candidate procedure");
    expect(store.getById(draft.id)?.status).toBe("published");
    expect(store.getById(draft.id)?.published_skill_name).toBe(published.skillName);
    expect(store.getById(draft.id)?.published_skill_path).toBe(published.skillPath);
  });

  test("is idempotent for already-published drafts with an existing file", () => {
    const store = new ProceduralSkillDraftStore(new Database(":memory:"));
    const draft = store.create({
      sourceHash: "publish-hash-2",
      agentKey: "nyx",
      title: "Workflow: Stabilize cockpit reconnect path",
      summary: "Reconnect path with verification commands.",
      draftMarkdown: "# Workflow\n",
    });

    const first = publishProceduralSkillDraft(store, draft.id, { skillsDir });
    const second = publishProceduralSkillDraft(store, draft.id, { skillsDir });

    expect(second.skillName).toBe(first.skillName);
    expect(second.skillPath).toBe(first.skillPath);
  });

  test("creates a unique name when the preferred auto skill name already exists", () => {
    const store = new ProceduralSkillDraftStore(new Database(":memory:"));
    const firstDraft = store.create({
      sourceHash: "publish-hash-3",
      agentKey: "nyx",
      title: "Workflow: Fix relay callback identity",
      summary: "Relay callback hardening.",
      draftMarkdown: "# Relay callback identity\n",
    });
    const secondDraft = store.create({
      sourceHash: "publish-hash-4",
      agentKey: "nyx",
      title: "Workflow: Fix relay callback identity",
      summary: "Relay callback hardening.",
      draftMarkdown: "# Relay callback identity\n",
    });

    const first = publishProceduralSkillDraft(store, firstDraft.id, { skillsDir, skillName: "auto-relay-callback" });
    const second = publishProceduralSkillDraft(store, secondDraft.id, { skillsDir, skillName: "auto-relay-callback" });

    expect(first.skillName).toBe("auto-relay-callback");
    expect(second.skillName).toBe("auto-relay-callback-2");
  });
});


describe("publishProceduralSkillDraft path safety", () => {
  test("defaults generated procedural skills outside the curated skill root", () => {
    const generatedDir = mkdtempSync(join(tmpdir(), "nyxhive-generated-default-"));
    const previous = process.env.NYXHIVE_GENERATED_SKILLS_DIR;
    process.env.NYXHIVE_GENERATED_SKILLS_DIR = generatedDir;
    try {
      const store = new ProceduralSkillDraftStore(new Database(":memory:"));
      const draft = store.create({
        sourceHash: "publish-generated-default",
        agentKey: "nyx",
        title: "Workflow: Protect prompt cache",
        summary: "Keep generated skills outside curated runtime skills.",
        draftMarkdown: "# Protect prompt cache\n",
      });

      const published = publishProceduralSkillDraft(store, draft.id);

      expect(published.skillPath.startsWith(generatedDir)).toBe(true);
      expect(existsSync(published.skillPath)).toBe(true);
      expect(store.getById(draft.id)?.published_skill_path).toBe(published.skillPath);
    } finally {
      if (previous === undefined) delete process.env.NYXHIVE_GENERATED_SKILLS_DIR;
      else process.env.NYXHIVE_GENERATED_SKILLS_DIR = previous;
      rmSync(generatedDir, { recursive: true, force: true });
    }
  });

  test("checks curated skill name collisions before writing generated skills", () => {
    const curatedDir = mkdtempSync(join(tmpdir(), "nyxhive-curated-collision-"));
    const generatedDir = mkdtempSync(join(tmpdir(), "nyxhive-generated-collision-"));
    const previousCurated = process.env.NYXHIVE_SKILLS_DIR;
    const previousGenerated = process.env.NYXHIVE_GENERATED_SKILLS_DIR;
    process.env.NYXHIVE_SKILLS_DIR = curatedDir;
    process.env.NYXHIVE_GENERATED_SKILLS_DIR = generatedDir;
    try {
      mkdirSync(join(curatedDir, "auto-existing"), { recursive: true });
      const store = new ProceduralSkillDraftStore(new Database(":memory:"));
      const draft = store.create({
        sourceHash: "publish-collision",
        agentKey: "nyx",
        title: "Workflow: Existing",
        summary: "Collision should suffix.",
        draftMarkdown: "# Existing\n",
      });

      const published = publishProceduralSkillDraft(store, draft.id, { skillName: "auto-existing" });

      expect(published.skillName).toBe("auto-existing-2");
      expect(published.skillPath).toBe(join(generatedDir, "auto-existing-2", "SKILL.md"));
    } finally {
      if (previousCurated === undefined) delete process.env.NYXHIVE_SKILLS_DIR;
      else process.env.NYXHIVE_SKILLS_DIR = previousCurated;
      if (previousGenerated === undefined) delete process.env.NYXHIVE_GENERATED_SKILLS_DIR;
      else process.env.NYXHIVE_GENERATED_SKILLS_DIR = previousGenerated;
      rmSync(curatedDir, { recursive: true, force: true });
      rmSync(generatedDir, { recursive: true, force: true });
    }
  });

  test("can refine an already-published skill in place", () => {
    const localSkillsDir = mkdtempSync(join(tmpdir(), "nyxhive-refine-skill-"));
    try {
      const store = new ProceduralSkillDraftStore(new Database(":memory:"));
      const draft = store.create({
        sourceHash: "publish-refine",
        agentKey: "nyx",
        title: "Workflow: Refine prompt cache guard",
        summary: "Original summary.",
        draftMarkdown: "# Original\n",
      });

      const first = publishProceduralSkillDraft(store, draft.id, { skillsDir: localSkillsDir });
      store.refine(draft.id, {
        summary: "Refined summary.",
        draftMarkdown: "# Refined\n\nKeep the harness sharp.",
      });

      const refined = publishProceduralSkillDraft(store, draft.id, { skillsDir: localSkillsDir, refine: true });
      const written = readFileSync(refined.skillPath, "utf-8");

      expect(refined.skillName).toBe(first.skillName);
      expect(refined.skillPath).toBe(first.skillPath);
      expect(written).toContain("# Refined");
      expect(store.getById(draft.id)?.published_skill_path).toBe(first.skillPath);
    } finally {
      rmSync(localSkillsDir, { recursive: true, force: true });
    }
  });
});
