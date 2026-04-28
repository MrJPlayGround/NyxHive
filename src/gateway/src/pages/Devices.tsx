import { useEffect, useState, useCallback } from "react";
import { Check, X, Smartphone, Trash2 } from "lucide-react";
import { useWsRequest, useWsEvent } from "../hooks/useWs";
import { Card, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { formatDate } from "../lib/format";

interface Device {
	id: string;
	name: string;
	approved: boolean;
	lastSeen: number | null;
	createdAt: number;
}

export function DevicesPage() {
	const [devices, setDevices] = useState<Device[]>([]);
	const [loading, setLoading] = useState(true);
	const request = useWsRequest();

	const load = useCallback(async () => {
		try {
			const result = await request<{ devices: Device[] }>("devices.list");
			setDevices(result.devices ?? []);
		} catch {
			// Ignore
		} finally {
			setLoading(false);
		}
	}, [request]);

	useEffect(() => {
		load();
	}, [load]);

	useWsEvent("device:pending", load);
	useWsEvent("device:approved", load);
	useWsEvent("device:revoked", load);

	const approveDevice = useCallback(
		async (id: string) => {
			await request("devices.approve", { deviceId: id });
			load();
		},
		[request, load],
	);

	const revokeDevice = useCallback(
		async (id: string) => {
			if (!confirm("Revoke access for this device?")) return;
			await request("devices.revoke", { deviceId: id });
			load();
		},
		[request, load],
	);

	const rejectDevice = useCallback(
		async (id: string) => {
			await request("devices.revoke", { deviceId: id });
			load();
		},
		[request, load],
	);

	const pending = devices.filter((d) => !d.approved);
	const approved = devices.filter((d) => d.approved);

	const revokeAll = useCallback(async () => {
		if (!confirm(`Revoke all ${approved.length} approved devices?`)) return;
		await Promise.all(
			approved.map((d) => request("devices.revoke", { deviceId: d.id })),
		);
		load();
	}, [approved, request, load]);

	return (
		<div>
			{loading ? (
				<div className="space-y-3">
					{Array.from({ length: 3 }).map((_, i) => (
						<Skeleton key={i} className="h-20 rounded-xl" />
					))}
				</div>
			) : (
				<>
					{pending.length > 0 && (
						<div>
							<h2 className="mb-3 text-sm font-medium text-amber-400">
								Pending Approval ({pending.length})
							</h2>
							<div className="space-y-2">
								{pending.map((device) => (
									<Card
										key={device.id}
										className="border-amber-500/20"
									>
										<CardContent className="flex items-center justify-between p-4">
											<div className="flex items-center gap-3">
												<Smartphone className="h-5 w-5 text-amber-400" />
												<div>
													<p className="font-medium">{device.name}</p>
													<p className="text-xs text-zinc-500">
														{device.id.slice(0, 8)}... &middot; Added{" "}
														{formatDate(device.createdAt)}
													</p>
												</div>
											</div>
											<div className="flex gap-2">
												<Button
													size="sm"
													variant="ghost"
													className="text-red-400 hover:text-red-300 gap-1"
													onClick={() => rejectDevice(device.id)}
												>
													<X className="h-3 w-3" /> Reject
												</Button>
												<Button
													size="sm"
													onClick={() => approveDevice(device.id)}
													className="gap-1"
												>
													<Check className="h-3 w-3" /> Approve
												</Button>
											</div>
										</CardContent>
									</Card>
								))}
							</div>
						</div>
					)}

					<div className="mt-4">
						<div className="mb-3 flex items-center justify-between">
							<h2 className="text-sm font-medium text-zinc-400">
								Approved Devices ({approved.length})
							</h2>
							{approved.length > 1 && (
								<Button
									size="sm"
									variant="ghost"
									className="text-red-400 hover:text-red-300 gap-1"
									onClick={revokeAll}
								>
									<Trash2 className="h-3 w-3" /> Revoke All
								</Button>
							)}
						</div>
						{approved.length === 0 ? (
							<p className="py-8 text-center text-sm text-zinc-500">
								No approved devices
							</p>
						) : (
							<div className="overflow-hidden rounded-lg border border-zinc-800">
								<table className="w-full text-sm">
									<thead>
										<tr className="border-b border-zinc-800 bg-zinc-900/50">
											<th className="px-4 py-3 text-left font-medium text-zinc-400">
												Name
											</th>
											<th className="px-4 py-3 text-left font-medium text-zinc-400">
												ID
											</th>
											<th className="px-4 py-3 text-left font-medium text-zinc-400">
												Last Seen
											</th>
											<th className="px-4 py-3 text-right font-medium text-zinc-400">
												Actions
											</th>
										</tr>
									</thead>
									<tbody>
										{approved.map((device) => (
											<tr
												key={device.id}
												className="border-b border-zinc-800/50 last:border-0"
											>
												<td className="px-4 py-3 font-medium">
													{device.name}
												</td>
												<td className="px-4 py-3">
													<code className="text-xs text-zinc-400">
														{device.id.slice(0, 12)}...
													</code>
												</td>
												<td className="px-4 py-3 text-zinc-400">
													{formatDate(device.lastSeen)}
												</td>
												<td className="px-4 py-3 text-right">
													<Button
														size="sm"
														variant="ghost"
														className="text-red-400 hover:text-red-300"
														onClick={() => revokeDevice(device.id)}
													>
														<X className="h-3 w-3 mr-1" /> Revoke
													</Button>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</div>
				</>
			)}
		</div>
	);
}
