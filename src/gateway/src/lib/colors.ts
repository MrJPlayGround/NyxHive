/** Category badge colors — for Badge variant="outline" */
export const categoryBadgeColors: Record<string, string> = {
	feature: "bg-[var(--nyx-accent-dim)] text-[var(--nyx-accent)] border-[rgb(var(--nyx-accent-rgb)/0.20)]",
	bugfix: "bg-red-500/10 text-red-400 border-red-500/20",
	improvement: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
	maintenance: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
	new_instance: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
};

/** Category text-only colors — for inline text */
export const categoryTextColors: Record<string, string> = {
	feature: "text-[var(--nyx-accent)]",
	bugfix: "text-red-400",
	improvement: "text-emerald-400",
	maintenance: "text-zinc-400",
	new_instance: "text-cyan-400",
};

/** Priority text colors */
export const priorityTextColors: Record<string, string> = {
	high: "text-red-400",
	medium: "text-amber-400",
	low: "text-zinc-400",
};

/** Priority dot colors (bg-*) */
export const priorityDotColors: Record<string, string> = {
	high: "bg-red-400",
	medium: "bg-amber-400",
	low: "bg-zinc-500",
};

/** Thread status badge colors */
export const threadStatusColors: Record<string, string> = {
	running: "bg-amber-500/10 text-amber-400 border-amber-500/20",
	completed: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
	failed: "bg-red-500/10 text-red-400 border-red-500/20",
	created: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
};

/** Channel status badge colors */
export const channelStatusColors: Record<string, string> = {
	connected: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
	disconnected: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
	error: "bg-red-500/10 text-red-400 border-red-500/20",
};

/** Log level colors */
export const logLevelColors: Record<string, string> = {
	error: "text-red-400",
	warn: "text-amber-400",
	info: "text-zinc-300",
	debug: "text-zinc-500",
};

/** Trace status badge colors */
export const traceStatusColors: Record<string, string> = {
	running: "bg-amber-500/10 text-amber-400 border-amber-500/20",
	completed: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
	failed: "bg-red-500/10 text-red-400 border-red-500/20",
};

/** Agent status config */
export const agentStatusConfig: Record<string, { color: string; label: string; badge: "default" | "secondary" | "destructive" }> = {
	idle: { color: "bg-emerald-500", label: "Idle", badge: "secondary" },
	running: { color: "bg-amber-500", label: "Running", badge: "default" },
	error: { color: "bg-red-500", label: "Error", badge: "destructive" },
};
