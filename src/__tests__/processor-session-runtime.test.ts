import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueDB } from "../queue/db.js";
import { QueueProcessor } from "../queue/processor.js";
import { MemoryStore } from "../memory/store.js";
import type { AgentConfig } from "../types.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "session-runtime-test-"));
}

function makeAnthropicAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Nyx",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    working_directory: "/tmp/nyx",
    capabilities: ["tool_use"],
    ...overrides,
  };
}

function makeCodexAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Nyx",
    provider: "openai",
    model: "gpt-5.4",
    working_directory: "/tmp/nyx",
    capabilities: ["tool_use"],
    always_cli: true,
    cli_fallback: "codex",
    agentic_mode: "strict",
    ...overrides,
  };
}

function makeProcessorWithMemory(
  dir: string,
  agents: Record<string, AgentConfig> = { nyx: makeAnthropicAgent() },
): { queue: QueueDB; memory: MemoryStore; processor: QueueProcessor } {
  const queue = new QueueDB(dir, "test");
  const memory = new MemoryStore(dir, "memory");
  const processor = new QueueProcessor(queue, {
    agents,
    teams: {},
    baseDir: dir,
    memory,
  });
  return { queue, memory, processor };
}

const cleanup: Array<{ queue: QueueDB; memory: MemoryStore; dir: string }> = [];

