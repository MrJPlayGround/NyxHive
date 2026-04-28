import { useCallback, useEffect, useState, useMemo } from "react";
import { useVisibilityRefresh } from "../hooks/useVisibilityRefresh";
import { Card, CardContent } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";
import { formatCost, formatDuration } from "../lib/format";
import { gateway } from "../lib/ws";
import {
	Cpu,
	TrendingUp,
	Clock,
	DollarSign,
	ArrowUpDown,
	ChevronDown,
} from "lucide-react";

interface SuccessRate {
	model: string;
	task_type: string;
	total: number;
	completed: number;
	failed: number;
	success_rate: number;
	avg_cost: number;
	avg_duration_ms: number;
}

type SortKey = "success_rate" | "avg_cost" | "avg_duration_ms" | "total";
type SortDir = "asc" | "desc";

const timeWindows = [
	{ value: 24, label: "24h" },
	{ value: 168, label: "7d" },
	{ value: 720, label: "30d" },
];

function rateColor(rate: number): string {
	if (rate >= 95) return "text-emerald-400";
	if (rate >= 80) return "text-amber-400";
	return "text-red-400";
}

function rateBg(rate: number): string {
	if (rate >= 95) return "bg-emerald-500/10";
	if (rate >= 80) return "bg-amber-500/10";
	return "bg-red-500/10";
}

/** Short model display name */
function shortModel(model: string): string {
	return model
		.replace("claude-", "")
		.replace("-20250514", "")
		.replace("-20241022", "")
		.replace("-20250219", "")
		.replace("-latest", "");
}

