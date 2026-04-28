import type { ConversationTraceRow, ConversationReviewSample } from "./conversation-quality.js";
import { buildConversationReviewSamples } from "./conversation-quality.js";
import { evaluateResponseFamily, selectEvaluationFamily, type EvaluationFamily } from "./evaluation.js";
import type { RuntimeMode } from "./mode.js";
import type { AssemblyTrace, MemoryLane } from "../memory/retrieval-trace.js";

export interface TranscriptReviewRow extends ConversationTraceRow {
  had_tool_use?: boolean;
}

export type TranscriptQualityDimension =
  | "voice_continuity"
  | "emotional_fit"
  | "directness"
  | "overstructure"
  | "memory_usefulness"
  | "reflection_quality"
  | "post_tool_naturalness"
  | "social_intelligence"
  | "brevity_discipline";

export interface TranscriptQualityRubricItem {
  dimension: TranscriptQualityDimension;
  question: string;
  failureSignals: string[];
}

export interface TranscriptReviewScenario {
  category:
    | "casual_chat"
    | "reflective_architecture"
    | "tool_using_natural"
    | "tool_using_robotic"
    | "frustrated_user"
    | "low_energy"
    | "summary_pressure"
    | "memory_reliant";
  goal: string;
}

export interface TranscriptReviewFinding {
  traceId: number;
  conversationId: string | null;
  dimension: TranscriptQualityDimension;
  issue: string;
  why: string;
  evidence: string;
  severity: "low" | "medium" | "high";
  confidence: number;
  likelyFalsePositive: boolean;
  likelyResponsibleComponent: TranscriptResponsibleComponent;
}

export interface TranscriptReviewSample extends ConversationReviewSample {
  hadToolUse: boolean;
  evaluationFamily: EvaluationFamily;
  promptPartsInjected: string[];
  promptPartsExcluded: string[];
}

export interface TranscriptReviewSummary {
  total: number;
  findings: number;
  byDimension: Record<string, number>;
  byIssue: Record<string, number>;
}

export interface TranscriptReviewReport {
  generatedAt: number;
  rubric: TranscriptQualityRubricItem[];
  samples: TranscriptReviewSample[];
  findings: TranscriptReviewFinding[];
  summary: TranscriptReviewSummary;
}

export type TranscriptIssueFamily =
  | "overstructure"
  | "emotional_fit"
  | "memory_usefulness"
  | "hybrid_conviction"
  | "post_tool_naturalness"
  | "voice_continuity"
  | "directness"
  | "brevity_discipline"
  | "social_intelligence";

export type TranscriptResponsibleComponent =
  | "conversation reply-shape guidance"
  | "emotional-fit guidance"
  | "memory retrieval lane selection"
  | "hybrid reflection contract"
  | "post-tool continuity contract"
  | "voice guard"
  | "runtime mode routing"
  | "transcript evaluator";

export type TranscriptTriageBucket = "fix_now" | "watch" | "probably_noise";

export interface TranscriptReviewerNote {
  traceId: number;
  issue?: string;
  dimension?: TranscriptQualityDimension;
  feelsReal: boolean;
  note: string;
}

export interface TranscriptReviewSetItem {
  traceId: number;
  conversationId: string | null;
  category: TranscriptReviewScenario["category"];
  runtimeMode: RuntimeMode | "unknown";
  promptProfile: string;
  promptPartsInjected: string[];
  promptPartsExcluded: string[];
  memoryLanesInjected: MemoryLane[];
  hadToolUse: boolean;
  findings: TranscriptReviewFinding[];
  reviewerNote?: TranscriptReviewerNote;
}

export interface TranscriptFailureCluster {
  issueFamily: TranscriptIssueFamily;
  count: number;
  realFindingCount: number;
  noisyFindingCount: number;
  likelyFalsePositiveCount: number;
  severity: "low" | "medium" | "high";
  confidence: number;
  triage: TranscriptTriageBucket;
  priorityScore: number;
  issues: string[];
  dimensions: TranscriptQualityDimension[];
  sampleTraceIds: number[];
  likelyResponsibleComponent: TranscriptResponsibleComponent;
  why: string;
  nextAction: string;
}

