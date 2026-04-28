interface ValidationResult { ok: boolean; error?: string; }

export function validateEditParams(channel: string, ts: string, text: string): ValidationResult {
  if (!channel) return { ok: false, error: "channel is required" };
  if (!ts) return { ok: false, error: "ts is required" };
  if (!text) return { ok: false, error: "text is required" };
  return { ok: true };
}

export function validateDeleteParams(channel: string, ts: string): ValidationResult {
  if (!channel) return { ok: false, error: "channel is required" };
  if (!ts) return { ok: false, error: "ts is required" };
  return { ok: true };
}

export async function editMessage(client: any, channel: string, ts: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const v = validateEditParams(channel, ts, text);
  if (!v.ok) return v;
  try { await client.chat.update({ channel, ts, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] }); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err) }; }
}

export async function deleteMessage(client: any, channel: string, ts: string): Promise<{ ok: boolean; error?: string }> {
  const v = validateDeleteParams(channel, ts);
  if (!v.ok) return v;
  try { await client.chat.delete({ channel, ts }); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err) }; }
}
