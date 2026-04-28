import type { AgentConfig, TeamConfig } from "../types.js";
import type { RoutingSuggestion } from "../memory/routing.js";
import { logger } from "../utils/logger.js";
import { resolvePrimaryAgentKey } from "./primary.js";

interface RouteResult {
  type: "agent" | "team";
  name: string;
  agent?: AgentConfig;
  team?: TeamConfig;
  strippedMessage: string;
  /** Data-driven suggestion from the routing store skill matrix (advisory only). */
  suggestedAgent?: string;
}

interface RoutingHints {
  routingStore?: { getSuggestions(sinceDays?: number, minTrials?: number): RoutingSuggestion[] };
  taskType?: string;
}

/**
 * Parse @mentions from a message and resolve to an agent or team.
 * Supports: @agentName, @teamName
 * If no mention is found, routes to the default agent.
 * When hints are provided and no @mention is present, enriches the result
 * with a suggestedAgent from the skill matrix (advisory, not auto-routing).
 */
export function routeMessage(
  message: string,
  agents: Record<string, AgentConfig>,
  teams: Record<string, TeamConfig>,
  defaultAgent?: string,
  hints?: RoutingHints,
): RouteResult {
  // Check for @mention at the start of the message
  const mentionMatch = message.match(/^@(\w+)\s*(.*)/s);

  if (mentionMatch) {
    const mention = mentionMatch[1].toLowerCase();
    const strippedMessage = mentionMatch[2].trim() || message;

    // Check teams first
    const teamKey = Object.keys(teams).find((k) => k.toLowerCase() === mention);
    if (teamKey) {
      const team = teams[teamKey];
      logger.debug(`[routing] Routed to team: ${team.name}`);
      return { type: "team", name: teamKey, team, strippedMessage };
    }

    // Check agents
    const agentKey = Object.keys(agents).find((k) => k.toLowerCase() === mention);
    if (agentKey) {
      const agent = agents[agentKey];
      logger.debug(`[routing] Routed to agent: ${agent.name}`);
      return { type: "agent", name: agentKey, agent, strippedMessage };
    }

    // Mention not found — fall through to default
    logger.debug(`[routing] Unknown mention @${mention}, using default`);
  }

  // Default agent
  const agentKey = defaultAgent ?? resolvePrimaryAgentKey(agents) ?? Object.keys(agents)[0];
  const agent = agents[agentKey];

  if (!agent) {
    throw new Error("No agents configured");
  }

  // Enrich with data-driven suggestion when falling to default (no @mention matched)
  let suggestedAgent: string | undefined;
  if (hints?.routingStore && hints?.taskType) {
    const suggestions = hints.routingStore.getSuggestions();
    const match = suggestions.find(s => s.task_type === hints.taskType);
    if (match && match.composite_score >= 70 && agents[match.agent]) {
      suggestedAgent = match.agent;
      logger.debug(`[routing] Skill matrix suggests @${match.agent} for ${hints.taskType} (score: ${match.composite_score})`);
    }
  }

  return {
    type: "agent",
    name: agentKey,
    agent,
    strippedMessage: message,
    suggestedAgent,
  };
}
