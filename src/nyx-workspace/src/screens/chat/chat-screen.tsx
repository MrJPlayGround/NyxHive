// Module-level local model override — set by composer when user picks a local model
// Avoids prop threading. Reset when switching back to cloud models.
export let _localModelOverride = ''
export function setLocalModelOverride(model: string) {
  _localModelOverride = model
}

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import {
  deriveFriendlyIdFromKey,
  isMissingAuth,
  readError,
  streamingTextForMessageList,
  textFromMessage,
} from './utils'
import {
  captureWaitingBaseline,
  createDeferredNewChatSend,
  createOptimisticMessage,
  decideActiveSubmitBehavior,
  nextWaitingBaseline,
  resolveUiSlashCommandAction,
  shouldFinishWaitingForAssistant,
} from './chat-screen-utils'
import {
  appendHistoryMessage,
  chatQueryKeys,
  clearHistoryMessages,
  fetchStatus,
  removeHistoryMessageByClientId,
  updateHistoryMessageByClientId,
  updateHistoryMessageByClientIdEverywhere,
  updateSessionLastMessage,
} from './chat-queries'
import { ChatHeader } from './components/chat-header'
import { ChatMessageList } from './components/chat-message-list'
import { ChatEmptyState } from './components/chat-empty-state'
import { ChatComposer } from './components/chat-composer'
import { ConnectionStatusMessage } from './components/connection-status-message'
import {
  consumePendingSend,
  hasPendingGeneration,
  hasPendingSend,
  isRecentSession,
  clearPendingSendForSession,
  resetPendingSend,
  stashPendingSend,
  setPendingGeneration,
} from './pending-send'
import { useChatMeasurements } from './hooks/use-chat-measurements'
import { useChatHistory } from './hooks/use-chat-history'
import { useRealtimeChatHistory } from './hooks/use-realtime-chat-history'
import { useSmoothStreamingText } from './hooks/use-smooth-streaming-text'
import { useStreamingMessage } from './hooks/use-streaming-message'
import { useActiveRunCheck } from './hooks/use-active-run-check'
import { useChatMobile } from './hooks/use-chat-mobile'
import { useChatSessions } from './hooks/use-chat-sessions'
import { useAutoSessionTitle } from './hooks/use-auto-session-title'
import { useRenameSession } from './hooks/use-rename-session'
import { useContextAlert } from './hooks/use-context-alert'
import { ContextBar } from './components/context-bar'
import {
  CHAT_OPEN_SETTINGS_EVENT,
  CHAT_PENDING_COMMAND_STORAGE_KEY,
  CHAT_RUN_COMMAND_EVENT,
} from './chat-events'
import type {
  ChatComposerAttachment,
  ChatComposerHandle,
  ChatComposerHelpers,
  ConversationMode,
  ConversationModePreference,
  ThinkingLevel,
} from './components/chat-composer'
import { resolveAutoConversationMode } from './conversation-mode-router'
import type { ApprovalRequest } from '@/lib/approvals-store'
import type {
  ChatAttachment,
  ChatMessage,
  HistoryResponse,
  SessionMeta,
} from './types'
import type { ChatRunCommandDetail } from './chat-events'
import {
  addApproval,
  loadApprovals,
  saveApprovals,
} from '@/lib/approvals-store'
import { stripQueuedWrapper } from '@/lib/strip-queued-wrapper'
import { cn } from '@/lib/utils'
import { toast } from '@/components/ui/toast'
import { hapticTap } from '@/lib/haptics'
import { FileExplorerSidebar } from '@/components/file-explorer'
import { SEARCH_MODAL_EVENTS } from '@/hooks/use-search-modal'
import { SIDEBAR_TOGGLE_EVENT } from '@/hooks/use-global-shortcuts'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { TerminalPanel } from '@/components/terminal-panel'
import { useTerminalPanelStore } from '@/stores/terminal-panel-store'
import { useModelSuggestions } from '@/hooks/use-model-suggestions'
import { ModelSuggestionToast } from '@/components/model-suggestion-toast'
import { MobileSessionsPanel } from '@/components/mobile-sessions-panel'
import { ContextAlertModal } from '@/components/usage-meter/context-alert-modal'
import { ErrorToastContainer, showErrorToast } from '@/components/error-toast'
// ContextMeter removed — ContextBar (PR #32) replaces it
import { useChatStore } from '@/stores/chat-store'
import { useResearchCard } from '@/hooks/use-research-card'
// MOBILE_TAB_BAR_OFFSET removed — tab bar always hidden in chat
import { useTapDebug } from '@/hooks/use-tap-debug'
import { useChatMode } from '@/hooks/use-chat-mode'
import { WORKSPACE_AGENT_NAME } from '@/lib/workspace-branding'
import {
  deriveActionRisk,
  type ActionRiskTier,
} from './workspace-ux-state'
// Activity store removed — not used in Nyx Workspace
const _noopSetActivity = (_s: string) => {}

const THINKING_DEFAULT_STORAGE_KEY = 'nyx-thinking-default'
const CONVERSATION_MODE_DEFAULT_STORAGE_KEY = 'nyx-conversation-mode-default'

function normalizeThinkingLevel(value: string | null): ThinkingLevel | null {
  if (value === 'adaptive') return 'high'
  if (
    value === 'off' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high'
  ) {
    return value
  }
  return null
}

function normalizeConversationMode(
  value: string | null,
): ConversationModePreference | null {
  if (value === 'auto') return 'auto'
  if (
    value === 'quick' ||
    value === 'task' ||
    value === 'build' ||
    value === 'deep'
  ) {
    return value
  }
  return null
}

function recommendedThinkingForMode(
  mode: ConversationModePreference,
): ThinkingLevel {
  if (mode === 'auto') return 'low'
  if (mode === 'quick') return 'low'
  if (mode === 'task') return 'medium'
  return 'high'
}

function approvalRiskClass(tier: ActionRiskTier): string {
  if (tier === 'high') {
    return 'border-red-300 bg-red-50 text-red-700 dark:border-red-800/60 dark:bg-red-950/30 dark:text-red-300'
  }
  if (tier === 'medium') {
    return 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300'
  }
  return 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-300'
}

type ChatScreenProps = {
  activeFriendlyId: string
  isNewChat?: boolean
  onSessionResolved?: (payload: {
    sessionKey: string
    friendlyId: string
  }) => void
  forcedSessionKey?: string
  /** Hide header + file explorer + terminal for panel mode */
  compact?: boolean
}

type PortableHistoryMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

type QueuedFollowupSend = {
  sessionKey: string
  friendlyId: string
  body: string
  attachments: Array<ChatAttachment>
  fastMode: boolean
  clientId: string
  conversationMode: ConversationModePreference
}

function normalizeMimeType(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

function isImageMimeType(value: unknown): boolean {
  const normalized = normalizeMimeType(value)
  return normalized.startsWith('image/')
}

function readDataUrlMimeType(value: unknown): string {
  if (typeof value !== 'string') return ''
  const match = /^data:([^;,]+)[^,]*,/i.exec(value.trim())
  return match?.[1]?.trim().toLowerCase() || ''
}

function stripDataUrlPrefix(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  const commaIndex = trimmed.indexOf(',')
  if (trimmed.toLowerCase().startsWith('data:') && commaIndex >= 0) {
    return trimmed.slice(commaIndex + 1).trim()
  }
  return trimmed
}

function normalizeMessageValue(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : ''
}

function getPortableHistoryContent(message: ChatMessage): string {
  const text = textFromMessage(message).trim()
  if (text) return text
  if (
    message.role === 'user' &&
    Array.isArray(message.attachments) &&
    message.attachments.length > 0
  ) {
    return 'Please review the attached content.'
  }
  return ''
}

function buildPortableHistory(
  messages: Array<ChatMessage>,
): Array<PortableHistoryMessage> {
  return messages
    .filter(
      (
        message,
      ): message is ChatMessage & { role: 'user' | 'assistant' | 'system' } =>
        message.role === 'user' ||
        message.role === 'assistant' ||
        message.role === 'system',
    )
    .filter((message) => (message as any).__streamingStatus !== 'streaming')
    .map((message) => {
      const content = getPortableHistoryContent(message)
      if (!content) return null
      return {
        role: message.role,
        content,
      }
    })
    .filter((message): message is PortableHistoryMessage => message !== null)
    .slice(-20)
}

function sanitizeExportToken(value: string): string {
  return value
    .trim()
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/^-+|-+$/g, '')
}

