import { describe, expect, test } from 'bun:test'
import { createGatewayAuthHeaders } from './gateway-auth-headers'
import { isGatewayApiProbeResponse } from './gateway-probe-response'

describe('gateway auth headers', () => {
  test('omits auth headers when no token is configured', () => {
    expect(createGatewayAuthHeaders('')).toEqual({})
  })

  test('marks authenticated workspace calls as internal clients', () => {
    expect(createGatewayAuthHeaders('test-token')).toEqual({
      Authorization: 'Bearer test-token',
      'X-Client-Type': 'nyx-internal',
    })
  })
})

describe('gateway capability probes', () => {
  test('does not treat SPA HTML fallbacks as available API endpoints', () => {
    const response = new Response('<!DOCTYPE html><title>Gateway</title>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })

    expect(isGatewayApiProbeResponse(response)).toBe(false)
  })

  test('accepts API-like success and method errors as available endpoints', () => {
    expect(
      isGatewayApiProbeResponse(
        Response.json({ ok: true }, { status: 200 }),
      ),
    ).toBe(true)
    expect(isGatewayApiProbeResponse(new Response('', { status: 405 }))).toBe(
      true,
    )
  })

  test('rejects absent or catch-all rejected API endpoints', () => {
    expect(isGatewayApiProbeResponse(Response.json({}, { status: 404 }))).toBe(
      false,
    )
    expect(isGatewayApiProbeResponse(Response.json({}, { status: 403 }))).toBe(
      false,
    )
  })
})
