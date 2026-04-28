/**
 * Escape text for AppleScript by building a concatenation expression.
 * Unsafe characters are expressed as `(ASCII character N)`, making injection
 * impossible regardless of input content.
 */
function escapeForAppleScript(text: string): string {
  const SAFE = /^[a-zA-Z0-9 .,!?;:'\-_=+@#$%^&*()\[\]{}<>\/|~`]$/;
  const parts: string[] = [];
  let current = "";

  for (const ch of text) {
    if (ch === '"' || ch === '\\') {
      if (current) { parts.push(`"${current}"`); current = ""; }
      parts.push(`(ASCII character ${ch.charCodeAt(0)})`);
    } else if (ch === '\n') {
      if (current) { parts.push(`"${current}"`); current = ""; }
      parts.push('(ASCII character 10)');
    } else if (ch === '\r') {
      if (current) { parts.push(`"${current}"`); current = ""; }
      parts.push('(ASCII character 13)');
    } else if (ch === '\t') {
      if (current) { parts.push(`"${current}"`); current = ""; }
      parts.push('(ASCII character 9)');
    } else if (SAFE.test(ch)) {
      current += ch;
    } else {
      const code = ch.charCodeAt(0);
      if (code <= 127) {
        if (current) { parts.push(`"${current}"`); current = ""; }
        parts.push(`(ASCII character ${code})`);
      } else {
        // Unicode — safe inside AppleScript strings
        current += ch;
      }
    }
  }
  if (current) parts.push(`"${current}"`);
  if (parts.length === 0) return '""';
  return parts.join(" & ");
}

/** Validate iMessage recipient (phone/email). Rejects injection-prone strings. */
function validateRecipient(recipient: string): string {
  if (!/^[\w.+@\-]+$/.test(recipient)) {
    throw new Error(`Invalid recipient format: ${recipient.slice(0, 50)}`);
  }
  return recipient;
}

/** Validate iMessage chat GUID format. */
function validateChatGuid(guid: string): string {
  if (!/^[\w;+\-.:]+$/.test(guid)) {
    throw new Error(`Invalid chat GUID format: ${guid.slice(0, 50)}`);
  }
  return guid;
}

async function sendMessage(recipient: string, text: string): Promise<void> {
  const safeRecipient = validateRecipient(recipient);
  const escapedText = escapeForAppleScript(text);
  const script = `
    tell application "Messages"
      set targetService to 1st account whose service type = iMessage
      set targetBuddy to participant "${safeRecipient}" of targetService
      send (${escapedText}) to targetBuddy
    end tell
  `;

  const proc = Bun.spawn(["osascript", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`osascript failed (exit ${exitCode}): ${stderr}`);
  }
}

async function sendToGroup(chatGuid: string, text: string): Promise<void> {
  const safeGuid = validateChatGuid(chatGuid);
  const escapedText = escapeForAppleScript(text);
  const script = `
    tell application "Messages"
      set targetChat to chat id "${safeGuid}"
      send (${escapedText}) to targetChat
    end tell
  `;

  const proc = Bun.spawn(["osascript", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`osascript send to group failed (exit ${exitCode}): ${stderr}`);
  }
}

export class IMessageSender {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;
  private recentlySent = new Map<string, number>();
  private recentChats = new Map<string, number>();

  /** Check if text was recently sent by us (within TTL) */
  wasSentByUs(text: string): boolean {
    const normalized = text.replace(/\s+/g, " ").trim();
    const ts = this.recentlySent.get(normalized);
    if (!ts) return false;
    if (Date.now() - ts > 30_000) {
      this.recentlySent.delete(normalized);
      return false;
    }
    return true;
  }

  /** Check if we recently sent to this chat (echo cooldown) */
  isEchoCooldown(chatIdentifier: string): boolean {
    const ts = this.recentChats.get(chatIdentifier);
    if (!ts) return false;
    if (Date.now() - ts > 5_000) {
      this.recentChats.delete(chatIdentifier);
      return false;
    }
    return true;
  }

  private trackSent(recipient: string, text: string): void {
    const normalized = text.replace(/\s+/g, " ").trim();
    this.recentlySent.set(normalized, Date.now());
    this.recentChats.set(recipient, Date.now());
    // Prune old entries
    if (this.recentlySent.size > 100) {
      const now = Date.now();
      for (const [k, v] of this.recentlySent) {
        if (now - v > 30_000) this.recentlySent.delete(k);
      }
    }
  }

  async send(recipient: string, text: string, isGroup: boolean, chatGuid?: string): Promise<void> {
    this.trackSent(recipient, text);
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          if (isGroup && chatGuid) {
            await sendToGroup(chatGuid, text);
          } else {
            await sendMessage(recipient, text);
          }
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      await task();
      await new Promise((r) => setTimeout(r, 300));
    }
    this.processing = false;
  }
}
