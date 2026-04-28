import { FileCode2, Folder, FolderOpen } from "lucide-react";
import { useMemo, useState } from "react";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import type { ThreadChange } from "../../lib/chat-runtime";
import { buildChangeTree, type ChangeTreeNode, uniqueThreadChanges } from "../../lib/thread-changes";
import { toDisplayPath } from "../../lib/display-path";

interface ThreadChangesPanelProps {
	changes: ThreadChange[];
	selectedPath: string | null;
	onSelectPath: (path: string) => void;
	onAttachSnippet?: (label: string, content: string) => void;
	className?: string;
}

function FileDelta({ change }: { change: ThreadChange }) {
	return (
		<div className="flex items-center gap-2 font-mono text-[10px]">
			{change.linesAdded > 0 ? <span className="text-emerald-400">+{change.linesAdded}</span> : null}
			{change.linesRemoved > 0 ? <span className="text-red-400">-{change.linesRemoved}</span> : null}
			{change.linesAdded === 0 && change.linesRemoved === 0 ? <span className="text-zinc-600">0</span> : null}
		</div>
	);
}

function ChangeNode({
	node,
	selectedPath,
	onSelectPath,
}: {
	node: ChangeTreeNode;
	selectedPath: string | null;
	onSelectPath: (path: string) => void;
}) {
	const [open, setOpen] = useState(true);
	const isSelected = node.type === "file" && node.path === selectedPath;

	if (node.type === "file" && node.change) {
		return (
			<button
				type="button"
				onClick={() => onSelectPath(node.rawPath ?? node.path)}
				className={cn(
					"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
					isSelected ? "bg-[rgb(var(--nyx-accent-rgb)/0.14)] text-zinc-100" : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200",
				)}
			>
				<FileCode2 className="h-3.5 w-3.5 shrink-0" />
				<span className="min-w-0 flex-1 truncate font-mono">{node.label}</span>
				<FileDelta change={node.change} />
			</button>
		);
	}

	return (
		<div>
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-zinc-500 hover:bg-white/[0.03] hover:text-zinc-200"
			>
				{open ? <FolderOpen className="h-3.5 w-3.5 shrink-0" /> : <Folder className="h-3.5 w-3.5 shrink-0" />}
				<span className="min-w-0 flex-1 truncate font-mono">{node.label}</span>
			</button>
			{open ? (
				<div className="ml-3 border-l border-white/6 pl-2">
					{node.children.map((child) => (
						<ChangeNode key={child.id} node={child} selectedPath={selectedPath} onSelectPath={onSelectPath} />
					))}
				</div>
			) : null}
		</div>
	);
}

export function ThreadChangesPanel({
	changes,
	selectedPath,
	onSelectPath,
	onAttachSnippet,
	className,
}: ThreadChangesPanelProps) {
	const latestChanges = useMemo(() => uniqueThreadChanges(changes), [changes]);
	const tree = useMemo(() => buildChangeTree(latestChanges), [latestChanges]);
	const selectedDisplayPath = selectedPath ? toDisplayPath(selectedPath) : null;
	const selectedChange = latestChanges.find((change) => toDisplayPath(change.filePath) === selectedDisplayPath) ?? latestChanges[0] ?? null;

	return (
		<div className={cn("flex min-h-0 flex-col overflow-hidden bg-[var(--nyx-panel-2)]", className)}>
			<div className="flex items-center justify-between border-b border-[var(--nyx-line)] px-4 py-2.5">
				<div>
					<p className="text-[13px] font-semibold text-[var(--nyx-text)]">Diff</p>
					<p className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">
						{latestChanges.length} changed file{latestChanges.length === 1 ? "" : "s"}
					</p>
				</div>
			</div>
			<div className="grid min-h-0 flex-1 grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
				<ScrollArea className="min-h-0 border-r border-[var(--nyx-line)]">
					<div className="p-2">
						{tree.length === 0 ? (
							<p className="px-2 py-3 text-xs text-zinc-500">Changed files will appear here.</p>
						) : (
							tree.map((node) => (
								<ChangeNode key={node.id} node={node} selectedPath={selectedChange ? toDisplayPath(selectedChange.filePath) : null} onSelectPath={onSelectPath} />
							))
						)}
					</div>
				</ScrollArea>
				<div className="min-h-0 overflow-hidden">
					{selectedChange ? (
						<div className="flex h-full min-h-0 flex-col">
							<div className="flex items-center justify-between border-b border-[var(--nyx-line)] px-4 py-3">
								<div className="min-w-0">
									<p className="truncate font-mono text-xs text-zinc-200">{toDisplayPath(selectedChange.filePath)}</p>
									<div className="mt-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-zinc-500">
										<span>{selectedChange.operation}</span>
										<FileDelta change={selectedChange} />
									</div>
								</div>
								{selectedChange.diffSummary && onAttachSnippet ? (
									<button
										type="button"
										onClick={() => onAttachSnippet(toDisplayPath(selectedChange.filePath), selectedChange.diffSummary ?? "")}
										className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-zinc-400 transition-colors hover:border-[rgb(var(--nyx-accent-rgb)/0.24)] hover:text-zinc-200"
									>
										Attach
									</button>
								) : null}
							</div>
							<ScrollArea className="min-h-0 flex-1">
								{selectedChange.diffSummary ? (
									<pre className="whitespace-pre-wrap px-4 py-4 font-mono text-[11px] leading-6 text-zinc-300">
										{selectedChange.diffSummary}
									</pre>
								) : (
									<div className="flex h-full items-center justify-center px-4 text-center text-xs text-zinc-500">
										No stored diff summary for this file change.
									</div>
								)}
							</ScrollArea>
						</div>
					) : (
						<div className="flex h-full items-center justify-center px-4 text-center text-xs text-zinc-500">
							Select a changed file to inspect it.
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
