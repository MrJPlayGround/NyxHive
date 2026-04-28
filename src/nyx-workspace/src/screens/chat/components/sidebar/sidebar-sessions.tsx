'use client'

import { HugeiconsIcon } from '@hugeicons/react'
import { ArrowDown01Icon } from '@hugeicons/core-free-icons'
import { memo, useMemo } from 'react'
import { SessionItem } from './session-item'
import type { SessionMeta } from '../../types'
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  ScrollAreaRoot,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { usePinnedSessions } from '@/hooks/use-pinned-sessions'
import { deriveSessionBuckets } from '../../workspace-ux-state'

type SidebarSessionsProps = {
  sessions: Array<SessionMeta>
  activeFriendlyId: string
  activeRuntimeSessionKeys?: Set<string>
  defaultOpen?: boolean
  onSelect?: () => void
  onRename: (session: SessionMeta) => void
  onDelete: (session: SessionMeta) => void
  onDeleteMany?: (sessions: Array<SessionMeta>) => void
  loading: boolean
  fetching: boolean
  error: string | null
  onRetry: () => void
}

export function isRuntimeActiveSession(
  session: Pick<SessionMeta, 'key' | 'friendlyId'>,
  activeRuntimeSessionKeys?: Set<string>,
): boolean {
  if (!activeRuntimeSessionKeys || activeRuntimeSessionKeys.size === 0) {
    return false
  }
  return (
    activeRuntimeSessionKeys.has(session.key) ||
    activeRuntimeSessionKeys.has(session.friendlyId)
  )
}

