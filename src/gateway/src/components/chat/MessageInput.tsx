import { useState, useRef, useCallback, useMemo } from "react";
import { uuid } from "../../lib/utils";
import { Send, Square, Paperclip, X, FileText, MessageCircleQuestion } from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ModelSelector } from "./ModelSelector";
import type { ChatAttachment, ChatModelInfo } from "../../stores/chat";
import type { SlashCommand } from "../../lib/chat-commands";
import type { TerminalSnippet } from "../../lib/chat-runtime";

interface MessageInputProps {
	onSend: (content: string, attachments?: ChatAttachment[]) => void;
	onAbort: () => void;
	onModelChange: (model?: string | null) => void;
	streaming: boolean;
	disabled: boolean;
	modelInfo: ChatModelInfo | null;
	modelLoading: boolean;
	ephemeralBtw: string | null;
	onDismissBtw: () => void;
	slashCommands: SlashCommand[];
	queuedCount: number;
	terminalSnippets: TerminalSnippet[];
	onRemoveSnippet: (snippetId: string) => void;
	placeholder?: string;
	streamingPlaceholder?: string;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const DOCUMENT_TYPES = [
	"application/pdf",
	"text/csv",
	"text/plain",
	"text/markdown",
	"text/html",
	"application/json",
];
const ALLOWED_TYPES = [...IMAGE_TYPES, ...DOCUMENT_TYPES];
const MAX_ATTACHMENTS = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const INPUT_HISTORY_MAX = 50;

function isImageType(mimeType: string): boolean {
	return IMAGE_TYPES.includes(mimeType);
}

function fileToAttachment(file: File): Promise<ChatAttachment> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result as string;
			const base64 = result.split(",")[1];
			resolve({
				id: uuid(),
				name: file.name,
				mimeType: file.type || "application/octet-stream",
				base64,
				previewUrl: isImageType(file.type) ? result : "",
			});
		};
		reader.onerror = reject;
		reader.readAsDataURL(file);
	});
}

