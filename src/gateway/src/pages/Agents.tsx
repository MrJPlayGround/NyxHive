import { useEffect, useCallback, useMemo } from "react";
import { useAgentsStore } from "../stores/agents";
import { useWsEvent } from "../hooks/useWs";
import { AgentCard } from "../components/agents/AgentCard";
import { Skeleton } from "../components/ui/skeleton";
import { Card, CardContent } from "../components/ui/card";
import { DollarSign, Cpu, Zap } from "lucide-react";
import { formatCost, formatTokens } from "../lib/format";
import type { Frame } from "../../protocol/frame";

export function AgentsPage() {
	const { agents, loading, fetchAgents, updateAgentStatus } = useAgentsStore();

	useEffect(() => {
		fetchAgents();
	}, [fetchAgents]);

	const handleStatus = useCallback(
		(frame: Frame) => {
			const payload = frame.payload as {
				agent: string;
				status: "idle" | "running" | "error";
				task: string | null;
			};
			updateAgentStatus(payload.agent, payload.status, payload.task);
		},
		[updateAgentStatus],
	);

	useWsEvent("agent:status", handleStatus);

	const totals = useMemo(() => {
		const cost = agents.reduce((s, a) => s + a.estimatedCostCents, 0);
		const tokens = agents.reduce((s, a) => s + a.totalTokensIn + a.totalTokensOut, 0);
		const invocations = agents.reduce((s, a) => s + a.totalInvocations, 0);
		return { cost, tokens, invocations };
	}, [agents]);

	const running = agents.filter((a) => a.status === "running");
	const idle = agents.filter((a) => a.status === "idle");
	const errored = agents.filter((a) => a.status === "error");

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Agents</h1>
				<p className="mt-1 text-sm text-zinc-400">
					{agents.length} agent{agents.length !== 1 ? "s" : ""} configured
				</p>
			</div>

			{/* Summary row */}
			{!loading && agents.length > 0 && (
				<div className="grid gap-3 sm:grid-cols-3">
					<Card>
						<CardContent className="flex items-center gap-3 p-4">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
								<DollarSign className="h-4 w-4 text-emerald-400" />
							</div>
							<div>
								<p className="text-xs text-zinc-500">Total Cost</p>
								<p className="text-lg font-semibold">{formatCost(totals.cost)}</p>
							</div>
						</CardContent>
					</Card>
					<Card>
						<CardContent className="flex items-center gap-3 p-4">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
								<Cpu className="h-4 w-4 text-[var(--nyx-accent)]" />
							</div>
							<div>
								<p className="text-xs text-zinc-500">Total Tokens</p>
								<p className="text-lg font-semibold">{formatTokens(totals.tokens)}</p>
							</div>
						</CardContent>
					</Card>
					<Card>
						<CardContent className="flex items-center gap-3 p-4">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
								<Zap className="h-4 w-4 text-amber-400" />
							</div>
							<div>
								<p className="text-xs text-zinc-500">Invocations</p>
								<p className="text-lg font-semibold">{totals.invocations}</p>
							</div>
						</CardContent>
					</Card>
				</div>
			)}

			{/* Agent cards grouped by status */}
			{loading ? (
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{Array.from({ length: 3 }).map((_, i) => (
						<Skeleton key={i} className="h-48 rounded-xl" />
					))}
				</div>
			) : agents.length === 0 ? (
				<p className="py-8 text-center text-sm text-zinc-500">
					No agents configured. Check your NyxHive configuration.
				</p>
			) : (
				<div className="space-y-6">
					{running.length > 0 && (
						<div>
							<h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-amber-400">
								<div className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
								Running ({running.length})
							</h2>
							<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
								{running.map((agent) => (
									<AgentCard key={agent.id} agent={agent} />
								))}
							</div>
						</div>
					)}
					{idle.length > 0 && (
						<div>
							{running.length > 0 && (
								<h2 className="mb-3 text-sm font-semibold text-zinc-400">
									Idle ({idle.length})
								</h2>
							)}
							<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
								{idle.map((agent) => (
									<AgentCard key={agent.id} agent={agent} />
								))}
							</div>
						</div>
					)}
					{errored.length > 0 && (
						<div>
							<h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-red-400">
								<div className="h-2 w-2 rounded-full bg-red-500" />
								Error ({errored.length})
							</h2>
							<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
								{errored.map((agent) => (
									<AgentCard key={agent.id} agent={agent} />
								))}
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
