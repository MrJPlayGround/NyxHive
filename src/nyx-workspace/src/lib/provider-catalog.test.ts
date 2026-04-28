import { describe, expect, test } from 'bun:test'
import { PROVIDER_CATALOG } from './provider-catalog'

describe('provider catalog', () => {
  test('only exposes auth flows wired in Nyx Workspace', () => {
    for (const provider of PROVIDER_CATALOG) {
      expect(provider.authTypes.every((type) => type === 'api-key' || type === 'local')).toBe(true)
    }
  })
})
