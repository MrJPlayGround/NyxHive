import { lazy, Suspense, useEffect, useCallback, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
	Home,
	MessageSquare,
	Bot,
	GitBranch,
	Briefcase,
	Brain,
	ScrollText,
	Settings,
	Shield,
	Menu,
	X,
	LayoutDashboard,
	Loader2,
} from "lucide-react";
import { cn } from "../lib/utils";
import { useAuthStore } from "../stores/auth";
import { useProposalsStore } from "../stores/proposals";
import { useAgentsStore } from "../stores/agents";
import { useWsEvent } from "../hooks/useWs";
import { useNotificationEvents } from "../hooks/useNotificationEvents";
import { useThemeSync } from "../hooks/useThemeSync";
import { Separator } from "./ui/separator";
import { NotificationCenter } from "./NotificationCenter";
import { CommandPalette } from "./CommandPalette";
import { ErrorBoundary } from "./ErrorBoundary";
import type { LucideIcon } from "lucide-react";
import type { Frame } from "../../protocol/frame";

const ChatPage = lazy(() => import("../pages/Chat").then((m) => ({ default: m.ChatPage })));
const CockpitPage = lazy(() => import("../pages/Cockpit").then((m) => ({ default: m.CockpitPage })));

function PanelLoader() {
	return (
		<div className="flex min-h-0 flex-1 items-center justify-center">
			<div className="inline-flex items-center gap-3 rounded-full border border-white/8 bg-white/[0.03] px-4 py-2 text-sm text-zinc-400">
				<Loader2 className="h-4 w-4 animate-spin text-[var(--nyx-accent)]" />
				Loading panel
			</div>
		</div>
	);
}

interface NavItem {
	to: string;
	icon: LucideIcon;
	label: string;
	badge?: () => number;
	badgeColor?: string;
}

function useBadgeCounts() {
	const proposals = useProposalsStore((s) => s.proposals);
	const agents = useAgentsStore((s) => s.agents);

	const pendingProposals = proposals.filter(
		(p) => p.status === "proposed" || p.status === "reviewed",
	).length;
	const runningAgents = agents.filter((a) => a.status === "running").length;

	return { pendingProposals, runningAgents };
}

function NavSection({ items }: { items: NavItem[] }) {
	return (
		<div className="space-y-0.5">
			{items.map(({ to, icon: Icon, label: itemLabel, badge, badgeColor }) => {
				const count = badge?.() ?? 0;
				return (
					<NavLink
						key={to}
						to={to}
						end={to === "/"}
						className={({ isActive }) =>
							cn(
								"flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150",
								"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nyx-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--nyx-bg)]",
								isActive
									? "bg-[var(--nyx-accent-dim)] text-[var(--nyx-accent)] border border-[rgb(var(--nyx-accent-rgb)/0.15)]"
									: "text-[var(--nyx-text-secondary)] hover:bg-[var(--nyx-panel-hover)] hover:text-[var(--nyx-text)] border border-transparent",
							)
						}
					>
						<Icon className="h-4 w-4 shrink-0" />
						{itemLabel}
						{count > 0 && (
							<span
								className={cn(
									"ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-medium",
									badgeColor ?? "bg-[var(--nyx-panel-hover)] text-[var(--nyx-text-secondary)]",
								)}
							>
								{count}
							</span>
						)}
					</NavLink>
				);
			})}
		</div>
	);
}

function ConnectionIndicator() {
	const { connected, authenticated, error } = useAuthStore();

	let color = "bg-[var(--nyx-danger)]";
	let glow = "";
	let text = "Disconnected";

	if (connected && authenticated) {
		color = "bg-[var(--nyx-accent)]";
		glow = "shadow-[0_0_8px_rgb(var(--nyx-accent-rgb)/0.4)] glow-dot";
		text = "Connected";
	} else if (connected) {
		color = "bg-[var(--nyx-warn)]";
		glow = "shadow-[0_0_8px_rgba(232,184,74,0.4)]";
		text = "Authenticating";
	} else if (error) {
		text = error.length > 30 ? "Error" : error;
	}

	return (
		<div className="flex items-center gap-2 px-3 py-2">
			<div className={cn("h-2 w-2 shrink-0 rounded-full", color, glow)} />
			<span className="truncate text-xs text-[var(--nyx-muted)]">{text}</span>
		</div>
	);
}

