import type { AgentConfig } from "../types.js";
import type { PairingRole } from "../pairing/pairing.js";

/**
 * Apply hard runtime restrictions based on the authenticated sender role.
 *
 * Roles are enforced here, not just hinted in prompts:
 * - operator: full agent behavior
 * - engineer: read-only analysis (no CLI, no write tools)
 * - support/viewer: no tool use, no CLI
 */
export function applySenderRolePolicy(agent: AgentConfig, senderRole?: string): AgentConfig {
  const role = (senderRole ?? "").toLowerCase() as PairingRole | "";
  if (!role || role === "operator") return agent;

  const next: AgentConfig = { ...agent };

  // CLI/Codex escalation is executable authority, not a provider feature.
  // Non-operators may still use SDK/API paths according to role limits.
  next.always_cli = false;
  next.cli_fallback = undefined;

  if (role === "engineer") {
    next.role = "expert";
    return next;
  }

  next.role = "expert";
  next.capabilities = (next.capabilities ?? []).filter((cap) => cap !== "tool_use");
  next.allowed_tools = undefined;
  next.disallowed_tools = undefined;
  next.mcp_tools = undefined;
  return next;
}
