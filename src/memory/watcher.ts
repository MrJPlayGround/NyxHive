import { watch, type FSWatcher } from "node:fs";
import { logger } from "../utils/logger.js";

export type WatchEvent = "change" | "create" | "delete";
export type WatchCallback = (filePath: string, event: WatchEvent) => void;
type FSWatcherWithErrorEvents = FSWatcher & {
  on(event: "error", listener: (err: NodeJS.ErrnoException) => void): FSWatcher;
};

export class VaultWatcher {
  private watcher: ReturnType<typeof watch> | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceMs: number;

  constructor(
    private vaultPath: string,
    private skipDirs: string[],
    private onChange: WatchCallback,
    debounceMs = 2000,
  ) {
    this.debounceMs = debounceMs;
  }

  start(retryCount = 0): void {
    if (this.watcher) return;

    try {
      const watcher = watch(this.vaultPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        if (!filename.endsWith(".md")) return;

        // Skip files in excluded directories
        if (this.skipDirs.some(d => filename.startsWith(`${d}/`) || filename.startsWith(`${d}\\`))) return;

        // Skip hidden directories
        if (filename.split("/").some(part => part.startsWith("."))) return;

        // Debounce: Obsidian triggers multiple write events per save
        const existing = this.debounceTimers.get(filename);
        if (existing) clearTimeout(existing);

        const event: WatchEvent = eventType === "rename" ? "create" : "change";

        this.debounceTimers.set(filename, setTimeout(() => {
          this.debounceTimers.delete(filename);
          this.onChange(filename, event);
        }, this.debounceMs));
      });
      this.watcher = watcher;

      (watcher as FSWatcherWithErrorEvents).on("error", (err: NodeJS.ErrnoException) => {
        logger.warn(`[watcher] Watch error (${err.code}), restarting...`);
        this.watcher?.close();
        this.watcher = null;
        this.scheduleRestart(0);
      });

      logger.info(`[watcher] Watching vault: ${this.vaultPath}`);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EINTR" && retryCount < 5) {
        const delay = Math.min(1000 * 2 ** retryCount, 30000);
        logger.warn(`[watcher] EINTR on start, retrying in ${delay}ms (attempt ${retryCount + 1}/5)`);
        this.scheduleRestart(delay, retryCount + 1);
      } else {
        logger.error(`[watcher] Failed to start: ${err}`);
      }
    }
  }

  private scheduleRestart(delay: number, retryCount = 0): void {
    setTimeout(() => this.start(retryCount), delay);
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Clear pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    logger.info("[watcher] Stopped");
  }
}
