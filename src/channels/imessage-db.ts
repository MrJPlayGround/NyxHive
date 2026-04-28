import { Database } from "bun:sqlite";

export interface IncomingMessage {
  rowId: number;
  guid: string;
  text: string;
  senderId: string;
  chatGuid: string;
  chatIdentifier: string;
  chatName: string | null;
  isGroup: boolean;
  timestamp: Date;
}

const MAC_EPOCH_MS = new Date("2001-01-01T00:00:00Z").getTime();

function macTimestampToDate(ns: number): Date {
  return new Date(MAC_EPOCH_MS + ns / 1_000_000);
}

function decodeAttributedBody(blob: Buffer): string | null {
  if (!blob || blob.length === 0) return null;
  const raw = blob.toString("utf-8");
  const matches = raw.match(/[\x20-\x7E\u00A0-\uFFFF]{2,}/g);
  if (!matches) return null;
  const skip = new Set([
    "NSString", "NSDictionary", "NSNumber", "NSArray",
    "NSMutableString", "NSObject", "NSValue",
  ]);
  const filtered = matches.filter((m) => !skip.has(m));
  return filtered[0] ?? null;
}

const NEW_MESSAGES_SQL = `
SELECT
  m.ROWID,
  m.guid,
  m.text,
  m.attributedBody,
  m.is_from_me,
  m.date,
  h.id AS sender_id,
  c.guid AS chat_guid,
  c.chat_identifier,
  c.display_name AS chat_name,
  c.style AS chat_style
FROM message m
LEFT JOIN handle h ON m.handle_id = h.ROWID
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c ON cmj.chat_id = c.ROWID
WHERE m.ROWID > ?
  AND m.is_from_me = 0
ORDER BY m.ROWID ASC
`;

export class IMessageDB {
  private db: Database;
  private lastRowId: number;
  private stmt: ReturnType<typeof Database.prototype.prepare>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: true });
    this.lastRowId = this.getCurrentMaxRowId();
    this.stmt = this.db.prepare(NEW_MESSAGES_SQL);
  }

  getCurrentMaxRowId(): number {
    const row = this.db.prepare("SELECT MAX(ROWID) as maxId FROM message").get() as any;
    return row?.maxId ?? 0;
  }

  getNewMessages(): IncomingMessage[] {
    const rows = this.stmt.all(this.lastRowId) as any[];
    const messages: IncomingMessage[] = [];

    for (const row of rows) {
      const text = row.text ?? decodeAttributedBody(row.attributedBody);
      if (!text) continue;

      this.lastRowId = row.ROWID;

      messages.push({
        rowId: row.ROWID,
        guid: row.guid,
        text,
        senderId: row.sender_id ?? "unknown",
        chatGuid: row.chat_guid,
        chatIdentifier: row.chat_identifier,
        chatName: row.chat_name || null,
        isGroup: row.chat_style === 43,
        timestamp: macTimestampToDate(row.date),
      });
    }

    return messages;
  }

  /** Advance lastRowId to current max, skipping any messages created since last poll */
  advanceToLatest(): void {
    this.lastRowId = this.getCurrentMaxRowId();
  }

  close(): void {
    this.db.close();
  }
}