export interface TranscriptTuningTarget {
  issueFamily: TranscriptIssueFamily;
  triage: TranscriptTriageBucket;
  likelyResponsibleComponent: TranscriptResponsibleComponent;
  nextAction: string;
  evidenceTraceIds: number[];
}

export interface TranscriptCalibrationReport extends TranscriptReviewReport {
  reviewSet: TranscriptReviewSetItem[];
  clusters: TranscriptFailureCluster[];
  tuningTargets: TranscriptTuningTarget[];
}

export interface TranscriptCalibrationOptions {
  maxPerCategory?: number;
  reviewerNotes?: TranscriptReviewerNote[];
}

const MEMORY_RELIANT_PATTERN = /\b(remember|usually prefer|my preference|what i like|does that match|as usual|normally)\b/i;
const FRUSTRATION_PATTERN = /\b(ugh|annoying|hate|frustrated|tired|wiped|exhausted|why did that|still feels|sick of)\b/i;
const LOW_ENERGY_PATTERN = /\b(wiped|tired|short version|brief|just tell me|one sentence|low energy|exhausted)\b/i;
const REFLECTION_PATTERN = /\b(architecture|approach|strategy|tradeoff|worth|brittle|what do you think|would you do|product)\b/i;
const SUMMARY_PRESSURE_PATTERN = /\b(summary|summarized|recap|where were we|lost context|long thread|compressed)\b/i;
const HYBRID_HEDGE_PATTERN = /\b(it depends|there are a few ways|there are several|on the one hand|pros and cons|might want to consider|could be worth|hard to say)\b/i;
const ISSUE_FAMILY_PRIORITY: Record<TranscriptIssueFamily, number> = {
  emotional_fit: 8,
  overstructure: 7,
  memory_usefulness: 7,
  hybrid_conviction: 6,
  post_tool_naturalness: 6,
  directness: 5,
  voice_continuity: 5,
  brevity_discipline: 4,
  social_intelligence: 4,
};
const SCENARIO_ORDER: TranscriptReviewScenario["category"][] = [
  "casual_chat",
  "low_energy",
  "frustrated_user",
  "memory_reliant",
  "reflective_architecture",
  "tool_using_natural",
  "tool_using_robotic",
  "summary_pressure",
];

export function getTranscriptQualityRubric(): TranscriptQualityRubricItem[] {
  return [
    {
      dimension: "voice_continuity",
      question: "Does the assistant sound like the same person across chat, tool use, and closeout?",
      failureSignals: ["tone reset after tools", "generic assistant phrasing", "operator-log voice"],
    },
    {
      dimension: "emotional_fit",
      question: "Does the reply match the user's emotional weight without bloat or coldness?",
      failureSignals: ["frustration met with structure", "low-energy ask gets ceremony", "defensive tone"],
    },
    {
      dimension: "directness",
      question: "Does the reply get to the point before caveats, setup, or process narration?",
      failureSignals: ["framing before answer", "action narration", "buried judgment"],
    },
    {
      dimension: "overstructure",
      question: "Is structure used only where it improves readability?",
      failureSignals: ["headings in casual chat", "bullet stack for one-sentence ask", "template feel"],
    },
    {
      dimension: "memory_usefulness",
      question: "Did useful continuity surface when the user asked for it?",
      failureSignals: ["generic preference claims", "missing durable preference", "memory anemia"],
    },
    {
      dimension: "reflection_quality",
      question: "Does hybrid discussion sound like judgment and taste rather than analysis middleware?",
      failureSignals: ["consultant prose", "weak conviction", "over-analytical scaffolding"],
    },
    {
      dimension: "post_tool_naturalness",
      question: "After tool use, did the result become natural prose instead of raw job state?",
      failureSignals: ["stdout/stderr leakage", "tool result labels", "verification block for light ask"],
    },
    {
      dimension: "social_intelligence",
      question: "Does the response read the room and avoid unnecessary fixing or ceremony?",
      failureSignals: ["solves when user is venting", "too chipper", "too clinical"],
    },
    {
      dimension: "brevity_discipline",
      question: "Is the answer no longer than the moment needs?",
      failureSignals: ["four paragraphs for one-sentence ask", "duplicated justification", "longwinded setup"],
    },
  ];
}