export function Layout() {
	const location = useLocation();
	const onChat = location.pathname === "/chat";
	const onCockpit = location.pathname === "/cockpit";
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [chatBooted, setChatBooted] = useState(onChat);
	const [cockpitBooted, setCockpitBooted] = useState(onCockpit);
	const { initDevice, connect, authenticated, fetchInstanceInfo, instanceName } = useAuthStore();
	const fetchProposals = useProposalsStore((s) => s.fetchProposals);
	const fetchAgents = useAgentsStore((s) => s.fetchAgents);
	const updateProposal = useProposalsStore((s) => s.updateProposal);
	const updateAgentStatus = useAgentsStore((s) => s.updateAgentStatus);
	const { pendingProposals, runningAgents } = useBadgeCounts();

	// Wait for Zustand persist hydration before initializing device.
	// Without this, initDevice() runs before localStorage is loaded,
	// generates a new deviceId, and the gateway needs re-approval every session.
	useEffect(() => {
		let started = false;
		const start = () => {
			if (started) return;
			started = true;
			initDevice();
			connect();
		};
		const unsub = useAuthStore.persist.onFinishHydration(start);
		// If already hydrated (e.g. hot reload), connect immediately
		if (useAuthStore.persist.hasHydrated()) {
			start();
		}
		return unsub;
	}, [initDevice, connect]);

	// Fetch data once authenticated
	useEffect(() => {
		if (authenticated) {
			fetchProposals();
			fetchAgents();
			fetchInstanceInfo();
		}
	}, [authenticated, fetchProposals, fetchAgents, fetchInstanceInfo]);

	// Live badge updates
	const handleProposalUpdate = useCallback(
		(frame: Frame) => {
			const payload = frame.payload as { proposalId: string; status: string; prUrl?: string };
			updateProposal(payload.proposalId, { status: payload.status, prUrl: payload.prUrl });
			if (["reviewed", "completed", "rejected", "failed", "merged"].includes(payload.status)) {
				fetchProposals();
			}
		},
		[updateProposal, fetchProposals],
	);

	const handleAgentStatus = useCallback(
		(frame: Frame) => {
			const payload = frame.payload as { agent: string; status: "idle" | "running" | "error"; task: string | null };
			updateAgentStatus(payload.agent, payload.status, payload.task);
		},
		[updateAgentStatus],
	);

	useWsEvent("proposal:update", handleProposalUpdate);
	useWsEvent("agent:status", handleAgentStatus);

	// Feed real-time events into notification center
	useNotificationEvents();

	// Sync theme to <html data-theme="...">
	useThemeSync();

	const primaryItems: NavItem[] = [
		{ to: "/", icon: Home, label: "Home" },
		{ to: "/cockpit", icon: LayoutDashboard, label: "Cockpit" },
		{ to: "/chat", icon: MessageSquare, label: "Chat" },
		{
			to: "/work",
			icon: Briefcase,
			label: "Work",
			badge: () => pendingProposals,
			badgeColor: "bg-[var(--nyx-danger-dim)] text-[var(--nyx-danger)]",
		},
	];

	const observeItems: NavItem[] = [
		{ to: "/control", icon: Shield, label: "Control" },
		{
			to: "/agents",
			icon: Bot,
			label: "Agents",
			badge: () => runningAgents,
			badgeColor: "bg-[var(--nyx-warn-dim)] text-[var(--nyx-warn)]",
		},
		{ to: "/threads", icon: GitBranch, label: "Threads" },
		{ to: "/logs", icon: ScrollText, label: "Logs" },
		{ to: "/knowledge", icon: Brain, label: "Knowledge" },
	];

	const systemItems: NavItem[] = [
		{ to: "/settings", icon: Settings, label: "Settings" },
	];

	// Close sidebar on navigation (mobile)
	useEffect(() => {
		setSidebarOpen(false);
	}, [location.pathname]);

	useEffect(() => {
		if (onChat) setChatBooted(true);
		if (onCockpit) setCockpitBooted(true);
	}, [onChat, onCockpit]);

	return (
		<div className="flex h-screen bg-[var(--nyx-bg)] text-[var(--nyx-text)]">
			{/* Ambient background mesh */}
			<div className="ambient-mesh" />
			{/* Grain texture */}
			<div className="grain-overlay" />

			{/* Mobile header */}
			<div className="fixed top-0 left-0 right-0 z-40 flex h-12 items-center gap-3 border-b border-[var(--nyx-line)] bg-[var(--nyx-bg)]/95 backdrop-blur-sm px-4 md:hidden">
				<button
					onClick={() => setSidebarOpen(!sidebarOpen)}
					aria-label="Toggle navigation"
					className="rounded-md p-1.5 text-[var(--nyx-text-secondary)] hover:text-[var(--nyx-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nyx-accent)]"
				>
					{sidebarOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
				</button>
				<h1 className="text-gradient text-sm font-bold tracking-tight">{instanceName ?? "NyxHive"}</h1>
			</div>

			{/* Sidebar overlay (mobile) */}
			{sidebarOpen && (
				<div
					className="fixed inset-0 z-40 bg-black/60 md:hidden"
					onClick={() => setSidebarOpen(false)}
				/>
			)}

			{/* Sidebar */}
			<nav
				className={cn(
					"sidebar-gradient fixed z-50 flex h-full w-48 shrink-0 flex-col border-r border-[var(--nyx-line)] transition-transform duration-200 md:static md:translate-x-0",
					sidebarOpen ? "translate-x-0" : "-translate-x-full",
				)}
			>
				<div className="flex items-center justify-between p-4">
					<div>
						<h1 className="text-shimmer text-lg font-bold tracking-tight">{instanceName ?? "NyxHive"}</h1>
						<p className="text-xs text-[var(--nyx-muted)]">Gateway</p>
					</div>
					<NotificationCenter />
				</div>
				<Separator />
				<div className="flex flex-1 flex-col overflow-auto p-3">
					<NavSection items={primaryItems} />
					<p className="px-3 pt-4 pb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--nyx-muted)]">Observe</p>
					<NavSection items={observeItems} />
					<p className="px-3 pt-4 pb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--nyx-muted)]">System</p>
					<NavSection items={systemItems} />
				</div>
				<Separator />
				<ConnectionIndicator />
			</nav>
			<main className={cn(
				"relative z-10 flex-1 min-h-0 overflow-hidden max-md:pt-12",
				(onChat || onCockpit) ? "flex min-h-0 flex-col" : "overflow-auto p-4",
			)}>
				{/* Chat stays mounted permanently so streams survive tab switches */}
				{(chatBooted || onChat) && (
					<Suspense fallback={onChat ? <PanelLoader /> : null}>
						<div className={cn("min-h-0 flex-1 overflow-hidden", onChat ? "flex" : "hidden")}>
							<ChatPage />
						</div>
					</Suspense>
				)}
				{/* Cockpit stays mounted permanently — owns fleet WS lifecycle */}
				{(cockpitBooted || onCockpit) && (
					<Suspense fallback={onCockpit ? <PanelLoader /> : null}>
						<div className={cn("min-h-0 flex-1 overflow-hidden", onCockpit ? "flex" : "hidden")}>
							<CockpitPage />
						</div>
					</Suspense>
				)}
				{!onChat && !onCockpit && (
					<ErrorBoundary>
						<Outlet />
					</ErrorBoundary>
				)}
			</main>
			<CommandPalette />
		</div>
	);
}
