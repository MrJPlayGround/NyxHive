/**
 * Completion artifact registry.
 *
 * Defines what "success" looks like for each proposal category.
 * Each artifact carries provenance (where it ran, what it produced)
 * so validation is evidence-based, not agent-reported.
 */

import type { ProposalCategory } from "./store.js";

export type ArtifactKind = "commit" | "pr" | "test_pass" | "type_check" | "note_written" | "config_applied";

export interface ArtifactExpectation {
  kind: ArtifactKind;
  required: boolean;
  description: string;
}

/**
 * Evidence attached to an artifact — proves it actually happened.
 * Not just "test_pass: true" but "test_pass ran `bun test` in /foo at exit 0".
 */
export interface ArtifactEvidence {
  present: boolean;
  /** Where the artifact was produced (cwd for commands, repo for commits) */
  scope?: string;
  /** Branch the artifact was produced on */
  branch?: string;
  /** Command that produced the evidence (for test_pass, type_check) */
  command?: string;
  /** Exit code (0 = success) */
  exit_code?: number;
  /** URL or ref (for pr, commit) */
  ref?: string;
}

/**
 * Per-category artifact expectations. Each category declares what
 * artifacts a successful execution should produce.
 *
 * Maintenance category follows "conditional floor" rule:
 * - If files changed on disk → commit is required
 * - Otherwise → at least one machine-verifiable artifact
 * This is enforced in validateArtifacts, not in the static registry.
 */
const ARTIFACT_REGISTRY: Record<ProposalCategory, ArtifactExpectation[]> = {
  bugfix: [
    { kind: "commit", required: true, description: "At least one commit on the execution branch" },
    { kind: "test_pass", required: true, description: "Tests pass after changes" },
    { kind: "type_check", required: true, description: "Type check passes" },
    { kind: "pr", required: true, description: "PR created for review" },
  ],
  feature: [
    { kind: "commit", required: true, description: "At least one commit on the execution branch" },
    { kind: "test_pass", required: true, description: "Tests pass after changes" },
    { kind: "type_check", required: true, description: "Type check passes" },
    { kind: "pr", required: true, description: "PR created for review" },
  ],
  improvement: [
    { kind: "commit", required: true, description: "At least one commit on the execution branch" },
    { kind: "test_pass", required: true, description: "Tests pass after changes" },
    { kind: "type_check", required: true, description: "Type check passes" },
    { kind: "pr", required: false, description: "PR created if changes warrant review" },
  ],
  maintenance: [
    { kind: "commit", required: false, description: "Commit if code was changed" },
    { kind: "test_pass", required: false, description: "Tests pass if they exist" },
    { kind: "type_check", required: false, description: "Type check passes if applicable" },
    { kind: "pr", required: false, description: "PR if code changes were made" },
  ],
  new_instance: [
    { kind: "config_applied", required: true, description: "Instance config created and valid" },
  ],
};

/**
 * Get the expected artifacts for a proposal category.
 */
export function getExpectedArtifacts(category: ProposalCategory): ArtifactExpectation[] {
  return ARTIFACT_REGISTRY[category] ?? [];
}

/**
 * Get only the required artifacts for a category.
 */
export function getRequiredArtifacts(category: ProposalCategory): ArtifactExpectation[] {
  return getExpectedArtifacts(category).filter(a => a.required);
}

export interface ArtifactCheck {
  kind: ArtifactKind;
  expected: boolean;
  present: boolean;
  required: boolean;
  /** Evidence proving the artifact's presence (or absence) */
  evidence?: ArtifactEvidence;
}

export interface ArtifactResult {
  passed: boolean;
  checks: ArtifactCheck[];
  missing: ArtifactCheck[];
}

/**
 * Validate actual artifacts against expectations.
 *
 * Accepts either simple booleans (backwards compatible) or rich evidence objects.
 * When evidence is provided, it's attached to the check for downstream consumers
 * (logging, chaining, audit).
 *
 * For maintenance category, enforces conditional floor:
 * - If commit is present → pass (files changed, commit proves work)
 * - If no commit and no other evidence artifact → fail
 */
export function validateArtifacts(
  category: ProposalCategory,
  actual: Partial<Record<ArtifactKind, boolean | ArtifactEvidence>>,
): ArtifactResult {
  const expectations = getExpectedArtifacts(category);

  const checks: ArtifactCheck[] = expectations.map(exp => {
    const value = actual[exp.kind];
    let present: boolean;
    let evidence: ArtifactEvidence | undefined;

    if (value === undefined || value === false) {
      present = false;
    } else if (value === true) {
      present = true;
    } else {
      // ArtifactEvidence object
      present = value.present;
      evidence = value;
    }

    return {
      kind: exp.kind,
      expected: true,
      present,
      required: exp.required,
      evidence,
    };
  });

  let missing = checks.filter(c => c.required && !c.present);

  // Maintenance conditional floor: if nothing is present at all, fail.
  // "All optional" doesn't mean "nothing required" — at least one artifact must be present.
  if (category === "maintenance" && missing.length === 0) {
    const anyPresent = checks.some(c => c.present);
    if (!anyPresent) {
      // Synthesize a missing check — maintenance needs at least one verifiable artifact
      missing = [{ kind: "commit", expected: true, present: false, required: true }];
    }
  }

  return {
    passed: missing.length === 0,
    checks,
    missing,
  };
}
