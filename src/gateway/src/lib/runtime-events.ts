import type { Frame } from "../../protocol/frame";

export const RUNTIME_EVENT_METHODS = [
	"thread.started",
	"turn.started",
	"turn.completed",
	"item.started",
	"item.updated",
	"item.completed",
	"context.updated",
	"diff.updated",
	"request.opened",
	"request.resolved",
	"chat:active",
	"run.heartbeat",
	"chat:heartbeat",
	"chat:execution",
	"context:metrics",
	"response:delta",
	"agent:progress",
	"chat:response",
	"response:complete",
] as const;

export function isGatewayEvent(frame: Frame): boolean {
	const payload = frame.payload as { data?: { channel?: string }; channel?: string };
	const channel = payload.data?.channel ?? payload.channel;
	return !channel || channel === "gateway";
}
