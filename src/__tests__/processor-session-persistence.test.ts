import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueDB } from "../queue/db.js";
import { QueueProcessor } from "../queue/processor.js";
import { ThreadDB } from "../server/db/threads.js";

describe("processImmediate session persistence", () => {
  let tmpDir: string;
  let queue: QueueDB;
  let threadSqlite: Database;
  let threadDb: ThreadDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "processor-session-persistence-test-"));
    queue = new QueueDB(tmpDir);
    threadSqlite = new Database(join(tmpDir, "threads.db"));
    threadDb = new ThreadDB(threadSqlite);
  });

  afterEach(() => {
    queue.close();
    threadSqlite.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("persists assistant response to thread messages when thread_id is provided", async () => {
    const session = threadDb.createSession({
      instance: "test",
      agent: "nyx",
      title: "New Session",
    });
    const router = {
      classifyLocal: () => "conversation",
      route: () => ({
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        taskType: "conversation",
        maxTokens: 256,
      }),
      routeWithTier: () => ({
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        taskType: "conversation",
        maxTokens: 256,
      }),
      complete: mock(async () => ({
        content: "persisted reply",
        model: "claude-haiku-4-5-20251001",
        provider: "anthropic",
        tokensIn: 7,
        tokensOut: 5,
      })),
    } as any;
    const processor = new QueueProcessor(queue, {
      agents: {
        nyx: {
          name: "nyx",
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          working_directory: tmpDir,
        },
      },
      teams: {},
      baseDir: tmpDir,
      defaultAgent: "nyx",
      router,
    });
    processor.setThreadDb(threadDb);

    const result = await processor.processImmediate({
      channel: `session:${session.id}`,
      sender: "User",
      sender_id: "jay",
      thread_id: session.id,
      message: "write the missing closeout",
    });

    expect(result.response).toBe("persisted reply");
    const messages = threadDb.getThreadMessages(session.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: "persisted reply",
      agent: "nyx",
      message_id: result.message_id,
      tokens: 12,
    });
  });

  test("persists assistant response when a recovered session message is processed from the queue", async () => {
    const session = threadDb.createSession({
      instance: "test",
      agent: "nyx",
      title: "Recovered Session",
    });
    threadDb.addThreadMessage(session.id, {
      role: "user",
      content: "survive restart",
    });

    const router = {
      classifyLocal: () => "conversation",
      route: () => ({
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        taskType: "conversation",
        maxTokens: 256,
      }),
      routeWithTier: () => ({
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        taskType: "conversation",
        maxTokens: 256,
      }),
      complete: mock(async () => ({
        content: "recovered reply",
        model: "claude-haiku-4-5-20251001",
        provider: "anthropic",
        tokensIn: 4,
        tokensOut: 3,
      })),
    } as any;
    const agentConfig = {
      name: "nyx",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      working_directory: tmpDir,
    } as any;
    const processor = new QueueProcessor(queue, {
      agents: { nyx: agentConfig },
      teams: {},
      baseDir: tmpDir,
      defaultAgent: "nyx",
      router,
    });
    processor.setThreadDb(threadDb);

    const messageId = queue.enqueueMessage({
      channel: `session:${session.id}`,
      sender: "User",
      sender_id: "jay",
      thread_id: session.id,
      message: "survive restart",
      agent: "nyx",
      status: "processing",
    });
    const msg = queue.getMessageByMessageId(messageId);
    expect(msg).not.toBeNull();

    await (processor as any).processForAgent("nyx", agentConfig, msg);

    const messages = threadDb.getThreadMessages(session.id);
    expect(messages.map((m) => [m.role, m.content, m.message_id])).toEqual([
      ["user", "survive restart", null],
      ["assistant", "recovered reply", messageId],
    ]);
    expect(threadDb.getThread(session.id)?.response).toBe("recovered reply");
  });
});
