/**
 * Nyx Gateway Client
 *
 * HTTP client for the Nyx gateway backend (default: http://127.0.0.1:3777).
 * Replaces the imported workspace shell's legacy WebSocket connection.
 */

import {
  NYX_API_URL,
  SESSIONS_API_UNAVAILABLE_MESSAGE,
  BEARER_TOKEN,
  ensureGatewayProbed,
  getCapabilities,
  probeGateway,
} from './gateway-capabilities'
import { createGatewayAuthHeaders } from './gateway-auth-headers'
import {
  buildAgentMemoryOverview,
  normalizeAgentMemoryBucket,
  type AgentMemoryOverview,
} from './agent-memory'
import { createSseParser } from '../lib/sse-parser'
import { normalizeMessageListResponse } from './message-list-payload'
import {
  normalizeSessionListResponse,
  nyxSessionToWorkspace,
  type NyxSession,
  type NyxSessionSummary,
} from './session-list-payload'
import {
  nyxMessageToWorkspace,
  toChatMessage,
  type WorkspaceMessage,
  type NyxMessage,
} from './message-adapter'
import { toSessionFiles } from './attachment-payloads'
export { nyxMessageToWorkspace, toChatMessage } from './message-adapter'
export type { WorkspaceMessage, NyxMessage } from './message-adapter'
export { normalizeSessionListResponse } from './session-list-payload'
export { normalizeMessageListResponse } from './message-list-payload'
export type { NyxSession } from './session-list-payload'

const _authHeaders = (): Record<string, string> =>
  createGatewayAuthHeaders(BEARER_TOKEN)

console.log(`[nyx-api] Configured API: ${NYX_API_URL}`)

const IS_NYX_WORKSPACE = process.env.NYX_WORKSPACE === '1'

function normalizeWorkspaceSenderId(sender: string): string {
  return (
    sender
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'jay'
  )
}

function getWorkspaceSenderId(): string {
  const sender =
    process.env.NYX_WORKSPACE_SENDER ||
    process.env.NYX_WORKSPACE_USER_NAME ||
    'User'
  return (
    process.env.NYX_WORKSPACE_SENDER_ID ||
    process.env.NYX_WORKSPACE_USER_ID ||
    normalizeWorkspaceSenderId(sender)
  )
}

// ── Types ─────────────────────────────────────────────────────────

export type NyxConfig = {
  model?: string
  provider?: string
  [key: string]: unknown
}

// ── Helpers ───────────────────────────────────────────────────────