function exportConversationTranscript(payload: {
  sessionLabel: string
  messages: Array<ChatMessage>
}) {
  if (typeof document === 'undefined') return false

  const sessionToken =
    sanitizeExportToken(payload.sessionLabel) || 'conversation'
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const body = payload.messages
    .map((message) => {
      const role =
        typeof message.role === 'string' && message.role.trim()
          ? message.role.trim().toUpperCase()
          : 'MESSAGE'
      const text = textFromMessage(message).trim()
      const attachments = Array.isArray(message.attachments)
        ? message.attachments
            .map((attachment) => attachment?.name?.trim())
            .filter((value): value is string => Boolean(value))
        : []

      const lines = [`## ${role}`]
      if (text) lines.push(text)
      if (attachments.length > 0) {
        lines.push('', 'Attachments:')
        for (const attachment of attachments) {
          lines.push(`- ${attachment}`)
        }
      }
      return lines.join('\n')
    })
    .join('\n\n')
    .trim()

  const content = `# ${WORKSPACE_AGENT_NAME} Conversation Export\n\nSession: ${payload.sessionLabel}\nExported: ${new Date().toISOString()}\n\n${body || '_No messages in this conversation._'}\n`
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${sessionToken}-${timestamp}.md`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
  return true
}

function messageFallbackSignature(message: ChatMessage): string {
  const raw = message as Record<string, unknown>
  const timestamp = normalizeMessageValue(
    typeof raw.timestamp === 'number' ? String(raw.timestamp) : raw.timestamp,
  )

  const contentParts = Array.isArray(message.content)
    ? message.content
        .map((part: any) => {
          if (part.type === 'text') {
            return `t:${typeof part.text === 'string' ? part.text.trim() : ''}`
          }
          if (part.type === 'thinking') {
            return `th:${typeof part.thinking === 'string' ? part.thinking : ''}`
          }
          if (part.type === 'toolCall') {
            const toolPart = part
            return `tc:${toolPart.id ?? ''}:${toolPart.name ?? ''}`
          }
          return `p:${part.type ?? ''}`
        })
        .join('|')
    : ''

  const attachments = Array.isArray(message.attachments)
    ? message.attachments
        .map((attachment) => {
          const name =
            typeof attachment?.name === 'string' ? attachment.name : ''
          const size =
            typeof attachment?.size === 'number' ? String(attachment.size) : ''
          const type =
            typeof attachment?.contentType === 'string'
              ? attachment.contentType
              : ''
          return `${name}:${size}:${type}`
        })
        .join('|')
    : ''

  return `${message.role ?? 'unknown'}:${timestamp}:${contentParts}:${attachments}`
}

function getMessageClientId(message: ChatMessage): string {
  const raw = message as Record<string, unknown>
  const directClientId = normalizeMessageValue(raw.clientId)
  if (directClientId) return directClientId

  const alternateClientId = normalizeMessageValue(raw.client_id)
  if (alternateClientId) return alternateClientId

  const optimisticId = normalizeMessageValue(raw.__optimisticId)
  if (optimisticId.startsWith('opt-')) {
    return optimisticId.slice(4)
  }
  return ''
}

function getRetryMessageKey(message: ChatMessage): string {
  const clientId = getMessageClientId(message)
  if (clientId) return `client:${clientId}`

  const raw = message as Record<string, unknown>
  const optimisticId = normalizeMessageValue(raw.__optimisticId)
  if (optimisticId) return `optimistic:${optimisticId}`

  const messageId = normalizeMessageValue(raw.id)
  if (messageId) return `id:${messageId}`

  const timestamp = normalizeMessageValue(
    typeof raw.timestamp === 'number' ? String(raw.timestamp) : raw.timestamp,
  )
  const messageText = textFromMessage(message).trim()
  return `fallback:${message.role ?? 'unknown'}:${timestamp}:${messageText}`
}

function isRetryableQueuedMessage(message: ChatMessage): boolean {
  if ((message.role || '') !== 'user') return false
  const raw = message as Record<string, unknown>
  const status = normalizeMessageValue(raw.status)
  return status === 'error'
}

const commandHelpers: ChatComposerHelpers = {
  reset() {},
  setValue() {},
  setAttachments() {},
}

function getMessageRetryAttachments(
  message: ChatMessage,
): Array<ChatAttachment> {
  if (!Array.isArray(message.attachments)) return []
  return message.attachments.filter((attachment) => {
    return Boolean(attachment) && typeof attachment === 'object'
  })
}

function getMessageStatusValue(message: ChatMessage): string {
  return normalizeMessageValue((message as Record<string, unknown>).status)
}

function getMessageTimestampValue(message: ChatMessage): number | null {
  const raw = message as Record<string, unknown>
  const candidates = [
    raw.timestamp,
    raw.__createdAt,
    raw.createdAt,
    raw.created_at,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate < 1_000_000_000_000 ? candidate * 1000 : candidate
    }
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate)
      if (!Number.isNaN(parsed)) return parsed
    }
  }

  return null
}

function getMessageAttachmentSignature(message: ChatMessage): string {
  if (!Array.isArray(message.attachments) || message.attachments.length === 0) {
    return ''
  }

  return message.attachments
    .map((attachment) => {
      const name = typeof attachment?.name === 'string' ? attachment.name : ''
      const size =
        typeof attachment?.size === 'number' ? String(attachment.size) : ''
      const type =
        typeof attachment?.contentType === 'string'
          ? attachment.contentType
          : ''
      return `${name}:${size}:${type}`
    })
    .sort()
    .join('|')
}

function isOptimisticUserMessage(message: ChatMessage): boolean {
  const raw = message as Record<string, unknown>
  return (
    normalizeMessageValue(raw.__optimisticId).length > 0 ||
    ['sending', 'sent', 'done'].includes(getMessageStatusValue(message))
  )
}

function shouldCollapseTextDuplicate(
  existing: ChatMessage,
  candidate: ChatMessage,
): boolean {
  if (existing.role !== candidate.role) return false

  if (candidate.role === 'assistant') {
    return true
  }

  if (candidate.role !== 'user') return false

  const existingTs = getMessageTimestampValue(existing)
  const candidateTs = getMessageTimestampValue(candidate)
  if (existingTs !== null && candidateTs !== null) {
    if (Math.abs(existingTs - candidateTs) > 15_000) return false
  }

  // Collapse same-turn user duplicates even after the optimistic marker has been
  // cleared. The send path can leave us with an optimistic local message plus a
  // confirmed/history copy after completion; requiring one side to still look
  // optimistic misses that handoff and leaves both visible.
  const existingSig = getMessageAttachmentSignature(existing)
  const candidateSig = getMessageAttachmentSignature(candidate)
  if (existingSig && candidateSig) {
    return existingSig === candidateSig
  }

  return true
}

function stripQueuedWrapperFromUserMessage(message: ChatMessage): ChatMessage {
  if (message.role !== 'user') return message

  const text = textFromMessage(message)
  const cleanedText = stripQueuedWrapper(text)
  if (cleanedText === text) return message

  return {
    ...message,
    content: [{ type: 'text', text: cleanedText }],
    text: cleanedText,
    body: cleanedText,
    message: cleanedText,
  }
}

export function ChatScreen({
  activeFriendlyId,
  isNewChat = false,
  onSessionResolved,
  forcedSessionKey,
  compact = false,
}: ChatScreenProps) {
  const navigate = useNavigate()
  const chatFocusMode = useWorkspaceStore((s) => s.chatFocusMode)
  const setChatFocusMode = useWorkspaceStore((s) => s.setChatFocusMode)
  const queryClient = useQueryClient()
  const [sending, setSending] = useState(false)
  const [_creatingSession, setCreatingSession] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isRedirecting, setIsRedirecting] = useState(false)
  const { headerRef, composerRef, mainRef, pinGroupMinHeight, headerHeight } =
    useChatMeasurements()
  useTapDebug(mainRef, { label: 'chat-main' })
  const chatMode = useChatMode()
  const isPortableMode = chatMode === 'portable'
  const portableChatFriendlyId = isPortableMode ? 'main' : activeFriendlyId
  // --- Issue #43 fix: lift waitingForResponse into persistent Zustand store ---
  // The store survives component unmount, so navigating away mid-stream
  // doesn't lose the "waiting" flag. sessionStorage backup handles reloads.
  const storeWaiting = useChatStore((s) => s.waitingSessionKeys)
  // resolvedSessionKey isn't available yet (defined below), so we track it via
  // a ref that's updated once it resolves. The memo/callback read the ref.
  const sessionKeyForWaiting = useRef<string | undefined>(undefined)
  const waitingForResponse = useMemo(() => {
    const key = sessionKeyForWaiting.current
    if (!key) return hasPendingSend() || hasPendingGeneration()
    return storeWaiting.has(key)
  }, [storeWaiting])

  const setWaitingForResponse = useCallback((waiting: boolean) => {
    const store = useChatStore.getState()
    const key = sessionKeyForWaiting.current
    if (!key) return
    if (waiting) {
      store.setSessionWaiting(key)
    } else {
      store.clearSessionWaiting(key)
    }
  }, [])
  const [liveToolActivity, setLiveToolActivity] = useState<
    Array<{ name: string; timestamp: number }>
  >([])
  const streamTimer = useRef<number | null>(null)
  const failsafeTimerRef = useRef<number | null>(null)
  const lastAssistantSignature = useRef('')
  const refreshHistoryRef = useRef<() => Promise<unknown>>(() =>
    Promise.resolve(),
  )
  const retriedQueuedMessageKeysRef = useRef(new Set<string>())
  const hasSeenDisconnectRef = useRef(false)
  const hadErrorRef = useRef(false)
  const [pendingApprovals, setPendingApprovals] = useState<
    Array<ApprovalRequest>
  >([])
  const [isCompacting, setIsCompacting] = useState(false)
  const [researchResetKey, setResearchResetKey] = useState(0)
  const [failedSendClientIds, setFailedSendClientIds] = useState<Set<string>>(
    () => new Set(),
  )
  // Per-session conversation mode — stored in localStorage and used as the default for new sessions
  const [conversationMode, setConversationMode] = useState<ConversationModePreference>(
    () => {
      if (typeof window === 'undefined') return 'build'
      const sessionId = activeFriendlyId || 'new'
      const key = `nyx-conversation-mode-${sessionId}`
      const stored =
        window.localStorage.getItem(key) ||
        window.localStorage.getItem(CONVERSATION_MODE_DEFAULT_STORAGE_KEY)
      return normalizeConversationMode(stored) ?? 'build'
    },
  )
  // Per-session reasoning level — stored in localStorage and used as the default for new sessions
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() => {
    if (typeof window === 'undefined') return 'high'
    const sessionId = activeFriendlyId || 'new'
    const key = `nyx-thinking-${sessionId}`
    const legacyKey = `hermes-thinking-${sessionId}`
    const modeKey = `nyx-conversation-mode-${sessionId}`
    const storedMode =
      normalizeConversationMode(
        window.localStorage.getItem(modeKey) ||
          window.localStorage.getItem(CONVERSATION_MODE_DEFAULT_STORAGE_KEY),
      ) ?? 'build'
    const stored =
      window.localStorage.getItem(key) ||
      window.sessionStorage.getItem(key) ||
      window.sessionStorage.getItem(legacyKey) ||
      window.localStorage.getItem(THINKING_DEFAULT_STORAGE_KEY)
    return normalizeThinkingLevel(stored) ?? recommendedThinkingForMode(storedMode)
  })
  const { alertOpen, alertThreshold, alertPercent, dismissAlert } =
    useContextAlert()

  useEffect(() => {
    if (typeof window === 'undefined') return
    const sessionId = activeFriendlyId || 'new'
    const modeKey = `nyx-conversation-mode-${sessionId}`
    const storedMode =
      normalizeConversationMode(
        window.localStorage.getItem(modeKey) ||
          window.localStorage.getItem(CONVERSATION_MODE_DEFAULT_STORAGE_KEY),
      ) ?? 'build'
    setConversationMode(storedMode)
    const key = `nyx-thinking-${sessionId}`
    const legacyKey = `hermes-thinking-${sessionId}`
    const stored =
      window.localStorage.getItem(key) ||
      window.sessionStorage.getItem(key) ||
      window.sessionStorage.getItem(legacyKey) ||
      window.localStorage.getItem(THINKING_DEFAULT_STORAGE_KEY)
    setThinkingLevel(
      normalizeThinkingLevel(stored) ?? recommendedThinkingForMode(storedMode),
    )
  }, [activeFriendlyId])

  const pendingStartRef = useRef(false)
  const composerHandleRef = useRef<ChatComposerHandle | null>(null)
  // Idempotency guard prevents duplicate sends on paste/attach double-fire.
  const lastSendKeyRef = useRef('')
  const lastSendAtRef = useRef(0)
  const activeSendRef = useRef<{
    sessionKey: string
    friendlyId: string
    clientId: string
  } | null>(null)
  const queuedFollowupRef = useRef<QueuedFollowupSend | null>(null)
  const [queuedFollowupVersion, setQueuedFollowupVersion] = useState(0)
  const [fileExplorerCollapsed, setFileExplorerCollapsed] = useState(() => {
    if (typeof window === 'undefined') return true
    const stored =
      localStorage.getItem('nyx-file-explorer-collapsed') ||
      localStorage.getItem('hermes-file-explorer-collapsed')
    return stored === null ? true : stored === 'true'
  })
  const { isMobile } = useChatMobile(queryClient)
  const mobileKeyboardInset = useWorkspaceStore((s) => s.mobileKeyboardInset)
  const mobileComposerFocused = useWorkspaceStore(
    (s) => s.mobileComposerFocused,
  )
  const mobileKeyboardActive = mobileKeyboardInset > 0 || mobileComposerFocused
  void mobileKeyboardActive // kept for future use
  const isTerminalPanelOpen = useTerminalPanelStore(
    (state) => state.isPanelOpen,
  )
  const terminalPanelHeight = useTerminalPanelStore(
    (state) => state.panelHeight,
  )
  const { renameSession, renaming: renamingSessionTitle } = useRenameSession()
  const sseConnectionState = useChatStore((s) => s.connectionState)
  const restoreStreamingSession = useChatStore((s) => s.restoreStreamingSession)

  const {
    sessionsQuery,
    sessions,
    activeSession,
    activeExists,
    activeSessionKey,
    activeTitle,
    sessionsError,
    sessionsLoading: _sessionsLoading,
    sessionsFetching: _sessionsFetching,
    refetchSessions: _refetchSessions,
  } = useChatSessions({ activeFriendlyId, isNewChat, forcedSessionKey })
  const {
    historyQuery,
    historyMessages,
    messageCount,
    historyError,
    resolvedSessionKey,
    activeCanonicalKey,
    sessionKeyForHistory,
  } = useChatHistory({
    activeFriendlyId: portableChatFriendlyId,
    activeSessionKey,
    forcedSessionKey,
    isNewChat,
    isRedirecting,
    activeExists,
    sessionsReady: sessionsQuery.isSuccess,
    queryClient,
    historyRefetchInterval: sseConnectionState === 'connected' ? 30_000 : 5_000,
    portableMode: isPortableMode,
  })

  // Keep the waiting-state ref in sync with the resolved session key
  sessionKeyForWaiting.current = resolvedSessionKey

  useEffect(() => {
    const candidates = [
      resolvedSessionKey,
      sessionKeyForHistory,
      activeCanonicalKey,
      activeFriendlyId,
    ]
    for (const key of candidates) {
      const normalized = typeof key === 'string' ? key.trim() : ''
      if (normalized) restoreStreamingSession(normalized)
    }
  }, [
    activeCanonicalKey,
    activeFriendlyId,
    resolvedSessionKey,
    restoreStreamingSession,
    sessionKeyForHistory,
  ])

  // On remount, check if the server still has an active run for this session.
  // If so, re-set waitingForResponse in the store so the UI shows the spinner.
  useActiveRunCheck({
    sessionKey: resolvedSessionKey ?? '',
    enabled:
      !isNewChat && Boolean(resolvedSessionKey) && historyQuery.isSuccess,
  })

  // Wire SSE realtime stream for instant message delivery
  const {
    messages: realtimeMessages,
    lastCompletedRunAt,
    connectionState,
    isRealtimeStreaming,
    realtimeStreamingText,
    realtimeStreamingThinking,
    realtimeLifecycleEvents,
    completedStreamingText,
    completedStreamingThinking,
    clearCompletedStreaming,
    activeToolCalls,
  } = useRealtimeChatHistory({
    sessionKey: isPortableMode
      ? 'main'
      : isNewChat
        ? 'new'
        : resolvedSessionKey ||
          sessionKeyForHistory ||
          activeCanonicalKey ||
          'main',
    friendlyId: portableChatFriendlyId,
    historyMessages,
    portableMode: isPortableMode,
    enabled:
      // Always enable for new chats in portable mode (no sessions API to resolve).
      // In enhanced mode, wait for session resolution before subscribing.
      ((isPortableMode && isNewChat) ||
        (!isNewChat &&
          Boolean(
            resolvedSessionKey || sessionKeyForHistory || activeCanonicalKey,
          ))) &&
      !isRedirecting,
    onUserMessage: useCallback(() => {
      // External message arrived (e.g. from Telegram) — show thinking indicator
      setWaitingForResponse(true)
      setPendingGeneration(true)
    }, []),
    onApprovalRequest: useCallback((payload: Record<string, unknown>) => {
      const approvalId =
        typeof payload.id === 'string'
          ? payload.id
          : typeof payload.approvalId === 'string'
            ? payload.approvalId
            : typeof payload.approvalId === 'string'
              ? payload.approvalId
              : ''

      const currentApprovals = loadApprovals()
      if (
        approvalId &&
        currentApprovals.some((entry) => {
          return entry.status === 'pending' && entry.approvalId === approvalId
        })
      ) {
        setPendingApprovals(
          currentApprovals.filter((entry) => entry.status === 'pending'),
        )
        return
      }

      const actionValue = payload.action ?? payload.tool ?? payload.command
      const action =
        typeof actionValue === 'string'
          ? actionValue
          : actionValue
            ? JSON.stringify(actionValue)
            : 'Tool call requires approval'
      const contextValue = payload.context ?? payload.input ?? payload.args
      const context =
        typeof contextValue === 'string'
          ? contextValue
          : contextValue
            ? JSON.stringify(contextValue)
            : ''
      const agentNameValue =
        payload.agentName ?? payload.agent ?? payload.source
      const agentName =
        typeof agentNameValue === 'string' && agentNameValue.trim().length > 0
          ? agentNameValue
          : 'Agent'
      const agentIdValue =
        payload.agentId ?? payload.sessionKey ?? payload.source
      const agentId =
        typeof agentIdValue === 'string' && agentIdValue.trim().length > 0
          ? agentIdValue
          : 'nyx'

      addApproval({
        agentId,
        agentName,
        action,
        context,
        source: 'nyx',
        approvalId: approvalId || undefined,
      })
      setPendingApprovals(
        loadApprovals().filter((entry) => entry.status === 'pending'),
      )
    }, []),
    onCompactionStart: useCallback(() => {
      setIsCompacting(true)
    }, []),
    onCompactionEnd: useCallback(() => {
      setIsCompacting(false)
    }, []),
  })

  // Keep activity stream open persistently — opens on mount so it's ready
  // before the first tool call fires (avoids connection latency gap).
  const waitingForResponseRef = useRef(waitingForResponse)
  useEffect(() => {
    waitingForResponseRef.current = waitingForResponse
  }, [waitingForResponse])

  useEffect(() => {
    const events = new EventSource('/api/events')
    const onActivity = (event: MessageEvent) => {
      // Only populate pills while waiting — but connection stays warm always
      if (!waitingForResponseRef.current) return
      try {
        const payload = JSON.parse(event.data) as {
          type?: unknown
          title?: unknown
        }
        if (payload.type !== 'tool' || typeof payload.title !== 'string') {
          return
        }
        const name = payload.title.replace(/^Tool activity:\s*/i, '').trim()
        if (!name) return
        setLiveToolActivity((prev) => {
          const filtered = prev.filter((entry) => entry.name !== name)
          return [{ name, timestamp: Date.now() }, ...filtered].slice(0, 5)
        })
      } catch {
        // Ignore malformed activity events.
      }
    }
    events.addEventListener('activity', onActivity)
    return () => {
      events.removeEventListener('activity', onActivity)
      events.close()
    }
  }, []) // mount only — stays open for session lifetime

  // Clear tool pills after response arrives (with brief delay so last pill is visible)
  useEffect(() => {
    if (waitingForResponse) return
    const timer = window.setTimeout(() => setLiveToolActivity([]), 800)
    return () => window.clearTimeout(timer)
  }, [waitingForResponse])

  useEffect(() => {
    if (!waitingForResponse) return
    clearCompletedStreaming()
  }, [clearCompletedStreaming, waitingForResponse])

  useEffect(() => {
    function checkApprovals() {
      const all = loadApprovals()
      setPendingApprovals(all.filter((entry) => entry.status === 'pending'))
    }
    checkApprovals()
    const id = window.setInterval(checkApprovals, 2000)
    return () => window.clearInterval(id)
  }, [])

  const resolvePendingApproval = useCallback(
    async (approval: ApprovalRequest, status: 'approved' | 'denied') => {
      const nextApprovals = loadApprovals().map((entry) => {
        if (entry.id !== approval.id) return entry
        return {
          ...entry,
          status,
          resolvedAt: Date.now(),
        }
      })
      saveApprovals(nextApprovals)
      setPendingApprovals(
        nextApprovals.filter((entry) => entry.status === 'pending'),
      )
      if (!approval.approvalId) return

      const endpoint =
        status === 'approved'
          ? `/api/approvals/${approval.approvalId}/approve`
          : `/api/approvals/${approval.approvalId}/deny`
      try {
        await fetch(endpoint, { method: 'POST' })
      } catch {
        // Local resolution still succeeds when API endpoint is unavailable.
      }
    },
    [],
  )

  // --- Stream management ---
  const streamStop = useCallback(() => {
    if (streamTimer.current) {
      window.clearTimeout(streamTimer.current)
      streamTimer.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      streamStop()
      if (failsafeTimerRef.current) {
        window.clearTimeout(failsafeTimerRef.current)
        failsafeTimerRef.current = null
      }
    }
  }, [streamStop])

  const streamFinish = useCallback(() => {
    streamStop()
    if (failsafeTimerRef.current) {
      window.clearTimeout(failsafeTimerRef.current)
      failsafeTimerRef.current = null
    }

    setPendingGeneration(false)

    const activeSend = activeSendRef.current
    const terminalSessionKeys = [
      'new',
      sessionKeyForWaiting.current,
      activeSend?.sessionKey,
      activeSend?.friendlyId,
      resolvedSessionKey,
      sessionKeyForHistory,
      activeCanonicalKey,
      activeSessionKey,
      activeFriendlyId,
    ]
    const store = useChatStore.getState()
    store.clearSessionWaitingForKeys(terminalSessionKeys)
    for (const key of terminalSessionKeys) {
      if (typeof key === 'string' && key.trim().length > 0) {
        store.clearStreamingSession(key.trim())
      }
    }

    if (activeSend) {
      clearPendingSendForSession(activeSend.sessionKey, activeSend.friendlyId)
    }
  }, [
    activeCanonicalKey,
    activeFriendlyId,
    activeSessionKey,
    resolvedSessionKey,
    sessionKeyForHistory,
    streamStop,
  ])

  const appendAssistantErrorMessage = useCallback(
    (messageText: string, send: typeof activeSendRef.current) => {
      const sessionKey =
        send?.sessionKey ||
        resolvedSessionKey ||
        sessionKeyForHistory ||
        activeSessionKey ||
        activeFriendlyId ||
        'main'
      const friendlyId = send?.friendlyId || activeFriendlyId || sessionKey
      appendHistoryMessage(queryClient, friendlyId, sessionKey, {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `I couldn't complete that request: ${messageText}`,
          },
        ],
        timestamp: Date.now(),
        status: 'error',
      } as ChatMessage)
    },
    [
      activeFriendlyId,
      activeSessionKey,
      queryClient,
      resolvedSessionKey,
      sessionKeyForHistory,
    ],
  )

  const streamStart = useCallback(() => {
    if (!activeFriendlyId || isNewChat) return
    // Bug #3 fix: no more 350ms polling loop — SSE handles realtime updates.
    // Single delayed fetch as fallback to catch the initial response.
    if (streamTimer.current) window.clearTimeout(streamTimer.current)
    streamTimer.current = window.setTimeout(() => {
      if (activeRealtimeStreamingRef.current) return
      void refreshHistoryRef.current()
    }, 2000)
  }, [activeFriendlyId, isNewChat])

  refreshHistoryRef.current = async function refreshHistory() {
    if (historyQuery.isFetching) return undefined

    // Snapshot any unconfirmed optimistic user messages BEFORE refetch.
    // The refetch replaces the query cache with server data — if the server
    // hasn't processed the user's POST yet, the optimistic message vanishes.
    const currentMessages = (historyQuery.data as any)?.messages as
      | Array<ChatMessage>
      | undefined
    const pendingOptimistic = (currentMessages ?? []).filter((msg) => {
      const raw = msg as Record<string, unknown>
      return (
        msg.role === 'user' &&
        (normalizeMessageValue(raw.__optimisticId).startsWith('opt-') ||
          normalizeMessageValue(raw.status) === 'sending')
      )
    })

    const result = await historyQuery.refetch()
    // Re-inject optimistic messages that weren't in the server response
    if (pendingOptimistic.length === 0) return result
    const historySessionKey = isPortableMode
      ? 'main'
      : activeSessionKey || sessionKeyForHistory || resolvedSessionKey || 'main'
    if (!portableChatFriendlyId || !historySessionKey) return result

    for (const optimistic of pendingOptimistic) {
      appendHistoryMessage(
        queryClient,
        portableChatFriendlyId,
        historySessionKey,
        optimistic,
      )
    }
    return result
  }

  const clearTimerRef = useRef<number | null>(null)

  // Failsafe: clear after done event + 10s if response never shows in display
  useEffect(() => {
    if (lastCompletedRunAt && waitingForResponse) {
      const timer = window.setTimeout(() => streamFinish(), 10000)
      return () => window.clearTimeout(timer)
    }
  }, [lastCompletedRunAt, waitingForResponse, streamFinish])

  // Hard failsafe: if waiting for 5s+ and SSE missed the done event, refetch history
  useEffect(() => {
    if (!waitingForResponse) return
    const fallback = window.setTimeout(() => {
      if (activeRealtimeStreamingRef.current) return
      void refreshHistoryRef.current()
    }, 5000)
    return () => window.clearTimeout(fallback)
  }, [waitingForResponse])

  useAutoSessionTitle({
    friendlyId: activeFriendlyId,
    sessionKey: resolvedSessionKey,
    activeSession,
    messages: historyMessages,
    messageCount,
    enabled:
      !isNewChat && Boolean(resolvedSessionKey) && historyQuery.isSuccess,
  })

  // Phase 4.1: Smart Model Suggestions
  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: async () => {
      const res = await fetch('/api/models')
      if (!res.ok) return { models: [] }
      const data = await res.json()
      return data
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  })

  const currentModelQuery = useQuery({
    queryKey: ['nyx', 'session-status-model'],
    queryFn: async () => {
      try {
        const res = await fetch('/api/session-status')
        if (!res.ok) return ''
        const data = await res.json()
        const payload = data.payload ?? data
        // Same logic as chat-composer: read model from status payload
        if (payload.model) return String(payload.model)
        if (payload.currentModel) return String(payload.currentModel)
        if (payload.modelAlias) return String(payload.modelAlias)
        if (payload.resolved?.modelProvider && payload.resolved?.model) {
          return `${payload.resolved.modelProvider}/${payload.resolved.model}`
        }
        return ''
      } catch {
        return ''
      }
    },
    refetchInterval: 30_000,
    retry: false,
  })

  const availableModelIds = useMemo(() => {
    const models = modelsQuery.data?.models || []
    return models.map((m: any) => m.id).filter((id: string) => id)
  }, [modelsQuery.data])

  const gatewayModel = currentModelQuery.data || ''
  const currentModel = _localModelOverride || gatewayModel

  // Ref so sendMessage can always read latest thinkingLevel without being in deps
  const thinkingLevelRef = useRef<ThinkingLevel>(thinkingLevel)
  useEffect(() => {
    thinkingLevelRef.current = thinkingLevel
  }, [thinkingLevel])
  const conversationModeRef = useRef<ConversationModePreference>(conversationMode)
  useEffect(() => {
    conversationModeRef.current = conversationMode
  }, [conversationMode])

  // Auto-upgrade reasoning to high for Claude 4.6 when session first loads
  const thinkingInitializedRef = useRef(false)
  useEffect(() => {
    if (!currentModel) return
    if (thinkingInitializedRef.current) return
    thinkingInitializedRef.current = true
    const is46 =
      currentModel.toLowerCase().includes('4-6') ||
      currentModel.toLowerCase().includes('claude-4.6')
    if (is46) {
      const sessionId = activeFriendlyId || 'new'
      const key = `nyx-thinking-${sessionId}`
      const legacyKey = `hermes-thinking-${sessionId}`
      const stored =
        typeof window !== 'undefined'
          ? window.localStorage.getItem(key) ||
            window.sessionStorage.getItem(key) ||
            window.sessionStorage.getItem(legacyKey) ||
            window.localStorage.getItem(THINKING_DEFAULT_STORAGE_KEY)
          : null
      // Only auto-set if not explicitly configured
      if (!stored) {
        setThinkingLevel('high')
      }
    }
  }, [currentModel, activeFriendlyId])

  // Persist thinking level changes to sessionStorage
  const handleThinkingLevelChange = useCallback(
    (level: ThinkingLevel) => {
      setThinkingLevel(level)
      if (typeof window !== 'undefined') {
        const sessionId = activeFriendlyId || 'new'
        const key = `nyx-thinking-${sessionId}`
        const legacyKey = `hermes-thinking-${sessionId}`
        window.localStorage.setItem(key, level)
        window.localStorage.setItem(THINKING_DEFAULT_STORAGE_KEY, level)
        window.sessionStorage.removeItem(key)
        window.sessionStorage.removeItem(legacyKey)
      }
    },
    [activeFriendlyId],
  )

  const handleConversationModeChange = useCallback(
    (mode: ConversationModePreference) => {
      const recommendedThinking = recommendedThinkingForMode(mode)
      setConversationMode(mode)
      setThinkingLevel(recommendedThinking)
      if (typeof window !== 'undefined') {
        const sessionId = activeFriendlyId || 'new'
        const modeKey = `nyx-conversation-mode-${sessionId}`
        const thinkingKey = `nyx-thinking-${sessionId}`
        const legacyThinkingKey = `hermes-thinking-${sessionId}`
        window.localStorage.setItem(modeKey, mode)
        window.localStorage.setItem(CONVERSATION_MODE_DEFAULT_STORAGE_KEY, mode)
        window.localStorage.setItem(thinkingKey, recommendedThinking)
        window.localStorage.setItem(
          THINKING_DEFAULT_STORAGE_KEY,
          recommendedThinking,
        )
        window.sessionStorage.removeItem(thinkingKey)
        window.sessionStorage.removeItem(legacyThinkingKey)
      }
    },
    [activeFriendlyId],
  )

  const { suggestion, dismiss, dismissForSession } = useModelSuggestions({
    currentModel, // Real model from session-status (fail closed if empty)
    sessionKey: resolvedSessionKey || 'main',
    messages: historyMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: textFromMessage(m),
    })) as any,
    availableModels: availableModelIds,
  })

  const {
    isStreaming: localIsStreaming,
    streamingText: localStreamingText,
    streamingMessageId: localStreamingMessageId,
    startStreaming,
    cancelStreaming,
  } = useStreamingMessage({
    onSessionResolved: useCallback(
      ({
        sessionKey,
        friendlyId,
      }: {
        sessionKey: string
        friendlyId: string
      }) => {
        const activeSend = activeSendRef.current
        if (activeSend) {
          activeSendRef.current = {
            ...activeSend,
            sessionKey,
            friendlyId,
          }
        }
        if (
          sessionKey === activeFriendlyId &&
          friendlyId === activeFriendlyId
        ) {
          return
        }
        onSessionResolved?.({ sessionKey, friendlyId })
      },
      [activeFriendlyId, onSessionResolved],
    ),
    onStarted: useCallback(
      ({ runId }: { runId: string | null }) => {
        const activeSend = activeSendRef.current
        if (!activeSend?.clientId) return
        updateHistoryMessageByClientIdEverywhere(
          queryClient,
          activeSend.clientId,
          (message) => ({
            ...message,
            status: 'sent',
            runId: runId ?? message.runId,
          }),
        )
        const store = useChatStore.getState()
        store.clearSessionWaitingForKeys(['new'])
        store.setSessionWaiting(activeSend.sessionKey, runId)
        setSending(false)
      },
      [queryClient],
    ),
    onComplete: useCallback(() => {
      const activeSend = activeSendRef.current
      if (activeSend?.clientId) {
        updateHistoryMessageByClientIdEverywhere(
          queryClient,
          activeSend.clientId,
          (message) => ({
            ...message,
            status: 'done',
          }),
        )
      }
      void refreshHistoryRef.current()
      setSending(false)
      // Clear waitingForResponse so ThinkingBubble hides and message renders
      streamFinish()
      activeSendRef.current = null
    }, [queryClient, streamFinish]),
    onError: useCallback(
      (messageText: string) => {
        const activeSend = activeSendRef.current
        if (activeSend?.clientId && !isMissingAuth(messageText)) {
          const sessionId =
            activeSend.friendlyId ||
            activeSend.sessionKey ||
            activeFriendlyId ||
            resolvedSessionKey ||
            activeSessionKey ||
            ''
          removeHistoryMessageByClientId(
            queryClient,
            activeSend.friendlyId || sessionId,
            activeSend.sessionKey || sessionId,
            activeSend.clientId,
          )
          if (sessionId) {
            removeHistoryMessageByClientId(
              queryClient,
              sessionId,
              sessionId,
              activeSend.clientId,
            )
          }
          setFailedSendClientIds((current) => {
            const next = new Set(current)
            next.add(activeSend.clientId)
            next.add(`opt-${activeSend.clientId}`)
            return next
          })
          const historyQueries = queryClient.getQueriesData<HistoryResponse>({
            queryKey: ['chat'],
          })
          for (const [queryKey, data] of historyQueries) {
            if (!data || !Array.isArray(data.messages)) continue
            const nextMessages = data.messages.filter((message) => {
              const raw = message as Record<string, unknown>
              return (
                raw.clientId !== activeSend.clientId &&
                raw.client_id !== activeSend.clientId &&
                raw.__optimisticId !== `opt-${activeSend.clientId}`
              )
            })
            if (nextMessages.length === data.messages.length) continue
            queryClient.setQueryData(queryKey, {
              ...data,
              messages: nextMessages,
            })
          }
        }
        setSending(false)
        streamFinish()
        activeSendRef.current = null
        if (isMissingAuth(messageText)) {
          try {
            navigate({ to: '/', replace: true })
          } catch {
            /* router not ready */
          }
          return
        }
        const errorMessage = `Failed to send message. ${messageText}`
        appendAssistantErrorMessage(messageText, activeSend)
        setError(errorMessage)
        toast('Failed to send message', { type: 'error' })
        showErrorToast(messageText)
      },
      [
        activeFriendlyId,
        activeSessionKey,
        appendAssistantErrorMessage,
        navigate,
        queryClient,
        resolvedSessionKey,
        streamFinish,
      ],
    ),
    onMessageAccepted: useCallback(
      (_sessionKey: string, friendlyId: string, clientId: string) => {
        // HTTP 200 received — server accepted the message. Clear "sending"
        // status immediately so the Retry timer never fires. This is the
        // primary confirmation path since the server does NOT echo user
        // messages back via SSE.
        updateHistoryMessageByClientId(
          queryClient,
          friendlyId,
          _sessionKey,
          clientId,
          (message) => ({
            ...message,
            status: 'queued',
          }),
        )
        updateHistoryMessageByClientIdEverywhere(
          queryClient,
          clientId,
          (message) => ({
            ...message,
            status: 'queued',
          }),
        )
      },
      [queryClient],
    ),
  })

  const activeIsRealtimeStreaming = isPortableMode
    ? localIsStreaming
    : isRealtimeStreaming
  const activeRealtimeStreamingText = isPortableMode
    ? localStreamingText
    : realtimeStreamingText
  const smoothActiveStreamingText = useSmoothStreamingText(
    activeRealtimeStreamingText,
    activeIsRealtimeStreaming,
  )

  // Use realtime-merged messages for display (SSE + history)
  // Re-apply display filter to realtime messages
  const finalDisplayMessages = useMemo(() => {
    const filtered = realtimeMessages.filter((msg) => {
      if (msg.role === 'user') {
        const raw = msg as Record<string, unknown>
        const clientId = normalizeMessageValue(raw.clientId)
        const clientIdSnake = normalizeMessageValue(raw.client_id)
        const optimisticId = normalizeMessageValue(raw.__optimisticId)
        if (
          failedSendClientIds.has(clientId) ||
          failedSendClientIds.has(clientIdSnake) ||
          failedSendClientIds.has(optimisticId)
        ) {
          return false
        }
        if (
          !sending &&
          !waitingForResponse &&
          optimisticId.startsWith('opt-') &&
          (raw.status === 'sending' || raw.status === 'error')
        ) {
          return false
        }
        const text = stripQueuedWrapper(textFromMessage(msg))
        if (text.startsWith('A subagent task')) return false
        return true
      }
      if (msg.role === 'assistant') {
        if (msg.__streamingStatus === 'streaming') return true
        if ((msg as any).__optimisticId && !msg.content?.length) return true
        if (textFromMessage(msg).trim().length > 0) return true
        const content = Array.isArray(msg.content) ? msg.content : []
        const hasToolCalls = content.some((part) => part.type === 'toolCall')
        const hasStreamToolCalls =
          Array.isArray((msg as any).__streamToolCalls) &&
          (msg as any).__streamToolCalls.length > 0
        return hasToolCalls || hasStreamToolCalls
      }
      return false
    })

    const sortedForDedup = [...filtered].sort((a, b) => {
      const aRaw = a as Record<string, unknown>
      const bRaw = b as Record<string, unknown>
      const aIsOptimistic =
        normalizeMessageValue(aRaw.__optimisticId).startsWith('opt-') &&
        !normalizeMessageValue(aRaw.id)
      const bIsOptimistic =
        normalizeMessageValue(bRaw.__optimisticId).startsWith('opt-') &&
        !normalizeMessageValue(bRaw.id)
      if (aIsOptimistic && !bIsOptimistic) return 1
      if (!aIsOptimistic && bIsOptimistic) return -1
      return 0
    })

    const seen = new Set<string>()
    const seenByText = new Map<string, ChatMessage>()
    const dedupedSet = new Set<ChatMessage>()
    for (const msg of sortedForDedup) {
      const raw = msg as Record<string, unknown>
      const rawOptimisticId = normalizeMessageValue(raw.__optimisticId)
      const bareOptimisticUuid = rawOptimisticId.startsWith('opt-')
        ? rawOptimisticId.slice(4)
        : ''
      const idCandidates = [
        normalizeMessageValue(raw.id),
        normalizeMessageValue(raw.messageId),
        normalizeMessageValue(raw.clientId),
        normalizeMessageValue(raw.client_id),
        normalizeMessageValue(raw.nonce),
        normalizeMessageValue(raw.idempotencyKey),
        bareOptimisticUuid,
        rawOptimisticId,
      ].filter(Boolean)

      const primaryKey =
        idCandidates.length > 0
          ? `${msg.role}:id:${idCandidates[0]}`
          : `${msg.role}:fallback:${messageFallbackSignature(msg)}`

      if (seen.has(primaryKey)) continue

      const text = stripQueuedWrapper(textFromMessage(msg)).trim()
      if (text.length > 0) {
        const normalizedText = text.replace(/\s+/g, ' ')
        const textKey = `${msg.role}:text:${normalizedText}`
        const existingTextMatch = seenByText.get(textKey)
        if (
          existingTextMatch &&
          shouldCollapseTextDuplicate(existingTextMatch, msg)
        ) {
          continue
        }
        if (!existingTextMatch) {
          seenByText.set(textKey, msg)
        }
      }

      seen.add(primaryKey)
      for (const candidate of idCandidates.slice(1)) {
        seen.add(`${msg.role}:id:${candidate}`)
      }
      dedupedSet.add(msg)
    }

    const deduped = filtered
      .filter((msg) => dedupedSet.has(msg))
      .map((msg) => stripQueuedWrapperFromUserMessage(msg))

    if (!activeIsRealtimeStreaming) {
      return deduped
    }

    const nextMessages = [...deduped]
    const streamToolCalls = activeToolCalls.map((toolCall) => ({
      ...toolCall,
      phase: toolCall.phase,
    }))

    const streamingMsg = {
      role: 'assistant',
      content: [],
      __optimisticId: 'streaming-current',
      __streamingStatus: 'streaming',
      __streamingText: activeRealtimeStreamingText,
      __streamingThinking: realtimeStreamingThinking,
      __streamToolCalls: streamToolCalls,
    } as ChatMessage

    const existingStreamIdx = nextMessages.findIndex(
      (message) => message.__streamingStatus === 'streaming',
    )

    if (existingStreamIdx >= 0) {
      nextMessages[existingStreamIdx] = {
        ...nextMessages[existingStreamIdx],
        ...streamingMsg,
      }
      return nextMessages
    }

    const lastUserIdx = nextMessages.reduce(
      (lastIdx, msg, idx) => (msg.role === 'user' ? idx : lastIdx),
      -1,
    )
    if (lastUserIdx >= 0 && lastUserIdx === nextMessages.length - 1) {
      nextMessages.push(streamingMsg)
    } else if (lastUserIdx >= 0) {
      nextMessages.splice(lastUserIdx + 1, 0, streamingMsg)
    } else {
      nextMessages.push(streamingMsg)
    }
    return nextMessages
  }, [
    activeToolCalls,
    activeIsRealtimeStreaming,
    activeRealtimeStreamingText,
    failedSendClientIds,
    realtimeMessages,
    realtimeStreamingThinking,
    sending,
    waitingForResponse,
  ])

  const derivedStreamingInfo = useMemo(() => {
    if (activeIsRealtimeStreaming) {
      const last = finalDisplayMessages[finalDisplayMessages.length - 1]
      const id = isPortableMode
        ? localStreamingMessageId
        : last?.role === 'assistant'
          ? (last as any).__optimisticId || (last as any).id || null
          : null
      return { isStreaming: true, streamingMessageId: id }
    }
    if (waitingForResponse && finalDisplayMessages.length > 0) {
      const last = finalDisplayMessages[finalDisplayMessages.length - 1]
      if (last && last.role === 'assistant') {
        const isStreamingPlaceholder =
          (last as any).__streamingStatus === 'streaming'
        if (!isStreamingPlaceholder) {
          return {
            isStreaming: false,
            streamingMessageId: null as string | null,
          }
        }
        const id = (last as any).__optimisticId || (last as any).id || null
        return { isStreaming: true, streamingMessageId: id }
      }
    }
    return { isStreaming: false, streamingMessageId: null as string | null }
  }, [
    waitingForResponse,
    finalDisplayMessages,
    activeIsRealtimeStreaming,
    isPortableMode,
    localStreamingMessageId,
  ])
  const messageListStreamingText = streamingTextForMessageList(
    derivedStreamingInfo.isStreaming,
    smoothActiveStreamingText || completedStreamingText.current || undefined,
  )

  const finalDisplayMessagesRef = useRef(finalDisplayMessages)
  useEffect(() => {
    finalDisplayMessagesRef.current = finalDisplayMessages
  }, [finalDisplayMessages])

  const waitingBaselineRef = useRef(captureWaitingBaseline([]))
  const wasWaitingForResponseRef = useRef(false)
  const prevIsRealtimeStreamingRef = useRef(activeIsRealtimeStreaming)
  const activeRealtimeStreamingRef = useRef(activeIsRealtimeStreaming)
  const waitingStartedAtRef = useRef<number | null>(null)
  const staleRunErrorShownRef = useRef(false)

  useEffect(() => {
    activeRealtimeStreamingRef.current = activeIsRealtimeStreaming
  }, [activeIsRealtimeStreaming])

  useEffect(() => {
    if (waitingForResponse) {
      waitingStartedAtRef.current ??= Date.now()
      return
    }
    waitingStartedAtRef.current = null
    staleRunErrorShownRef.current = false
  }, [waitingForResponse])

  useEffect(() => {
    const wasWaitingForResponse = wasWaitingForResponseRef.current
    waitingBaselineRef.current = nextWaitingBaseline({
      current: waitingBaselineRef.current,
      messages: finalDisplayMessages,
      waitingForResponse,
      wasWaitingForResponse,
    })
    wasWaitingForResponseRef.current = waitingForResponse
  }, [waitingForResponse, finalDisplayMessages])

  useEffect(() => {
    if (!waitingForResponse) {
      if (clearTimerRef.current) {
        window.clearTimeout(clearTimerRef.current)
        clearTimerRef.current = null
      }
      return
    }
    const last = finalDisplayMessages[finalDisplayMessages.length - 1]
    if (!last || last.role !== 'assistant') return
    if ((last as any).__streamingStatus === 'streaming') return
    if (
      shouldFinishWaitingForAssistant(
        finalDisplayMessages,
        waitingBaselineRef.current,
      )
    ) {
      if (clearTimerRef.current) return
      clearTimerRef.current = window.setTimeout(() => {
        clearTimerRef.current = null
        streamFinish()
      }, 50)
    }
  }, [finalDisplayMessages, waitingForResponse, streamFinish])

  // Poll active-run even when the local SSE hook reports connected. The
  // workspace stream can fail before a terminal event reaches the browser; the
  // authoritative backend state must be allowed to clear stale waiting UI.
  useEffect(() => {
    if (!waitingForResponse || !resolvedSessionKey) return
    const interval = window.setInterval(async () => {
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(resolvedSessionKey)}/active-run`,
        )
        if (!res.ok) return
        const data = await res.json()
        const runIsActive =
          data.ok &&
          data.run &&
          ['accepted', 'active', 'handoff'].includes(data.run.status)
        if (runIsActive) return

        const historyRefresh = refreshHistoryRef.current()
        if (
          historyRefresh &&
          typeof (historyRefresh as Promise<unknown>).then === 'function'
        ) {
          await historyRefresh
        }
        const waitedMs =
          Date.now() - (waitingStartedAtRef.current ?? Date.now())
        if (waitedMs < 8000) return

        const latestMessages = finalDisplayMessagesRef.current
        const hasNewAssistant = shouldFinishWaitingForAssistant(
          latestMessages,
          waitingBaselineRef.current,
        )

        if (!hasNewAssistant) {
          return
        }

        streamFinish()
        setSending(false)
        activeSendRef.current = null
      } catch {
        // ignore network errors
      }
    }, 3000)
    return () => window.clearInterval(interval)
  }, [waitingForResponse, resolvedSessionKey, streamFinish])

  useEffect(() => {
    const wasStreaming = prevIsRealtimeStreamingRef.current
    prevIsRealtimeStreamingRef.current = activeIsRealtimeStreaming
    if (wasStreaming && !activeIsRealtimeStreaming && waitingForResponse) {
      if (clearTimerRef.current) return
      clearTimerRef.current = window.setTimeout(() => {
        clearTimerRef.current = null
        streamFinish()
      }, 100)
    }
  }, [activeIsRealtimeStreaming, waitingForResponse, streamFinish])

  const handleSwitchModel = useCallback(async () => {
    if (!suggestion) return

    try {
      const res = await fetch('/api/model-switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionKey: resolvedSessionKey || 'main',
          model: suggestion.suggestedModel,
        }),
      })

      if (res.ok) {
        dismiss()
        // Optionally show success toast or update UI
      }
    } catch (err) {
      setError(
        `Failed to switch model. ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }, [suggestion, resolvedSessionKey, dismiss])

  // Sync chat activity to global store for sidebar orchestrator avatar
  const setLocalActivity = _noopSetActivity
  useEffect(() => {
    if (liveToolActivity.length > 0) {
      setLocalActivity('tool-use')
    } else if (activeIsRealtimeStreaming) {
      setLocalActivity('responding')
    } else if (waitingForResponse) {
      setLocalActivity('thinking')
    } else {
      setLocalActivity('idle')
    }
  }, [
    waitingForResponse,
    activeIsRealtimeStreaming,
    liveToolActivity,
    setLocalActivity,
  ])

  const statusQuery = useQuery({
    queryKey: ['nyx', 'status'],
    queryFn: fetchStatus,
    retry: 2,
    retryDelay: 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: true,
    staleTime: 30_000,
    refetchInterval: 60_000, // Re-check every 60s to clear stale errors
  })
  // Don't show errors for new chats or when SSE is connected
  const statusError =
    !isNewChat && connectionState !== 'connected'
      ? statusQuery.error instanceof Error
        ? {
            message: statusQuery.error.message,
            status: (statusQuery.error as Error & { status?: number }).status,
          }
        : statusQuery.data && !statusQuery.data.ok
          ? {
              message:
                statusQuery.data.error || `${WORKSPACE_AGENT_NAME} unavailable`,
              status: statusQuery.data.status,
            }
          : null
      : null
  const serverError = statusError?.message ?? sessionsError ?? historyError
  const serverErrorStatus = statusError?.status
  const showErrorNotice = Boolean(serverError) && !isNewChat
  const handleRefetch = useCallback(() => {
    void statusQuery.refetch()
    void sessionsQuery.refetch()
    void historyQuery.refetch()
  }, [statusQuery, sessionsQuery, historyQuery])

  const handleRefreshHistory = useCallback(() => {
    void historyQuery.refetch()
  }, [historyQuery])

  useEffect(() => {
    const handleRefreshRequest = () => {
      void historyQuery.refetch()
    }
    window.addEventListener('nyx:chat-refresh', handleRefreshRequest)
    return () => {
      window.removeEventListener('nyx:chat-refresh', handleRefreshRequest)
    }
  }, [historyQuery])

  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState === 'visible') {
        void historyQuery.refetch()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () =>
      document.removeEventListener('visibilitychange', handleVisibility)
  }, [historyQuery])

  // Re-mount catch-up: when navigating back to chat from another tab (Skills,
  // Memory, etc.), the component re-mounts. If a response finished while we
  // were away, the initial refetch may hit stale data. A delayed re-refetch
  // ensures we pick up responses that were persisted shortly after the first
  // fetch. See: https://github.com/outsourc-e/hermes-workspace/issues/43
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void historyQuery.refetch()
    }, 2000)
    return () => window.clearTimeout(timer)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- mount-only

  useEffect(() => {
    function handleSSEDrop() {
      void historyQuery.refetch()
    }
    window.addEventListener('nyx:sse-dropped', handleSSEDrop)
    return () => {
      window.removeEventListener('nyx:sse-dropped', handleSSEDrop)
    }
  }, [historyQuery])

  const terminalPanelInset =
    !isMobile && isTerminalPanelOpen && !chatFocusMode ? terminalPanelHeight : 0
  // --chat-composer-height is the measured offsetHeight of the composer wrapper,
  // which already includes its own paddingBottom (tab bar + safe area).
  // So content just needs composer-height + a small breathing gap.
  const mobileScrollBottomOffset = useMemo(() => {
    if (!isMobile) return 0
    return 'var(--chat-composer-height, 56px)'
  }, [isMobile])

  // Keep message list clear of composer, keyboard, and desktop terminal panel.
  const stableContentStyle = useMemo<React.CSSProperties>(() => {
    if (isMobile) {
      return {
        paddingBottom: 'calc(var(--chat-composer-height, 56px) + 8px)',
      }
    }
    return {
      paddingBottom:
        terminalPanelInset > 0 ? `${terminalPanelInset + 16}px` : '16px',
    }
  }, [isMobile, terminalPanelInset])

  const shouldRedirectToNew =
    !isNewChat &&
    !forcedSessionKey &&
    !isRecentSession(activeFriendlyId) &&
    sessionsQuery.isSuccess &&
    sessions.length > 0 &&
    !sessions.some((session) => session.friendlyId === activeFriendlyId) &&
    !historyQuery.isFetching &&
    !historyQuery.isSuccess

  useEffect(() => {
    if (isRedirecting) {
      if (error) setError(null)
      return
    }
    if (shouldRedirectToNew) {
      if (error) setError(null)
      return
    }
    if (
      sessionsQuery.isSuccess &&
      !activeExists &&
      !sessionsError &&
      !historyError
    ) {
      if (error) setError(null)
      return
    }
    const messageText = sessionsError ?? historyError ?? statusError?.message
    if (!messageText) {
      if (error?.startsWith('Failed to load')) {
        setError(null)
      }
      return
    }
    if (isMissingAuth(messageText)) {
      navigate({ to: '/', replace: true })
    }
    const message = sessionsError
      ? `Failed to load sessions. ${sessionsError}`
      : historyError
        ? `Failed to load history. ${historyError}`
        : statusError
          ? `${WORKSPACE_AGENT_NAME} unavailable. ${statusError.message}`
          : null
    if (message) setError(message)
  }, [
    activeExists,
    error,
    statusError,
    historyError,
    isRedirecting,
    navigate,
    sessionsError,
    sessionsQuery.isSuccess,
    shouldRedirectToNew,
  ])

  useEffect(() => {
    if (!isRedirecting) return
    if (isNewChat) {
      setIsRedirecting(false)
      return
    }
    if (!shouldRedirectToNew && sessionsQuery.isSuccess) {
      setIsRedirecting(false)
    }
  }, [isNewChat, isRedirecting, sessionsQuery.isSuccess, shouldRedirectToNew])

  useEffect(() => {
    if (isNewChat) return
    if (!sessionsQuery.isSuccess) return
    if (sessions.length === 0) return
    if (!shouldRedirectToNew) return
    resetPendingSend()
    clearHistoryMessages(queryClient, activeFriendlyId, sessionKeyForHistory)
    const latestSession = sessions[0]?.friendlyId ?? 'new'
    navigate({
      to: '/chat/$sessionKey',
      params: { sessionKey: latestSession },
      replace: true,
    })
  }, [
    activeFriendlyId,
    historyQuery.isFetching,
    historyQuery.isSuccess,
    isNewChat,
    navigate,
    queryClient,
    sessionKeyForHistory,
    sessions,
    sessionsQuery.isSuccess,
    shouldRedirectToNew,
  ])

  const hideUi = shouldRedirectToNew || isRedirecting
  const isFocusMode = !compact && chatFocusMode
  const showComposer = !isRedirecting

  const handleToggleFocusMode = useCallback(() => {
    if (compact) return
    setChatFocusMode(!chatFocusMode)
  }, [chatFocusMode, compact, setChatFocusMode])

  useEffect(() => {
    if (compact && chatFocusMode) {
      setChatFocusMode(false)
    }
  }, [chatFocusMode, compact, setChatFocusMode])

  useEffect(() => {
    if (!chatFocusMode) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      setChatFocusMode(false)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [chatFocusMode, setChatFocusMode])

  // ⌘. (Mac) / Ctrl+. (Win) to toggle focus mode
  useEffect(() => {
    if (compact) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '.' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      setChatFocusMode(!chatFocusMode)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [compact, chatFocusMode, setChatFocusMode])

  useEffect(() => {
    return () => {
      useWorkspaceStore.getState().setChatFocusMode(false)
    }
  }, [])

  // Reset state when session changes
  useEffect(() => {
    const resetKey = isNewChat ? 'new' : activeFriendlyId
    if (!resetKey) return
    retriedQueuedMessageKeysRef.current.clear()
    if (pendingStartRef.current) {
      pendingStartRef.current = false
      return
    }
    if (hasPendingSend() || hasPendingGeneration()) {
      setWaitingForResponse(true)
      return
    }
    streamStop()
    lastAssistantSignature.current = ''
    setWaitingForResponse(false)
  }, [activeFriendlyId, isNewChat, streamStop])

  /**
   * Simplified sendMessage - fire and forget.
   * Response arrives via SSE stream, not via this function.
   */
  const sendMessage = useCallback(
    function sendMessage(
      sessionKey: string,
      friendlyId: string,
      body: string,
      attachments: Array<ChatAttachment> = [],
      fastMode = false,
      skipOptimistic = false,
      existingClientId = '',
      conversationModeOverride?: ConversationModePreference,
    ) {
      // Read from ref so we always get the latest value without capturing it in deps
      const currentThinkingLevel = thinkingLevelRef.current
      const currentConversationModePreference =
        conversationModeOverride ?? conversationModeRef.current
      const autoResolution =
        currentConversationModePreference === 'auto'
          ? resolveAutoConversationMode({
              message: body,
              attachmentCount: attachments.length,
            })
          : null
      const currentConversationMode: ConversationMode =
        currentConversationModePreference === 'auto'
          ? autoResolution!.mode
          : currentConversationModePreference
      const effectiveThinkingLevel =
        autoResolution?.reasoning ?? currentThinkingLevel
      setLocalActivity('reading')
      const normalizedAttachments = attachments.map((attachment) => ({
        ...attachment,
        id: attachment.id ?? crypto.randomUUID(),
      }))

      // Inject text/file attachment content directly into the message body.
      // Servers reliably forward text in the message body; file attachments
      // may be silently dropped for non-image types.
      const textBlocks = normalizedAttachments
        .filter((a) => {
          const mime =
            normalizeMimeType(a.contentType ?? '') ||
            readDataUrlMimeType(a.dataUrl ?? '')
          return !isImageMimeType(mime) && (a.dataUrl ?? '').length > 0
        })
        .map((a) => {
          const raw = a.dataUrl ?? ''
          const content = raw.startsWith('data:')
            ? atob(raw.split(',')[1] ?? '')
            : raw
          return `\n\n<attachment name="${a.name ?? 'file'}">\n${content}\n</attachment>`
        })
      const enrichedBody = body + textBlocks.join('')

      let optimisticClientId = existingClientId
      setResearchResetKey((current) => current + 1)
      if (!skipOptimistic) {
        const { clientId, optimisticMessage } = createOptimisticMessage(
          body,
          normalizedAttachments,
        )
        optimisticClientId = clientId
        appendHistoryMessage(
          queryClient,
          friendlyId,
          sessionKey,
          optimisticMessage,
        )
        updateSessionLastMessage(
          queryClient,
          sessionKey,
          friendlyId,
          optimisticMessage,
        )
      }

      setPendingGeneration(true)
      setSending(true)
      setError(null)
      clearCompletedStreaming()
      setWaitingForResponse(true)
      activeSendRef.current = {
        sessionKey,
        friendlyId,
        clientId: optimisticClientId,
      }

      // Failsafe: clear waitingForResponse after 120s no matter what
      // Prevents infinite spinner if SSE/idle detection both fail
      if (failsafeTimerRef.current) {
        window.clearTimeout(failsafeTimerRef.current)
      }
      failsafeTimerRef.current = window.setTimeout(() => {
        streamFinish()
      }, 120_000)

      // Send a compatibility shape for attachment parsing.
      // Different server/channel versions read different keys.
      const payloadAttachments = normalizedAttachments.map((attachment) => {
        const mimeType =
          normalizeMimeType(attachment.contentType) ||
          readDataUrlMimeType(attachment.dataUrl)
        const isImage = isImageMimeType(mimeType)
        // For text/file attachments, dataUrl holds raw text (not a base64 data URL).
        // We must base64-encode it so the server can build a valid data: URI.
        const rawDataUrl = attachment.dataUrl ?? ''
        let encodedContent: string
        let finalDataUrl: string
        if (!isImage && !rawDataUrl.startsWith('data:')) {
          encodedContent = btoa(unescape(encodeURIComponent(rawDataUrl)))
          finalDataUrl = mimeType
            ? `data:${mimeType};base64,${encodedContent}`
            : `data:text/plain;base64,${encodedContent}`
        } else {
          encodedContent = stripDataUrlPrefix(rawDataUrl)
          finalDataUrl = rawDataUrl
        }
        return {
          id: attachment.id,
          name: attachment.name,
          fileName: attachment.name,
          contentType: mimeType || undefined,
          mimeType: mimeType || undefined,
          mediaType: mimeType || undefined,
          type: isImage ? 'image' : 'file',
          content: encodedContent,
          data: encodedContent,
          base64: encodedContent,
          dataUrl: finalDataUrl,
          size: attachment.size,
        }
      })
      const history = buildPortableHistory(finalDisplayMessages)

      try {
        streamStart()
      } catch (e) {
        if (import.meta.env.DEV) {
          console.warn('[chat] streamStart error (non-fatal):', e)
        }
      }

      void startStreaming({
        sessionKey,
        friendlyId,
        message: enrichedBody,
        history,
        attachments:
          payloadAttachments.length > 0 ? payloadAttachments : undefined,
        thinking:
          effectiveThinkingLevel === 'off' ? undefined : effectiveThinkingLevel,
        conversationMode: currentConversationMode,
        fastMode,
        model: currentModel || undefined,
        idempotencyKey: optimisticClientId || crypto.randomUUID(),
      }).catch((err: unknown) => {
        const messageText = err instanceof Error ? err.message : String(err)
        if (import.meta.env.DEV) {
          console.warn('[chat] send-stream failed', messageText)
        }
      })
    },
    [
      finalDisplayMessages,
      clearCompletedStreaming,
      queryClient,
      setLocalActivity,
      startStreaming,
      streamFinish,
      streamStart,
      currentModel,
    ],
  )

  const flushQueuedFollowup = useCallback(() => {
    if (waitingForResponse || activeIsRealtimeStreaming) return
    const queued = queuedFollowupRef.current
    if (!queued) return

    const activeKeys = new Set(
      [
        resolvedSessionKey,
        sessionKeyForHistory,
        activeSessionKey,
        activeFriendlyId,
        isPortableMode ? 'main' : null,
      ]
        .map((key) => (typeof key === 'string' ? key.trim() : ''))
        .filter(Boolean),
    )
    if (
      activeKeys.size > 0 &&
      !activeKeys.has(queued.sessionKey) &&
      !activeKeys.has(queued.friendlyId)
    ) {
      return
    }

    queuedFollowupRef.current = null
    setQueuedFollowupVersion((current) => current + 1)
    updateHistoryMessageByClientIdEverywhere(
      queryClient,
      queued.clientId,
      (message) => ({
        ...message,
        status: 'sending',
      }),
    )
    sendMessage(
      queued.sessionKey,
      queued.friendlyId,
      queued.body,
      queued.attachments,
      queued.fastMode,
      true,
      queued.clientId,
      queued.conversationMode,
    )
  }, [
    activeFriendlyId,
    activeIsRealtimeStreaming,
    activeSessionKey,
    isPortableMode,
    queryClient,
    resolvedSessionKey,
    sendMessage,
    sessionKeyForHistory,
    waitingForResponse,
  ])

  useEffect(() => {
    flushQueuedFollowup()
  }, [flushQueuedFollowup, queuedFollowupVersion])

  useLayoutEffect(() => {
    if (isNewChat) return
    const pending = consumePendingSend(
      isPortableMode
        ? 'main'
        : forcedSessionKey || resolvedSessionKey || activeSessionKey,
      portableChatFriendlyId,
    )
    if (!pending) return
    pendingStartRef.current = true
    const historyKey = chatQueryKeys.history(
      pending.friendlyId,
      pending.sessionKey,
    )
    const cached = queryClient.getQueryData(historyKey)
    const cachedMessages = Array.isArray((cached as any)?.messages)
      ? (cached as any).messages
      : []
    const alreadyHasOptimistic = cachedMessages.some((message: any) => {
      if (pending.optimisticMessage.clientId) {
        if (message.clientId === pending.optimisticMessage.clientId) return true
        if (message.__optimisticId === pending.optimisticMessage.clientId)
          return true
      }
      if (pending.optimisticMessage.__optimisticId) {
        if (message.__optimisticId === pending.optimisticMessage.__optimisticId)
          return true
      }
      return false
    })
    if (!alreadyHasOptimistic) {
      appendHistoryMessage(
        queryClient,
        pending.friendlyId,
        pending.sessionKey,
        pending.optimisticMessage,
      )
    }
    setWaitingForResponse(true)
    sendMessage(
      pending.sessionKey,
      pending.friendlyId,
      pending.message,
      pending.attachments,
      false,
      true,
      typeof pending.optimisticMessage.clientId === 'string'
        ? pending.optimisticMessage.clientId
        : '',
    )
  }, [
    activeSessionKey,
    forcedSessionKey,
    isNewChat,
    isPortableMode,
    portableChatFriendlyId,
    queryClient,
    resolvedSessionKey,
    sendMessage,
  ])

  const retryQueuedMessage = useCallback(
    function retryQueuedMessage(message: ChatMessage, mode: 'manual' | 'auto') {
      if (!isRetryableQueuedMessage(message)) return false

      const body = textFromMessage(message).trim()
      const attachments = getMessageRetryAttachments(message)
      if (body.length === 0 && attachments.length === 0) return false

      const retryKey = getRetryMessageKey(message)
      if (
        mode === 'auto' &&
        retriedQueuedMessageKeysRef.current.has(retryKey)
      ) {
        return false
      }

      const sessionKeyForSend = isPortableMode
        ? 'main'
        : forcedSessionKey || resolvedSessionKey || activeSessionKey || 'main'
      const sessionKeyForMessage = sessionKeyForHistory || sessionKeyForSend
      const existingClientId = getMessageClientId(message)

      if (existingClientId) {
        updateHistoryMessageByClientId(
          queryClient,
          portableChatFriendlyId,
          sessionKeyForMessage,
          existingClientId,
          function markSending(currentMessage) {
            return { ...currentMessage, status: 'sending' }
          },
        )
        updateHistoryMessageByClientIdEverywhere(
          queryClient,
          existingClientId,
          function markSendingEverywhere(currentMessage) {
            return { ...currentMessage, status: 'sending' }
          },
        )
      }

      if (mode === 'auto') {
        retriedQueuedMessageKeysRef.current.add(retryKey)
      }

      sendMessage(
        sessionKeyForSend,
        portableChatFriendlyId,
        body,
        attachments,
        false,
        true,
        existingClientId,
      )
      return true
    },
    [
      activeSessionKey,
      forcedSessionKey,
      isPortableMode,
      portableChatFriendlyId,
      queryClient,
      resolvedSessionKey,
      sessionKeyForHistory,
      sendMessage,
    ],
  )

  const flushRetryableMessages = useCallback(
    function flushRetryableMessages() {
      for (const message of finalDisplayMessages) {
        retryQueuedMessage(message, 'auto')
      }
    },
    [finalDisplayMessages, retryQueuedMessage],
  )

  const handleRetryMessage = useCallback(
    function handleRetryMessage(message: ChatMessage) {
      const retryKey = getRetryMessageKey(message)
      retriedQueuedMessageKeysRef.current.delete(retryKey)
      retryQueuedMessage(message, 'manual')
    },
    [retryQueuedMessage],
  )

  useEffect(() => {
    if (false) {
      // Server connection checks removed — Nyx uses direct API
      hasSeenDisconnectRef.current = true
      retriedQueuedMessageKeysRef.current.clear()
      return
    }

    if (connectionState === 'connected' && hasSeenDisconnectRef.current) {
      hasSeenDisconnectRef.current = false
      flushRetryableMessages()
    }
  }, [connectionState, flushRetryableMessages])

  useEffect(() => {
    if (statusError) {
      hadErrorRef.current = true
      retriedQueuedMessageKeysRef.current.clear()
      return
    }

    const isHealthy = statusQuery.data?.ok === true
    if (isHealthy && hadErrorRef.current) {
      hadErrorRef.current = false
      flushRetryableMessages()
    }
  }, [flushRetryableMessages, statusError, statusQuery.data])

  useEffect(() => {
    function handleHealthRestored() {
      retriedQueuedMessageKeysRef.current.clear()
      hadErrorRef.current = false
      flushRetryableMessages()
      handleRefetch()
    }

    window.addEventListener('nyx:health-restored', handleHealthRestored)
    return () => {
      window.removeEventListener('nyx:health-restored', handleHealthRestored)
    }
  }, [flushRetryableMessages, handleRefetch])

  const createSessionForMessage = useCallback(
    async (preferredFriendlyId?: string) => {
      setCreatingSession(true)
      try {
        const res = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            preferredFriendlyId && preferredFriendlyId.trim().length > 0
              ? { friendlyId: preferredFriendlyId }
              : {},
          ),
        })
        if (!res.ok) throw new Error(await readError(res))

        const data = (await res.json()) as {
          sessionKey?: string
          friendlyId?: string
        }

        const sessionKey =
          typeof data.sessionKey === 'string' ? data.sessionKey : ''
        const friendlyId =
          typeof data.friendlyId === 'string' &&
          data.friendlyId.trim().length > 0
            ? data.friendlyId.trim()
            : (preferredFriendlyId?.trim() ?? '') ||
              deriveFriendlyIdFromKey(sessionKey)

        if (!sessionKey || !friendlyId) {
          throw new Error('Invalid session response')
        }

        queryClient.invalidateQueries({ queryKey: chatQueryKeys.sessions })
        return { sessionKey, friendlyId }
      } finally {
        setCreatingSession(false)
      }
    },
    [queryClient],
  )

  const upsertSessionInCache = useCallback(
    (friendlyId: string, lastMessage: ChatMessage) => {
      if (!friendlyId) return
      queryClient.setQueryData(
        chatQueryKeys.sessions,
        function upsert(existing: unknown) {
          const sessions = Array.isArray(existing)
            ? (existing as Array<SessionMeta>)
            : []
          const now = Date.now()
          const existingIndex = sessions.findIndex((session) => {
            return (
              session.friendlyId === friendlyId || session.key === friendlyId
            )
          })

          if (existingIndex === -1) {
            return [
              {
                key: friendlyId,
                friendlyId,
                updatedAt: now,
                lastMessage,
                titleStatus: 'idle',
              },
              ...sessions,
            ]
          }

          return sessions.map((session, index) => {
            if (index !== existingIndex) return session
            return {
              ...session,
              updatedAt: now,
              lastMessage,
            }
          })
        },
      )
    },
    [queryClient],
  )

  const scrollChatToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const viewport = document.querySelector('[data-chat-scroll-viewport]')
      if (viewport) {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior })
      }
    },
    [],
  )

  const handleUiSlashCommand = useCallback(
    (command: string) => {
      const trimmedCommand = command.trim()
      if (!trimmedCommand.startsWith('/')) return false

      if (trimmedCommand === '/clear') {
        const sessionKey =
          forcedSessionKey ||
          resolvedSessionKey ||
          activeSessionKey ||
          activeFriendlyId
        clearHistoryMessages(queryClient, activeFriendlyId, sessionKey)
        toast('Chat cleared', { type: 'success' })
        return true
      }

      const action = resolveUiSlashCommandAction(trimmedCommand)
      if (action?.kind === 'navigate') {
        if (action.to === '/chat/$sessionKey') {
          navigate({ to: action.to, params: action.params })
        } else {
          navigate({ to: action.to })
        }
        return true
      }

      if (action?.kind === 'settings') {
        window.dispatchEvent(
          new CustomEvent(CHAT_OPEN_SETTINGS_EVENT, {
            detail: { section: action.section },
          }),
        )
        return true
      }

      if (trimmedCommand === '/save') {
        const exported = exportConversationTranscript({
          sessionLabel: activeFriendlyId || 'conversation',
          messages: finalDisplayMessages,
        })
        if (exported) {
          toast('Conversation exported', { type: 'success' })
        }
        return true
      }

      return false
    },
    [
      activeFriendlyId,
      activeSessionKey,
      finalDisplayMessages,
      forcedSessionKey,
      navigate,
      queryClient,
      resolvedSessionKey,
    ],
  )

  const sendSteer = useCallback(
    async (sessionKey: string, message: string) => {
      const autoResolution =
        conversationModeRef.current === 'auto'
          ? resolveAutoConversationMode({ message })
          : null
      const conversationMode: ConversationMode =
        conversationModeRef.current === 'auto'
          ? autoResolution!.mode
          : conversationModeRef.current
      const res = await fetch('/api/send-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionKey,
          friendlyId: activeFriendlyId,
          message,
          steer: true,
          conversationMode,
        }),
      })
      if (!res.ok) throw new Error(await readError(res))
      return res.json() as Promise<{ ok?: boolean; status?: string }>
    },
    [activeFriendlyId],
  )

  const send = useCallback(
    (
      body: string,
      attachments: Array<ChatComposerAttachment>,
      fastMode: boolean,
      helpers: ChatComposerHelpers,
    ) => {
      const trimmedBody = body.trim()
      if (trimmedBody.length === 0 && attachments.length === 0) return
      if (attachments.length === 0 && handleUiSlashCommand(trimmedBody)) return

      // Deduplicate sends with identical content within a 500ms window.
      // This prevents double-fire from paste events that trigger multiple send paths.
      const sendKey = `${trimmedBody}|${attachments.map((a) => `${a.name}:${a.size}`).join(',')}`
      const now = Date.now()
      if (
        sendKey === lastSendKeyRef.current &&
        now - lastSendAtRef.current < 500
      )
        return
      lastSendKeyRef.current = sendKey
      lastSendAtRef.current = now

      // Haptic feedback on mobile when message is sent
      if (isMobile) hapticTap()

      const attachmentPayload: Array<ChatAttachment> = attachments.map(
        (attachment) => ({
          ...attachment,
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety
          id: attachment.id ?? crypto.randomUUID(),
        }),
      )
      const scrollAfterSubmit = () => {
        requestAnimationFrame(() => scrollChatToBottom('smooth'))
      }

      if (isNewChat) {
        helpers.reset()
        scrollAfterSubmit()
        const { threadId, clientId, optimisticMessage, pendingSend } =
          createDeferredNewChatSend({
            body: trimmedBody,
            attachments: attachmentPayload,
            portableMode: isPortableMode,
          })
        appendHistoryMessage(queryClient, threadId, threadId, optimisticMessage)
        upsertSessionInCache(threadId, optimisticMessage)
        stashPendingSend(pendingSend)
        setPendingGeneration(true)
        setSending(true)
        setWaitingForResponse(true)
        activeSendRef.current = {
          sessionKey: threadId,
          friendlyId: threadId,
          clientId,
        }

        if (!isPortableMode) {
          void createSessionForMessage(threadId).catch((err: unknown) => {
            if (import.meta.env.DEV) {
              console.warn('[chat] failed to register new thread', err)
            }
            void queryClient.invalidateQueries({
              queryKey: chatQueryKeys.sessions,
            })
          })
        }
        // In portable mode, navigate to /chat/main instead of UUID
        navigate({
          to: '/chat/$sessionKey',
          params: { sessionKey: threadId },
          replace: true,
        })
        return
      }

      const sessionKeyForSend = isPortableMode
        ? 'main'
        : forcedSessionKey || resolvedSessionKey || activeSessionKey || 'main'
      const friendlyIdForSend = isPortableMode ? 'main' : activeFriendlyId
      const matchingQueuedFollowup =
        queuedFollowupRef.current &&
        (queuedFollowupRef.current.sessionKey === sessionKeyForSend ||
          queuedFollowupRef.current.friendlyId === friendlyIdForSend)
          ? queuedFollowupRef.current
          : null
      const store = useChatStore.getState()
      const sessionBusy =
        waitingForResponse ||
        activeIsRealtimeStreaming ||
        store.isSessionWaiting(sessionKeyForSend) ||
        store.isSessionWaiting(friendlyIdForSend)
      const activeSubmitBehavior = decideActiveSubmitBehavior({
        sessionBusy,
        hasQueuedFollowup: Boolean(matchingQueuedFollowup),
      })

      if (activeSubmitBehavior === 'queue') {
        helpers.reset()
        scrollAfterSubmit()
        const { clientId, optimisticMessage } = createOptimisticMessage(
          trimmedBody,
          attachmentPayload,
        )
        const queuedMessage: ChatMessage = {
          ...optimisticMessage,
          status: 'queued',
        }
        appendHistoryMessage(
          queryClient,
          friendlyIdForSend,
          sessionKeyForSend,
          queuedMessage,
        )
        updateSessionLastMessage(
          queryClient,
          sessionKeyForSend,
          friendlyIdForSend,
          queuedMessage,
        )
        queuedFollowupRef.current = {
          sessionKey: sessionKeyForSend,
          friendlyId: friendlyIdForSend,
          body: trimmedBody,
          attachments: attachmentPayload,
          fastMode,
          clientId,
          conversationMode: conversationModeRef.current,
        }
        setQueuedFollowupVersion((current) => current + 1)
        toast('Queued after current response', { type: 'info' })
        return
      }

      if (activeSubmitBehavior === 'steer') {
        if (attachmentPayload.length > 0) {
          toast('Attachments stay queued until the current response finishes', {
            type: 'info',
          })
          return
        }
        helpers.reset()
        scrollAfterSubmit()
        const { clientId, optimisticMessage } = createOptimisticMessage(
          `[steer] ${trimmedBody}`,
          [],
        )
        const steerMessage: ChatMessage = {
          ...optimisticMessage,
          status: 'sent',
        }
        appendHistoryMessage(
          queryClient,
          friendlyIdForSend,
          sessionKeyForSend,
          steerMessage,
        )
        updateSessionLastMessage(
          queryClient,
          sessionKeyForSend,
          friendlyIdForSend,
          steerMessage,
        )
        void sendSteer(sessionKeyForSend, trimmedBody).catch((err: unknown) => {
          updateHistoryMessageByClientIdEverywhere(
            queryClient,
            clientId,
            (message) => ({
              ...message,
              status: 'error',
            }),
          )
          toast(
            `Failed to steer active response. ${
              err instanceof Error ? err.message : String(err)
            }`,
            { type: 'error' },
          )
        })
        return
      }

      helpers.reset()
      scrollAfterSubmit()
      sendMessage(
        sessionKeyForSend,
        friendlyIdForSend,
        trimmedBody,
        attachmentPayload,
        fastMode,
      )
    },
    [
      activeFriendlyId,
      activeSessionKey,
      activeIsRealtimeStreaming,
      createSessionForMessage,
      forcedSessionKey,
      isNewChat,
      navigate,
      onSessionResolved,
      scrollChatToBottom,
      sendMessage,
      sendSteer,
      upsertSessionInCache,
      queryClient,
      resolvedSessionKey,
      handleUiSlashCommand,
      waitingForResponse,
    ],
  )

  const handleAbortStreaming = useCallback(() => {
    const activeSend = activeSendRef.current
    if (activeSend?.clientId) {
      updateHistoryMessageByClientIdEverywhere(
        queryClient,
        activeSend.clientId,
        (message) => ({
          ...message,
          status: 'sent',
        }),
      )
    }
    cancelStreaming()
    setSending(false)
    streamFinish()
    activeSendRef.current = null
  }, [cancelStreaming, queryClient, streamFinish])

  const runPaletteSlashCommand = useCallback(
    (command: string) => {
      const trimmedCommand = command.trim()
      if (!trimmedCommand.startsWith('/')) return
      if (handleUiSlashCommand(trimmedCommand)) return
      send(trimmedCommand, [], false, commandHelpers)
    },
    [commandHelpers, handleUiSlashCommand, send],
  )

  useEffect(() => {
    function handleRunCommand(event: Event) {
      const detail = (event as CustomEvent<ChatRunCommandDetail>).detail
      if (!detail?.command) return
      runPaletteSlashCommand(detail.command)
    }

    window.addEventListener(CHAT_RUN_COMMAND_EVENT, handleRunCommand)
    return () => {
      window.removeEventListener(CHAT_RUN_COMMAND_EVENT, handleRunCommand)
    }
  }, [runPaletteSlashCommand])

  useEffect(() => {
    const pendingCommand = window.sessionStorage.getItem(
      CHAT_PENDING_COMMAND_STORAGE_KEY,
    )
    if (!pendingCommand) return

    window.sessionStorage.removeItem(CHAT_PENDING_COMMAND_STORAGE_KEY)
    runPaletteSlashCommand(pendingCommand)
  }, [runPaletteSlashCommand])

  const toggleSidebar = useWorkspaceStore((s) => s.toggleSidebar)

  const handleToggleSidebarCollapse = useCallback(() => {
    toggleSidebar()
  }, [toggleSidebar])

  const handleToggleFileExplorer = useCallback(() => {
    setFileExplorerCollapsed((prev) => {
      const next = !prev
      if (typeof window !== 'undefined') {
        localStorage.setItem('nyx-file-explorer-collapsed', String(next))
        localStorage.removeItem('hermes-file-explorer-collapsed')
      }
      return next
    })
  }, [])

  useEffect(() => {
    function handleToggleFileExplorerFromSearch() {
      handleToggleFileExplorer()
    }

    window.addEventListener(
      SEARCH_MODAL_EVENTS.TOGGLE_FILE_EXPLORER,
      handleToggleFileExplorerFromSearch,
    )
    window.addEventListener(SIDEBAR_TOGGLE_EVENT, handleToggleSidebarCollapse)
    return () => {
      window.removeEventListener(
        SEARCH_MODAL_EVENTS.TOGGLE_FILE_EXPLORER,
        handleToggleFileExplorerFromSearch,
      )
      window.removeEventListener(
        SIDEBAR_TOGGLE_EVENT,
        handleToggleSidebarCollapse,
      )
    }
  }, [handleToggleFileExplorer, handleToggleSidebarCollapse])

  const handleInsertFileReference = useCallback((reference: string) => {
    composerHandleRef.current?.insertText(reference)
  }, [])

  const historyLoading =
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety
    (historyQuery.isLoading && !historyQuery.data) || isRedirecting
  const historyEmpty = !historyLoading && finalDisplayMessages.length === 0
  const errorNotice = useMemo(() => {
    if (!showErrorNotice) return null
    if (!serverError) return null
    return (
      <ConnectionStatusMessage
        state="error"
        error={serverError}
        status={serverErrorStatus}
        onRetry={handleRefetch}
      />
    )
  }, [serverError, serverErrorStatus, handleRefetch, showErrorNotice])

  const mobileHeaderStatus: 'connected' | 'connecting' | 'disconnected' =
    connectionState === 'connected'
      ? 'connected'
      : statusQuery.data?.ok === false || statusQuery.isError
        ? 'disconnected'
        : 'connecting'

  const activeHeaderToolName =
    liveToolActivity[0]?.name || activeToolCalls[0]?.name || undefined
  const headerStatusMode: 'idle' | 'sending' | 'streaming' | 'tool' =
    activeHeaderToolName
      ? 'tool'
      : derivedStreamingInfo.isStreaming
        ? 'streaming'
        : sending || waitingForResponse
          ? 'sending'
          : 'idle'
  const researchCard = useResearchCard({
    sessionKey: resolvedSessionKey || activeCanonicalKey,
    isStreaming: derivedStreamingInfo.isStreaming,
    resetKey: `${resolvedSessionKey || activeCanonicalKey || 'main'}:${researchResetKey}`,
  })

  // Pull-to-refresh offset removed

  const handleOpenAgentDetails = useCallback(() => {
    // agent view panel removed
  }, [])

  const handleRenameActiveSessionTitle = useCallback(
    async (nextTitle: string) => {
      const sessionKey =
        resolvedSessionKey || activeSession?.key || activeSessionKey || ''
      if (!sessionKey) return
      await renameSession(
        sessionKey,
        activeSession?.friendlyId ?? null,
        nextTitle,
      )
    },
    [
      activeSession?.friendlyId,
      activeSession?.key,
      activeSessionKey,
      renameSession,
      resolvedSessionKey,
    ],
  )

  // Listen for mobile header agent-details tap
  useEffect(() => {
    const handler = () => {
      /* agent view removed */
    }
    window.addEventListener('nyx:chat-agent-details', handler)
    return () => window.removeEventListener('nyx:chat-agent-details', handler)
  }, [])

  const queuedFollowupActive = useMemo(() => {
    const queued = queuedFollowupRef.current
    if (!queued) return false
    const activeKeys = new Set(
      [
        resolvedSessionKey,
        sessionKeyForHistory,
        activeSessionKey,
        activeFriendlyId,
        forcedSessionKey,
        isPortableMode ? 'main' : null,
      ]
        .map((key) => (typeof key === 'string' ? key.trim() : ''))
        .filter(Boolean),
    )
    if (activeKeys.size === 0) return true
    return activeKeys.has(queued.sessionKey) || activeKeys.has(queued.friendlyId)
  }, [
    activeFriendlyId,
    activeSessionKey,
    forcedSessionKey,
    isPortableMode,
    queuedFollowupVersion,
    resolvedSessionKey,
    sessionKeyForHistory,
  ])

  return (
    <div
      className={cn(
        'relative min-w-0 flex flex-col overflow-hidden',
        compact ? 'h-full flex-1 min-h-0' : 'h-full',
      )}
      style={{ background: 'var(--theme-bg)' }}
    >
      <div
        className={cn(
          'flex-1 min-h-0 overflow-hidden',
          compact
            ? 'flex min-h-0 w-full flex-col'
            : isMobile
              ? 'flex flex-col'
              : 'grid grid-cols-[auto_1fr] grid-rows-[minmax(0,1fr)]',
        )}
      >
        {hideUi || compact || isFocusMode ? null : isMobile ? null : (
          <FileExplorerSidebar
            collapsed={fileExplorerCollapsed}
            onToggle={handleToggleFileExplorer}
            onInsertReference={handleInsertFileReference}
          />
        )}

        <main
          className={cn(
            'flex h-full flex-1 min-h-0 min-w-0 flex-col overflow-hidden transition-[margin-right,margin-bottom] duration-200',
            'mr-0',
            (activeIsRealtimeStreaming || hasPendingGeneration()) &&
              'chat-streaming-glow',
          )}
          style={{
            marginBottom:
              terminalPanelInset > 0 ? `${terminalPanelInset}px` : undefined,
          }}
          ref={mainRef}
        >
          {!compact && (
            <ChatHeader
              activeTitle={activeTitle}
              onRenameTitle={handleRenameActiveSessionTitle}
              renamingTitle={renamingSessionTitle}
              wrapperRef={headerRef}
              onOpenSessions={() => setSessionsOpen(true)}
              sessions={sessions ?? []}
              activeFriendlyId={activeFriendlyId}
              onSelectSession={(key) =>
                void navigate({
                  to: '/chat/$sessionKey',
                  params: { sessionKey: key },
                })
              }
              showFileExplorerButton={!isMobile && !isFocusMode}
              fileExplorerCollapsed={fileExplorerCollapsed}
              onToggleFileExplorer={handleToggleFileExplorer}
              dataUpdatedAt={historyQuery.dataUpdatedAt}
              onRefresh={handleRefreshHistory}
              agentModel={currentModel}
              agentConnected={mobileHeaderStatus === 'connected'}
              onOpenAgentDetails={handleOpenAgentDetails}
              pullOffset={0}
              statusMode={headerStatusMode}
              activeToolName={activeHeaderToolName}
              thinkingLevel={thinkingLevel}
              isFocusMode={isFocusMode}
              onToggleFocusMode={handleToggleFocusMode}
              onUndo={undefined}
              onClear={undefined}
            />
          )}

          {errorNotice && (
            <div className="sticky top-0 z-20 px-4 py-2">{errorNotice}</div>
          )}
          {pendingApprovals.length > 0 && (
            <div className="mx-4 mb-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 shadow-sm dark:border-amber-800/50 dark:bg-amber-900/15">
              <div className="space-y-2">
                {pendingApprovals.map((approval) => {
                  const approvalAction =
                    approval.action || 'Tool call requires approval'
                  const risk = deriveActionRisk(approvalAction, {
                    command: approval.context,
                  })
                  return (
                    <div
                      key={approval.id}
                      className="flex flex-col gap-3 rounded-lg border border-amber-200/80 bg-white/70 p-3 dark:border-amber-800/40 dark:bg-black/10 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                            Approval required
                          </p>
                          <span
                            className={cn(
                              'rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em]',
                              approvalRiskClass(risk.tier),
                            )}
                            title={risk.detail}
                          >
                            {risk.label}
                          </span>
                          <span className="truncate text-[11px] text-amber-600 dark:text-amber-500">
                            {approval.agentName || 'Agent'}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-xs font-medium text-amber-700 dark:text-amber-400">
                          {approvalAction}
                        </p>
                        {approval.context ? (
                          <p className="mt-1 max-h-16 overflow-hidden rounded border border-amber-200/70 bg-amber-100/50 px-2 py-1 text-[10px] font-mono leading-4 text-amber-700 dark:border-amber-800/50 dark:bg-amber-950/20 dark:text-amber-400">
                            {approval.context.slice(0, 240)}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            void resolvePendingApproval(approval, 'approved')
                          }}
                          className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600"
                        >
                          Approve once
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void resolvePendingApproval(approval, 'denied')
                          }}
                          className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 dark:border-red-800/50 dark:bg-red-900/10 dark:text-red-400"
                        >
                          Deny
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {hideUi ? null : (
            <ContextBar
              sessionId={
                activeSession?.key || activeSessionKey || resolvedSessionKey
              }
            />
          )}

          {hideUi ? null : (
            <ChatMessageList
              messages={finalDisplayMessages}
              onRetryMessage={handleRetryMessage}
              onRefresh={handleRefreshHistory}
              loading={historyLoading}
              empty={historyEmpty}
              emptyState={
                <ChatEmptyState
                  compact={compact}
                  onSuggestionClick={(prompt) => {
                    composerHandleRef.current?.setValue(prompt + ' ')
                  }}
                />
              }
              notice={null}
              noticePosition="end"
              waitingForResponse={waitingForResponse}
              sessionKey={activeCanonicalKey}
              pinToTop={false}
              pinGroupMinHeight={pinGroupMinHeight}
              headerHeight={headerHeight}
              contentStyle={stableContentStyle}
              bottomOffset={
                isMobile ? mobileScrollBottomOffset : terminalPanelInset
              }
              isStreaming={derivedStreamingInfo.isStreaming}
              streamingMessageId={derivedStreamingInfo.streamingMessageId}
              streamingText={messageListStreamingText}
              streamingThinking={
                realtimeStreamingThinking ||
                completedStreamingThinking.current ||
                undefined
              }
              lifecycleEvents={realtimeLifecycleEvents}
              hideSystemMessages
              activeToolCalls={activeToolCalls}
              liveToolActivity={liveToolActivity}
              researchCard={researchCard}
              isCompacting={isCompacting}
              sending={sending}
            />
          )}
          {showComposer ? (
            <ChatComposer
              onSubmit={send}
              onAbort={handleAbortStreaming}
              isLoading={sending || waitingForResponse}
              disabled={sending || hideUi}
              sessionKey={
                isNewChat
                  ? undefined
                  : forcedSessionKey || resolvedSessionKey || activeSessionKey
              }
              wrapperRef={composerRef}
              composerRef={composerHandleRef}
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety
              focusKey={`${isNewChat ? 'new' : activeFriendlyId}:${activeCanonicalKey ?? ''}`}
              conversationMode={conversationMode}
              onConversationModeChange={handleConversationModeChange}
              thinkingLevel={thinkingLevel}
              onThinkingLevelChange={handleThinkingLevelChange}
              queuedFollowupActive={queuedFollowupActive}
            />
          ) : null}
        </main>
      </div>
      {!compact && !hideUi && !isMobile && !isFocusMode && <TerminalPanel />}

      {suggestion && (
        <ModelSuggestionToast
          suggestedModel={suggestion.suggestedModel}
          reason={suggestion.reason}
          costImpact={suggestion.costImpact}
          onSwitch={handleSwitchModel}
          onDismiss={dismiss}
          onDismissForSession={dismissForSession}
        />
      )}

      {isMobile && (
        <MobileSessionsPanel
          open={sessionsOpen}
          onClose={() => setSessionsOpen(false)}
          sessions={sessions}
          activeFriendlyId={activeFriendlyId}
          onSelectSession={(friendlyId) => {
            setSessionsOpen(false)
            void navigate({
              to: '/chat/$sessionKey',
              params: { sessionKey: friendlyId },
            })
          }}
          onNewChat={() => {
            setSessionsOpen(false)
            void navigate({
              to: '/chat/$sessionKey',
              params: { sessionKey: 'new' },
            })
          }}
        />
      )}

      <ContextAlertModal
        open={alertOpen}
        onClose={dismissAlert}
        threshold={alertThreshold}
        contextPercent={alertPercent}
      />

      <ErrorToastContainer />
    </div>
  )
}
