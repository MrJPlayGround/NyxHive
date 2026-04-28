import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

interface MockEndpointState {
  connectError?: string;
  listTools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  listToolsError?: string;
  callResults?: Record<string, string>;
  callError?: Record<string, string>;
  closeCount?: number;
}

const endpointState = new Map<string, MockEndpointState>();

class MockStreamableHTTPClientTransport {
  constructor(
    public url: URL,
    public options: { requestInit?: { headers?: Record<string, string> } },
  ) {}
}

class MockClient {
  private endpointUrl = "";

  async connect(transport: MockStreamableHTTPClientTransport): Promise<void> {
    this.endpointUrl = transport.url.toString();
    const state = endpointState.get(this.endpointUrl);
    if (state?.connectError) {
      throw new Error(state.connectError);
    }
  }

  async listTools(): Promise<{ tools: NonNullable<MockEndpointState["listTools"]> }> {
    const state = endpointState.get(this.endpointUrl) ?? {};
    if (state.listToolsError) {
      throw new Error(state.listToolsError);
    }
    return { tools: state.listTools ?? [] };
  }

  async callTool(args: { name: string }): Promise<{ content: Array<{ type: string; text: string }> }> {
    const state = endpointState.get(this.endpointUrl) ?? {};
    const error = state.callError?.[args.name];
    if (error) {
      throw new Error(error);
    }
    return {
      content: [{ type: "text", text: state.callResults?.[args.name] ?? `${this.endpointUrl}:${args.name}` }],
    };
  }

  async close(): Promise<void> {
    const state = endpointState.get(this.endpointUrl);
    if (state) state.closeCount = (state.closeCount ?? 0) + 1;
  }
}

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: MockClient,
}));

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockStreamableHTTPClientTransport,
}));

import { createMcpBridge, createMultiMcpBridge } from "../agents/native-mcp-client.js";

describe("native MCP client bridge", () => {
  beforeEach(() => {
    endpointState.clear();
  });

  afterEach(() => {
    endpointState.clear();
  });

  it("merges tools across multiple endpoints and tolerates partial failure", async () => {
    endpointState.set("http://localhost:3777/api/mcp", {
      listTools: [
        { name: "search_knowledge", description: "Search knowledge" },
        { name: "list_agents", description: "List agents" },
      ],
      callResults: { search_knowledge: "nyxai knowledge" },
    });
    endpointState.set("http://localhost:3778/api/mcp", {
      listTools: [
        { name: "list_proposals", description: "List proposals" },
      ],
      callResults: { list_proposals: "nyxlabs proposals" },
    });
    endpointState.set("http://localhost:3779/api/mcp", {
      connectError: "ECONNREFUSED",
    });

    const bridge = await createMultiMcpBridge([
      { mcpUrl: "http://localhost:3777/api/mcp", apiKey: "a", toolFilter: ["search_knowledge"], slug: "nyxai" },
      { mcpUrl: "http://localhost:3778/api/mcp", apiKey: "b", toolFilter: ["list_proposals"], slug: "nyxlabs" },
      { mcpUrl: "http://localhost:3779/api/mcp", apiKey: "c", toolFilter: ["search_knowledge"], slug: "aether" },
    ]);

    expect(bridge).not.toBeNull();
    expect(bridge!.apiTools.map((tool) => tool.function.name).sort()).toEqual([
      "mcp__nyxai__search_knowledge",
      "mcp__nyxlabs__list_proposals",
    ]);
    await expect(bridge!.callTool("mcp__nyxai__search_knowledge", { query: "fleet" })).resolves.toBe("nyxai knowledge");
    await expect(bridge!.callTool("mcp__nyxlabs__list_proposals", {})).resolves.toBe("nyxlabs proposals");
    await expect(bridge!.callTool("mcp__aether__search_knowledge", {})).resolves.toContain("unknown MCP tool");

    await bridge!.close();
    expect(endpointState.get("http://localhost:3777/api/mcp")?.closeCount).toBe(1);
    expect(endpointState.get("http://localhost:3778/api/mcp")?.closeCount).toBe(1);
    expect(endpointState.get("http://localhost:3779/api/mcp")?.closeCount).toBeUndefined();
  });

  it("keeps single-endpoint compatibility through createMcpBridge", async () => {
    endpointState.set("http://localhost:3777/api/mcp", {
      listTools: [{ name: "search_knowledge", description: "Search knowledge" }],
      callResults: { search_knowledge: "ok" },
    });

    const bridge = await createMcpBridge(
      "http://localhost:3777/api/mcp",
      "secret",
      ["search_knowledge"],
      "nyxai",
    );

    expect(bridge?.apiTools.map((tool) => tool.function.name)).toEqual(["mcp__nyxai__search_knowledge"]);
    await expect(bridge?.callTool("mcp__nyxai__search_knowledge", { query: "x" })).resolves.toBe("ok");
  });
});
