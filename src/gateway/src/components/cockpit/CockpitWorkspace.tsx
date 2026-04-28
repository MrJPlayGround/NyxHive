import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  Brain,
  Clock3,
  FileCode2,
  Loader2,
  Maximize,
  MessageSquareText,
  Minimize,
  MoreHorizontal,
  PencilLine,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { MessageList } from "../chat/MessageList";
import { MessageInput } from "../chat/MessageInput";
import { ExecutionPanel } from "../chat/ExecutionPanel";
import { ChatRequestCards } from "../chat/ChatRequestCards";
import {
  CockpitInspectorPanel,
  type CockpitInspectorTab,
} from "./CockpitInspectorPanel";
import { useFleetChatStore } from "../../stores/fleet-chat";
import { useUiPrefs } from "../../stores/ui-prefs";
import type { FleetInstance } from "../../stores/fleet-config";
import type { InstanceAuthState } from "../../stores/fleet-auth";
import type { ChatAttachment } from "../../stores/chat";
import { cn } from "../../lib/utils";
import { getWorkspaceLoadPlan } from "./workspace-load-plan";
import { getCockpitLayoutState } from "./cockpit-layout";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)}d`;
  return `${Math.floor(delta / 604_800_000)}w`;
}

interface CockpitWorkspaceProps {
  instance: FleetInstance;
  auth: InstanceAuthState;
}

function formatContextPct(pct: number): string {
  if (!Number.isFinite(pct)) return "0%";
  if (pct > 100) return "100%+";
  if (pct < 0) return "0%";
  return `${pct}%`;
}

const COCKPIT_EMPTY_CHAT_SUGGESTIONS = [
  "Check system health",
  "Summarize recent activity",
  "List pending approvals",
  "What are you working on?",
];

export function CockpitWorkspace({ instance, auth }: CockpitWorkspaceProps) {
  const fleetChat = useFleetChatStore((state) => state.instances[instance.id]);
  const {
    setActiveAgent,
    sendMessage,
    abortStream,
    loadHistory,
    loadRequests,
    fetchThreads,
    searchThreads,
    switchThread,
    resolveRequest,
    loadModelInfo,
    setModelOverride,
    renameThread,
    deleteThread,
    archiveThread,
    selectChangePath,
    setDiffOpen,
    addTerminalSnippet,
    removeTerminalSnippet,
    resetInstance,
    dismissEphemeralBtw,
    askBtw,
  } = useFleetChatStore();
  const {
    showReasoning,
    showToolCalls,
    focusMode,
    toggleReasoning,
    toggleToolCalls,
    toggleFocusMode,
  } = useUiPrefs();
  const [resolvingRequestId, setResolvingRequestId] = useState<string | null>(
    null,
  );
  const [threadActionKey, setThreadActionKey] = useState<string | null>(null);
  const [threadQuery, setThreadQuery] = useState("");
  const deferredThreadQuery = useDeferredValue(threadQuery);
  const [traceOpen, setTraceOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] =
    useState<CockpitInspectorTab>("status");
  const traceAutoOpenedRef = useRef(false);

  const preferredAgent = auth.leadAgent ?? instance.preferredAgent ?? "nyx";
  const threadId = fleetChat?.threadId ?? null;
  const messages = fleetChat?.messages ?? [];
  const messageCount = messages.length;
  const hasOnlyTransientAssistantMessages =
    messageCount > 0 &&
    messages.every(
      (message) =>
        message.role === "assistant" &&
        !message.content.trim() &&
        !(message.reasoning?.trim()) &&
        !message.attachments?.length,
    );
  const activeAgent = fleetChat?.activeAgent ?? preferredAgent;
  const isStreaming = fleetChat?.streaming ?? false;
  const queuedCount = fleetChat?.queuedMessages.length ?? 0;
  const workspaceLoadPlan = getWorkspaceLoadPlan({
    authenticated: auth.authenticated,
    hasFleetChat: Boolean(fleetChat),
    threadId,
    messageCount,
    hasOnlyTransientAssistantMessages,
  });

  useEffect(() => {
    if (!fleetChat) return;
    if (fleetChat.activeAgent === preferredAgent) return;
    setActiveAgent(instance.id, preferredAgent);
  }, [fleetChat, preferredAgent, instance.id, setActiveAgent]);

  useEffect(() => {
    if (!workspaceLoadPlan.loadRequests) return;
    void loadRequests(instance.id);
  }, [instance.id, loadRequests, workspaceLoadPlan.loadRequests]);

  useEffect(() => {
    if (!workspaceLoadPlan.fetchThreads) return;
    void fetchThreads(instance.id);
  }, [instance.id, fetchThreads, workspaceLoadPlan.fetchThreads]);

  useEffect(() => {
    void searchThreads(instance.id, deferredThreadQuery);
  }, [deferredThreadQuery, instance.id, searchThreads]);

  useEffect(() => {
    if (!workspaceLoadPlan.loadModelInfo) return;
    void loadModelInfo(instance.id);
  }, [
    activeAgent,
    instance.id,
    loadModelInfo,
    threadId,
    workspaceLoadPlan.loadModelInfo,
  ]);

  useEffect(() => {
    if (!workspaceLoadPlan.loadHistory || !threadId) return;
    void loadHistory(instance.id, threadId);
  }, [instance.id, loadHistory, threadId, workspaceLoadPlan.loadHistory]);

  const activeThreadRequests = useMemo(
    () =>
      (fleetChat?.pendingRequests ?? []).filter(
        (request) =>
          request.threadId && request.threadId === fleetChat.threadId,
      ),
    [fleetChat],
  );
  const inboxRequests = useMemo(
    () =>
      (fleetChat?.pendingRequests ?? []).filter(
        (request) =>
          !request.threadId || request.threadId !== fleetChat.threadId,
      ),
    [fleetChat],
  );
  const threadSearchQuery = threadQuery.trim();
  const searchingSavedThreads = threadSearchQuery.length >= 2;
  const visibleThreads = useMemo(() => {
    const query = threadSearchQuery.toLowerCase();
    if (searchingSavedThreads) {
      return fleetChat?.threadSearchResults ?? [];
    }
    if (!query) return fleetChat?.threads ?? [];
    return (fleetChat?.threads ?? []).filter((thread) =>
      `${thread.title} ${thread.agent} ${thread.status}`
        .toLowerCase()
        .includes(query),
    );
  }, [
    fleetChat?.threadSearchResults,
    fleetChat?.threads,
    searchingSavedThreads,
    threadSearchQuery,
  ]);

  const hasTraceActivity =
    (fleetChat?.streaming ?? false) ||
    (fleetChat?.executionEvents.length ?? 0) > 0;

  useEffect(() => {
    if (hasTraceActivity && !traceAutoOpenedRef.current) {
      traceAutoOpenedRef.current = true;
      setTraceOpen(true);
      return;
    }
    if (!hasTraceActivity) {
      traceAutoOpenedRef.current = false;
    }
  }, [hasTraceActivity]);

  useEffect(() => {
    if (!fleetChat?.diffOpen) return;
    if (fleetChat.threadChanges.length === 0 && !fleetChat.selectedChangePath) {
      return;
    }
    setInspectorTab("files");
  }, [
    fleetChat?.diffOpen,
    fleetChat?.selectedChangePath,
    fleetChat?.threadChanges.length,
  ]);

  const handleSend = useCallback(
    (content: string, attachments?: ChatAttachment[]) => {
      const trimmed = content.trim();
      if (!trimmed && (!attachments || attachments.length === 0)) return;
      if (isStreaming && trimmed.toLowerCase().startsWith("btw ")) {
        const question = trimmed.slice(4).trim();
        if (!question) return;
        void askBtw(instance.id, question);
        return;
      }
      void sendMessage(instance.id, trimmed, attachments);
    },
    [askBtw, isStreaming, instance.id, sendMessage],
  );

  const handleResolveRequest = useCallback(
    async (requestId: string, action: "approve" | "reject") => {
      setResolvingRequestId(requestId);
      try {
        await resolveRequest(instance.id, requestId, action);
      } catch (error) {
        console.error(
          `[cockpit.request.resolve:${instance.id}] failed:`,
          error,
        );
      } finally {
        setResolvingRequestId(null);
      }
    },
    [instance.id, resolveRequest],
  );

  const handleAttachSnippet = useCallback(
    (itemId: string, label: string, content: string) => {
      addTerminalSnippet(instance.id, { itemId, label, content });
    },
    [addTerminalSnippet, instance.id],
  );

  const handleOpenChange = useCallback(
    (path: string) => {
      setInspectorTab("files");
      setInspectorOpen(true);
      selectChangePath(instance.id, path);
    },
    [instance.id, selectChangePath],
  );

  const handleOpenInspector = useCallback(
    (tab: CockpitInspectorTab) => {
      setInspectorTab(tab);
      setInspectorOpen(true);
      if (tab === "files" && !fleetChat?.diffOpen) {
        setDiffOpen(instance.id, true);
      }
    },
    [fleetChat?.diffOpen, instance.id, setDiffOpen],
  );

  const handleCloseInspector = useCallback(() => {
    setInspectorOpen(false);
    setDiffOpen(instance.id, false);
  }, [instance.id, setDiffOpen]);

  const handleRenameThread = useCallback(
    async (threadId: string, currentTitle: string) => {
      const title = window.prompt("Rename thread", currentTitle)?.trim();
      if (!title || title === currentTitle) return;
      setThreadActionKey(`${threadId}:rename`);
      try {
        await renameThread(instance.id, threadId, title);
      } catch (error) {
        console.error(`[cockpit.thread.rename:${instance.id}] failed:`, error);
      } finally {
        setThreadActionKey(null);
      }
    },
    [instance.id, renameThread],
  );

  const handleArchiveThread = useCallback(
    async (threadId: string, title: string) => {
      if (!window.confirm(`Archive "${title}"?`)) return;
      setThreadActionKey(`${threadId}:archive`);
      try {
        await archiveThread(instance.id, threadId);
      } catch (error) {
        console.error(`[cockpit.thread.archive:${instance.id}] failed:`, error);
      } finally {
        setThreadActionKey(null);
      }
    },
    [archiveThread, instance.id],
  );

  const handleDeleteThread = useCallback(
    async (threadId: string, title: string) => {
      if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
      setThreadActionKey(`${threadId}:delete`);
      try {
        await deleteThread(instance.id, threadId);
      } catch (error) {
        console.error(`[cockpit.thread.delete:${instance.id}] failed:`, error);
      } finally {
        setThreadActionKey(null);
      }
    },
    [deleteThread, instance.id],
  );

  if (!fleetChat) return null;

  const contextPct = fleetChat.contextPct;
  const connectionReady = auth.connected && auth.authenticated;
  const diffChanges = fleetChat.threadChanges;
  const executionCount = fleetChat.executionEvents.length;
  const changedFileCount = diffChanges.length;
  const layout = getCockpitLayoutState({
    focusMode,
    traceOpen,
    diffOpen: fleetChat.diffOpen,
    executionCount,
    changedFileCount,
    streaming: fleetChat.streaming,
  });
  const rightInspectorOpen =
    !focusMode && (inspectorOpen || layout.showDiffRail);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-3 border-b border-[var(--nyx-line)] px-5 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div
              className="h-8 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: instance.color }}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-semibold text-[var(--nyx-text)]">
                  {auth.instanceName ?? instance.label}
                </p>
                {fleetChat.modelInfo?.overridden ? (
                  <span className="rounded-full border border-[rgb(var(--nyx-accent-rgb)/0.18)] bg-[rgb(var(--nyx-accent-rgb)/0.08)] px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-[var(--nyx-accent)]">
                    Override
                  </span>
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-zinc-500">
                <span className="uppercase tracking-[0.16em]">
                  Agent {fleetChat.activeAgent}
                </span>
                {fleetChat.modelInfo ? (
                  <span>
                    {fleetChat.modelInfo.provider} · {fleetChat.modelInfo.model}
                  </span>
                ) : null}
                {threadId ? (
                  <span className="font-mono">{threadId.slice(0, 8)}</span>
                ) : (
                  <span>No active thread</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setTraceOpen((open) => !open)}
              className={`rounded-md border px-2 py-1.5 text-xs transition-colors ${layout.showTraceDrawer ? "border-[rgb(var(--nyx-accent-rgb)/0.24)] bg-[rgb(var(--nyx-accent-rgb)/0.12)] text-[var(--nyx-accent)]" : "border-transparent text-zinc-500 hover:border-white/10 hover:bg-white/[0.03] hover:text-zinc-300"}`}
              title={
                layout.showTraceDrawer
                  ? "Hide trace drawer"
                  : "Show trace drawer"
              }
            >
              <span className="flex items-center gap-1.5">
                <SquareTerminal className="h-4 w-4" />
                <span className="hidden sm:inline">Trace</span>
                {executionCount > 0 ? (
                  <span className="font-mono text-[10px]">
                    {executionCount}
                  </span>
                ) : null}
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (rightInspectorOpen && inspectorTab === "files") {
                  handleCloseInspector();
                  return;
                }
                handleOpenInspector("files");
              }}
              disabled={!layout.canToggleDiff}
              className={`rounded-md border px-2 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${rightInspectorOpen && inspectorTab === "files" ? "border-[rgb(var(--nyx-accent-rgb)/0.24)] bg-[rgb(var(--nyx-accent-rgb)/0.12)] text-[var(--nyx-accent)]" : "border-transparent text-zinc-500 hover:border-white/10 hover:bg-white/[0.03] hover:text-zinc-300"}`}
              title={
                rightInspectorOpen && inspectorTab === "files"
                  ? "Hide inspector"
                  : "Show changed files"
              }
            >
              <span className="flex items-center gap-1.5">
                <FileCode2 className="h-4 w-4" />
                <span className="hidden sm:inline">Diff</span>
                {changedFileCount > 0 ? (
                  <span className="font-mono text-[10px]">
                    {changedFileCount}
                  </span>
                ) : null}
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (rightInspectorOpen && inspectorTab !== "files") {
                  handleCloseInspector();
                  return;
                }
                handleOpenInspector("status");
              }}
              className={`rounded-md border px-2 py-1.5 text-xs transition-colors ${rightInspectorOpen && inspectorTab !== "files" ? "border-[rgb(var(--nyx-accent-rgb)/0.24)] bg-[rgb(var(--nyx-accent-rgb)/0.12)] text-[var(--nyx-accent)]" : "border-transparent text-zinc-500 hover:border-white/10 hover:bg-white/[0.03] hover:text-zinc-300"}`}
              title={
                rightInspectorOpen && inspectorTab !== "files"
                  ? "Hide inspector"
                  : "Show workspace inspector"
              }
            >
              <span className="flex items-center gap-1.5">
                <SquareTerminal className="h-4 w-4" />
                <span className="hidden sm:inline">Inspector</span>
                {activeThreadRequests.length + inboxRequests.length > 0 ? (
                  <span className="font-mono text-[10px]">
                    {activeThreadRequests.length + inboxRequests.length}
                  </span>
                ) : null}
              </span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="rounded-md border border-transparent px-2 py-1.5 text-xs text-zinc-500 transition-colors hover:border-white/10 hover:bg-white/[0.03] hover:text-zinc-300"
                  title="View options"
                >
                  <span className="flex items-center gap-1.5">
                    <Settings2 className="h-4 w-4" />
                    <span className="hidden sm:inline">View</span>
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel className="text-xs uppercase tracking-[0.16em] text-zinc-500">
                  Cockpit View
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={showReasoning}
                  onCheckedChange={toggleReasoning}
                >
                  <Brain className="h-4 w-4" />
                  Reasoning
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={showToolCalls}
                  onCheckedChange={toggleToolCalls}
                >
                  <SquareTerminal className="h-4 w-4" />
                  Tool trace in chat
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={focusMode}
                  onCheckedChange={toggleFocusMode}
                >
                  {focusMode ? (
                    <Minimize className="h-4 w-4" />
                  ) : (
                    <Maximize className="h-4 w-4" />
                  )}
                  Focus mode
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              onClick={() => {
                resetInstance(instance.id);
                void loadModelInfo(instance.id);
                void loadRequests(instance.id);
              }}
              className="rounded-md border border-transparent p-1.5 text-zinc-500 transition-colors hover:border-white/10 hover:bg-white/[0.03] hover:text-zinc-300"
              title="Start new thread"
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (threadId) {
                  void loadHistory(instance.id, threadId);
                }
                void loadRequests(instance.id);
                void loadModelInfo(instance.id);
              }}
              className="rounded-md border border-transparent p-1.5 text-zinc-500 transition-colors hover:border-white/10 hover:bg-white/[0.03] hover:text-zinc-300"
              title="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            {contextPct !== null ? (
              <div
                className="ml-1 flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1"
                title={`Context pressure ${formatContextPct(contextPct)}`}
              >
                <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                  Context
                </span>
                <div className="h-1.5 w-20 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className={`h-full rounded-full ${contextPct > 80 ? "bg-red-500" : contextPct > 50 ? "bg-yellow-500" : "bg-[var(--nyx-accent)]"}`}
                    style={{ width: `${Math.min(contextPct, 100)}%` }}
                  />
                </div>
                <span
                  className={`text-xs tabular-nums ${contextPct > 80 ? "text-red-400" : "text-zinc-500"}`}
                >
                  {formatContextPct(contextPct)}
                </span>
              </div>
            ) : null}
          </div>
        </div>

        {!connectionReady ? (
          <div className="flex items-center gap-3 border-b border-[rgba(244,112,104,0.12)] bg-[rgba(244,112,104,0.04)] px-5 py-3 text-sm text-zinc-300">
            <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--nyx-danger)]" />
            <div className="min-w-0">
              <p className="font-medium text-zinc-200">
                This instance is not authenticated yet.
              </p>
              <p className="text-xs text-zinc-500">
                {auth.error ??
                  "Connect and approve the device before sending messages."}
              </p>
            </div>
          </div>
        ) : null}

        {inboxRequests.length > 0 ? (
          <div className="flex items-center gap-2 border-b border-[var(--nyx-line)] px-5 py-2 text-[11px] text-zinc-500">
            <MessageSquareText className="h-3.5 w-3.5" />
            <span>
              {inboxRequests.length} pending request
              {inboxRequests.length === 1 ? "" : "s"} outside the active thread
            </span>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          {!focusMode && (
            <div className="flex w-72 shrink-0 flex-col border-r border-[var(--nyx-line)] bg-[var(--nyx-panel-2)]">
              <div className="flex items-center justify-between border-b border-[var(--nyx-line)] px-4 py-3">
                <div>
                  <p className="text-[13px] font-semibold text-[var(--nyx-text)]">
                    Recent Threads
                  </p>
                  <p className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                    {fleetChat.threads.length} loaded
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void fetchThreads(instance.id);
                  }}
                  className="rounded-md border border-transparent p-1.5 text-zinc-500 transition-colors hover:border-white/10 hover:bg-white/[0.03] hover:text-zinc-300"
                  title="Refresh threads"
                >
                  <RefreshCw className="h-4 w-4" />
                </button>
              </div>
              <div className="border-b border-[var(--nyx-line)] px-4 py-3">
                <label className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2 text-sm text-zinc-400 transition-colors focus-within:border-[rgb(var(--nyx-accent-rgb)/0.18)] focus-within:text-zinc-200">
                  <Search className="h-4 w-4 shrink-0 text-zinc-500" />
                  <input
                    value={threadQuery}
                    onChange={(event) => setThreadQuery(event.target.value)}
                    placeholder="Find a thread..."
                    className="w-full bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-600"
                  />
                </label>
                <p className="mt-2 text-[11px] text-zinc-500">
                  {searchingSavedThreads
                    ? fleetChat.threadsSearching
                      ? "Searching saved threads..."
                      : `${visibleThreads.length} saved-thread match${visibleThreads.length === 1 ? "" : "es"}`
                    : `${visibleThreads.length} of ${fleetChat.threads.length} visible`}
                </p>
              </div>
              <div className="border-b border-[var(--nyx-line)] px-4 py-3">
                <div className="flex items-start gap-2">
                  <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--nyx-accent)]" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-zinc-200">Inbox</p>
                    <p className="mt-1 text-[11px] leading-5 text-zinc-500">
                      {inboxRequests.length > 0
                        ? `${inboxRequests.length} request${inboxRequests.length === 1 ? "" : "s"} waiting outside this thread`
                        : "No pending cross-thread requests right now."}
                    </p>
                  </div>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                <button
                  type="button"
                  onClick={() => {
                    resetInstance(instance.id);
                    void loadModelInfo(instance.id);
                    void loadRequests(instance.id);
                  }}
                  className={cn(
                    "mb-2 flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                    threadId === null
                      ? "border-[rgb(var(--nyx-accent-rgb)/0.2)] bg-[rgb(var(--nyx-accent-rgb)/0.10)] text-[var(--nyx-accent)]"
                      : "border-transparent bg-white/[0.02] text-zinc-300 hover:border-white/10 hover:bg-white/[0.04]",
                  )}
                >
                  <Plus className="h-4 w-4 shrink-0" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">New Thread</p>
                    <p className="text-[11px] text-zinc-500">
                      Start fresh with {activeAgent}
                    </p>
                  </div>
                </button>
                {searchingSavedThreads && fleetChat.threadsSearching ? (
                  <div className="flex items-center gap-2 px-3 py-4 text-xs text-zinc-500">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Searching saved threads...
                  </div>
                ) : fleetChat.threadsLoading ? (
                  <div className="flex items-center gap-2 px-3 py-4 text-xs text-zinc-500">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading recent threads…
                  </div>
                ) : !searchingSavedThreads && fleetChat.threads.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-zinc-500">
                    No saved threads yet for this instance.
                  </div>
                ) : visibleThreads.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-zinc-500">
                    {searchingSavedThreads
                      ? `No saved threads match "${threadSearchQuery}".`
                      : `Nothing matches "${threadSearchQuery}".`}
                  </div>
                ) : (
                  visibleThreads.map((thread) => {
                    const activeThread = thread.id === threadId;
                    const actionBusy =
                      threadActionKey?.startsWith(`${thread.id}:`) ?? false;
                    return (
                      <div
                        key={thread.id}
                        className={cn(
                          "group mb-1 flex items-start gap-1 rounded-lg border transition-colors",
                          activeThread
                            ? "border-[rgb(var(--nyx-accent-rgb)/0.18)] bg-[rgb(var(--nyx-accent-rgb)/0.10)]"
                            : "border-transparent text-zinc-300 hover:border-white/10 hover:bg-white/[0.03]",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            void switchThread(instance.id, thread.id);
                          }}
                          className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left"
                        >
                          <div
                            className={cn(
                              "mt-1 h-2 w-2 shrink-0 rounded-full",
                              thread.status === "failed"
                                ? "bg-[var(--nyx-danger)]"
                                : thread.status === "completed"
                                  ? "bg-emerald-400"
                                  : "bg-[var(--nyx-warn)]",
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <p
                              className={cn(
                                "truncate text-sm font-medium",
                                activeThread
                                  ? "text-zinc-100"
                                  : "text-zinc-200",
                              )}
                            >
                              {thread.title}
                            </p>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                              <span>{thread.agent}</span>
                              <span>·</span>
                              <span>{thread.messageCount} msg</span>
                              <span>·</span>
                              <span>
                                {formatRelativeTime(thread.updatedAt)}
                              </span>
                            </div>
                            {"snippet" in thread && thread.snippet ? (
                              <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-zinc-500">
                                {thread.snippet.replace(/\*\*/g, "")}
                              </p>
                            ) : null}
                          </div>
                          <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-600" />
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className="mr-1 mt-1 rounded-md border border-transparent p-1.5 text-zinc-600 opacity-0 transition-all hover:border-white/10 hover:bg-white/[0.04] hover:text-zinc-300 group-hover:opacity-100 data-[state=open]:opacity-100"
                              disabled={actionBusy}
                              aria-label={`Thread actions for ${thread.title}`}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem
                              onSelect={() => {
                                void handleRenameThread(
                                  thread.id,
                                  thread.title,
                                );
                              }}
                            >
                              <PencilLine className="h-4 w-4" />
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => {
                                void handleArchiveThread(
                                  thread.id,
                                  thread.title,
                                );
                              }}
                            >
                              <Archive className="h-4 w-4" />
                              Archive
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onSelect={() => {
                                void handleDeleteThread(
                                  thread.id,
                                  thread.title,
                                );
                              }}
                              className="text-red-300 focus:bg-red-500/10 focus:text-red-200"
                            >
                              <Trash2 className="h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {activeThreadRequests.length > 0 ? (
                <div className="shrink-0 px-6 pt-4">
                  <ChatRequestCards
                    requests={activeThreadRequests}
                    resolvingId={resolvingRequestId}
                    onResolve={handleResolveRequest}
                  />
                </div>
              ) : null}
              <MessageList
                messages={fleetChat.messages}
                executionEvents={fleetChat.executionEvents}
                onOpenChange={handleOpenChange}
                onSendSuggestion={handleSend}
                showReasoning={showReasoning}
                showToolCalls={showToolCalls}
                emptyTitle={auth.instanceName ?? instance.label}
                emptySubtitle={`Direct line to ${fleetChat.activeAgent}. Pick a quick check or send a message.`}
                emptyActions={COCKPIT_EMPTY_CHAT_SUGGESTIONS}
              />
            </div>
            {layout.showTraceSection ? (
              <div className="border-t border-[var(--nyx-line)] bg-[var(--nyx-panel-2)]">
                <button
                  type="button"
                  onClick={() => setTraceOpen((open) => !open)}
                  className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-white/[0.02]"
                >
                  <SquareTerminal className="h-4 w-4 shrink-0 text-[var(--nyx-accent)]" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-300">
                      Trace
                    </p>
                    <p className="text-[11px] text-zinc-500">
                      {executionCount} event{executionCount === 1 ? "" : "s"}
                      {fleetChat.streaming ? " · live" : ""}
                    </p>
                  </div>
                  {layout.showTraceSummary ? (
                    <Maximize className="h-4 w-4 text-zinc-500" />
                  ) : (
                    <Minimize className="h-4 w-4 text-zinc-500" />
                  )}
                </button>
                {layout.showTraceDrawer ? (
                  <ExecutionPanel
                    events={fleetChat.executionEvents}
                    streaming={fleetChat.streaming}
                    onOpenChange={handleOpenChange}
                    onAttachSnippet={handleAttachSnippet}
                    className="max-h-72 border-t border-[var(--nyx-line)]"
                  />
                ) : null}
              </div>
            ) : null}
            <MessageInput
              onSend={handleSend}
              onAbort={() => abortStream(instance.id)}
              onModelChange={(model) => {
                void setModelOverride(instance.id, model);
              }}
              streaming={fleetChat.streaming}
              disabled={!connectionReady}
              modelInfo={fleetChat.modelInfo}
              modelLoading={fleetChat.modelLoading}
              ephemeralBtw={fleetChat.ephemeralBtw}
              onDismissBtw={() => dismissEphemeralBtw(instance.id)}
              slashCommands={[]}
              queuedCount={queuedCount}
              terminalSnippets={fleetChat.terminalSnippets}
              onRemoveSnippet={(snippetId) =>
                removeTerminalSnippet(instance.id, snippetId)
              }
              placeholder={`Message ${auth.instanceName ?? instance.label}...`}
              streamingPlaceholder={`Send a follow-up or "btw ..." while ${activeAgent} is working`}
            />
          </div>
        </div>
      </div>

      {rightInspectorOpen ? (
        <div className="flex w-[30rem] shrink-0 flex-col border-l border-[var(--nyx-line)] bg-[var(--nyx-panel-2)] max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:top-12 max-md:z-40 max-md:w-screen max-md:border-l-0">
          <CockpitInspectorPanel
            activeTab={inspectorTab}
            onTabChange={setInspectorTab}
            onClose={handleCloseInspector}
            executionEvents={fleetChat.executionEvents}
            threadChanges={diffChanges}
            selectedPath={fleetChat.selectedChangePath}
            pendingRequests={fleetChat.pendingRequests}
            resolvingRequestId={resolvingRequestId}
            terminalSnippets={fleetChat.terminalSnippets}
            streaming={fleetChat.streaming}
            contextPct={contextPct}
            modelInfo={fleetChat.modelInfo}
            modelLoading={fleetChat.modelLoading}
            activeAgent={activeAgent}
            threadId={threadId}
            queuedCount={queuedCount}
            runtime={fleetChat.runtime}
            connectionReady={connectionReady}
            onOpenChange={handleOpenChange}
            onAttachSnippet={handleAttachSnippet}
            onResolveRequest={handleResolveRequest}
            onRemoveSnippet={(snippetId) =>
              removeTerminalSnippet(instance.id, snippetId)
            }
          />
        </div>
      ) : null}
    </div>
  );
}
