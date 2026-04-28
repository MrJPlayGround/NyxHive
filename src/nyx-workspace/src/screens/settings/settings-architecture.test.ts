import { describe, expect, test } from 'bun:test'
import {
  QUICK_SETTINGS_SECTION_IDS,
  SETTINGS_GROUPS,
  getSettingsSection,
} from './settings-architecture'

describe('settings architecture', () => {
  test('organizes canonical settings into workspace, runtime, and advanced groups', () => {
    expect(SETTINGS_GROUPS.map((group) => group.id)).toEqual([
      'workspace',
      'runtime',
      'advanced',
    ])
  })

  test('keeps every canonical settings section in exactly one source-of-truth group', () => {
    const sectionIds = SETTINGS_GROUPS.flatMap((group) =>
      group.sections.map((section) => section.id),
    )

    expect(new Set(sectionIds).size).toBe(sectionIds.length)
    expect(getSettingsSection('providers')?.domain).toBe('runtime')
    expect(getSettingsSection('chat')?.domain).toBe('workspace')
    expect(getSettingsSection('config-sources')?.domain).toBe('advanced')
  })

  test('limits quick settings to local workspace preferences', () => {
    expect(QUICK_SETTINGS_SECTION_IDS).toEqual([
      'quick',
      'appearance',
      'chat',
      'notifications',
      'language',
    ])

    for (const id of QUICK_SETTINGS_SECTION_IDS) {
      expect(getSettingsSection(id)?.domain).toBe('workspace')
    }
  })
})
