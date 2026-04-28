import { createHash } from "node:crypto";
import type { ProceduralSkillDraft, ProceduralSkillDraftStore } from "../memory/procedural-skills.js";
import { compileProceduralSkillDigest, type CompiledKnowledgeStore } from "../memory/compiled-knowledge.js";

export interface ProceduralSkillExtractionInput {
  agentKey: string;
  channel: string;
  sender: string;
  conversationId: string;
  traceId?: string | null;
  userMessage: string;
  assistantResponse: string;
}

const MAX_TITLE_LENGTH = 88;
const MAX_SUMMARY_LENGTH = 180;
const MAX_EXCERPT_LENGTH = 500;
const MIN_USER_LENGTH = 40;
const MIN_ASSISTANT_LENGTH = 160;
const MIN_COMBINED_LENGTH = 280;

const WORKFLOW_VERB_PATTERN = /\b(fix|debug|stabiliz(?:e|ing)|investigat(?:e|ing)|verify|test|refactor|deploy|launch|restart|repair|migrate|implement|build|wire|clean(?:up)?|review|audit|ssh|pull|push)\b/i;
const LIST_PATTERN = /(^|\n)\s*(?:[-*]|\d+\.)\s+/;
const VERIFICATION_PATTERN = /\b(test|verify|verified|verification|build|typecheck|passed|green|smoke(?:\s|-)?test|health)\b/i;
const COMMAND_PATTERN = /(`[^`]+`|\bbun(?:x)?\s+\S+|\bgit\s+\S+|\bssh\s+\S+|\bcurl\s+\S+|\bnpm\s+\S+|\bpnpm\s+\S+|\byarn\s+\S+)/i;
const FILE_PATH_PATTERN = /\b(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9]+\b/g;
const DECISION_PATTERN = /\b(decid(?:e|es|ing)|decision|choose|triage|classif(?:y|ies|ication)|approval|approve|reject|escalat(?:e|ion)|when to|when not to|before (?:changing|claiming|promoting|publishing|merging|restarting)|first check|if .* then|otherwise|fallback|gate|boundary|policy|risk|safe to|not safe to|root cause before|repeatable decision)\b/i;
const ONE_OFF_PATTERN = /\b(this incident|this one|one[- ]off|single run|current failure|specific to this|not reusable|investigation only|root-cause investigation only|for this thread|in this conversation)\b/i;
const UNPROVEN_PATTERN = /\b(no code changes(?: made)?|not implemented|has not been implemented|hasn't been implemented|not yet implemented|still need(?:s)? to|would need to|should add|plan only|design only|handoff|proposal only|before guessing|needs a restart before|not verified|unverified)\b/i;
const PROVEN_OUTCOME_PATTERN = /\b(done|completed|fixed|implemented|patched|updated|changed|added|wired|deployed|restarted|pushed|merged|resolved|confirmed|working path|root cause (?:was|is)|verified|passed|passes|green|build(?:s)? clean)\b/i;
const SKILL_INTENT_PATTERN = /\b(skill|procedural memory|repeatable decision|reusable workflow|workflow draft|auto[- ]skill)\b/i;
const DECISION_SHAPE_PATTERN = /\b(when to|when not to|if .* then|otherwise|fallback|decision boundary|before (?:changing|claiming|promoting|publishing|merging|restarting)|safe to|not safe to|escalate|approve|reject)\b/i;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function cleanSentence(value: string): string {
  return normalizeWhitespace(value.replace(/^[-*\d.\s]+/, "").replace(/[`#>*_]/g, ""));
}

function summarizeAssistantResponse(response: string): string {
  const sentences = response
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map(cleanSentence)
    .filter(Boolean);
  return truncate(sentences[0] ?? cleanSentence(response), MAX_SUMMARY_LENGTH);
}

