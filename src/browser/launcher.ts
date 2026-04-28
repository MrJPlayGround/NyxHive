/**
 * Browser launcher — manages a persistent Chrome instance using a per-instance profile.
 *
 * Profile location: <instance>/data/browser-profile/
 * Chrome is launched with --user-data-dir so all sessions, cookies, and
 * extensions persist across restarts.
 */

// biome-ignore lint/style/useNodejsImportProtocol: Bun's ChildProcess types differ between node: and bare imports
import { spawn, type ChildProcess } from "child_process";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { logger } from "../utils/logger.js";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Profile dir — set via initBrowserProfile() from instance data_dir, or defaults to CWD-based
let PROFILE_DIR = resolve("data", "browser-profile");

/** Set the browser profile directory from instance config. Call once at startup. */
export function initBrowserProfile(dataDir: string): void {
  PROFILE_DIR = join(resolve(dataDir), "browser-profile");
}

let chromeProc: ChildProcess | null = null;
const trackedPids = new Set<number>();

/** Ensure profile directory exists */
function ensureProfileDir(): void {
  if (!existsSync(PROFILE_DIR)) {
    mkdirSync(PROFILE_DIR, { recursive: true });
  }
}

/**
 * Open a URL in Chrome using the Nyx profile.
 * If Chrome is already running with this profile, opens a new tab.
 * Returns the PID of the Chrome process.
 */
export function openBrowser(url?: string): { pid: number | null; status: string } {
  ensureProfileDir();

  const args = [
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  if (url) {
    args.push(url);
  }

  try {
    // If Chrome is already running with our profile, open a new tab via the same profile
    if (chromeProc && chromeProc.exitCode === null) {
      if (url) {
        // Use the Chrome binary directly with the same profile to ensure the tab
        // opens in the Nyx profile instance, not whatever Chrome is in the foreground
        const tab = spawn(CHROME_PATH, [`--user-data-dir=${PROFILE_DIR}`, url], {
          stdio: "ignore",
          detached: true,
        });
        tab.unref();
        logger.info(`[browser] Opened new tab (Nyx profile): ${url}`);
        return { pid: chromeProc.pid ?? null, status: "tab_opened" };
      }
      return { pid: chromeProc.pid ?? null, status: "already_running" };
    }

    // Launch fresh Chrome with the Nyx profile
    chromeProc = spawn(CHROME_PATH, args, {
      stdio: "ignore",
      detached: true,
    });

    chromeProc.unref();

    if (chromeProc.pid) {
      trackedPids.add(chromeProc.pid);
    }

    chromeProc.on("exit", (code) => {
      logger.info(`[browser] Chrome exited (code ${code})`);
      if (chromeProc?.pid) trackedPids.delete(chromeProc.pid);
      chromeProc = null;
    });

    logger.info(`[browser] Chrome launched (pid ${chromeProc.pid}) with profile ${PROFILE_DIR}${url ? ` → ${url}` : ""}`);
    return { pid: chromeProc.pid ?? null, status: "launched" };
  } catch (err) {
    logger.error(`[browser] Failed to launch Chrome: ${err}`);
    return { pid: null, status: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Close the managed Chrome instance gracefully.
 */
export function closeBrowser(): { status: string } {
  if (!chromeProc || chromeProc.exitCode !== null) {
    chromeProc = null;
    return { status: "not_running" };
  }

  try {
    chromeProc.kill("SIGTERM");
    logger.info(`[browser] Chrome SIGTERM sent (pid ${chromeProc.pid})`);

    // Force-kill after 5s if still alive
    const pid = chromeProc.pid;
    setTimeout(() => {
      try {
        if (pid) process.kill(pid, 0); // check if alive
        if (pid) process.kill(pid, "SIGKILL");
        logger.warn(`[browser] Chrome force-killed (pid ${pid})`);
      } catch {
        // Already dead — good
      }
    }, 5000);

    return { status: "closing" };
  } catch (err) {
    return { status: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Get current browser status.
 */
export function browserStatus(): { running: boolean; pid: number | null; profileDir: string } {
  const running = chromeProc !== null && chromeProc.exitCode === null;
  return {
    running,
    pid: running ? (chromeProc?.pid ?? null) : null,
    profileDir: PROFILE_DIR,
  };
}

/**
 * Cleanup — called during server shutdown.
 * Kills any Chrome processes we launched.
 */
export function cleanupBrowser(): void {
  if (chromeProc && chromeProc.exitCode === null) {
    try {
      chromeProc.kill("SIGTERM");
      logger.info(`[browser] Cleanup: Chrome terminated (pid ${chromeProc.pid})`);
    } catch {
      // Already dead
    }
    chromeProc = null;
  }
  trackedPids.clear();
}