afterEach(() => {
  for (const item of cleanup.splice(0)) {
    item.queue.close();
    item.memory.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

describe("QueueProcessor runtime-aware session persistence", () => {
  test("persists and reloads explicit runtime metadata for Claude CLI sessions", () => {
    const dir = makeTempDir();
    const { queue, memory, processor } = makeProcessorWithMemory(dir, {
      nyx: makeAnthropicAgent(),
    });
    cleanup.push({ queue, memory, dir });

    const procAny = processor as any;
    procAny.updateCliSession("conv-1:nyx", "session-123", "claude_cli", 321);

    const row = memory
      .getDb()
      .query("SELECT session_id, runtime, turns, last_turn_tokens_in FROM cli_sessions WHERE key = ?")
      .get("conv-1:nyx") as Record<string, unknown> | null;

    expect(row).not.toBeNull();
    expect(row?.session_id).toBe("session-123");
    expect(row?.runtime).toBe("claude_cli");
    expect(row?.turns).toBe(1);
    expect(row?.last_turn_tokens_in).toBe(321);
    expect(procAny.resolveCliSessionId("conv-1:nyx", makeAnthropicAgent())).toBe("session-123");
  });

  test("refuses stale runtime reuse and clears mismatched sessions", () => {
    const dir = makeTempDir();
    const { queue, memory, processor } = makeProcessorWithMemory(dir);
    cleanup.push({ queue, memory, dir });

    const procAny = processor as any;
    procAny.updateCliSession("conv-3:nyx", "thread-unknown", "unknown_runtime", 88_000);

    expect(procAny.resolveCliSessionId("conv-3:nyx", makeAnthropicAgent())).toBeUndefined();

    const row = memory
      .getDb()
      .query("SELECT session_id FROM cli_sessions WHERE key = ?")
      .get("conv-3:nyx");
    expect(row).toBeNull();
  });

  test("reuses Claude CLI sessions and refuses non-claude_cli sessions", () => {
    const dir = makeTempDir();
    const { queue, memory, processor } = makeProcessorWithMemory(dir);
    cleanup.push({ queue, memory, dir });

    const procAny = processor as any;
    procAny.updateCliSession("conv-5:nyx", "cli-session-123", "claude_cli", 12_345);

    expect(
      procAny.resolveCliSessionId("conv-5:nyx", makeAnthropicAgent()),
    ).toBe("cli-session-123");
    // Non-claude_cli runtime is a mismatch — should be refused
    procAny.updateCliSession("conv-5b:nyx", "stale-session", "unknown_runtime", 12_345);
    expect(procAny.resolveCliSessionId("conv-5b:nyx", makeAnthropicAgent())).toBeUndefined();
  });

  test("reuses Codex app-server sessions for strict Codex agents", () => {
    const dir = makeTempDir();
    const { queue, memory, processor } = makeProcessorWithMemory(dir, {
      nyx: makeCodexAgent(),
    });
    cleanup.push({ queue, memory, dir });

    const procAny = processor as any;
    procAny.updateCliSession("conv-6:nyx", "codex-thread-123", "codex_app_server", 20_000);

    expect(
      procAny.resolveCliSessionId("conv-6:nyx", makeCodexAgent()),
    ).toBe("codex-thread-123");
  });

  test("does not auto-resume persisted runtime sessions for fresh agentic DM asks", () => {
    const dir = makeTempDir();
    const { queue, memory, processor } = makeProcessorWithMemory(dir, {
      vortex: makeCodexAgent({ name: "Vortex" }),
    });
    cleanup.push({ queue, memory, dir });

    const procAny = processor as any;
    const sessionKey = "telegram:jay:vortex";
    procAny.updateCliSession(sessionKey, "stale-codex-thread", "codex_app_server", 30_000);

    expect(
      procAny.resolveCliSessionIdForTurn(sessionKey, makeCodexAgent({ name: "Vortex" }), {
        message: "Vortex is going onto NyxLabs Discord. Inspect the Discord harness and comms channel for prompt ejection safety.",
        runtimeMode: "agentic",
      }),
    ).toBeUndefined();

    expect(
      memory.getDb().query("SELECT session_id FROM cli_sessions WHERE key = ?").get(sessionKey),
    ).not.toBeNull();

    expect(
      procAny.resolveCliSessionIdForTurn(sessionKey, makeCodexAgent({ name: "Vortex" }), {
        message: "yes",
        runtimeMode: "conversation",
      }),
    ).toBeUndefined();
  });

  test("resumes persisted runtime sessions only for explicit continuation turns", () => {
    const dir = makeTempDir();
    const { queue, memory, processor } = makeProcessorWithMemory(dir, {
      vortex: makeCodexAgent({ name: "Vortex" }),
    });
    cleanup.push({ queue, memory, dir });

    const procAny = processor as any;
    const sessionKey = "telegram:jay:vortex";
    procAny.updateCliSession(sessionKey, "active-codex-thread", "codex_app_server", 30_000);

    expect(
      procAny.resolveCliSessionIdForTurn(sessionKey, makeCodexAgent({ name: "Vortex" }), {
        message: "continue the Discord safety review from the previous run",
        runtimeMode: "agentic",
      }),
    ).toBe("active-codex-thread");
  });

  test("loads legacy rows safely but refuses to reuse unknown-runtime sessions", () => {
    const dir = makeTempDir();
    const queue = new QueueDB(dir, "test");
    const memory = new MemoryStore(dir, "memory");
    cleanup.push({ queue, memory, dir });

    memory.getDb().exec(`
      CREATE TABLE IF NOT EXISTS cli_sessions (
        key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        turns INTEGER,
        last_turn_tokens_in INTEGER
      )
    `);
    memory.getDb().run(
      "INSERT OR REPLACE INTO cli_sessions (key, session_id, created_at, updated_at, turns, last_turn_tokens_in) VALUES (?, ?, ?, ?, ?, ?)",
      ["conv-4:nyx", "legacy-session", Date.now(), Date.now(), 1, 5_000],
    );

    const processor = new QueueProcessor(queue, {
      agents: { nyx: makeAnthropicAgent() },
      teams: {},
      baseDir: dir,
      memory,
    });

    expect((processor as any).resolveCliSessionId("conv-4:nyx", makeAnthropicAgent())).toBeUndefined();
    expect(
      memory.getDb().query("SELECT session_id FROM cli_sessions WHERE key = ?").get("conv-4:nyx"),
    ).toBeNull();
  });
});
