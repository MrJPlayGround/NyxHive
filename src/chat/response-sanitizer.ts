const WORKFLOW_LEAK_OPENING = /^\s*Using\s+`?(?:superpowers:|[^.\n]{0,160}\b(?:using-superpowers|test-driven-development|systematic-debugging|verification-before-completion|writing-plans|brainstorming))/i;
const WORKFLOW_PROGRESS_OPENING = /^\s*(?:Using\s+`?(?:superpowers:|[^.\n]{0,160}\b(?:using-superpowers|test-driven-development|systematic-debugging|verification-before-completion|writing-plans|brainstorming))|I(?:'|’| a)m\s+(?:starting|checking|locating|reading|running|adding|making|moving|rerunning|backfilling|committing|pushing|drilling|treating|skipping|opening|looking|inspecting|verifying|patching|testing|fixing)\b|I(?:'ll|’ll| will)\s+(?:start|check|locate|read|run|add|make|move|rerun|backfill|commit|push|drill|treat|skip|open|inspect|verify|patch|test|fix)\b|The\s+(?:narrow|targeted|full|live|regression|failing)\b.*\b(?:tests?|logs?|coverage|suite|checks?)\b|Verification is clean\b|Implementation is now wired\b)/i;
const RUN_CONTEXT_PREFIX = /^\s*(?:\[Current Message\]\s*)?\[Run Context\]\s*Run ID:[^\n]*\nScratchpad:[^\n]*(?:\nUse the scratchpad[^\n]*)?\n*/i;
const CLOSEOUT_MARKER_PATTERN = /\b(?:Done\.|Yeah\.|Good,|Mostly yes\.|No\.|Added [^.]{1,120}\.|Stability sweep found|Found issue:|Root cause:|I found\b|Core checks\b|Fixed:|Fixed [^.]{1,120}\.|Implemented [^.]{1,120}\.|Updated [^.]{1,120}\.|Changed [^.]{1,120}\.|What changed:|Evidence:|Outcome:|Caveat:|Blocked:)/i;
const CLOSEOUT_HEADING_PATTERN = /(What changed:|Evidence:|Git:|Outcome:|Caveat:|Verification:|Changed:|Fixed:|Root cause:|Blockers?:)/g;
const SUBSTANTIVE_WORKFLOW_RESPONSE_MIN_CHARS = 180;

function hasSubstantiveBody(candidate: string): boolean {
  const nonEmptyLines = candidate.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  return candidate.trim().length >= SUBSTANTIVE_WORKFLOW_RESPONSE_MIN_CHARS && nonEmptyLines.length >= 2;
}

function stripOpeningProgress(candidate: string): string {
  const trimmed = candidate.trimStart();
  const paragraphBreak = trimmed.search(/\n\s*\n/);
  if (paragraphBreak > 0) {
    const firstParagraph = trimmed.slice(0, paragraphBreak);
    const rest = trimmed.slice(paragraphBreak).trim();
    if (WORKFLOW_PROGRESS_OPENING.test(firstParagraph) && rest.length >= 60) {
      return rest;
    }
  }

  const firstSentenceEnd = trimmed.search(/\.(?=\s+[A-Z]|\n|[A-Z]|$)/);
  if (firstSentenceEnd > 0) {
    const firstSentence = trimmed.slice(0, firstSentenceEnd + 1);
    const rest = trimmed.slice(firstSentenceEnd + 1).trim();
    if (WORKFLOW_PROGRESS_OPENING.test(firstSentence) && rest.length >= 60) {
      return rest;
    }
  }

  return candidate.trim();
}

export function stripWorkflowLeak(response: string): string {
  let candidate = response;
  const prefix = RUN_CONTEXT_PREFIX.exec(candidate);
  if (prefix) candidate = candidate.slice(prefix[0].length);

  if (!WORKFLOW_LEAK_OPENING.test(candidate) && !WORKFLOW_PROGRESS_OPENING.test(candidate)) {
    return prefix ? candidate.trim() : response;
  }

  const match = CLOSEOUT_MARKER_PATTERN.exec(candidate);
  if (!match || match.index <= 0) {
    const withoutOpening = stripOpeningProgress(candidate);
    if (withoutOpening !== candidate.trim()) return withoutOpening;
    return hasSubstantiveBody(candidate) ? candidate.trim() : "";
  }

  return candidate
    .slice(match.index)
    .replace(CLOSEOUT_HEADING_PATTERN, "\n\n$1")
    .replace(/:(?=-|\d+\.)/g, ":\n")
    .replace(/([^\n])(?=- `)/g, "$1\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sanitizeAssistantResponse(text: string): string {
  return stripWorkflowLeak(text)
    .replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<invoke[\s\S]*?<\/invoke>/g, "")
    .replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
