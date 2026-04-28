import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Pencil, Archive, Trash2, Send } from "lucide-react";
import { useThreadsStore, type ThreadDetail } from "../stores/threads";
import { useWsEvent } from "../hooks/useWs";
import { gateway } from "../lib/ws";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Separator } from "../components/ui/separator";
import { ScrollArea } from "../components/ui/scroll-area";
import { Skeleton } from "../components/ui/skeleton";
import { Input } from "../components/ui/input";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { cn } from "../lib/utils";
import { formatDate, formatTokens } from "../lib/format";
import type { Frame } from "../../protocol/frame";

export function ThreadDetailPage() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const { getThread, renameThread, archiveThread, deleteThread } = useThreadsStore();
	const [thread, setThread] = useState<ThreadDetail | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		if (!id) return;
		setLoading(true);
		getThread(id).then((t) => {
			setThread(t);
			setLoading(false);
		});
	}, [id, getThread]);

	// Rename state
	const [editing, setEditing] = useState(false);
	const [editTitle, setEditTitle] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	const startRename = () => {
		setEditTitle(thread?.title ?? "");
		setEditing(true);
		setTimeout(() => inputRef.current?.focus(), 0);
	};

	const commitRename = async () => {
		if (!thread || !editTitle.trim()) return;
		setEditing(false);
		await renameThread(thread.id, editTitle.trim());
		setThread((prev) => prev ? { ...prev, title: editTitle.trim() } : prev);
	};

	// Delete dialog
	const [showDelete, setShowDelete] = useState(false);
	const handleDelete = async () => {
		if (!thread) return;
		await deleteThread(thread.id);
		navigate("/threads");
	};

	// Archive dialog
	const [showArchive, setShowArchive] = useState(false);
	const handleArchive = async () => {
		if (!thread) return;
		await archiveThread(thread.id);
		navigate("/threads");
	};

	// Reply
	const [replyText, setReplyText] = useState("");
	const [replying, setReplying] = useState(false);
	const [replyResponse, setReplyResponse] = useState("");
	const replyResponseRef = useRef("");

	const handleReply = async () => {
		if (!thread || !replyText.trim()) return;
		setReplying(true);
		setReplyResponse("");
		replyResponseRef.current = "";
		try {
			await gateway.request("chat.send", {
				message: replyText,
				agent: thread.agent,
				threadId: thread.id,
			});
			// Append user message locally
			setThread((prev) => prev ? {
				...prev,
				messages: [...(prev.messages ?? []), {
					role: "user",
					content: replyText,
					timestamp: Date.now(),
				}],
			} : prev);
			setReplyText("");
		} catch {
			setReplying(false);
		}
	};

	// Listen for response deltas for this thread
	const handleDelta = useCallback(
		(frame: Frame) => {
			const payload = frame.payload as { data?: { text_delta?: string; sender_id?: string }; text_delta?: string; sender_id?: string };
			const threadId = payload.data?.sender_id ?? payload.sender_id;
			if (threadId !== id) return;
			const delta = payload.data?.text_delta ?? payload.text_delta ?? "";
			if (delta) {
				replyResponseRef.current += delta;
				setReplyResponse(replyResponseRef.current);
			}
		},
		[id],
	);

	const handleDone = useCallback(
		(frame: Frame) => {
			const payload = frame.payload as { text?: string; threadId?: string; done?: boolean };
			const threadId = payload.threadId;
			if (threadId !== id) return;
			if (payload.done) {
				setReplying(false);
				const finalText = payload.text || replyResponseRef.current;
				if (finalText) {
					setThread((prev) => prev ? {
						...prev,
						messages: [...(prev.messages ?? []), {
							role: "assistant",
							content: finalText,
							agent: prev.agent,
							timestamp: Date.now(),
						}],
					} : prev);
					replyResponseRef.current = "";
					setReplyResponse("");
				}
			}
		},
		[id],
	);

	useWsEvent("response:delta", handleDelta);
	useWsEvent("chat:response", handleDone);

	if (loading) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-48 rounded-xl" />
				<Skeleton className="h-64 rounded-xl" />
			</div>
		);
	}

	if (!thread) {
		return (
			<div className="py-8 text-center text-zinc-500">
				Thread not found
			</div>
		);
	}

	const isUuid = (s: string | null | undefined) => s && /^[0-9a-f]{8}-/.test(s);

	return (
		<div>
			<div className="flex items-center gap-3">
				<Button variant="ghost" size="icon" onClick={() => navigate("/threads")}>
					<ArrowLeft className="h-4 w-4" />
				</Button>
				<div className="min-w-0 flex-1">
					{editing ? (
						<Input
							ref={inputRef}
							value={editTitle}
							onChange={(e) => setEditTitle(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") commitRename();
								if (e.key === "Escape") setEditing(false);
							}}
							onBlur={commitRename}
							className="text-xl font-semibold"
						/>
					) : (
						<h1
							className="text-xl font-semibold truncate cursor-pointer group"
							onClick={startRename}
						>
							{thread.title || thread.id.slice(0, 8)}
							<Pencil className="ml-2 inline h-3.5 w-3.5 text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity" />
						</h1>
					)}
					<div className="flex items-center gap-2 text-sm text-zinc-400">
						{thread.agent && <Badge variant="secondary" className="text-xs">{thread.agent}</Badge>}
						{thread.project && !isUuid(thread.project) && (
							<span>{thread.project}</span>
						)}
						<span>{formatDate(thread.createdAt, true)}</span>
					</div>
				</div>
				<div className="flex items-center gap-1">
					<Button variant="ghost" size="icon" onClick={() => setShowArchive(true)} title="Archive">
						<Archive className="h-4 w-4 text-zinc-400" />
					</Button>
					<Button variant="ghost" size="icon" onClick={() => setShowDelete(true)} title="Delete">
						<Trash2 className="h-4 w-4 text-red-400" />
					</Button>
					<Badge variant="outline" className="ml-2 shrink-0">
						{thread.status}
					</Badge>
				</div>
			</div>

			<div className="mt-6 grid gap-4 grid-cols-3">
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-sm text-zinc-400">Tokens</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="text-2xl font-semibold">
							{formatTokens(thread.tokensIn + thread.tokensOut)}
						</p>
					</CardContent>
				</Card>
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-sm text-zinc-400">Cost</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="text-2xl font-semibold">
							${(thread.costCents / 100).toFixed(2)}
						</p>
					</CardContent>
				</Card>
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-sm text-zinc-400">Messages</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="text-2xl font-semibold">{thread.messageCount}</p>
					</CardContent>
				</Card>
			</div>

			{thread.delegationChain && thread.delegationChain.length > 0 && (
				<div className="mt-4">
					<p className="mb-2 text-sm font-medium text-zinc-400">
						Delegation Chain
					</p>
					<div className="flex items-center gap-2">
						{thread.delegationChain.map((agent, i) => (
							<div key={i} className="flex items-center gap-2">
								{i > 0 && <span className="text-zinc-600">&rarr;</span>}
								<Badge variant="secondary">{agent}</Badge>
							</div>
						))}
					</div>
				</div>
			)}

			{thread.gitBranch && (
				<div className="mt-4 flex items-center gap-4 text-sm text-zinc-400">
					<span>Branch: <code className="text-zinc-300">{thread.gitBranch}</code></span>
					{thread.prUrl && (
						<a
							href={thread.prUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="text-[var(--nyx-accent)] hover:underline"
						>
							View PR
						</a>
					)}
				</div>
			)}

			<Separator className="my-6" />

			<h2 className="mb-4 text-lg font-semibold">Messages</h2>
			<ScrollArea className="h-[calc(100vh-420px)] min-h-[200px]">
				<div className="space-y-4 pr-4">
					{(thread.messages ?? []).map((msg, i) => (
						<div
							key={i}
							className={cn(
								"rounded-lg px-4 py-3",
								msg.role === "user" ? "bg-zinc-800" : "bg-zinc-900",
							)}
						>
							<div className="mb-1 flex items-center gap-2">
								<span className="text-xs font-medium text-zinc-400">
									{msg.role === "user" ? "User" : msg.agent ?? "Assistant"}
								</span>
								<span className="text-xs text-zinc-600">
									{formatDate(msg.timestamp, true)}
								</span>
							</div>
							<p className="whitespace-pre-wrap text-sm">{msg.content}</p>
						</div>
					))}
					{(thread.messages ?? []).length === 0 && (
						<p className="py-4 text-center text-sm text-zinc-500">
							No message history available
						</p>
					)}
				</div>
			</ScrollArea>

			{/* Reply input */}
			<div className="mt-4 flex gap-2">
				<Input
					placeholder="Send a follow-up message..."
					value={replyText}
					onChange={(e) => setReplyText(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleReply(); } }}
					disabled={replying}
					className="flex-1"
				/>
				<Button onClick={handleReply} disabled={replying || !replyText.trim()}>
					<Send className="h-4 w-4" />
				</Button>
			</div>

			{/* Streaming reply */}
			{replyResponse && (
				<div className="mt-2 rounded-lg bg-zinc-900 px-4 py-3">
					<div className="mb-1 flex items-center gap-2">
						<span className="text-xs font-medium text-zinc-400">{thread.agent ?? "Assistant"}</span>
						{replying && <span className="text-xs text-[var(--nyx-accent)] animate-pulse">streaming...</span>}
					</div>
					<p className="whitespace-pre-wrap text-sm">{replyResponse}</p>
				</div>
			)}

			{/* Confirm dialogs */}
			<ConfirmDialog
				open={showDelete}
				onOpenChange={setShowDelete}
				title="Delete thread"
				description={`Are you sure you want to delete "${thread.title || thread.id.slice(0, 8)}"? This cannot be undone.`}
				confirmLabel="Delete"
				variant="danger"
				onConfirm={handleDelete}
			/>
			<ConfirmDialog
				open={showArchive}
				onOpenChange={setShowArchive}
				title="Archive thread"
				description="This thread will be hidden from the default list. You can still find it with filters."
				confirmLabel="Archive"
				onConfirm={handleArchive}
			/>
		</div>
	);
}
