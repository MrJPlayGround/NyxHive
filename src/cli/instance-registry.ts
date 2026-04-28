import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const BOOKMARKS_PATH = join(
  process.env.HOME ?? "/root",
  ".nyxhive",
  "bookmarks.json",
);

export interface Bookmark {
  name: string;
  path: string;       // absolute path to instance directory
  port?: number;       // convenience, not authoritative
}

export interface BookmarkStore {
  bookmarks: Bookmark[];
}

export function loadBookmarks(filePath = BOOKMARKS_PATH): BookmarkStore {
  if (!existsSync(filePath)) return { bookmarks: [] };
  const raw = readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw) as BookmarkStore;
  return { bookmarks: Array.isArray(data.bookmarks) ? data.bookmarks : [] };
}

export function saveBookmarks(store: BookmarkStore, filePath = BOOKMARKS_PATH): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`);
}

export function addBookmark(bookmark: Bookmark, filePath = BOOKMARKS_PATH): void {
  const store = loadBookmarks(filePath);
  const existing = store.bookmarks.findIndex(b => b.name === bookmark.name);
  if (existing >= 0) {
    store.bookmarks[existing] = bookmark;
  } else {
    store.bookmarks.push(bookmark);
  }
  saveBookmarks(store, filePath);
}

export function removeBookmark(name: string, filePath = BOOKMARKS_PATH): void {
  const store = loadBookmarks(filePath);
  store.bookmarks = store.bookmarks.filter(b => b.name !== name);
  saveBookmarks(store, filePath);
}

export async function checkInstanceHealth(
  bookmark: Bookmark,
  timeoutMs = 5000,
): Promise<{ status: string; ok: boolean }> {
  if (!bookmark.port) return { status: "no port configured", ok: false };
  const url = `http://localhost:${bookmark.port}/health`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok
      ? { status: "healthy", ok: true }
      : { status: `unhealthy (${response.status})`, ok: false };
  } catch {
    return { status: "unreachable", ok: false };
  }
}
