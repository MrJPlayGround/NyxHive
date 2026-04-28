import { describe, test, expect } from "bun:test";
import { extractMemories } from "../memory/extract.js";
import type { ProviderRouter } from "../providers/router.js";

/** Create a mock router that returns the given content string */
function mockRouter(content: string): ProviderRouter {
  return {
    complete: async () => ({ content, usage: { input: 0, output: 0 } }),
  } as unknown as ProviderRouter;
}

describe("extractMemories — parsing & validation", () => {
  test("parses valid JSON array from plain response", async () => {
    const json = JSON.stringify([
      { type: "fact", content: "User prefers TypeScript", importance: 0.8 },
      { type: "preference", content: "Minimal dependencies", importance: 0.9 },
    ]);
    const result = await extractMemories("transcript", "", mockRouter(json));
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("fact");
    expect(result[0].content).toBe("User prefers TypeScript");
    expect(result[0].importance).toBe(0.8);
    expect(result[1].type).toBe("preference");
  });

  test("extracts JSON from markdown code block", async () => {
    const response = `Here are the extracted memories:

\`\`\`json
[{"type": "decision", "content": "Use SQLite everywhere", "importance": 0.7}]
\`\`\`

That's what I found.`;
    const result = await extractMemories("transcript", "", mockRouter(response));
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("decision");
    expect(result[0].content).toBe("Use SQLite everywhere");
  });

  test("extracts JSON embedded in surrounding text", async () => {
    const response = `I found these memories: [{"type": "goal", "content": "Ship by end of month", "importance": 0.6}] — done.`;
    const result = await extractMemories("transcript", "", mockRouter(response));
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("goal");
  });

  test("filters out invalid MemoryType values", async () => {
    const json = JSON.stringify([
      { type: "fact", content: "Valid memory", importance: 0.5 },
      { type: "banana", content: "Invalid type", importance: 0.5 },
      { type: "error", content: "Not in VALID_TYPES set", importance: 0.5 },
      { type: "preference", content: "Also valid", importance: 0.5 },
    ]);
    const result = await extractMemories("transcript", "", mockRouter(json));
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("fact");
    expect(result[1].type).toBe("preference");
  });

  test("clamps importance > 1.0 to 1.0", async () => {
    const json = JSON.stringify([
      { type: "fact", content: "Very important", importance: 5.0 },
    ]);
    const result = await extractMemories("transcript", "", mockRouter(json));
    expect(result).toHaveLength(1);
    expect(result[0].importance).toBe(1.0);
  });

  test("clamps importance < 0 to 0", async () => {
    const json = JSON.stringify([
      { type: "fact", content: "Negative importance", importance: -2.5 },
    ]);
    const result = await extractMemories("transcript", "", mockRouter(json));
    expect(result).toHaveLength(1);
    expect(result[0].importance).toBe(0);
  });

  test("defaults importance to 0.5 when not a number", async () => {
    const json = JSON.stringify([
      { type: "fact", content: "Missing importance" },
      { type: "fact", content: "String importance", importance: "high" },
    ]);
    const result = await extractMemories("transcript", "", mockRouter(json));
    expect(result).toHaveLength(2);
    expect(result[0].importance).toBe(0.5);
    expect(result[1].importance).toBe(0.5);
  });

  test("rejects content shorter than 3 characters", async () => {
    const json = JSON.stringify([
      { type: "fact", content: "OK", importance: 0.5 },
      { type: "fact", content: "ab", importance: 0.5 },
      { type: "fact", content: "", importance: 0.5 },
      { type: "fact", content: "This is fine", importance: 0.5 },
    ]);
    const result = await extractMemories("transcript", "", mockRouter(json));
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("This is fine");
  });

  test("returns empty array for empty JSON array", async () => {
    const result = await extractMemories("transcript", "", mockRouter("[]"));
    expect(result).toEqual([]);
  });

  test("returns empty array for malformed JSON", async () => {
    const result = await extractMemories("transcript", "", mockRouter("{not valid json[}"));
    expect(result).toEqual([]);
  });

  test("returns empty array when no JSON found in response", async () => {
    const result = await extractMemories("transcript", "", mockRouter("No memories found in this conversation."));
    expect(result).toEqual([]);
  });

  test("returns empty array when response is empty string", async () => {
    const result = await extractMemories("transcript", "", mockRouter(""));
    expect(result).toEqual([]);
  });

  test("skips non-object items in array", async () => {
    const json = `[{"type": "fact", "content": "Valid one", "importance": 0.5}, "string item", 42, null, true]`;
    const result = await extractMemories("transcript", "", mockRouter(json));
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Valid one");
  });

  test("skips items with missing type", async () => {
    const json = JSON.stringify([
      { content: "No type field", importance: 0.5 },
    ]);
    const result = await extractMemories("transcript", "", mockRouter(json));
    expect(result).toEqual([]);
  });

  test("skips items with missing content", async () => {
    const json = JSON.stringify([
      { type: "fact", importance: 0.5 },
    ]);
    const result = await extractMemories("transcript", "", mockRouter(json));
    expect(result).toEqual([]);
  });

  test("preserves updates field when present as string", async () => {
    const json = JSON.stringify([
      { type: "fact", content: "Now uses Bun", importance: 0.8, updates: "Previously used Node.js" },
    ]);
    const result = await extractMemories("transcript", "", mockRouter(json));
    expect(result).toHaveLength(1);
    expect(result[0].updates).toBe("Previously used Node.js");
  });

  test("sets updates to undefined when not a string", async () => {
    const json = JSON.stringify([
      { type: "fact", content: "Some fact", importance: 0.5, updates: 123 },
      { type: "fact", content: "Another fact", importance: 0.5 },
    ]);
    const result = await extractMemories("transcript", "", mockRouter(json));
    expect(result).toHaveLength(2);
    expect(result[0].updates).toBeUndefined();
    expect(result[1].updates).toBeUndefined();
  });

  test("returns empty array when router throws", async () => {
    const failRouter = {
      complete: async () => { throw new Error("LLM down"); },
    } as unknown as ProviderRouter;
    const result = await extractMemories("transcript", "", failRouter);
    expect(result).toEqual([]);
  });

  test("all 8 valid types are accepted", async () => {
    const validTypes = ["fact", "preference", "decision", "identity", "event", "observation", "goal", "task"] as const;
    const items = validTypes.map((type) => ({ type, content: `Memory of type ${type}`, importance: 0.5 }));
    const result = await extractMemories("transcript", "", mockRouter(JSON.stringify(items)));
    expect(result).toHaveLength(8);
    for (let i = 0; i < validTypes.length; i++) {
      expect(result[i].type).toBe(validTypes[i]);
    }
  });
});
