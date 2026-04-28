import { useEffect, useCallback } from "react";
import { gateway } from "../lib/ws";
import type { Frame } from "../../protocol/frame";

export function useWsRequest() {
	return useCallback(
		<T = unknown>(method: string, payload?: unknown) =>
			gateway.request<T>(method, payload ?? {}),
		[],
	);
}

export function useWsEvent(event: string, handler: (frame: Frame) => void) {
	useEffect(() => {
		return gateway.on(event, handler);
	}, [event, handler]);
}
