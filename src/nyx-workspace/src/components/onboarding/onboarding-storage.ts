export const INITIAL_SETUP_KEY = 'nyx-onboarding-complete'
export const LEGACY_CONFIGURED_KEY = 'hermes-configured'
export const PRODUCT_TOUR_KEY = 'nyx-onboarding-completed'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type SetupStatusSnapshot = {
  capabilities?: {
    chatCompletions?: boolean
    sessions?: boolean
  }
}

export type SetupConfigSnapshot = {
  activeModel?: string
  activeProvider?: string
}

export function hasCompletedInitialSetup(storage: StorageLike): boolean {
  return (
    storage.getItem(INITIAL_SETUP_KEY) === 'true' ||
    storage.getItem(LEGACY_CONFIGURED_KEY) === 'true'
  )
}

export function markInitialSetupComplete(storage: StorageLike): void {
  storage.setItem(INITIAL_SETUP_KEY, 'true')
  storage.setItem(LEGACY_CONFIGURED_KEY, 'true')
  // Completing setup should not immediately open a second onboarding flow.
  storage.setItem(PRODUCT_TOUR_KEY, 'true')
}

export function clearInitialSetup(storage: StorageLike): void {
  storage.removeItem(INITIAL_SETUP_KEY)
  storage.removeItem(LEGACY_CONFIGURED_KEY)
  storage.removeItem(PRODUCT_TOUR_KEY)
}

export function canSkipInitialSetup(
  status: SetupStatusSnapshot | null | undefined,
  config: SetupConfigSnapshot | null | undefined,
): boolean {
  if (status?.capabilities?.sessions) return true
  const chatCapable = Boolean(
    status?.capabilities?.chatCompletions,
  )
  return Boolean(
    chatCapable && (config?.activeModel || config?.activeProvider),
  )
}
