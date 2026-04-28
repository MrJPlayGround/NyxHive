const WORKFLOW_OPENING =
  /^\s*(?:Using\s+`?(?:superpowers:|[^.\n]{0,180}\b(?:using-superpowers|test-driven-development|systematic-debugging|verification-before-completion|writing-plans|brainstorming))|I(?:'|’)?m\s+(?:starting|checking|locating|reading|running|adding|making|moving|rerunning|backfilling|committing|pushing|drilling|treating|skipping|opening|looking|inspecting|verifying|patching|testing|fixing)\b|I(?:'|’)?ll\s+(?:start|check|locate|read|run|add|make|move|rerun|backfill|commit|push|drill|treat|skip|open|inspect|verify|patch|test|fix)\b|The\s+(?:narrow|targeted|full|live|regression|failing)\b.*\b(?:tests?|logs?|coverage|suite|checks?)\b|Verification is clean\b|Implementation is now wired\b)/i

const RUN_CONTEXT_PREFIX =
  /^\s*(?:\[Current Message\]\s*)?\[Run Context\]\s*Run ID:[^\n]*\nScratchpad:[^\n]*(?:\nUse the scratchpad[^\n]*)?\n*/i

const CLOSEOUT_MARKER =
  /\b(?:Done\.|Yeah\.|Good,|Mostly yes\.|No\.|Added [^.]{1,120}\.|Stability sweep found|Found issue:|Root cause:|I found\b|Core checks\b|Fixed:|Fixed [^.]{1,120}\.|Implemented [^.]{1,120}\.|Updated [^.]{1,120}\.|Changed [^.]{1,120}\.|What changed:|Evidence:|Outcome:|Caveat:|Blocked:)/i

const CLOSEOUT_HEADING =
  /(What changed:|Evidence:|Git:|Outcome:|Caveat:|Verification:|Changed:|Fixed:|Root cause:|Blockers?:)/g

export function sanitizeAssistantResponse(text: string): string {
  let result = text
    .replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<invoke[\s\S]*?<\/invoke>/g, '')
    .replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/g, '')
    .trim()

  const prefix = RUN_CONTEXT_PREFIX.exec(result)
  if (prefix) result = result.slice(prefix[0].length).trim()

  if (WORKFLOW_OPENING.test(result)) {
    const match = CLOSEOUT_MARKER.exec(result)
    result = match && match.index > 0 ? result.slice(match.index) : ''
  }

  return result
    .replace(CLOSEOUT_HEADING, '\n\n$1')
    .replace(/:(?=-|\d+\.)/g, ':\n')
    .replace(/([^\n])(?=- `)/g, '$1\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
