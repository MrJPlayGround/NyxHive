import { memo } from 'react'
import { cn } from '@/lib/utils'

export const DEFAULT_USER_AVATAR_SRC = '/jay-avatar.png'

type AvatarProps = {
  size?: number
  className?: string
  src?: string | null
  alt?: string
}

/**
 * User avatar — same logo family as assistant.
 * Dark slate rounded square with orange person silhouette + accent.
 */
function UserAvatarComponent({
  size = 28,
  className,
  src,
  alt = 'User',
}: AvatarProps) {
  return (
    <img
      src={src && src.trim().length > 0 ? src : DEFAULT_USER_AVATAR_SRC}
      alt={alt}
      className={cn('shrink-0 object-cover', className)}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(6, Math.round(size * 0.2)),
      }}
    />
  )
}

export const UserAvatar = memo(UserAvatarComponent)
