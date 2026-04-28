import { useEffect } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { Add01Icon, Chat01Icon } from '@hugeicons/core-free-icons'
import type { SessionMeta } from '@/screens/chat/types'
import {
  deriveSessionBuckets,
  formatSessionAge,
  getSessionUxTitle,
} from '@/screens/chat/workspace-ux-state'
import { cn } from '@/lib/utils'

type Props = {
  open: boolean
  onClose: () => void
  sessions: Array<SessionMeta>
  activeFriendlyId: string
  onSelectSession: (key: string) => void
  onNewChat: () => void
}

export function MobileSessionsPanel({
  open,
  onClose,
  sessions,
  activeFriendlyId,
  onSelectSession,
  onNewChat,
}: Props) {
  useEffect(() => {
    if (!open) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  if (!open) return null

  const sessionBuckets = deriveSessionBuckets({ sessions })

  return (
    <div className="fixed inset-0 z-[97] no-swipe md:hidden">
      <button
        type="button"
        className="absolute inset-0 bg-black/40 animate-in fade-in duration-200"
        aria-label="Close sessions panel"
        onClick={onClose}
      />

      <aside
        className="no-swipe absolute inset-y-0 left-0 w-[80vw] max-w-sm border-r shadow-2xl animate-in slide-in-from-left-8 duration-200"
        style={{
          background: 'var(--color-surface, #fff)',
          borderColor: 'var(--color-border, #e5e7eb)',
        }}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-primary-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">Sessions</h2>
            <button
              type="button"
              onClick={onNewChat}
              className="inline-flex items-center gap-1 rounded-lg border border-primary-200 bg-primary-50 px-2.5 py-1.5 text-xs font-medium text-primary-700 transition-colors hover:border-accent-200 hover:text-accent-600"
            >
              <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={1.8} />
              New Chat
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {sessions.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center text-primary-500">
                <HugeiconsIcon icon={Chat01Icon} size={24} strokeWidth={1.6} />
                <p className="text-sm">No sessions yet.</p>
                <p className="text-xs text-primary-400">
                  Start a conversation to see it here.
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                {sessionBuckets.map((bucket) => (
                  <div key={bucket.id} className="space-y-1">
                    <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary-500">
                      {bucket.label}
                    </div>
                    {bucket.items.map((item) => {
                      const session = item.session
                      const active = session.friendlyId === activeFriendlyId
                      const timestamp = formatSessionAge(session.updatedAt)
                      return (
                        <button
                          key={session.key}
                          type="button"
                          onClick={() => onSelectSession(session.friendlyId)}
                          className={cn(
                            'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                            active
                              ? 'border-accent-300 bg-accent-50'
                              : 'border-transparent bg-primary-50 hover:border-primary-200',
                          )}
                        >
                          <div className="truncate text-sm font-medium text-ink">
                            {getSessionUxTitle(session)}
                          </div>
                          <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-primary-500">
                            <span className="truncate">
                              {item.activeRuntime ? 'Working' : session.friendlyId}
                            </span>
                            {timestamp ? <span>{timestamp}</span> : null}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}
