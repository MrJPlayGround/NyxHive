import type { ChatRuntimeEvent } from "./chat-runtime";
import type { ExecutionEvent } from "../stores/chat";

type LifecycleRuntimeEvent = Extract<
	ChatRuntimeEvent,
	{ type: "turn.started" | "turn.completed" | "chat.active" }
>;

function lifecycleEventId(event: LifecycleRuntimeEvent): string {
	const runKey = event.runId ?? `${event.threadId}:active`;
	return `runtime:${runKey}:lifecycle`;
}

export function createLifecycleExecutionEvent(event: LifecycleRuntimeEvent): ExecutionEvent | null {
	if (event.type === "chat.active") {
		return {
			id: lifecycleEventId(event),
			kind: "status",
			phase: "started",
			title: "Run is active",
			subtitle: event.agent ? `@${event.agent}` : undefined,
			details: "Connected to the live run. Tool, command, and file events will appear here as they happen.",
			timestamp: event.startedAt ?? Date.now(),
		};
	}

	if (event.type === "turn.started") {
		return {
			id: lifecycleEventId(event),
			kind: "status",
			phase: "started",
			turn: event.turn,
			title: "Run started",
			subtitle: event.agent ? `@${event.agent}` : undefined,
			details: "Connected to the live run. Tool, command, and file events will appear here as they happen.",
			timestamp: event.startedAt,
		};
	}

	if (!event.runId) return null;
	return {
		id: lifecycleEventId(event),
		kind: "status",
		phase: event.status === "failed" ? "failed" : "completed",
		turn: event.turn,
		title: event.status === "failed"
			? "Run failed"
			: event.status === "aborted"
				? "Run aborted"
				: "Run completed",
		subtitle: event.agent ? `@${event.agent}` : undefined,
		details: event.status === "completed"
			? "The agent finished this turn."
			: event.status === "aborted"
				? "The run was aborted before completion."
				: "The run ended with an error.",
		timestamp: event.finishedAt,
	};
}
