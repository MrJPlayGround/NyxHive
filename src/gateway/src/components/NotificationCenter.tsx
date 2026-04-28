import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, Bot, Briefcase, GitBranch, AlertTriangle, X } from "lucide-react";
import { cn } from "../lib/utils";
import { useNotificationStore, type Notification } from "../stores/notifications";
import { formatRelativeTime } from "../lib/format";

const typeConfig: Record<Notification["type"], { icon: typeof Bell; color: string }> = {
	proposal: { icon: Briefcase, color: "text-[var(--nyx-accent)]" },
	agent: { icon: Bot, color: "text-[var(--nyx-warn)]" },
	thread: { icon: GitBranch, color: "text-[var(--nyx-accent-2)]" },
	system: { icon: Bell, color: "text-[var(--nyx-text-secondary)]" },
	error: { icon: AlertTriangle, color: "text-[var(--nyx-danger)]" },
};

function NotificationItem({
	notification,
	onNavigate,
}: {
	notification: Notification;
	onNavigate: (link: string) => void;
}) {
	const markRead = useNotificationStore((s) => s.markRead);
	const { icon: Icon, color } = typeConfig[notification.type] ?? typeConfig.system;

	return (
		<button
			type="button"
			onClick={() => {
				markRead(notification.id);
				if (notification.link) onNavigate(notification.link);
			}}
			className={cn(
				"flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors",
				notification.read
					? "opacity-60 hover:opacity-80"
					: "bg-[var(--nyx-accent-dim)] hover:bg-[rgb(var(--nyx-accent-rgb)/0.12)]",
			)}
		>
			<Icon className={cn("mt-0.5 h-4 w-4 shrink-0", color)} />
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium text-[var(--nyx-text)]">{notification.title}</p>
				{notification.description && (
					<p className="mt-0.5 truncate text-xs text-[var(--nyx-muted)]">{notification.description}</p>
				)}
			</div>
			<span className="shrink-0 text-[10px] text-[var(--nyx-muted)]">
				{formatRelativeTime(notification.timestamp)}
			</span>
		</button>
	);
}

export function NotificationCenter() {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const navigate = useNavigate();

	const notifications = useNotificationStore((s) => s.notifications);
	const unreadCount = useNotificationStore((s) => s.unreadCount);
	const markAllRead = useNotificationStore((s) => s.markAllRead);
	const clear = useNotificationStore((s) => s.clear);

	// Close on outside click
	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				onClick={() => {
					setOpen(!open);
					if (!open && unreadCount > 0) markAllRead();
				}}
				className={cn(
					"relative rounded-md p-1.5 text-[var(--nyx-text-secondary)] transition-colors hover:text-[var(--nyx-text)]",
					open && "bg-[var(--nyx-accent-dim)] text-[var(--nyx-accent)]",
				)}
			>
				<Bell className="h-4 w-4" />
				{unreadCount > 0 && (
					<span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--nyx-danger)] px-1 text-[10px] font-bold text-white">
						{unreadCount > 9 ? "9+" : unreadCount}
					</span>
				)}
			</button>

			{open && (
				<div className="absolute left-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-lg border border-[var(--nyx-line)] bg-[var(--nyx-panel-2)] shadow-xl backdrop-blur-xl">
					<div className="flex items-center justify-between border-b border-[var(--nyx-line)] px-4 py-2.5">
						<span className="text-xs font-medium text-[var(--nyx-text-secondary)]">Notifications</span>
						<div className="flex items-center gap-2">
							{notifications.length > 0 && (
								<button
									type="button"
									onClick={clear}
									className="text-[10px] text-[var(--nyx-muted)] hover:text-[var(--nyx-text-secondary)] transition-colors"
								>
									Clear all
								</button>
							)}
							<button
								type="button"
								onClick={() => setOpen(false)}
								className="text-[var(--nyx-muted)] hover:text-[var(--nyx-text-secondary)] transition-colors"
							>
								<X className="h-3.5 w-3.5" />
							</button>
						</div>
					</div>
					<div className="max-h-80 overflow-y-auto">
						{notifications.length === 0 ? (
							<p className="px-4 py-8 text-center text-xs text-[var(--nyx-muted)]">
								No notifications yet
							</p>
						) : (
							<div className="p-1">
								{notifications.map((n) => (
									<NotificationItem
										key={n.id}
										notification={n}
										onNavigate={(link) => {
											setOpen(false);
											navigate(link);
										}}
									/>
								))}
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
