import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationManager, type ConversationManagerContext } from "../queue/conversation.js";

function makeCtx(overrides: Partial<ConversationManagerContext> = {}): ConversationManagerContext {
  return {
    memory: undefined,
    router: undefined,
    nyxhiveConfig: undefined,
    graphMemory: undefined,
    getAgent: () => undefined,
    ...overrides,
  };
}

function makeMemory() {
  const conversations = new Map<string, { channel: string; senderId: string }>();
  const messages = new Map<string, Array<{ role: string; content: string; model?: string | null; provider?: string | null }>>();
  const summaries = new Map<string, string>();

  return {
    ensureConversation(convId: string, channel: string, senderId: string) {
      conversations.set(convId, { channel, senderId });
    },
    saveMessage(convId: string, role: string, content: string, model: string | null, provider: string | null, _ti: number, _to: number, _cost: number) {
      if (!messages.has(convId)) messages.set(convId, []);
      messages.get(convId)!.push({ role, content, model, provider });
    },
    getMessages(convId: string, limit: number) {
      const msgs = messages.get(convId) ?? [];
      return msgs.slice(-limit);
    },
    getMessageCount(convId: string) {
      return (messages.get(convId) ?? []).length;
    },
    getConversationSummary(convId: string) {
      return summaries.get(convId) ?? null;
    },
    saveConversationSummary(convId: string, summary: string) {
      summaries.set(convId, summary);
    },
    trimToRecent(convId: string, keep: number) {
      const msgs = messages.get(convId) ?? [];
      const removed = Math.max(0, msgs.length - keep);
      messages.set(convId, msgs.slice(-keep));
      return removed;
    },
    trimOldMessages(convId: string, keepRecent: number) {
      const msgs = messages.get(convId) ?? [];
      messages.set(convId, msgs.slice(-keepRecent));
    },
    getLastMessages(convId: string, count: number) {
      const msgs = messages.get(convId) ?? [];
      return msgs.slice(-count);
    },
    deleteLastMessages(convId: string, count: number) {
      const msgs = messages.get(convId) ?? [];
      const toRemove = Math.min(count, msgs.length);
      messages.set(convId, msgs.slice(0, msgs.length - toRemove));
      return toRemove;
    },
    clearConversation(convId: string) {
      messages.delete(convId);
      summaries.delete(convId);
    },
    // Expose internals for assertions
    _messages: messages,
    _conversations: conversations,
    _summaries: summaries,
  };
}

