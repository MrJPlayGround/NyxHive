/**
 * Lightweight MCP client bridge for the native API tool-execution loop.
 *
 * Claude CLI agents get MCP tools via --mcp-config. Native API (GPT/OpenRouter) agents
 * had no equivalent — this module fills that gap by connecting to the NyxHive MCP server
 * via StreamableHTTP and exposing its tools as OpenAI function-call definitions.
 *
 * Tool naming convention mirrors Claude CLI: mcp__<slug>__<toolname>
 * Tool descriptions are capped at 1024 chars (OpenAI API + ForgeCode standard).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "../utils/logger.js";

// ForgeCode tool description limit — exceeding this silently truncates on some providers
const MAX_TOOL_DESCRIPTION_CHARS = 1024;

/** Max retries for transient MCP tool call failures (network blips, 503s). */
const MAX_MCP_RETRIES = 2;

/**
 * Error patterns that indicate a transient failure worth retrying.
 * Permanent errors (unknown tool, bad args, auth failure) are not retried.
 */
const TRANSIENT_MCP_PATTERNS = [
  /timeout/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /network/i,
  /temporarily unavailable/i,
  /503/,
  /502/,
  /try again/i,
];

function isTransientMcpError(err: unknown): boolean {
  const msg = String(err);
  return TRANSIENT_MCP_PATTERNS.some((p) => p.test(msg));
}

export interface NativeMcpAPITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface McpToolBridge {
  /** Tools ready to be merged into the OpenAI API tools array */
  apiTools: NativeMcpAPITool[];
  /** Call an MCP tool by its prefixed name (mcp__slug__toolname) */
  callTool(prefixedName: string, args: Record<string, unknown>): Promise<string>;
  /** Release the MCP client connection */
  close(): Promise<void>;
}

export interface McpBridgeEndpoint {
  mcpUrl: string;
  apiKey: string;
  toolFilter: string[];
  slug: string;
  name?: string;
  onRemoteDown?: (info: { slug: string; url: string; reason: string; availableTools?: string[] }) => void;
}

interface ConnectedMcpEndpoint {
  apiTools: NativeMcpAPITool[];
  client: Client;
  nameMap: Map<string, string>;
  slug: string;
}

async function connectMcpEndpoint(endpoint: McpBridgeEndpoint): Promise<ConnectedMcpEndpoint | null> {
  const client = new Client({ name: "nyxhive-native-api", version: "1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(endpoint.mcpUrl),
    { requestInit: { headers: { Authorization: `Bearer ${endpoint.apiKey}` } } },
  );

  try {
    await client.connect(transport);
  } catch (err) {
    logger.warn(`[mcp-bridge] Could not connect to ${endpoint.mcpUrl}: ${err}. Proceeding without MCP tools.`);
    endpoint.onRemoteDown?.({
      slug: endpoint.slug,
      url: endpoint.mcpUrl,
      reason: String(err),
    });
    return null;
  }

  let rawTools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  try {
    const result = await client.listTools();
    rawTools = result.tools;
  } catch (err) {
    logger.warn(`[mcp-bridge] listTools failed for ${endpoint.mcpUrl}: ${err}. Proceeding without MCP tools.`);
    endpoint.onRemoteDown?.({
      slug: endpoint.slug,
      url: endpoint.mcpUrl,
      reason: String(err),
    });
    await client.close().catch(() => {});
    return null;
  }

  const filterSet = new Set(endpoint.toolFilter.map((t) => t.toLowerCase()));
  const matched = rawTools.filter((t) => filterSet.has(t.name.toLowerCase()));

  if (matched.length === 0) {
    logger.debug(`[mcp-bridge] No tools matched filter [${endpoint.toolFilter.join(",")}] from ${rawTools.length} available on ${endpoint.mcpUrl}. Closing.`);
    await client.close().catch(() => {});
    return null;
  }

  logger.info(`[mcp-bridge] Connected to ${endpoint.mcpUrl} — ${matched.length}/${rawTools.length} tools loaded for slug="${endpoint.slug}"`);

  const nameMap = new Map<string, string>();
  const apiTools: NativeMcpAPITool[] = matched.map((t) => {
    const prefixedName = `mcp__${endpoint.slug}__${t.name}`;
    nameMap.set(prefixedName, t.name);
    return {
      type: "function" as const,
      function: {
        name: prefixedName,
        description: (t.description ?? t.name).slice(0, MAX_TOOL_DESCRIPTION_CHARS),
        parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      },
    };
  });

  return {
    apiTools,
    client,
    nameMap,
    slug: endpoint.slug,
  };
}

export async function createMultiMcpBridge(
  endpoints: McpBridgeEndpoint[],
): Promise<McpToolBridge | null> {
  if (endpoints.length === 0) return null;

  const connected = (await Promise.all(endpoints.map((endpoint) => connectMcpEndpoint(endpoint))))
    .filter((endpoint): endpoint is ConnectedMcpEndpoint => endpoint !== null);

  if (connected.length === 0) return null;

  const routeMap = new Map<string, { client: Client; rawName: string; slug: string }>();
  const apiTools: NativeMcpAPITool[] = [];

  for (const endpoint of connected) {
    apiTools.push(...endpoint.apiTools);
    for (const [prefixedName, rawName] of endpoint.nameMap) {
      if (routeMap.has(prefixedName)) {
        logger.warn(`[mcp-bridge] Duplicate MCP tool name "${prefixedName}" detected. Keeping first registration.`);
        continue;
      }
      routeMap.set(prefixedName, { client: endpoint.client, rawName, slug: endpoint.slug });
    }
  }

  return {
    apiTools,

    async callTool(prefixedName: string, args: Record<string, unknown>): Promise<string> {
      const route = routeMap.get(prefixedName);
      if (!route) {
        return `Error: unknown MCP tool "${prefixedName}" — not in bridge (available: ${[...routeMap.keys()].join(", ")})`;
      }

      let lastErr: unknown;
      for (let attempt = 0; attempt <= MAX_MCP_RETRIES; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
          logger.debug(`[mcp-bridge] Retrying ${route.rawName} on ${route.slug} (attempt ${attempt + 1}/${MAX_MCP_RETRIES + 1})`);
        }
        try {
          const result = await route.client.callTool({ name: route.rawName, arguments: args });
          const content = result.content as Array<{ type: string; text?: string }>;
          const text = content
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text!)
            .join("\n");
          return text || "(empty MCP response)";
        } catch (err) {
          lastErr = err;
          if (!isTransientMcpError(err)) break;
        }
      }
      const failedEndpoint = endpoints.find((endpoint) => endpoint.slug === route.slug);
      failedEndpoint?.onRemoteDown?.({
        slug: route.slug,
        url: failedEndpoint.mcpUrl,
        reason: String(lastErr),
        availableTools: apiTools.map((tool) => tool.function.name),
      });
      return `Error: MCP tool "${route.rawName}" failed: ${lastErr}`;
    },

    async close(): Promise<void> {
      await Promise.all(connected.map((endpoint) => endpoint.client.close().catch(() => {})));
    },
  };
}

/**
 * Connect to the NyxHive MCP endpoint, list available tools, filter to requested subset,
 * and return a bridge object for use in the native API tool-execution loop.
 *
 * Returns null if the server is unreachable or no matching tools are found —
 * the caller should proceed without MCP tools rather than failing.
 */
export async function createMcpBridge(
  mcpUrl: string,
  apiKey: string,
  toolFilter: string[],
  slug: string,
): Promise<McpToolBridge | null> {
  return createMultiMcpBridge([{ mcpUrl, apiKey, toolFilter, slug }]);
}
