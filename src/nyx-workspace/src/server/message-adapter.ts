export type WorkspaceMessage = {
  id: number | string
  session_id: string
  role: string
  content: string | null
  tool_call_id?: string | null
  tool_calls?: Array<unknown> | string | null
  tool_name?: string | null
  timestamp: number
  token_count?: number | null
  finish_reason?: string | null
}

export type NyxMessage = {
  id: number | string
  role: string
  content: string
  agent?: string | null
  created_at?: number
}

export function nyxMessageToWorkspace(
  message: NyxMessage,
  sessionId: string,
): WorkspaceMessage {
  const messageId =
    typeof message.id === 'string' && message.id.trim().length > 0
      ? message.id.trim()
      : typeof message.id === 'number'
        ? message.id
        : Date.now()

  return {
    id: messageId,
    session_id: sessionId,
    role: message.role,
    content: message.content,
    timestamp: message.created_at
      ? Math.floor(message.created_at / 1000)
      : Math.floor(Date.now() / 1000),
    tool_calls: null,
    tool_name: message.agent || null,
  }
}

/** Convert a backend message to the ChatMessage format the frontend expects. */
export function toChatMessage(
  msg: WorkspaceMessage,
  options?: { historyIndex?: number },
): Record<string, unknown> {
  // Accept either parsed arrays from FastAPI or legacy JSON strings.
  let toolCalls: Array<unknown> | undefined
  if (Array.isArray(msg.tool_calls)) {
    toolCalls = msg.tool_calls
  } else if (msg.tool_calls && typeof msg.tool_calls === 'string') {
    try {
      toolCalls = JSON.parse(msg.tool_calls)
    } catch {
      toolCalls = undefined
    }
  }

  const content: Array<Record<string, unknown>> = []

  const streamToolCallsArr: Array<Record<string, unknown>> = []
  if (msg.role === 'assistant' && toolCalls && Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const record = tc as Record<string, unknown>
      const fn = record.function as Record<string, unknown> | undefined
      const toolCallId =
        record.id || `tc-${Math.random().toString(36).slice(2, 8)}`
      const toolName = fn?.name || (record.name as string | undefined) || 'tool'
      const toolArgs = fn?.arguments
      streamToolCallsArr.push({
        id: toolCallId,
        name: toolName,
        args: toolArgs,
        phase: 'complete',
      })
      content.push({
        type: 'toolCall',
        id: toolCallId,
        name: toolName,
        arguments:
          toolArgs && typeof toolArgs === 'object'
            ? (toolArgs as Record<string, unknown>)
            : undefined,
        partialJson: typeof toolArgs === 'string' ? toolArgs : undefined,
      })
    }
  }

  if (msg.role === 'tool') {
    content.push({
      type: 'tool_result',
      toolCallId: msg.tool_call_id,
      toolName: msg.tool_name,
      text: msg.content || '',
    })
  }

  if (msg.content && msg.role !== 'tool') {
    content.push({ type: 'text', text: msg.content })
  }

  return {
    id: `msg-${msg.id}`,
    role: msg.role,
    content,
    text: msg.content || '',
    timestamp: msg.timestamp ? msg.timestamp * 1000 : Date.now(),
    createdAt: msg.timestamp
      ? new Date(msg.timestamp * 1000).toISOString()
      : undefined,
    sessionKey: msg.session_id,
    ...(typeof options?.historyIndex === 'number'
      ? { __historyIndex: options.historyIndex }
      : {}),
    ...(streamToolCallsArr.length > 0
      ? { streamToolCalls: streamToolCallsArr }
      : {}),
  }
}
