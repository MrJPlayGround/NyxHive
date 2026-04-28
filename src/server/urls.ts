import type { NyxHiveConfig } from "../types.js";

type ServerConfigLike = Pick<NyxHiveConfig, "server"> | { server?: { port?: number; public_url?: string } };
type RemoteConfigLike = Pick<NyxHiveConfig, "server" | "remotes">;
type RemotesOnlyConfigLike = Pick<NyxHiveConfig, "remotes">;

function normalizeUrlPath(pathname: string): string {
  if (!pathname || pathname === "/") return "";
  return pathname.replace(/\/+$/, "");
}

function buildUrlWithPath(baseUrl: string, pathSuffix: string): string {
  const url = new URL(baseUrl);
  if (!url.pathname.endsWith(pathSuffix)) {
    url.pathname = `${normalizeUrlPath(url.pathname)}${pathSuffix}`;
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function toMcpSlug(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || "remote";
}

export function resolveServerBaseUrl(config?: ServerConfigLike): string | undefined {
  const publicUrl = config?.server?.public_url?.trim();
  if (publicUrl) {
    const url = new URL(publicUrl);
    url.pathname = normalizeUrlPath(url.pathname);
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  const port = config?.server?.port;
  if (!port) return undefined;
  return `http://localhost:${port}/`;
}

export function resolveMcpEndpointUrl(config?: ServerConfigLike): string | undefined {
  const baseUrl = resolveServerBaseUrl(config);
  if (!baseUrl) return undefined;
  return buildUrlWithPath(baseUrl, "/api/mcp");
}

export function resolveRelayCallbackUrl(config?: ServerConfigLike): string | undefined {
  const baseUrl = resolveServerBaseUrl(config);
  if (!baseUrl) return undefined;
  return buildUrlWithPath(baseUrl, "/api/relay/callback");
}

export function resolveRemoteMcpEndpointUrl(baseUrl: string): string {
  return buildUrlWithPath(baseUrl, "/api/mcp");
}

export interface ResolvedRemoteMcpEndpoint {
  name: string;
  slug: string;
  url: string;
  api_key_env: string;
  description?: string;
}

export function resolveConfiguredRemoteMcpEndpoints(
  config?: RemotesOnlyConfigLike,
  agentNames?: string[],
  opts: { requireAgentAllowlist?: boolean } = {},
): ResolvedRemoteMcpEndpoint[] {
  const remotes = config?.remotes;
  if (!remotes) return [];

  const wantedAgents = new Set((agentNames ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean));

  return Object.entries(remotes).flatMap(([name, remote]) => {
    const allowedAgents = remote.agents?.map((agent) => agent.trim().toLowerCase()).filter(Boolean);
    if (opts.requireAgentAllowlist && (!allowedAgents?.length || wantedAgents.size === 0)) {
      return [];
    }
    if (allowedAgents?.length && wantedAgents.size > 0 && !allowedAgents.some((agent) => agent === "*" || wantedAgents.has(agent))) {
      return [];
    }

    return [{
      name,
      slug: toMcpSlug(name),
      url: resolveRemoteMcpEndpointUrl(remote.url),
      api_key_env: remote.api_key_env,
      description: remote.description,
    }];
  });
}

export function describeServerContract(config: RemoteConfigLike): {
  base_url?: string;
  mcp_url?: string;
  relay_callback_url?: string;
  public_url_configured: boolean;
  remote_contract_ready: boolean;
  warnings: string[];
} {
  const baseUrl = resolveServerBaseUrl(config);
  const publicUrlConfigured = !!config.server?.public_url?.trim();
  const hasRemotes = Object.keys(config.remotes ?? {}).length > 0;
  const warnings: string[] = [];

  if (hasRemotes && !publicUrlConfigured) {
    warnings.push("server.public_url is not set; remote MCP discovery and reverse relay require an externally reachable URL.");
  }

  return {
    base_url: baseUrl,
    mcp_url: resolveMcpEndpointUrl(config),
    relay_callback_url: resolveRelayCallbackUrl(config),
    public_url_configured: publicUrlConfigured,
    remote_contract_ready: !hasRemotes || publicUrlConfigured,
    warnings,
  };
}