describe("ConversationManager", () => {
  let mgr: ConversationManager;
  const tempDirs: string[] = [];

  beforeEach(() => {
    mgr = new ConversationManager();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeInstanceSoul(agentKey: string, memory: string): string {
    const dir = mkdtempSync(join(tmpdir(), "conversation-manager-instance-soul-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, agentKey), { recursive: true });
    writeFileSync(
      join(dir, agentKey, "identity.md"),
      `---\nname: ${agentKey}\nrole: lead\n---\n# ${agentKey}\n\nInstance-local agent.`,
    );
    writeFileSync(join(dir, agentKey, "memory.md"), memory);
    return dir;
  }

  describe("conversationId", () => {
    test("builds id from channel and senderId", () => {
      expect(mgr.conversationId("telegram", "user123")).toBe("telegram:user123");
    });

    test("falls back to sender when senderId undefined", () => {
      expect(mgr.conversationId("discord", undefined, "jay")).toBe("discord:jay");
    });

    test("uses explicit local fallback for single-user channels", () => {
      expect(mgr.conversationId("api")).toBe("api:local");
    });

    test("rejects missing identity on multi-user channels", () => {
      expect(() => mgr.conversationId("slack")).toThrow("Missing sender identity");
    });

    test("prefers senderId over sender", () => {
      expect(mgr.conversationId("api", "id123", "name456")).toBe("api:id123");
    });

    test("treats gateway thread ids as distinct conversation identities", () => {
      const threadA = mgr.conversationId("gateway", "thread-a", "NyxHive Gateway");
      const threadB = mgr.conversationId("gateway", "thread-b", "NyxHive Gateway");
      expect(threadA).toBe("gateway:thread-a");
      expect(threadB).toBe("gateway:thread-b");
      expect(threadA).not.toBe(threadB);
    });
  });

  describe("sanitizeResponse", () => {
    test("strips [TOOL_CALL] blocks", () => {
      const input = 'Answer.\n[TOOL_CALL]\n{"name": "read_file"}\n[/TOOL_CALL]\nDone.';
      expect(mgr.sanitizeResponse(input)).toBe("Answer.\n\nDone.");
    });

    test("strips multiple [TOOL_CALL] blocks", () => {
      const input = "A[TOOL_CALL]x[/TOOL_CALL]B[TOOL_CALL]y[/TOOL_CALL]C";
      expect(mgr.sanitizeResponse(input)).toBe("ABC");
    });

    test("strips XML tool_call blocks", () => {
      const input = "Answer.\n<tool_call>fake</tool_call>\nEnd.";
      expect(mgr.sanitizeResponse(input)).toBe("Answer.\n\nEnd.");
    });

    test("strips minimax tool_call blocks", () => {
      const input = "Response.\n<minimax:tool_call>data</minimax:tool_call>\nMore.";
      expect(mgr.sanitizeResponse(input)).toBe("Response.\n\nMore.");
    });

    test("strips invoke blocks", () => {
      const input = "Before.<invoke name='test'>data</invoke>After.";
      expect(mgr.sanitizeResponse(input)).toBe("Before.After.");
    });

    test("collapses excessive newlines", () => {
      const input = "Line 1\n\n\n\n\nLine 2";
      expect(mgr.sanitizeResponse(input)).toBe("Line 1\n\nLine 2");
    });

    test("trims whitespace", () => {
      expect(mgr.sanitizeResponse("  hello  ")).toBe("hello");
    });

    test("handles empty string", () => {
      expect(mgr.sanitizeResponse("")).toBe("");
    });

    test("strips workflow progress preamble from assistant closeouts", () => {
      const input = [
        "Using `superpowers:using-superpowers`, `test-driven-development`, and `verification-before-completion`. I’ll add restart provenance as a small audited path.",
        "The narrow tests are green. Verification is clean, so I’m committing this as the restart provenance change and pushing it.",
        "Added restart provenance.",
        "",
        "What changed:",
        "- `restart-instance.sh` writes provenance before restarting.",
        "",
        "Evidence:",
        "- Full suite passed.",
      ].join("");

      expect(mgr.sanitizeResponse(input)).toBe([
        "Added restart provenance.",
        "",
        "What changed:",
        "- `restart-instance.sh` writes provenance before restarting.",
        "",
        "Evidence:",
        "- Full suite passed.",
      ].join("\n"));
    });

    test("drops pure workflow progress diary entries", () => {
      const input = "Using superpowers:using-superpowers. I’ll inspect the repo first, then run tests.";
      expect(mgr.sanitizeResponse(input)).toBe("");
    });

    test("preserves substantive answers after a progress opener", () => {
      const input = [
        "I’ll check the live comparison quickly.",
        "",
        "Pi.dev is closer to a hosted automation scaffold. Nyx is a persistent local runtime with memory, queue state, and repo ownership.",
        "",
        "The practical difference is that Pi.dev can run workflows, while Nyx is meant to carry continuity across User's engineering system.",
      ].join("\n");

      expect(mgr.sanitizeResponse(input)).toBe([
        "Pi.dev is closer to a hosted automation scaffold. Nyx is a persistent local runtime with memory, queue state, and repo ownership.",
        "",
        "The practical difference is that Pi.dev can run workflows, while Nyx is meant to carry continuity across User's engineering system.",
      ].join("\n"));
    });

    test("strips a single workflow sentence before a substantive answer", () => {
      const input = "Using `superpowers:using-superpowers` for the session rule, then I’ll check `pi.dev` live before giving you a real comparison.I like it. Pi is a clean, sharp bet: minimal core, maximal user-shaped extensibility.";

      expect(mgr.sanitizeResponse(input)).toBe(
        "I like it. Pi is a clean, sharp bet: minimal core, maximal user-shaped extensibility.",
      );
    });

    test("strips multiline workflow diary before compact closeout", () => {
      const input = [
        "Using superpowers:using-superpowers, test-driven-development, and verification-before-completion. I will add restart provenance.",
        "I am locating the restart command path and audit surface.",
        "No fixes until there is a pinned cause.",
        "The narrow tests are green. I am running the full suite now.",
        "Verification is clean, so I am committing this change.",
        "Added restart provenance.",
        "",
        "Evidence:",
        "- Full suite passed.",
        "- Typecheck passed.",
      ].join("\n");

      expect(mgr.sanitizeResponse(input)).toBe([
        "Added restart provenance.",
        "",
        "Evidence:",
        "- Full suite passed.",
        "- Typecheck passed.",
      ].join("\n"));
    });

    test("strips run-context-prefixed workflow diary before compact closeout", () => {
      const input = [
        "[Run Context]",
        "Run ID: def9480a-584e-4480-8401-6062e1a4ba7d",
        "Scratchpad: /home/user/dev/nyxhive/.nyxhive/data/scratchpads/def9480a-584e-4480-8401-6062e1a4ba7d",
        "Using superpowers:using-superpowers, test-driven-development, and verification-before-completion. I will add restart provenance.",
        "I am skipping extra design ceremony here because you already approved the narrow design.",
        "The failing coverage is in place.",
        "Implementation is now wired.",
        "Verification is clean, so I am committing this as the restart provenance change and pushing it.",
        "Added restart provenance.",
        "",
        "What changed:",
        "- restart-instance.sh writes restart-provenance.jsonl before killing/restarting.",
        "",
        "Evidence:",
        "- Full suite passed.",
      ].join("\n");

      expect(mgr.sanitizeResponse(input)).toBe([
        "Added restart provenance.",
        "",
        "What changed:",
        "- restart-instance.sh writes restart-provenance.jsonl before killing/restarting.",
        "",
        "Evidence:",
        "- Full suite passed.",
      ].join("\n"));
    });

    test("strips run-context prefix even without a skill announcement", () => {
      const input = [
        "[Current Message]",
        "[Run Context]",
        "Run ID: def9480a-584e-4480-8401-6062e1a4ba7d",
        "Scratchpad: /home/user/dev/nyxhive/.nyxhive/data/scratchpads/def9480a-584e-4480-8401-6062e1a4ba7d",
        "Use the scratchpad for temporary notes, intermediate artifacts, and machine-readable outputs you want preserved with this run.",
        "I’ll fix the reply leak, verify it, and restart the daemon.",
        "The repo is clean at a sanitizer-focused HEAD.",
        "Fixed: run context stays out of replies.",
        "Evidence: targeted test passed.",
      ].join("\n");

      expect(mgr.sanitizeResponse(input)).toBe([
        "Fixed: run context stays out of replies.",
        "",
        "Evidence: targeted test passed.",
      ].join("\n"));
    });

    test("strips workflow diary even when it starts without skill announcement", () => {
      const input = [
        "I am starting with the recent instability surface.",
        "The live logs already show two hidden stability signals.",
        "Found issue: restart-recovered replies skipped visible history.",
        "",
        "Fixed: persisted recovered session replies.",
        "Evidence: full suite passed.",
      ].join("\n");

      expect(mgr.sanitizeResponse(input)).toBe([
        "Found issue: restart-recovered replies skipped visible history.",
        "",
        "Fixed: persisted recovered session replies.",
        "",
        "Evidence: full suite passed.",
      ].join("\n"));
    });
  });

  describe("getConversationHistory", () => {
    test("returns empty when no memory", () => {
      const ctx = makeCtx();
      const result = mgr.getConversationHistory("test:user", "claude-sonnet-4-6", 0, undefined, ctx);
      expect(result.messages).toEqual([]);
      expect(result.metrics.messageCount).toBe(0);
    });

    test("returns messages from memory", () => {
      const memory = makeMemory();
      memory.saveMessage("test:user", "user", "hello", null, null, 0, 0, 0);
      memory.saveMessage("test:user", "assistant", "hi there", null, null, 0, 0, 0);
      const ctx = makeCtx({ memory: memory as any });

      const result = mgr.getConversationHistory("test:user", "claude-sonnet-4-6", 0, undefined, ctx);
      expect(result.messages.length).toBeGreaterThanOrEqual(1);
      expect(result.metrics.messageCount).toBeGreaterThan(0);
    });

    test("filters workflow progress diary out of context history", () => {
      const memory = makeMemory();
      memory.saveMessage("test:user", "user", "fix this", null, null, 0, 0, 0);
      memory.saveMessage(
        "test:user",
        "assistant",
        "Using superpowers:using-superpowers. I’ll inspect files, then report back.",
        null,
        null,
        0,
        0,
        0,
      );
      memory.saveMessage("test:user", "assistant", "Fixed the bug.", null, null, 0, 0, 0);
      const ctx = makeCtx({ memory: memory as any });

      const result = mgr.getConversationHistory("test:user", "claude-sonnet-4-6", 0, undefined, ctx);

      expect(result.messages.some((message) => message.content.includes("Using superpowers"))).toBe(false);
      expect(result.messages.some((message) => message.content === "Fixed the bug.")).toBe(true);
    });

    test("respects max_history config", () => {
      const memory = makeMemory();
      // Add 5 messages
      for (let i = 0; i < 5; i++) {
        memory.saveMessage("test:user", "user", `msg ${i}`, null, null, 0, 0, 0);
        memory.saveMessage("test:user", "assistant", `reply ${i}`, null, null, 0, 0, 0);
      }
      const ctx = makeCtx({
        memory: memory as any,
        nyxhiveConfig: { context: { max_history: 4 } } as any,
      });

      const result = mgr.getConversationHistory("test:user", "claude-sonnet-4-6", 0, undefined, ctx);
      // Should be bounded by max_history
      expect(result.messages.length).toBeLessThanOrEqual(4);
    });
  });

  describe("buildParentContext", () => {
    test("returns null when no memory", () => {
      const ctx = makeCtx();
      expect(mgr.buildParentContext("test:user", 2000, ctx)).toBeNull();
    });

    test("returns null when no messages", () => {
      const memory = makeMemory();
      const ctx = makeCtx({ memory: memory as any });
      expect(mgr.buildParentContext("test:user", 2000, ctx)).toBeNull();
    });

    test("builds context from recent messages", () => {
      const memory = makeMemory();
      memory.saveMessage("test:user", "user", "Please respond in Portuguese", null, null, 0, 0, 0);
      memory.saveMessage("test:user", "assistant", "Claro, vou responder em português", null, null, 0, 0, 0);
      const ctx = makeCtx({ memory: memory as any });

      const result = mgr.buildParentContext("test:user", 2000, ctx);
      expect(result).toContain("User: Please respond in Portuguese");
      expect(result).toContain("Assistant: Claro");
    });

    test("respects maxChars limit", () => {
      const memory = makeMemory();
      // Add several long messages
      for (let i = 0; i < 10; i++) {
        memory.saveMessage("test:user", "user", "x".repeat(200), null, null, 0, 0, 0);
        memory.saveMessage("test:user", "assistant", "y".repeat(200), null, null, 0, 0, 0);
      }
      const ctx = makeCtx({ memory: memory as any });

      const result = mgr.buildParentContext("test:user", 500, ctx);
      expect(result).toBeTruthy();
      expect(result!.length).toBeLessThanOrEqual(600); // 500 + line prefix overhead
    });

    test("truncates individual message content within budget", () => {
      const memory = makeMemory();
      memory.saveMessage("test:user", "user", "z".repeat(500), null, null, 0, 0, 0);
      const ctx = makeCtx({ memory: memory as any });

      const result = mgr.buildParentContext("test:user", 2000, ctx);
      expect(result).toBeTruthy();
      // Each message line starts with "User: " or "Assistant: " and content capped at 400
      const contentLength = result!.replace("User: ", "").length;
      expect(contentLength).toBeLessThanOrEqual(400);
    });
  });

  describe("saveToHistory", () => {
    test("saves user and assistant messages", () => {
      const memory = makeMemory();
      const ctx = makeCtx({ memory: memory as any });

      mgr.saveToHistory(
        "telegram:user1", "telegram", "user1",
        "What is 2+2?", "4",
        "claude-sonnet-4-6", "anthropic",
        100, 50, 0.001,
        "nyx", ctx,
      );

      const msgs = memory.getMessages("telegram:user1", 10);
      expect(msgs).toHaveLength(2);
      expect(msgs[0].role).toBe("user");
      expect(msgs[0].content).toBe("What is 2+2?");
      expect(msgs[1].role).toBe("assistant");
      expect(msgs[1].content).toBe("4");
    });

    test("sanitizes assistant response before saving", () => {
      const memory = makeMemory();
      const ctx = makeCtx({ memory: memory as any });

      mgr.saveToHistory(
        "api:user1", "api", "user1",
        "hello", "Response.\n<tool_call>fake</tool_call>\nDone.",
        null, null, 0, 0, 0,
        undefined, ctx,
      );

      const msgs = memory.getMessages("api:user1", 10);
      expect(msgs[1].content).toBe("Response.\n\nDone.");
      expect(msgs[1].content).not.toContain("tool_call");
    });

    test("ensures conversation exists", () => {
      const memory = makeMemory();
      const ctx = makeCtx({ memory: memory as any });

      mgr.saveToHistory(
        "discord:jay", "discord", "jay",
        "hi", "hey",
        null, null, 0, 0, 0,
        undefined, ctx,
      );

      expect(memory._conversations.has("discord:jay")).toBe(true);
      expect(memory._conversations.get("discord:jay")!.channel).toBe("discord");
      expect(memory._conversations.get("discord:jay")!.senderId).toBe("jay");
    });

    test("does nothing when no memory", () => {
      const ctx = makeCtx();
      // Should not throw
      mgr.saveToHistory(
        "api:user", "api", "user",
        "hi", "hey",
        null, null, 0, 0, 0,
        undefined, ctx,
      );
    });

    test("enforces hard cap when message count exceeds max_history", () => {
      const memory = makeMemory();
      // Pre-populate with messages beyond hard cap
      for (let i = 0; i < 250; i++) {
        memory.saveMessage("test:user", i % 2 === 0 ? "user" : "assistant", `msg ${i}`, null, null, 0, 0, 0);
      }

      const ctx = makeCtx({
        memory: memory as any,
        nyxhiveConfig: { context: { max_history: 200, summary_threshold: 300 } } as any,
      });

      mgr.saveToHistory(
        "test:user", "test", "user",
        "one more", "response",
        null, null, 0, 0, 0,
        undefined, ctx,
      );

      // After hard cap enforcement, should be trimmed to 200
      expect(memory.getMessageCount("test:user")).toBeLessThanOrEqual(200);
    });
  });

  describe("getContextStrategy", () => {
    test("returns undefined when agent not found", () => {
      const ctx = makeCtx();
      expect(mgr.getContextStrategy("nonexistent", ctx)).toBeUndefined();
    });

    test("returns config-level strategy when present", () => {
      const strategy = { history_budget_ratio: 0.3 };
      const ctx = makeCtx({
        getAgent: () => ({ context_strategy: strategy } as any),
      });
      expect(mgr.getContextStrategy("forge", ctx)).toBe(strategy);
    });

    test("falls back to soul strategy when config has none", () => {
      const ctx = makeCtx({
        getAgent: () => ({} as any),
      });
      // Soul system may return a strategy for known agents
      const strategy = mgr.getContextStrategy("forge", ctx);
      // Either undefined or a valid strategy object from the soul system
      if (strategy) {
        expect(typeof strategy).toBe("object");
      }
    });

    test("uses the current instance soul directory for fallback strategy", () => {
      const instanceSoulsDir = makeInstanceSoul(
        "vortex",
        "---\nfresh_context: true\ncontext_budget: 0\nmax_messages: 3\n---",
      );
      const ctx = makeCtx({
        instanceSoulsDir,
        getAgent: () => ({} as any),
      } as Partial<ConversationManagerContext>);

      const strategy = mgr.getContextStrategy("vortex", ctx);

      expect(strategy?.fresh_context).toBe(true);
      expect(strategy?.context_budget).toBe(0);
      expect(strategy?.max_messages).toBe(3);
    });
  });
});
