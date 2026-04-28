export function createGatewayAuthHeaders(
  token: string,
): Record<string, string> {
  if (!token) return {}
  return {
    Authorization: `Bearer ${token}`,
    'X-Client-Type': 'nyx-internal',
  }
}
