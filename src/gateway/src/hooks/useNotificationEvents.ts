import { useCallback } from "react";
import { useWsEvent } from "./useWs";
import { useNotificationStore } from "../stores/notifications";
import type { Frame } from "../../protocol/frame";

/** SSE events arrive wrapped: payload = { type, data: {...}, timestamp }. Unwrap to get the inner data. */
function unwrapPayload<T>(frame: Frame): T {
	const payload = frame.payload as Record<string, unknown>;
	return (payload?.data ?? payload) as T;
}

/** Listens to real-time WS events and pushes them into the notification store */
export function useNotificationEvents() {
	const push = useNotificationStore((s) => s.push);

	const handleProposal = useCallback(
		(frame: Frame) => {
			const p = unwrapPayload<{
				proposalId: string;
				title?: string;
				status: string;
				agent?: string;
				prUrl?: string;
			}>(frame);
			const title = p.title ?? p.proposalId.slice(0, 12);

			// Only notify on meaningful status changes
			if (p.status === "completed") {
				push({
					type: "proposal",
					title: "Proposal completed",
					description: title,
					link: "/work",
				});
			} else if (p.status === "proposed") {
				push({
					type: "proposal",
					title: "New proposal",
					description: title,
					link: "/work",
				});
			} else if (p.status === "failed") {
				push({
					type: "proposal",
					title: "Proposal failed",
					description: title,
					link: "/work",
				});
			} else if (p.status === "reviewed") {
				push({
					type: "proposal",
					title: "Proposal reviewed",
					description: `${title} — ready for approval`,
					link: "/work",
				});
			}
		},
		[push],
	);

	const handleAgent = useCallback(
		(frame: Frame) => {
			const p = unwrapPayload<{
				agent: string;
				status: "idle" | "running" | "error";
				task: string | null;
			}>(frame);
			if (p.status === "error") {
				push({
					type: "agent",
					title: `Agent error: ${p.agent}`,
					description: p.task ?? undefined,
					link: "/agents",
				});
			}
		},
		[push],
	);

	const handleScan = useCallback(
		(frame: Frame) => {
			const p = unwrapPayload<{
				task_id: string;
				task_name: string;
				agent: string;
				status: string;
				error?: string;
				proposals_created?: number;
				result_preview?: string;
			}>(frame);
			if (p.status === "completed") {
				const findings = p.proposals_created ?? 0;
				const preview = p.result_preview?.slice(0, 200);
				const isReport = p.task_name.startsWith("heartbeat:") || p.task_name.startsWith("briefing:");
				push({
					type: "system",
					title: isReport ? `${p.task_name.split(":")[0].charAt(0).toUpperCase()}${p.task_name.split(":")[0].slice(1)} report` : "Task completed",
					description: isReport && preview
						? `${p.task_name} — ${preview}`
						: findings > 0
							? `${p.task_name} — ${findings} new finding${findings === 1 ? "" : "s"}`
							: `${p.task_name} — no new findings`,
					link: "/scheduler",
				});
			} else if (p.status === "failed") {
				push({
					type: "error",
					title: "Task failed",
					description: `${p.task_name}${p.error ? `: ${p.error}` : ""}`,
					link: "/scheduler",
				});
			}
		},
		[push],
	);

	const handleThread = useCallback(
		(frame: Frame) => {
			const p = unwrapPayload<{
				threadId: string;
				status: string;
				agent?: string;
			}>(frame);
			if (p.status === "completed") {
				push({
					type: "thread",
					title: "Thread completed",
					description: `${p.agent ?? "Agent"} finished`,
					link: `/threads/${p.threadId}`,
				});
			} else if (p.status === "failed") {
				push({
					type: "thread",
					title: "Thread failed",
					description: `${p.agent ?? "Agent"} encountered an error`,
					link: `/threads/${p.threadId}`,
				});
			}
		},
		[push],
	);

	useWsEvent("proposal:update", handleProposal);
	useWsEvent("agent:status", handleAgent);
	useWsEvent("scan:completed", handleScan);
	useWsEvent("thread:update", handleThread);
}
