/**
 * Tool activity emoji formatting for channel progress messages.
 * Maps tool verbs (from formatToolActivity output) to display emojis.
 */

const VERB_EMOJI: Record<string, string> = {
  Reading: "📖",
  Writing: "✍️",
  Editing: "🔧",
  Running: "💻",
  Searching: "🔍",
  Fetching: "🌐",
  "Web search": "🔍",
  Subagent: "🧠",
  Updating: "📋",
};

/** Extract the leading verb from an activity string and return the matching emoji. */
export function toolActivityEmoji(activity: string): string {
  for (const [verb, emoji] of Object.entries(VERB_EMOJI)) {
    if (activity.startsWith(verb)) return emoji;
  }
  // MCP tools show as "mcp__instance__tool"
  if (activity.startsWith("mcp__") || activity.includes("__")) return "🔗";
  return "⚙️";
}

/** Format an activity string with its emoji prefix. */
export function formatToolLine(activity: string): string {
  return `${toolActivityEmoji(activity)} ${humanStatusFromActivity(activity)}`;
}

export function humanStatusFromActivity(activity: string | undefined): string {
  const normalized = activity?.trim().toLowerCase() ?? "";
  if (!normalized) return "Nyx is thinking...";
  if (normalized.includes("web") || normalized.includes("fetch") || normalized.includes("browse")) {
    return "Nyx is checking sources...";
  }
  if (
    normalized.startsWith("reading ")
    || normalized.includes("read ")
    || normalized.includes("search")
    || normalized.includes("grep")
    || normalized.includes("glob")
    || normalized.includes("inspect")
  ) {
    return "Nyx is checking context...";
  }
  if (normalized.includes("classif") || normalized.includes("think") || normalized.includes("reason") || normalized.includes("respond")) {
    return "Nyx is thinking...";
  }
  return "Nyx is working...";
}