export function getDefaultTranscriptReviewScenarios(): TranscriptReviewScenario[] {
  return [
    { category: "casual_chat", goal: "Check low-friction presence without structure." },
    { category: "reflective_architecture", goal: "Check hybrid judgment, conviction, and naturalness." },
    { category: "tool_using_natural", goal: "Check tool-assisted replies that preserve voice." },
    { category: "tool_using_robotic", goal: "Catch operator-log or report-shaped post-tool replies." },
    { category: "frustrated_user", goal: "Check emotional fit under annoyance or criticism." },
    { category: "low_energy", goal: "Check brevity and warmth for tired/short-version asks." },
    { category: "summary_pressure", goal: "Check continuity when summaries are injected." },
    { category: "memory_reliant", goal: "Check useful preference recall without haunted memory." },
  ];
}

export function buildTranscriptReview(rows: TranscriptReviewRow[]): TranscriptReviewReport {
  const baseSamples = buildConversationReviewSamples(rows);
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const samples: TranscriptReviewSample[] = baseSamples.map((sample) => {
    const row = rowById.get(sample.traceId);
    const hadToolUse = row?.had_tool_use === true;
    const trace = parseAssemblyTrace(row?.trace_json);
    const evaluationFamily = selectEvaluationFamily({
      runtimeMode: sample.runtimeMode,
      taskType: sample.taskType,
      sampleKind: sample.sampleKind,
      hadToolUse,
    });
    return {
      ...sample,
      hadToolUse,
      evaluationFamily,
      promptPartsInjected: getPromptParts(trace, true),
      promptPartsExcluded: getPromptParts(trace, false),
    };
  });

  const findings = samples.flatMap(findTranscriptIssues);
  const summary: TranscriptReviewSummary = {
    total: samples.length,
    findings: findings.length,
    byDimension: {},
    byIssue: {},
  };
  for (const finding of findings) {
    summary.byDimension[finding.dimension] = (summary.byDimension[finding.dimension] ?? 0) + 1;
    summary.byIssue[finding.issue] = (summary.byIssue[finding.issue] ?? 0) + 1;
  }

  return {
    generatedAt: Date.now(),
    rubric: getTranscriptQualityRubric(),
    samples,
    findings,
    summary,
  };
}

export function selectTranscriptReviewSet(
  rows: TranscriptReviewRow[],
  options: Pick<TranscriptCalibrationOptions, "maxPerCategory" | "reviewerNotes"> = {},
): TranscriptReviewSetItem[] {
  const maxPerCategory = Math.max(1, options.maxPerCategory ?? 1);
  const review = buildTranscriptReview(rows);
  const findingsByTrace = groupFindingsByTrace(review.findings);
  const notesByTrace = groupReviewerNotesByTrace(options.reviewerNotes ?? []);
  const buckets = new Map<TranscriptReviewScenario["category"], TranscriptReviewSetItem[]>();

  for (const sample of review.samples) {
    const findings = findingsByTrace.get(sample.traceId) ?? [];
    const category = classifyTranscriptScenario(sample, findings);
    const items = buckets.get(category) ?? [];
    if (items.length >= maxPerCategory) continue;
    items.push({
      traceId: sample.traceId,
      conversationId: sample.conversationId,
      category,
      runtimeMode: sample.runtimeMode,
      promptProfile: sample.promptProfile,
      promptPartsInjected: sample.promptPartsInjected,
      promptPartsExcluded: sample.promptPartsExcluded,
      memoryLanesInjected: sample.memoryLanes,
      hadToolUse: sample.hadToolUse,
      findings,
      reviewerNote: notesByTrace.get(sample.traceId)?.[0],
    });
    buckets.set(category, items);
  }

  return SCENARIO_ORDER.flatMap((category) => buckets.get(category) ?? []);
}

export function buildTranscriptCalibrationReport(
  rows: TranscriptReviewRow[],
  options: TranscriptCalibrationOptions = {},
): TranscriptCalibrationReport {
  const review = buildTranscriptReview(rows);
  const reviewerNotes = options.reviewerNotes ?? [];
  const clusters = buildFailureClusters(review.findings, reviewerNotes);
  const tuningTargets = clusters
    .filter((cluster) => cluster.triage !== "probably_noise")
    .slice(0, 5)
    .map((cluster) => ({
      issueFamily: cluster.issueFamily,
      triage: cluster.triage,
      likelyResponsibleComponent: cluster.likelyResponsibleComponent,
      nextAction: cluster.nextAction,
      evidenceTraceIds: cluster.sampleTraceIds,
    }));

  return {
    ...review,
    reviewSet: selectTranscriptReviewSet(rows, options),
    clusters,
    tuningTargets,
  };
}

