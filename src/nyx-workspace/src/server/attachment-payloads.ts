export type SessionFilePayload = {
  name: string
  type: string
  data: string
}

function readAttachmentString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stripAttachmentDataUrlPrefix(value: string): string {
  const trimmed = value.trim()
  const commaIndex = trimmed.indexOf(',')
  if (trimmed.toLowerCase().startsWith('data:') && commaIndex >= 0) {
    return trimmed.slice(commaIndex + 1).trim()
  }
  return trimmed
}

export function toSessionFiles(
  attachments?: Array<Record<string, unknown>>,
): Array<SessionFilePayload> | undefined {
  if (!attachments?.length) return undefined

  const files: Array<SessionFilePayload> = []
  for (const attachment of attachments) {
    const name =
      readAttachmentString(attachment.name) ||
      readAttachmentString(attachment.fileName)
    const type =
      readAttachmentString(attachment.contentType) ||
      readAttachmentString(attachment.mimeType) ||
      readAttachmentString(attachment.mediaType)
    const data = stripAttachmentDataUrlPrefix(
      readAttachmentString(attachment.content) ||
        readAttachmentString(attachment.data) ||
        readAttachmentString(attachment.base64) ||
        readAttachmentString(attachment.dataUrl),
    )

    if (!name || !type || !data) continue
    files.push({ name, type, data })
  }

  return files.length > 0 ? files : undefined
}
