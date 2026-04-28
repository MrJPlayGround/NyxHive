export interface ClarificationResult {
  question: string;
  options: Array<{ key: string; description: string }>;
  formatted: string; // Human-readable version for chat display
}

/**
 * System prompt instruction injected into all agents to enable clarification.
 */
export const CLARIFICATION_INSTRUCTION = "[Clarification: if truly ambiguous (different outcomes), respond ONLY with: [@clarify: Question? | opt_a: Desc | opt_b: Desc] — max 4 options. Prefer reasonable defaults over asking.]";

const CLARIFY_REGEX = /\[@clarify:\s*(.+?)(?:\s*\|\s*(\w+):\s*([^|\]]+?))*\s*\]/s;

/**
 * Parse a clarification tag from agent response.
 * Returns null if not a clarification or if the tag is only a small part of the response.
 */
export function parseClarification(response: string): ClarificationResult | null {
  const match = response.match(CLARIFY_REGEX);
  if (!match) return null;

  // Only treat as clarification if the response is MOSTLY the tag
  const tagLength = match[0].length;
  const responseLength = response.trim().length;
  if (tagLength < responseLength * 0.5) return null;

  const question = match[1].trim();
  const options: Array<{ key: string; description: string }> = [];

  // Parse option pairs from the full tag
  const optionRegex = /\|\s*(\w+):\s*([^|\]]+)/g;
  const fullTag = match[0];
  let optMatch: RegExpExecArray | null = optionRegex.exec(fullTag);
  while (optMatch !== null) {
    options.push({ key: optMatch[1].trim(), description: optMatch[2].trim() });
    optMatch = optionRegex.exec(fullTag);
  }

  // Format for display
  let formatted = question;
  if (options.length > 0) {
    formatted += `\n${options.map((o, i) => `${i + 1}. ${o.key}: ${o.description}`).join("\n")}`;
    formatted += "\n\nReply with your choice (number or description).";
  }

  return { question, options, formatted };
}
