import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CompiledKnowledgeStore } from "../memory/compiled-knowledge.js";
import { ProceduralSkillDraftStore } from "../memory/procedural-skills.js";
import {
  buildProceduralSkillDraftInput,
  recordProceduralSkillDraftIfQualified,
  shouldCreateProceduralSkillDraft,
} from "../queue/procedural-skill-extraction.js";

function createStore() {
  return new ProceduralSkillDraftStore(new Database(":memory:"));
}

describe("procedural skill extraction", () => {
  const substantialInput = {
    agentKey: "nyx",
    channel: "gateway",
    sender: "jay",
    conversationId: "gateway:thread-1",
    traceId: "trace-1",
    userMessage: "Turn the cockpit reconnect debugging flow into a repeatable decision skill: when auth changes happen, decide whether reconnect churn is a real regression or expected rotation before changing src/gateway/src/hooks/useFleetConnections.ts.",
    assistantResponse: [
      "1. First check whether the reconnects line up with an auth token rotation before deciding it is a regression.",
      "2. Updated src/gateway/src/hooks/useFleetConnections.ts to treat per-instance credentials as a valid connection target before global credentials.",
      "3. Added a regression test in src/gateway/src/hooks/useFleetConnections.test.ts for the reconnect path and a smoke check around ws://localhost:3777/ws.",
      "4. Verified with `bun test src/gateway/src/hooks/useFleetConnections.test.ts`, `bun run typecheck`, and `bun run gateway:build`.",
      "5. If reconnects only happen during expected credential replacement, report expected rotation; otherwise escalate as a gateway regression.",
    ].join("\n"),
  };

  test("qualifies substantial engineering workflows", () => {
    expect(shouldCreateProceduralSkillDraft(substantialInput)).toBe(true);

    const draft = buildProceduralSkillDraftInput(substantialInput);
    expect(draft).not.toBeNull();
    expect(draft?.title).toContain("Workflow:");
    expect(draft?.summary).toContain("First check whether the reconnects");
    expect(draft?.draftMarkdown).toContain("## Candidate procedure");
    expect(draft?.draftMarkdown).toContain("## Promotion checklist");
    expect(draft?.draftMarkdown).toContain("## Decision boundary");
    expect(draft?.draftMarkdown).toContain("## When not to use");
    expect(draft?.draftMarkdown).toContain("## Extraction evidence");
    expect(draft?.draftMarkdown).toContain("Trigger signals:");
    expect(draft?.draftMarkdown).toContain("Source trace: trace-1");
    expect(draft?.draftMarkdown).toContain("useFleetConnections.ts");
    expect(draft?.draftMarkdown).toContain("bun run typecheck");
  });

  test("skips short conversational turns", () => {
    expect(shouldCreateProceduralSkillDraft({
      agentKey: "nyx",
      channel: "gateway",
      sender: "jay",
      conversationId: "gateway:thread-2",
      userMessage: "status?",
      assistantResponse: "All good.",
    })).toBe(false);
  });

  test("skips one-off task procedures without a decision boundary", () => {
    expect(shouldCreateProceduralSkillDraft({
      ...substantialInput,
      userMessage: "Fix the cockpit reconnect churn in src/gateway/src/hooks/useFleetConnections.ts and verify the gateway websocket reconnect path stays stable after auth changes.",
      assistantResponse: [
        "1. Reproduced the reconnect churn by switching auth state while the gateway websocket was open.",
        "2. Updated src/gateway/src/hooks/useFleetConnections.ts to prefer per-instance credentials.",
        "3. Added a regression test in src/gateway/src/hooks/useFleetConnections.test.ts.",
        "4. Verified with `bun test src/gateway/src/hooks/useFleetConnections.test.ts`, `bun run typecheck`, and `bun run gateway:build`.",
      ].join("\n"),
    })).toBe(false);
  });

  test("skips root-cause notes that were not implemented or verified", () => {
    expect(shouldCreateProceduralSkillDraft({
      ...substantialInput,
      userMessage: "Workflow: why doesnt it appear on scheduled automations? Decide where the scheduled automation surface should come from before guessing.",
      assistantResponse: [
        "1. The UI is telling us exactly where it expects this to come from: nyxhive.toml.",
        "2. I checked src/scheduler/update.ts and config/nyxhive.toml and found scheduler tasks are not seeded.",
        "3. To make it appear, we would need to enable scheduler tasks and restart the instance.",
        "4. No code changes made yet; this was root-cause investigation only.",
      ].join("\n"),
    })).toBe(false);
  });

  test("skips design-only skill-shaped responses", () => {
    expect(shouldCreateProceduralSkillDraft({
      ...substantialInput,
      userMessage: "Workflow: Design an hourly self-improvement system to help improve our software. Make it a reusable decision skill.",
      assistantResponse: [
        "1. When deciding whether to run the hourly loop, first check tests, queue health, and recent failures.",
        "2. If the system is unstable, skip implementation and write a proposal instead.",
        "3. The design should include verification gates and a rollback path.",
        "4. This is a plan only and has not been implemented or verified.",
      ].join("\n"),
    })).toBe(false);
  });

  test("skips simple operational replays even when commands succeeded", () => {
    expect(shouldCreateProceduralSkillDraft({
      ...substantialInput,
      userMessage: "Pull master on Air and restart Nyx/Vortex so the gateway is fresh.",
      assistantResponse: [
        "1. Ran `git pull --ff-only origin master` on Air.",
        "2. Ran `bun run gateway:build` and restarted NyxAI and NyxLabs.",
        "3. Verified health endpoints responded and both PIDs changed.",
        "4. Done.",
      ].join("\n"),
    })).toBe(false);
  });

  test("skips scheduler and proposal-originated messages", () => {
    expect(shouldCreateProceduralSkillDraft({
      ...substantialInput,
      sender: "scheduler:heartbeat",
      conversationId: "system:heartbeat",
    })).toBe(false);

    expect(shouldCreateProceduralSkillDraft({
      ...substantialInput,
      sender: "proposal-exec:proposal-123",
      conversationId: "proposal:123",
    })).toBe(false);
  });

  test("records and dedupes qualified drafts", () => {
    const store = createStore();

    const first = recordProceduralSkillDraftIfQualified(store, substantialInput);
    const second = recordProceduralSkillDraftIfQualified(store, substantialInput);

    expect(first).not.toBeNull();
    expect(second?.id).toBe(first?.id);
    expect(store.list().length).toBe(1);
  });

  test("promotes qualified drafts into compiled workflow knowledge", () => {
    const store = createStore();
    const compiledKnowledge = new CompiledKnowledgeStore(new Database(":memory:"));

    const draft = recordProceduralSkillDraftIfQualified(store, substantialInput, {
      compiledKnowledge,
    });

    expect(draft).not.toBeNull();
    const page = compiledKnowledge.getBySourceKey(`procedural-skill:${draft?.source_hash}`);
    expect(page?.category).toBe("workflow");
    expect(page?.content).toContain("Source: procedural skill draft");
    expect(page?.content).toContain("useFleetConnections.ts");
  });
});
