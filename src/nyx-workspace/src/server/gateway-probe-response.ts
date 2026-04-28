export function isGatewayApiProbeResponse(response: Response): boolean {
  if (response.status === 404 || response.status === 403) return false

  const contentType = response.headers.get('content-type')?.toLowerCase() || ''
  if (contentType.includes('text/html')) return false

  return response.ok || [400, 405, 422].includes(response.status)
}
