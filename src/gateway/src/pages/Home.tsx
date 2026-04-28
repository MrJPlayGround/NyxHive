import { useEffect, useCallback } from "react";
import { useWsRequest, useWsEvent } from "../hooks/useWs";
import { useProposalsStore } from "../stores/proposals";
import { useAgentsStore } from "../stores/agents";
import { useAuthStore } from "../stores/auth";
import { useActivityFeedStore } from "../stores/activity-feed";
import { useSystemStore } from "../stores/system";
import type { ActivityEvent } from "../stores/activity-feed";
import type { Frame } from "../../protocol/frame";
import { InstanceHeader } from "../components/home/InstanceHeader";
import { AgentStrip } from "../components/home/AgentStrip";
import { StatsStrip } from "../components/home/StatsStrip";
import { NeedsAttentionPanel } from "../components/home/NeedsAttentionPanel";
import { ActivityFeed } from "../components/home/ActivityFeed";

export function HomePage() {
	const health = useSystemStore((s) => s.health);
	const fetchHealth = useSystemStore((s) => s.fetchHealth);
	const request = useWsRequest();

	const proposals = useProposalsStore((s) => s.proposals);
	const approve = useProposalsStore((s) => s.approve);
	const reject = useProposalsStore((s) => s.reject);

	const agents = useAgentsStore((s) => s.agents);
	const updateAgentStatus = useAgentsStore((s) => s.updateAgentStatus);

	const activityEvents = useActivityFeedStore((s) => s.events);
	const addActivityEvent = useActivityFeedStore((s) => s.addEvent);
	const setActivityEvents = useActivityFeedStore((s) => s.setEvents);

	const instanceName = useAuthStore((s) => s.instanceName) ?? "NyxHive";

	// Load health on mount + poll every 25s
	useEffect(() => {
		fetchHealth();
		const interval = setInterval(fetchHealth, 25_000);
		return () => clearInterval(interval);
	}, [fetchHealth]);

	// Load initial activity events
	useEffect(() => {
		request<ActivityEvent[]>("activity.recent")
			.then((events) => setActivityEvents(events))
			.catch(() => {});
	}, [request, setActivityEvents]);

	// Live activity updates
	useWsEvent(
		"activity:event",
		useCallback(
			(frame: Frame) => {
				addActivityEvent(frame.payload as ActivityEvent);
			},
			[addActivityEvent],
		),
	);

	// Live agent status updates
	useWsEvent(
		"agent:status",
		useCallback(
			(frame: Frame) => {
				const payload = frame.payload as {
					agent: string;
					status: "idle" | "running" | "error";
					task: string | null;
				};
				updateAgentStatus(payload.agent, payload.status, payload.task);
			},
			[updateAgentStatus],
		),
	);

	const pendingProposals = proposals.filter(
		(p) => p.status === "proposed" || p.status === "reviewed",
	);
	const completedCount = proposals.filter(
		(p) => p.status === "completed" || p.status === "merged",
	).length;
	const runningCount = agents.filter((a) => a.status === "running").length;
	const totalCost = agents.reduce((s, a) => s + a.estimatedCostCents, 0);

	return (
		<div className="mx-auto max-w-6xl space-y-5">
			<InstanceHeader
				instanceName={instanceName}
				agentCount={agents.length}
				health={health}
				runningCount={runningCount}
			/>

			{/* Attention first — the operator's primary question is "do I need to act?" */}
			<NeedsAttentionPanel
				proposals={pendingProposals}
				onApprove={(id) => approve(id)}
				onReject={(id) => reject(id)}
			/>

			{/* Compact agent status strip */}
			<AgentStrip agents={agents} />

			<StatsStrip
				health={health}
				totalCost={totalCost}
				proposalCount={pendingProposals.length}
				completedCount={completedCount}
			/>

			<ActivityFeed events={activityEvents} />
		</div>
	);
}