function deriveTitle(userMessage: string): string {
  const normalized = normalizeWhitespace(
    userMessage
      .replace(/^(?:please|can you|could you|i want you to|need to|let's|lets)\s+/i, "")
      .replace(/[.?!]+$/g, ""),
  );
  if (!normalized) return "Workflow candidate";
  const base = truncate(normalized, MAX_TITLE_LENGTH);
  return base.toLowerCase().startsWith("workflow:")
    ? base
    : `Workflow: ${base}`;
}

function extractFilePaths(text: string): string[] {
  const matches = text.match(FILE_PATH_PATTERN) ?? [];
  return [...new Set(matches)].slice(0, 8);
}

function extractCommands(text: string): string[] {
  const commands = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => COMMAND_PATTERN.test(line))
    .map((line) => truncate(line.replace(/^[-*]\s*/, ""), 120));
  return [...new Set(commands)].slice(0, 6);
}

function deriveProcedureSteps(text: string): string[] {
  const explicitSteps = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => LIST_PATTERN.test(line))
    .map(cleanSentence)
    .filter((line) => line.length >= 18);
  if (explicitSteps.length > 0) {
    return [...new Set(explicitSteps)].slice(0, 7);
  }

  const sentenceSteps = text
    .split(/(?<=[.!?])\s+/)
    .map(cleanSentence)
    .filter((line) => line.length >= 24)
    .filter((line) => WORKFLOW_VERB_PATTERN.test(line) || VERIFICATION_PATTERN.test(line));
  return [...new Set(sentenceSteps)].slice(0, 6);
}

function deriveVerificationNotes(text: string): string[] {
  return text
    .split("\n")
    .map((line) => cleanSentence(line))
    .filter((line) => line.length >= 12)
    .filter((line) => VERIFICATION_PATTERN.test(line))
    .slice(0, 5);
}

function deriveExtractionSignals(input: ProceduralSkillExtractionInput, assistantResponse: string): string[] {
  const combined = `${input.userMessage}\n${assistantResponse}`;
  const signals: string[] = [];

  if (WORKFLOW_VERB_PATTERN.test(input.userMessage)) signals.push("workflow request");
  if (LIST_PATTERN.test(assistantResponse)) signals.push("explicit procedure steps");
  if (VERIFICATION_PATTERN.test(assistantResponse)) signals.push("verification evidence");
  if (COMMAND_PATTERN.test(combined)) signals.push("command evidence");
  if (extractFilePaths(combined).length > 0) signals.push("file references");
  if (DECISION_PATTERN.test(combined)) signals.push("decision boundary");

  return signals;
}

function shouldSkipForOrigin(input: ProceduralSkillExtractionInput): boolean {
  const sender = input.sender.trim().toLowerCase();
  if (input.channel === "system") return true;
  if (sender === "system") return true;
  if (sender.startsWith("scheduler:")) return true;
  if (sender.startsWith("proposal-")) return true;
  if (sender.startsWith("proposal-exec:")) return true;
  return false;
}

function hasEnoughReusableSignal(input: ProceduralSkillExtractionInput): boolean {
  const combined = `${input.userMessage}\n${input.assistantResponse}`;
  let score = 0;

  if (ONE_OFF_PATTERN.test(combined)) return false;
  if (UNPROVEN_PATTERN.test(input.assistantResponse)) return false;
  if (!DECISION_PATTERN.test(combined)) return false;
  if (!DECISION_SHAPE_PATTERN.test(combined)) return false;
  if (!PROVEN_OUTCOME_PATTERN.test(combined) || !VERIFICATION_PATTERN.test(input.assistantResponse)) return false;

  if (WORKFLOW_VERB_PATTERN.test(input.userMessage)) score += 1;
  if (SKILL_INTENT_PATTERN.test(combined)) score += 1;
  if (LIST_PATTERN.test(input.assistantResponse)) score += 1;
  if (VERIFICATION_PATTERN.test(input.assistantResponse)) score += 1;
  if (COMMAND_PATTERN.test(combined)) score += 1;
  if (extractFilePaths(combined).length > 0) score += 1;
  if (DECISION_PATTERN.test(combined)) score += 2;
  if (DECISION_SHAPE_PATTERN.test(combined)) score += 2;
  if (PROVEN_OUTCOME_PATTERN.test(combined)) score += 1;

  return score >= 8;
}

export function shouldCreateProceduralSkillDraft(input: ProceduralSkillExtractionInput): boolean {
  const userMessage = normalizeWhitespace(input.userMessage);
  const assistantResponse = normalizeWhitespace(input.assistantResponse);
  if (shouldSkipForOrigin(input)) return false;
  if (userMessage.length < MIN_USER_LENGTH) return false;
  if (assistantResponse.length < MIN_ASSISTANT_LENGTH) return false;
  if (userMessage.length + assistantResponse.length < MIN_COMBINED_LENGTH) return false;
  return hasEnoughReusableSignal({ ...input, userMessage, assistantResponse });
}