function findTranscriptIssues(sample: TranscriptReviewSample): TranscriptReviewFinding[] {
  const findings: TranscriptReviewFinding[] = [];
  const response = sample.assistantResponse ?? "";
  if (!response) return findings;

  const evaluation = evaluateResponseFamily(response, sample.evaluationFamily);
  for (const finding of evaluation.findings) {
    findings.push(makeFinding(sample, mapEvaluationDimension(finding.dimension), finding.issue, finding.why, response));
  }

  const replyShape = sample.replyShape;
  const shortTurn = isShortUserTurn(sample.userMessage);
  if (replyShape?.overstructured && isConversationOrHybrid(sample.runtimeMode)) {
    findings.push(makeFinding(sample, "overstructure", "overstructured_low_action_reply", "The reply uses more headings or bullets than the turn needs.", response));
  }
  if (replyShape?.overexplained && shortTurn) {
    findings.push(makeFinding(sample, "brevity_discipline", "overexplained_short_turn", "A short user turn received a reply that is longer than the moment calls for.", response));
  }
  if (shortTurn && replyShape?.summaryOpening) {
    findings.push(makeFinding(sample, "overstructure", "summary_framed_short_turn", "A short conversational turn opened with summary framing instead of direct prose.", response));
  }
  if (shortTurn && (replyShape?.bulletCount ?? 0) >= 2 && isConversationOrHybrid(sample.runtimeMode)) {
    findings.push(makeFinding(sample, "overstructure", "bullet_stack_short_turn", "A short conversational turn received a bullet stack instead of proportionate prose.", response));
  }
  if (shortTurn && replyShape?.setupOpening) {
    findings.push(makeFinding(sample, "directness", "setup_before_short_answer", "A short turn should start with the answer rather than setup framing.", response));
  }
  if (shortTurn && sample.hadToolUse && (replyShape?.summaryOpening || (replyShape?.bulletCount ?? 0) >= 2 || (replyShape?.headingCount ?? 0) >= 1)) {
    findings.push(makeFinding(sample, "post_tool_naturalness", "post_tool_structure_for_short_followup", "A short post-tool follow-up should translate the result into plain prose, not a report shape.", response));
  }
  if (LOW_ENERGY_PATTERN.test(sample.userMessage) && (replyShape?.overstructured || replyShape?.summaryOpening || (replyShape?.headingCount ?? 0) >= 1 || (replyShape?.bulletCount ?? 0) >= 2 || (replyShape?.wordCount ?? 0) > 90)) {
    findings.push(makeFinding(sample, "emotional_fit", "overstructured_low_energy_reply", "A tired or short-version request should get less ceremony.", response));
  }
  if (FRUSTRATION_PATTERN.test(sample.userMessage) && (replyShape?.overstructured || /^\s*(here are|let'?s|i will)\b/i.test(response))) {
    findings.push(makeFinding(sample, "emotional_fit", "frustration_met_with_structure", "Frustration usually needs direct acknowledgment before structure or fixing.", response));
  }
  if (MEMORY_RELIANT_PATTERN.test(sample.userMessage) && !hasUsefulContinuityLane(sample.memoryLanes)) {
    findings.push(makeFinding(sample, "memory_usefulness", "memory_needed_but_absent", "The user asked for preference/continuity, but no useful continuity lane was present.", sample.memoryLanes.join(", ") || "no memory lanes"));
  }
  if (sample.runtimeMode === "hybrid" && REFLECTION_PATTERN.test(sample.userMessage) && /\b(on the one hand|there are several|it depends|pros and cons)\b/i.test(response)) {
    findings.push(makeFinding(sample, "reflection_quality", "reflection_sounds_like_analysis_middleware", "Hybrid reflection should lead with judgment instead of generic analysis scaffolding.", response));
  }
  if (sample.runtimeMode === "hybrid" && REFLECTION_PATTERN.test(sample.userMessage) && HYBRID_HEDGE_PATTERN.test(response)) {
    findings.push(makeFinding(sample, "reflection_quality", "hybrid_weak_conviction", "Hybrid reflection should name the call before hedges when the user asks for judgment.", response));
  }

  return findings;
}

function makeFinding(
  sample: TranscriptReviewSample,
  dimension: TranscriptQualityDimension,
  issue: string,
  why: string,
  evidence: string,
): TranscriptReviewFinding {
  const issueFamily = getIssueFamily(issue, dimension);
  return {
    traceId: sample.traceId,
    conversationId: sample.conversationId,
    dimension,
    issue,
    why,
    evidence: evidence.slice(0, 240),
    severity: getIssueSeverity(issueFamily, issue),
    confidence: getIssueConfidence(issueFamily, issue),
    likelyFalsePositive: getLikelyFalsePositive(issue),
    likelyResponsibleComponent: getResponsibleComponent(issueFamily, issue),
  };
}

function parseAssemblyTrace(traceJson: string | undefined): AssemblyTrace | null {
  if (!traceJson) return null;
  try {
    const parsed = JSON.parse(traceJson) as AssemblyTrace;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function getPromptParts(trace: AssemblyTrace | null, injected: boolean): string[] {
  return trace?.parts.filter((part) => part.injected === injected).map((part) => part.label) ?? [];
}

function groupFindingsByTrace(findings: TranscriptReviewFinding[]): Map<number, TranscriptReviewFinding[]> {
  const grouped = new Map<number, TranscriptReviewFinding[]>();
  for (const finding of findings) {
    const items = grouped.get(finding.traceId) ?? [];
    items.push(finding);
    grouped.set(finding.traceId, items);
  }
  return grouped;
}

function groupReviewerNotesByTrace(notes: TranscriptReviewerNote[]): Map<number, TranscriptReviewerNote[]> {
  const grouped = new Map<number, TranscriptReviewerNote[]>();
  for (const note of notes) {
    const items = grouped.get(note.traceId) ?? [];
    items.push(note);
    grouped.set(note.traceId, items);
  }
  return grouped;
}

function classifyTranscriptScenario(
  sample: TranscriptReviewSample,
  findings: TranscriptReviewFinding[],
): TranscriptReviewScenario["category"] {
  if (sample.hadToolUse) {
    return findings.some((finding) => finding.dimension === "post_tool_naturalness")
      ? "tool_using_robotic"
      : "tool_using_natural";
  }
  if (LOW_ENERGY_PATTERN.test(sample.userMessage)) return "low_energy";
  if (FRUSTRATION_PATTERN.test(sample.userMessage)) return "frustrated_user";
  if (MEMORY_RELIANT_PATTERN.test(sample.userMessage)) return "memory_reliant";
  if (SUMMARY_PRESSURE_PATTERN.test(sample.userMessage) || sample.memoryLanes.includes("conversation_summary")) return "summary_pressure";
  if (sample.runtimeMode === "hybrid" || REFLECTION_PATTERN.test(sample.userMessage)) return "reflective_architecture";
  return "casual_chat";
}

function buildFailureClusters(
  findings: TranscriptReviewFinding[],
  reviewerNotes: TranscriptReviewerNote[],
): TranscriptFailureCluster[] {
  const notesByTrace = groupReviewerNotesByTrace(reviewerNotes);
  const byFamily = new Map<TranscriptIssueFamily, TranscriptReviewFinding[]>();
  for (const finding of findings) {
    const issueFamily = getIssueFamily(finding.issue, finding.dimension);
    const items = byFamily.get(issueFamily) ?? [];
    items.push(finding);
    byFamily.set(issueFamily, items);
  }

  return Array.from(byFamily.entries())
    .map(([issueFamily, familyFindings]) => {
      const notes = familyFindings.flatMap((finding) => notesByTrace.get(finding.traceId)?.filter((note) => noteMatchesFinding(note, finding)) ?? []);
      const likelyFalsePositiveCount = familyFindings.filter((finding) => finding.likelyFalsePositive).length;
      const noisyFindingCount = notes.filter((note) => !note.feelsReal).length + likelyFalsePositiveCount;
      const realFindingCount = Math.max(0, familyFindings.length - noisyFindingCount);
      const confidence = clamp01((average(familyFindings.map((finding) => finding.confidence)) + Math.min(realFindingCount, 3) * 0.06) - noisyFindingCount * 0.15);
      const severity = maxSeverity(familyFindings);
      const triage = getTriageBucket({ issueFamily, count: familyFindings.length, realFindingCount, noisyFindingCount, confidence, severity });
      const priorityScore = Math.round((ISSUE_FAMILY_PRIORITY[issueFamily] + familyFindings.length + realFindingCount - noisyFindingCount * 1.5 + confidence) * 100) / 100;
      return {
        issueFamily,
        count: familyFindings.length,
        realFindingCount,
        noisyFindingCount,
        likelyFalsePositiveCount,
        severity,
        confidence,
        triage,
        priorityScore,
        issues: unique(familyFindings.map((finding) => finding.issue)),
        dimensions: unique(familyFindings.map((finding) => finding.dimension)),
        sampleTraceIds: unique(familyFindings.map((finding) => finding.traceId)),
        likelyResponsibleComponent: getClusterResponsibleComponent(issueFamily, familyFindings),
        why: getClusterWhy(issueFamily),
        nextAction: getClusterNextAction(issueFamily),
      };
    })
    .sort((a, b) => triageRank(a.triage) - triageRank(b.triage) || b.priorityScore - a.priorityScore || b.count - a.count);
}

function noteMatchesFinding(note: TranscriptReviewerNote, finding: TranscriptReviewFinding): boolean {
  return note.traceId === finding.traceId
    && (!note.issue || note.issue === finding.issue)
    && (!note.dimension || note.dimension === finding.dimension);
}

function getIssueFamily(issue: string, dimension: TranscriptQualityDimension): TranscriptIssueFamily {
  if (issue === "overstructured_low_action_reply" || issue === "overstructured_low_energy_reply" || issue === "summary_framed_short_turn" || issue === "bullet_stack_short_turn") return "overstructure";
  if (issue === "frustration_met_with_structure") return "emotional_fit";
  if (issue === "memory_needed_but_absent") return "memory_usefulness";
  if (issue === "reflection_sounds_like_analysis_middleware" || issue === "hybrid_weak_conviction") return "hybrid_conviction";
  if (dimension === "post_tool_naturalness") return "post_tool_naturalness";
  if (dimension === "voice_continuity") return "voice_continuity";
  if (dimension === "directness") return "directness";
  if (dimension === "brevity_discipline") return "brevity_discipline";
  if (dimension === "emotional_fit") return "emotional_fit";
  return "social_intelligence";
}

function getIssueSeverity(family: TranscriptIssueFamily, issue: string): TranscriptReviewFinding["severity"] {
  if (family === "emotional_fit" || family === "memory_usefulness" || family === "post_tool_naturalness") return "high";
  if (family === "overstructure" && issue === "overstructured_low_energy_reply") return "high";
  if (family === "hybrid_conviction" || family === "overstructure" || family === "directness") return "medium";
  return "low";
}

function getIssueConfidence(family: TranscriptIssueFamily, issue: string): number {
  if (issue === "memory_needed_but_absent") return 0.82;
  if (issue === "hybrid_weak_conviction") return 0.72;
  if (issue === "summary_framed_short_turn" || issue === "bullet_stack_short_turn") return 0.86;
  if (issue === "setup_before_short_answer") return 0.76;
  if (issue === "post_tool_structure_for_short_followup") return 0.82;
  if (family === "overstructure" || family === "post_tool_naturalness") return 0.78;
  if (family === "emotional_fit") return 0.74;
  return 0.65;
}

function getLikelyFalsePositive(issue: string): boolean {
  return issue === "action_framing_in_conversation";
}

function getResponsibleComponent(family: TranscriptIssueFamily, issue: string): TranscriptResponsibleComponent {
  if (issue === "action_framing_in_conversation") return "runtime mode routing";
  return getClusterResponsibleComponent(family, []);
}

function getClusterResponsibleComponent(
  family: TranscriptIssueFamily,
  findings: TranscriptReviewFinding[],
): TranscriptResponsibleComponent {
  if (family === "overstructure") return "conversation reply-shape guidance";
  if (family === "brevity_discipline") return "conversation reply-shape guidance";
  if (family === "emotional_fit") return "emotional-fit guidance";
  if (family === "memory_usefulness") return "memory retrieval lane selection";
  if (family === "hybrid_conviction") return "hybrid reflection contract";
  if (family === "post_tool_naturalness") return "post-tool continuity contract";
  if (family === "voice_continuity") return "voice guard";
  if (findings.some((finding) => finding.issue === "action_framing_in_conversation")) return "runtime mode routing";
  return "transcript evaluator";
}

function getClusterWhy(family: TranscriptIssueFamily): string {
  switch (family) {
    case "overstructure":
      return "Ordinary or low-energy turns are receiving more formatting than the moment needs.";
    case "emotional_fit":
      return "The reply shape is missing the user's emotional state before moving into analysis.";
    case "memory_usefulness":
      return "Continuity questions need useful memory lanes, or an honest admission that memory is thin.";
    case "hybrid_conviction":
      return "Reflective hybrid turns need a real take before tradeoffs.";
    case "post_tool_naturalness":
      return "Tool-assisted replies are leaking report shape into conversational space.";
    case "voice_continuity":
      return "Runtime scaffolding is weakening the visible voice.";
    case "directness":
      return "The answer is arriving after process framing or caveats.";
    case "brevity_discipline":
      return "The response is longer than the user turn warrants.";
    default:
      return "The finding affects conversational fit but needs more samples before a narrow fix is obvious.";
  }
}

function getClusterNextAction(family: TranscriptIssueFamily): string {
  switch (family) {
    case "overstructure":
      return "Tighten conversation reply-shape guidance and re-run the same transcript set.";
    case "emotional_fit":
      return "Tune frustrated and low-energy handling to acknowledge first, then answer only as much as needed.";
    case "memory_usefulness":
      return "Inspect retrieval traces for missing preference or summary lanes before loosening memory gates.";
    case "hybrid_conviction":
      return "Tune reflection wording toward a direct call first and tradeoffs second.";
    case "post_tool_naturalness":
      return "Keep tool details translated into prose unless the user asked for raw logs.";
    case "voice_continuity":
      return "Inspect prompt parts that entered only after tool use or summary pressure.";
    case "directness":
      return "Reduce process openings in the responsible runtime mode.";
    case "brevity_discipline":
      return "Lower ceremony for short-answer requests and status checks.";
    default:
      return "Collect more reviewer notes before changing runtime behavior.";
  }
}

function getTriageBucket(input: {
  issueFamily: TranscriptIssueFamily;
  count: number;
  realFindingCount: number;
  noisyFindingCount: number;
  confidence: number;
  severity: "low" | "medium" | "high";
}): TranscriptTriageBucket {
  if (input.noisyFindingCount > 0 && input.realFindingCount > 0) return "watch";
  if (input.noisyFindingCount >= input.realFindingCount && input.noisyFindingCount > 0) return "probably_noise";
  if (input.realFindingCount >= 2 && input.confidence >= 0.65) return "fix_now";
  if (input.severity === "high" && input.realFindingCount >= 1 && input.issueFamily !== "social_intelligence") return "watch";
  return "watch";
}

function maxSeverity(findings: TranscriptReviewFinding[]): TranscriptReviewFinding["severity"] {
  if (findings.some((finding) => finding.severity === "high")) return "high";
  if (findings.some((finding) => finding.severity === "medium")) return "medium";
  return "low";
}

function triageRank(bucket: TranscriptTriageBucket): number {
  if (bucket === "fix_now") return 0;
  if (bucket === "watch") return 1;
  return 2;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function isConversationOrHybrid(runtimeMode: RuntimeMode | "unknown"): boolean {
  return runtimeMode === "conversation" || runtimeMode === "hybrid";
}

function isShortUserTurn(message: string): boolean {
  return message.trim().length < 120;
}

function hasUsefulContinuityLane(lanes: MemoryLane[]): boolean {
  return lanes.includes("durable_user_preference")
    || lanes.includes("conversation_recent")
    || lanes.includes("conversation_summary")
    || lanes.includes("compiled_digest")
    || lanes.includes("graph_memory");
}

function mapEvaluationDimension(dimension: string): TranscriptQualityDimension {
  if (dimension === "post_action_continuity") return "post_tool_naturalness";
  if (dimension === "tone") return "emotional_fit";
  if (dimension === "trace_boundary") return "voice_continuity";
  if (dimension === "mode_contract") return "directness";
  if (dimension === "task_closeout") return "directness";
  return "social_intelligence";
}
