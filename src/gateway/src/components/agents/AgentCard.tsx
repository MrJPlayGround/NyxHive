import { Bot } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Badge } from "../ui/badge";
import { cn } from "../../lib/utils";
import { formatTokens, formatCost, formatRelativeTime } from "../../lib/format";
import { agentStatusConfig } from "../../lib/colors";
import type { Agent } from "../../stores/agents";

export function AgentCard({ agent }: { agent: Agent }) {
	const status = agentStatusConfig[agent.status];

	return (
		<Card className="transition-colors hover:border-zinc-700">
			<CardHeader className="pb-3">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-900">
							<Bot className="h-5 w-5 text-zinc-400" />
						</div>
						<div>
							<CardTitle className="text-base">{agent.name}</CardTitle>
							<p className="text-xs text-zinc-500">{agent.role}</p>
						</div>
					</div>
					<Badge variant={status.badge} className="gap-1.5">
						<div className={cn("h-1.5 w-1.5 rounded-full", status.color)} />
						{status.label}
					</Badge>
				</div>
			</CardHeader>
			<CardContent>
				{agent.currentTask && (
					<p className="mb-3 truncate text-sm text-zinc-400">
						{agent.currentTask}
					</p>
				)}
				<div className="grid grid-cols-2 gap-3 text-sm">
					<div>
						<p className="text-xs text-zinc-500">Invocations</p>
						<p className="font-medium">{agent.totalInvocations}</p>
					</div>
					<div>
						<p className="text-xs text-zinc-500">Cost</p>
						<p className="font-medium">{formatCost(agent.estimatedCostCents)}</p>
					</div>
					<div>
						<p className="text-xs text-zinc-500">Tokens In/Out</p>
						<p className="font-medium">
							{formatTokens(agent.totalTokensIn)} / {formatTokens(agent.totalTokensOut)}
						</p>
					</div>
					<div>
						<p className="text-xs text-zinc-500">Last Active</p>
						<p className="font-medium">{formatRelativeTime(agent.lastInvokedAt)}</p>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
