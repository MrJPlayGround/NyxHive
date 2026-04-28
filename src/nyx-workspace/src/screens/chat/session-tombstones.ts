type Tombstone = {
  id: string
  expiresAt: number
}

const TOMBSTONE_TTL_MS = 8000
const tombstones = new Map<string, Tombstone>()

export function markSessionDeleted(id: string) {
  if (!id) return
  tombstones.set(id, { id, expiresAt: Date.now() + TOMBSTONE_TTL_MS })
}

export function markSessionDeletedIds(...ids: Array<string | undefined | null>) {
  for (const id of ids) {
    if (typeof id === 'string') markSessionDeleted(id)
  }
}

export function clearSessionDeleted(id: string) {
  if (!id) return
  tombstones.delete(id)
}

export function clearSessionDeletedIds(
  ...ids: Array<string | undefined | null>
) {
  for (const id of ids) {
    if (typeof id === 'string') clearSessionDeleted(id)
  }
}

function pruneConfirmedTombstones<T extends { key: string; friendlyId: string }>(
  sessions: Array<T>,
  now: number,
) {
  if (tombstones.size === 0) return
  const visibleSessionIds = new Set<string>()
  for (const session of sessions) {
    if (session.key) visibleSessionIds.add(session.key)
    if (session.friendlyId) visibleSessionIds.add(session.friendlyId)
  }

  for (const [id, tombstone] of tombstones) {
    if (tombstone.expiresAt > now) continue
    if (visibleSessionIds.has(id)) continue
    tombstones.delete(id)
  }
}

export function filterSessionsWithTombstones<
  T extends { key: string; friendlyId: string },
>(sessions: Array<T>) {
  if (tombstones.size === 0) return sessions
  const now = Date.now()
  pruneConfirmedTombstones(sessions, now)
  if (tombstones.size === 0) return sessions

  let changed = false
  const next = sessions.filter((session) => {
    if (tombstones.has(session.key) || tombstones.has(session.friendlyId)) {
      changed = true
      return false
    }
    return true
  })
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety
  return changed ? next : sessions
}
