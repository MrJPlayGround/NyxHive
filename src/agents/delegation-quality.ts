import type { ActorMention } from "../types.js";

export interface DelegationQualityInput {
  originalRequest: string;
  mention: ActorMention;
  availableAgents?: string[];
  primaryAgent?: string;
  resultResponse?: string;
}

export interface DelegationQualityDiagnostics {
  passed: boolean;
  issues: string[];
  unnecessaryDelegation: boolean;
  wrongTargetLikely: boolean;
  missingRationale: boolean;
  missingSuccessContract: boolean;
  poorMergeBack: boolean;
  ownershipClear: boolean;
}

const DIRECT_ANSWER_PATTERN = /^(hi|hello|hey|thanks|thank you|ok|okay|nice|lol|what do you think\??|you alive\??)$/i;

export function inspectDelegationQuality(input: DelegationQualityInput): DelegationQualityDiagnostics {
  const issues: string[] = [];
  const request = input.originalRequest.trim();
  const contract = input.mention.contract;
  const unnecessaryDelegation = DIRECT_ANSWER_PATTERN.test(request) && !contract;
  const wrongTargetLikely = !!input.availableAgents?.length
    && !input.availableAgents.includes(input.mention.agent.toLowerCase())
    && !input.availableAgents.includes(input.mention.agent);
  const missingRationale = !contract && !input.mention.verifyHints?.length && !input.mention.filePaths?.length;
  const missingSuccessContract = !!contract && contract.successCriteria.length === 0 && contract.verification.length === 0;
  const poorMergeBack = !!input.resultResponse && hasDoubleVoice(input.resultResponse);
  const ownershipClear = contract
    ? contract.outputFiles.length > 0 || contract.outputType !== "unknown" || contract.constraints.length > 0
    : !!input.mention.filePaths?.length || !!input.mention.verifyHints?.length;

  if (unnecessaryDelegation) issues.push("unnecessary_delegation");
  if (wrongTargetLikely) issues.push("wrong_target");
  if (missingRationale) issues.push("missing_rationale");
  if (missingSuccessContract) issues.push("missing_success_contract");
  if (poorMergeBack) issues.push("poor_merge_back");
  if (!ownershipClear) issues.push("unclear_ownership");

  return {
    passed: issues.length === 0,
    issues,
    unnecessaryDelegation,
    wrongTargetLikely,
    missingRationale,
    missingSuccessContract,
    poorMergeBack,
    ownershipClear,
  };
}

export function formatDelegationInspection(input: DelegationQualityInput): string {
  const diagnostics = inspectDelegationQuality(input);
  const target = input.mention.instance ? `${input.mention.instance}/${input.mention.agent}` : input.mention.agent;
  const lines = [
    `Target: ${target}`,
    `Task: ${input.mention.task.slice(0, 240)}`,
    `Ownership: ${diagnostics.ownershipClear ? "clear" : "unclear"}`,
    `Result: ${diagnostics.passed ? "pass" : `issues=${diagnostics.issues.join(", ")}`}`,
  ];
  return lines.join("\n");
}

function hasDoubleVoice(response: string): boolean {
  return /\*\*[^*]+\*\* \(@[^)]+\):[\s\S]+\*\*[^*]+\*\* \(@[^)]+\):/m.test(response)
    || /\b(agent said|analyst said|tester said|forge said)\b/i.test(response);
}
