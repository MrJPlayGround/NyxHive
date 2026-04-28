// Progressive conversation summarization
// Replaces the inline summarizeConversation() in processor.ts

import type { ProviderRouter } from "../providers/router.js";
import type { StoredMessage } from "../memory/store.js";
import { estimateTokens } from "./tokens.js";
import { logger } from "../utils/logger.js";

// Per-role summarization profiles
interface SummarizationProfile {
  charLimit: number;       // chars per message in transcript
  maxTokens: number;       // summary token budget
}

function getProfile(role?: string): SummarizationProfile {
  switch (role) {
    case "orchestrator":
      return { charLimit: 600, maxTokens: 1000 };
    case "coder":
    case "reviewer":
      return { charLimit: 600, maxTokens: 800 };
    default:
      return { charLimit: 500, maxTokens: 600 };
  }
}

/**
 * Extract the most important content from a message for summarization.
 * For assistant messages: preserves file paths, decisions, tool outcomes, code references.
 * For user messages: preserves the full request (usually short enough).
 */
export function extractMessageEssence(role: string, content: string, charLimit: number): string {
  if (role === "user" || content.length <= charLimit) {
    return content.slice(0, charLimit);
  }

  // For long assistant messages, extract high-signal lines instead of blind truncation
  const lines = content.split("\n");
  const kept: string[] = [];
  let budget = charLimit;

  for (const line of lines) {
    if (budget <= 0) break;
    const trimmed = line.trim();
    if (!trimmed) continue;

    const isHighSignal =
      /\b(src\/|\.ts|\.js|\.tsx|\.py|\.rs|\.swift)\b/.test(trimmed) ||
      /\b(fixed|implemented|added|removed|changed|created|deleted|refactored)\b/i.test(trimmed) ||
      /\b(error|fail|pass|success|warning|bug|issue)\b/i.test(trimmed) ||
      /\b(decision|because|reason|chose|trade-?off|approach)\b/i.test(trimmed) ||
      /\b(TODO|FIXME|NOTE|IMPORTANT|BREAKING)\b/.test(trimmed) ||
      /^[-*]\s/.test(trimmed) ||
      /^#{1,4}\s/.test(trimmed) ||
      /^\d+\.\s/.test(trimmed);

    if (isHighSignal) {
      const chunk = trimmed.slice(0, Math.min(200, budget));
      kept.push(chunk);
      budget -= chunk.length + 1;
    }
  }

  // If we didn't extract enough high-signal content, fall back to head+tail
  if (kept.length < 3) {
    const head = content.slice(0, Math.floor(charLimit * 0.7));
    const tail = content.slice(-Math.floor(charLimit * 0.3));
    return `${head}\n...\n${tail}`;
  }

  return kept.join("\n");
}

function buildSummarizationPrompt(
  transcript: string,
  existingSummary: string | null,
): string {
  const parts: string[] = [];

  if (existingSummary) {
    parts.push(
      `[Existing summary — incorporate this into the new summary, do not lose decisions or open items]\n${existingSummary}`,
    );
  }

  parts.push(
    `[Conversation transcript]\n${transcript}`,
    `Produce a concise summary of the conversation above. Structure your response with these exact sections:

**Key Decisions:** List each decision as "WHAT: [decision] — WHY: [rationale]". Preserving the rationale is critical — future summaries must retain both the decision and its reasoning.
**Work Done:** What was implemented, fixed, or changed. Include file paths, function names, test results (pass/fail counts), and specific outcomes. "Fixed X in src/foo.ts" is better than "made some changes."
**Context:** The current state — what is being built, what was completed, what is in-flight. Preserve durable conversational preferences, voice/style decisions, and relationship context when the transcript explicitly establishes them.
**Open Items:** Unresolved questions, blockers, or next steps that need attention.

Be specific and concrete. Omit pleasantries and meta-commentary. Never compress a decision to just its outcome — the reasoning matters as much as the result. Preserve file paths and technical details — they are critical for continuity. Output only the summary.`,
  );

  return parts.join("\n\n");
}

