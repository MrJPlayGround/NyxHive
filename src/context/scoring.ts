/**
 * Message Importance Scoring
 *
 * Scores conversation messages on a 0-100 scale for compaction decisions.
 * Higher scores = more important = survives compaction longer.
 */

import type { StoredMessage } from "../memory/store.js";

export interface MessageScore {
  messageId: number;
  score: number;
  signals: string[];
}

// --- Signal patterns ---

const CONSTRAINT_PATTERNS = /\b(always|never|don't|do not|must not|prefer|require|requirement|mandatory|forbidden)\b/i;
const DELEGATION_PATTERNS = /\[@(?:[a-z0-9_-]+|agent|delegate|hire|team):|\bdelegation[-_\s]?[a-z0-9-]+\b/i;
const TOOL_OUTCOME_PATTERNS = /\b(pass(?:ed)?|fail(?:ed|ure)?|error|fixed|verified|executed|ran|deployed|installed|built|wrote|created|modified|deleted|updated)\b/i;
const DECISION_PATTERNS = /\b(because|decided|chose|trade-?off|approach|rationale|reason(?:ing)?|went with|picked)\b/i;
const ERROR_FIX_PATTERNS = /\b(error|fix(?:ed)?|bug|broke|broken|regression|fail(?:ed|ure)?|crash|exception|issue|debug)\b/i;
const ACTION_PATTERNS = /\b(created|modified|updated|deleted|renamed|moved|added|removed|wrote|fixed|implemented)\b/i;
const FILE_PATH_PATTERNS = /(?:\/|\.{1,2}\/)?[\w.-]+(?:\/[\w.-]+)+\.(?:ts|tsx|js|jsx|py|rs|swift|toml|json|md|sql)\b/i;
const LEARN_TAG_PATTERN = /\[@learn:/;
const ACK_ONLY_PATTERNS = /^(?:ok(?:ay)?|got it(?:,?\s*working on it)?|working on it|understood|sounds good|sure|done|thanks|pong)[.!]?\s*$/i;
const RECENT_WINDOW = 4;
const REPEATED_INFO_THRESHOLD = 0.72;
const REPEATED_INFO_MIN_TOKENS = 6;

/**
 * Score a single message for importance.
 * Returns 0-100 with explanation signals.
 */
export function scoreMessage(
  msg: StoredMessage,
  index: number,
  totalMessages: number,
): MessageScore {
  let score = 0;
  const signals: string[] = [];

  const content = msg.content;
  const hasFilePath = FILE_PATH_PATTERNS.test(content);
  const hasAction = ACTION_PATTERNS.test(content);

  // User constraint/preference (+40)
  if (msg.role === "user" && CONSTRAINT_PATTERNS.test(content)) {
    score += 40;
    signals.push("user_constraint");
  }

  // Active delegation reference (+35)
  if (DELEGATION_PATTERNS.test(content)) {
    score += 35;
    signals.push("delegation_ref");
  }

  // Tool outcome (success/fail) (+30)
  if (TOOL_OUTCOME_PATTERNS.test(content) && (hasFilePath || /\b(test|typecheck|deploy|migration|command|tool)\b/i.test(content))) {
    score += 30;
    signals.push("tool_outcome");
  }

  // Decision with rationale (+25)
  if (DECISION_PATTERNS.test(content)) {
    score += 25;
    signals.push("decision");
  }

  // Error/fix context (+25)
  if (ERROR_FIX_PATTERNS.test(content)) {
    score += 25;
    signals.push("error_fix");
  }

  // Code change reference (+20)
  if (hasFilePath && hasAction) {
    score += 20;
    signals.push("code_ref");
  }

  // Recent messages boost (+20 for last 4)
  if (index >= totalMessages - RECENT_WINDOW) {
    score += 20;
    signals.push("recent");
  }

  // Explicit memory save (+15)
  if (LEARN_TAG_PATTERN.test(content)) {
    score += 15;
    signals.push("learn_tag");
  }

  // Acknowledgment/status penalty (-20) — only if no high-value signals detected
  if (msg.role === "assistant" && content.length < 50 && signals.length === 0 && ACK_ONLY_PATTERNS.test(content.trim())) {
    score -= 20;
    signals.push("ack_only");
  }

  return {
    messageId: msg.id,
    score: Math.max(0, Math.min(100, score)),
    signals,
  };
}

function tokenize(content: string): Set<string> {
  return new Set(
    content
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/)
      .filter((token) => token.length >= 3),
  );
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection++;
  }

  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Score all messages in a conversation.
 * Returns scores sorted by score ascending (lowest first = evict first).
 */
export function scoreMessages(messages: StoredMessage[]): MessageScore[] {
  const scores = messages.map((msg, i) => scoreMessage(msg, i, messages.length));

  const tokenSets = messages.map((msg) => tokenize(msg.content));
  for (let i = 0; i < messages.length; i++) {
    if (tokenSets[i].size < REPEATED_INFO_MIN_TOKENS) continue;

    let bestSimilarity = 0;
    for (let j = 0; j < i; j++) {
      if (tokenSets[j].size < REPEATED_INFO_MIN_TOKENS) continue;
      bestSimilarity = Math.max(bestSimilarity, jaccardSimilarity(tokenSets[i], tokenSets[j]));
    }

    if (bestSimilarity >= REPEATED_INFO_THRESHOLD) {
      scores[i].score = Math.max(0, scores[i].score - 15);
      scores[i].signals.push("repeated_info");
    }
  }

  return scores.sort((a, b) => a.score - b.score);
}

/**
 * Select messages to evict based on scores and token budget.
 * Returns message IDs to evict (lowest-scored first until budget target is met).
 *
 * @param messages - All messages in the conversation
 * @param scores - Pre-computed scores (sorted ascending)
 * @param targetTokens - How many tokens we need to free
 * @param tokenEstimator - Function to estimate tokens for a message
 * @param preserveRecentCount - Number of most recent messages to never evict
 */
export function selectEvictions(
  messages: StoredMessage[],
  scores: MessageScore[],
  targetTokens: number,
  tokenEstimator: (content: string) => number,
  preserveRecentCount = 4,
  minimumKeepCount = preserveRecentCount,
): Set<number> {
  const evictIds = new Set<number>();
  let freedTokens = 0;

  // Build a set of IDs that must be preserved (most recent N)
  const preserveIds = new Set<number>();
  for (let i = Math.max(0, messages.length - preserveRecentCount); i < messages.length; i++) {
    preserveIds.add(messages[i].id);
  }

  // Walk scores ascending (lowest value first)
  for (const { messageId } of scores) {
    if (freedTokens >= targetTokens) break;
    if (preserveIds.has(messageId)) continue;
    if (messages.length - evictIds.size <= minimumKeepCount) break;

    const msg = messages.find((m) => m.id === messageId);
    if (!msg) continue;

    evictIds.add(messageId);
    freedTokens += tokenEstimator(msg.content);
  }

  return evictIds;
}