async function nyxGet<T>(path: string): Promise<T> {
  const res = await fetch(`${NYX_API_URL}${path}`, { headers: _authHeaders() })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Nyx API ${path}: ${res.status} ${body}`)
  }
  return res.json() as Promise<T>
}

async function nyxPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${NYX_API_URL}${path}`, {
    method: 'POST',
    headers: { ..._authHeaders(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Nyx API POST ${path}: ${res.status} ${text}`)
  }
  return res.json() as Promise<T>
}

async function nyxPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${NYX_API_URL}${path}`, {
    method: 'PATCH',
    headers: { ..._authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Nyx API PATCH ${path}: ${res.status} ${text}`)
  }
  return res.json() as Promise<T>
}

async function nyxDeleteReq(path: string): Promise<void> {
  const res = await fetch(`${NYX_API_URL}${path}`, {
    method: 'DELETE',
    headers: _authHeaders(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Nyx API DELETE ${path}: ${res.status} ${text}`)
  }
}

// ── Health ────────────────────────────────────────────────────────

export async function checkHealth(): Promise<{ status: string }> {
  return nyxGet('/health')
}

// ── Sessions ─────────────────────────────────────────────────────

export async function listSessions(
  limit = 50,
  offset = 0,
): Promise<Array<NyxSession>> {
  const resp = await nyxGet<unknown>(
    `/api/sessions?limit=${limit}&offset=${offset}`,
  )
  return normalizeSessionListResponse(resp)
}

export async function getSession(sessionId: string): Promise<NyxSession> {
  if (IS_NYX_WORKSPACE) {
    const resp = await nyxGet<
      NyxSessionSummary & {
        messages?: Array<NyxMessage>
        message_count?: number
      }
    >(`/api/sessions/${sessionId}`)
    return nyxSessionToWorkspace(resp)
  }
  const resp = await nyxGet<{ session: NyxSession }>(
    `/api/sessions/${sessionId}`,
  )
  return resp.session
}

export async function createSession(opts?: {
  id?: string
  title?: string
  model?: string
}): Promise<NyxSession> {
  if (IS_NYX_WORKSPACE) {
    const resp = await nyxPost<{
      session_id: string
      title?: string | null
      agent?: string | null
      created_at?: number
    }>('/api/sessions', {
      id: opts?.id,
      title: opts?.title,
      agent: opts?.model,
    })
    return nyxSessionToWorkspace(resp)
  }
  const resp = await nyxPost<{ session: NyxSession }>(
    '/api/sessions',
    opts || {},
  )
  return resp.session
}

export async function updateSession(
  sessionId: string,
  updates: { title?: string },
): Promise<NyxSession> {
  if (IS_NYX_WORKSPACE) {
    const resp = await nyxPatch<NyxSessionSummary>(
      `/api/sessions/${sessionId}`,
      updates,
    )
    return nyxSessionToWorkspace(resp)
  }
  const resp = await nyxPatch<{ session: NyxSession }>(
    `/api/sessions/${sessionId}`,
    updates,
  )
  return resp.session
}

export async function deleteSession(sessionId: string): Promise<void> {
  return nyxDeleteReq(`/api/sessions/${sessionId}`)
}

export async function getMessages(
  sessionId: string,
): Promise<Array<WorkspaceMessage>> {
  if (IS_NYX_WORKSPACE) {
    const resp = await nyxGet<unknown>(`/api/sessions/${sessionId}`)
    return normalizeMessageListResponse(resp, sessionId)
  }
  try {
    const resp = await nyxGet<unknown>(`/api/sessions/${sessionId}/messages`)
    const messages = normalizeMessageListResponse(resp, sessionId)
    if (messages.length > 0) return messages
  } catch {
    // Older NyxHive session APIs expose messages on the session detail payload.
  }
  const resp = await nyxGet<unknown>(`/api/sessions/${sessionId}`)
  return normalizeMessageListResponse(resp, sessionId)
}

export async function searchSessions(
  query: string,
  limit = 20,
): Promise<{ query: string; count: number; results: Array<unknown> }> {
  return nyxGet(
    `/api/sessions/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  )
}

export async function forkSession(
  sessionId: string,
): Promise<{ session: NyxSession; forked_from: string }> {
  return nyxPost(`/api/sessions/${sessionId}/fork`)
}

/** Convert a NyxSession to the session summary format the frontend expects */
export function toSessionSummary(session: NyxSession): Record<string, unknown> {
  return {
    key: session.id,
    friendlyId: session.id,
    kind: 'chat',
    status: session.ended_at ? 'ended' : 'idle',
    model: session.model || '',
    label: session.title || session.id,
    title: session.title || session.id,
    derivedTitle: session.title || session.id,
    tokenCount: (session.input_tokens ?? 0) + (session.output_tokens ?? 0),
    totalTokens: (session.input_tokens ?? 0) + (session.output_tokens ?? 0),
    message_count: session.message_count ?? 0,
    tool_call_count: session.tool_call_count ?? 0,
    messageCount: session.message_count ?? 0,
    toolCallCount: session.tool_call_count ?? 0,
    cost: 0,
    createdAt: session.started_at ? session.started_at * 1000 : Date.now(),
    startedAt: session.started_at ? session.started_at * 1000 : Date.now(),
    updatedAt: session.ended_at
      ? session.ended_at * 1000
      : session.started_at
        ? session.started_at * 1000
        : Date.now(),
    usage: {
      promptTokens: session.input_tokens ?? 0,
      completionTokens: session.output_tokens ?? 0,
      totalTokens: (session.input_tokens ?? 0) + (session.output_tokens ?? 0),
    },
  }
}

// ── Chat (streaming) ─────────────────────────────────────────────

type StreamChatOptions = {
  signal?: AbortSignal
  onEvent: (payload: { event: string; data: Record<string, unknown> }) => void
}

/**
 * Send a chat message and stream SSE events from the Nyx gateway.
 * Returns a promise that resolves when the stream ends.
 */
export async function streamChat(
  sessionId: string,
  body: {
    message: string
    model?: string
    reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
    conversationMode?: 'quick' | 'task' | 'build' | 'deep'
    sender?: string
    sender_id?: string
    system_message?: string
    attachments?: Array<Record<string, unknown>>
  },
  opts: StreamChatOptions,
): Promise<void> {
  if (IS_NYX_WORKSPACE || getCapabilities().sessions) {
    const runId = crypto.randomUUID()

    const res = await fetch(
      `${NYX_API_URL}/api/sessions/${sessionId}/message`,
      {
        method: 'POST',
        headers: { ..._authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: body.message,
          model_override:
            body.model && body.model !== 'default' ? body.model : undefined,
          reasoning_effort: body.reasoningEffort,
          conversation_mode: body.conversationMode,
          sender: body.sender,
          sender_id: body.sender_id,
          stream: true,
          files: toSessionFiles(body.attachments),
        }),
        signal: opts.signal,
      },
    )

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Nyx chat stream: ${res.status} ${text}`)
    }

    opts.onEvent({
      event: 'run.started',
      data: {
        run_id: runId,
        session_id: sessionId,
        user_message: {
          id: `${runId}:user`,
          role: 'user',
          content: body.message,
        },
      },
    })

    const reader = res.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    const parser = createSseParser(({ event, data: dataStr }) => {
      if (dataStr === '[DONE]') return

      try {
        const data = JSON.parse(dataStr) as Record<string, unknown>
        if (event === 'response') {
          const content = typeof data.response === 'string' ? data.response : ''
          opts.onEvent({
            event: 'assistant.completed',
            data: {
              content,
              session_id: sessionId,
              run_id: runId,
              message: {
                id: data.message_id || `${runId}:assistant`,
                role: 'assistant',
                content,
              },
            },
          })
          opts.onEvent({
            event: 'run.completed',
            data: { session_id: sessionId, run_id: runId },
          })
          return
        }
        if (event === 'error') {
          opts.onEvent({
            event: 'error',
            data: {
              message:
                typeof data.error === 'string'
                  ? data.error
                  : 'Nyx stream error',
              session_id: sessionId,
              run_id: runId,
            },
          })
          return
        }
        opts.onEvent({ event, data })
      } catch {
        // skip malformed JSON
      }
    })

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      parser.push(decoder.decode(value, { stream: true }))
    }
    parser.push(decoder.decode())
    parser.finish()
    return
  }

  const res = await fetch(
    `${NYX_API_URL}/api/sessions/${sessionId}/chat/stream`,
    {
      method: 'POST',
      headers: { ..._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    },
  )

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Nyx chat stream: ${res.status} ${text}`)
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  const parser = createSseParser(({ event, data: dataStr }) => {
    if (dataStr === '[DONE]') return
    try {
      const data = JSON.parse(dataStr) as Record<string, unknown>
      opts.onEvent({ event, data })
    } catch {
      // skip malformed JSON
    }
  })

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parser.push(decoder.decode(value, { stream: true }))
  }
  parser.push(decoder.decode())
  parser.finish()
}

/** Non-streaming chat */
export async function sendChat(
  sessionId: string,
  messageOrOpts: string | { message: string; model?: string },
  model?: string,
): Promise<Record<string, unknown>> {
  const msg =
    typeof messageOrOpts === 'string' ? messageOrOpts : messageOrOpts.message
  const mdl = typeof messageOrOpts === 'string' ? model : messageOrOpts.model
  return nyxPost(`/api/sessions/${sessionId}/chat`, {
    message: msg,
    model: mdl,
  })
}

export async function steerSession(
  sessionId: string,
  message: string,
): Promise<Record<string, unknown>> {
  const senderId = getWorkspaceSenderId()
  const conversationId = `session:${sessionId}:${senderId}`
  return nyxPost(`/api/agents/nyx/steer`, {
    message,
    conversation_id: conversationId,
    priority: 'normal',
    source: `workspace:${senderId}`,
  })
}

// ── Memory ───────────────────────────────────────────────────────

export async function getMemory(): Promise<unknown> {
  return nyxGet('/api/memory')
}

async function nyxGetOptional<T>(
  path: string,
  fallback: T,
  warnings: Array<string>,
  label: string,
): Promise<T> {
  try {
    return await nyxGet<T>(path)
  } catch (err) {
    warnings.push(
      `${label}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return fallback
  }
}

