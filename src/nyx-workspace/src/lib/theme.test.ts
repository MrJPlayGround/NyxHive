import { describe, expect, test } from 'bun:test'
import { normalizeTheme } from './theme'

describe('theme identity migration', () => {
  test('uses Nyx-native theme ids', () => {
    expect(normalizeTheme('nyx-official')).toBe('nyx-official')
  })

  test('maps legacy Hermes theme ids without exposing them as primary ids', () => {
    expect(normalizeTheme('hermes-official')).toBe('nyx-official')
    expect(normalizeTheme('hermes-slate-light')).toBe('nyx-slate-light')
  })
})
