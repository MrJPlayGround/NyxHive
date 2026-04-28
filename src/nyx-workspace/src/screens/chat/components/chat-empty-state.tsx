import { HugeiconsIcon } from '@hugeicons/react'
import { BrainIcon, CodeIcon, PuzzleIcon } from '@hugeicons/core-free-icons'
import { motion } from 'motion/react'
import {
  WORKSPACE_AGENT_NAME,
  WORKSPACE_DISPLAY_NAME,
} from '@/lib/workspace-branding'

type SuggestionChip = {
  label: string
  prompt: string
  icon: unknown
}

const SUGGESTIONS: Array<SuggestionChip> = [
  {
    label: 'Inspect workspace',
    prompt:
      'Inspect this workspace, summarize the active architecture, and name the next highest-leverage improvement.',
    icon: CodeIcon,
  },
  {
    label: 'Plan next run',
    prompt:
      'Turn the current goal into a short execution plan, then start with the first safe step.',
    icon: BrainIcon,
  },
  {
    label: 'Produce artifact',
    prompt: 'Create a concise markdown handoff for the current work and save it as a reusable artifact.',
    icon: PuzzleIcon,
  },
]

type ChatEmptyStateProps = {
  onSuggestionClick?: (prompt: string) => void
  compact?: boolean
}

export function ChatEmptyState({
  onSuggestionClick,
  compact = false,
}: ChatEmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="flex h-full flex-col items-center justify-center px-4 py-8"
    >
      <div className="flex max-w-xl flex-col items-center text-center">
        {/* Avatar with accent glow */}
        <div className="relative mb-5">
          <div
            className="absolute inset-0 rounded-2xl blur-2xl opacity-35"
            style={{
              background: 'var(--theme-accent)',
              transform: 'scale(1.6)',
            }}
          />
          <img
            src="/nyx-avatar.webp"
            alt={WORKSPACE_AGENT_NAME}
            className="relative size-20 rounded-2xl"
            style={{
              boxShadow:
                '0 8px 32px color-mix(in srgb, var(--theme-accent) 30%, transparent)',
            }}
          />
        </div>

        {/* Title + value prop */}
        <h2
          className="text-xl font-semibold tracking-tight"
          style={{ color: 'var(--theme-text)' }}
        >
          {WORKSPACE_DISPLAY_NAME}
        </h2>

        {!compact && (
          <>
            <p className="mt-2 text-sm" style={{ color: 'var(--theme-muted)' }}>
              Agent workspace · sessions · approvals · artifacts · runtime trace
            </p>
          </>
        )}

        {/* Prompt chips */}
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion.label}
              type="button"
              onClick={() => onSuggestionClick?.(suggestion.prompt)}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-medium transition-all hover:scale-[1.02]"
              style={{
                background: 'var(--theme-card)',
                border: '1px solid var(--theme-border)',
                color: 'var(--theme-text)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--theme-card2)'
                e.currentTarget.style.borderColor = 'var(--theme-accent-border)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--theme-card)'
                e.currentTarget.style.borderColor = 'var(--theme-border)'
              }}
            >
              <HugeiconsIcon
                icon={suggestion.icon as any}
                size={14}
                strokeWidth={1.5}
                style={{ color: 'var(--theme-accent)' }}
              />
              {suggestion.label}
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  )
}
