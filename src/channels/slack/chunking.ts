export function chunkMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    // Try paragraph break (\n\n): find the first one that is past the 30% mark
    const ppIdx = remaining.indexOf("\n\n");
    if (ppIdx !== -1 && ppIdx < maxLen && ppIdx > maxLen * 0.3) {
      chunks.push(remaining.slice(0, ppIdx));
      remaining = remaining.slice(ppIdx + 2);
      continue;
    }
    // Try line break (\n): find last one within maxLen that is past the 30% mark
    const nlIdx = remaining.lastIndexOf("\n", maxLen);
    if (nlIdx > maxLen * 0.3) {
      chunks.push(remaining.slice(0, nlIdx));
      remaining = remaining.slice(nlIdx + 1);
      continue;
    }
    // Try word break (space)
    const spIdx = remaining.lastIndexOf(" ", maxLen);
    if (spIdx > maxLen * 0.3) {
      chunks.push(remaining.slice(0, spIdx));
      remaining = remaining.slice(spIdx + 1);
      continue;
    }
    // Hard split
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }
  return chunks;
}
