export type ThemeId =
  | 'nyx-official'
  | 'nyx-official-light'
  | 'nyx-classic'
  | 'nyx-classic-light'
  | 'nyx-slate'
  | 'nyx-slate-light'
  | 'nyx-mono'
  | 'nyx-mono-light'

export const THEMES: Array<{
  id: ThemeId
  label: string
  description: string
  icon: string
}> = [
  {
    id: 'nyx-official',
    label: 'Nyx Official',
    description: 'Nyx flagship theme',
    icon: '⚕',
  },
  {
    id: 'nyx-official-light',
    label: 'Nyx Official Light',
    description: 'Nyx light palette',
    icon: '⚕',
  },
  {
    id: 'nyx-classic',
    label: 'Nyx Classic',
    description: 'Bronze accents on dark charcoal',
    icon: '🔶',
  },
  {
    id: 'nyx-classic-light',
    label: 'Classic Light',
    description: 'Warm parchment with bronze accents',
    icon: '🔶',
  },
  {
    id: 'nyx-slate',
    label: 'Slate',
    description: 'Cool blue developer theme',
    icon: '🔷',
  },
  {
    id: 'nyx-slate-light',
    label: 'Slate Light',
    description: 'GitHub-light palette with blue accents',
    icon: '🔷',
  },
  {
    id: 'nyx-mono',
    label: 'Mono',
    description: 'Clean monochrome grayscale',
    icon: '◐',
  },
  {
    id: 'nyx-mono-light',
    label: 'Mono Light',
    description: 'Bright monochrome grayscale',
    icon: '◐',
  },
]

const STORAGE_KEY = 'nyx-theme'
const LEGACY_STORAGE_KEY = 'hermes-theme'
const DEFAULT_THEME: ThemeId = 'nyx-official'
const THEME_SET = new Set<ThemeId>(THEMES.map((theme) => theme.id))
const LEGACY_THEME_MAP: Record<string, ThemeId> = {
  'hermes-official': 'nyx-official',
  'hermes-official-light': 'nyx-official-light',
  'hermes-classic': 'nyx-classic',
  'hermes-classic-light': 'nyx-classic-light',
  'hermes-slate': 'nyx-slate',
  'hermes-slate-light': 'nyx-slate-light',
  'hermes-mono': 'nyx-mono',
  'hermes-mono-light': 'nyx-mono-light',
}
const LIGHT_THEME_MAP: Record<
  Exclude<ThemeId, `${string}-light`>,
  Extract<ThemeId, `${string}-light`>
> = {
  'nyx-official': 'nyx-official-light',
  'nyx-classic': 'nyx-classic-light',
  'nyx-slate': 'nyx-slate-light',
  'nyx-mono': 'nyx-mono-light',
}
const DARK_THEME_MAP: Record<
  Extract<ThemeId, `${string}-light`>,
  Exclude<ThemeId, `${string}-light`>
> = {
  'nyx-official-light': 'nyx-official',
  'nyx-classic-light': 'nyx-classic',
  'nyx-slate-light': 'nyx-slate',
  'nyx-mono-light': 'nyx-mono',
}

const LIGHT_THEMES = new Set<ThemeId>([
  'nyx-official-light',
  'nyx-classic-light',
  'nyx-slate-light',
  'nyx-mono-light',
])

export function normalizeTheme(
  value: string | null | undefined,
): ThemeId | null {
  if (typeof value !== 'string') return null
  if (THEME_SET.has(value as ThemeId)) return value as ThemeId
  return LEGACY_THEME_MAP[value] ?? null
}

export function isValidTheme(
  value: string | null | undefined,
): value is ThemeId {
  return normalizeTheme(value) === value
}

export function isDarkTheme(theme: ThemeId): boolean {
  return !LIGHT_THEMES.has(theme)
}

export function getThemeVariant(
  theme: ThemeId,
  mode: 'light' | 'dark',
): ThemeId {
  if (mode === 'light') {
    return isDarkTheme(theme)
      ? LIGHT_THEME_MAP[theme as keyof typeof LIGHT_THEME_MAP]
      : theme
  }

  return isDarkTheme(theme)
    ? theme
    : DARK_THEME_MAP[theme as keyof typeof DARK_THEME_MAP]
}

export function getTheme(): ThemeId {
  if (typeof window === 'undefined') return DEFAULT_THEME
  const stored =
    localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY)
  const theme = normalizeTheme(stored) ?? DEFAULT_THEME
  if (stored && stored !== theme) {
    localStorage.setItem(STORAGE_KEY, theme)
    localStorage.removeItem(LEGACY_STORAGE_KEY)
  }
  return theme
}

export function setTheme(theme: ThemeId): void {
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.classList.remove('light', 'dark', 'system')
  const nextMode = isDarkTheme(theme) ? 'dark' : 'light'
  root.classList.add(nextMode)
  root.style.setProperty('color-scheme', nextMode)
  localStorage.setItem(STORAGE_KEY, theme)
  localStorage.removeItem(LEGACY_STORAGE_KEY)
}
