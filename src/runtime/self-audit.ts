import { DEFAULT_COST_RATES, getContextWindow, getModelTier } from "../defaults.js";
import { resolveCodexSecurityDecision } from "../agents/codex-security.js";
import type { AgentConfig } from "../types.js";

export type RuntimeAuditSeverity = "pass" | "warn" | "fail";

export type RuntimeAuditCheck = {
  id: string;
  label: string;
  severity: RuntimeAuditSeverity;
  detail: string;
};

export type RuntimeSelfAuditInput = {
  agents: Record<string, AgentConfig>;
  queue: { pending: number; processing: number; deadLetters: number; staleRunning: number };
  git: { clean: boolean; branch: string; ahead: number };
  modelMetadata?: { hasCostRate: boolean; hasContextWindow: boolean; tier: number };
};

export type RuntimeSelfAuditReport = {
  ok: boolean;
  status: RuntimeAuditSeverity;
  checks: RuntimeAuditCheck[];
};

function findNyxAgent(agents: Record<string, AgentConfig>): AgentConfig | undefined {
  return agents.Nyx ?? agents.nyx ?? agents.assistant ?? Object.values(agents).find((agent) => agent.name.toLowerCase() === "nyx");
}

export function runRuntimeSelfAudit(input: RuntimeSelfAuditInput): RuntimeSelfAuditReport {
  const checks: RuntimeAuditCheck[] = [];
  const nyx = findNyxAgent(input.agents);
  const model = nyx?.model ?? "";
  const metadata = input.modelMetadata ?? {
    hasCostRate: Boolean(DEFAULT_COST_RATES[model]),
    hasContextWindow: getContextWindow(model) > 0,
    tier: getModelTier(model),
  };

  checks.push({
    id: "model-default",
    label: "Nyx model",
    severity: model === "gpt-5.5" ? "pass" : "fail",
    detail: model || "missing",
  });
  checks.push({
    id: "model-metadata",
    label: "Model metadata",
    severity: metadata.hasCostRate && metadata.hasContextWindow && metadata.tier >= 4 ? "pass" : "fail",
    detail: `cost=${metadata.hasCostRate} context=${metadata.hasContextWindow} tier=${metadata.tier}`,
  });

  if (nyx) {
    const decision = resolveCodexSecurityDecision({
      agent: nyx,
      workingDirectory: nyx.working_directory,
      configuredAdditionalDirectories: nyx.allowed_directories,
      taskType: "coding",
      requireExecutableAuthority: true,
    });
    checks.push({
      id: "codex-authority",
      label: "Codex authority",
      severity: decision.authority.filteredAdditionalDirectories.length === 0 ? "pass" : "fail",
      detail: `${decision.sandboxMode}; filtered=${decision.authority.filteredAdditionalDirectories.join(",") || "none"}`,
    });
  } else {
    checks.push({ id: "codex-authority", label: "Codex authority", severity: "fail", detail: "Nyx agent missing" });
  }

  checks.push({
    id: "queue-health",
    label: "Queue health",
    severity: input.queue.staleRunning > 0 ? "fail" : input.queue.deadLetters > 0 ? "warn" : "pass",
    detail: `pending=${input.queue.pending} processing=${input.queue.processing} dead=${input.queue.deadLetters} stale=${input.queue.staleRunning}`,
  });
  checks.push({
    id: "git-state",
    label: "Git state",
    severity: input.git.clean ? "pass" : "warn",
    detail: `${input.git.branch}; ahead=${input.git.ahead}; clean=${input.git.clean}`,
  });

  const status: RuntimeAuditSeverity = checks.some((check) => check.severity === "fail")
    ? "fail"
    : checks.some((check) => check.severity === "warn")
      ? "warn"
      : "pass";

  return { ok: status !== "fail", status, checks };
}
