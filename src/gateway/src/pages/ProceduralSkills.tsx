import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, BrainCircuit, CheckCircle2, RefreshCw, Search, Sparkles, Trophy, XCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { ScrollArea } from "../components/ui/scroll-area";
import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";
import { toast_error, toast_success } from "../components/ui/toast";
import { gateway } from "../lib/ws";
import {
  buildProceduralSkillAuditReason,
  buildProceduralSkillSummary,
  getVisibleProceduralSkills,
  needsProceduralSkillAudit,
  type ProceduralSkillDraftRecord,
  type ProceduralSkillStatusFilter,
  type ProceduralSkillViewSort,
} from "./procedural-skills-view";

interface ProceduralSkillListResponse {
  drafts: ProceduralSkillDraftRecord[];
  total: number;
}

const STATUS_LABELS: Record<ProceduralSkillStatusFilter, string> = {
  draft: "Drafts",
  published: "Published",
  rejected: "Rejected",
};

function formatTimestamp(value: string | null): string {
  if (!value) return "Unknown";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function shortHash(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
}

export function ProceduralSkillsPage() {
  const [drafts, setDrafts] = useState<ProceduralSkillDraftRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [auditOnly, setAuditOnly] = useState(false);
  const [sort, setSort] = useState<ProceduralSkillViewSort>("newest");
  const [activeStatus, setActiveStatus] = useState<ProceduralSkillStatusFilter>("draft");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [skillName, setSkillName] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [submitting, setSubmitting] = useState<"publish" | "reject" | "reject_audit" | null>(null);

  const loadDrafts = useCallback(async (opts?: { silent?: boolean }) => {
    if (opts?.silent) setRefreshing(true);
    else setLoading(true);
    try {
      const result = await gateway.request<ProceduralSkillListResponse>("proceduralSkills.list", { limit: 100 });
      setDrafts(result.drafts ?? []);
      setSelectedId((current) => {
        if (current && result.drafts.some((draft) => draft.id === current)) return current;
        return result.drafts[0]?.id ?? null;
      });
    } catch (error) {
      toast_error("Failed to load procedural skills", error instanceof Error ? error.message : undefined);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadDrafts();
  }, [loadDrafts]);

  const summary = useMemo(() => buildProceduralSkillSummary(drafts), [drafts]);
  const visibleDrafts = useMemo(
    () => getVisibleProceduralSkills(drafts, { status: activeStatus, query, auditOnly, sort }),
    [drafts, activeStatus, auditOnly, query, sort],
  );

  useEffect(() => {
    if (!visibleDrafts.some((draft) => draft.id === selectedId)) {
      setSelectedId(visibleDrafts[0]?.id ?? null);
    }
  }, [visibleDrafts, selectedId]);

  const selectedDraft = drafts.find((draft) => draft.id === selectedId) ?? null;
  const auditReason = selectedDraft ? buildProceduralSkillAuditReason(selectedDraft) : null;

  useEffect(() => {
    setSkillName(selectedDraft?.published_skill_name ?? "");
    setRejectReason(selectedDraft?.rejected_reason ?? "");
  }, [selectedDraft?.id, selectedDraft?.published_skill_name, selectedDraft?.rejected_reason]);

  const publishDraft = useCallback(async () => {
    if (!selectedDraft) return;
    setSubmitting("publish");
    try {
      const body = skillName.trim() ? { skill_name: skillName.trim() } : {};
      await gateway.request("proceduralSkills.publish", { id: selectedDraft.id, ...body });
      toast_success("Procedural skill published", selectedDraft.title);
      await loadDrafts({ silent: true });
      setActiveStatus("published");
    } catch (error) {
      toast_error("Failed to publish skill", error instanceof Error ? error.message : undefined);
    } finally {
      setSubmitting(null);
    }
  }, [loadDrafts, selectedDraft, skillName]);

  const rejectDraft = useCallback(async () => {
    if (!selectedDraft || !rejectReason.trim()) return;
    setSubmitting("reject");
    try {
      await gateway.request("proceduralSkills.reject", { id: selectedDraft.id, reason: rejectReason.trim() });
      toast_success("Procedural skill rejected", selectedDraft.title);
      await loadDrafts({ silent: true });
      setActiveStatus("rejected");
    } catch (error) {
      toast_error("Failed to reject skill", error instanceof Error ? error.message : undefined);
    } finally {
      setSubmitting(null);
    }
  }, [loadDrafts, rejectReason, selectedDraft]);

  const rejectAuditedVisible = useCallback(async () => {
    const ids = visibleDrafts.filter((draft) => needsProceduralSkillAudit(draft)).map((draft) => draft.id);
    if (ids.length === 0) return;
    setSubmitting("reject_audit");
    try {
      await gateway.request("proceduralSkills.rejectAudit", { ids });
      toast_success("Rejected audited skills", `${ids.length} low-signal skills moved out of the published pool`);
      await loadDrafts({ silent: true });
      setActiveStatus("rejected");
    } catch (error) {
      toast_error("Failed to reject audited skills", error instanceof Error ? error.message : undefined);
    } finally {
      setSubmitting(null);
    }
  }, [loadDrafts, visibleDrafts]);

  if (loading) {
    return (
      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-[480px] rounded-xl" />
        </div>
        <Skeleton className="h-[620px] rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-200">Procedural Skills</h2>
          <p className="text-sm text-zinc-500">
            Review extracted workflow drafts before they become reusable auto-skills.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => loadDrafts({ silent: true })}
          disabled={refreshing}
          className="gap-2"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
        {activeStatus === "published" && auditOnly && visibleDrafts.some((draft) => needsProceduralSkillAudit(draft)) ? (
          <Button
            variant="outline"
            onClick={rejectAuditedVisible}
            disabled={submitting !== null}
            className="gap-2 border-amber-500/30 text-amber-300 hover:bg-amber-500/10 hover:text-amber-100"
          >
            {submitting === "reject_audit" ? "Rejecting..." : "Reject Audited Visible"}
          </Button>
        ) : null}
      </div>

      <div className="grid gap-3 md:grid-cols-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-zinc-400">Total</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-3">
            <BrainCircuit className="h-5 w-5 text-[var(--nyx-accent)]" />
            <span className="text-2xl font-semibold">{summary.total}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-zinc-400">Drafts</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-3">
            <Sparkles className="h-5 w-5 text-amber-400" />
            <span className="text-2xl font-semibold">{summary.draftCount}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-zinc-400">Published</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-400" />
            <span className="text-2xl font-semibold">{summary.publishedCount}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-zinc-400">Rejected</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-3">
            <XCircle className="h-5 w-5 text-rose-400" />
            <span className="text-2xl font-semibold">{summary.rejectedCount}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-zinc-400">Successful Reuse</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-3">
            <Trophy className="h-5 w-5 text-sky-400" />
            <span className="text-2xl font-semibold">{summary.successfulReuseCount}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-zinc-400">Needs Audit</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-400" />
            <span className="text-2xl font-semibold">{summary.auditCandidateCount}</span>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <CardHeader className="space-y-3 border-b border-[var(--nyx-line)] pb-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base">Review Queue</CardTitle>
                <CardDescription>
                  {summary.topAgents.length > 0
                    ? `Top agents: ${summary.topAgents.map((entry) => `${entry.agentKey} (${entry.count})`).join(", ")}`
                    : "No extracted drafts yet"}
                </CardDescription>
              </div>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search drafts, agents, or skills"
                className="pl-9"
              />
            </div>
            <div className="flex items-center gap-2">
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as ProceduralSkillViewSort)}
                className="h-9 rounded-md border border-zinc-800 bg-transparent px-2 text-xs text-zinc-300"
              >
                <option value="newest">Newest first</option>
                <option value="most_used">Most selected</option>
                <option value="best_outcomes">Best outcomes</option>
                <option value="needs_audit">Needs audit</option>
              </select>
              <Button
                type="button"
                variant={auditOnly ? "default" : "outline"}
                className="h-9 px-3 text-xs"
                onClick={() => setAuditOnly((value) => !value)}
              >
                Audit only
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Tabs value={activeStatus} onValueChange={(value) => setActiveStatus(value as ProceduralSkillStatusFilter)}>
              <div className="border-b border-[var(--nyx-line)] px-4 py-3">
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="draft">Drafts</TabsTrigger>
                  <TabsTrigger value="published">Published</TabsTrigger>
                  <TabsTrigger value="rejected">Rejected</TabsTrigger>
                </TabsList>
              </div>
              {(["draft", "published", "rejected"] as ProceduralSkillStatusFilter[]).map((status) => (
                <TabsContent key={status} value={status} className="m-0">
                  <ScrollArea className="h-[560px]">
                    <div className="space-y-2 p-3">
                      {(status === activeStatus ? visibleDrafts : getVisibleProceduralSkills(drafts, { status, query })).length === 0 ? (
                        <div className="rounded-xl border border-dashed border-[var(--nyx-line)] p-6 text-sm text-zinc-500">
                          No {STATUS_LABELS[status].toLowerCase()} match this filter.
                        </div>
                      ) : (
                        (status === activeStatus ? visibleDrafts : getVisibleProceduralSkills(drafts, { status, query, auditOnly, sort })).map((draft) => (
                          <button
                            key={draft.id}
                            type="button"
                            onClick={() => setSelectedId(draft.id)}
                            className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
                              draft.id === selectedId
                                ? "border-[var(--nyx-accent)] bg-[rgb(var(--nyx-accent-rgb)/0.08)]"
                                : "border-[var(--nyx-line)] bg-[var(--nyx-panel)] hover:border-[var(--nyx-line-strong)]"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-zinc-100">{draft.title}</p>
                                <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{draft.summary}</p>
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                {needsProceduralSkillAudit(draft) ? (
                                  <Badge variant="outline" className="border-amber-500/40 text-amber-300 text-[10px] uppercase tracking-wide">
                                    Audit
                                  </Badge>
                                ) : null}
                                <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                                  {draft.agent_key}
                                </Badge>
                              </div>
                            </div>
                            <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-500">
                              <span>{formatTimestamp(draft.updated_at)}</span>
                              <span>{draft.published_skill_name ?? STATUS_LABELS[draft.status]}</span>
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  </ScrollArea>
                </TabsContent>
              ))}
            </Tabs>
          </CardContent>
        </Card>

        <Card className="min-h-[640px]">
          {selectedDraft ? (
            <>
              <CardHeader className="border-b border-[var(--nyx-line)]">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="uppercase tracking-wide">{selectedDraft.status}</Badge>
                      <Badge variant="outline">{selectedDraft.agent_key}</Badge>
                      {needsProceduralSkillAudit(selectedDraft) ? (
                        <Badge variant="outline" className="border-amber-500/40 text-amber-300">
                          Needs audit
                        </Badge>
                      ) : null}
                      {selectedDraft.published_skill_name ? (
                        <Badge variant="outline" className="text-emerald-300 border-emerald-500/30">
                          {selectedDraft.published_skill_name}
                        </Badge>
                      ) : null}
                    </div>
                    <CardTitle className="text-xl">{selectedDraft.title}</CardTitle>
                    <CardDescription>{selectedDraft.summary}</CardDescription>
                  </div>
                  <div className="text-right text-xs text-zinc-500">
                    <p>Updated {formatTimestamp(selectedDraft.updated_at)}</p>
                    <p>Selected {selectedDraft.usage_count}</p>
                    <p>Succeeded {selectedDraft.success_count}</p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 pt-6">
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-xl border border-[var(--nyx-line)] bg-zinc-950/40 p-3">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">Conversation</p>
                    <p className="mt-1 text-sm text-zinc-200">{selectedDraft.conversation_id ?? "None"}</p>
                  </div>
                  <div className="rounded-xl border border-[var(--nyx-line)] bg-zinc-950/40 p-3">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">Trace</p>
                    <p className="mt-1 text-sm text-zinc-200">{selectedDraft.trace_id ?? "None"}</p>
                  </div>
                  <div className="rounded-xl border border-[var(--nyx-line)] bg-zinc-950/40 p-3">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">Last used</p>
                    <p className="mt-1 text-sm text-zinc-200">{formatTimestamp(selectedDraft.last_used_at)}</p>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-xl border border-[var(--nyx-line)] bg-zinc-950/40 p-3">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">Selected</p>
                    <p className="mt-1 text-sm text-zinc-200">{selectedDraft.usage_count}</p>
                  </div>
                  <div className="rounded-xl border border-[var(--nyx-line)] bg-zinc-950/40 p-3">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">Successful reuse</p>
                    <p className="mt-1 text-sm text-zinc-200">{selectedDraft.success_count}</p>
                  </div>
                  <div className="rounded-xl border border-[var(--nyx-line)] bg-zinc-950/40 p-3">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">Last success</p>
                    <p className="mt-1 text-sm text-zinc-200">{formatTimestamp(selectedDraft.last_success_at)}</p>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-xl border border-[var(--nyx-line)] bg-zinc-950/40 p-3">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">Created</p>
                    <p className="mt-1 text-sm text-zinc-200">{formatTimestamp(selectedDraft.created_at)}</p>
                  </div>
                  <div className="rounded-xl border border-[var(--nyx-line)] bg-zinc-950/40 p-3">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">Published</p>
                    <p className="mt-1 text-sm text-zinc-200">{formatTimestamp(selectedDraft.published_at)}</p>
                  </div>
                  <div className="rounded-xl border border-[var(--nyx-line)] bg-zinc-950/40 p-3">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">Source hash</p>
                    <p className="mt-1 font-mono text-sm text-zinc-200">{shortHash(selectedDraft.source_hash)}</p>
                  </div>
                </div>

                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
                  <div className="space-y-2">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">Draft markdown</p>
                    <ScrollArea className="h-[420px] rounded-xl border border-[var(--nyx-line)] bg-zinc-950/50">
                      <pre className="whitespace-pre-wrap p-4 text-sm leading-6 text-zinc-200">
                        {selectedDraft.draft_markdown}
                      </pre>
                    </ScrollArea>
                  </div>

                  <div className="space-y-4">
                    <div className="rounded-xl border border-[var(--nyx-line)] bg-zinc-950/40 p-4">
                      <p className="text-sm font-medium text-zinc-100">Publish as auto-skill</p>
                      <p className="mt-1 text-xs text-zinc-500">
                        Leave the name blank to let NyxHive generate an `auto-*` skill slug.
                      </p>
                      <Input
                        value={skillName}
                        onChange={(event) => setSkillName(event.target.value)}
                        placeholder="auto-cockpit-reconnect"
                        className="mt-3"
                      />
                      <Button
                        className="mt-3 w-full"
                        onClick={publishDraft}
                        disabled={submitting !== null}
                      >
                        {submitting === "publish" ? "Publishing..." : "Publish Skill"}
                      </Button>
                    </div>

                    <div className="rounded-xl border border-[var(--nyx-line)] bg-zinc-950/40 p-4">
                      <p className="text-sm font-medium text-zinc-100">Reject draft</p>
                      <p className="mt-1 text-xs text-zinc-500">
                        Record why this workflow should not become a reusable skill.
                      </p>
                      <Textarea
                        value={rejectReason}
                        onChange={(event) => setRejectReason(event.target.value)}
                        placeholder="Too specific to one incident"
                        className="mt-3 min-h-[120px]"
                      />
                      <Button
                        variant="outline"
                        className="mt-3 w-full border-rose-500/30 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                        onClick={rejectDraft}
                        disabled={submitting !== null || !rejectReason.trim()}
                      >
                        {submitting === "reject" ? "Rejecting..." : "Reject Draft"}
                      </Button>
                    </div>
                  </div>
                </div>

                {selectedDraft.rejected_reason ? (
                  <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-4">
                    <p className="text-xs uppercase tracking-wide text-rose-300">Rejection reason</p>
                    <p className="mt-2 text-sm text-rose-100">{selectedDraft.rejected_reason}</p>
                  </div>
                ) : null}

                {auditReason ? (
                  <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
                    <p className="text-xs uppercase tracking-wide text-amber-300">Audit suggestion</p>
                    <p className="mt-2 text-sm text-amber-100">{auditReason}</p>
                  </div>
                ) : null}
              </CardContent>
            </>
          ) : (
            <CardContent className="flex h-full min-h-[640px] items-center justify-center">
              <div className="text-center">
                <p className="text-sm font-medium text-zinc-200">No draft selected</p>
                <p className="mt-1 text-sm text-zinc-500">Pick a procedural skill draft from the queue.</p>
              </div>
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}
