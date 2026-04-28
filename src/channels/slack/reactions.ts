export function validateReactionParams(channel: string, ts: string, emoji: string) {
  if (!channel) return { ok: false as const, error: "channel required" };
  if (!ts) return { ok: false as const, error: "ts required" };
  const cleaned = emoji.replace(/^:|:$/g, "");
  if (!cleaned) return { ok: false as const, error: "emoji required" };
  return { ok: true as const, emoji: cleaned };
}

export async function addReaction(client: any, channel: string, ts: string, emoji: string) {
  const v = validateReactionParams(channel, ts, emoji);
  if (!v.ok) return v;
  try { await client.reactions.add({ channel, timestamp: ts, name: v.emoji }); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err) }; }
}

export async function removeReaction(client: any, channel: string, ts: string, emoji: string) {
  const v = validateReactionParams(channel, ts, emoji);
  if (!v.ok) return v;
  try { await client.reactions.remove({ channel, timestamp: ts, name: v.emoji }); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err) }; }
}

export async function listReactions(client: any, channel: string, ts: string) {
  try {
    const result = await client.reactions.get({ channel, timestamp: ts, full: true });
    return { ok: true, reactions: result.message?.reactions ?? [] };
  } catch (err) { return { ok: false, error: String(err), reactions: [] }; }
}
