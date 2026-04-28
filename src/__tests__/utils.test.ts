import { describe, test, expect } from "bun:test";
import { buildTelegramHTMLPreview, markdownToTelegramHTML, sanitizeResponse, splitMessage, splitTelegramHTML } from "../channels/utils.js";
import { withRetry } from "../utils/retry.js";

function stripHTMLTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function expectBalancedTelegramHTML(html: string): void {
  const stack: string[] = [];
  for (const match of html.matchAll(/<\/?([a-z0-9]+)(?:\s+[^>]+)?>/gi)) {
    const full = match[0];
    const name = match[1]!.toLowerCase();
    if (full[1] === "/") {
      expect(stack.pop()).toBe(name);
    } else {
      stack.push(name);
    }
  }
  expect(stack).toEqual([]);
}

describe("sanitizeResponse", () => {
  test("strips workflow diary before channel delivery", () => {
    const input = [
      "Using superpowers:using-superpowers, test-driven-development, and verification-before-completion. I’ll add restart provenance.",
      "I’m skipping extra design ceremony here because the change is narrow.",
      "First pass is locating the restart command path and the existing audit surface.",
      "Added restart provenance.",
      "",
      "Evidence: full suite passed.",
    ].join("\n");

    expect(sanitizeResponse(input)).toBe("Added restart provenance.\n\nEvidence: full suite passed.");
  });
});

describe("splitMessage", () => {
  test("short message returns single chunk", () => {
    expect(splitMessage("hello world", 100)).toEqual(["hello world"]);
  });

  test("empty string returns empty array", () => {
    expect(splitMessage("", 100)).toEqual([]);
  });

  test("message exactly at maxLen returns single chunk", () => {
    const msg = "a".repeat(50);
    expect(splitMessage(msg, 50)).toEqual([msg]);
  });

  test("splits on newlines when within boundary", () => {
    const msg = "Line one is here\nLine two is here\nLine three is here";
    const result = splitMessage(msg, 30);
    expect(result.length).toBeGreaterThan(1);
    expect(result[0]).toBe("Line one is here");
  });

  test("falls back to spaces when no newline near boundary", () => {
    const msg = "word1 word2 word3 word4 word5 word6 word7 word8";
    const result = splitMessage(msg, 20);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
  });

  test("hard splits when no good boundary found", () => {
    const msg = "a".repeat(100);
    const result = splitMessage(msg, 30);
    expect(result.length).toBeGreaterThan(1);
    expect(result[0].length).toBe(30);
  });

  test("all chunks respect maxLen with mixed content", () => {
    const msg = "Hello world\nThis is a test of the message splitter with various content types\nEnd";
    const result = splitMessage(msg, 40);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(40);
    }
  });

  test("multiple splits reassemble correctly", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
    const msg = lines.join("\n");
    const result = splitMessage(msg, 30);
    const reassembled = result.join("\n");
    for (const line of lines) {
      expect(reassembled).toContain(line);
    }
  });

  test("prefers newline over space when both valid", () => {
    const msg = "first part\nsecond part of msg";
    const result = splitMessage(msg, 20);
    expect(result[0]).toBe("first part");
  });

  test("handles very small maxLen", () => {
    const msg = "ab cd";
    const result = splitMessage(msg, 3);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(3);
    }
  });
});

describe("markdownToTelegramHTML", () => {
  test("converts supported markdown and escapes raw html", () => {
    const markdown = [
      "# Heading",
      "",
      "Use **bold**, *italic*, ~~strike~~, `code`, [link](https://example.com?a=1&b=2), and <raw> tags.",
    ].join("\n");

    expect(markdownToTelegramHTML(markdown)).toBe(
      '<b>Heading</b>\n\nUse <b>bold</b>, <i>italic</i>, <s>strike</s>, <code>code</code>, <a href="https://example.com?a=1&amp;b=2">link</a>, and &lt;raw&gt; tags.',
    );
  });
});

describe("splitTelegramHTML", () => {
  test("splits long formatted responses without breaking tags", () => {
    const markdown = [
      "# Heading",
      "",
      Array.from(
        { length: 12 },
        () => "**bold text** and _italic text_ with [link](https://example.com/path) plus extra words.",
      ).join(" "),
      "",
      "```ts",
      "const answer = 42;",
      "```",
    ].join("\n");
    const html = markdownToTelegramHTML(markdown);

    const chunks = splitTelegramHTML(html, 120);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
      expectBalancedTelegramHTML(chunk);
    }
    expect(chunks.map(stripHTMLTags).join("")).toBe(stripHTMLTags(html));
  });

  test("builds truncated previews without invalid html", () => {
    const html = markdownToTelegramHTML(Array.from({ length: 40 }, () => "**bold** _italic_").join(" "));

    const preview = buildTelegramHTMLPreview(html, 80);

    expect(preview.length).toBeLessThanOrEqual(80);
    expect(preview).toContain("<i>(full response attached)</i>");
    expectBalancedTelegramHTML(preview);
  });
});

describe("withRetry", () => {
  test("returns result on first success", async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return "success"; }, { baseDelayMs: 1 });
    expect(result).toBe("success");
    expect(calls).toBe(1);
  });

  test("retries on 429 and succeeds on second try", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
      return "ok";
    }, { baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  test("retries on 500", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("server error"), { status: 500 });
      return "recovered";
    }, { baseDelayMs: 1 });
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });

  test("retries on 502", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("bad gateway"), { status: 502 });
      return "recovered";
    }, { baseDelayMs: 1 });
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });

  test("retries on 503", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("unavailable"), { status: 503 });
      return "recovered";
    }, { baseDelayMs: 1 });
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });

  test("throws immediately on 400", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw Object.assign(new Error("bad request"), { status: 400 });
    }, { baseDelayMs: 1 })).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });

  test("throws immediately on 404", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw Object.assign(new Error("not found"), { status: 404 });
    }, { baseDelayMs: 1 })).rejects.toThrow("not found");
    expect(calls).toBe(1);
  });

  test("throws immediately on 401", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw Object.assign(new Error("unauthorized"), { status: 401 });
    }, { baseDelayMs: 1 })).rejects.toThrow("unauthorized");
    expect(calls).toBe(1);
  });

  test("throws after maxRetries exhausted", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw Object.assign(new Error("always fails"), { status: 500 });
    }, { maxRetries: 2, baseDelayMs: 1 })).rejects.toThrow("always fails");
    expect(calls).toBe(3);
  });

  test("retries generic errors without status code", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw new Error("network error");
      return "recovered";
    }, { baseDelayMs: 1 });
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });

  test("respects statusCode property", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("retry me"), { statusCode: 429 });
      return "ok";
    }, { baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  test("custom retryOn list works", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("teapot"), { status: 418 });
      return "ok";
    }, { baseDelayMs: 1, retryOn: [418] });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  test("custom retryOn excludes default codes", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw Object.assign(new Error("server error"), { status: 500 });
    }, { baseDelayMs: 1, retryOn: [418] })).rejects.toThrow("server error");
    expect(calls).toBe(1);
  });
});
