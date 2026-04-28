import { mkdirSync, appendFileSync, statSync, renameSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogListener = (level: LogLevel, message: string, module?: string) => void;

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATED_FILES = 3;

export interface LogEntry {
  level: LogLevel;
  message: string;
  module?: string;
  timestamp: number;
}

class Logger {
  private level: number = LEVELS.info;
  private logFile: string | null = null;
  private prefix: string | null = null;
  private backgroundMode = false;
  private listeners: LogListener[] = [];
  private recentBuffer: LogEntry[] = [];
  private maxRecentEntries = 200;

  setLevel(level: LogLevel): void {
    this.level = LEVELS[level] ?? LEVELS.info;
  }

  setLogFile(dataDir: string, projectName?: string): void {
    mkdirSync(dataDir, { recursive: true });
    const fileName = `${(projectName ?? "instance").toLowerCase()}.log`;
    this.logFile = join(dataDir, fileName);
    // When stdout is not a TTY (e.g. nohup/start-bg redirects to file),
    // skip console to avoid double-logging to the same file
    this.backgroundMode = !process.stdout.isTTY;
  }

  setPrefix(name: string): void {
    this.prefix = name.toLowerCase();
  }

  onLog(listener: LogListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private format(level: LogLevel, message: string): string {
    const ts = new Date().toISOString();
    return `${ts} [${level.toUpperCase().padEnd(5)}] ${message}`;
  }

  private rotateIfNeeded(): void {
    if (!this.logFile) return;
    try {
      const stats = statSync(this.logFile);
      if (stats.size < MAX_LOG_SIZE) return;

      // Rotate: .log.3 → delete, .log.2 → .log.3, .log.1 → .log.2, .log → .log.1
      for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
        const src = i === 1 ? this.logFile : `${this.logFile}.${i - 1}`;
        const dst = `${this.logFile}.${i}`;
        try {
          if (i === MAX_ROTATED_FILES) {
            try { unlinkSync(dst); } catch { /* doesn't exist */ }
          }
          renameSync(src, dst);
        } catch {
          // Source doesn't exist, skip
        }
      }
    } catch {
      // File doesn't exist yet, nothing to rotate
    }
  }

  private log(level: LogLevel, message: string): void {
    if (LEVELS[level] < this.level) return;

    let msg = message;
    if (this.prefix && !message.startsWith("[")) {
      msg = `[${this.prefix}] ${message}`;
    }

    const formatted = this.format(level, msg);

    // In background mode (log file active), only write to file — skip console
    // to avoid double-logging when stdout is redirected to the same file
    if (!this.backgroundMode) {
      switch (level) {
        case "error":
          console.error(formatted);
          break;
        case "warn":
          console.warn(formatted);
          break;
        default:
          console.log(formatted);
      }
    }

    if (this.logFile) {
      try {
        this.rotateIfNeeded();
        appendFileSync(this.logFile, `${formatted}\n`);
      } catch {
        // Silently ignore file write errors
      }
    }

    // Notify listeners (for WebSocket log streaming)
    // Extract module from prefix or bracketed tag in message
    const module = this.prefix ?? undefined;

    // Keep in-memory ring buffer for recent log retrieval
    const entry: LogEntry = { level, message: msg, module, timestamp: Date.now() };
    this.recentBuffer.push(entry);
    if (this.recentBuffer.length > this.maxRecentEntries) {
      this.recentBuffer = this.recentBuffer.slice(-this.maxRecentEntries);
    }

    for (const listener of this.listeners) {
      try { listener(level, msg, module); } catch { /* never crash on listener errors */ }
    }
  }

  getRecentEntries(limit = 100): LogEntry[] {
    const clamped = Math.min(Math.max(limit, 1), 500);
    const fileEntries = this.readRecentFileEntries(clamped);
    if (fileEntries.length > 0) return fileEntries;
    return this.recentBuffer.slice(-clamped);
  }

  private readRecentFileEntries(limit: number): LogEntry[] {
    if (!this.logFile || !existsSync(this.logFile)) return [];
    try {
      const content = readFileSync(this.logFile, "utf-8");
      const lines = content.split("\n").filter(Boolean).slice(-limit);
      return lines
        .map((line) => this.parseLogLine(line))
        .filter((entry): entry is LogEntry => entry !== null);
    } catch {
      return [];
    }
  }

  private parseLogLine(line: string): LogEntry | null {
    const match = line.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+\[(DEBUG|INFO|WARN|ERROR)\s*\]\s*(.*)$/);
    if (!match) return null;
    const [, iso, rawLevel, message] = match;
    const timestamp = Date.parse(iso);
    if (!Number.isFinite(timestamp)) return null;
    return {
      level: rawLevel.toLowerCase() as LogLevel,
      message,
      module: this.prefix ?? undefined,
      timestamp,
    };
  }

  debug(msg: string): void { this.log("debug", msg); }
  info(msg: string): void { this.log("info", msg); }
  warn(msg: string): void { this.log("warn", msg); }
  error(msg: string): void { this.log("error", msg); }
}

export const logger = new Logger();
