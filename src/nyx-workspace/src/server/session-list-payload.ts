export type NyxSession = {
  id: string
  source?: string
  user_id?: string | null
  model?: string | null
  title?: string | null
  started_at?: number
  ended_at?: number | null
  end_reason?: string | null
  message_count?: number
  tool_call_count?: number
  input_tokens?: number
  output_tokens?: number
  parent_session_id?: string | null
  last_active?: number | null
}

export type NyxSessionSummary = {
  session_id: string
  title?: string | null
  agent?: string | null
  total_cost_cents?: number
  created_at?: number
  updated_at?: number
  message_count?: number
}

export function nyxSessionToWorkspace(session: NyxSessionSummary): NyxSession {
  const startedAt = session.created_at
    ? Math.floor(session.created_at / 1000)
    : Math.floor(Date.now() / 1000)
  const lastActive = session.updated_at
    ? Math.floor(session.updated_at / 1000)
    : startedAt
  return {
    id: session.session_id,
    source: 'nyxhive',
    model: session.agent || null,
    title: session.title || session.session_id,
    started_at: startedAt,
    ended_at: null,
    last_active: lastActive,
    message_count: session.message_count ?? 0,
  }
}

export function normalizeSessionListResponse(payload: unknown): Array<NyxSession> {
  if (Array.isArray(payload)) return payload as Array<NyxSession>
  if (!payload || typeof payload !== 'object') return []

  const record = payload as {
    sessions?: Array<NyxSessionSummary>
    items?: Array<NyxSession>
  }
  if (Array.isArray(record.sessions)) {
    return record.sessions.map(nyxSessionToWorkspace)
  }
  if (Array.isArray(record.items)) {
    return record.items
  }
  return []
}
