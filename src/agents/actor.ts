import type { ActorMention } from "../types.js";
import { logger } from "../utils/logger.js";
import { DELEGATION_CONTENT_WARN_CHARS } from "../defaults.js";

/** Action types recognised by lead/coordinator agents (shared between mention parsing and action parsing). */
const ACTION_TYPES = new Set<string>([
  "hire", "fire", "reassign", "team", "schedule", "unschedule",
  "alert", "develop", "dev-pause", "dev-resume", "dev-skip", "learn", "propose",
  "batch-approve", "batch-reject", "btw", "steer",
]);

interface CodeRange { start: number; end: number; }

/** Find all code fence (```) and inline code (`) ranges in text */
function getCodeRanges(text: string): CodeRange[] {
  const ranges: CodeRange[] = [];
  const fenceRegex = /```[\s\S]*?```/g;
  let match: RegExpExecArray | null = fenceRegex.exec(text);
  while (match !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
    match = fenceRegex.exec(text);
  }
  const inlineRegex = /`[^`]+`/g;
  match = inlineRegex.exec(text);
  while (match !== null) {
    const pos = match.index;
    if (!ranges.some(r => pos >= r.start && pos < r.end)) {
      ranges.push({ start: pos, end: pos + match[0].length });
    }
    match = inlineRegex.exec(text);
  }
  return ranges;
}

function isInsideCode(position: number, ranges: CodeRange[]): boolean {
  return ranges.some(r => position >= r.start && position < r.end);
}

/**
 * Parse [@agent: task] mentions from an agent's response.
 * Only matches agents that exist in the known agents set.
 * Returns the mentions and the cleaned response (mentions stripped).
 */
export function parseActorMentions(
  response: string,
  knownAgents: Set<string>,
): { mentions: ActorMention[]; unknownAgents: string[]; cleanedResponse: string } {
  const mentions: ActorMention[] = [];
  const unknownAgents: string[] = [];
  // Support [@agent: task], [@agent(hint): task], and [@instance.agent: task] syntax
  // Model hints let lead/coordinator agents control model selection: [@forge(light): task]
  const regex = /\[@([\w][\w.-]*)(?:\((\w+)\))?:\s*([^\]]+)\]/g;
  const codeRanges = getCodeRanges(response);

  let cleanedResponse = response;
  let match: RegExpExecArray | null = regex.exec(response);

  while (match !== null) {
    if (isInsideCode(match.index, codeRanges)) {
      match = regex.exec(response);
      continue;
    }
    const rawName = match[1].toLowerCase();
    const hint = match[2]?.toLowerCase();  // model hint (optional)
    const task = match[3].trim();

    // Split instance.agent if dot-qualified
    const dotIdx = rawName.indexOf(".");
    let instance: string | undefined;
    let agent: string;
    if (dotIdx > 0) {
      instance = rawName.slice(0, dotIdx);
      agent = rawName.slice(dotIdx + 1);
    } else {
      agent = rawName;
    }

    // Remote instance mentions are always valid (resolved at dispatch time)
    // Local mentions must match a known agent
    if (instance || knownAgents.has(agent)) {
      // "ralph" is a delegation mode, not a model hint
      const isRalphMode = hint === "ralph";
      mentions.push({
        agent,
        task,
        instance,
        modelHint: isRalphMode ? undefined : hint,
        mode: isRalphMode ? "ralph" : undefined,
        filePaths: extractFilePaths(task),
        verifyHints: extractVerificationHints(task),
      });
      if (hint && !isRalphMode) {
        logger.info(`[actor] Model hint for @${agent}: ${hint}`);
      }
      if (isRalphMode) {
        logger.info(`[actor] Ralph loop mode for @${agent}`);
      }
      if (task.length > DELEGATION_CONTENT_WARN_CHARS) {
        logger.warn(
          `[actor] Delegation to @${instance ? `${instance}.` : ""}${agent} has oversized task content (${task.length} chars, threshold ${DELEGATION_CONTENT_WARN_CHARS}). Consider using file references instead of inline content.`,
        );
      }
    } else {
      // Track unknown agents (skip action-type tags like hire/fire/etc.)
      if (!ACTION_TYPES.has(agent)) {
        unknownAgents.push(agent);
      }
    }
    match = regex.exec(response);
  }

  // Strip all matched mentions from the response (but preserve those inside code)
  if (mentions.length > 0) {
    const stripRegex = /\[@([\w][\w.-]*)(?:\(\w+\))?:\s*([^\]]+)\]/g;
    cleanedResponse = response.replace(stripRegex, (fullMatch, rawName, _task, offset) => {
      if (isInsideCode(offset, codeRanges)) return fullMatch;
      const rn = rawName.toLowerCase();
      const dotIdx = rn.indexOf(".");
      // Strip if it's an instance-qualified mention or a known local agent
      if (dotIdx > 0) return "";
      return knownAgents.has(rn) ? "" : fullMatch;
    });
    // Clean up extra whitespace left behind
    cleanedResponse = cleanedResponse.replace(/\n{3,}/g, "\n\n").trim();
  }

  return { mentions, unknownAgents, cleanedResponse };
}

// --- Management Action Tags ---

export type AgentActionType = "hire" | "fire" | "reassign" | "team" | "schedule" | "unschedule" | "alert" | "develop" | "dev-pause" | "dev-resume" | "dev-skip" | "learn" | "propose" | "batch-approve" | "batch-reject";

export interface AgentAction {
  type: AgentActionType;
  params: Record<string, string>;
  raw: string;
}

/**
 * Parse management action tags from a lead/coordinator response.
 * These are structurally distinct from [@agent: task] delegation tags.
 *
 * Supported:
 *   [@hire: key=<k> name="<n>" prompt="<p>"]
 *   [@hire: key=<k> name="<n>" provider=<p> model=<m> prompt="<p>"]
 *   [@fire: <key>]
 *   [@reassign: <key> model=<model>]
 *   [@reassign: <key> model=<model> provider=<provider>]
 *   [@team: <team_name> agents=<key1>,<key2>,<key3>]
 *   [@schedule: name="<n>" cron="<c>" agent=<a> prompt="<p>"]
 *   [@schedule: name="<n>" run_at=<ts> agent=<a> prompt="<p>"]
 *   [@unschedule: <name>]
 *   [@alert: message="<text>"]
 *   [@alert: channel=<ch> recipient=<id> message="<text>"]
 *   [@develop: feature="<desc>" agent=<key> branch=<branch>]
 *   [@dev-pause: <plan-id>]
 *   [@dev-resume: <plan-id>]
 *   [@dev-skip: <plan-id> story=<story-id>]
 *   [@learn: category="<cat>" content="<what was learned>"]
 *   [@learn: <what was learned>]  (category defaults to "learnings")
 *   [@propose: title="<title>" description="<desc>" category=<cat> effort=<effort> priority=<pri> files="<f1>,<f2>"]
 */
export function parseAgentActions(response: string): {
  actions: AgentAction[];
  cleanedResponse: string;
} {
  const actions: AgentAction[] = [];
  // Match [@type: content] where type is a known action (supports hyphenated types like batch-approve)
  // Allow nested [...] inside content (e.g. files=["a","b"]) by matching non-bracket chars OR balanced brackets
  const regex = /\[@([\w-]+):\s*((?:[^\[\]]+|\[[^\]]*\])+)\]/g;
  const codeRanges = getCodeRanges(response);
  let match: RegExpExecArray | null = regex.exec(response);

  // Actions that agents naturally format inside code blocks (structured output)
  const CODE_SAFE_ACTIONS = new Set(["propose", "learn"]);

  while (match !== null) {
    const type = match[1].toLowerCase();
    if (!ACTION_TYPES.has(type)) {
      match = regex.exec(response);
      continue;
    }
    // Skip actions inside code blocks — EXCEPT propose/learn which agents commonly wrap in fences
    if (!CODE_SAFE_ACTIONS.has(type) && isInsideCode(match.index, codeRanges)) {
      match = regex.exec(response);
      continue;
    }

    const raw = match[0];
    const content = match[2].trim();
    const params = parseActionParams(type, content);

    actions.push({ type: type as AgentActionType, params, raw });
    match = regex.exec(response);
  }

  // Second pass: multi-line [@propose:] blocks (including inside code fences).
  // Agents naturally wrap structured output in code blocks, so we parse those too.
  // Format:
  //   [@propose:]
  //   key: value
  //   key: value
  //   (terminated by blank line, ---, ###, ```, or another [@)
  const multilineRegex = /\[@propose:\]\s*\n((?:[\w_]+:\s*[^\n]+\n?)+)/g;
  let mlMatch: RegExpExecArray | null = multilineRegex.exec(response);

  while (mlMatch !== null) {
    const block = mlMatch[1];
    const params: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const kvMatch = line.match(/^(\w[\w_]*):\s*(.+)/);
      if (kvMatch) {
        params[kvMatch[1]] = kvMatch[2].trim();
      }
    }
    // Map common field names to expected params
    if (params.scout_source) {
      params.source = params.scout_source;
      delete params.scout_source;
    }
    // Only add if we got at least a description (title can be derived from first sentence)
    if (params.description || params.title) {
      actions.push({ type: "propose", params, raw: mlMatch[0] });
    }
    mlMatch = multilineRegex.exec(response);
  }

  // Strip action tags from the response
  let cleanedResponse = response;
  if (actions.length > 0) {
    for (const action of actions) {
      cleanedResponse = cleanedResponse.replace(action.raw, "");
    }
    cleanedResponse = cleanedResponse.replace(/\n{3,}/g, "\n\n").trim();
  }

  return { actions, cleanedResponse };
}

