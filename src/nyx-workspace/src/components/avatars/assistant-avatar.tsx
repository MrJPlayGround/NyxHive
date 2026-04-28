import { memo } from 'react'
import { cn } from '@/lib/utils'
import { WORKSPACE_AGENT_NAME } from '@/lib/workspace-branding'

type AvatarProps = {
  size?: number
  className?: string
}

/**
 * Assistant avatar.
 */
function AssistantAvatarComponent({ size = 28, className }: AvatarProps) {
  return (
    <img
      src="/nyx-avatar.webp"
      alt={WORKSPACE_AGENT_NAME}
      className={cn('shrink-0', className)}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(4, Math.round(size * 0.15)),
      }}
    />
  )
}

export const AssistantAvatar = memo(AssistantAvatarComponent)
