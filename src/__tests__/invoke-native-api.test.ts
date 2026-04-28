import { afterEach, beforeEach, describe, expect, it, mock, spyOn, type Mock } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentConfig, NyxHiveConfig } from "../types.js";
import type { InvokeOpts } from "../agents/invoke.js";

import { invokeNativeAPI } from "../agents/invoke-native-api.js";
import * as nativeMcpModule from "../agents/native-mcp-client.js";
import { ProceduralSkillDraftStore } from "../memory/procedural-skills.js";
import { DelegationRunStore } from "../runs/store.js";

function makeAgent(): AgentConfig {
  return {
    name: "Strider",
    role: "orchestrator",
    provider: "openai",
    model: "gpt-4o-mini",
    working_directory: "./workspace/strider",
    system_prompt: "You are Strider.",
    capabilities: ["tool_use"],
    mcp_tools: ["search_knowledge", "list_proposals"],
  };
}

function makeConfig(): NyxHiveConfig {
  return {
    daemon: {
      name: "Strider",
    },
    server: {
      port: 3776,
      api_key: "local-api-key",
    },
    agents: {
      strider: makeAgent(),
    },
    providers: {
      openai: {
        api_key_env: "OPENAI_API_KEY",
      },
    },
    remotes: {
      nyxai: {
        url: "http://localhost:3777",
        api_key_env: "NYXAI_REMOTE_API_KEY",
        agents: ["strider"],
      },
      nyxlabs: {
        url: "http://localhost:3778",
        api_key_env: "NYXLABS_REMOTE_API_KEY",
        agents: ["*"],
      },
      aether: {
        url: "http://localhost:3779/root",
        api_key_env: "AETHER_REMOTE_API_KEY",
        agents: ["strider"],
      },
    },
  } as unknown as NyxHiveConfig;
}

