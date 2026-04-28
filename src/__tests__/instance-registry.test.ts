import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadBookmarks,
  saveBookmarks,
  addBookmark,
  removeBookmark,
  checkInstanceHealth,
  type BookmarkStore,
  type Bookmark,
} from "../cli/instance-registry.js";

describe("Bookmark Store CRUD", () => {
  let tmpDir: string;
  let bookmarksPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-bookmarks-"));
    bookmarksPath = join(tmpDir, "bookmarks.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- loadBookmarks ---

  test("returns empty store if file doesn't exist", () => {
    const store = loadBookmarks(bookmarksPath);
    expect(store.bookmarks).toEqual([]);
  });

  test("loads existing bookmarks", () => {
    const data: BookmarkStore = {
      bookmarks: [
        { name: "test", path: "/some/path", port: 3777 },
      ],
    };
    saveBookmarks(data, bookmarksPath);

    const store = loadBookmarks(bookmarksPath);
    expect(store.bookmarks).toHaveLength(1);
    expect(store.bookmarks[0].name).toBe("test");
  });

  test("handles corrupt file gracefully", () => {
    writeFileSync(bookmarksPath, "not json");
    expect(() => loadBookmarks(bookmarksPath)).toThrow();
  });

  // --- saveBookmarks ---

  test("creates parent directory if needed", () => {
    const nestedPath = join(tmpDir, "nested", "dir", "bookmarks.json");
    saveBookmarks({ bookmarks: [] }, nestedPath);
    expect(existsSync(nestedPath)).toBe(true);
  });

  test("writes valid JSON", () => {
    saveBookmarks({ bookmarks: [{ name: "a", path: "/a", port: 3777 }] }, bookmarksPath);
    const raw = readFileSync(bookmarksPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.bookmarks).toHaveLength(1);
  });

  // --- addBookmark ---

  test("adds bookmark to empty store", () => {
    addBookmark({ name: "new-instance", path: "/my/path", port: 3777 }, bookmarksPath);

    const store = loadBookmarks(bookmarksPath);
    expect(store.bookmarks).toHaveLength(1);
    expect(store.bookmarks[0].name).toBe("new-instance");
    expect(store.bookmarks[0].port).toBe(3777);
  });

  test("adds multiple bookmarks", () => {
    addBookmark({ name: "first", path: "/first", port: 3777 }, bookmarksPath);
    addBookmark({ name: "second", path: "/second", port: 3778 }, bookmarksPath);

    const store = loadBookmarks(bookmarksPath);
    expect(store.bookmarks).toHaveLength(2);
  });

  test("updates existing bookmark with same name", () => {
    addBookmark({ name: "dup", path: "/a", port: 3777 }, bookmarksPath);
    addBookmark({ name: "dup", path: "/b", port: 3778 }, bookmarksPath);

    const store = loadBookmarks(bookmarksPath);
    expect(store.bookmarks).toHaveLength(1);
    expect(store.bookmarks[0].path).toBe("/b");
    expect(store.bookmarks[0].port).toBe(3778);
  });

  test("port is optional", () => {
    addBookmark({ name: "no-port", path: "/no-port" }, bookmarksPath);

    const store = loadBookmarks(bookmarksPath);
    expect(store.bookmarks[0].port).toBeUndefined();
  });

  // --- removeBookmark ---

  test("removes bookmark by name", () => {
    addBookmark({ name: "to-remove", path: "/remove", port: 3777 }, bookmarksPath);
    addBookmark({ name: "keep", path: "/keep", port: 3778 }, bookmarksPath);

    removeBookmark("to-remove", bookmarksPath);

    const store = loadBookmarks(bookmarksPath);
    expect(store.bookmarks).toHaveLength(1);
    expect(store.bookmarks[0].name).toBe("keep");
  });

  test("removing nonexistent bookmark is a no-op", () => {
    addBookmark({ name: "only", path: "/only" }, bookmarksPath);
    removeBookmark("nonexistent", bookmarksPath);

    const store = loadBookmarks(bookmarksPath);
    expect(store.bookmarks).toHaveLength(1);
  });
});

describe("checkInstanceHealth", () => {
  test("returns unreachable for non-running instance", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect ECONNREFUSED"));
    const bookmark: Bookmark = {
      name: "dead",
      path: "/dead",
      port: 19998,
    };

    const result = await checkInstanceHealth(bookmark, 2000);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("unreachable");
    fetchSpy.mockRestore();
  });

  test("returns no port configured when port is missing", async () => {
    const bookmark: Bookmark = {
      name: "no-port",
      path: "/no-port",
    };

    const result = await checkInstanceHealth(bookmark, 2000);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("no port configured");
  });
});

describe("Bookmark file operations", () => {
  let tmpDir: string;
  let bookmarksPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-bm-ops-"));
    bookmarksPath = join(tmpDir, "bookmarks.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("full CRUD lifecycle", () => {
    // Create
    addBookmark({ name: "alpha", path: "/alpha", port: 3777 }, bookmarksPath);
    addBookmark({ name: "beta", path: "/beta", port: 3778 }, bookmarksPath);
    addBookmark({ name: "gamma", path: "/gamma", port: 3779 }, bookmarksPath);

    let store = loadBookmarks(bookmarksPath);
    expect(store.bookmarks).toHaveLength(3);

    // Update
    addBookmark({ name: "beta", path: "/beta-v2", port: 4778 }, bookmarksPath);
    store = loadBookmarks(bookmarksPath);
    expect(store.bookmarks).toHaveLength(3);
    const beta = store.bookmarks.find(b => b.name === "beta");
    expect(beta!.path).toBe("/beta-v2");
    expect(beta!.port).toBe(4778);

    // Delete
    removeBookmark("beta", bookmarksPath);
    store = loadBookmarks(bookmarksPath);
    expect(store.bookmarks).toHaveLength(2);
    expect(store.bookmarks.find(b => b.name === "beta")).toBeUndefined();
  });

  test("store survives reload", () => {
    addBookmark({ name: "persist", path: "/persist", port: 3777 }, bookmarksPath);

    // Simulate fresh load
    const freshStore = loadBookmarks(bookmarksPath);
    expect(freshStore.bookmarks).toHaveLength(1);
    expect(freshStore.bookmarks[0].name).toBe("persist");
  });
});
