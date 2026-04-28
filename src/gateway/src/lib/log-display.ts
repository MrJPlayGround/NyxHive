export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogLike {
	level: LogLevel;
	message: string;
	module?: string;
	timestamp: number;
}

export interface DisplayLogEntry {
	level: LogLevel;
	module?: string;
	title: string;
	detail?: string;
	chips: string[];
	raw: string;
	tone: "normal" | "muted" | "warn" | "error" | "success";
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const INSTANCE_TAGS = new Set(["nyx", "nyxai", "nyxlabs", "morph", "gateway"]);

function shorten(value: string, max = 180): string {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, max - 3).trimEnd()}...`;
}

function shortenPaths(value: string): string {
	return value
		.replaceAll("/home/user/dev/nyxhive/", "nyxhive/")
		.replaceAll("/home/user/dev/nyxhive/", "nyxhive/")
		.replaceAll("/home/user/", "~/");
}

function trimShellWrapper(command: string): string {
	let value = command.trim();
	value = value.replace(/^\/bin\/(?:zsh|bash)\s+-lc\s+/, "");
	value = value.replace(/^bash\s+-lc\s+/, "");
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1);
	}
	return shorten(shortenPaths(value), 220);
}

function parseBracketTags(message: string): { tags: string[]; rest: string } {
	const tags: string[] = [];
	let rest = message.trim();
	while (true) {
		const match = rest.match(/^\[([^\]]+)\]\s*/);
		if (!match) break;
		tags.push(match[1]);
		rest = rest.slice(match[0].length).trimStart();
	}
	return { tags, rest };
}

function parseKeyValues(value: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const match of value.matchAll(/\b([a-zA-Z_][\w.-]*)=("[^"]*"|'[^']*'|[^\s]+)/g)) {
		out[match[1]] = match[2].replace(/^["']|["']$/g, "");
	}
	return out;
}

function pickModule(entry: LogLike, tags: string[]): string | undefined {
	const entryModule = entry.module?.trim();
	const tagModule = tags.find((tag) => {
		const normalized = tag.toLowerCase();
		return !INSTANCE_TAGS.has(normalized) && !tag.includes("=");
	});
	if (!entryModule || INSTANCE_TAGS.has(entryModule.toLowerCase())) return tagModule ?? entryModule;
	return entryModule;
}

function chip(value: string | undefined, prefix?: string): string | null {
	if (!value) return null;
	return prefix ? `${prefix} ${value}` : value;
}

function durationSeconds(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const match = value.match(/^(\d+(?:\.\d+)?)(ms|s)?$/);
	if (!match) return undefined;
	const numeric = Number(match[1]);
	if (!Number.isFinite(numeric)) return undefined;
	const seconds = match[2] === "s" ? numeric : numeric / 1000;
	return seconds < 10 ? `${Math.round(seconds * 10) / 10}s` : `${Math.round(seconds)}s`;
}

function collectContextChips(kv: Record<string, string>): string[] {
	return [
		chip(kv.agent),
		chip(kv.ch, "#"),
		chip(kv.elapsed),
		chip(durationSeconds(kv.duration)),
		chip(kv.exit ? `exit ${kv.exit}` : undefined),
	]
		.filter((value): value is string => Boolean(value))
		.slice(0, 4);
}

function commandLog(rest: string, kv: Record<string, string>): DisplayLogEntry | null {
	const match = rest.match(/\bcodex_command_(start|done)=([\s\S]*?)(?:\s+exit=(-?\d+)\b|$)/);
	if (!match) return null;
	const action = match[1];
	const exit = match[3] ?? kv.exit;
	const command = trimShellWrapper(match[2]);
	const failed = exit != null && exit !== "0";
	return {
		level: failed ? "warn" : "info",
		title: action === "start" ? "Command started" : failed ? "Command failed" : "Command finished",
		detail: command,
		chips: collectContextChips({ ...kv, ...(exit ? { exit } : {}) }),
		raw: rest,
		tone: failed ? "warn" : action === "done" ? "success" : "normal",
	};
}

function activityLog(rest: string, kv: Record<string, string>): Partial<DisplayLogEntry> | null {
	if (/\balive=\d+s\b/.test(rest)) {
		const running = kv.running ? `running ${kv.running}` : kv.state;
		return {
			title: running ? `Nyx is working... (${running})` : "Nyx is working...",
			chips: collectContextChips(kv),
			tone: "muted",
		};
	}

	if (/\bbackend=\w+ completed\b/.test(rest)) {
		const backend = kv.backend ? `${kv.backend} ` : "";
		const duration = durationSeconds(kv.duration);
		const tokens = rest.match(/\btokens=([^\s]+)/)?.[1];
		const cost = rest.match(/\bcost=([^\s]+)/)?.[1];
		return {
			title: `${backend}run completed`.trim(),
			detail: [duration, tokens ? `${tokens} tokens` : undefined, cost].filter(Boolean).join(" · "),
			chips: collectContextChips(kv),
			tone: "success",
		};
	}

	const completed = rest.match(/\bCompleted\s+([0-9a-f-]{8,})\s+—\s+(.+)$/i);
	if (completed) {
		return {
			title: "Message completed",
			detail: shorten(completed[2]),
			chips: collectContextChips(kv),
			tone: "success",
		};
	}

	if (rest.includes("Starting graceful shutdown")) {
		return { title: "Graceful shutdown started", chips: collectContextChips(kv), tone: "warn" };
	}

	return null;
}

export function formatLogEntry(entry: LogLike): DisplayLogEntry {
	const { tags, rest } = parseBracketTags(entry.message);
	const module = pickModule(entry, tags);
	const metaTag = tags.find((tag) => tag.includes("="));
	const kv = { ...parseKeyValues(metaTag ?? ""), ...parseKeyValues(rest) };
	const command = commandLog(rest, kv);
	if (command) {
		return { ...command, module, raw: entry.message };
	}

	const activity = activityLog(rest, kv);
	if (activity) {
		return {
			level: entry.level,
			module,
			title: activity.title ?? shorten(shortenPaths(rest), 160),
			detail: activity.detail,
			chips: activity.chips ?? collectContextChips(kv),
			raw: entry.message,
			tone: activity.tone ?? (entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "normal"),
		};
	}

	return {
		level: entry.level,
		module,
		title: shorten(shortenPaths(rest || entry.message), 180),
		chips: collectContextChips(kv),
		raw: entry.message,
		tone: entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : entry.level === "debug" ? "muted" : "normal",
	};
}

export function logMatchesSearch(entry: LogLike, search: string): boolean {
	const needle = search.trim().toLowerCase();
	if (!needle) return true;
	const display = formatLogEntry(entry);
	return [display.title, display.detail, display.module, display.raw, ...display.chips]
		.filter(Boolean)
		.join(" ")
		.toLowerCase()
		.includes(needle);
}

export function meetsMinLevel(entry: LogLike, minLevel: LogLevel | "all" | ""): boolean {
	if (!minLevel || minLevel === "all") return true;
	return LEVEL_PRIORITY[formatLogEntry(entry).level] >= LEVEL_PRIORITY[minLevel];
}