/**
 * Parse key=value and key="quoted value" parameters from action content.
 * Special handling per action type for simpler forms.
 */
function parseActionParams(type: string, content: string): Record<string, string> {
  const params: Record<string, string> = {};

  // Simple forms: [@fire: key], [@unschedule: name], [@dev-pause: id], [@dev-resume: id], [@learn: text]
  if (type === "learn") {
    // [@learn: category="<cat>" <content>] or [@learn: <content>]
    const catMatch = content.match(/^category="([^"]*)"\s*(.*)/s);
    if (catMatch) {
      params.category = catMatch[1];
      params.content = catMatch[2].trim();
    } else {
      // Check for content="..." form
      const contentMatch = content.match(/content="([^"]*)"/);
      if (contentMatch) {
        params.content = contentMatch[1];
        // Extract category if present
        const catKv = content.match(/category="([^"]*)"/);
        if (catKv) params.category = catKv[1];
      } else {
        params.content = content.trim();
      }
    }
    return params;
  }

  if (type === "fire" || type === "unschedule" || type === "dev-pause" || type === "dev-resume") {
    // Check for id=<value> form
    if (content.startsWith("id=")) {
      params.id = content.slice(3).trim();
    } else {
      params.key = content.trim();
    }
    return params;
  }

  // Extract quoted values first (key="value with spaces")
  const quotedRegex = /(\w+)="([^"]*)"/g;
  let quotedMatch: RegExpExecArray | null = quotedRegex.exec(content);
  let remaining = content;

  while (quotedMatch !== null) {
    params[quotedMatch[1]] = quotedMatch[2];
    remaining = remaining.replace(quotedMatch[0], "");
    quotedMatch = quotedRegex.exec(content);
  }

  // Extract unquoted key=value pairs
  const unquotedRegex = /(\w+)=(\S+)/g;
  let unquotedMatch: RegExpExecArray | null = unquotedRegex.exec(remaining);

  while (unquotedMatch !== null) {
    if (!params[unquotedMatch[1]]) {
      params[unquotedMatch[1]] = unquotedMatch[2];
    }
    unquotedMatch = unquotedRegex.exec(remaining);
  }

  // For [@reassign: key model=...], the first word is the key
  if (type === "reassign" && !params.key) {
    const firstWord = content.match(/^(\w+)\s/);
    if (firstWord) params.key = firstWord[1];
  }

  // For [@team: name agents=...], the first word is the team name
  if (type === "team" && !params.name) {
    const firstWord = content.match(/^(\w+)\s/);
    if (firstWord) params.name = firstWord[1];
  }

  // For [@propose: free text] — if no key=value pairs found, treat content as description
  if (type === "propose" && !params.description && !params.title) {
    params.description = content.trim();
  }

  // Map scout_source -> source (consistent with multiline parser)
  if (type === "propose" && params.scout_source) {
    params.source = params.scout_source;
    delete params.scout_source;
  }

  return params;
}

