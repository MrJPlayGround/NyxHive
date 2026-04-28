import { useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useThreadsStore } from "../stores/threads";
import { usePagination } from "../hooks/usePagination";
import { useWsEvent } from "../hooks/useWs";
import type { Frame } from "../../protocol/frame";
import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";
import { Input } from "../components/ui/input";
import { Pagination } from "../components/ui/pagination";
import { formatDate, formatTokens, formatCost } from "../lib/format";
import { threadStatusColors } from "../lib/colors";

export function ThreadsPage() {
	const { filters, setFilter, fetchThreads } = useThreadsStore();
	const navigate = useNavigate();

	const fetcher = useCallback(
		(offset: number, limit: number) => fetchThreads(offset, limit),
		[fetchThreads],
	);

	const pag = usePagination(fetcher, 50);

	const handleThreadUpdate = useCallback(
		(frame: Frame) => {
			const payload = frame.payload as { threadId?: string; status?: string; title?: string };
			if (!payload.threadId) return;
			pag.fetch();
		},
		[pag],
	);
	useWsEvent("thread:update", handleThreadUpdate);

	useEffect(() => {
		pag.fetch();
	}, [pag.fetch]);

	// Refetch on filter change — use resetAndFetch to avoid stale page race
	useEffect(() => {
		pag.resetAndFetch();
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [filters.agent, filters.project, filters.status]);

	return (
		<div>
			<h1 className="text-2xl font-semibold">Threads</h1>
			<p className="mt-1 text-sm text-zinc-400">
				{pag.total !== null ? `${pag.total} conversation${pag.total !== 1 ? "s" : ""}` : "Conversations"}
			</p>

			<div className="mt-4 flex gap-2">
				<Input
					placeholder="Filter by agent..."
					value={filters.agent}
					onChange={(e) => setFilter("agent", e.target.value)}
					className="max-w-[200px]"
				/>
				<Input
					placeholder="Filter by project..."
					value={filters.project}
					onChange={(e) => setFilter("project", e.target.value)}
					className="max-w-[200px]"
				/>
			</div>

			<div className="mt-4">
				{pag.loading ? (
					<div className="space-y-2">
						{Array.from({ length: 5 }).map((_, i) => (
							<Skeleton key={i} className="h-14 rounded-lg" />
						))}
					</div>
				) : pag.items.length === 0 ? (
					<p className="py-8 text-center text-sm text-zinc-500">
						No threads found
					</p>
				) : (
					<div className="overflow-hidden rounded-lg border border-zinc-800">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-zinc-800 bg-zinc-900/50">
									<th className="px-4 py-3 text-left font-medium text-zinc-400">Title</th>
									<th className="px-4 py-3 text-left font-medium text-zinc-400">Agent</th>
									<th className="px-4 py-3 text-left font-medium text-zinc-400">Status</th>
									<th className="px-4 py-3 text-right font-medium text-zinc-400">Tokens</th>
									<th className="px-4 py-3 text-right font-medium text-zinc-400">Cost</th>
									<th className="px-4 py-3 text-right font-medium text-zinc-400">Created</th>
								</tr>
							</thead>
							<tbody>
								{pag.items.map((thread) => (
									<tr
										key={thread.id}
										onClick={() => navigate(`/threads/${thread.id}`)}
										className="cursor-pointer border-b border-zinc-800/50 transition-colors hover:bg-zinc-900/50 last:border-0"
									>
										<td className="max-w-[300px] truncate px-4 py-3 font-medium">
											{thread.title || thread.id.slice(0, 8)}
										</td>
										<td className="px-4 py-3 text-zinc-400">{thread.agent}</td>
										<td className="px-4 py-3">
											<Badge variant="outline" className={threadStatusColors[thread.status] ?? threadStatusColors.created}>
												{thread.status}
											</Badge>
										</td>
										<td className="px-4 py-3 text-right tabular-nums text-zinc-400">
											{formatTokens(thread.tokensIn + thread.tokensOut)}
										</td>
										<td className="px-4 py-3 text-right tabular-nums text-zinc-400">
											{formatCost(thread.costCents, false)}
										</td>
										<td className="px-4 py-3 text-right text-zinc-500">
											{formatDate(thread.createdAt)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}

				{pag.items.length > 0 && (
					<Pagination
						page={pag.page}
						totalPages={pag.totalPages}
						total={pag.total}
						pageSize={pag.pageSize}
						loading={pag.loading}
						onNext={pag.nextPage}
						onPrev={pag.prevPage}
						onPageSizeChange={pag.setPageSize}
					/>
				)}
			</div>
		</div>
	);
}
