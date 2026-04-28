import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
	Activity,
	ArrowRight,
	Bot,
	CheckCircle,
	Clock,
	DollarSign,
	GitBranch,
	Layers,
	MemoryStick,
	MessageSquare,
	Play,
	Wifi,
} from "lucide-react";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { useWsRequest } from "../hooks/useWs";
import { useProposalsStore } from "../stores/proposals";
import { useAgentsStore } from "../stores/agents";
import type { Thread } from "../stores/threads";
import { cn } from "../lib/utils";
import { formatBytes, formatCost, formatRelativeTime, formatTokens, formatUptime } from "../lib/format";
import { categoryTextColors } from "../lib/colors";
import type { Health } from "../lib/types";


const ATTENTION_STATUSES = new Set(["proposed", "reviewed"]);

export function TransactionPage() {
	const request = useWsRequest();
	const proposals = useProposalsStore((s) => s.proposals);
	const approve = useProposalsStore((s) => s.approve);
	const reject = useProposalsStore((s) => s.reject);
	const agents = useAgentsStore((s) => s.agents);

	const [health, setHealth] = useState<Health | null>(null);
	const [healthLoading, setHealthLoading] = useState(true);
	const [threadsLoading, setThreadsLoading] = useState(true);
	const [threads, setThreads] = useState<Thread[]>([]);

	const loadSurface = useCallback(async () => {
		setHealthLoading(true);
		setThreadsLoading(true);
		try {
			const [nextHealth, threadResult] = await Promise.all([
				request<Health>("system.health"),
				request<{ threads: Thread[] }>("threads.list", { limit: 8, offset: 0 }),
			]);
			setHealth(nextHealth);
			setThreads(threadResult.threads ?? []);
		} catch {
			// Keep the surface resilient. Layout already handles auth/connectivity.
		} finally {
			setHealthLoading(false);
			setThreadsLoading(false);
		}
	}, [request]);

	useEffect(() => {
		void loadSurface();
	}, [loadSurface]);

	const attention = useMemo(
		() =>
			proposals
				.filter((proposal) => ATTENTION_STATUSES.has(proposal.status))
				.sort((a, b) => b.createdAt - a.createdAt)
				.slice(0, 6),
		[proposals],
	);

	const completions = useMemo(
		() =>
			proposals
				.filter((proposal) => proposal.status === "completed" || proposal.status === "merged")
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.slice(0, 4),
		[proposals],
	);

	const activeAgents = useMemo(
		() => agents.filter((agent) => agent.status === "running" || agent.status === "error"),
		[agents],
	);

	const spendCents = agents.reduce((sum, agent) => sum + agent.estimatedCostCents, 0);
	const threadTokens = threads.reduce((sum, thread) => sum + thread.tokensIn + thread.tokensOut, 0);
	const completedCount = proposals.filter((proposal) => proposal.status === "completed" || proposal.status === "merged").length;

	const statCards = health
		? [
				{ label: "Uptime", value: formatUptime(health.uptime), icon: Clock, tone: "text-[var(--nyx-accent)]", chrome: "bg-[var(--nyx-accent-dim)]" },
				{ label: "Queue", value: String(health.queueDepth), icon: Layers, tone: "text-sky-300", chrome: "bg-sky-500/12" },
				{ label: "Connections", value: String(health.activeConnections), icon: Wifi, tone: "text-emerald-300", chrome: "bg-emerald-500/12" },
				{ label: "Memory", value: formatBytes(health.memoryUsage), icon: MemoryStick, tone: "text-amber-300", chrome: "bg-amber-500/12" },
				{ label: "Spend", value: formatCost(spendCents), icon: DollarSign, tone: "text-rose-300", chrome: "bg-rose-500/12" },
			]
		: [];

	return (
		<div className="space-y-6">
			<section className="transaction-surface relative overflow-hidden rounded-[28px] border border-white/8 px-5 py-5 sm:px-6 sm:py-6">
				<div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgb(var(--nyx-accent-rgb)/0.22),transparent_32%),radial-gradient(circle_at_bottom_right,rgba(34,197,94,0.12),transparent_28%)]" />
				<div className="relative">
					<div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
						<div className="max-w-3xl space-y-3">
							<div className="flex flex-wrap items-center gap-2">
								<Badge variant="outline" className="border-[rgb(var(--nyx-accent-rgb)/0.25)] bg-[rgb(var(--nyx-accent-rgb)/0.08)] text-[var(--nyx-accent)]">
									Gateway V2
								</Badge>
								<Badge variant="outline" className="border-emerald-400/25 bg-emerald-500/10 text-emerald-200">
									Transaction phase
								</Badge>
							</div>
							<div>
								<h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Operate from the flow, not from the file cabinet.</h1>
								<p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-300 sm:text-base">
									This is the parallel v2 surface. Current Gateway pages stay intact while we tighten the operator loop:
									see pressure, switch threads, approve work, and track live execution from one place.
								</p>
							</div>
						</div>
						<div className="flex flex-wrap gap-2">
							<Button asChild>
								<Link to="/chat">
									<MessageSquare className="h-4 w-4" />
									Open chat
								</Link>
							</Button>
							<Button asChild variant="outline">
								<Link to="/work">
									<Play className="h-4 w-4" />
									Review work
								</Link>
							</Button>
							<Button asChild variant="ghost" className="text-zinc-300 hover:bg-white/5">
								<Link to="/threads">
									<GitBranch className="h-4 w-4" />
									Browse threads
								</Link>
							</Button>
						</div>
					</div>

					<div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
						<div className="rounded-2xl border border-white/8 bg-black/15 p-4 backdrop-blur-sm">
							<p className="text-xs uppercase tracking-[0.22em] text-zinc-500">Attention</p>
							<p className="mt-3 text-3xl font-semibold">{attention.length}</p>
							<p className="mt-1 text-sm text-zinc-400">Pending approvals or reviews waiting on you.</p>
						</div>
						<div className="rounded-2xl border border-white/8 bg-black/15 p-4 backdrop-blur-sm">
							<p className="text-xs uppercase tracking-[0.22em] text-zinc-500">Live agents</p>
							<p className="mt-3 text-3xl font-semibold">{activeAgents.length}</p>
							<p className="mt-1 text-sm text-zinc-400">Running or faulted agents surfaced directly in the rail below.</p>
						</div>
						<div className="rounded-2xl border border-white/8 bg-black/15 p-4 backdrop-blur-sm">
							<p className="text-xs uppercase tracking-[0.22em] text-zinc-500">Recent context</p>
							<p className="mt-3 text-3xl font-semibold">{formatTokens(threadTokens)}</p>
							<p className="mt-1 text-sm text-zinc-400">Tokens across the most recent thread slice.</p>
						</div>
						<div className="rounded-2xl border border-white/8 bg-black/15 p-4 backdrop-blur-sm">
							<p className="text-xs uppercase tracking-[0.22em] text-zinc-500">Completed</p>
							<p className="mt-3 text-3xl font-semibold">{completedCount}</p>
							<p className="mt-1 text-sm text-zinc-400">Completed or merged proposals currently on record.</p>
						</div>
					</div>
				</div>
			</section>

			<div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.95fr)]">
				<div className="space-y-6">
					<Card className="overflow-hidden border-white/8 bg-zinc-950/65">
						<CardContent className="p-0">
							<div className="flex items-center justify-between border-b border-white/6 px-5 py-4">
								<div>
									<p className="text-sm font-medium text-zinc-100">Attention queue</p>
									<p className="mt-1 text-sm text-zinc-500">Approve, reject, or leave things queued. No context switching required.</p>
								</div>
								<Button asChild variant="ghost" size="sm" className="text-zinc-300">
									<Link to="/work">
										See all
										<ArrowRight className="h-4 w-4" />
									</Link>
								</Button>
							</div>

							<div className="divide-y divide-white/6">
								{attention.length === 0 && (
									<div className="px-5 py-10 text-center text-sm text-zinc-500">
										Nothing backed up. The queue is clear.
									</div>
								)}
								{attention.map((proposal) => (
									<div key={proposal.id} className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
										<div className="min-w-0">
											<div className="flex flex-wrap items-center gap-2">
												<span className="truncate font-medium text-zinc-100">{proposal.title}</span>
												<Badge variant="outline" className="border-white/8 bg-white/4 text-zinc-300">
													{proposal.status}
												</Badge>
											</div>
											<div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
												<span className={cn("font-medium", categoryTextColors[proposal.category])}>{proposal.category}</span>
												<span>{proposal.effort}</span>
												<span>{proposal.priority}</span>
												<span>{formatRelativeTime(proposal.createdAt)}</span>
											</div>
										</div>
										<div className="flex shrink-0 gap-2">
											<Button size="sm" variant="ghost" className="text-emerald-300 hover:bg-emerald-500/10" onClick={() => approve(proposal.id)}>
												Approve
											</Button>
											<Button size="sm" variant="ghost" className="text-rose-300 hover:bg-rose-500/10" onClick={() => reject(proposal.id)}>
												Reject
											</Button>
										</div>
									</div>
								))}
							</div>
						</CardContent>
					</Card>

					<Card className="border-white/8 bg-zinc-950/65">
						<CardContent className="p-5">
							<div className="flex items-center justify-between">
								<div>
									<p className="text-sm font-medium text-zinc-100">Execution rail</p>
									<p className="mt-1 text-sm text-zinc-500">Treat agent activity like transactions moving through the system.</p>
								</div>
								<Button asChild variant="ghost" size="sm" className="text-zinc-300">
									<Link to="/agents">
										Agent view
										<ArrowRight className="h-4 w-4" />
									</Link>
								</Button>
							</div>

							<div className="mt-4 grid gap-3 lg:grid-cols-2">
								{activeAgents.length === 0 && (
									<div className="rounded-2xl border border-dashed border-white/8 px-4 py-8 text-center text-sm text-zinc-500 lg:col-span-2">
										No active agents right now.
									</div>
								)}
								{activeAgents.map((agent) => (
									<div key={agent.id} className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
										<div className="flex items-center gap-3">
											<div className={cn(
												"flex h-10 w-10 items-center justify-center rounded-2xl border",
												agent.status === "error"
													? "border-rose-500/30 bg-rose-500/10 text-rose-300"
													: "border-amber-500/30 bg-amber-500/10 text-amber-300",
											)}>
												<Bot className="h-4 w-4" />
											</div>
											<div className="min-w-0 flex-1">
												<div className="flex items-center gap-2">
													<p className="truncate font-medium text-zinc-100">{agent.name}</p>
													<Badge
														variant="outline"
														className={cn(
															"border-white/8 text-xs",
															agent.status === "error" ? "bg-rose-500/10 text-rose-200" : "bg-amber-500/10 text-amber-200",
														)}
													>
														{agent.status}
													</Badge>
												</div>
												<p className="mt-1 truncate text-sm text-zinc-500">{agent.currentTask ?? "Awaiting next transaction"}</p>
											</div>
										</div>
										<div className="mt-4 flex items-center justify-between text-xs text-zinc-500">
											<span>{formatTokens(agent.totalTokensIn + agent.totalTokensOut)} tokens</span>
											<span>{formatCost(agent.estimatedCostCents)}</span>
										</div>
									</div>
								))}
							</div>
						</CardContent>
					</Card>
				</div>

				<div className="space-y-6">
					<Card className="border-white/8 bg-zinc-950/65">
						<CardContent className="p-5">
							<div className="flex items-center justify-between">
								<div>
									<p className="text-sm font-medium text-zinc-100">System pulse</p>
									<p className="mt-1 text-sm text-zinc-500">Operational state in one glance.</p>
								</div>
								<Activity className="h-4 w-4 text-[var(--nyx-accent)]" />
							</div>

							<div className="mt-4 grid gap-3 sm:grid-cols-2">
								{healthLoading && Array.from({ length: 4 }).map((_, index) => (
									<Skeleton key={index} className="h-24 rounded-2xl" />
								))}
								{!healthLoading && statCards.map(({ label, value, icon: Icon, tone, chrome }) => (
									<div key={label} className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
										<div className={cn("flex h-10 w-10 items-center justify-center rounded-2xl border border-white/6", chrome)}>
											<Icon className={cn("h-4 w-4", tone)} />
										</div>
										<p className="mt-4 text-xs uppercase tracking-[0.2em] text-zinc-500">{label}</p>
										<p className="mt-1 text-xl font-semibold text-zinc-100">{value}</p>
									</div>
								))}
							</div>
						</CardContent>
					</Card>

					<Card className="border-white/8 bg-zinc-950/65">
						<CardContent className="p-5">
							<div className="flex items-center justify-between">
								<div>
									<p className="text-sm font-medium text-zinc-100">Recent threads</p>
									<p className="mt-1 text-sm text-zinc-500">Stay near the conversations with the most recent motion.</p>
								</div>
								<Button asChild variant="ghost" size="sm" className="text-zinc-300">
									<Link to="/threads">
										Directory
										<ArrowRight className="h-4 w-4" />
									</Link>
								</Button>
							</div>

							<div className="mt-4 space-y-2">
								{threadsLoading && Array.from({ length: 4 }).map((_, index) => (
									<Skeleton key={index} className="h-18 rounded-2xl" />
								))}
								{!threadsLoading && threads.length === 0 && (
									<div className="rounded-2xl border border-dashed border-white/8 px-4 py-8 text-center text-sm text-zinc-500">
										No recent threads yet.
									</div>
								)}
								{threads.map((thread) => (
									<Link
										key={thread.id}
										to={`/threads/${thread.id}`}
										className="block rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 transition-colors hover:border-[rgb(var(--nyx-accent-rgb)/0.15)] hover:bg-[rgb(var(--nyx-accent-rgb)/0.06)]"
									>
										<div className="flex items-start justify-between gap-3">
											<div className="min-w-0">
												<p className="truncate font-medium text-zinc-100">{thread.title || thread.id.slice(0, 8)}</p>
												<p className="mt-1 truncate text-sm text-zinc-500">{thread.project || thread.agent}</p>
											</div>
											<Badge variant="outline" className="border-white/8 bg-white/4 text-zinc-300">
												{thread.status}
											</Badge>
										</div>
										<div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
											<span>{thread.agent}</span>
											<span>{formatTokens(thread.tokensIn + thread.tokensOut)} tokens</span>
											<span>{formatCost(thread.costCents, false)}</span>
											<span>{formatRelativeTime(thread.updatedAt)}</span>
										</div>
									</Link>
								))}
							</div>
						</CardContent>
					</Card>

					<Card className="border-white/8 bg-zinc-950/65">
						<CardContent className="p-5">
							<div className="flex items-center justify-between">
								<div>
									<p className="text-sm font-medium text-zinc-100">Recently landed</p>
									<p className="mt-1 text-sm text-zinc-500">Keep closure visible so the dashboard does not become a pure alarm panel.</p>
								</div>
								<CheckCircle className="h-4 w-4 text-emerald-300" />
							</div>
							<div className="mt-4 space-y-2">
								{completions.length === 0 && (
									<div className="rounded-2xl border border-dashed border-white/8 px-4 py-8 text-center text-sm text-zinc-500">
										No completed proposals yet.
									</div>
								)}
								{completions.map((proposal) => (
									<div key={proposal.id} className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
										<div className="flex items-center justify-between gap-3">
											<div className="min-w-0">
												<p className="truncate font-medium text-zinc-100">{proposal.title}</p>
												<p className="mt-1 text-xs text-zinc-500">{formatRelativeTime(proposal.updatedAt)}</p>
											</div>
											<Badge variant="outline" className="border-emerald-400/25 bg-emerald-500/10 text-emerald-200">
												{proposal.status}
											</Badge>
										</div>
									</div>
								))}
							</div>
						</CardContent>
					</Card>
				</div>
			</div>
		</div>
	);
}
