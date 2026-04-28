import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { getTheme, setTheme } from '@/lib/theme'

const SETTINGS_STORAGE_KEY = 'nyx-settings'
const LEGACY_SETTINGS_STORAGE_KEY = 'hermes-settings'

export type SettingsThemeMode = 'system' | 'light' | 'dark'
export type AccentColor = 'orange' | 'purple' | 'blue' | 'green'

export type StudioSettings = {
  nyxApiUrl: string
  nyxToken: string
  theme: SettingsThemeMode
  accentColor: AccentColor
  editorFontSize: number
  editorWordWrap: boolean
  editorMinimap: boolean
  notificationsEnabled: boolean
  usageThreshold: number
  smartSuggestionsEnabled: boolean
  preferredBudgetModel: string
  preferredPremiumModel: string
  onlySuggestCheaper: boolean
  showSystemMetricsFooter: boolean
  /** Mobile chat nav mode: 'dock' = iMessage (no nav in chat), 'integrated' = chat input in nav pill, 'scroll-hide' = nav shows on scroll up */
  mobileChatNavMode: 'dock' | 'integrated' | 'scroll-hide'
}

type SettingsState = {
  settings: StudioSettings
  updateSettings: (updates: Partial<StudioSettings>) => void
}

export const defaultStudioSettings: StudioSettings = {
  nyxApiUrl: '',
  nyxToken: '',
  theme: 'system',
  accentColor: 'blue',
  editorFontSize: 13,
  editorWordWrap: true,
  editorMinimap: false,
  notificationsEnabled: true,
  usageThreshold: 80,
  smartSuggestionsEnabled: false,
  preferredBudgetModel: '',
  preferredPremiumModel: '',
  onlySuggestCheaper: false,
  showSystemMetricsFooter: false,
  mobileChatNavMode: 'dock',
}

function migrateSettingsStorageKey(): void {
  if (typeof window === 'undefined') return
  try {
    const current = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
    const legacy = window.localStorage.getItem(LEGACY_SETTINGS_STORAGE_KEY)
    if (!current && legacy) {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, legacy)
    }
    if (legacy) {
      window.localStorage.removeItem(LEGACY_SETTINGS_STORAGE_KEY)
    }
  } catch {
    // Ignore storage failures in private browsing.
  }
}

migrateSettingsStorageKey()

export const useSettingsStore = create<SettingsState>()(
  persist(
    function createSettingsStore(set) {
      return {
        settings: defaultStudioSettings,
        updateSettings: function updateSettings(updates) {
          set(function applyUpdates(state) {
            return {
              settings: {
                ...state.settings,
                ...updates,
              },
            }
          })
        },
      }
    },
    {
      name: SETTINGS_STORAGE_KEY,
      skipHydration: true,
    },
  ),
)

export function useSettings() {
  const settings = useSettingsStore(function selectSettings(state) {
    return state.settings
  })
  const updateSettings = useSettingsStore(function selectUpdateSettings(state) {
    return state.updateSettings
  })

  return {
    settings,
    updateSettings,
  }
}

export function resolveTheme(theme: SettingsThemeMode): 'light' | 'dark' {
  if (theme === 'light') return 'light'
  if (theme === 'dark') return 'dark'

  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function applyTheme(_theme?: SettingsThemeMode) {
  setTheme(getTheme())
  document.documentElement.setAttribute('data-accent', 'orange')
}

export function initializeSettingsAppearance() {
  setTheme(getTheme())
  document.documentElement.setAttribute('data-accent', 'orange')
}
