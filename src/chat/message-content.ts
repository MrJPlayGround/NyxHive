const THINKING_BLOCK_RE = /<thinking>([\s\S]*?)<\/thinking>\s*/g;

export function extractThinkingBlocks(content: string): string[] {
  const reasoningBlocks: string[] = [];
  for (const match of content.matchAll(THINKING_BLOCK_RE)) {
    const reasoning = match[1]?.trim();
    if (reasoning) reasoningBlocks.push(reasoning);
  }
  return reasoningBlocks;
}

export function stripThinking(content: string): string {
  return content.replace(THINKING_BLOCK_RE, "").trim();
}

export function normalizeAssistantMessageContent(content: string) {
  const reasoningBlocks = extractThinkingBlocks(content);
  return {
    content: stripThinking(content),
    reasoning: reasoningBlocks.length > 0 ? reasoningBlocks.join("\n\n") : null,
  };
}