function makeStreamResponse(): Response {
  const payload = [
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      model: "gpt-4o-mini",
      choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      model: "gpt-4o-mini",
      usage: { prompt_tokens: 11, completion_tokens: 7 },
      choices: [{ delta: {}, finish_reason: "stop" }],
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");

  return new Response(payload, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("invokeNativeAPI", () => {
  let originalFetch: typeof fetch;
  let tempDir: string;
  let capturedBody: Record<string, unknown> | undefined;
  let createMultiMcpBridgeSpy: Mock<typeof nativeMcpModule.createMultiMcpBridge> | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nyxhive-native-api-"));
    capturedBody = undefined;
    createMultiMcpBridgeSpy = spyOn(nativeMcpModule, "createMultiMcpBridge").mockImplementation(async () => ({
      apiTools: [
        {
          type: "function" as const,
          function: {
            name: "mcp__nyxai__search_knowledge",
            description: "Search NyxAI knowledge",
            parameters: { type: "object", properties: {} },
          },
        },
        {
          type: "function" as const,
          function: {
            name: "mcp__nyxlabs__list_proposals",
            description: "List NyxLabs proposals",
            parameters: { type: "object", properties: {} },
          },
        },
        {
          type: "function" as const,
          function: {
            name: "mcp__aether__search_knowledge",
            description: "Search Aether knowledge",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      callTool: async () => "(unused)",
      close: async () => {},
    }));
    originalFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = "openai-test-key";
    process.env.NYXAI_REMOTE_API_KEY = "nyxai-key";
    process.env.NYXLABS_REMOTE_API_KEY = "nyxlabs-key";
    process.env.AETHER_REMOTE_API_KEY = "aether-key";
    globalThis.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return makeStreamResponse();
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    createMultiMcpBridgeSpy?.mockRestore();
    createMultiMcpBridgeSpy = undefined;
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.OPENAI_API_KEY;
    delete process.env.NYXAI_REMOTE_API_KEY;
    delete process.env.NYXLABS_REMOTE_API_KEY;
    delete process.env.AETHER_REMOTE_API_KEY;
  });

  it("exposes local read-only tools plus remote MCP tools for orchestrator agents", async () => {
    const result = await invokeNativeAPI(
      makeAgent(),
      "List available tools.",
      {
        baseDir: tempDir,
        config: makeConfig(),
        agentKey: "strider",
      } satisfies InvokeOpts,
      Date.now(),
      "orchestrator",
    );

    expect(result.method).toBe("api");
    expect(result.response).toBe("done");
    expect(createMultiMcpBridgeSpy).toHaveBeenCalledTimes(1);
    expect(createMultiMcpBridgeSpy?.mock.calls[0]?.[0]).toEqual([
      {
        mcpUrl: "http://localhost:3776/api/mcp",
        apiKey: "local-api-key",
        toolFilter: ["search_knowledge", "list_proposals"],
        slug: "strider",
      },
      expect.objectContaining({
        mcpUrl: "http://localhost:3777/api/mcp",
        apiKey: "nyxai-key",
        toolFilter: ["search_knowledge", "list_proposals"],
        slug: "nyxai",
        name: "nyxai",
        onRemoteDown: expect.any(Function),
      }),
      expect.objectContaining({
        mcpUrl: "http://localhost:3778/api/mcp",
        apiKey: "nyxlabs-key",
        toolFilter: ["search_knowledge", "list_proposals"],
        slug: "nyxlabs",
        name: "nyxlabs",
        onRemoteDown: expect.any(Function),
      }),
      expect.objectContaining({
        mcpUrl: "http://localhost:3779/root/api/mcp",
        apiKey: "aether-key",
        toolFilter: ["search_knowledge", "list_proposals"],
        slug: "aether",
        name: "aether",
        onRemoteDown: expect.any(Function),
      }),
    ]);

    const toolNames = ((capturedBody?.tools as Array<{ function: { name: string } }>) ?? []).map((tool) => tool.function.name);
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("search_knowledge");
    expect(toolNames).toContain("todo_write");
    expect(toolNames).toContain("mcp__nyxai__search_knowledge");
    expect(toolNames).toContain("mcp__nyxlabs__list_proposals");
    expect(toolNames).toContain("mcp__aether__search_knowledge");
    expect(toolNames).not.toContain("write_file");
    expect(toolNames).not.toContain("run_command");
  });

  it("skips tool and MCP setup when toolMode is off", async () => {
    await invokeNativeAPI(
      makeAgent(),
      "Just talk to me like a companion.",
      {
        baseDir: tempDir,
        config: makeConfig(),
        agentKey: "strider",
        toolMode: "off",
      } satisfies InvokeOpts,
      Date.now(),
      "conversation",
    );

    expect(createMultiMcpBridgeSpy).not.toHaveBeenCalled();
    expect(capturedBody?.tools).toBeUndefined();
  });

  it("narrows MCP tools by task profile while keeping local tools available", async () => {
    const result = await invokeNativeAPI(
      makeAgent(),
      "Just talk to me like a companion.",
      {
        baseDir: tempDir,
        config: makeConfig(),
        agentKey: "strider",
      } satisfies InvokeOpts,
      Date.now(),
      "conversation",
    );

    expect(createMultiMcpBridgeSpy).not.toHaveBeenCalled();
    expect(result.context_budget).toEqual({
      mcp_profile: "conversation",
      mcp_requested_tools: 2,
      mcp_exposed_tools: 0,
      mcp_dropped_tools: ["search_knowledge", "list_proposals"],
      estimated_mcp_schema_tokens: 0,
      estimated_mcp_saved_tokens: 1000,
    });

    const toolNames = ((capturedBody?.tools as Array<{ function: { name: string } }>) ?? []).map((tool) => tool.function.name);
    expect(toolNames).toContain("read_file");
    expect(toolNames).not.toContain("mcp__nyxai__search_knowledge");
  });

  it("records selected procedural skills as successful on a completed native run", async () => {
    const store = new ProceduralSkillDraftStore(new Database(":memory:"));
    const draft = store.create({
      sourceHash: "hash-native-success",
      agentKey: "strider",
      conversationId: "session-123",
      title: "Workflow: inspect relay callback routes",
      summary: "Audit relay callback identity and verify nonce dedup.",
      draftMarkdown: "Inspect src/server/routes/relay.ts and verify nonce dedup.",
    });
    store.publish(draft.id, "auto-relay-native");

    await invokeNativeAPI(
      makeAgent(),
      "Audit relay callback identity and verify nonce dedup in src/server/routes/relay.ts.",
      {
        baseDir: tempDir,
        config: makeConfig(),
        agentKey: "strider",
        sessionId: "session-123",
        proceduralSkills: store,
      } satisfies InvokeOpts,
      Date.now(),
      "analysis",
    );

    const updated = store.getById(draft.id);
    expect(updated?.usage_count).toBe(1);
    expect(updated?.success_count).toBe(1);
    expect(updated?.last_success_at).not.toBeNull();
  });

  it("records provider blocked paths when native API omits accepted files before model handoff", async () => {
    const runsDir = join(tempDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    const runs = new DelegationRunStore(runsDir, "native-file-blockers");
    const run = runs.createRun({
      run_id: "run-native-files",
      message_id: "msg-native-files",
      trace_id: "trace-native-files",
      task_description: "Transcribe the attached audio.",
      agent: "strider",
      brain: "sdk",
      status: "running",
    });

    await invokeNativeAPI(
      makeAgent(),
      "Transcribe this audio.",
      {
        baseDir: tempDir,
        config: makeConfig(),
        agentKey: "strider",
        messageId: "msg-native-files",
        channel: "api",
        traceId: "trace-native-files",
        runId: run.run_id,
        runs,
        files: [
          {
            name: "clip.mp3",
            mimeType: "audio/mpeg",
            base64: "AAEC",
            size: 3,
          },
        ],
      },
      Date.now(),
      "analysis",
    );

    const messages = capturedBody?.messages as Array<{ role: string; content: string }> | undefined;
    expect(JSON.stringify(messages)).not.toContain("clip.mp3");

    const blockedPaths = runs.listBlockedPaths({ run_id: run.run_id, limit: 10 });
    expect(blockedPaths).toHaveLength(1);
    expect(blockedPaths[0]).toMatchObject({
      run_id: run.run_id,
      message_id: "msg-native-files",
      trace_id: "trace-native-files",
      channel: "api",
      area: "provider",
      failed_path: "native_api.openai.gpt-4o-mini.files[clip.mp3]",
      missing_primitive: "provider.file.native_api_attachment_transport",
      next_action: "fix",
      requires_approval: false,
    });
    expect(blockedPaths[0]?.trigger).toContain("clip.mp3");
    expect(blockedPaths[0]?.impact).toContain("not available to the model");
  });
});
