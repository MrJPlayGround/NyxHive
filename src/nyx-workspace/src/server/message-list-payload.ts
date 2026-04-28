import {
  nyxMessageToWorkspace,
  type NyxMessage,
  type WorkspaceMessage,
} from './message-adapter'

export function normalizeMessageListResponse(
  payload: unknown,
  sessionId: string,
): Array<WorkspaceMessage> {
  if (Array.isArray(payload)) return payload as Array<WorkspaceMessage>
  if (!payload || typeof payload !== 'object') return []

  const record = payload as {
    messages?: Array<NyxMessage>
    items?: Array<WorkspaceMessage>
  }
  if (Array.isArray(record.messages)) {
    return record.messages.map((message) =>
      nyxMessageToWorkspace(message, sessionId),
    )
  }
  if (Array.isArray(record.items)) {
    return record.items
  }
  return []
}