// --- Followup Tag Parsing ---

export interface FollowupTag {
  task: string;
  agent?: string;
}

/**
 * Parse [@followup: task] and [@followup agent: task] tags from an agent's response.
 * These queue new messages for the originating agent (or a specified one).
 *
 * Supported:
 *   [@followup: investigate the flaky test]          — followup for originating agent
 *   [@followup analyst: research the API changes]    — followup for specific agent
 */
export function parseFollowups(response: string): {
  followups: FollowupTag[];
  cleanedResponse: string;
} {
  const followups: FollowupTag[] = [];
  const codeRanges = getCodeRanges(response);
  const regex = /\[@followup(?:\s+(\w+))?:\s*([^\]]+)\]/gi;
  let match: RegExpExecArray | null = regex.exec(response);

  while (match !== null) {
    if (isInsideCode(match.index, codeRanges)) {
      match = regex.exec(response);
      continue;
    }
    const agentName = match[1]?.toLowerCase();
    const task = match[2].trim();
    if (!task) {
      match = regex.exec(response);
      continue;
    }
    followups.push({ task, agent: agentName || undefined });
    match = regex.exec(response);
  }

  // Strip followup tags from the response
  let cleanedResponse = response;
  if (followups.length > 0) {
    cleanedResponse = response.replace(
      /\[@followup(?:\s+\w+)?:\s*[^\]]+\]/gi,
      (fullMatch, offset) => {
        if (isInsideCode(offset, codeRanges)) return fullMatch;
        return "";
      },
    );
    cleanedResponse = cleanedResponse.replace(/\n{3,}/g, "\n\n").trim();
  }

  return { followups, cleanedResponse };
}

