'use client'

import { useMemo, useState } from 'react'

type MissionLauncherProfile = {
  id: string
  displayName: string
  role: string
}

type MissionLauncherProps = {
  profiles: Array<MissionLauncherProfile>
  isLaunching: boolean
  onLaunch: (input: {
    goal: string
    mode: 'quick' | 'task' | 'build' | 'deep'
    profile: string
    autonomy: 'low' | 'medium' | 'high'
    model: string
  }) => Promise<void>
}

export function MissionLauncher({
  profiles,
  isLaunching,
  onLaunch,
}: MissionLauncherProps) {
  const availableProfiles = useMemo(
    () =>
      profiles.length > 0
        ? profiles
        : [{ id: 'nyx', displayName: 'Nyx', role: 'Primary runtime' }],
    [profiles],
  )
  const [goal, setGoal] = useState('')
  const [mode, setMode] = useState<'quick' | 'task' | 'build' | 'deep'>('task')
  const [profile, setProfile] = useState(availableProfiles[0]?.id ?? 'nyx')
  const [autonomy, setAutonomy] = useState<'low' | 'medium' | 'high'>('medium')
  const [model, setModel] = useState('')

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!goal.trim()) return
    await onLaunch({
      goal: goal.trim(),
      mode,
      profile,
      autonomy,
      model,
    })
    setGoal('')
    setModel('')
  }

  return (
    <section className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-5 shadow-sm">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--theme-muted)]">
            Mission Control
          </p>
          <h2 className="mt-2 text-xl font-semibold text-[var(--theme-text)]">
            Launch structured work without prompt soup
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--theme-muted)]">
            Start bounded runtime work with explicit mode, ownership, and autonomy instead of
            improvising it through chat.
          </p>
        </div>
      </div>

      <form className="mt-5 grid gap-4" onSubmit={handleSubmit}>
        <label className="grid gap-2">
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--theme-muted)]">
            Goal
          </span>
          <textarea
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            rows={3}
            placeholder="Ship the operations backend route set and close the history regression audit."
            className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-input)] px-4 py-3 text-sm text-[var(--theme-text)] outline-none transition placeholder:text-[var(--theme-muted)] focus:border-[var(--theme-accent)]"
          />
        </label>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <label className="grid gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--theme-muted)]">
              Mode
            </span>
            <select
              value={mode}
              onChange={(event) =>
                setMode(event.target.value as 'quick' | 'task' | 'build' | 'deep')
              }
              className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-input)] px-3 py-2 text-sm text-[var(--theme-text)] outline-none transition focus:border-[var(--theme-accent)]"
            >
              <option value="quick">Quick</option>
              <option value="task">Task</option>
              <option value="build">Build</option>
              <option value="deep">Deep</option>
            </select>
          </label>

          <label className="grid gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--theme-muted)]">
              Assignee
            </span>
            <select
              value={profile}
              onChange={(event) => setProfile(event.target.value)}
              className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-input)] px-3 py-2 text-sm text-[var(--theme-text)] outline-none transition focus:border-[var(--theme-accent)]"
            >
              {availableProfiles.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.displayName}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--theme-muted)]">
              Autonomy
            </span>
            <select
              value={autonomy}
              onChange={(event) =>
                setAutonomy(event.target.value as 'low' | 'medium' | 'high')
              }
              className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-input)] px-3 py-2 text-sm text-[var(--theme-text)] outline-none transition focus:border-[var(--theme-accent)]"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>

          <label className="grid gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--theme-muted)]">
              Model override
            </span>
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="Optional"
              className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-input)] px-3 py-2 text-sm text-[var(--theme-text)] outline-none transition placeholder:text-[var(--theme-muted)] focus:border-[var(--theme-accent)]"
            />
          </label>
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-[var(--theme-muted)]">
            Launch creates a durable mission record and scheduler-backed runtime target.
          </p>
          <button
            type="submit"
            disabled={isLaunching || !goal.trim()}
            className="rounded-full border border-[var(--theme-accent)] bg-[var(--theme-accent)] px-4 py-2 text-sm font-semibold transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ color: '#fff' }}
          >
            {isLaunching ? 'Launching…' : 'Launch mission'}
          </button>
        </div>
      </form>
    </section>
  )
}
