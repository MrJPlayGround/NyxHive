import { Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from '@/components/ui/toast'
import { useCrewStatus } from '@/hooks/use-crew-status'
import {
  fetchOperationMissions,
  fetchOperationRuns,
  fetchTradingLaneSnapshot,
  launchOperationMissionRequest,
} from '@/lib/operations-api'
import { CrewOpsPanel } from './components/crew-ops-panel'
import { MissionLauncher } from './components/mission-launcher'
import { MissionList } from './components/mission-list'
import { RunLedger } from './components/run-ledger'

type OperationsSurface = {
  title: string
  description: string
  to: string
}

const SURFACES: Array<OperationsSurface> = [
  {
    title: 'Jobs',
    description: 'Inspect scheduler history, rerun jobs, and edit recurring work.',
    to: '/jobs',
  },
  {
    title: 'Tasks',
    description: 'Check reviewer gates, handoffs, and assignee load without leaving Operations.',
    to: '/tasks',
  },
  {
    title: 'Profiles',
    description: 'Adjust profile posture and see how each runtime lane is configured.',
    to: '/profiles',
  },
  {
    title: 'Memory',
    description: 'Trace why the system remembered something before you intervene.',
    to: '/memory',
  },
]

const STALE_BUILD_ERROR_FRAGMENT = 'returned HTML instead of JSON'

function isStaleBuildError(message: string | null): boolean {
  return Boolean(message && message.includes(STALE_BUILD_ERROR_FRAGMENT))
}

function formatPanelError(message: string | null, label: string): string | null {
  if (!message) return null
  if (isStaleBuildError(message)) {
    return `Restart required to reload ${label} on this workspace build.`
  }
  return message
}

export function OperationsScreen() {
  const queryClient = useQueryClient()
  const missionsQuery = useQuery({
    queryKey: ['operations', 'missions'],
    queryFn: fetchOperationMissions,
    staleTime: 10_000,
  })
  const runsQuery = useQuery({
    queryKey: ['operations', 'runs'],
    queryFn: () => fetchOperationRuns(12),
    staleTime: 10_000,
  })
  const tradingQuery = useQuery({
    queryKey: ['operations', 'trading-lane'],
    queryFn: fetchTradingLaneSnapshot,
    staleTime: 15_000,
  })
  const {
    crew,
    isLoading: isCrewLoading,
    isError: isCrewError,
    error: crewError,
  } = useCrewStatus()

  const launchMutation = useMutation({
    mutationFn: launchOperationMissionRequest,
    onSuccess: () => {
      toast('Mission launched from Operations.', { type: 'success' })
      void queryClient.invalidateQueries({ queryKey: ['operations', 'missions'] })
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : String(error), {
        type: 'error',
      })
    },
  })

  const trading = tradingQuery.data
  const rawTradingError =
    tradingQuery.error instanceof Error ? tradingQuery.error.message : null
  const rawMissionsError =
    missionsQuery.error instanceof Error ? missionsQuery.error.message : null
  const rawRunsError =
    runsQuery.error instanceof Error ? runsQuery.error.message : null
  const crewErrorMessage =
    isCrewError && crewError instanceof Error ? crewError.message : null
  const launcherProfiles = crew.map(({ id, displayName, role }) => ({
    id,
    displayName,
    role,
  }))
  const stalePanels = [
    rawMissionsError && isStaleBuildError(rawMissionsError) ? 'missions' : null,
    rawRunsError && isStaleBuildError(rawRunsError) ? 'runs' : null,
    rawTradingError && isStaleBuildError(rawTradingError) ? 'trading lane' : null,
  ].filter(Boolean) as string[]
  const missionsError = formatPanelError(rawMissionsError, 'mission data')
  const runsError = formatPanelError(rawRunsError, 'run ledger data')
  const tradingError = formatPanelError(rawTradingError, 'trading lane data')

  return (
    <div className="min-h-full overflow-y-auto bg-surface text-ink">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <section className="rounded-[28px] border border-primary-200 bg-[linear-gradient(135deg,rgba(252,245,231,0.98),rgba(240,249,255,0.9))] p-6 shadow-sm backdrop-blur">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Runtime Operations
          </p>
          <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <h1 className="text-2xl font-semibold text-slate-950 sm:text-3xl">
                Mission launch, crew posture, and live runs in one operational surface
              </h1>
              <p className="mt-3 text-sm leading-6 text-slate-700">
                Hermes had the right instinct here. The upgrade for NyxHive is not more dashboard theater; it is a single surface where you can launch work, see who is carrying load, and inspect what the runtime is doing right now.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.18em]">
              <span className="rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-slate-900 shadow-sm">
                {missionsQuery.data?.length ?? 0} missions
              </span>
              <span className="rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-slate-900 shadow-sm">
                {runsQuery.data?.length ?? 0} runs
              </span>
              <span className="rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-slate-900 shadow-sm">
                {crew.length} crew
              </span>
            </div>
          </div>
        </section>

        {stalePanels.length > 0 ? (
          <section className="rounded-2xl border border-amber-300 bg-amber-50 px-5 py-4 text-sm text-amber-900 shadow-sm">
            <p className="font-semibold">Operations is talking to a stale workspace build.</p>
            <p className="mt-1 text-amber-800">
              {stalePanels.join(', ')} are returning the app shell instead of JSON.
              Reload the workspace or gateway to pick up the latest API routes.
            </p>
          </section>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
          <MissionLauncher
            profiles={launcherProfiles}
            isLaunching={launchMutation.isPending}
            onLaunch={(input) => launchMutation.mutateAsync(input)}
          />
          <CrewOpsPanel
            crew={crew}
            isLoading={isCrewLoading}
            error={crewErrorMessage}
          />
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <MissionList
            missions={missionsQuery.data ?? []}
            isLoading={missionsQuery.isLoading}
            error={missionsError}
          />
          <section className="rounded-2xl border border-emerald-300/60 bg-[var(--theme-card)] p-5 shadow-sm">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-600">
                  Trading Lane
                </p>
                <h2 className="mt-2 text-xl font-semibold text-[var(--theme-text)]">
                  Astra stays bounded to the paper desk
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--theme-muted)]">
                  Trading still belongs inside the same control plane, but the guardrail stays intact: disabled, research, paper, or halted. Live remains intentionally unavailable here.
                </p>
              </div>
              <div className="rounded-full border border-emerald-300/60 bg-emerald-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
                {trading?.lane.mode ?? 'unknown'}
              </div>
            </div>

            {tradingError ? (
              <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                Trading lane unavailable: {tradingError}
              </p>
            ) : tradingQuery.isLoading ? (
              <p className="mt-4 text-sm text-[var(--theme-muted)]">Loading trading lane…</p>
            ) : trading ? (
              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card2)] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--theme-muted)]">
                    Adapter
                  </p>
                  <p className="mt-2 text-lg font-semibold text-[var(--theme-text)]">
                    {trading.lane.active_adapter}
                  </p>
                  <p className="mt-2 text-sm text-[var(--theme-muted)]">
                    {trading.lane.last_mode_change_reason ?? 'No mode change logged yet.'}
                  </p>
                </div>
                <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card2)] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--theme-muted)]">
                    Risk Posture
                  </p>
                  <p className="mt-2 text-lg font-semibold text-[var(--theme-text)]">
                    ${trading.risk.daily_pnl.toFixed(2)} / ${Math.abs(trading.risk.daily_loss_limit).toFixed(2)}
                  </p>
                  <p className="mt-2 text-sm text-[var(--theme-muted)]">
                    {trading.risk.daily_trades}/{trading.risk.max_daily_trades} trades,{' '}
                    {trading.risk._open_positions}/{trading.risk.max_concurrent} open positions
                  </p>
                </div>
                <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card2)] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--theme-muted)]">
                    Recent Intents
                  </p>
                  <p className="mt-2 text-lg font-semibold text-[var(--theme-text)]">
                    {trading.intents.length}
                  </p>
                  <p className="mt-2 text-sm text-[var(--theme-muted)]">
                    {trading.intents[0]
                      ? `${trading.intents[0].symbol} is ${trading.intents[0].status}.`
                      : 'No structured intents yet.'}
                  </p>
                </div>
                <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card2)] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--theme-muted)]">
                    Executions
                  </p>
                  <p className="mt-2 text-lg font-semibold text-[var(--theme-text)]">
                    {trading.executions.length}
                  </p>
                  <p className="mt-2 text-sm text-[var(--theme-muted)]">
                    {trading.executions[0]
                      ? `${trading.executions[0].symbol} is ${trading.executions[0].status}.`
                      : 'No paper fills yet.'}
                  </p>
                </div>
              </div>
            ) : null}
          </section>
        </div>

        <RunLedger
          runs={runsQuery.data ?? []}
          isLoading={runsQuery.isLoading}
          error={runsError}
        />

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {SURFACES.map((surface) => (
            <Link
              key={surface.to}
              to={surface.to}
              className="group rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-[var(--theme-accent)]"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold text-[var(--theme-text)]">
                    {surface.title}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-[var(--theme-muted)]">
                    {surface.description}
                  </p>
                </div>
                <span className="text-sm font-medium text-accent-500 transition group-hover:translate-x-0.5">
                  Open
                </span>
              </div>
            </Link>
          ))}
        </section>
      </div>
    </div>
  )
}
