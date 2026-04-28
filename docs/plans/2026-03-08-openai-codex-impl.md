# OpenAI + Codex Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add OpenAI as a full provider (Chat Completions API) and Codex CLI as a coding agent backend, authenticated via `codex login` OAuth tokens.

**Architecture:** Three new modules — `codex-auth.ts` reads/refreshes OAuth tokens from `~/.codex/auth.json`, `openai.ts` provider implements the standard `Provider` interface using Chat Completions, and `invoke-codex.ts` spawns `codex` CLI as a subprocess for coding agents. All wired into existing routing, config, and startup.

**Tech Stack:** TypeScript/Bun, native `fetch`, no new dependencies.

---

### Task 1: Codex Auth Module

**Files:**
- Create: `src/auth/codex-auth.ts`
- Test: `src/__tests__/codex-auth.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { readCodexAuth, refreshTokens, exchangeForApiKey, getApiKey, isTokenFresh } from "../auth/codex-auth.js";

// Mock fs.readFileSync for auth.json reads
const mockReadFileSync = mock(() => "");
const mockWriteFileSync = mock(() => {});
const mockExistsSync = mock(() => true);

mock.module("fs", () => ({
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  existsSync: mockExistsSync,
}));

describe("codex-auth", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "new-token" }), { status: 200 })
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockExistsSync.mockReset();
  });

  describe("readCodexAuth", () => {
    it("reads and parses ~/.codex/auth.json", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: "sk-test-123",
        tokens: {
          access_token: "at-123",
          refresh_token: "rt-456",
          id_token: {},
          account_id: "acct-789",
        },
        last_refresh: "2026-03-08T12:00:00Z",
      }));

      const auth = readCodexAuth();
      expect(auth).not.toBeNull();
      expect(auth!.apiKey).toBe("sk-test-123");
      expect(auth!.accessToken).toBe("at-123");
      expect(auth!.refreshToken).toBe("rt-456");
      expect(auth!.accountId).toBe("acct-789");
    });

    it("returns null when auth.json doesn't exist", () => {
      mockExistsSync.mockReturnValue(false);
      const auth = readCodexAuth();
      expect(auth).toBeNull();
    });

    it("returns null for api_key auth mode (no OAuth tokens)", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        auth_mode: "api-key",
        OPENAI_API_KEY: "sk-direct-key",
      }));
      const auth = readCodexAuth();
      // Should still work — api key is usable
      expect(auth).not.toBeNull();
      expect(auth!.apiKey).toBe("sk-direct-key");
    });
  });

  describe("isTokenFresh", () => {
    it("returns true for recent refresh", () => {
      expect(isTokenFresh(new Date().toISOString())).toBe(true);
    });

    it("returns false for old refresh", () => {
      const old = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
      expect(isTokenFresh(old)).toBe(false);
    });

    it("returns false for null", () => {
      expect(isTokenFresh(null)).toBe(false);
    });
  });

  describe("refreshTokens", () => {
    it("posts to auth.openai.com with refresh_token grant", async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify({
        access_token: "new-at",
        refresh_token: "new-rt",
        id_token: "new-id",
      }), { status: 200 }));

      const result = await refreshTokens("rt-old");
      expect(result.accessToken).toBe("new-at");
      expect(result.refreshToken).toBe("new-rt");

      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://auth.openai.com/oauth/token");
      expect(opts.method).toBe("POST");
    });

    it("throws on non-200 response", async () => {
      fetchSpy.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
      await expect(refreshTokens("rt-bad")).rejects.toThrow();
    });
  });

  describe("exchangeForApiKey", () => {
    it("exchanges id_token for API key via token exchange grant", async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify({
        access_token: "sk-exchanged-key",
      }), { status: 200 }));

      const key = await exchangeForApiKey("id-token-123");
      expect(key).toBe("sk-exchanged-key");

      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://auth.openai.com/oauth/token");
      const body = opts.body as string;
      expect(body).toContain("token-exchange");
      expect(body).toContain("openai-api-key");
    });
  });

  describe("getApiKey", () => {
    it("returns env var OPENAI_API_KEY if set", async () => {
      const origEnv = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-env-key";
      try {
        const key = await getApiKey();
        expect(key).toBe("sk-env-key");
      } finally {
        if (origEnv !== undefined) process.env.OPENAI_API_KEY = origEnv;
        else delete process.env.OPENAI_API_KEY;
      }
    });

    it("returns API key from codex auth.json", async () => {
      delete process.env.OPENAI_API_KEY;
      mockReadFileSync.mockReturnValue(JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: "sk-from-codex",
        tokens: {
          access_token: "at",
          refresh_token: "rt",
          id_token: {},
          account_id: "acct",
        },
        last_refresh: new Date().toISOString(),
      }));

      const key = await getApiKey();
      expect(key).toBe("sk-from-codex");
    });

    it("returns null when no auth available", async () => {
      delete process.env.OPENAI_API_KEY;
      mockExistsSync.mockReturnValue(false);
      const key = await getApiKey();
      expect(key).toBeNull();
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/codex-auth.test.ts`
Expected: FAIL — module `../auth/codex-auth.js` doesn't exist

