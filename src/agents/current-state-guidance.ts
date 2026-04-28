const LIVE_EVIDENCE_SOURCES = "live code, runtime config, API tools, or logs";

export const CURRENT_STATE_CHANNEL_GUIDANCE = [
  `For current-state or operational questions, verify live evidence first when feasible: ${LIVE_EVIDENCE_SOURCES}.`,
  "Use memory or vault knowledge as background context, not as the source of truth for what exists or is running now.",
  "If memory conflicts with live evidence, state that the memory was stale and answer from what you verified.",
] as const;

export const VAULT_CURRENT_STATE_GUIDANCE = `- **Before answering current-state questions:** Verify live evidence first when feasible: ${LIVE_EVIDENCE_SOURCES}; use vault notes as context or historical reference`;
