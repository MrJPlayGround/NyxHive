import { useCallback } from "react";
import type { Frame } from "../../protocol/frame";
import { useToast } from "../components/ui/toast";
import { useWsEvent, useWsRequest } from "./useWs";

export function useDeviceNotifications() {
	const { addToast } = useToast();
	const request = useWsRequest();

	const handlePending = useCallback(
		(frame: Frame) => {
			const p = frame.payload as { deviceId?: string; deviceName?: string } | undefined;
			const deviceId = p?.deviceId ?? "unknown";
			const deviceName = p?.deviceName ?? "Unknown device";
			addToast({
				title: "New device requesting access",
				description: `"${deviceName}" (${deviceId.slice(0, 8)}...)`,
				action: {
					label: "Approve",
					onClick: async () => {
						try {
							await request("devices.approve", { deviceId });
						} catch {
							// Will show on devices page if it fails
						}
					},
				},
			});
		},
		[addToast, request],
	);

	const handleApproved = useCallback(
		(frame: Frame) => {
			const p = frame.payload as { deviceName?: string } | undefined;
			const deviceName = p?.deviceName ?? "Device";
			addToast({
				title: "Device approved",
				description: `"${deviceName}" can now connect`,
				duration: 5000,
			});
		},
		[addToast],
	);

	const handleRevoked = useCallback(
		(_frame: Frame) => {
			addToast({
				title: "Device revoked",
				duration: 5000,
			});
		},
		[addToast],
	);

	useWsEvent("device:pending", handlePending);
	useWsEvent("device:approved", handleApproved);
	useWsEvent("device:revoked", handleRevoked);
}
