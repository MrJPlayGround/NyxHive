'use client'

import { Link } from '@tanstack/react-router'
import type { OperationMission } from '../operations-api'

type MissionListProps = {
  missions: Array<OperationMission>
  isLoading: boolean
  error: string | null
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'Never'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function statusTone(status: OperationMission['status']): string {
  switch (status) {
    case 'completed':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700'
    case 'failed':
      return 'border-rose-200 bg-rose-50 text-rose-700'
    case 'running':
      return 'border-amber-200 bg-amber-50 text-amber-700'
    case 'paused':
      return 'border-slate-200 bg-slate-100 text-slate-700'
    default:
      return 'border-primary-200 bg-primary-50 text-primary-700'
  }
}

export function MissionList({ missions, isLoading, error }: MissionListProps) {
  return (
    <section className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--theme-muted)]">
            Missions
          </p>
          <h2 className="mt-2 text-xl font-semibold text-[var(--theme-text)]">
            Structured work with durable history
          </h2>
        </div>
        <div className="rounded-full border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--theme-text)]">
          {missions.length} tracked
        </div>
      </div>

      {isLoading ? (
        <p className="mt-4 text-sm text-[var(--theme-muted)]">Loading missions…</p>
      ) : error ? (
        <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </p>
      ) : missions.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--theme-muted)]">
          No missions yet. Use Mission Control to launch the first one.
        </p>
      ) : (
        <div className="mt-5 space-y-3">
          {missions.map((mission) => (
            <article
              key={mission.id}
              className="rounded-2xl border border-[var(--theme-border-subtle)] bg-[var(--theme-card2)] p-4"
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${statusTone(mission.status)}`}
                    >
                      {mission.status}
                    </span>
                    <span className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-600">
                      {mission.mode}
                    </span>
                    <span className="text-xs text-[var(--theme-muted)]">
                      {mission.profile} · {mission.autonomy} autonomy
                    </span>
                  </div>
                  <h3 className="mt-3 text-base font-semibold text-[var(--theme-text)]">
                    {mission.goal}
                  </h3>
                  <p className="mt-2 text-xs text-[var(--theme-muted)]">
                    Created {formatTimestamp(mission.createdAt)}
                    {mission.lastRunAt ? ` · Last run ${formatTimestamp(mission.lastRunAt)}` : ''}
                  </p>
                  {mission.lastError ? (
                    <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                      {mission.lastError}
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 flex-wrap gap-2 text-xs">
                  {mission.jobId ? (
                    <Link
                      to="/jobs"
                      search={{ agent: mission.profile }}
                      className="rounded-full border border-[var(--theme-border)] px-3 py-1.5 text-[var(--theme-text)] transition hover:border-[var(--theme-accent)]"
                    >
                      Job {mission.jobId.slice(0, 8)}
                    </Link>
                  ) : null}
                  {mission.sessionKey ? (
                    <Link
                      to="/chat/$sessionKey"
                      params={{ sessionKey: mission.sessionKey }}
                      className="rounded-full border border-[var(--theme-border)] px-3 py-1.5 text-[var(--theme-text)] transition hover:border-[var(--theme-accent)]"
                    >
                      Open session
                    </Link>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