**Step 3: Write the implementation**

```typescript
// src/auth/codex-auth.ts
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { logger } from "../utils/logger.js";

const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_INTERVAL_MS = 8 * 60 * 1000; // 8 minutes, matching Codex

export interface CodexAuthData {
  apiKey: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accountId: string | null;
  lastRefresh: string | null;
  authMode: string;
}

interface CodexAuthJson {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: unknown;
    account_id?: string;
  };
  last_refresh?: string;
}

/** Read and parse ~/.codex/auth.json. Returns null if file doesn't exist or is invalid. */
export function readCodexAuth(path?: string): CodexAuthData | null {
  const authPath = path ?? CODEX_AUTH_PATH;
  if (!existsSync(authPath)) return null;

  try {
    const raw = readFileSync(authPath, "utf-8");
    const data = JSON.parse(raw) as CodexAuthJson;

    return {
      apiKey: data.OPENAI_API_KEY ?? null,
      accessToken: data.tokens?.access_token ?? null,
      refreshToken: data.tokens?.refresh_token ?? null,
      idToken: typeof data.tokens?.id_token === "string" ? data.tokens.id_token : null,
      accountId: data.tokens?.account_id ?? null,
      lastRefresh: data.last_refresh ?? null,
      authMode: data.auth_mode ?? "unknown",
    };
  } catch (err) {
    logger.warn(`[codex-auth] Failed to read ${authPath}: ${err}`);
    return null;
  }
}

/** Check if the token was refreshed within the refresh interval. */
export function isTokenFresh(lastRefresh: string | null): boolean {
  if (!lastRefresh) return false;
  const refreshTime = new Date(lastRefresh).getTime();
  return Date.now() - refreshTime < REFRESH_INTERVAL_MS;
}

/** Refresh OAuth tokens using the refresh_token grant. */
export async function refreshTokens(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
}> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { access_token: string; refresh_token?: string; id_token?: string };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    idToken: data.id_token ?? null,
  };
}

/** Exchange an id_token for an OpenAI API key via token exchange grant. */
export async function exchangeForApiKey(idToken: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: CLIENT_ID,
    requested_token: "openai-api-key",
    subject_token: idToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { access_token: string };
  return data.access_token;
}

/** Update ~/.codex/auth.json with refreshed tokens. */
function persistTokens(
  authPath: string,
  accessToken: string,
  refreshToken: string,
  idToken: string | null,
  apiKey: string | null,
): void {
  try {
    const raw = readFileSync(authPath, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (data.tokens && typeof data.tokens === "object") {
      (data.tokens as Record<string, unknown>).access_token = accessToken;
      (data.tokens as Record<string, unknown>).refresh_token = refreshToken;
      if (idToken) (data.tokens as Record<string, unknown>).id_token = idToken;
    }
    if (apiKey) data.OPENAI_API_KEY = apiKey;
    data.last_refresh = new Date().toISOString();
    writeFileSync(authPath, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.warn(`[codex-auth] Failed to persist tokens: ${err}`);
  }
}

/**
 * Get a usable OpenAI API key. Resolution order:
 * 1. OPENAI_API_KEY env var
 * 2. ~/.codex/auth.json OPENAI_API_KEY field
 * 3. Refresh tokens + exchange for API key
 * Returns null if no auth is available.
 */
export async function getApiKey(envKey?: string): Promise<string | null> {
  // 1. Direct env var
  const envApiKey = process.env[envKey ?? "OPENAI_API_KEY"];
  if (envApiKey) return envApiKey;

  // 2. Codex auth.json
  const auth = readCodexAuth();
  if (!auth) return null;

  // If we have an API key and tokens are fresh, use it directly
  if (auth.apiKey && isTokenFresh(auth.lastRefresh)) {
    return auth.apiKey;
  }

  // If we have an API key but tokens are stale, try refresh
  if (auth.refreshToken) {
    try {
      const refreshed = await refreshTokens(auth.refreshToken);
      let apiKey = auth.apiKey;

      // If we got a new id_token, exchange for fresh API key
      if (refreshed.idToken) {
        try {
          apiKey = await exchangeForApiKey(refreshed.idToken);
        } catch (err) {
          logger.warn(`[codex-auth] Token exchange failed, using existing API key: ${err}`);
        }
      }

      // Persist refreshed tokens
      persistTokens(CODEX_AUTH_PATH, refreshed.accessToken, refreshed.refreshToken, refreshed.idToken, apiKey);

      return apiKey;
    } catch (err) {
      logger.warn(`[codex-auth] Token refresh failed: ${err}`);
      // Fall through to stale API key if available
    }
  }

  // Return stale API key as last resort
  return auth.apiKey;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/codex-auth.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
cd /home/user/dev/nyxhive
git add src/auth/codex-auth.ts src/__tests__/codex-auth.test.ts
git commit -m "feat: add codex-auth module for OpenAI OAuth token management"
```

