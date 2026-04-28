// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OperationsScreen } from './operations-screen'

const itWithDom = typeof document === 'undefined' ? it.skip : it

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}))

vi.mock('./components/mission-launcher', () => ({
  MissionLauncher: (props: Record<string, unknown>) => {
    return (
      <div data-testid="mission-launcher">
        {JSON.stringify(props.profiles ?? null)}
      </div>
    )
  },
}))

vi.mock('./components/mission-list', () => ({
  MissionList: (props: Record<string, unknown>) => {
    return <div data-testid="mission-list">{JSON.stringify(props)}</div>
  },
}))

vi.mock('./components/run-ledger', () => ({
  RunLedger: (props: Record<string, unknown>) => {
    return <div data-testid="run-ledger">{JSON.stringify(props)}</div>
  },
}))

vi.mock('./components/crew-ops-panel', () => ({
  CrewOpsPanel: (props: Record<string, unknown>) => {
    return <div data-testid="crew-ops-panel">{JSON.stringify(props)}</div>
  },
}))

vi.mock('@/hooks/use-crew-status', () => ({
  useCrewStatus: () => ({
    crew: [
      {
        id: 'nyx',
        displayName: 'Nyx',
        role: 'Lead runtime',
        profileFound: true,
        gatewayState: 'running',
        processAlive: true,
        platforms: {},
        model: 'gpt-5.4',
        provider: 'openai',
        lastSessionTitle: null,
        lastSessionAt: null,
        sessionCount: 0,
        messageCount: 0,
        toolCallCount: 0,
        totalTokens: 0,
        estimatedCostUsd: null,
        cronJobCount: 0,
        assignedTaskCount: 0,
        activeRunCount: 0,
        latestRun: null,
        lastFailure: null,
        lastHandoff: null,
        queuedJobCount: 0,
      },
    ],
    lastUpdated: null,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}))

const fetchOperationMissionsMock = vi.fn()
const fetchOperationRunsMock = vi.fn()
const fetchTradingLaneSnapshotMock = vi.fn()
const launchOperationMissionRequestMock = vi.fn()

vi.mock('@/lib/operations-api', () => ({
  fetchOperationMissions: (...args: Array<unknown>) =>
    fetchOperationMissionsMock(...args),
  fetchOperationRuns: (...args: Array<unknown>) => fetchOperationRunsMock(...args),
  fetchTradingLaneSnapshot: (...args: Array<unknown>) =>
    fetchTradingLaneSnapshotMock(...args),
  launchOperationMissionRequest: (...args: Array<unknown>) =>
    launchOperationMissionRequestMock(...args),
}))

function primeOperationsApiMocks() {
  fetchOperationMissionsMock.mockResolvedValue([])
  fetchOperationRunsMock.mockResolvedValue([])
  fetchTradingLaneSnapshotMock.mockResolvedValue({
    lane: {
      mode: 'paper',
      active_adapter: 'paper',
      last_mode_change_reason: 'paper desk armed',
      last_halt_reason: null,
    },
    risk: {
      daily_pnl: 0,
      daily_loss_limit: -250,
      daily_trades: 0,
      max_daily_trades: 5,
      _open_positions: 0,
      max_concurrent: 2,
    },
    intents: [],
    executions: [],
  })
}

beforeEach(() => {
  fetchOperationMissionsMock.mockReset()
  fetchOperationRunsMock.mockReset()
  fetchTradingLaneSnapshotMock.mockReset()
  launchOperationMissionRequestMock.mockReset()
  primeOperationsApiMocks()
})

afterEach(() => {
  cleanup()
})

describe('OperationsScreen', () => {
  itWithDom('passes crew-derived profiles into the mission launcher', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <OperationsScreen />
      </QueryClientProvider>,
    )

    expect(
      await screen.findByText(
        'Mission launch, crew posture, and live runs in one operational surface',
      ),
    ).toBeTruthy()
    expect(screen.getByText('1 crew')).toBeTruthy()
    expect(screen.getByTestId('mission-launcher')).toBeTruthy()
    expect(screen.getByTestId('mission-launcher').textContent).toContain('"id":"nyx"')
    expect(screen.getByTestId('mission-launcher').textContent).toContain(
      '"displayName":"Nyx"',
    )
  })

  itWithDom('pins the hero copy to readable dark ink on the light operations banner', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <OperationsScreen />
      </QueryClientProvider>,
    )

    const heading = await screen.findByRole('heading', {
      name: 'Mission launch, crew posture, and live runs in one operational surface',
    })
    const eyebrow = screen.getByText('Runtime Operations')
    const body = screen.getByText(
      /Hermes had the right instinct here\. The upgrade for NyxHive is not more dashboard theater;/,
    )

    expect(heading.className).toContain('text-slate-950')
    expect(body.className).toContain('text-slate-700')
    expect(eyebrow.className).toContain('text-slate-500')
  })

  itWithDom('shows a single stale-build warning and trims duplicate route errors', async () => {
    const staleMessage =
      '/api/operations/missions returned HTML instead of JSON. The workspace or gateway is likely stale and needs a restart.'

    fetchOperationMissionsMock.mockRejectedValue(new Error(staleMessage))
    fetchOperationRunsMock.mockRejectedValue(
      new Error(
        '/api/operations/runs returned HTML instead of JSON. The workspace or gateway is likely stale and needs a restart.',
      ),
    )
    fetchTradingLaneSnapshotMock.mockRejectedValue(
      new Error(
        '/api/nyx-trading-lane returned HTML instead of JSON. The workspace or gateway is likely stale and needs a restart.',
      ),
    )

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <OperationsScreen />
      </QueryClientProvider>,
    )

    expect(
      await screen.findByText(/Operations is talking to a stale workspace build\./),
    ).toBeTruthy()
    expect(screen.getByText(/Reload the workspace or gateway to pick up the latest API routes\./)).toBeTruthy()
    expect(screen.getByText(/Restart required to reload trading lane data on this workspace build\./)).toBeTruthy()
    expect(screen.getByTestId('mission-list').textContent).toContain(
      '"error":"Restart required to reload mission data on this workspace build."',
    )
    expect(screen.getByTestId('run-ledger').textContent).toContain(
      '"error":"Restart required to reload run ledger data on this workspace build."',
    )
  })
})
