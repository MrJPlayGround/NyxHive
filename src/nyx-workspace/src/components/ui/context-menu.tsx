'use client'

import { ContextMenu } from '@base-ui/react/context-menu'
import { cn } from '@/lib/utils'

type ContextMenuRootProps = React.ComponentProps<typeof ContextMenu.Root>

function ContextMenuRoot({ children, ...props }: ContextMenuRootProps) {
  return <ContextMenu.Root {...props}>{children}</ContextMenu.Root>
}

type ContextMenuTriggerProps = React.ComponentProps<typeof ContextMenu.Trigger>

function ContextMenuTrigger({ className, ...props }: ContextMenuTriggerProps) {
  return <ContextMenu.Trigger className={cn(className)} {...props} />
}

type ContextMenuContentProps = {
  className?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  children: React.ReactNode
}

function ContextMenuContent({
  className,
  side = 'bottom',
  align = 'start',
  children,
}: ContextMenuContentProps) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Positioner side={side} align={align}>
        <ContextMenu.Popup
          className={cn('min-w-[160px] rounded-lg p-1 text-sm shadow-lg', className)}
          style={{
            background: 'var(--theme-card)',
            color: 'var(--theme-text)',
            border: '1px solid var(--theme-border)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            opacity: 1,
            zIndex: 9999,
          }}
        >
          {children}
        </ContextMenu.Popup>
      </ContextMenu.Positioner>
    </ContextMenu.Portal>
  )
}

type ContextMenuItemProps = React.ComponentProps<typeof ContextMenu.Item>

function ContextMenuItem({ className, ...props }: ContextMenuItemProps) {
  return (
    <ContextMenu.Item
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm select-none font-[450]',
        className,
      )}
      style={{ color: 'var(--theme-text)' }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLElement).style.background = 'var(--theme-card2)'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLElement).style.background = 'transparent'
      }}
      {...props}
    />
  )
}

export {
  ContextMenuRoot,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
}
