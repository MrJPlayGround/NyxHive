export type SettingsDomainId = 'workspace' | 'runtime' | 'advanced'

export type SettingsSectionId =
  | 'quick'
  | 'appearance'
  | 'chat'
  | 'notifications'
  | 'language'
  | 'providers'
  | 'agent'
  | 'routing'
  | 'voice'
  | 'memory'
  | 'agent-display'
  | 'mcp'
  | 'backend-status'
  | 'config-sources'

export type SettingsSectionDefinition = {
  id: SettingsSectionId
  label: string
  description: string
  domain: SettingsDomainId
  to?: '/settings/mcp'
}

export type SettingsGroupDefinition = {
  id: SettingsDomainId
  label: string
  description: string
  sections: Array<SettingsSectionDefinition>
}

export const SETTINGS_GROUPS: Array<SettingsGroupDefinition> = [
  {
    id: 'workspace',
    label: 'Workspace',
    description: 'Local UI preferences for this browser.',
    sections: [
      {
        id: 'quick',
        label: 'Quick Access',
        description: 'Common local preferences and links.',
        domain: 'workspace',
      },
      {
        id: 'appearance',
        label: 'Appearance',
        description: 'Theme and visual preferences stored locally.',
        domain: 'workspace',
      },
      {
        id: 'chat',
        label: 'Chat',
        description: 'Message visibility, display name, and avatar.',
        domain: 'workspace',
      },
      {
        id: 'notifications',
        label: 'Notifications',
        description: 'Browser-side alerts and local thresholds.',
        domain: 'workspace',
      },
      {
        id: 'language',
        label: 'Language',
        description: 'Workspace interface language.',
        domain: 'workspace',
      },
    ],
  },
  {
    id: 'runtime',
    label: 'Runtime',
    description: 'NyxHive behavior backed by live runtime configuration.',
    sections: [
      {
        id: 'providers',
        label: 'Providers & Models',
        description: 'Provider auth, default model, and model discovery.',
        domain: 'runtime',
      },
      {
        id: 'agent',
        label: 'Agent Defaults',
        description: 'Agent execution limits and default behavior.',
        domain: 'runtime',
      },
      {
        id: 'routing',
        label: 'Routing',
        description: 'Model routing policy and fallback behavior.',
        domain: 'runtime',
      },
      {
        id: 'voice',
        label: 'Voice',
        description: 'TTS and STT provider configuration.',
        domain: 'runtime',
      },
      {
        id: 'memory',
        label: 'Memory',
        description: 'Runtime memory and user profile behavior.',
        domain: 'runtime',
      },
      {
        id: 'agent-display',
        label: 'Agent Display',
        description: 'Runtime display flags surfaced from config.',
        domain: 'runtime',
      },
      {
        id: 'mcp',
        label: 'MCP Servers',
        description: 'Runtime integration configuration.',
        domain: 'runtime',
        to: '/settings/mcp',
      },
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    description: 'Diagnostics, config sources, and backend detail.',
    sections: [
      {
        id: 'backend-status',
        label: 'Backend Status',
        description: 'Operational backend status and limits.',
        domain: 'advanced',
      },
      {
        id: 'config-sources',
        label: 'Config Sources',
        description: 'Config home, runtime source, and read-only details.',
        domain: 'advanced',
      },
    ],
  },
]

export const QUICK_SETTINGS_SECTION_IDS: Array<SettingsSectionId> = [
  'quick',
  'appearance',
  'chat',
  'notifications',
  'language',
]

export function getSettingsSection(
  id: SettingsSectionId,
): SettingsSectionDefinition | undefined {
  for (const group of SETTINGS_GROUPS) {
    const section = group.sections.find((candidate) => candidate.id === id)
    if (section) return section
  }
  return undefined
}
