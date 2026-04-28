import { describe, expect, test } from 'bun:test'

import {
  deriveActionRisk,
  deriveArtifactSummary,
  deriveSessionBuckets,
  deriveSetupReadiness,
} from './workspace-ux-state'
import type { SessionMeta } from './types'

function session(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    key: 'session-1',
    friendlyId: 'session-1',
    label: 'Session one',
    updatedAt: Date.UTC(2026, 3, 21, 9, 0, 0),
    ...overrides,
  }
}

describe('workspace UX state', () => {
  test('groups working, today, week, and older sessions into scanable buckets', () => {
    const now = Date.UTC(2026, 3, 21, 13, 0, 0)
    const buckets = deriveSessionBuckets({
      sessions: [
        session({ key: 'active', friendlyId: 'active', label: 'Live run' }),
        session({
          key: 'today',
          friendlyId: 'today',
          label: 'Morning work',
          updatedAt: Date.UTC(2026, 3, 21, 8, 0, 0),
        }),
        session({
          key: 'week',
          friendlyId: 'week',
          label: 'Roadmap',
          updatedAt: Date.UTC(2026, 3, 18, 8, 0, 0),
        }),
        session({
          key: 'old',
          friendlyId: 'old',
          label: 'Old thread',
          updatedAt: Date.UTC(2026, 2, 10, 8, 0, 0),
        }),
      ],
      activeRuntimeSessionKeys: new Set(['active']),
      now,
    })

    expect(buckets.map((bucket) => bucket.label)).toEqual([
      'Working now',
      'Today',
      'This week',
      'Older',
    ])
    expect(buckets[0]?.items[0]?.session.friendlyId).toBe('active')
    expect(buckets[0]?.items[0]?.subtitle).toContain('Working')
    expect(buckets[1]?.items[0]?.subtitle).toContain('5h ago')
  })

  test('classifies destructive commands as high risk approval work', () => {
    const risk = deriveActionRisk('exec', {
      command: 'rm -rf /home/user/dev/nyxhive/dist',
    })

    expect(risk.tier).toBe('high')
    expect(risk.label).toBe('High risk')
    expect(risk.detail).toContain('destructive')
  })

  test('classifies read-only inspection as low risk', () => {
    const risk = deriveActionRisk('read', {
      path: '/home/user/dev/nyxhive/package.json',
    })

    expect(risk.tier).toBe('low')
    expect(risk.label).toBe('Read-only')
  })

  test('summarizes assistant deliverables from markdown and code output', () => {
    expect(
      deriveArtifactSummary({
        text: '```markdown\n# Launch Plan\n\n- Ship it\n```',
        attachments: [],
        toolSections: [],
      }),
    ).toMatchObject({
      kind: 'markdown',
      label: 'Markdown deliverable',
      count: 1,
    })

    expect(
      deriveArtifactSummary({
        text: '```ts\nexport const ok = true\n```',
        attachments: [],
        toolSections: [],
      }),
    ).toMatchObject({
      kind: 'code',
      label: 'Code artifact',
    })
  })

  test('derives setup readiness from available runtime capabilities', () => {
    expect(
      deriveSetupReadiness({
        connected: true,
        sessionsAvailable: true,
        configAvailable: true,
        skillsAvailable: false,
        sessionCount: 0,
      }),
    ).toEqual({
      status: 'ready',
      headline: 'Ready for first run',
      detail: 'Core chat and runtime configuration are available.',
      nextAction: 'Start chat',
    })

    expect(
      deriveSetupReadiness({
        connected: false,
        sessionsAvailable: false,
        configAvailable: false,
        skillsAvailable: false,
        sessionCount: 0,
      }).status,
    ).toBe('blocked')
  })
})