// --- BTW & Steer Tag Parsing ---

export interface BtwTag {
  agent: string;
  content: string;
}

export interface SteerTag {
  agent: string;
  content: string;
}

/**
 * Parse [@btw agent: question] tags from an agent's response.
 * These are ephemeral side queries — the answer is NOT injected into the response.
 *
 * Supported:
 *   [@btw forge: what file handles retries?]
 *   [@btw analyst: is the memory store initialized?]
 */
export function parseBtwTags(response: string): {
  btws: BtwTag[];
  cleanedResponse: string;
} {
  const btws: BtwTag[] = [];
  const codeRanges = getCodeRanges(response);
  const regex = /\[@btw\s+(\w[\w.-]*):\s*([^\]]+)\]/gi;
  let match: RegExpExecArray | null = regex.exec(response);

  while (match !== null) {
    if (isInsideCode(match.index, codeRanges)) {
      match = regex.exec(response);
      continue;
    }
    const agent = match[1].toLowerCase();
    const content = match[2].trim();
    if (!content) {
      match = regex.exec(response);
      continue;
    }
    btws.push({ agent, content });
    match = regex.exec(response);
  }

  let cleanedResponse = response;
  if (btws.length > 0) {
    cleanedResponse = response.replace(
      /\[@btw\s+\w[\w.-]*:\s*[^\]]+\]/gi,
      (fullMatch, offset) => {
        if (isInsideCode(offset, codeRanges)) return fullMatch;
        return "";
      },
    );
    cleanedResponse = cleanedResponse.replace(/\n{3,}/g, "\n\n").trim();
  }

  return { btws, cleanedResponse };
}

/**
 * Parse [@steer agent: message] tags from an agent's response.
 * These inject mid-task context into a running agent's conversation.
 *
 * Supported:
 *   [@steer forge: focus on the error handling path first]
 *   [@steer tester: skip flaky integration tests for now]
 */
export function parseSteerTags(response: string): {
  steers: SteerTag[];
  cleanedResponse: string;
} {
  const steers: SteerTag[] = [];
  const codeRanges = getCodeRanges(response);
  const regex = /\[@steer\s+(\w[\w.-]*):\s*([^\]]+)\]/gi;
  let match: RegExpExecArray | null = regex.exec(response);

  while (match !== null) {
    if (isInsideCode(match.index, codeRanges)) {
      match = regex.exec(response);
      continue;
    }
    const agent = match[1].toLowerCase();
    const content = match[2].trim();
    if (!content) {
      match = regex.exec(response);
      continue;
    }
    steers.push({ agent, content });
    match = regex.exec(response);
  }

  let cleanedResponse = response;
  if (steers.length > 0) {
    cleanedResponse = response.replace(
      /\[@steer\s+\w[\w.-]*:\s*[^\]]+\]/gi,
      (fullMatch, offset) => {
        if (isInsideCode(offset, codeRanges)) return fullMatch;
        return "";
      },
    );
    cleanedResponse = cleanedResponse.replace(/\n{3,}/g, "\n\n").trim();
  }

  return { steers, cleanedResponse };
}

// --- Delegation Enrichment ---

/** Extract file paths from delegation text */
export function extractFilePaths(text: string): string[] {
  const pathRegex = /(?:^|\s|["'`(])(((?:\/[\w.-]+)+(?:\/[\w.-]+\.\w+)?|(?:\.\/|src\/|lib\/|test\/)[\w./-]+))/g;
  const paths = new Set<string>();
  let match: RegExpExecArray | null = pathRegex.exec(text);
  while (match !== null) {
    // Strip trailing sentence punctuation that the greedy [\w./-]+ may consume
    const p = match[1].trim().replace(/\.+$/, "");
    if (p.length > 4 && /\.\w{1,5}$/.test(p)) {
      paths.add(p);
    }
    match = pathRegex.exec(text);
  }
  return [...paths];
}

/** Extract verification triggers from delegation text */
export function extractVerificationHints(text: string): string[] {
  const hints: string[] = [];
  const patterns = [
    /(?:make sure|ensure|verify|check that|confirm)\s+(.{10,80}?)(?:\.|$)/gi,
    /(?:tests?\s+(?:should\s+)?(?:still\s+)?pass)/gi,
    /(?:build[s]?\s+(?:should\s+)?(?:still\s+)?(?:clean|succeed|pass))/gi,
    /(?:no\s+type\s+errors?)/gi,
  ];
  for (const pat of patterns) {
    let m: RegExpExecArray | null = pat.exec(text);
    while (m !== null) {
      hints.push(m[0].trim());
      m = pat.exec(text);
    }
  }
  return [...new Set(hints)];
}
