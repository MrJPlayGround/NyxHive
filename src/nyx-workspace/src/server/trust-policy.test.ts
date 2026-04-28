import { describe, expect, test } from 'bun:test'
import { evaluateWorkspaceActionTrust } from './trust-policy'

describe('workspace trust policy', () => {
  test('allows direct chat answers without side effects', () => {
    expect(
      evaluateWorkspaceActionTrust({ intent: 'chat-answer', explicitUserIntent: false }),
    ).toMatchObject({ allowed: true, requiresExplicitUserIntent: false })
  })

  test('blocks live facts when current-info tools are unavailable or failed', () => {
    expect(
      evaluateWorkspaceActionTrust({
        intent: 'live-info',
        explicitUserIntent: false,
        toolAvailable: false,
      }),
    ).toMatchObject({ allowed: false, indicator: 'tool-failed' })
    expect(
      evaluateWorkspaceActionTrust({
        intent: 'live-info',
        explicitUserIntent: false,
        toolAvailable: true,
        toolSucceeded: false,
      }),
    ).toMatchObject({ allowed: false, indicator: 'tool-failed' })
  })

  test('requires explicit user intent for memory, reminders, file writes, and external sends', () => {
    for (const intent of ['remember-this', 'create-reminder', 'file-write', 'external-send'] as const) {
      expect(
        evaluateWorkspaceActionTrust({ intent, explicitUserIntent: false }),
      ).toMatchObject({ allowed: false, requiresExplicitUserIntent: true })
    }
  })

  test('marks explicit reminders with a visible trust indicator', () => {
    expect(
      evaluateWorkspaceActionTrust({ intent: 'create-reminder', explicitUserIntent: true }),
    ).toMatchObject({ allowed: true, indicator: 'scheduled-task-created' })
  })

  test('keeps public surfaces public-safe even with explicit user intent', () => {
    expect(
      evaluateWorkspaceActionTrust({
        intent: 'file-write',
        explicitUserIntent: true,
        surface: 'discord_public',
      }),
    ).toMatchObject({
      allowed: false,
      boundary: 'public_safe',
      reason: 'Public surfaces stay public-safe; file-write is blocked there.',
    })
  })

  test('allows paired DM surfaces to perform explicit side effects', () => {
    expect(
      evaluateWorkspaceActionTrust({
        intent: 'external-send',
        explicitUserIntent: true,
        surface: 'telegram_dm',
        pairedSurface: true,
      }),
    ).toMatchObject({
      allowed: true,
      boundary: 'paired_dm',
      reason: 'Paired DM surface accepted explicit external-send.',
    })
  })
})
