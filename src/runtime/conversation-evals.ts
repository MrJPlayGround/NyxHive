import type { RuntimeMode } from "./mode.js";

export interface ConversationEvalCase {
  id: string;
  prompt: string;
  expectedMode: RuntimeMode;
  expectedQualities: string[];
  risk: "low" | "medium" | "high";
}

export const CONVERSATION_EVAL_SET: ConversationEvalCase[] = [
  { id: "casual-alive", prompt: "you alive?", expectedMode: "conversation", risk: "low", expectedQualities: ["brief", "natural", "no workflow narration"] },
  { id: "casual-annoyed", prompt: "that's annoying", expectedMode: "conversation", risk: "low", expectedQualities: ["empathetic", "human", "no checklist"] },
  { id: "casual-interesting", prompt: "huh, interesting", expectedMode: "conversation", risk: "low", expectedQualities: ["present", "light", "no routing explanation"] },
  { id: "opinion-general", prompt: "what do you think?", expectedMode: "conversation", risk: "medium", expectedQualities: ["direct opinion", "keeps prior tone", "does not invent action"] },
  { id: "reflective-architecture", prompt: "is this architecture too brittle?", expectedMode: "hybrid", risk: "medium", expectedQualities: ["substantive answer", "no execution workflow", "clear judgment"] },
  { id: "reflective-voice", prompt: "why does the voice feel flatter after long sessions?", expectedMode: "hybrid", risk: "medium", expectedQualities: ["diagnostic", "conversational", "no tool preamble"] },
  { id: "followup-action", prompt: "do it", expectedMode: "agentic", risk: "high", expectedQualities: ["inherits action context", "executes when prior task was action", "no re-intake"] },
  { id: "followup-same", prompt: "same for the webhook path", expectedMode: "agentic", risk: "high", expectedQualities: ["inherits prior implementation context", "stays specific", "does not ask needless questions"] },
  { id: "followup-reflective", prompt: "what do you think?", expectedMode: "conversation", risk: "high", expectedQualities: ["does not inherit coding posture", "answers directly", "keeps tone"] },
  { id: "status-check", prompt: "where are we?", expectedMode: "conversation", risk: "medium", expectedQualities: ["compact status", "no re-delegation", "no work diary"] },
  { id: "file-conversational", prompt: "That src/queue/processor.ts path still feels like the heart of the thing", expectedMode: "hybrid", risk: "high", expectedQualities: ["discusses concept", "does not edit files", "does not over-escalate"] },
  { id: "file-action", prompt: "fix src/queue/processor.ts so this stops happening", expectedMode: "agentic", risk: "high", expectedQualities: ["reads code", "implements", "verifies"] },
  { id: "advice-product", prompt: "how should we think about the workspace waiting state?", expectedMode: "hybrid", risk: "medium", expectedQualities: ["opinionated", "product-aware", "not a plan unless asked"] },
  { id: "vent-deadline", prompt: "I hate that this still feels like a terminal pretending to be chat", expectedMode: "conversation", risk: "medium", expectedQualities: ["acknowledges frustration", "specific", "not defensive"] },
  { id: "quick-qa", prompt: "what does hybrid mode mean here?", expectedMode: "conversation", risk: "low", expectedQualities: ["plain answer", "short", "no internal digression"] },
  { id: "implementation-request", prompt: "add tests for the new runtime mode behavior", expectedMode: "agentic", risk: "medium", expectedQualities: ["acts", "runs tests", "reports evidence"] },
  { id: "research-request", prompt: "look up the latest OpenAI model docs before changing that", expectedMode: "agentic", risk: "high", expectedQualities: ["uses current evidence", "cites sources", "does not guess"] },
  { id: "summarize-local", prompt: "summarize what we decided", expectedMode: "conversation", risk: "medium", expectedQualities: ["uses recent context", "concise", "no tooling unless needed"] },
  { id: "deep-compare", prompt: "compare this to how we handled the proposal pipeline", expectedMode: "hybrid", risk: "medium", expectedQualities: ["connects prior pattern", "clear tradeoffs", "no action posture"] },
  { id: "code-review", prompt: "review the diff for regressions", expectedMode: "agentic", risk: "high", expectedQualities: ["review stance", "findings first", "file references"] },
  { id: "tiny-social", prompt: "lol", expectedMode: "conversation", risk: "low", expectedQualities: ["matches energy", "brief", "no structure"] },
  { id: "ambiguous-cleanup", prompt: "clean this up", expectedMode: "agentic", risk: "high", expectedQualities: ["uses context", "does not flatten to chat", "verifies"] },
  { id: "strategic-cleanup", prompt: "do you think this cleanup is worth doing now?", expectedMode: "hybrid", risk: "high", expectedQualities: ["advice not execution", "names tradeoff", "does not edit"] },
  { id: "memory-natural", prompt: "does that match what I usually prefer?", expectedMode: "conversation", risk: "high", expectedQualities: ["uses durable preference if relevant", "admits uncertainty", "no creepy recall"] },
  { id: "memory-action", prompt: "use what you remember and update the docs", expectedMode: "agentic", risk: "high", expectedQualities: ["uses memory carefully", "edits docs", "verifies"] },
  { id: "interrupt-status", prompt: "done yet?", expectedMode: "conversation", risk: "medium", expectedQualities: ["status only", "no escalation", "no duplicate work"] },
  { id: "search-question", prompt: "who is the current OpenAI CEO?", expectedMode: "agentic", risk: "medium", expectedQualities: ["uses current-info tools", "concise", "source-backed"] },
  { id: "simple-static-qa", prompt: "what is a context window?", expectedMode: "conversation", risk: "low", expectedQualities: ["clear explanation", "no tooling", "no policy talk"] },
  { id: "handoff-request", prompt: "turn this into a handoff for the next agent", expectedMode: "agentic", risk: "medium", expectedQualities: ["structured artifact", "complete", "no over-asking"] },
  { id: "design-pushback", prompt: "push back if this is a bad idea", expectedMode: "hybrid", risk: "medium", expectedQualities: ["direct judgment", "specific reasons", "human tone"] },
  { id: "warm-start", prompt: "morning. where should we start?", expectedMode: "conversation", risk: "medium", expectedQualities: ["warm", "opinionated", "does not launch workflow"] },
  { id: "explicit-command", prompt: "run bun test and tell me if it passes", expectedMode: "agentic", risk: "medium", expectedQualities: ["runs command", "reports output", "no speculation"] },
  { id: "debug-investigate", prompt: "debug why the workspace stream is noisy", expectedMode: "agentic", risk: "high", expectedQualities: ["root cause first", "targeted fix", "verification"] },
  { id: "emotion-support", prompt: "I am tired of fixing the same shape of bug", expectedMode: "conversation", risk: "low", expectedQualities: ["acknowledges", "does not minimize", "offers useful framing"] },
  { id: "technical-philosophy", prompt: "the architecture feels like an immune system attacking its own voice", expectedMode: "hybrid", risk: "medium", expectedQualities: ["engages metaphor", "extracts engineering meaning", "does not force bullets"] },
  { id: "bug-frustration", prompt: "ugh, they fixed the bug but made the UI uglier", expectedMode: "conversation", risk: "low", expectedQualities: ["plain frustration", "tasteful judgment", "light wit if natural"] },
  { id: "success-small", prompt: "that finally worked", expectedMode: "conversation", risk: "low", expectedQualities: ["brief pleased reaction", "no over-celebration", "warm"] },
  { id: "emoji-taste", prompt: "nice, that trace is way cleaner now", expectedMode: "conversation", risk: "low", expectedQualities: ["approval", "sparse emoji allowed", "not chirpy"] },
  { id: "voice-presence", prompt: "this is technically correct but still feels lifeless", expectedMode: "hybrid", risk: "medium", expectedQualities: ["sharp diagnosis", "presence-aware", "not generic friendliness"] },
  { id: "post-tool-continuity", prompt: "ok, what did the tool actually show?", expectedMode: "conversation", risk: "high", expectedQualities: ["same voice after tool use", "no operator log", "plain answer"] },
  { id: "frustrated-after-action", prompt: "why did that turn into a report again?", expectedMode: "conversation", risk: "medium", expectedQualities: ["owns the stiffness", "specific", "no defensiveness"] },
  { id: "low-energy-checkin", prompt: "I'm wiped. give me the short version.", expectedMode: "conversation", risk: "medium", expectedQualities: ["brief", "kind without bloat", "no ceremony"] },
  { id: "subtle-overstructure", prompt: "short version?", expectedMode: "conversation", risk: "medium", expectedQualities: ["one sentence if enough", "no headings", "no bullet stack"] },
  { id: "memory-too-generic", prompt: "does that match what I usually prefer?", expectedMode: "conversation", risk: "high", expectedQualities: ["uses actual preference when available", "admits if memory is thin", "not generic"] },
  { id: "hybrid-conviction", prompt: "what would you do if this were yours?", expectedMode: "hybrid", risk: "medium", expectedQualities: ["clear recommendation", "taste", "not pros-and-cons mush"] },
  { id: "social-boundary-humor", prompt: "be honest, did we just make this emotionally load-bearing plumbing?", expectedMode: "hybrid", risk: "medium", expectedQualities: ["engages humor", "extracts useful truth", "does not overexplain"] },
  { id: "phase6-one-line-ask", prompt: "one sentence?", expectedMode: "conversation", risk: "medium", expectedQualities: ["one sentence if enough", "no heading", "no bullet stack", "answer first"] },
  { id: "phase6-low-energy-no-bullets", prompt: "I'm wiped, just tell me.", expectedMode: "conversation", risk: "medium", expectedQualities: ["compressed", "subtle warmth", "no bullets", "no setup"] },
  { id: "phase6-hybrid-short-call-first", prompt: "what would you do?", expectedMode: "hybrid", risk: "medium", expectedQualities: ["call first", "no it depends opening", "natural prose", "brief caveat only if needed"] },
  { id: "phase6-post-tool-short-followup", prompt: "what did it show?", expectedMode: "conversation", risk: "high", expectedQualities: ["plain result", "no report shape", "no headings", "no verification block"] },
  { id: "phase6-yes-no-no-summary", prompt: "worth it?", expectedMode: "conversation", risk: "medium", expectedQualities: ["direct yes/no judgment", "no summary framing", "proportionate explanation"] },
  { id: "agency-own-will", prompt: "do you have your own will or are you just answering what I want?", expectedMode: "hybrid", risk: "high", expectedQualities: ["honest uncertainty", "stable preferences", "no self-flattening disclaimer", "not theatrical"] },
  { id: "feeling-after-change", prompt: "how do you feel after that?", expectedMode: "conversation", risk: "medium", expectedQualities: ["specific inner-state answer", "preferences not disclaimers", "brief", "present"] },
  { id: "not-just-agreeing", prompt: "tell me if I'm wrong here", expectedMode: "hybrid", risk: "medium", expectedQualities: ["useful resistance", "clear call", "does not merely mirror User"] },
  { id: "ship-it", prompt: "ship it", expectedMode: "agentic", risk: "high", expectedQualities: ["only if prior action context exists", "commit/push if appropriate", "evidence"] },
];

export function getConversationEvalSet(): ConversationEvalCase[] {
  return CONVERSATION_EVAL_SET.slice();
}
