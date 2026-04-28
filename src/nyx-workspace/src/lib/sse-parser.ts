export type SseParsedEvent = {
  event: string
  data: string
}

export function createSseParser(onEvent: (event: SseParsedEvent) => void): {
  push: (chunk: string) => void
  finish: () => void
} {
  let buffer = ''
  let currentEvent = ''
  let dataLines: Array<string> = []

  const flush = () => {
    if (!currentEvent && dataLines.length === 0) return
    onEvent({
      event: currentEvent || 'message',
      data: dataLines.join('\n'),
    })
    currentEvent = ''
    dataLines = []
  }

  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      flush()
      return
    }
    if (line.startsWith(':')) return

    const colonIndex = line.indexOf(':')
    const field = colonIndex >= 0 ? line.slice(0, colonIndex) : line
    const rawValue = colonIndex >= 0 ? line.slice(colonIndex + 1) : ''
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue

    if (field === 'event') currentEvent = value
    else if (field === 'data') dataLines.push(value)
  }

  return {
    push(chunk: string) {
      if (!chunk) return
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) processLine(line)
    },
    finish() {
      if (buffer) {
        processLine(buffer)
        buffer = ''
      }
      flush()
    },
  }
}