export function buildProceduralSkillDraftInput(input: ProceduralSkillExtractionInput): {
  sourceHash: string;
  agentKey: string;
  conversationId: string;
  traceId?: string | null;
  title: string;
  summary: string;
  draftMarkdown: string;
} | null {
  if (!shouldCreateProceduralSkillDraft(input)) return null;

  const normalizedUserMessage = normalizeWhitespace(input.userMessage);
  const normalizedAssistantResponse = normalizeWhitespace(input.assistantResponse);
  const filePaths = extractFilePaths(`${input.userMessage}\n${input.assistantResponse}`);
  const commands = extractCommands(input.assistantResponse);
  const procedureSteps = deriveProcedureSteps(input.assistantResponse);
  const verificationNotes = deriveVerificationNotes(input.assistantResponse);
  const extractionSignals = deriveExtractionSignals(input, normalizedAssistantResponse);
  const title = deriveTitle(normalizedUserMessage);
  const summary = summarizeAssistantResponse(normalizedAssistantResponse);
  const sourceHash = createHash("sha256")
    .update([
      input.agentKey,
      input.conversationId,
      normalizedUserMessage,
      normalizedAssistantResponse,
    ].join("\n---\n"))
    .digest("hex");

  const lines = [
    `# ${title}`,
    "",
    "## Status",
    "Draft candidate extracted automatically from a successful run. Publish only if it replaces a repeatable decision, not merely a repeatable task.",
    "",
    "## When to use",
    `- ${summary}`,
    `- Agent: ${input.agentKey}`,
    `- Conversation: ${input.conversationId}`,
  ];

  if (filePaths.length > 0) {
    lines.push(`- Common files: ${filePaths.join(", ")}`);
  }

  lines.push("", "## Extraction evidence");
  lines.push(`- Trigger signals: ${extractionSignals.join(", ") || "heuristic match"}`);
  lines.push("- Promotion gate: must encode a reusable decision boundary, when-not-to-use guidance, and verification evidence.");
  lines.push(`- Source hash: ${sourceHash.slice(0, 12)}`);
  if (input.traceId) {
    lines.push(`- Source trace: ${input.traceId}`);
  }
  if (commands.length > 0) {
    lines.push(`- Captured commands: ${commands.length}`);
  }
  if (filePaths.length > 0) {
    lines.push(`- Captured file refs: ${filePaths.length}`);
  }

  lines.push("", "## User ask", truncate(normalizedUserMessage, MAX_EXCERPT_LENGTH));

  if (procedureSteps.length > 0) {
    lines.push("", "## Candidate procedure");
    for (const step of procedureSteps) {
      lines.push(`1. ${step}`);
    }
  }

  lines.push(
    "",
    "## Promotion checklist",
    "- Replaces a repeatable decision, not just a repeatable task.",
    "- Captures a proven path from a completed, verified run.",
    "- States when to use, when not to use, and what evidence changes the decision.",
    "- Avoids one-off incident details that will not transfer to the next run.",
    "",
    "## Decision boundary",
    "- Before publishing, rewrite this section to state the decision this skill replaces and the evidence that resolves it.",
    "",
    "## When not to use",
    "- Do not use this skill for one-off incidents unless the same decision boundary recurs.",
  );

  if (commands.length > 0) {
    lines.push("", "## Common commands");
    for (const command of commands) {
      lines.push(`- ${command}`);
    }
  }

  if (verificationNotes.length > 0) {
    lines.push("", "## Verification notes");
    for (const note of verificationNotes) {
      lines.push(`- ${note}`);
    }
  }

  lines.push("", "## Source response excerpt", truncate(normalizedAssistantResponse, MAX_EXCERPT_LENGTH));

  return {
    sourceHash,
    agentKey: input.agentKey,
    conversationId: input.conversationId,
    traceId: input.traceId ?? null,
    title,
    summary,
    draftMarkdown: lines.join("\n"),
  };
}

export function recordProceduralSkillDraftIfQualified(
  store: ProceduralSkillDraftStore,
  input: ProceduralSkillExtractionInput,
  options?: { compiledKnowledge?: CompiledKnowledgeStore },
): ProceduralSkillDraft | null {
  const draft = buildProceduralSkillDraftInput(input);
  if (!draft) return null;

  const created = store.create({
    sourceHash: draft.sourceHash,
    agentKey: draft.agentKey,
    conversationId: draft.conversationId,
    traceId: draft.traceId,
    title: draft.title,
    summary: draft.summary,
    draftMarkdown: draft.draftMarkdown,
  });
  options?.compiledKnowledge?.upsert(compileProceduralSkillDigest(created));
  return created;
}
