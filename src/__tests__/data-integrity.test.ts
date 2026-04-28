import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "../memory/store.js";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("data integrity", () => {
  let store: MemoryStore;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "data-integrity-"));
    store = new MemoryStore(dir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("clearConversation removes conversation row", () => {
    store.ensureConversation("conv-clear-1", "telegram", "123");
    store.saveMessage("conv-clear-1", "user", "hello", null, null, 0, 0, 0);
    store.saveMessage("conv-clear-1", "assistant", "hi", null, null, 0, 0, 0);
    store.saveConversationSummary("conv-clear-1", "A greeting exchange");

    // Verify conversation exists
    const messages = store.getMessages("conv-clear-1", 10);
    expect(messages.length).toBe(2);
    expect(store.getConversationSummary("conv-clear-1")).toBe("A greeting exchange");

    store.clearConversation("conv-clear-1");

    // Messages and summary should be gone
    expect(store.getMessages("conv-clear-1", 10)).toEqual([]);
    expect(store.getConversationSummary("conv-clear-1")).toBeNull();

    // Conversation row itself should be gone — verify via raw DB query
    const db = store.getDb();
    const row = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE id = ?").get("conv-clear-1") as { count: number };
    expect(row.count).toBe(0);
  });

  test("clearConversation does not affect other conversations", () => {
    store.ensureConversation("conv-keep", "telegram", "123");
    store.ensureConversation("conv-delete", "telegram", "456");
    store.saveMessage("conv-keep", "user", "keep me", null, null, 0, 0, 0);
    store.saveMessage("conv-delete", "user", "delete me", null, null, 0, 0, 0);

    store.clearConversation("conv-delete");

    // conv-keep should be intact
    expect(store.getMessages("conv-keep", 10).length).toBe(1);
    const db = store.getDb();
    const kept = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE id = ?").get("conv-keep") as { count: number };
    expect(kept.count).toBe(1);

    // conv-delete should be fully gone
    const deleted = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE id = ?").get("conv-delete") as { count: number };
    expect(deleted.count).toBe(0);
  });

  test("clearConversation is idempotent on nonexistent conversation", () => {
    // Should not throw
    store.clearConversation("nonexistent-conv");
    const db = store.getDb();
    const row = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE id = ?").get("nonexistent-conv") as { count: number };
    expect(row.count).toBe(0);
  });
});
