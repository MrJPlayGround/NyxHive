/**
 * Outbound response redaction.
 *
 * Two layers:
 * - redactSecrets(): always applied to all outbound responses.
 *   Catches API keys, tokens, credentials that should never appear in output.
 * - redactForGroup(): applied in group/public context.
 *   Additionally strips internal paths and server details.
 */

interface RedactionRule {
  pattern: RegExp;
  replacement: string;
}

const SENSITIVE_ENV_NAME_RE = /(api[_-]?key|token|secret|password|auth|cookie)/i;
const MIN_DYNAMIC_SECRET_LENGTH = 16;

// Always applied: credentials and secrets
const SECRET_RULES: RedactionRule[] = [
  // Anthropic API keys
  { pattern: /sk-ant-[a-zA-Z0-9-]{20,}/g, replacement: "[REDACTED_KEY]" },
  // OpenAI-style keys
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, replacement: "[REDACTED_KEY]" },
  // AWS access keys
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED_KEY]" },
  // Generic secret assignment patterns (key=..., token=..., etc.)
  { pattern: /(?:api[_-]?key|api[_-]?secret|bot[_-]?token|access[_-]?token|secret[_-]?key)[\s:="']+[^\s"']{16,}/gi, replacement: "[REDACTED_CREDENTIAL]" },
  // Bearer tokens
  { pattern: /Bearer\s+[a-zA-Z0-9._~+/=-]{20,}/g, replacement: "Bearer [REDACTED]" },
  // JWT tokens (three base64url-encoded segments)
  { pattern: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, replacement: "[REDACTED_JWT]" },
  // Telegram bot tokens (numeric:alphanumeric)
  { pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35,}\b/g, replacement: "[REDACTED_BOT_TOKEN]" },
  // Discord bot tokens (base64-ish, 59+ chars)
  { pattern: /[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, replacement: "[REDACTED_BOT_TOKEN]" },
  // GitHub Personal Access Tokens
  { pattern: /ghp_[a-zA-Z0-9]{36,}/g, replacement: "[REDACTED_GITHUB_PAT]" },
  // GitHub fine-grained PATs
  { pattern: /github_pat_[a-zA-Z0-9_]{82,}/g, replacement: "[REDACTED_GITHUB_PAT]" },
  // Database connection strings
  { pattern: /(?:mongodb\+srv|mongodb|postgresql|postgres|mysql|redis):\/\/[^\s"'`,)}\]]+/gi, replacement: "[REDACTED_DB_URL]" },
  // Authorization headers in text
  { pattern: /(?:Authorization|X-API-Key|X-Auth-Token)[\s:]+(?:Bearer\s+)?[a-zA-Z0-9._~+/=-]{16,}/gi, replacement: "[REDACTED_AUTH_HEADER]" },
];

// Group context: also strip internal details
const GROUP_RULES: RedactionRule[] = [
  // Absolute paths revealing server/user structure
  { pattern: /\/Users\/[^\s"'`,)}\]]+/g, replacement: "[internal-path]" },
  { pattern: /\/home\/[^\s"'`,)}\]]+/g, replacement: "[internal-path]" },
];

function redactDynamicEnvSecrets(text: string): string {
  let result = text;

  for (const [name, rawValue] of Object.entries(process.env)) {
    if (!SENSITIVE_ENV_NAME_RE.test(name)) continue;
    const value = rawValue?.trim();
    if (!value || value.length < MIN_DYNAMIC_SECRET_LENGTH) continue;
    if (!result.includes(value)) continue;
    result = result.split(value).join("[REDACTED_ENV_SECRET]");
  }

  return result;
}

/**
 * Strip secrets from text. Applied to ALL outbound responses.
 */
export function redactSecrets(text: string): string {
  let result = redactDynamicEnvSecrets(text);
  for (const rule of SECRET_RULES) {
    // Reset lastIndex for global regexes
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

/**
 * Strip secrets + internal details. Applied in group/public context.
 */
export function redactForGroup(text: string): string {
  let result = redactSecrets(text);
  for (const rule of GROUP_RULES) {
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}
