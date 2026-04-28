import type { TaskType } from "../providers/types.js";

export const MCP_TOOL_SCHEMA_ESTIMATE_TOKENS = 500;

export interface McpToolProfileDecision {
  profile: string;
  requestedTools: string[];
  exposedTools: string[];
  droppedTools: string[];
  estimatedSchemaTokens: number;
  estimatedSavedTokens: number;
}

const STATUS_TOOLS = new Set([
  "list_agents",
  "list_projects",
  "get_agent_status",
  "get_queue_status",
  "get_context_pressure",
  "knowledge_health",
]);

const MEMORY_TOOLS = new Set([
  "search_knowledge",
  "search_obsidian",
  "search_conversation_memory",
  "list_threads",
  "get_thread",
]);

const PROPOSAL_READ_TOOLS = new Set([
  "list_proposals",
  "get_proposal",
]);

const PROPOSAL_WRITE_TOOLS = new Set([
  "create_proposal",
  "start_review",
  "approve_proposal",
  "reject_proposal",
  "requeue_proposal",
  "complete_proposal",
  "delete_proposal",
]);

const COORDINATION_TOOLS = new Set([
  "send_message",
  "relay_message",
  "channels_list",
  "channel_send",
  "claim_work",
  "release_work",
  "post_progress",
  "request_input",
  "btw_agent",
  "steer_agent",
]);

const CODE_TOOLS = new Set([
  "git_status",
  "git_log",
  "list_projects",
]);

const OPS_TOOLS = new Set([
  "get_usage",
  "get_logs",
  "get_routing_stats",
  "trigger_scan",
  "list_scheduled_tasks",
]);

const RESEARCH_TOOLS = new Set([
  "brave_web_search",
  "brave_news_search",
  "brave_image_search",
  "brave_video_search",
  "brave_local_search",
  "crawl_page",
  "crawl_site",
  "analyze_image",
]);

const BROWSER_TOOLS = new Set([
  "open_browser",
  "close_browser",
  "browser_status",
]);

const OBSIDIAN_WRITE_TOOLS = new Set([
  "write_obsidian_note",
]);

const SLACK_TOOLS = new Set([
  "slack_post_message",
  "slack_read_messages",
  "slack_list_channels",
]);

const CHANNEL_TOOLS = new Set([
  "channels_list",
  "channel_send",
]);

const TRADING_TOOLS = new Set([
  "get_trading_lane_state",
  "set_trading_lane_mode",
  "create_trade_intent",
  "get_trade_intents",
  "get_trade_executions",
  "get_watchlist",
  "add_to_watchlist",
  "remove_from_watchlist",
  "get_signals",
  "create_signal",
  "update_signal_status",
  "get_positions",
  "open_position",
  "close_position",
  "update_position",
  "get_risk_state",
  "update_risk_state",
  "check_risk",
  "add_market_note",
  "get_market_notes",
  "save_journal_entry",
  "get_journal_entries",
  "add_todo",
  "get_todos",
  "complete_todo",
  "create_alert",
  "get_alerts",
  "trigger_alert",
  "get_trading_context",
]);

function union(...sets: Array<Set<string>>): Set<string> {
  const out = new Set<string>();
  for (const set of sets) {
    for (const item of set) out.add(item);
  }
  return out;
}

