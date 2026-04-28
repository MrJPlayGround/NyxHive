'use client'

import { Link } from '@tanstack/react-router'
import type { OperationRun } from '../operations-api'

type RunLedgerProps = {
  runs: Array<OperationRun>
  isLoading: boolean
  error: string | null
}

function formatTime(value: number): string {
  try {
    return new Date(value).toLocaleString()
  } catch {
    return String(value)
  }
}

export function RunLedger({ runs, isLoading, error }: RunLedgerProps) {
  return (
    <section className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--theme-muted)]">
            Run Ledger
          </p>
          <h2 className="mt-2 text-xl font-semibold text-[var(--theme-text)]">
            Active, stalled, handoff, and error state in one place
          </h2>
        </div>
      </div>

      {isLoading ? (
        <p className="mt-4 text-sm text-[var(--theme-muted)]">Loading run ledger…</p>
      ) : error ? (
        <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </p>
      ) : runs.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--theme-muted)]">No persisted runs yet.</p>
      ) : (
        <div className="mt-5 space-y-3">
          {runs.map((run) => (
            <article
              key={run.runId}
              className="rounded-2xl border border-[var(--theme-border-subtle)] bg-[var(--theme-card2)] p-4"
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-[var(--theme-border)] bg-[var(--theme-bg)] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--theme-text)]">
                      {run.status}
                    </span>
                    <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--theme-muted)]">
                      {run.conversationMode ?? 'unknown'} / {run.runtimePosture ?? 'unknown'}
                    </span>
                  </div>
                  <h3 className="mt-3 text-base font-semibold text-[var(--theme-text)]">
                    {run.friendlyId}
                  </h3>
                  <p className="mt-2 text-xs text-[var(--theme-muted)]">
                    Updated {formatTime(run.updatedAt)} · Last event {formatTime(run.lastEventAt)}
                  </p>
                  {run.errorMessage ? (
                    <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                      {run.errorMessage}
                    </p>
                  ) : null}
                  {run.assistantText ? (
                    <p className="mt-3 line-clamp-2 text-sm leading-6 text-[var(--theme-muted)]">
                      {run.assistantText}
                    </p>
                  ) : null}
                </div>

                <div className="grid shrink-0 grid-cols-3 gap-2 text-center text-xs text-[var(--theme-muted)]">
                  <div className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2">
                    <p className="font-semibold text-[var(--theme-text)]">{run.toolCallCount}</p>
                    <p>Tools</p>
                  </div>
                  <div className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2">
                    <p className="font-semibold text-[var(--theme-text)]">{run.lifecycleEventCount}</p>
                    <p>Events</p>
                  </div>
                  <div className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2">
                    <p className="font-semibold text-[var(--theme-text)]">{run.runId.slice(0, 6)}</p>
                    <p>Run ID</p>
                  </div>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2 text-xs">
                <Link
                  to="/chat/$sessionKey"
                  params={{ sessionKey: run.sessionKey }}
                  className="rounded-full border border-[var(--theme-border)] px-3 py-1.5 text-[var(--theme-text)] transition hover:border-[var(--theme-accent)]"
                >
                  Open session
                </Link>
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(run.runId)}
                  className="rounded-full border border-[var(--theme-border)] px-3 py-1.5 text-[var(--theme-text)] transition hover:border-[var(--theme-accent)]"
                >
                  Copy run ID
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
