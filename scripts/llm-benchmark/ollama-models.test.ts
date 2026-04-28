import { afterEach, describe, expect, mock, test } from "bun:test";
import { listInstalledModels, resolveInstalledModel, resolveInstalledModels } from "./ollama-models.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("resolveInstalledModel", () => {
  test("matches an exact installed name", () => {
    expect(resolveInstalledModel("gemma3:4b", ["gemma3:4b", "phi4-mini:latest"])).toBe("gemma3:4b");
  });

  test("matches a requested prefix to an installed tagged model", () => {
    expect(resolveInstalledModel("phi4-mini", ["phi4-mini:latest"])).toBe("phi4-mini:latest");
  });

  test("returns null when the model is missing", () => {
    expect(resolveInstalledModel("ministral-3:3b", ["phi4-mini:latest"])).toBeNull();
  });
});

describe("resolveInstalledModels", () => {
  test("filters out unavailable models instead of returning broken names", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        models: [
          { name: "gemma3:4b" },
          { name: "phi4-mini:latest" },
        ],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn;
    try {
      await expect(resolveInstalledModels(["ministral-3:3b", "phi4-mini", "gemma3:4b"]))
        .resolves
        .toEqual(["phi4-mini:latest", "gemma3:4b"]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("lists installed model names from Ollama", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        models: [{ name: "llama3.2:3b" }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await expect(listInstalledModels()).resolves.toEqual(["llama3.2:3b"]);
  });
});
