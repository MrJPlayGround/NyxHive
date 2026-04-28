'use client'

import { Link } from '@tanstack/react-router'
import type { CrewMember } from '@/hooks/use-crew-status'

type CrewOpsPanelProps = {
  crew: Array<CrewMember>
  isLoading: boolean
  error: string | null
}

function getVisibleFailure(member: CrewMember): CrewMember['lastFailure'] {
  if (!member.lastFailure) return null
  if (!member.latestRun) return member.lastFailure
  return member.latestRun.updatedAt <= member.lastFailure.updatedAt
    ? member.lastFailure
    : null
}

function formatUpdatedAt(value: number | null): string {
  if (!value) return 'Never'
  const diffMs = Date.now() - value * 1000
  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  return `${Math.floor(diffHours / 24)}d ago`
}

export function CrewOpsPanel({ crew, isLoading, error }: CrewOpsPanelProps) {
  return (
    <section className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--theme-muted)]">
            Crew Posture
          </p>
          <h2 className="mt-2 text-xl font-semibold text-[var(--theme-text)]">
            Who is busy, blocked, or drifting
          </h2>
        </div>
      </div>

      {isLoading ? (
        <p className="mt-4 text-sm text-[var(--theme-muted)]">Loading crew posture…</p>
      ) : error ? (
        <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </p>
      ) : (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {crew.map((member) => {
            const visibleFailure = getVisibleFailure(member)

            return (
              <article
                key={member.id}
                className="rounded-2xl border border-[var(--theme-border-subtle)] bg-[var(--theme-card2)] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--theme-muted)]">
                      {member.role}
                    </p>
                    <h3 className="mt-2 text-lg font-semibold text-[var(--theme-text)]">
                      {member.displayName}
                    </h3>
                    <p className="mt-1 text-sm text-[var(--theme-muted)]">
                      {member.model} · {member.provider}
                    </p>
                  </div>
                  <div className="rounded-full border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--theme-text)]">
                    {member.gatewayState}
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3 text-sm text-[var(--theme-muted)] xl:grid-cols-4">
                  <div className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-3">
                    <p className="text-xs uppercase tracking-[0.14em] text-[var(--theme-muted)]">Active runs</p>
                    <p className="mt-2 text-lg font-semibold text-[var(--theme-text)]">
                      {member.activeRunCount}
                    </p>
                  </div>
                  <div className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-3">
                    <p className="text-xs uppercase tracking-[0.14em] text-[var(--theme-muted)]">Queued jobs</p>
                    <p className="mt-2 text-lg font-semibold text-[var(--theme-text)]">
                      {member.queuedJobCount}
                    </p>
                  </div>
                  <div className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-3">
                    <p className="text-xs uppercase tracking-[0.14em] text-[var(--theme-muted)]">Assigned tasks</p>
                    <p className="mt-2 text-lg font-semibold text-[var(--theme-text)]">
                      {member.assignedTaskCount}
                    </p>
                  </div>
                  <div className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-3">
                    <p className="text-xs uppercase tracking-[0.14em] text-[var(--theme-muted)]">Last active</p>
                    <p className="mt-2 text-lg font-semibold text-[var(--theme-text)]">
                      {formatUpdatedAt(member.lastSessionAt)}
                    </p>
                  </div>
                </div>

                <div className="mt-4 space-y-2 text-sm text-[var(--theme-muted)]">
                  <p>
                    Latest run:{' '}
                    <span className="font-medium text-[var(--theme-text)]">
                      {member.latestRun
                        ? `${member.latestRun.status} · ${member.latestRun.runId.slice(0, 8)}`
                        : 'No tracked runs'}
                    </span>
                  </p>
                  {visibleFailure ? (
                    <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
                      Last failure: {visibleFailure.errorMessage || visibleFailure.status}
                    </p>
                  ) : null}
                </div>

                <div className="mt-4 flex flex-wrap gap-2 text-xs">
                  {member.latestRun ? (
                    <Link
                      to="/chat/$sessionKey"
                      params={{ sessionKey: member.latestRun.sessionKey }}
                      className="rounded-full border border-[var(--theme-border)] px-3 py-1.5 text-[var(--theme-text)] transition hover:border-[var(--theme-accent)]"
                    >
                      Open chat
                    </Link>
                  ) : null}
                  <Link
                    to="/tasks"
                    search={{ assignee: member.id }}
                    className="rounded-full border border-[var(--theme-border)] px-3 py-1.5 text-[var(--theme-text)] transition hover:border-[var(--theme-accent)]"
                  >
                    View tasks
                  </Link>
                  <Link
                    to="/jobs"
                    search={{ agent: member.id }}
                    className="rounded-full border border-[var(--theme-border)] px-3 py-1.5 text-[var(--theme-text)] transition hover:border-[var(--theme-accent)]"
                  >
                    View jobs
                  </Link>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
