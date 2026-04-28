export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

export function formatCost(cents: number, showZero = true): string {
	if (!showZero && cents === 0) return "-";
	return `$${(cents / 100).toFixed(2)}`;
}

export function formatRelativeTime(ts: number | null): string {
	if (!ts) return "Never";
	const diff = Date.now() - ts;
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return "Just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

export function formatTimeAgo(ts: number | string): string {
	const diff = Date.now() - (typeof ts === "string" ? new Date(ts).getTime() : ts);
	const mins = Math.floor(diff / 60000);
	if (mins < 60) return `${mins}m`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h`;
	return `${Math.floor(hrs / 24)}d`;
}

export function formatDate(ts: number | null, full = false): string {
	if (!ts) return "Never";
	if (full) return new Date(ts).toLocaleString();
	return new Date(ts).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function formatUptime(seconds: number): string {
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const rem = Math.floor(s % 60);
	if (m < 60) return `${m}m ${rem}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m`;
}

export function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return `${mins}m ${secs}s`;
}

export function formatBytes(bytes: number): string {
	if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
	if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
	return `${(bytes / 1024).toFixed(0)} KB`;
}