---

### Task 2: OpenAI Provider

**Files:**
- Create: `src/providers/openai.ts`
- Test: `src/__tests__/openai-provider.test.ts`

**Step 1: Write the failing tests**

Follow the exact same pattern as `src/__tests__/openrouter-provider.test.ts` — `spyOn(globalThis, "fetch")`, mock responses, verify request formation, headers, message mapping, tool calls, error handling.

```typescript
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { OpenAIProvider } from "../providers/openai.js";

function makeSuccessResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-123",
    choices: [{
      message: { role: "assistant", content: "Hello from GPT", tool_calls: undefined },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    model: "gpt-4.1",
    ...overrides,
  };
}

function okResponse(data: Record<string, unknown> = makeSuccessResponse()) {
  return {
    ok: true, status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

function lastBody(fetchSpy: ReturnType<typeof spyOn>): any {
  const calls = fetchSpy.mock.calls;
  const [, opts] = calls[calls.length - 1] as [string, RequestInit];
  return JSON.parse(opts.body as string);
}

function lastOpts(fetchSpy: ReturnType<typeof spyOn>): RequestInit {
  const calls = fetchSpy.mock.calls;
  return calls[calls.length - 1][1] as RequestInit;
}

describe("OpenAIProvider", () => {
  let provider: OpenAIProvider;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    provider = new OpenAIProvider("sk-test-key", ["gpt-4.1", "gpt-4.1-mini", "o3"]);
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("has name 'openai'", () => {
    expect(provider.name).toBe("openai");
  });

  describe("listModels", () => {
    it("returns configured models", () => {
      expect(provider.listModels()).toEqual(["gpt-4.1", "gpt-4.1-mini", "o3"]);
    });
  });

  describe("complete", () => {
    it("sends POST to OpenAI Chat Completions API", async () => {
      await provider.complete({ messages: [{ role: "user", content: "Hi" }] });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      expect(opts.method).toBe("POST");
    });

    it("sends correct auth header", async () => {
      await provider.complete({ messages: [{ role: "user", content: "Hi" }] });
      const opts = lastOpts(fetchSpy);
      const headers = opts.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sk-test-key");
    });

    it("maps system prompt to system message", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        system: "You are helpful",
      });
      const body = lastBody(fetchSpy);
      expect(body.messages[0]).toEqual({ role: "system", content: "You are helpful" });
      expect(body.messages[1]).toEqual({ role: "user", content: "Hi" });
    });

    it("uses first model as default", async () => {
      await provider.complete({ messages: [{ role: "user", content: "Hi" }] });
      const body = lastBody(fetchSpy);
      expect(body.model).toBe("gpt-4.1");
    });

    it("uses specified model", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        model: "o3",
      });
      const body = lastBody(fetchSpy);
      expect(body.model).toBe("o3");
    });

    it("maps tools to OpenAI function format", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        tools: [{
          name: "get_weather",
          description: "Get weather info",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        }],
      });
      const body = lastBody(fetchSpy);
      expect(body.tools).toEqual([{
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather info",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      }]);
    });

    it("parses tool calls from response", async () => {
      fetchSpy.mockResolvedValue(okResponse(makeSuccessResponse({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Lisbon"}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })));

      const result = await provider.complete({ messages: [{ role: "user", content: "Weather?" }] });
      expect(result.toolCalls).toEqual([{ name: "get_weather", arguments: { city: "Lisbon" } }]);
      expect(result.finishReason).toBe("tool_calls");
    });

    it("handles malformed tool call arguments", async () => {
      fetchSpy.mockResolvedValue(okResponse(makeSuccessResponse({
        choices: [{
          message: {
            role: "assistant",
            content: "fallback text",
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "broken", arguments: "not-json{" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })));

      const result = await provider.complete({ messages: [{ role: "user", content: "Hi" }] });
      expect(result.toolCalls).toBeUndefined();
      expect(result.content).toBe("fallback text");
    });

    it("returns token counts and model", async () => {
      const result = await provider.complete({ messages: [{ role: "user", content: "Hi" }] });
      expect(result.tokensIn).toBe(50);
      expect(result.tokensOut).toBe(20);
      expect(result.model).toBe("gpt-4.1");
      expect(result.provider).toBe("openai");
    });

    it("throws on API error", async () => {
      fetchSpy.mockResolvedValue({
        ok: false, status: 429,
        text: () => Promise.resolve("Rate limited"),
      } as unknown as Response);

      await expect(
        provider.complete({ messages: [{ role: "user", content: "Hi" }] })
      ).rejects.toThrow("OpenAI API error 429");
    });

    it("throws when no choices returned", async () => {
      fetchSpy.mockResolvedValue(okResponse({ ...makeSuccessResponse(), choices: [] }));
      await expect(
        provider.complete({ messages: [{ role: "user", content: "Hi" }] })
      ).rejects.toThrow("no choices");
    });

    it("handles image file attachments", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "What's this?" }],
        files: [{
          name: "photo.jpg",
          mimeType: "image/jpeg",
          base64: "abc123",
          size: 1000,
        }],
      });
      const body = lastBody(fetchSpy);
      const lastMsg = body.messages[body.messages.length - 1];
      expect(Array.isArray(lastMsg.content)).toBe(true);
      expect(lastMsg.content[1].type).toBe("image_url");
      expect(lastMsg.content[1].image_url.url).toBe("data:image/jpeg;base64,abc123");
    });

    it("handles text file attachments", async () => {
      const encoded = Buffer.from("console.log('hello')").toString("base64");
      await provider.complete({
        messages: [{ role: "user", content: "Review this" }],
        files: [{
          name: "app.ts",
          mimeType: "text/plain",
          base64: encoded,
          size: 20,
        }],
      });
      const body = lastBody(fetchSpy);
      const lastMsg = body.messages[body.messages.length - 1];
      expect(Array.isArray(lastMsg.content)).toBe(true);
      expect(lastMsg.content[1].text).toContain("console.log('hello')");
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/openai-provider.test.ts`
Expected: FAIL — module `../providers/openai.js` doesn't exist

