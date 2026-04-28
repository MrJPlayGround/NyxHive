export function isMissingSessionError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error)
  return /(?:^|\D)404(?:\D|$)/.test(raw) && /session\s+not\s+found/i.test(raw)
}
