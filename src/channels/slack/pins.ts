export function validatePinParams(channel: string, ts: string) {
  if (!channel) return { ok: false as const, error: "channel required" };
  if (!ts) return { ok: false as const, error: "ts required" };
  return { ok: true as const };
}

export async function pinMessage(client: any, channel: string, ts: string) {
  const v = validatePinParams(channel, ts);
  if (!v.ok) return v;
  try { await client.pins.add({ channel, timestamp: ts }); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err) }; }
}

export async function unpinMessage(client: any, channel: string, ts: string) {
  const v = validatePinParams(channel, ts);
  if (!v.ok) return v;
  try { await client.pins.remove({ channel, timestamp: ts }); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err) }; }
}

export async function listPins(client: any, channel: string) {
  if (!channel) return { ok: false, error: "channel required", items: [] };
  try { const r = await client.pins.list({ channel }); return { ok: true, items: r.items ?? [] }; }
  catch (err) { return { ok: false, error: String(err), items: [] }; }
}