function baseProfile(taskType?: string): { name: string; tools: Set<string> } {
  switch (taskType as TaskType | undefined) {
    case "coding":
    case "worker_subtask":
      return {
        name: "coding",
        tools: union(STATUS_TOOLS, MEMORY_TOOLS, PROPOSAL_READ_TOOLS, CODE_TOOLS, new Set(["claim_work", "release_work", "post_progress"])),
      };
    case "code_review":
      return {
        name: "code_review",
        tools: union(STATUS_TOOLS, MEMORY_TOOLS, PROPOSAL_READ_TOOLS, CODE_TOOLS, new Set(["start_review", "post_progress"])),
      };
    case "analysis":
    case "expert":
      return {
        name: taskType ?? "analysis",
        tools: union(STATUS_TOOLS, MEMORY_TOOLS, PROPOSAL_READ_TOOLS, CODE_TOOLS, OPS_TOOLS),
      };
    case "research":
      return {
        name: "research",
        tools: union(MEMORY_TOOLS, RESEARCH_TOOLS),
      };
    case "long_context":
      return {
        name: "long_context",
        tools: union(STATUS_TOOLS, MEMORY_TOOLS, PROPOSAL_READ_TOOLS),
      };
    case "orchestrator":
      return {
        name: "orchestrator",
        tools: union(STATUS_TOOLS, MEMORY_TOOLS, PROPOSAL_READ_TOOLS, PROPOSAL_WRITE_TOOLS, COORDINATION_TOOLS, OPS_TOOLS, OBSIDIAN_WRITE_TOOLS),
      };
    case "classification":
    case "conversation":
    case "simple_qa":
    case "summarization":
    case "trivial":
    default:
      return { name: taskType ?? "unknown", tools: new Set() };
  }
}

function addHintedTools(profile: Set<string>, message: string | undefined): string[] {
  const text = message?.toLowerCase() ?? "";
  const hints: string[] = [];

  if (/\b(https?:\/\/|web|web\s*search|search\s+(?:the\s+)?web|search online|look up|latest|current|news|browse|crawl|weather|forecast|temperature|rain|raining|wind|humidity)\b/.test(text)) {
    for (const tool of RESEARCH_TOOLS) profile.add(tool);
    hints.push("research");
  }

  if (/\b(browser|screenshot|web page|frontend|ui|playwright|visual|canvas)\b/.test(text)) {
    for (const tool of BROWSER_TOOLS) profile.add(tool);
    hints.push("browser");
  }

  if (/\b(trading|trade|watchlist|position|risk|signal|ticker|market|journal|alert)\b/.test(text)) {
    for (const tool of TRADING_TOOLS) profile.add(tool);
    hints.push("trading");
  }

  if (/\b(slack|thread_ts)\b/.test(text)) {
    for (const tool of SLACK_TOOLS) profile.add(tool);
    hints.push("slack");
  }

  if (/\b(discord|telegram|ios|channel|recipient|send\s+(?:this\s+)?(?:to|through))\b/.test(text)) {
    for (const tool of CHANNEL_TOOLS) profile.add(tool);
    hints.push("channel");
  }

  if (/\b(obsidian|vault|note)\b/.test(text)) {
    for (const tool of OBSIDIAN_WRITE_TOOLS) profile.add(tool);
    hints.push("obsidian");
  }

  return hints;
}

function uniqueTools(tools: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tool of tools) {
    const trimmed = tool.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function resolveMcpToolProfile(params: {
  requestedTools: string[];
  taskType?: string;
  message?: string;
}): McpToolProfileDecision {
  const requestedTools = uniqueTools(params.requestedTools);
  if (process.env.NYXHIVE_MCP_PROFILE_MODE === "off") {
    return {
      profile: "disabled",
      requestedTools,
      exposedTools: requestedTools,
      droppedTools: [],
      estimatedSchemaTokens: requestedTools.length * MCP_TOOL_SCHEMA_ESTIMATE_TOKENS,
      estimatedSavedTokens: 0,
    };
  }

  const profile = baseProfile(params.taskType);
  const hints = addHintedTools(profile.tools, params.message);
  const allowed = new Set([...profile.tools].map((tool) => tool.toLowerCase()));
  const exposedTools = requestedTools.filter((tool) => allowed.has(tool.toLowerCase()));
  const exposed = new Set(exposedTools.map((tool) => tool.toLowerCase()));
  const droppedTools = requestedTools.filter((tool) => !exposed.has(tool.toLowerCase()));
  const profileName = hints.length > 0 ? `${profile.name}+${hints.join("+")}` : profile.name;

  return {
    profile: profileName,
    requestedTools,
    exposedTools,
    droppedTools,
    estimatedSchemaTokens: exposedTools.length * MCP_TOOL_SCHEMA_ESTIMATE_TOKENS,
    estimatedSavedTokens: droppedTools.length * MCP_TOOL_SCHEMA_ESTIMATE_TOKENS,
  };
}