**Step 3: Write the implementation**

```typescript
// src/providers/openai.ts
import type {
  Provider,
  CompletionParams,
  ProviderResponse,
  ToolCall,
} from "./types.js";
import { logger } from "../utils/logger.js";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<Record<string, any>>;
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model: string;
}

export class OpenAIProvider implements Provider {
  name = "openai" as const;
  private apiKey: string;
  private models: string[];

  constructor(apiKey: string, models: string[]) {
    this.apiKey = apiKey;
    this.models = models;
  }

  listModels(): string[] {
    return this.models;
  }

  async complete(params: CompletionParams): Promise<ProviderResponse> {
    const model = params.model ?? this.models[0];
    const maxTokens = params.maxTokens ?? 4096;

    logger.info(`[openai] Request: ${model}, ${params.messages.length} messages, max_tokens=${maxTokens}`);
    const startTime = Date.now();

    const messages: OpenAIMessage[] = [];

    // System message
    const systemContent = params.system
      ?? params.messages.find((m) => m.role === "system")?.content;
    if (systemContent) {
      messages.push({ role: "system", content: systemContent });
    }

    // User/assistant messages
    for (const m of params.messages) {
      if (m.role !== "system") {
        messages.push({ role: m.role, content: m.content });
      }
    }

    // Inject file content blocks into the last user message
    if (params.files?.length) {
      const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
      if (lastUserIdx >= 0) {
        const textContent = messages[lastUserIdx].content as string;
        const contentBlocks: Array<Record<string, any>> = [];
        contentBlocks.push({ type: "text", text: textContent });
        for (const file of params.files) {
          if (file.mimeType.startsWith("image/")) {
            contentBlocks.push({
              type: "image_url",
              image_url: { url: `data:${file.mimeType};base64,${file.base64}` },
            });
          } else {
            const decoded = Buffer.from(file.base64, "base64").toString("utf-8");
            contentBlocks.push({
              type: "text",
              text: `[File: ${file.name}]\n${decoded}`,
            });
          }
        }
        messages[lastUserIdx].content = contentBlocks;
      }
    }

    // Tools
    const tools: OpenAITool[] | undefined = params.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: params.temperature ?? 0.7,
        ...(tools?.length ? { tools } : {}),
      }),
    });

    if (!response.ok) {
      const latency = Date.now() - startTime;
      const text = await response.text();
      logger.warn(`[openai] Failed ${model} after ${latency}ms — HTTP ${response.status}: ${text.slice(0, 500)}`);
      throw new Error(`OpenAI API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as OpenAIResponse;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error(`OpenAI returned no choices for model ${model}`);
    }
    const latency = Date.now() - startTime;

    // Parse tool calls
    let toolCalls: ToolCall[] | undefined;
    if (choice.message.tool_calls?.length) {
      const rawCount = choice.message.tool_calls.length;
      toolCalls = choice.message.tool_calls
        .map((tc) => {
          try {
            return {
              name: tc.function.name,
              arguments: JSON.parse(tc.function.arguments),
            };
          } catch {
            logger.warn(`[openai] Malformed tool call arguments for ${tc.function.name}: ${tc.function.arguments.slice(0, 200)}`);
            return null;
          }
        })
        .filter((tc): tc is ToolCall => tc !== null);
      if (toolCalls.length === 0) {
        logger.warn(`[openai] All ${rawCount} tool call(s) failed to parse — treating as text-only response`);
        toolCalls = undefined;
      }
    }

    logger.info(`[openai] Completed ${data.model} in ${latency}ms — ${data.usage.prompt_tokens}in/${data.usage.completion_tokens}out, stop=${choice.finish_reason}`);

    return {
      content: choice.message.content ?? "",
      model: data.model,
      provider: this.name,
      tokensIn: data.usage.prompt_tokens,
      tokensOut: data.usage.completion_tokens,
      toolCalls,
      finishReason: choice.finish_reason,
    };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/openai-provider.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
