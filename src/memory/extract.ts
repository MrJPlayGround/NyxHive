import { logger } from "../utils/logger.js";
import type { ProviderRouter } from "../providers/router.js";
import type { ExtractedMemory } from "../types.js";

const EXTRACTION_PROMPT = `Analyze this conversation excerpt and extract structured memories.

Return a JSON array of objects with these fields:
- type: one of "fact", "preference", "decision", "identity", "event", "observation", "goal", "task"
- content: concise statement (one sentence)
- importance: 0.0-1.0 (how important is this to remember long-term?)
- updates: if this updates/supersedes a known fact, describe what it updates (optional)

Rules:
- Only extract genuinely useful long-term knowledge
- Skip transient details, small talk, and implementation minutiae
- Preferences and decisions are high value. They prevent re-asking the same questions
- Be concise: "User prefers TypeScript" not "The user mentioned that they prefer to use TypeScript for their projects"
- Return [] if nothing worth remembering

Known memories (avoid duplicates):
{existing_memories}

Conversation:
{transcript}`;

const VALID_TYPES = new Set(["fact", "preference", "decision", "identity", "event", "observation", "goal", "task"]);

/** Extract structured memories from a conversation transcript using LLM analysis. */
export async function extractMemories(
  transcript: string,
  existingMemories: string,
  router: ProviderRouter,
): Promise<ExtractedMemory[]> {
  try {
    const response = await router.complete(
      {
        messages: [
          {
            role: "user",
            content: EXTRACTION_PROMPT
              .replace("{transcript}", transcript)
              .replace("{existing_memories}", existingMemories),
          },
        ],
        maxTokens: 500,
        temperature: 0.2,
      },
      "openrouter",
      "openai/gpt-oss-120b",
    );

    // Extract JSON array from response (handle markdown code blocks)
    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    let parsed: unknown[];
    try {
      parsed = JSON.parse(jsonMatch[0]) as unknown[];
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    // Validate and clean each extracted memory
    const validated: ExtractedMemory[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const mem = item as Record<string, unknown>;

      if (typeof mem.type !== "string" || !VALID_TYPES.has(mem.type)) continue;
      if (typeof mem.content !== "string" || mem.content.length < 3) continue;

      const importance = typeof mem.importance === "number"
        ? Math.max(0, Math.min(1, mem.importance))
        : 0.5;

      validated.push({
        type: mem.type as ExtractedMemory["type"],
        content: mem.content,
        importance,
        updates: typeof mem.updates === "string" ? mem.updates : undefined,
      });
    }

    logger.info(`[extract] Extracted ${validated.length} memories from transcript`);
    return validated;
  } catch (err) {
    logger.warn(`[extract] Extraction failed: ${err}`);
    return [];
  }
}
