import { useEffect, useState, useCallback } from "react";
import { MessageSquare, Radio } from "lucide-react";
import { useWsRequest } from "../hooks/useWs";
import { useVisibilityRefresh } from "../hooks/useVisibilityRefresh";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";
import { formatDate } from "../lib/format";
import { channelStatusColors } from "../lib/colors";
import { channelIcons } from "../lib/types";

interface Channel {
	id: string;
	type: string;
	status: "connected" | "disconnected" | "error";
	messageCount: number;
	lastActivity: number | null;
}

export function ChannelsPage() {
	const [channels, setChannels] = useState<Channel[]>([]);
	const [loading, setLoading] = useState(true);
	const request = useWsRequest();

	const load = useCallback(async () => {
		try {
			const result = await request<{ channels: Channel[] }>("channels.list");
			setChannels(result.channels ?? []);
		} catch {
			// Ignore
		} finally {
			setLoading(false);
		}
	}, [request]);

	useEffect(() => {
		load();
	}, [load]);

	useVisibilityRefresh(load);

	return (
		<div>
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				{loading ? (
					Array.from({ length: 4 }).map((_, i) => (
						<Skeleton key={i} className="h-36 rounded-xl" />
					))
				) : channels.length === 0 ? (
					<p className="col-span-full py-8 text-center text-sm text-zinc-500">
						No channels configured
					</p>
				) : (
					channels.map((ch) => (
						<Card key={ch.id}>
							<CardHeader className="pb-2">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										{ch.type === "discord" ? (
											<MessageSquare className="h-5 w-5 text-[#5865F2]" />
										) : (
											<Radio className="h-5 w-5 text-zinc-400" />
										)}
										<CardTitle className="text-base">
											{channelIcons[ch.type] ?? ch.type}
										</CardTitle>
									</div>
									<Badge variant="outline" className={channelStatusColors[ch.status]}>
										{ch.status}
									</Badge>
								</div>
							</CardHeader>
							<CardContent>
								<div className="space-y-1 text-sm">
									<div className="flex justify-between">
										<span className="text-zinc-500">Messages</span>
										<span>{ch.messageCount.toLocaleString()}</span>
									</div>
									<div className="flex justify-between">
										<span className="text-zinc-500">Last Activity</span>
										<span className="text-zinc-400">
											{formatDate(ch.lastActivity)}
										</span>
									</div>
								</div>
							</CardContent>
						</Card>
					))
				)}
			</div>
		</div>
	);
}
