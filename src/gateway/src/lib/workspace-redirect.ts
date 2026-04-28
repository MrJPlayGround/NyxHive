const WORKSPACE_APP_PORT_BY_GATEWAY_PORT: Record<string, string> = {
  "3778": "3781",
  "3779": "3777",
};

type LocationLike = {
  protocol: string;
  hostname: string;
  port: string;
};

export function resolveWorkspaceOperationsUrl(location: LocationLike): string {
  const appPort = WORKSPACE_APP_PORT_BY_GATEWAY_PORT[location.port] ?? "3777";
  return `${location.protocol}//${location.hostname}:${appPort}/operations`;
}