export async function getAgentMemoryOverview(): Promise<AgentMemoryOverview> {
  const warnings: Array<string> = []
  const [
    bank,
    briefing,
    artifactStats,
    knowledgeStats,
    digests,
    proceduralSkills,
  ] = await Promise.all([
    nyxGetOptional('/api/memory/bank', {}, warnings, 'memory bank'),
    nyxGetOptional(
      '/api/memory/graph/briefing?max=18',
      {},
      warnings,
      'graph briefing',
    ),
    nyxGetOptional(
      '/api/memory/context/artifacts/stats',
      {},
      warnings,
      'context artifacts',
    ),
    nyxGetOptional('/api/knowledge/stats', {}, warnings, 'knowledge stats'),
    nyxGetOptional(
      '/api/knowledge/digests?limit=12',
      { pages: [] },
      warnings,
      'knowledge digests',
    ),
    nyxGetOptional(
      '/api/skills/procedural?limit=12&sort=needs_audit',
      { drafts: [], total: 0 },
      warnings,
      'procedural skills',
    ),
  ])

  return buildAgentMemoryOverview({
    bank,
    briefing,
    artifactStats,
    knowledgeStats,
    digests,
    proceduralSkills,
    warnings,
  })
}

export async function getAgentMemoryBucket(opts: {
  type: string
  query?: string
  limit?: number
  offset?: number
}): Promise<{
  type: string
  items: Array<Record<string, unknown>>
  total: number
}> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50))
  const offset = Math.max(0, opts.offset ?? 0)
  const query = opts.query?.trim()
  const queryParam = query ? `&q=${encodeURIComponent(query)}` : ''
  let payload: unknown

  if (opts.type === 'context_artifacts') {
    payload = await nyxGet(`/api/memory/context/artifacts?limit=${limit}`)
  } else if (opts.type === 'knowledge_digests') {
    const digestQuery = query ? `&q=${encodeURIComponent(query)}` : ''
    payload = await nyxGet(
      `/api/knowledge/digests?limit=${limit}${digestQuery}`,
    )
  } else if (opts.type === 'procedural_skills') {
    const skillQuery = query ? `&query=${encodeURIComponent(query)}` : ''
    payload = await nyxGet(
      `/api/skills/procedural?limit=${limit}&sort=needs_audit${skillQuery}`,
    )
  } else {
    payload = await nyxGet(
      `/api/memory/bank/${encodeURIComponent(opts.type)}?limit=${limit}&offset=${offset}${queryParam}`,
    )
  }

  return normalizeAgentMemoryBucket(opts.type, payload)
}

