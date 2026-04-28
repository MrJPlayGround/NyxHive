'use client'

import { Link } from '@tanstack/react-router'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Delete01Icon,
  MoreHorizontalIcon,
  Pen01Icon,
  PinIcon,
} from '@hugeicons/core-free-icons'
import { memo, useMemo } from 'react'
import { getMessageTimestamp } from '../../utils'
import type { SessionMeta } from '../../types'
import { formatSessionAge, getSessionUxTitle } from '../../workspace-ux-state'
import { cn } from '@/lib/utils'
import {
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
} from '@/components/ui/menu'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRoot,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

type SessionItemProps = {
  session: SessionMeta
  active: boolean
  isPinned: boolean
  runtimeActive?: boolean
  onSelect?: () => void
  onTogglePin: (session: SessionMeta) => void
  onRename: (session: SessionMeta) => void
  onDelete: (session: SessionMeta) => void
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isUuidLike(value: string): boolean {
  return UUID_PATTERN.test(value.trim())
}

function getFriendlyIdLabel(friendlyId: string): string {
  if (!isUuidLike(friendlyId)) return friendlyId
  return `ID ${friendlyId.slice(0, 8)}`
}

function SessionItemComponent({
  session,
  active,
  isPinned,
  runtimeActive = false,
  onSelect,
  onTogglePin,
  onRename,
  onDelete,
}: SessionItemProps) {
  const isGenerating = session.titleStatus === 'generating'
  const isError = session.titleStatus === 'error'
  const baseTitle = isGenerating ? 'Naming…' : getSessionUxTitle(session)

  const updatedAt = useMemo(() => {
    if (typeof session.updatedAt === 'number') return session.updatedAt
    if (session.lastMessage) return getMessageTimestamp(session.lastMessage)
    return null
  }, [session.lastMessage, session.updatedAt])

  const subtitle = useMemo(() => {
    if (isError) {
      return session.titleError || 'Could not generate a title'
    }
    const parts: Array<string> = []
    if (runtimeActive) parts.push('Working')
    const formatted = formatSessionAge(updatedAt ?? undefined)
    if (formatted) parts.push(formatted)
    if (session.titleSource === 'manual') parts.push('Renamed')
    if (session.friendlyId) parts.push(getFriendlyIdLabel(session.friendlyId))
    return parts.join(' · ')
  }, [
    isError,
    runtimeActive,
    session.friendlyId,
    session.titleError,
    session.titleSource,
    updatedAt,
  ])

  const menuItems = (Item: typeof MenuItem | typeof ContextMenuItem) => (
    <>
      <Item
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onTogglePin(session)
        }}
        className="gap-2"
      >
        <HugeiconsIcon icon={PinIcon} size={20} strokeWidth={1.5} />{' '}
        {isPinned ? 'Unpin session' : 'Pin session'}
      </Item>
      <Item
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onRename(session)
        }}
        className="gap-2"
      >
        <HugeiconsIcon icon={Pen01Icon} size={20} strokeWidth={1.5} />{' '}
        Rename
      </Item>
      <Item
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onDelete(session)
        }}
        className="text-red-700 gap-2 hover:bg-red-50 dark:hover:bg-red-900/30/80 data-highlighted:bg-red-50/80"
      >
        <HugeiconsIcon icon={Delete01Icon} size={20} strokeWidth={1.5} />{' '}
        Delete
      </Item>
    </>
  )

  const sessionLink = (
    <Link
      to="/chat/$sessionKey"
      params={{ sessionKey: session.friendlyId }}
      onClick={() => {
        try {
          localStorage.setItem('nyx-last-session', session.friendlyId)
        } catch {}
        onSelect?.()
      }}
      className={cn(
        'group inline-flex items-center justify-between',
        'w-full text-left pl-1.5 pr-0.5 h-14 rounded-lg transition-colors duration-0',
        'select-none',
        active
          ? 'bg-primary-200 text-primary-950'
          : 'bg-transparent text-primary-950 [&:hover:not(:has(button:hover))]:bg-primary-200',
      )}
    >
      <div className="flex-1 min-w-0 py-1.5">
        <div
          className={cn(
            'truncate text-sm font-[500]',
            isGenerating ? 'text-primary-700' : '',
          )}
        >
          {runtimeActive ? (
            <span
              className="mr-1.5 inline-block size-1.5 rounded-full bg-accent-500 align-middle"
              aria-hidden="true"
            />
          ) : null}
          <span className={cn(isGenerating ? 'animate-pulse' : undefined)}>
            {baseTitle}
          </span>
        </div>
        <div
          className={cn(
            'mt-0.5 text-[11px] text-primary-600 truncate',
            isError ? 'text-red-600' : undefined,
          )}
        >
          {subtitle}
        </div>
      </div>
      <MenuRoot>
        <MenuTrigger
          type="button"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          className={cn(
            'ml-2 inline-flex size-7 items-center justify-center rounded-md text-primary-700',
            'opacity-0 transition-opacity group-hover:opacity-100 hover:bg-primary-200 dark:hover:bg-primary-800',
            'aria-expanded:opacity-100 aria-expanded:bg-primary-200',
          )}
          aria-label="Session options"
        >
          <HugeiconsIcon
            icon={MoreHorizontalIcon}
            size={20}
            strokeWidth={1.5}
          />
        </MenuTrigger>
        <MenuContent side="bottom" align="end">{menuItems(MenuItem)}</MenuContent>
      </MenuRoot>
    </Link>
  )

  return (
    <ContextMenuRoot>
      <ContextMenuTrigger className="w-full">{sessionLink}</ContextMenuTrigger>
      <ContextMenuContent side="bottom" align="start">
        {menuItems(ContextMenuItem)}
      </ContextMenuContent>
    </ContextMenuRoot>
  )
}

function areSessionItemsEqual(prev: SessionItemProps, next: SessionItemProps) {
  if (prev.active !== next.active) return false
  if (prev.isPinned !== next.isPinned) return false
  if (prev.runtimeActive !== next.runtimeActive) return false
  if (prev.onSelect !== next.onSelect) return false
  if (prev.onTogglePin !== next.onTogglePin) return false
  if (prev.onRename !== next.onRename) return false
  if (prev.onDelete !== next.onDelete) return false
  if (prev.session === next.session) return true
  return (
    prev.session.key === next.session.key &&
    prev.session.friendlyId === next.session.friendlyId &&
    prev.session.label === next.session.label &&
    prev.session.title === next.session.title &&
    prev.session.derivedTitle === next.session.derivedTitle &&
    prev.session.updatedAt === next.session.updatedAt &&
    prev.session.titleStatus === next.session.titleStatus &&
    prev.session.titleSource === next.session.titleSource &&
    prev.session.titleError === next.session.titleError
  )
}

const SessionItem = memo(SessionItemComponent, areSessionItemsEqual)

export { SessionItem }
