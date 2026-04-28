import { describe, test, expect } from "bun:test";
import { eventSchemas } from "../gateway/protocol/events.js";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const declaredEvents = new Set(Object.keys(eventSchemas));

/**
 * Scan source files matching a glob pattern and extract all regex capture
 * group matches from their contents.
 */
function extractFromSource(glob: string, pattern: RegExp, baseDir: string = ROOT): Set<string> {
  const results = new Set<string>();
  const scanner = new Glob(glob);
  for (const file of scanner.scanSync(baseDir)) {
    const content = readFileSync(join(baseDir, file), "utf-8");
    for (const match of content.matchAll(pattern)) {
      if (match[1]) results.add(match[1]);
    }
  }
  return results;
}

// ── Backend: every deliberately broadcast event must be declared ─────────────

describe("protocol alignment — backend emitters", () => {
  test("all connections.broadcast() event names are declared in eventSchemas", () => {
    const broadcastPattern = /connections\.broadcast\(\s*["']([^"']+)["']/g;
    const emitted = extractFromSource("src/server/**/*.ts", broadcastPattern);

    const undeclared = [...emitted].filter((e) => !declaredEvents.has(e));
    if (undeclared.length > 0) {
      throw new Error(
        `Backend broadcasts events not declared in eventSchemas:\n` +
          undeclared.map((e) => `  - "${e}"`).join("\n") +
          `\n\nAdd schemas for these events in src/gateway/protocol/events.ts`,
      );
    }
    expect(undeclared).toEqual([]);
  });

  test("all broadcastToSubscribed() event names are declared in eventSchemas", () => {
    const subscribedPattern = /broadcastToSubscribed\(\s*["']([^"']+)["']/g;
    const emitted = extractFromSource("src/server/**/*.ts", subscribedPattern);

    const undeclared = [...emitted].filter((e) => !declaredEvents.has(e));
    expect(undeclared).toEqual([]);
  });

  test("all direct WS frame events (handler.ts) are declared in eventSchemas", () => {
    const handlerContent = readFileSync(join(ROOT, "src/server/ws/handler.ts"), "utf-8");
    // Match hand-built event frames: method: "xxx" within event-sending contexts
    const directFramePattern = /method:\s*["']([^"']+)["']/g;
    const directEvents = new Set<string>();
    for (const match of handlerContent.matchAll(directFramePattern)) {
      // Exclude request/response method references (connect.authenticate, error)
      if (match[1] && !["connect.authenticate", "error"].includes(match[1])) {
        directEvents.add(match[1]);
      }
    }

    const undeclared = [...directEvents].filter((e) => !declaredEvents.has(e));
    if (undeclared.length > 0) {
      throw new Error(
        `Direct WS frame events not declared in eventSchemas:\n` +
          undeclared.map((e) => `  - "${e}"`).join("\n"),
      );
    }
    expect(undeclared).toEqual([]);
  });
});

// ── Frontend: every subscription must reference a declared event ─────────────

describe("protocol alignment — frontend subscribers", () => {
  test("all useWsEvent() subscriptions reference declared events", () => {
    const subscribePattern = /useWsEvent\(\s*["']([^"']+)["']/g;
    const subscribed = extractFromSource("src/gateway/src/**/*.{ts,tsx}", subscribePattern);

    const undeclared = [...subscribed].filter((e) => !declaredEvents.has(e));
    if (undeclared.length > 0) {
      throw new Error(
        `Frontend subscribes to events not declared in eventSchemas:\n` +
          undeclared.map((e) => `  - "${e}"`).join("\n") +
          `\n\nEither add schemas or fix the event name`,
      );
    }
    expect(undeclared).toEqual([]);
  });

  test("all gateway.on() subscriptions reference declared events", () => {
    const onPattern = /gateway\.on\(\s*["']([^"']+)["']/g;
    const subscribed = extractFromSource("src/gateway/src/**/*.{ts,tsx}", onPattern);

    const undeclared = [...subscribed].filter((e) => !declaredEvents.has(e));
    expect(undeclared).toEqual([]);
  });
});

// ── Route-level broadcasts must be declared ──────────────────────────────────

describe("protocol alignment — route broadcasts", () => {
  test("all connections.broadcast() in route files are declared", () => {
    const broadcastPattern = /connections\.broadcast\(\s*["']([^"']+)["']/g;
    const emitted = extractFromSource("src/server/routes/**/*.ts", broadcastPattern);

    const undeclared = [...emitted].filter((e) => !declaredEvents.has(e));
    expect(undeclared).toEqual([]);
  });
});

// ── Catalog sanity ───────────────────────────────────────────────────────────

describe("protocol alignment — catalog sanity", () => {
  test("eventSchemas has no empty keys", () => {
    for (const key of Object.keys(eventSchemas)) {
      expect(key.length).toBeGreaterThan(0);
    }
  });

  test("every declared event has a Zod schema with .safeParse", () => {
    for (const [_name, schema] of Object.entries(eventSchemas)) {
      expect(typeof schema.safeParse).toBe("function");
    }
  });

  test("no duplicate event names (schema keys are unique)", () => {
    const keys = Object.keys(eventSchemas);
    expect(keys.length).toBe(new Set(keys).size);
  });
});
