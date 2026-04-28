/**
 * Sensitive env var patterns — any key matching these is stripped from agent environments.
 * Covers: API keys, tokens, passwords, secrets, credentials.
 */
const SENSITIVE_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /token/i,
  /credential/i,
  /private[_-]?key/i,
  /auth/i,
];

/** Explicit safe list — these are always forwarded regardless of pattern matches. */
const SAFE_VARS = new Set([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "NODE_ENV",
  "BUN_INSTALL",
  "EDITOR",
  "VISUAL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "COLORTERM",
  "TERM_PROGRAM",
  "HOSTNAME",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CODEX_AUTH_PATH",
]);

/**
 * Sanitize process.env for agent subprocesses.
 * Keeps safe vars, strips anything matching sensitive patterns.
 */
export function sanitizeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SAFE_VARS.has(key)) {
      result[key] = value;
      continue;
    }
    if (SENSITIVE_PATTERNS.some((p) => p.test(key))) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Credential vault — holds secrets in memory, dispenses only to authorized agents.
 * The daemon loads credentials at boot; agents never see the full set.
 */
export class CredentialVault {
  private secrets: Map<string, string>;
  /** Track credential access for audit purposes */
  private accessLog: Array<{ agent: string; credentials: string[]; timestamp: number }> = [];

  constructor(secrets: Record<string, string>) {
    this.secrets = new Map(Object.entries(secrets));
  }

  get(name: string): string | undefined {
    return this.secrets.get(name);
  }

  has(name: string): boolean {
    return this.secrets.has(name);
  }

  /**
   * Return only the credentials an agent has declared it needs.
   * Unknown/missing names are silently skipped.
   * Access is logged for audit trail.
   */
  getForAgent(declared: string[], agentName?: string): Record<string, string> {
    const result: Record<string, string> = {};
    const accessed: string[] = [];
    for (const name of declared) {
      const value = this.secrets.get(name);
      if (value !== undefined) {
        result[name] = value;
        accessed.push(name);
      }
    }
    if (accessed.length > 0) {
      this.accessLog.push({
        agent: agentName ?? "unknown",
        credentials: accessed,
        timestamp: Date.now(),
      });
      // Keep only last 1000 entries
      if (this.accessLog.length > 1000) {
        this.accessLog = this.accessLog.slice(-500);
      }
    }
    return result;
  }

  /** Get recent credential access entries for audit. */
  getAccessLog(limit = 100): Array<{ agent: string; credentials: string[]; timestamp: number }> {
    return this.accessLog.slice(-limit);
  }
}
