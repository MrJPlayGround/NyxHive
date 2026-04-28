import { describe, expect, it } from "bun:test";
import {
  describeServerContract,
  resolveConfiguredRemoteMcpEndpoints,
  resolveMcpEndpointUrl,
  resolveRelayCallbackUrl,
  resolveRemoteMcpEndpointUrl,
  resolveServerBaseUrl,
  toMcpSlug,
} from "../server/urls.js";

describe("server urls", () => {
  it("falls back to localhost when no public URL is configured", () => {
    expect(resolveServerBaseUrl({ server: { port: 3777 } })).toBe("http://localhost:3777/");
    expect(resolveMcpEndpointUrl({ server: { port: 3777 } })).toBe("http://localhost:3777/api/mcp");
  });

  it("builds the MCP route from a configured public base URL", () => {
    expect(resolveServerBaseUrl({ server: { port: 3777, public_url: "https://nyx.example.com/core/" } }))
      .toBe("https://nyx.example.com/core");
    expect(resolveMcpEndpointUrl({ server: { port: 3777, public_url: "https://nyx.example.com/core/" } }))
      .toBe("https://nyx.example.com/core/api/mcp");
  });

  it("preserves an explicit MCP endpoint path", () => {
    expect(resolveMcpEndpointUrl({ server: { port: 3777, public_url: "https://nyx.example.com/api/mcp" } }))
      .toBe("https://nyx.example.com/api/mcp");
  });

  it("derives remote MCP URLs from remote base URLs", () => {
    expect(resolveRemoteMcpEndpointUrl("http://localhost:3778")).toBe("http://localhost:3778/api/mcp");
    expect(resolveRemoteMcpEndpointUrl("https://labs.example.com/core/")).toBe("https://labs.example.com/core/api/mcp");
    expect(resolveRemoteMcpEndpointUrl("https://labs.example.com/api/mcp")).toBe("https://labs.example.com/api/mcp");
  });

  it("normalizes remote names into MCP-safe slugs", () => {
    expect(toMcpSlug("Nyx Labs")).toBe("nyx_labs");
    expect(toMcpSlug("Aether")).toBe("aether");
  });

  it("filters configured remote MCP endpoints by agent allowlist", () => {
    expect(resolveConfiguredRemoteMcpEndpoints({
      remotes: {
        nyxai: { url: "http://localhost:3777", api_key_env: "NYXAI_KEY", agents: ["strider"] },
        nyxlabs: { url: "http://localhost:3778/base", api_key_env: "NYXLABS_KEY" },
        aether: { url: "http://localhost:3779", api_key_env: "AETHER_KEY", agents: ["other"] },
      },
    }, ["strider"])).toEqual([
      {
        name: "nyxai",
        slug: "nyxai",
        url: "http://localhost:3777/api/mcp",
        api_key_env: "NYXAI_KEY",
        description: undefined,
      },
      {
        name: "nyxlabs",
        slug: "nyxlabs",
        url: "http://localhost:3778/base/api/mcp",
        api_key_env: "NYXLABS_KEY",
        description: undefined,
      },
    ]);
  });

  it("can require explicit remote MCP agent grants for tool exposure", () => {
    expect(resolveConfiguredRemoteMcpEndpoints({
      remotes: {
        nyxai: { url: "http://localhost:3777", api_key_env: "NYXAI_KEY", agents: ["strider"] },
        shared: { url: "http://localhost:3778", api_key_env: "SHARED_KEY", agents: ["*"] },
        implicit: { url: "http://localhost:3779", api_key_env: "IMPLICIT_KEY" },
      },
    }, ["strider"], { requireAgentAllowlist: true }).map((endpoint) => endpoint.name)).toEqual([
      "nyxai",
      "shared",
    ]);
  });

  it("builds the relay callback route from the advertised server URL", () => {
    expect(resolveRelayCallbackUrl({ server: { port: 3777, public_url: "https://nyx.example.com/core/" } } as any))
      .toBe("https://nyx.example.com/core/api/relay/callback");
  });

  it("flags remotes without a public URL", () => {
    expect(describeServerContract({
      server: { port: 3777 },
      remotes: {
        trading: { url: "https://trading.example.com", api_key_env: "TRADING_API_KEY" },
      },
    } as any)).toEqual({
      base_url: "http://localhost:3777/",
      mcp_url: "http://localhost:3777/api/mcp",
      relay_callback_url: "http://localhost:3777/api/relay/callback",
      public_url_configured: false,
      remote_contract_ready: false,
      warnings: [
        "server.public_url is not set; remote MCP discovery and reverse relay require an externally reachable URL.",
      ],
    });
  });
});
