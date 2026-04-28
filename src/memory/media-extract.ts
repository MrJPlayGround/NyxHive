import { buildObsidianNote } from "./obsidian.js";

export interface ExtractedKnowledge {
  title: string;
  summary: string;
  claims: string[];
  frameworks: string[];
  techniques: string[];
  examples: string[];
  tags: string[];
  related_concepts: string[];
}

const EXTRACTION_PROMPT = `You are a knowledge extraction agent. Given a transcript, extract structured knowledge.

Return a JSON object with these fields:
- title: A prose-as-title claim that captures the core insight (e.g. "memory graphs beat giant memory files" not "Memory Systems")
- summary: 2-3 sentences capturing the key message
- claims: Array of distinct claims worth preserving (12-18 for a long talk)
- frameworks: Named frameworks or mental models mentioned (3-5)
- techniques: Actionable techniques described (5-8)
- examples: Concrete examples with enough context to be useful (2-4)
- tags: Suggested category tags
- related_concepts: Terms that might link to existing knowledge (potential wikilinks)

Be precise. Extract signal, not noise. Each claim should stand alone as a useful piece of knowledge.

TRANSCRIPT:
`;

export async function extractKnowledge(
  transcript: string,
  options?: {
    sourceTitle?: string;
    sourceUrl?: string;
    apiKey?: string;
    model?: string;
  },
): Promise<ExtractedKnowledge> {
  const apiKey = options?.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("No API key for knowledge extraction");

  const model = options?.model ?? "anthropic/claude-haiku-4-5-20251001";

  const maxChars = 100_000;
  const truncated = transcript.length > maxChars
    ? `${transcript.slice(0, maxChars)}\n[TRUNCATED]`
    : transcript;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "user", content: EXTRACTION_PROMPT + truncated },
      ],
      response_format: { type: "json_object" },
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    throw new Error(`Extraction LLM call failed (${response.status}): ${await response.text()}`);
  }

  const result = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty LLM response for knowledge extraction");

  try {
    return JSON.parse(content) as ExtractedKnowledge;
  } catch {
    throw new Error(`Failed to parse extraction JSON: ${content.slice(0, 200)}`);
  }
}

export function buildExtractionNote(
  extraction: ExtractedKnowledge,
  source: { url?: string; filePath?: string; duration?: number },
): string {
  const sections: string[] = [];

  sections.push(extraction.summary);

  const sourceLines: string[] = [];
  if (source.url) sourceLines.push(`- URL: ${source.url}`);
  if (source.filePath) sourceLines.push(`- File: ${source.filePath}`);
  if (source.duration) sourceLines.push(`- Duration: ${Math.round(source.duration / 60)} minutes`);
  if (sourceLines.length > 0) {
    sections.push(`## Source\n\n${sourceLines.join("\n")}`);
  }

  if (extraction.claims.length > 0) {
    sections.push(`## Key Claims\n\n${extraction.claims.map(c => `- ${c}`).join("\n")}`);
  }
  if (extraction.frameworks.length > 0) {
    sections.push(`## Frameworks\n\n${extraction.frameworks.map(f => `- ${f}`).join("\n")}`);
  }
  if (extraction.techniques.length > 0) {
    sections.push(`## Techniques\n\n${extraction.techniques.map(t => `- ${t}`).join("\n")}`);
  }
  if (extraction.examples.length > 0) {
    sections.push(`## Examples\n\n${extraction.examples.map(e => `- ${e}`).join("\n")}`);
  }

  return buildObsidianNote({
    title: extraction.title,
    content: sections.join("\n\n"),
    category: "Knowledge",
    tags: ["ingested", ...extraction.tags],
    relatedNotes: extraction.related_concepts,
    sourceAgent: "brain-ingest",
    properties: {
      ...(source.url ? { source_url: source.url } : {}),
      ...(source.duration ? { duration_seconds: source.duration } : {}),
    },
  });
}
