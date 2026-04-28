// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CrewOpsPanel } from './crew-ops-panel'
import type { CrewMember } from '@/hooks/use-crew-status'

const itWithDom = typeof document === 'undefined' ? it.skip : it

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}))

const baseMember: CrewMember = {
  id: 'workspace',
  displayName: 'Workspace',
  role: 'Primary profile',
  profileFound: true,
  gatewayState: 'running',
  processAlive: true,
  platforms: {},
  model: 'gpt-5.4',
  provider: 'openai',
  lastSessionTitle: 'Operations smoke',
  lastSessionAt: Math.floor(Date.now() / 1000),
  sessionCount: 12,
  messageCount: 40,
  toolCallCount: 5,
  totalTokens: 3000,
  estimatedCostUsd: null,
  cronJobCount: 0,
  assignedTaskCount: 0,
  activeRunCount: 1,
  latestRun: null,
  lastFailure: null,
  lastHandoff: null,
  queuedJobCount: 0,
}

afterEach(() => {
  cleanup()
})

describe('CrewOpsPanel', () => {
  itWithDom('hides stale failures once a newer run is active', () => {
    render(
      <CrewOpsPanel
        crew={[
          {
            ...baseMember,
            latestRun: {
              sessionKey: 'session-live',
              runId: 'run-live-1234',
              status: 'active',
              updatedAt: 200,
              assistantText: 'Working',
              errorMessage: null,
            },
            lastFailure: {
              sessionKey: 'session-old',
              runId: 'run-old-9999',
              status: 'error',
              updatedAt: 100,
              assistantText: '',
              errorMessage:
                'Codex Exec exited with signal SIGTERM: Reading prompt from stdin...',
            },
          },
        ]}
        isLoading={false}
        error={null}
      />,
    )

    expect(screen.getByText(/Latest run:/)).toBeTruthy()
    expect(screen.queryByText(/Last failure:/)).toBeNull()
    expect(screen.queryByText(/Reading prompt from stdin/)).toBeNull()
  })

  itWithDom('shows the failure pill when the latest run is still the failed one', () => {
    render(
      <CrewOpsPanel
        crew={[
          {
            ...baseMember,
            activeRunCount: 0,
            latestRun: {
              sessionKey: 'session-failed',
              runId: 'run-failed-1234',
              status: 'error',
              updatedAt: 200,
              assistantText: '',
              errorMessage:
                'Codex Exec exited with signal SIGTERM: Reading prompt from stdin...',
            },
            lastFailure: {
              sessionKey: 'session-failed',
              runId: 'run-failed-1234',
              status: 'error',
              updatedAt: 200,
              assistantText: '',
              errorMessage:
                'Codex Exec exited with signal SIGTERM: Reading prompt from stdin...',
            },
          },
        ]}
        isLoading={false}
        error={null}
      />,
    )

    expect(screen.getByText(/Last failure:/)).toBeTruthy()
    expect(screen.getByText(/Reading prompt from stdin/)).toBeTruthy()
  })
})