cd /home/user/dev/nyxhive
git add src/providers/openai.ts src/__tests__/openai-provider.test.ts
git commit -m "feat: add OpenAI provider (Chat Completions API)"
```

---

### Task 3: Wire OpenAI Into Config, Types, and Startup

**Files:**
- Modify: `src/providers/types.ts` (add `"openai"` to `ProviderName`)
- Modify: `src/defaults.ts` (add OpenAI models to tiers, cost rates, context windows)
- Modify: `src/config-schema.ts` (add `auth_mode` to provider schema)
- Modify: `src/index.ts` (register OpenAI provider on startup)
- Modify: `src/providers/router.ts` (add `"openai"` to fallback order type)

**Step 1: Update ProviderName type**

In `src/providers/types.ts` line 81:
```typescript
// Before:
export type ProviderName = "anthropic" | "openrouter";
// After:
export type ProviderName = "anthropic" | "openrouter" | "openai";
```

**Step 2: Add OpenAI models to defaults**

In `src/defaults.ts`, add to `DEFAULT_COST_RATES`:
```typescript
"gpt-4.1":       { input: 2, output: 8 },
"gpt-4.1-mini":  { input: 0.4, output: 1.6 },
"gpt-4.1-nano":  { input: 0.1, output: 0.4 },
"o3":            { input: 2, output: 8 },
"o4-mini":       { input: 1.1, output: 4.4 },
```

Add to `MODEL_TIERS`:
```typescript
// OpenAI tiers
"gpt-4.1-nano":  1,
"gpt-4.1-mini":  2,
"gpt-4.1":       3,
"o4-mini":       3,
"o3":            4,
```

Add to `MODEL_CONTEXT_WINDOWS`:
```typescript
"gpt-4.1":       1_047_576,
"gpt-4.1-mini":  1_047_576,
"gpt-4.1-nano":  1_047_576,
"o3":            200_000,
"o4-mini":       200_000,
```

Add to `MODEL_HINT_MAP`:
```typescript
"gpt4":   { model: "gpt-4.1",      provider: "openai" },
"o3":     { model: "o3",            provider: "openai" },
```

Add `"openai"` to `DEFAULT_FALLBACK_ORDER`:
```typescript
export const DEFAULT_FALLBACK_ORDER: ProviderName[] = ["anthropic", "openrouter", "openai"];
```

**Step 3: Add auth_mode to provider config schema**

In `src/config-schema.ts`, update `providerSchema`:
```typescript
const providerSchema = z.object({
  api_key_env: z.string().optional(), // Now optional — codex auth can be used instead
  auth_mode: z.enum(["api_key", "codex"]).optional(),
  default_model: z.string().optional(),
});
```

**Step 4: Register OpenAI provider in startup**

In `src/index.ts`, after the OpenRouter registration block (~line 128), add:
```typescript
// OpenAI
try {
  const openaiConfig = config.providers.openai;
  if (openaiConfig) {
    const { getApiKey } = await import("./auth/codex-auth.js");
    const apiKey = openaiConfig.api_key_env
      ? process.env[openaiConfig.api_key_env]
      : await getApiKey();
    if (apiKey) {
      const { OpenAIProvider } = await import("./providers/openai.js");
      const models = ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "o3", "o4-mini"];
      router.registerProvider("openai", new OpenAIProvider(apiKey, models));
      logger.info("OpenAI provider registered" + (openaiConfig.auth_mode === "codex" ? " (codex auth)" : " (API key)"));
    } else {
      logger.warn("OpenAI not available: no API key or codex auth. Run 'codex login' or set OPENAI_API_KEY.");
    }
  }
} catch (err) {
  logger.warn(`OpenAI not available: ${err}`);
}
```

**Step 5: Run type checker and full test suite**

Run: `cd /home/user/dev/nyxhive && bunx tsc --noEmit && bun test`
Expected: No type errors, all tests pass

**Step 6: Commit**

```bash
cd /home/user/dev/nyxhive
git add src/providers/types.ts src/defaults.ts src/config-schema.ts src/index.ts
git commit -m "feat: wire OpenAI provider into config, types, routing, and startup"
```

---

### Task 4: Codex CLI Invocation Module

**Files:**
- Create: `src/agents/invoke-codex.ts`
- Test: `src/__tests__/invoke-codex.test.ts`
- Modify: `src/agents/invoke.ts` (route `cli_fallback = "codex"` to new module)

**Step 1: Write the failing tests**

Test the JSON-RPC message parsing, session lifecycle, and response extraction. Mock subprocess spawning.

```typescript
import { describe, it, expect } from "bun:test";
import { parseCodexJsonRpc, type CodexRpcMessage } from "../agents/invoke-codex.js";

