import { useEffect, useRef } from "react";

/**
 * Calls `callback` when the document becomes visible after being hidden for at least `minHiddenMs`.
 * Useful for refreshing stale data on pages without WebSocket events.
 */
export function useVisibilityRefresh(callback: () => void, minHiddenMs = 30_000) {
	const hiddenAtRef = useRef<number | null>(null);

	useEffect(() => {
		const handler = () => {
			if (document.hidden) {
				hiddenAtRef.current = Date.now();
			} else if (hiddenAtRef.current !== null) {
				const elapsed = Date.now() - hiddenAtRef.current;
				hiddenAtRef.current = null;
				if (elapsed >= minHiddenMs) {
					callback();
				}
			}
		};

		document.addEventListener("visibilitychange", handler);
		return () => document.removeEventListener("visibilitychange", handler);
	}, [callback, minHiddenMs]);
}
