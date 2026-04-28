import type { ProposalCategory, ProposalEffort, ProposalPriority } from "./store.js";

export interface ProposalDecisionInput {
  title: string;
  description: string;
  category: ProposalCategory;
  effort: ProposalEffort;
  priority?: ProposalPriority;
  files: string[];
}

export interface ProposalDecisionGate {
  shouldCreate: boolean;
  reason: string;
  signals: string[];
  suggestedLane: "proposal" | "task" | "standing_order" | "skill_candidate" | "incident_note";
}

const GOVERNANCE_CATEGORY = new Set<ProposalCategory>(["feature", "new_instance"]);

const GOVERNANCE_PATTERN = /\b(approval|approve|approval workflow|policy|product direction|user[- ]?facing|public[- ]?facing|external|budget|spend|cost|billing|auth|security|permission|token|secret|credential|schema|migration|data loss|delete|destructive|standing order|skill|repeatable decision|escalation|risk|governance|proposal review|proposal lane|review routing)\b/i;
const INCIDENT_PATTERN = /\b(failing|failed|broken|regression|incident|outage|dead letter|stale queue|unauthorized|crash|error|flaky)\b/i;
const STANDING_ORDER_PATTERN = /\b(watch|monitor|heartbeat|daily|hourly|weekly|recurring|when .* then|if .* then|trigger|cadence|escalat(?:e|ion))\b/i;
const SKILL_PATTERN = /\b(skill|procedure|playbook|repeatable decision|decision boundary|when to use|when not to use)\b/i;

function protectedPath(file: string): boolean {
  return /\b(auth|security|rbac|middleware|migration|schema|supabase|billing|session|token|secret|credential|permission)\b|\.env|config\.toml|schema\.sql|package\.json|bun\.lock/i.test(file);
}

export function evaluateProposalDecision(input: ProposalDecisionInput): ProposalDecisionGate {
  const text = `${input.title}\n${input.description}`;
  const signals: string[] = [];

  if (GOVERNANCE_CATEGORY.has(input.category)) signals.push(`governance category:${input.category}`);
  if (input.priority === "high") signals.push("high priority");
  if (input.effort === "medium" || input.effort === "large") signals.push(`non-trivial effort:${input.effort}`);
  if (input.files.some(protectedPath)) signals.push("protected files");
  if (GOVERNANCE_PATTERN.test(text)) signals.push("governance language");

  if (signals.length > 0) {
    return {
      shouldCreate: true,
      reason: `requires approval or policy decision (${signals.join(", ")})`,
      signals,
      suggestedLane: "proposal",
    };
  }

  if (STANDING_ORDER_PATTERN.test(text)) {
    return {
      shouldCreate: false,
      reason: "looks like bounded recurring work; make it a standing order instead of a proposal",
      signals: ["recurring-work language"],
      suggestedLane: "standing_order",
    };
  }

  if (SKILL_PATTERN.test(text)) {
    return {
      shouldCreate: false,
      reason: "looks like reusable procedure work; make it a skill candidate instead of a proposal",
      signals: ["skill language"],
      suggestedLane: "skill_candidate",
    };
  }

  if (INCIDENT_PATTERN.test(text)) {
    return {
      shouldCreate: false,
      reason: "looks like a concrete incident or fix; create a task or fix it directly, then report evidence",
      signals: ["incident language"],
      suggestedLane: "task",
    };
  }

  return {
    shouldCreate: false,
    reason: "no approval, policy, risk, or repeatable-decision signal; use chat/task/report lane instead",
    signals: [],
    suggestedLane: "task",
  };
}