export function MessageInput({
	onSend,
	onAbort,
	onModelChange,
	streaming,
	disabled,
	modelInfo,
	modelLoading,
	ephemeralBtw,
	onDismissBtw,
	slashCommands,
	queuedCount,
	terminalSnippets,
	onRemoveSnippet,
	placeholder = "Send a message... (Enter)",
	streamingPlaceholder = 'Steer, or "btw ..." to side-ask',
}: MessageInputProps) {
	const [value, setValue] = useState("");
	const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
	const [selectedCommandIdx, setSelectedCommandIdx] = useState(0);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const inputHistoryRef = useRef<string[]>([]);
	const inputHistoryCursorRef = useRef(-1);

	const inputMode = useMemo(() => {
		const trimmed = value.trimStart().toLowerCase();
		if (trimmed.startsWith("/")) return "command" as const;
		if (!streaming) return "send" as const;
		if (trimmed.startsWith("btw ") || trimmed === "btw") return "btw" as const;
		return "send" as const;
	}, [streaming, value]);

	// Slash command autocomplete
	const filteredCommands = useMemo(() => {
		const trimmed = value.trimStart().toLowerCase();
		if (!trimmed.startsWith("/")) return [];
		const query = trimmed.split(" ")[0];
		return slashCommands.filter((cmd) => {
			if (cmd.streamingOnly && !streaming) return false;
			return cmd.name.startsWith(query);
		});
	}, [value, slashCommands, streaming]);

	const showCommandMenu = filteredCommands.length > 0 && !value.trimStart().includes(" ");
	const estimatedTokens = value.length >= 100 ? Math.ceil(value.length / 4) : null;

	const pushInputHistory = useCallback((text: string) => {
		const trimmed = text.trim();
		if (!trimmed) return;
		const history = inputHistoryRef.current;
		if (history[history.length - 1] === trimmed) return;
		history.push(trimmed);
		if (history.length > INPUT_HISTORY_MAX) history.shift();
		inputHistoryCursorRef.current = -1;
	}, []);

	const addFiles = useCallback(async (files: FileList | File[]) => {
		const toAdd = Array.from(files).filter((f) => {
			if (f.size > MAX_FILE_SIZE) return false;
			if (ALLOWED_TYPES.includes(f.type)) return true;
			return /\.(csv|html|json|md|pdf|txt)$/i.test(f.name);
		});
		if (toAdd.length === 0) return;

		const remaining = MAX_ATTACHMENTS - attachments.length;
		const batch = toAdd.slice(0, remaining);
		const newAttachments = await Promise.all(batch.map(fileToAttachment));
		setAttachments((prev) => [...prev, ...newAttachments]);
	}, [attachments.length]);

	const removeAttachment = useCallback((id: string) => {
		setAttachments((prev) => {
			const removed = prev.find((a) => a.id === id);
			if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
			return prev.filter((a) => a.id !== id);
		});
	}, []);

	const handleSend = useCallback(() => {
		const trimmed = value.trim();
		if ((!trimmed && attachments.length === 0) || disabled) return;
		pushInputHistory(trimmed);
		onSend(trimmed, attachments.length > 0 ? attachments : undefined);
		setValue("");
		setAttachments([]);
		textareaRef.current?.focus();
	}, [value, attachments, disabled, onSend, pushInputHistory]);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (showCommandMenu) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedCommandIdx((i) => Math.min(i + 1, filteredCommands.length - 1));
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedCommandIdx((i) => Math.max(i - 1, 0));
				return;
			}
			if (e.key === "Tab") {
				e.preventDefault();
				const cmd = filteredCommands[selectedCommandIdx];
				if (cmd) {
					setValue(cmd.hasArgs ? cmd.name + " " : cmd.name);
					setSelectedCommandIdx(0);
				}
				return;
			}
			if (e.key === "Escape") {
				setValue("");
				return;
			}
		}
		if (!value.trim() && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
			const history = inputHistoryRef.current;
			if (history.length === 0) return;
			e.preventDefault();
			if (e.key === "ArrowUp") {
				inputHistoryCursorRef.current =
					inputHistoryCursorRef.current < 0
						? history.length - 1
						: Math.max(0, inputHistoryCursorRef.current - 1);
				setValue(history[inputHistoryCursorRef.current] ?? "");
				return;
			}
			if (inputHistoryCursorRef.current < 0) return;
			inputHistoryCursorRef.current += 1;
			if (inputHistoryCursorRef.current >= history.length) {
				inputHistoryCursorRef.current = -1;
				setValue("");
				return;
			}
			setValue(history[inputHistoryCursorRef.current] ?? "");
			return;
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	const handlePaste = useCallback((e: React.ClipboardEvent) => {
		const items = e.clipboardData?.items;
		if (!items) return;

		const pastedFiles: File[] = [];
		for (const item of items) {
			if (item.kind === "file") {
				const file = item.getAsFile();
				if (file) pastedFiles.push(file);
			}
		}
		if (pastedFiles.length > 0) {
			e.preventDefault();
			addFiles(pastedFiles);
		}
	}, [addFiles]);

	const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		if (e.target.files) addFiles(e.target.files);
		e.target.value = "";
	}, [addFiles]);

	const handleDrop = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
	}, [addFiles]);

	return (
		<div className="relative z-10 max-h-[45vh] shrink-0 overflow-y-auto border-t border-[var(--nyx-accent-dim)] bg-[var(--nyx-panel)] p-4" onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
			{ephemeralBtw && (
				<div className="mx-auto mb-2 max-w-6xl rounded-lg border border-[rgb(var(--nyx-accent-rgb)/0.15)] bg-[rgb(var(--nyx-accent-rgb)/0.05)] px-4 py-3">
					<div className="flex items-start justify-between gap-2">
						<div className="flex items-start gap-2 min-w-0">
							<MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0 text-[var(--nyx-accent)]" />
							<p className="text-sm text-zinc-200 whitespace-pre-wrap">{ephemeralBtw}</p>
						</div>
						<button
							type="button"
							onClick={onDismissBtw}
							className="shrink-0 rounded p-0.5 text-zinc-500 hover:text-zinc-300"
						>
							<X className="h-3.5 w-3.5" />
						</button>
					</div>
				</div>
			)}
			{attachments.length > 0 && (
				<div className="mx-auto mb-2 flex max-w-6xl gap-2 overflow-x-auto">
					{attachments.map((att) => (
						<div key={att.id} className="relative shrink-0">
							{IMAGE_TYPES.includes(att.mimeType) ? (
								<img
									src={att.previewUrl}
									alt={att.name}
									className="h-16 w-16 rounded-md object-cover border border-zinc-700"
								/>
							) : (
								<div className="flex h-16 items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800/50 px-3">
									<FileText className="h-5 w-5 shrink-0 text-[var(--nyx-accent)]" />
									<span className="max-w-[120px] truncate text-xs text-zinc-300">{att.name}</span>
								</div>
							)}
							<button
								type="button"
								onClick={() => removeAttachment(att.id)}
								className="absolute -right-1 -top-1 rounded-full bg-zinc-800 p-0.5 text-zinc-400 hover:text-zinc-200"
							>
								<X className="h-3 w-3" />
							</button>
						</div>
					))}
				</div>
			)}
			{terminalSnippets.length > 0 && (
				<div className="mx-auto mb-2 max-w-6xl rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2">
					<div className="mb-2 flex items-center gap-2">
						<span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">Terminal context</span>
						<span className="text-[11px] text-zinc-400">{terminalSnippets.length} snippet{terminalSnippets.length === 1 ? "" : "s"} will be injected</span>
					</div>
					<div className="flex flex-wrap gap-1.5">
						{terminalSnippets.map((snippet) => (
							<div
								key={snippet.id}
								className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-zinc-300"
							>
								<span className="font-mono">{snippet.label}</span>
								<span className="text-zinc-500">
									{snippet.lineStart === snippet.lineEnd
										? `L${snippet.lineStart}`
										: `L${snippet.lineStart}-${snippet.lineEnd}`}
								</span>
								<button
									type="button"
									onClick={() => onRemoveSnippet(snippet.id)}
									className="rounded p-0.5 text-zinc-500 hover:text-zinc-200"
								>
									<X className="h-3 w-3" />
								</button>
							</div>
						))}
					</div>
				</div>
			)}
			{streaming && inputMode === "btw" && (
				<div className="mx-auto mb-1.5 flex max-w-6xl min-w-0 flex-wrap items-center gap-1.5 px-0 sm:px-11">
					<MessageCircleQuestion className="h-3 w-3 shrink-0 text-[var(--nyx-accent)]" />
					<span className="min-w-0 text-[11px] text-[var(--nyx-accent)]">Side question — won't interrupt the agent</span>
				</div>
			)}
			{queuedCount > 0 && (
				<div className="mx-auto mb-1.5 flex max-w-6xl min-w-0 flex-wrap items-center gap-1.5 px-0 sm:px-11">
					<span className="min-w-0 text-[11px] text-zinc-400">{queuedCount} message{queuedCount > 1 ? "s" : ""} queued — will send when agent finishes</span>
				</div>
			)}
			{showCommandMenu && (
				<div className="mx-auto mb-1 max-w-6xl min-w-0 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-lg">
					{filteredCommands.map((cmd, i) => (
						<button
							key={cmd.name}
							type="button"
							className={`flex w-full min-w-0 items-center gap-3 px-3 py-1.5 text-left text-sm ${
								i === selectedCommandIdx ? "bg-[rgb(var(--nyx-accent-rgb)/0.12)] text-zinc-100" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
							}`}
							onMouseDown={(e) => {
								e.preventDefault();
								setValue(cmd.hasArgs ? cmd.name + " " : cmd.name);
								setSelectedCommandIdx(0);
								if (!cmd.hasArgs) {
									onSend(cmd.name);
									setValue("");
								}
								textareaRef.current?.focus();
							}}
							onMouseEnter={() => setSelectedCommandIdx(i)}
						>
							<span className="shrink-0 font-mono text-xs text-[var(--nyx-accent)]">{cmd.name}</span>
							<span className="min-w-0 truncate text-xs text-zinc-500">{cmd.description}</span>
						</button>
					))}
				</div>
			)}
			<div className="mx-auto flex max-w-6xl min-w-0 gap-2">
				<input
					ref={fileInputRef}
					type="file"
					accept={[...ALLOWED_TYPES, ".csv", ".md", ".json", ".txt", ".pdf"].join(",")}
					multiple
					onChange={handleFileSelect}
					className="hidden"
				/>
				<Button
					variant="ghost"
					size="icon"
					onClick={() => fileInputRef.current?.click()}
					disabled={disabled || streaming || attachments.length >= MAX_ATTACHMENTS}
					className="shrink-0 self-end text-zinc-400 hover:text-zinc-200"
				>
					<Paperclip className="h-4 w-4" />
				</Button>
				<Textarea
					ref={textareaRef}
					value={value}
					onChange={(e) => { setValue(e.target.value); setSelectedCommandIdx(0); inputHistoryCursorRef.current = -1; }}
					onKeyDown={handleKeyDown}
					onPaste={handlePaste}
					placeholder={streaming ? streamingPlaceholder : placeholder}
					className="min-h-[44px] max-h-[200px] min-w-0 flex-1 resize-none overflow-y-auto"
					disabled={disabled}
					rows={1}
				/>
				{streaming && (
					<Button
						variant="destructive"
						size="icon"
						onClick={() => onAbort()}
						className="shrink-0 self-end"
						title="Stop"
					>
						<Square className="h-4 w-4" />
					</Button>
				)}
				<Button
					size="icon"
					onClick={handleSend}
					disabled={(!value.trim() && attachments.length === 0) || disabled}
					className={`shrink-0 self-end ${streaming && inputMode === "btw" ? "bg-[var(--nyx-accent)] hover:bg-[var(--nyx-accent)]" : ""}`}
					title={streaming && inputMode === "btw" ? "Ask side question" : "Send"}
				>
					{streaming && inputMode === "btw" ? (
						<MessageCircleQuestion className="h-4 w-4" />
					) : (
						<Send className="h-4 w-4" />
					)}
				</Button>
			</div>
			<div className="mx-auto mt-2 flex max-w-6xl min-w-0 flex-wrap items-center gap-2 px-0 sm:px-11">
				<ModelSelector
					modelInfo={modelInfo}
					loading={modelLoading}
					disabled={disabled || streaming}
					onSelect={onModelChange}
				/>
				{modelInfo ? (
					<span className="text-[11px] text-zinc-500">
						{modelInfo.overridden ? "Thread override active" : "Agent default"}
					</span>
				) : null}
				<span className="ml-auto hidden text-[11px] text-zinc-600 sm:inline">
					Enter sends · Shift+Enter newline · ↑ recalls
				</span>
				{estimatedTokens ? (
					<span className="text-[11px] tabular-nums text-zinc-500">
						~{estimatedTokens} tokens
					</span>
				) : null}
			</div>
		</div>
	);
}