// ── Skills ───────────────────────────────────────────────────────

export async function listSkills(): Promise<unknown> {
  return nyxGet('/api/skills')
}

export async function getSkill(name: string): Promise<unknown> {
  return nyxGet(`/api/skills/${encodeURIComponent(name)}`)
}

export async function getSkillCategories(): Promise<unknown> {
  return nyxGet('/api/skills/categories')
}

// ── Config ───────────────────────────────────────────────────────

export async function getConfig(): Promise<NyxConfig> {
  return nyxGet<NyxConfig>('/api/config')
}

export async function patchConfig(
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return nyxPatch<Record<string, unknown>>('/api/config', patch)
}

// ── Models ───────────────────────────────────────────────────────

export async function listModels(): Promise<{
  object: string
  data: Array<{ id: string; object: string }>
}> {
  return nyxGet('/v1/models')
}

// ── Connection check ─────────────────────────────────────────────

export async function isNyxAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${NYX_API_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      await probeGateway({ force: true })
      return false
    }
    await probeGateway({ force: true })
    return true
  } catch {
    await probeGateway({ force: true }).catch(() => undefined)
    return false
  }
}

export {
  ensureGatewayProbed,
  getCapabilities as getGatewayCapabilities,
  NYX_API_URL,
  SESSIONS_API_UNAVAILABLE_MESSAGE,
}