/**
 * Summarize a conversation with structured output and progressive compression.
 *
 * Progressive: if an existing summary is present, it is incorporated into the new one
 * (rolling summary, not a replacement). This preserves decisions and open items across
 * multiple summarization cycles.
 */
export async function progressiveSummarize(
  messages: StoredMessage[],
  existingSummary: string | null,
  router: ProviderRouter,
  agentRole?: string,
): Promise<string | null> {
  if (messages.length === 0) return null;

  const profile = getProfile(agentRole);

  const transcript = messages
    .map((m) => `${m.role}: ${extractMessageEssence(m.role, m.content, profile.charLimit)}`)
    .join("\n");

  const prompt = buildSummarizationPrompt(transcript, existingSummary);

  // Use routing table for summarization — picks model from config, not hardcoded
  const route = router.route("summarization");

  logger.info(
    `[summarize] Summarizing ${messages.length} messages via ${route.provider}/${route.model} (role=${agentRole ?? "default"}, maxTokens=${profile.maxTokens})`,
  );

  try {
    const response = await router.complete(
      {
        messages: [{ role: "user", content: prompt }],
        maxTokens: profile.maxTokens,
        temperature: 0.3,
      },
      route.provider,
      route.model,
    );

    return response.content;
  } catch (err) {
    logger.warn(`[summarize] LLM call failed: ${err}`);
    return null;
  }
}

/**
 * Compact a summary that has grown too large.
 * Preserves Key Decisions and Open Items in full,
 * trims Work Done to most recent items, collapses Context to current state.
 */
export function compactSummary(summary: string, maxTokens: number): string {
  const currentTokens = estimateTokens(summary, { mode: "fast" });
  if (currentTokens <= maxTokens) return summary;

  // Parse sections
  const sections: Record<string, string> = {};
  let currentSection = "";
  const lines = summary.split("\n");

  for (const line of lines) {
    const sectionMatch = line.match(/^\*\*(.+?):\*\*/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      sections[currentSection] = line + "\n";
    } else if (currentSection) {
      sections[currentSection] += line + "\n";
    }
  }

  // Keep Key Decisions and Open Items in full
  const preserved = ["Key Decisions", "Open Items"];
  const compressible = ["Work Done", "Context"];

  const parts: string[] = [];

  for (const section of preserved) {
    if (sections[section]) {
      parts.push(sections[section].trim());
    }
  }

  // Compress Work Done to last 5 bullet items
  if (sections["Work Done"]) {
    const workLines = sections["Work Done"].split("\n");
    const header = workLines[0];
    const bullets = workLines.filter((l) => /^[-*]\s/.test(l.trim()));
    const kept = bullets.length > 0
      ? bullets.slice(-5)
      : workLines.slice(1).filter((l) => l.trim()).slice(-5);
    parts.push([header, ...kept].join("\n").trim());
  }

  // Compress Context to the current state only
  if (sections["Context"]) {
    const ctxLines = sections["Context"].split("\n").filter((l) => l.trim());
    const header = ctxLines[0] ?? "**Context:**";
    const currentState = ctxLines
      .slice(1)
      .find((line) => line.trim() && !/^[-*]\s/.test(line.trim()))
      ?? ctxLines[1]
      ?? "";
    parts.push([header, currentState].filter(Boolean).join("\n").trim());
  }

  // Include any other sections not in our known list (trimmed)
  for (const [name, content] of Object.entries(sections)) {
    if (!preserved.includes(name) && !compressible.includes(name)) {
      const trimmed = content.split("\n").slice(0, 3).join("\n").trim();
      parts.push(trimmed);
    }
  }

  const result = parts.join("\n\n");

  // If still too long, hard truncate
  const resultTokens = estimateTokens(result, { mode: "fast" });
  if (resultTokens > maxTokens) {
    const maxChars = Math.floor(maxTokens * 3.5);
    return result.slice(0, maxChars) + "\n\n[summary truncated for context budget]";
  }

  return result;
}
