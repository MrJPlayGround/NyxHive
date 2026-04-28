const DEFAULT_STALL_TIMEOUT_MS = 1_200_000;
const DEFAULT_STARTUP_GRACE_MS = 1_200_000;
const MIN_STALL_TIMEOUT_MS = 60_000;

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getInvocationStallTimeoutMs(): number {
  const configured = parsePositiveInteger(process.env.NYXHIVE_STALL_TIMEOUT_MS);
  if (!configured) return DEFAULT_STALL_TIMEOUT_MS;
  return Math.max(configured, MIN_STALL_TIMEOUT_MS);
}

export function getInvocationStartupGraceMs(): number {
  return Math.max(DEFAULT_STARTUP_GRACE_MS, getInvocationStallTimeoutMs());
}

export { DEFAULT_STALL_TIMEOUT_MS, DEFAULT_STARTUP_GRACE_MS, MIN_STALL_TIMEOUT_MS };