export function ModelsPage() {
	const [data, setData] = useState<SuccessRate[]>([]);
	const [loading, setLoading] = useState(true);
	const [hours, setHours] = useState(168);
	const [sortKey, setSortKey] = useState<SortKey>("total");
	const [sortDir, setSortDir] = useState<SortDir>("desc");
	const [taskFilter, setTaskFilter] = useState("");

	useEffect(() => {
		setLoading(true);
		gateway
			.request<{ success_rates: SuccessRate[] }>("usage.routing", { hours })
			.then((res) => setData(res.success_rates))
			.finally(() => setLoading(false));
	}, [hours]);

	useVisibilityRefresh(useCallback(() => {
		setLoading(true);
		gateway
			.request<{ success_rates: SuccessRate[] }>("usage.routing", { hours })
			.then((res) => setData(res.success_rates))
			.finally(() => setLoading(false));
	}, [hours]));

	const taskTypes = useMemo(
		() => [...new Set(data.map((r) => r.task_type))].sort(),
		[data],
	);

	const filtered = useMemo(() => {
		let rows = taskFilter ? data.filter((r) => r.task_type === taskFilter) : data;
		rows = [...rows].sort((a, b) => {
			const av = a[sortKey];
			const bv = b[sortKey];
			return sortDir === "desc" ? (bv as number) - (av as number) : (av as number) - (bv as number);
		});
		return rows;
	}, [data, taskFilter, sortKey, sortDir]);

	const totals = useMemo(() => {
		const models = new Set(data.map((r) => r.model));
		const tasks = new Set(data.map((r) => r.task_type));
		const totalInvocations = data.reduce((s, r) => s + r.total, 0);
		const weightedRate =
			totalInvocations > 0
				? data.reduce((s, r) => s + r.success_rate * r.total, 0) / totalInvocations
				: 0;
		return {
			models: models.size,
			tasks: tasks.size,
			invocations: totalInvocations,
			avgRate: Math.round(weightedRate * 10) / 10,
		};
	}, [data]);

	function handleSort(key: SortKey) {
		if (sortKey === key) {
			setSortDir((d) => (d === "desc" ? "asc" : "desc"));
		} else {
			setSortKey(key);
			setSortDir("desc");
		}
	}

	const SortHeader = ({ label, field }: { label: string; field: SortKey }) => (
		<button
			type="button"
			onClick={() => handleSort(field)}
			className={cn(
				"flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider",
				sortKey === field ? "text-[var(--nyx-accent)]" : "text-zinc-500 hover:text-zinc-300",
			)}
		>
			{label}
			{sortKey === field ? (
				<ChevronDown
					className={cn("h-3 w-3 transition-transform", sortDir === "asc" && "rotate-180")}
				/>
			) : (
				<ArrowUpDown className="h-3 w-3 opacity-40" />
			)}
		</button>
	);

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Models</h1>
				<p className="mt-1 text-sm text-zinc-400">
					Performance scorecard by model and task type
				</p>
			</div>

			{/* Summary cards */}
			{!loading && data.length > 0 && (
				<div className="grid gap-3 sm:grid-cols-4">
					<Card>
						<CardContent className="flex items-center gap-3 p-4">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
								<Cpu className="h-4 w-4 text-[var(--nyx-accent)]" />
							</div>
							<div>
								<p className="text-xs text-zinc-500">Models</p>
								<p className="text-lg font-semibold">{totals.models}</p>
							</div>
						</CardContent>
					</Card>
					<Card>
						<CardContent className="flex items-center gap-3 p-4">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
								<TrendingUp className="h-4 w-4 text-emerald-400" />
							</div>
							<div>
								<p className="text-xs text-zinc-500">Avg Success</p>
								<p className={cn("text-lg font-semibold", rateColor(totals.avgRate))}>
									{totals.avgRate}%
								</p>
							</div>
						</CardContent>
					</Card>
					<Card>
						<CardContent className="flex items-center gap-3 p-4">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
								<Clock className="h-4 w-4 text-[var(--nyx-accent)]" />
							</div>
							<div>
								<p className="text-xs text-zinc-500">Task Types</p>
								<p className="text-lg font-semibold">{totals.tasks}</p>
							</div>
						</CardContent>
					</Card>
					<Card>
						<CardContent className="flex items-center gap-3 p-4">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
								<DollarSign className="h-4 w-4 text-amber-400" />
							</div>
							<div>
								<p className="text-xs text-zinc-500">Invocations</p>
								<p className="text-lg font-semibold">{totals.invocations.toLocaleString()}</p>
							</div>
						</CardContent>
					</Card>
				</div>
			)}

			{/* Filters row */}
			<div className="flex flex-wrap items-center gap-3">
				{/* Time window */}
				<div className="flex gap-1 rounded-lg bg-zinc-900/50 p-1">
					{timeWindows.map((w) => (
						<button
							key={w.value}
							type="button"
							onClick={() => setHours(w.value)}
							className={cn(
								"rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
								hours === w.value
									? "bg-[rgb(var(--nyx-accent-rgb)/0.12)] text-[var(--nyx-accent)]"
									: "text-zinc-500 hover:text-zinc-300",
							)}
						>
							{w.label}
						</button>
					))}
				</div>

				{/* Task type filter */}
				{taskTypes.length > 1 && (
					<div className="flex gap-1 rounded-lg bg-zinc-900/50 p-1">
						<button
							type="button"
							onClick={() => setTaskFilter("")}
							className={cn(
								"rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
								taskFilter === ""
									? "bg-[rgb(var(--nyx-accent-rgb)/0.12)] text-[var(--nyx-accent)]"
									: "text-zinc-500 hover:text-zinc-300",
							)}
						>
							All tasks
						</button>
						{taskTypes.map((t) => (
							<button
								key={t}
								type="button"
								onClick={() => setTaskFilter(t)}
								className={cn(
									"rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
									taskFilter === t
										? "bg-[rgb(var(--nyx-accent-rgb)/0.12)] text-[var(--nyx-accent)]"
										: "text-zinc-500 hover:text-zinc-300",
								)}
							>
								{t}
							</button>
						))}
					</div>
				)}
			</div>

			{/* Table */}
			{loading ? (
				<div className="space-y-2">
					{Array.from({ length: 8 }).map((_, i) => (
						<Skeleton key={i} className="h-12 rounded-lg" />
					))}
				</div>
			) : filtered.length === 0 ? (
				<p className="py-12 text-center text-sm text-zinc-500">
					No model data yet. Data appears after agents process tasks.
				</p>
			) : (
				<Card>
					<div className="overflow-x-auto">
						<table className="w-full">
							<thead>
								<tr className="border-b border-zinc-800/60">
									<th className="px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-zinc-500">
										Model
									</th>
									<th className="px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-zinc-500">
										Task Type
									</th>
									<th className="px-4 py-3 text-right">
										<SortHeader label="Success" field="success_rate" />
									</th>
									<th className="px-4 py-3 text-right">
										<SortHeader label="Invocations" field="total" />
									</th>
									<th className="px-4 py-3 text-right">
										<SortHeader label="Avg Cost" field="avg_cost" />
									</th>
									<th className="px-4 py-3 text-right">
										<SortHeader label="Avg Duration" field="avg_duration_ms" />
									</th>
								</tr>
							</thead>
							<tbody>
								{filtered.map((row) => (
									<tr
										key={`${row.model}-${row.task_type}`}
										className="border-b border-zinc-800/30 hover:bg-zinc-900/30 transition-colors"
									>
										<td className="px-4 py-3">
											<span className="text-sm font-medium text-zinc-200">
												{shortModel(row.model)}
											</span>
										</td>
										<td className="px-4 py-3">
											<span className="rounded bg-zinc-800/60 px-2 py-0.5 text-xs text-zinc-400">
												{row.task_type}
											</span>
										</td>
										<td className="px-4 py-3 text-right">
											<span
												className={cn(
													"inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
													rateBg(row.success_rate),
													rateColor(row.success_rate),
												)}
											>
												{row.success_rate}%
											</span>
											<span className="ml-2 text-[10px] text-zinc-600">
												{row.completed}/{row.total}
											</span>
										</td>
										<td className="px-4 py-3 text-right text-sm text-zinc-300">
											{row.total}
										</td>
										<td className="px-4 py-3 text-right text-sm text-zinc-300">
											{formatCost(row.avg_cost * 100)}
										</td>
										<td className="px-4 py-3 text-right text-sm text-zinc-300">
											{formatDuration(row.avg_duration_ms)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</Card>
			)}
		</div>
	);
}
