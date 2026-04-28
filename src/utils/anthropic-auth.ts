import { userInfo } from "node:os";
import { createHash } from "node:crypto";
import { logger } from "./logger.js";

const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface AnthropicAuth {
  authToken: string;
}

/**
 * Compute the keychain service suffix for a config directory.
 * Claude Code uses SHA256(configDir)[:8] as the suffix.
 */
function keychainSuffix(configDir: string): string {
  return createHash("sha256").update(configDir).digest("hex").slice(0, 8);
}

/**
 * Read OAuth tokens from macOS Keychain (where Claude Code stores them).
 */
async function readKeychainTokens(configDir: string): Promise<OAuthTokens | null> {
  const suffix = keychainSuffix(configDir);
  const service = `Claude Code-credentials-${suffix}`;

  try {
    const proc = Bun.spawn(
      ["security", "find-generic-password", "-s", service, "-w"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0 || !stdout.trim()) return null;

    const data = JSON.parse(stdout.trim()) as { claudeAiOauth: OAuthTokens };
    return data.claudeAiOauth;
  } catch {
    return null;
  }
}

/**
 * Write updated OAuth tokens back to macOS Keychain.
 */
async function writeKeychainTokens(configDir: string, tokens: OAuthTokens): Promise<void> {
  const suffix = keychainSuffix(configDir);
  const service = `Claude Code-credentials-${suffix}`;
  const payload = JSON.stringify({ claudeAiOauth: tokens });

  try {
    // Delete existing entry first (security doesn't have an update command)
    const del = Bun.spawn(
      ["security", "delete-generic-password", "-s", service],
      { stdout: "pipe", stderr: "pipe" },
    );
    await del.exited;

    // Add new entry
    const add = Bun.spawn(
      ["security", "add-generic-password", "-s", service, "-a", userInfo().username, "-w", payload],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await add.exited;
    if (exitCode !== 0) {
      logger.warn("[auth] Failed to update keychain");
    }
  } catch {
    logger.warn("[auth] Could not write to keychain");
  }
}

/**
 * Resolve Anthropic auth from a claude config directory.
 * Reads OAuth tokens from macOS Keychain and refreshes if expired.
 */
export async function resolveFromKeychain(configDir: string): Promise<AnthropicAuth> {
  const tokens = await readKeychainTokens(configDir);

  if (!tokens) {
    throw new Error(`No credentials found in keychain for config dir "${configDir}"`);
  }

  // Check if token is still valid (with 5 min buffer)
  const now = Date.now();
  if (tokens.expiresAt > now + 5 * 60 * 1000) {
    logger.info("[auth] Using keychain token (valid)");
    return { authToken: tokens.accessToken };
  }

  // Token expired — refresh it
  logger.info("[auth] Refreshing keychain token...");

  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const newTokens: OAuthTokens = {
    ...tokens,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? tokens.refreshToken,
    expiresAt: now + data.expires_in * 1000,
  };

  // Write back to keychain
  await writeKeychainTokens(configDir, newTokens);
  logger.info("[auth] Token refreshed");

  return { authToken: newTokens.accessToken };
}