export const SidebarSessions = memo(function SidebarSessions({
  sessions,
  activeFriendlyId,
  activeRuntimeSessionKeys,
  defaultOpen = true,
  onSelect,
  onRename,
  onDelete,
  onDeleteMany,
  loading,
  fetching,
  error,
  onRetry,
}: SidebarSessionsProps) {
  const { pinnedSessionKeys, togglePinnedSession } = usePinnedSessions()

  const [pinnedSessions, unpinnedSessions] = useMemo(() => {
    const pinnedKeys = new Set(pinnedSessionKeys)
    const pinned: Array<SessionMeta> = []
    const unpinned: Array<SessionMeta> = []
    for (const session of sessions) {
      if (pinnedKeys.has(session.key)) {
        pinned.push(session)
      } else {
        unpinned.push(session)
      }
    }
    return [pinned, unpinned] as const
  }, [pinnedSessionKeys, sessions])

  const unpinnedBuckets = useMemo(
    () =>
      deriveSessionBuckets({
        sessions: unpinnedSessions,
        activeRuntimeSessionKeys,
      }),
    [activeRuntimeSessionKeys, unpinnedSessions],
  )

  function handleTogglePin(session: SessionMeta) {
    togglePinnedSession(session.key)
  }

  return (
    <Collapsible
      className="flex h-full flex-col flex-1 min-h-0 w-full"
      defaultOpen={defaultOpen}
    >
      <div className="flex items-center gap-1 px-5 pt-3 pb-1">
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-none p-0 shrink-0 text-[10px] font-semibold uppercase tracking-wider hover:bg-transparent data-panel-open:text-primary-500">
          <span className="select-none">Sessions</span>
          <span className="rounded-full bg-primary-200/70 px-1.5 py-0.5 text-[9px] font-medium normal-case tracking-normal text-primary-600">
            {sessions.length}
          </span>
          <span className="ml-auto p-0.5 rounded hover:bg-primary-200 dark:hover:bg-primary-800 transition-colors">
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={12}
              strokeWidth={2}
              className="text-primary-500 transition-transform duration-150 -rotate-90 group-data-panel-open:rotate-0"
            />
          </span>
        </CollapsibleTrigger>
        {sessions.length > 0 && onDeleteMany ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[10px] normal-case text-primary-500 hover:text-red-600"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onDeleteMany(sessions)
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>

      {/* Pinned sessions — always visible (outside collapsible panel) */}
      {pinnedSessions.length > 0 ? (
        <div className="flex shrink-0 flex-col gap-px pl-3 pr-2 pt-1">
          {pinnedSessions.map((session) => (
            <SessionItem
              key={session.key}
              session={session}
              active={session.friendlyId === activeFriendlyId}
              isPinned
              runtimeActive={isRuntimeActiveSession(
                session,
                activeRuntimeSessionKeys,
              )}
              onSelect={onSelect}
              onTogglePin={handleTogglePin}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </div>
      ) : null}

      <CollapsiblePanel
        className="w-full min-h-0"
        contentClassName="flex flex-col overflow-y-auto max-h-[calc(100vh-300px)]"
      >
        <ScrollAreaRoot className="flex-1 min-h-0">
          <ScrollAreaViewport className="min-h-0">
            <div className="flex flex-col gap-px pl-3 pr-2">
              {loading ? (
                <div className="px-2 py-2 text-xs text-primary-500">
                  Loading sessions…
                </div>
              ) : error ? (
                <div className="px-2 py-2 text-xs text-primary-500">
                  <div className="mb-2">Failed to load sessions.</div>
                  <div className="text-[11px] opacity-80">{error}</div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="mt-2"
                    onClick={onRetry}
                  >
                    Retry
                  </Button>
                </div>
              ) : unpinnedBuckets.length > 0 ? (
                <>
                  {pinnedSessions.length > 0 ? (
                    <div className="my-1 border-t border-primary-200/80" />
                  ) : null}
                  {unpinnedBuckets.map((bucket) => (
                    <div key={bucket.id} className="contents">
                      <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary-500/80">
                        {bucket.label}
                      </div>
                      {bucket.items.map((item) => (
                        <SessionItem
                          key={item.session.key}
                          session={item.session}
                          active={item.session.friendlyId === activeFriendlyId}
                          isPinned={false}
                          runtimeActive={item.activeRuntime}
                          onSelect={onSelect}
                          onTogglePin={handleTogglePin}
                          onRename={onRename}
                          onDelete={onDelete}
                        />
                      ))}
                    </div>
                  ))}
                </>
              ) : (
                <div className="px-2 py-2 text-xs text-primary-500">
                  {pinnedSessions.length > 0
                    ? 'All sessions are pinned.'
                    : 'No sessions yet. Start a conversation →'}
                </div>
              )}
            </div>
          </ScrollAreaViewport>
          <ScrollAreaScrollbar orientation="vertical">
            <ScrollAreaThumb />
          </ScrollAreaScrollbar>
        </ScrollAreaRoot>
      </CollapsiblePanel>
    </Collapsible>
  )
}, areSidebarSessionsEqual)

function areSidebarSessionsEqual(
  prev: SidebarSessionsProps,
  next: SidebarSessionsProps,
) {
  if (prev.activeFriendlyId !== next.activeFriendlyId) return false
  if (prev.activeRuntimeSessionKeys !== next.activeRuntimeSessionKeys)
    return false
  if (prev.defaultOpen !== next.defaultOpen) return false
  if (prev.onSelect !== next.onSelect) return false
  if (prev.onRename !== next.onRename) return false
  if (prev.onDelete !== next.onDelete) return false
  if (prev.onDeleteMany !== next.onDeleteMany) return false
  if (prev.loading !== next.loading) return false
  if (prev.fetching !== next.fetching) return false
  if (prev.error !== next.error) return false
  if (prev.onRetry !== next.onRetry) return false
  if (prev.sessions === next.sessions) return true
  if (prev.sessions.length !== next.sessions.length) return false
  for (let i = 0; i < prev.sessions.length; i += 1) {
    const prevSession = prev.sessions[i]
    const nextSession = next.sessions[i]
    if (prevSession.key !== nextSession.key) return false
    if (prevSession.friendlyId !== nextSession.friendlyId) return false
    if (prevSession.label !== nextSession.label) return false
    if (prevSession.title !== nextSession.title) return false
    if (prevSession.derivedTitle !== nextSession.derivedTitle) return false
    if (prevSession.updatedAt !== nextSession.updatedAt) return false
    if (prevSession.titleStatus !== nextSession.titleStatus) return false
    if (prevSession.titleSource !== nextSession.titleSource) return false
    if (prevSession.titleError !== nextSession.titleError) return false
  }
  return true
}