describe("invoke-codex", () => {
  describe("parseCodexJsonRpc", () => {
    it("parses a valid JSON-RPC response", () => {
      const line = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { type: "message", content: "Hello from Codex" },
      });
      const parsed = parseCodexJsonRpc(line);
      expect(parsed).not.toBeNull();
      expect(parsed!.id).toBe(1);
      expect(parsed!.result?.content).toBe("Hello from Codex");
    });

    it("parses a notification (no id)", () => {
      const line = JSON.stringify({
        jsonrpc: "2.0",
        method: "item/message",
        params: { content: "Working..." },
      });
      const parsed = parseCodexJsonRpc(line);
      expect(parsed).not.toBeNull();
      expect(parsed!.method).toBe("item/message");
    });

    it("returns null for invalid JSON", () => {
      expect(parseCodexJsonRpc("not-json{")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseCodexJsonRpc("")).toBeNull();
    });

    it("handles error responses", () => {
      const line = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32600, message: "Invalid request" },
      });
      const parsed = parseCodexJsonRpc(line);
      expect(parsed).not.toBeNull();
      expect(parsed!.error?.message).toBe("Invalid request");
    });
  });

  describe("extractCodexResponse", () => {
    // Import after the module is created
    it("extracts final text from a sequence of messages", async () => {
      const { extractCodexResponse } = await import("../agents/invoke-codex.js");
      const messages: CodexRpcMessage[] = [
        { jsonrpc: "2.0", method: "item/message", params: { content: "Let me think..." } },
        { jsonrpc: "2.0", method: "item/message", params: { content: "Here's the answer: 42" } },
      ];
      const result = extractCodexResponse(messages);
      expect(result).toContain("42");
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/invoke-codex.test.ts`
Expected: FAIL — module doesn't exist

**Step 3: Write the implementation**

```typescript
// src/agents/invoke-codex.ts
import { logger } from "../utils/logger.js";
import type { AgentConfig, InvocationResult } from "../types.js";
import type { TaskType } from "../providers/types.js";
import type { CLIProgress, InvokeOpts } from "./invoke.js";
import { ensureWorkspace } from "./workspace.js";
import { loadAndCompileSoul } from "../soul/index.js";
import { SSE_HEARTBEAT_INTERVAL_MS } from "../defaults.js";

// --- JSON-RPC types ---

export interface CodexRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** Parse a single line of JSON-RPC output from Codex. Returns null on invalid input. */
export function parseCodexJsonRpc(line: string): CodexRpcMessage | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line);
    if (parsed.jsonrpc !== "2.0") return null;
    return parsed as CodexRpcMessage;
  } catch {
    return null;
  }
}

/** Extract the final response text from a sequence of Codex RPC messages. */
export function extractCodexResponse(messages: CodexRpcMessage[]): string {
  // Collect all message content from notifications
  const textParts: string[] = [];
  for (const msg of messages) {
    if (msg.method === "item/message" && msg.params?.content) {
      textParts.push(msg.params.content as string);
    }
    // Also handle result messages (responses to our requests)
    if (msg.result?.content) {
      textParts.push(msg.result.content as string);
    }
  }
  return textParts[textParts.length - 1] ?? textParts.join("\n") ?? "";
}

// Task-type-aware timeouts (same as invoke-cli.ts)
const CODEX_TIMEOUTS: Record<string, number> = {
  orchestrator: 120 * 60,
  coding:        90 * 60,
  code_review:   45 * 60,
  expert:        45 * 60,
  analysis:      30 * 60,
};
const CODEX_DEFAULT_TIMEOUT = 20 * 60;

/**
 * Invoke an agent via the Codex CLI.
 * Spawns `codex` as a subprocess and communicates via stdin/stdout.
 *
 * Uses `codex --full-auto -q --json` for non-interactive execution:
 * - `--full-auto`: auto-approve all tool calls (equivalent to --dangerously-skip-permissions)
 * - `-q`: quiet mode (suppress interactive UI)
 * - `--json`: output JSON-RPC messages on stdout
 */
export async function invokeCodex(
  agent: AgentConfig,
  message: string,
  opts: InvokeOpts,
  startTime: number,
  taskType?: TaskType,
): Promise<InvocationResult> {
  const timeoutSec = CODEX_TIMEOUTS[taskType ?? ""] ?? CODEX_DEFAULT_TIMEOUT;

  // Build system prompt via soul compilation
  const { workspace } = await ensureWorkspace(agent, opts);
  let systemPrompt = opts.systemPrompt ?? "";
  try {
    const soul = await loadAndCompileSoul(agent, opts.config);
    if (soul) systemPrompt = soul;
  } catch (err) {
    logger.warn(`[invoke-codex] Soul compilation failed for ${agent.name}: ${err}`);
  }

  // Build the full prompt (system + user message)
  const fullPrompt = systemPrompt
    ? `${systemPrompt}\n\n---\n\n${message}`
    : message;

  // Spawn codex CLI
  const args = [
    "codex",
    "--full-auto",   // Auto-approve all actions
    "-q",            // Quiet (no interactive UI)
    "--json",        // JSON output mode
  ];

  // Add model if specified
  if (agent.model) {
    args.push("--model", agent.model);
  }

  // Add working directory
  if (workspace) {
    args.push("--cwd", workspace);
  }

  logger.info(`[invoke-codex] Spawning: ${args.join(" ")} (timeout: ${timeoutSec}s)`);

  const proc = Bun.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Codex reads its own auth from ~/.codex/auth.json
    },
    cwd: workspace ?? opts.baseDir,
  });

  // Send the prompt via stdin and close
  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(fullPrompt));
  await writer.close();

  // Collect output with timeout
  const messages: CodexRpcMessage[] = [];
  let fullOutput = "";

  const timeoutMs = timeoutSec * 1000;
  const deadline = Date.now() + timeoutMs;

  // Read stdout line by line
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        fullOutput += line + "\n";

        const rpc = parseCodexJsonRpc(line);
        if (rpc) {
          messages.push(rpc);

          // Auto-approve any approval requests
          if (rpc.method?.includes("requestApproval") && rpc.id != null) {
            const approval = JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result: { approved: true },
            }) + "\n";
            // Can't write after closing stdin in simple mode
            // Codex --full-auto handles this automatically
          }

          // Emit progress
          if (opts.onProgress && rpc.method === "item/message") {
            opts.onProgress({
              turns: messages.length,
              tokensIn: 0,
              tokensOut: 0,
              elapsed: (Date.now() - startTime) / 1000,
              activity: (rpc.params?.content as string)?.slice(0, 80),
              textDelta: rpc.params?.content as string,
              phase: "responding",
            });
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Wait for process to exit
  const exitCode = await proc.exited;
  const duration = Date.now() - startTime;

  // Capture stderr for diagnostics
  const stderr = await new Response(proc.stderr).text();
  if (stderr && exitCode !== 0) {
    logger.warn(`[invoke-codex] stderr: ${stderr.slice(0, 500)}`);
  }

  const response = extractCodexResponse(messages);

  if (!response && exitCode !== 0) {
    throw new Error(`Codex exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
  }

  logger.info(`[invoke-codex] Completed ${agent.name} in ${duration}ms (exit: ${exitCode}, messages: ${messages.length})`);

  return {
    response: response || "(no response from Codex)",
    agent: agent.name,
    method: "cli",
    task_type: taskType,
    model: agent.model,
    duration_ms: duration,
    tokens_in: 0,  // Codex doesn't expose token counts in JSON mode
    tokens_out: 0,
  };
}
```

**Step 4: Wire into invoke.ts routing**

In `src/agents/invoke.ts`, add import at top:
```typescript
import { invokeCodex } from "./invoke-codex.js";
```

Update the `always_cli` check (~line 183) to route codex:
```typescript
if (agent.always_cli && agent.cli_fallback) {
  logger.info(`[classify] ${JSON.stringify({ type: "orchestrator", method: "always_cli", confidence: 1.0, agent: agent.name, model: agent.model, provider: agent.provider, invocation: agent.cli_fallback === "codex" ? "codex" : "cli", message: message.slice(0, 80) })}`);
  logger.info(`[invoke] Routing: always_cli → ${agent.cli_fallback === "codex" ? "Codex" : "CLI"} for ${agent.name}`);
  if (agent.cli_fallback === "codex") {
    return invokeCodex(agent, message, opts, startTime, "orchestrator");
  }
  return invokeCLI(agent, message, opts, startTime, "orchestrator");
}
```

Also update the last-resort CLI fallback (~line 418):
```typescript
if (agent.cli_fallback && agent.cli_fallback !== "opencode" && agent.cli_fallback !== "codex") {
  // ... existing claude CLI fallback
}

// Last resort: Codex via explicit cli_fallback = "codex"
if (agent.cli_fallback === "codex") {
  fallbackIdx++;
  logger.info(`[invoke] [fallback ${fallbackIdx}/${totalFallbacks}] Last resort → Codex for ${agent.name}`);
  return invokeCodex(agent, message, opts, startTime, taskType);
}
```

**Step 5: Run tests**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/invoke-codex.test.ts`
Expected: All tests PASS

Run: `cd /home/user/dev/nyxhive && bunx tsc --noEmit && bun test`
Expected: Full suite passes, no type errors

**Step 6: Commit**

```bash
cd /home/user/dev/nyxhive
git add src/agents/invoke-codex.ts src/__tests__/invoke-codex.test.ts src/agents/invoke.ts
git commit -m "feat: add Codex CLI invocation module with JSON-RPC parsing"
```

---

### Task 5: Full Integration Verification

**Files:**
- No new files — verification only

**Step 1: Run full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All tests pass (existing + ~40 new tests)

**Step 2: Run type checker**

Run: `cd /home/user/dev/nyxhive && bunx tsc --noEmit`
Expected: No errors

**Step 3: Verify config schema accepts OpenAI provider**

Create a test snippet or manually verify that this TOML block would validate:
```toml
[providers.openai]
auth_mode = "codex"
default_model = "gpt-4.1"
```

**Step 4: Final commit (if any fixes needed)**

```bash
cd /home/user/dev/nyxhive
git add -A
git commit -m "chore: integration fixes for OpenAI + Codex support"
```

---

## Summary

| Task | Files | Tests | Description |
|------|-------|-------|-------------|
| 1 | `src/auth/codex-auth.ts` | ~10 | OAuth token reader + refresh + exchange |
| 2 | `src/providers/openai.ts` | ~15 | Chat Completions provider |
| 3 | 4 existing files | 0 (type/config changes) | Wire into routing, types, startup |
| 4 | `src/agents/invoke-codex.ts` + `invoke.ts` | ~5 | Codex CLI subprocess invocation |
| 5 | — | 0 | Full suite verification |

Total: 3 new files, 4 modified files, ~30 new tests.
