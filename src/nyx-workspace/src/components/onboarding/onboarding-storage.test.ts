import { describe, expect, test } from 'bun:test'
import {
  INITIAL_SETUP_KEY,
  LEGACY_CONFIGURED_KEY,
  PRODUCT_TOUR_KEY,
  canSkipInitialSetup,
  clearInitialSetup,
  hasCompletedInitialSetup,
  markInitialSetupComplete,
} from './onboarding-storage'

function createStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
}

describe('onboarding storage', () => {
  test('treats current and legacy setup keys as complete', () => {
    const storage = createStorage()

    expect(hasCompletedInitialSetup(storage)).toBe(false)

    storage.setItem(INITIAL_SETUP_KEY, 'true')
    expect(hasCompletedInitialSetup(storage)).toBe(true)

    clearInitialSetup(storage)
    storage.setItem(LEGACY_CONFIGURED_KEY, 'true')
    expect(hasCompletedInitialSetup(storage)).toBe(true)
  })

  test('markInitialSetupComplete writes every key needed to avoid duplicate onboarding', () => {
    const storage = createStorage()

    markInitialSetupComplete(storage)

    expect(storage.getItem(INITIAL_SETUP_KEY)).toBe('true')
    expect(storage.getItem(LEGACY_CONFIGURED_KEY)).toBe('true')
    expect(storage.getItem(PRODUCT_TOUR_KEY)).toBe('true')
  })

  test('clearInitialSetup removes setup and tour keys', () => {
    const storage = createStorage()

    markInitialSetupComplete(storage)
    clearInitialSetup(storage)

    expect(storage.getItem(INITIAL_SETUP_KEY)).toBeNull()
    expect(storage.getItem(LEGACY_CONFIGURED_KEY)).toBeNull()
    expect(storage.getItem(PRODUCT_TOUR_KEY)).toBeNull()
  })

  test('canSkipInitialSetup requires chat support and configured model or provider', () => {
    expect(
      canSkipInitialSetup(
        { capabilities: { chatCompletions: true } },
        { activeModel: 'gpt-5.4' },
      ),
    ).toBe(true)
    expect(
      canSkipInitialSetup(
        { capabilities: { chatCompletions: true } },
        { activeProvider: 'openai-codex' },
      ),
    ).toBe(true)
    expect(
      canSkipInitialSetup(
        { capabilities: { chatCompletions: false } },
        { activeModel: 'gpt-5.4' },
      ),
    ).toBe(false)
    expect(
      canSkipInitialSetup(
        { capabilities: { sessions: true, chatCompletions: false } },
        {},
      ),
    ).toBe(true)
    expect(
      canSkipInitialSetup({ capabilities: { chatCompletions: true } }, {}),
    ).toBe(false)
  })
})
