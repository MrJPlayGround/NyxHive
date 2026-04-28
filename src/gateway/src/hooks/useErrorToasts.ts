import { useEffect } from "react";
import { gateway } from "../lib/ws";
import { useToast } from "../components/ui/toast";
import { useNotificationStore } from "../stores/notifications";

/** Methods where errors are expected/handled locally — don't toast these */
const SILENT_METHODS = new Set([
	"chat.send",
	"chat.abort",
	"chat.history",
	"connect.authenticate",
	"proposals.createPr",
	"proposals.merge",
	"proposals.retry",
	"proposals.requeue",
]);

/** Error messages that are transient startup noise — don't toast */
const SILENT_MESSAGES = new Set(["Authenticate first", "Not connected"]);

/**
 * Wires gateway request errors to the toast notification system.
 * Silences methods that handle their own errors (chat, auth)
 * and transient connection/auth errors during startup.
 */
export function useErrorToasts() {
	const { addToast } = useToast();
	const push = useNotificationStore((s) => s.push);

	useEffect(() => {
		gateway.onRequestError = (method, error) => {
			if (SILENT_METHODS.has(method)) return;
			const msg = error.message ?? error.code ?? "Unknown error";
			if (SILENT_MESSAGES.has(msg)) return;

			addToast({
				title: `Request failed: ${method}`,
				description: msg,
				duration: 6000,
			});
			push({
				type: "error",
				title: `${method} failed`,
				description: msg,
			});
		};

		return () => {
			gateway.onRequestError = undefined;
		};
	}, [addToast, push]);
}
