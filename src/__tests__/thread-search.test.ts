import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ThreadDB } from "../server/db/threads.js";

describe("thread search", () => {
  let db: ThreadDB;

  beforeEach(() => {
    db = new ThreadDB(new Database(":memory:"));
  });

  afterEach(() => {
    db.close();
  });

  test("indexes and finds threads by title", () => {
    const thread = db.createThread({ title: "Fix authentication bug", message: "Auth is broken", instance: "test" });
    db.indexThreadForSearch(thread.id, "Fix authentication bug", "Auth is broken");
    const results = db.searchThreads("authentication");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(thread.id);
    expect(results[0].snippet).toContain("Auth");
  });

  test("indexes and finds threads by content", () => {
    const thread = db.createThread({ title: "Task", message: "Deploy the kubernetes cluster", instance: "test" });
    db.indexThreadForSearch(thread.id, "Task", "Deploy the kubernetes cluster");
    const results = db.searchThreads("kubernetes");
    expect(results.length).toBeGreaterThan(0);
  });

  test("returns empty for no matches", () => {
    const results = db.searchThreads("nonexistent");
    expect(results).toHaveLength(0);
  });

  test("returns empty for empty query", () => {
    const results = db.searchThreads("");
    expect(results).toHaveLength(0);
  });

  test("limits results", () => {
    for (let i = 0; i < 5; i++) {
      const t = db.createThread({ title: `Thread ${i}`, message: `Common keyword task ${i}`, instance: "test" });
      db.indexThreadForSearch(t.id, `Thread ${i}`, `Common keyword task ${i}`);
    }
    const results = db.searchThreads("keyword", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("handles special characters safely", () => {
    const results = db.searchThreads("test'\"*()");
    expect(results).toHaveLength(0); // no crash
  });

  test("auto-indexes on thread creation", () => {
    db.createThread({ title: "Refactor database layer", message: "Need to refactor the DB", instance: "test" });
    const results = db.searchThreads("refactor");
    expect(results.length).toBeGreaterThan(0);
  });

  test("auto-indexes on message insert", () => {
    const thread = db.createThread({ title: "Task", message: "Initial message", instance: "test" });
    db.addThreadMessage(thread.id, { role: "assistant", content: "Deploying microservices architecture" });
    const results = db.searchThreads("microservices");
    expect(results.length).toBeGreaterThan(0);
  });
});
