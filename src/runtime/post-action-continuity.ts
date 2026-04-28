const OPERATOR_LOG_TERMS = [
  "tool result",
  "tool call",
  "raw output",
  "stdout",
  "stderr",
  "json payload",
  "command exited",
  "exit code",
  "runtime trace",
];

const REPORT_SHAPE_PATTERN = /^(task completed|done|completed|all set)\b[\s\S]{0,240}\b(verification|changed|stdout|stderr|tool result|command exited)\b/i;

export interface PostActionContinuityDiagnostics {
  passed: boolean;
  operatorLogTerms: string[];
  reportShapeForLightAction: boolean;
  bulletCount: number;
  issues: string[];
}

export function inspectPostActionContinuity(response: string): PostActionContinuityDiagnostics {
  const normalized = response.toLowerCase();
  const operatorLogTerms = OPERATOR_LOG_TERMS.filter((term) => normalized.includes(term));
  const bulletCount = response.split(/\r?\n/).filter((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line)).length;
  const reportShapeForLightAction = REPORT_SHAPE_PATTERN.test(response.trim()) || (bulletCount >= 3 && /\bverification\b/i.test(response));
  const issues: string[] = [];
  if (operatorLogTerms.length > 0) issues.push("operator_log_leakage");
  if (reportShapeForLightAction) issues.push("report_shape_for_light_action");

  return {
    passed: issues.length === 0,
    operatorLogTerms,
    reportShapeForLightAction,
    bulletCount,
    issues,
  };
}
