import type { ProposalCategory, ProposalEffort, ProposalAutonomy } from "./store.js";

/** File path patterns that always require human approval, regardless of category or effort.
 *
 * Uses \b only at the START of keywords — NOT at the end — so camelCase/PascalCase
 * filenames like AuthContext.tsx or authPersistence.ts are caught.
 * (A trailing \b fails on camelCase because the boundary between "auth" and "Context"
 * is letter→letter, which is NOT a word boundary.)
 */
const PROTECTED_PATHS = [
  /\bauth/i,
  /\bsecurity/i,
  /\brbac/i,
  /\bmiddleware/i,
  /config\.toml/i,
  /schema\.sql/i,
  /\bmigrations?\b/i,
  /\.env/i,
  /\bcredentials\b/i,
  /\bkeychain\b/i,
  /package\.json/i,
  /bun\.lock/i,
  /\bsecret/i,
  /\btoken/i,
  /\bsession/i,
  /\bpermission/i,
  /\brls\b/i,
  /supabase\//i,
];

/** Categories that always require approval */
const APPROVAL_CATEGORIES = new Set<ProposalCategory>(["feature", "improvement"]);

/** Auto-eligible categories (still subject to effort + file checks) */
const AUTO_ELIGIBLE_CATEGORIES = new Set<ProposalCategory>(["maintenance", "bugfix"]);

/**
 * Classify whether a proposal can be auto-executed or requires owner approval.
 *
 * Hard safety rails (never bypassed):
 * - Features and improvements always require approval
 * - Medium or large effort always requires approval
 * - Any file matching PROTECTED_PATHS always requires approval
 *
 * Auto-eligible:
 * - maintenance or bugfix + small effort + no protected files
 */
export function classifyAutonomy(
  category: ProposalCategory,
  effort: ProposalEffort,
  files: string[],
): ProposalAutonomy {
  // Instance proposals always require approval — never auto-execute
  if (category === "new_instance") return "requires_approval";

  // Hard rails: category
  if (APPROVAL_CATEGORIES.has(category)) return "requires_approval";

  // Hard rails: effort
  if (effort !== "small") return "requires_approval";

  // Hard rails: protected files
  if (files.some(f => PROTECTED_PATHS.some(p => p.test(f)))) return "requires_approval";

  // Auto-eligible categories with small effort and safe files
  if (AUTO_ELIGIBLE_CATEGORIES.has(category)) return "auto";

  // Default: require approval
  return "requires_approval";
}
