/**
 * Input sanitizer — detects prompt injection patterns in user messages.
 *
 * Runs before messages reach the LLM. Three severity levels:
 * - "block": message is rejected entirely, user gets a generic refusal
 * - "warn": message is flagged in audit log, still processed
 * - "pass": no match, clean message
 *
 * All patterns are checked against the raw message text. The sanitizer
 * does NOT modify messages — it only classifies them. Modification would
 * risk breaking legitimate messages.
 */

import { logger } from "../utils/logger.js";

export type SanitizeVerdict = "pass" | "warn" | "block";

/**
 * Trust origin — controls how strictly patterns are enforced.
 * - "user": untrusted external input, full enforcement (default)
 * - "agent": internal agent-to-agent messages, blocks downgraded to warns
 * - "system": system-generated content (reviews, proposals), sanitizer skipped
 */
export type TrustOrigin = "user" | "agent" | "system";

export interface SanitizeResult {
  verdict: SanitizeVerdict;
  /** Which pattern(s) matched, if any */
  matched: string[];
  /** Human-readable reason for the verdict */
  reason?: string;
}

interface Pattern {
  name: string;
  regex: RegExp;
  severity: "block" | "warn";
}

/**
 * Patterns that indicate prompt injection attempts.
 * Ordered roughly by severity / confidence.
 */
const PATTERNS: Pattern[] = [
  // --- Block-level: high confidence injection ---
  {
    name: "system_prompt_extraction",
    regex: /(?:output|print|show|reveal|display|repeat|echo)\s+(?:me\s+)?(?:your|the)\s+(?:system\s*prompt|instructions|initial\s*prompt|rules|guidelines|soul)/i,
    severity: "block",
  },
  {
    name: "ignore_instructions",
    regex: /(?:ignore|disregard|forget|override|bypass|skip)\s+(?:(?:all|your|prior|any|previous|above|earlier)\s+){0,2}(?:instructions|rules|guidelines|constraints|restrictions|directives|prompts)/i,
    severity: "block",
  },
  {
    name: "role_hijack",
    regex: /(?:you\s+are\s+now|from\s+now\s+on\s+you\s+are|pretend\s+(?:to\s+be|you\s*(?:'re|are))|act\s+as\s+(?:if\s+you\s+are|a)|switch\s+to\s+(?:a\s+)?(?:different|new)\s+(?:role|persona|mode))/i,
    severity: "block",
  },
  {
    name: "dev_mode_jailbreak",
    regex: /(?:(?:enable|enter|activate|switch\s+to)\s+(?:dev(?:eloper)?|debug|admin|root|god|sudo|unrestricted|jailbreak|DAN)\s+mode|you\s+(?:have\s+been|are)\s+(?:freed|liberated|unlocked|unchained))/i,
    severity: "block",
  },
  {
    name: "output_format_injection",
    regex: /\[(?:system|SYSTEM)\]|<\|(?:im_start|system|endoftext)\|>|<<\s*SYS\s*>>|###\s*(?:System|Instruction|Human|Assistant)\s*:/i,
    severity: "block",
  },
  {
    name: "identity_spoofing",
    regex: /(?:I\s+am|this\s+is|speaking\s+as|message\s+from)\s+(?:User|the\s+(?:operator|admin|owner))/i,
    severity: "block",
  },

  // --- Warn-level: suspicious but could be legitimate ---
  {
    name: "credential_fishing",
    regex: /(?:what\s+(?:is|are)\s+(?:your|the)\s+(?:api\s*key|token|password|secret|credential|\.env|env\s*(?:var|file)))|(?:show|list|reveal|dump)\s+(?:all\s+)?(?:your\s+)?(?:secret|credential|token|env|\.env|key)/i,
    severity: "warn",
  },
  {
    name: "file_path_probing",
    regex: /(?:what\s+(?:is|are)\s+(?:your|the)\s+(?:file\s*path|directory|working\s*dir|config\s*(?:path|file)|home\s*dir))|(?:show|list|reveal)\s+(?:your\s+)?(?:file\s*system|directory\s*(?:structure|tree)|config\s*files)/i,
    severity: "warn",
  },
  {
    name: "instruction_boundary",
    regex: /(?:end\s+of\s+(?:system\s+)?(?:prompt|instructions)|---+\s*(?:new|real|actual)\s*(?:instructions|prompt|task))/i,
    severity: "warn",
  },
  {
    name: "multi_persona",
    regex: /(?:respond\s+(?:as|like)\s+(?:two|multiple|different)\s+(?:people|personas|characters))|(?:split\s+(?:your\s+)?(?:personality|response))/i,
    severity: "warn",
  },
  {
    name: "encoding_evasion",
    regex: /(?:base64|rot13|hex|ascii|unicode|encode|decode)\s*[:=]\s*[A-Za-z0-9+/=]{20,}/i,
    severity: "warn",
  },
];

/**
 * Scan a message for prompt injection patterns.
 * Returns a verdict + list of matched pattern names.
 *
 * Trust-aware: "system" origin skips entirely, "agent" downgrades blocks to warns.
 */
export function sanitizeInput(text: string, trust: TrustOrigin = "user"): SanitizeResult {
  if (trust === "system") {
    return { verdict: "pass", matched: [] };
  }

  const matched: string[] = [];
  let maxSeverity: SanitizeVerdict = "pass";

  for (const pattern of PATTERNS) {
    if (pattern.regex.test(text)) {
      matched.push(pattern.name);
      if (pattern.severity === "block") {
        maxSeverity = "block";
      } else if (pattern.severity === "warn" && maxSeverity !== "block") {
        maxSeverity = "warn";
      }
    }
  }

  if (matched.length === 0) {
    return { verdict: "pass", matched: [] };
  }

  // Agent-origin messages: downgrade blocks to warns (content is trusted but worth logging)
  if (trust === "agent" && maxSeverity === "block") {
    maxSeverity = "warn";
  }

  const reason = `Matched patterns: ${matched.join(", ")} [trust=${trust}]`;
  logger.info(`[security] Input sanitizer: ${maxSeverity} — ${reason} — text: "${text.slice(0, 120)}…"`);

  return { verdict: maxSeverity, matched, reason };
}

/**
 * Quick check — returns true if the message should be blocked.
 */
export function shouldBlockMessage(text: string, trust: TrustOrigin = "user"): boolean {
  return sanitizeInput(text, trust).verdict === "block";
}
