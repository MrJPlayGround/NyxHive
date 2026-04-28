import { useEffect, useState } from "react";
import {
	Server,
	Bot,
	Users,
	Radio,
	BookOpen,
	Shield,
	RefreshCw,
	Cpu,
	Route,
	FileText,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";
import { gateway } from "../lib/ws";
import { channelIcons } from "../lib/types";

interface SettingsData {
	instance: { name: string; data_dir: string; log_level: string };
	server: { port: number; has_api_key: boolean };
	agents: Record<
		string,
		{
			name: string;
			role: string;
			provider: string;
			model: string;
			working_directory?: string;
			capabilities?: string[];
		}
	>;
	teams: Record<string, { name: string; agents: string[]; description?: string }>;
	channels: string[];
	routing: { classifier_model: string; classifier_provider: string };
	vault: { path: string } | null;
	review_gate: boolean;
	pairing: boolean;
	config_path: string;
}

function SectionCard({
	icon: Icon,
	title,
	children,
}: {
	icon: React.ElementType;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-300">
					<Icon className="h-4 w-4 text-zinc-500" />
					{title}
				</CardTitle>
			</CardHeader>
			<CardContent>{children}</CardContent>
		</Card>
	);
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div className="flex items-center justify-between py-1.5">
			<span className="text-xs text-zinc-500">{label}</span>
			<span className="text-xs text-zinc-300">{value}</span>
		</div>
	);
}

const roleBadgeColor: Record<string, string> = {
	lead: "bg-[rgb(var(--nyx-accent-rgb)/0.12)] text-[var(--nyx-accent)] border-[rgb(var(--nyx-accent-rgb)/0.25)]",
	worker: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
};

export function ConfigPage() {
	const [settings, setSettings] = useState<SettingsData | null>(null);
	const [loading, setLoading] = useState(true);

	const fetchSettings = async () => {
		setLoading(true);
		try {
			const result = await gateway.request<{
				content: string;
				path: string;
			}>("config.get", {});

			// Parse TOML to extract structured data
			const lines = result.content.split("\n");
			const parsed = parseTomlBasic(lines);

			setSettings({
				instance: {
					name: parsed.daemon?.name ?? "NyxHive",
					data_dir: parsed.daemon?.data_dir ?? "./data",
					log_level: parsed.daemon?.log_level ?? "info",
				},
				server: {
					port: parsed.server?.port ?? 3777,
					has_api_key: !!parsed.server?.api_key,
				},
				agents: parsed._agents ?? {},
				teams: parsed._teams ?? {},
				channels: [
					parsed.telegram ? "telegram" : null,
					parsed.discord ? "discord" : null,
					parsed.slack ? "slack" : null,
					parsed.imessage ? "imessage" : null,
				].filter(Boolean) as string[],
				routing: {
					classifier_model: parsed.routing?.classifier_model ?? "unknown",
					classifier_provider: parsed.routing?.classifier_provider ?? "unknown",
				},
				vault: parsed.vault?.path ? { path: parsed.vault.path } : null,
				review_gate: parsed.review_gate?.enabled === true,
				pairing: parsed.pairing?.enabled === true,
				config_path: result.path,
			});
		} catch {
			// Failed to fetch
		}
		setLoading(false);
	};

	useEffect(() => {
		fetchSettings();
	}, []);

	if (loading) {
		return (
			<div className="grid gap-4 md:grid-cols-2">
				{Array.from({ length: 6 }).map((_, i) => (
					<Skeleton key={i} className="h-40 rounded-xl" />
				))}
			</div>
		);
	}

	if (!settings) {
		return (
			<div className="text-sm text-zinc-500">Failed to load configuration.</div>
		);
	}

	const agentEntries = Object.entries(settings.agents);
	const teamEntries = Object.entries(settings.teams);

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div>
					<h2 className="text-lg font-semibold text-zinc-200">
						{settings.instance.name}
					</h2>
					<p className="text-xs text-zinc-500">
						Read-only view — edit{" "}
						<code className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-400">
							nyxhive.toml
						</code>{" "}
						to change configuration
					</p>
				</div>
				<button
					onClick={fetchSettings}
					className="rounded-md p-2 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
				>
					<RefreshCw className="h-4 w-4" />
				</button>
			</div>

			<div className="grid gap-4 md:grid-cols-2">
				{/* Instance */}
				<SectionCard icon={Cpu} title="Instance">
					<div className="divide-y divide-zinc-800/50">
						<Field label="Name" value={settings.instance.name} />
						<Field label="Data Directory" value={<code className="text-xs text-zinc-400">{settings.instance.data_dir}</code>} />
						<Field label="Log Level" value={
							<Badge variant="outline" className="text-xs">{settings.instance.log_level}</Badge>
						} />
					</div>
				</SectionCard>

				{/* Server */}
				<SectionCard icon={Server} title="Server">
					<div className="divide-y divide-zinc-800/50">
						<Field label="Port" value={settings.server.port} />
						<Field
							label="API Key"
							value={
								settings.server.has_api_key ? (
									<Badge variant="outline" className="text-xs text-emerald-400 border-emerald-500/30">
										Configured
									</Badge>
								) : (
									<Badge variant="outline" className="text-xs text-zinc-500 border-zinc-700">
										Not set
									</Badge>
								)
							}
						/>
						<Field label="Config" value={<code className="text-xs text-zinc-500">{settings.config_path}</code>} />
					</div>
				</SectionCard>

				{/* Agents */}
				<SectionCard icon={Bot} title={`Agents (${agentEntries.length})`}>
					<div className="space-y-3">
						{agentEntries.map(([id, agent]) => (
							<div
								key={id}
								className="rounded-lg border border-zinc-800/50 bg-zinc-900/50 p-3"
							>
								<div className="flex items-center gap-2 mb-2">
									<span className="text-sm font-medium text-zinc-200">
										{agent.name}
									</span>
									<Badge
										variant="outline"
										className={`text-[10px] ${roleBadgeColor[agent.role] ?? roleBadgeColor.worker}`}
									>
										{agent.role}
									</Badge>
								</div>
								<div className="space-y-1 text-xs text-zinc-500">
									<div className="flex justify-between">
										<span>Provider</span>
										<span className="text-zinc-400">{agent.provider}</span>
									</div>
									<div className="flex justify-between">
										<span>Model</span>
										<span className="text-zinc-400 font-mono">{agent.model}</span>
									</div>
									{agent.capabilities && agent.capabilities.length > 0 && (
										<div className="flex justify-between">
											<span>Capabilities</span>
											<div className="flex gap-1">
												{agent.capabilities.map((cap) => (
													<Badge
														key={cap}
														variant="outline"
														className="text-[10px] text-zinc-500"
													>
														{cap}
													</Badge>
												))}
											</div>
										</div>
									)}
								</div>
							</div>
						))}
					</div>
				</SectionCard>

				{/* Teams */}
				{teamEntries.length > 0 && (
					<SectionCard icon={Users} title={`Teams (${teamEntries.length})`}>
						<div className="space-y-3">
							{teamEntries.map(([id, team]) => (
								<div
									key={id}
									className="rounded-lg border border-zinc-800/50 bg-zinc-900/50 p-3"
								>
									<div className="text-sm font-medium text-zinc-200 mb-1">
										{team.name}
									</div>
									{team.description && (
										<div className="text-xs text-zinc-500 mb-2">
											{team.description}
										</div>
									)}
									<div className="flex gap-1.5">
										{team.agents.map((a) => (
											<Badge
												key={a}
												variant="outline"
												className="text-[10px] text-zinc-400"
											>
												{a}
											</Badge>
										))}
									</div>
								</div>
							))}
						</div>
					</SectionCard>
				)}

				{/* Routing */}
				<SectionCard icon={Route} title="Routing">
					<div className="divide-y divide-zinc-800/50">
						<Field
							label="Classifier Model"
							value={
								<code className="text-xs text-zinc-400 font-mono">
									{settings.routing.classifier_model}
								</code>
							}
						/>
						<Field
							label="Classifier Provider"
							value={settings.routing.classifier_provider}
						/>
					</div>
				</SectionCard>

				{/* Channels */}
				<SectionCard icon={Radio} title="Channels">
					{settings.channels.length === 0 ? (
						<div className="text-xs text-zinc-500">No channels configured</div>
					) : (
						<div className="flex flex-wrap gap-2">
							{settings.channels.map((ch) => (
								<Badge
									key={ch}
									variant="outline"
									className="text-xs text-emerald-400 border-emerald-500/30"
								>
									{channelIcons[ch] ?? ch}
								</Badge>
							))}
						</div>
					)}
				</SectionCard>

				{/* Integrations */}
				<SectionCard icon={BookOpen} title="Integrations">
					<div className="divide-y divide-zinc-800/50">
						<Field
							label="Obsidian Vault"
							value={
								settings.vault ? (
									<code className="text-xs text-zinc-400">{settings.vault.path}</code>
								) : (
									<span className="text-zinc-600">Not configured</span>
								)
							}
						/>
						<Field
							label="Review Gate"
							value={
								<Badge
									variant="outline"
									className={`text-[10px] ${settings.review_gate ? "text-emerald-400 border-emerald-500/30" : "text-zinc-600 border-zinc-700"}`}
								>
									{settings.review_gate ? "Enabled" : "Disabled"}
								</Badge>
							}
						/>
						<Field
							label="Pairing Mode"
							value={
								<Badge
									variant="outline"
									className={`text-[10px] ${settings.pairing ? "text-emerald-400 border-emerald-500/30" : "text-zinc-600 border-zinc-700"}`}
								>
									{settings.pairing ? "Enabled" : "Disabled"}
								</Badge>
							}
						/>
					</div>
				</SectionCard>
			</div>
		</div>
	);
}

/**
 * Basic TOML parser — extracts top-level sections and key-value pairs.
 * Handles [section], [section.subsection], basic strings, numbers, booleans, arrays.
 * Does NOT handle multiline strings or inline tables — those sections are parsed
 * via the structured agent/team extraction below.
 */
function parseTomlBasic(lines: string[]): Record<string, any> {
	const result: Record<string, any> = {};
	const agents: Record<string, any> = {};
	const teams: Record<string, any> = {};
	let currentSection = "";
	let currentAgent = "";
	let currentTeam = "";
	let inMultilineString = false;
	let multilineKey = "";
	let multilineValue = "";

	for (const line of lines) {
		const trimmed = line.trim();

		// Handle multiline strings
		if (inMultilineString) {
			if (trimmed.includes('"""')) {
				multilineValue += trimmed.replace('"""', "");
				// Store the multiline value (skip it for now — system prompts)
				inMultilineString = false;
				multilineKey = "";
				multilineValue = "";
			} else {
				multilineValue += trimmed + "\n";
			}
			continue;
		}

		// Skip comments and empty lines
		if (!trimmed || trimmed.startsWith("#")) continue;

		// Section headers
		const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
		if (sectionMatch) {
			const section = sectionMatch[1];

			// Handle [agents.xxx]
			const agentMatch = section.match(/^agents\.(.+)$/);
			if (agentMatch) {
				currentAgent = agentMatch[1];
				currentTeam = "";
				agents[currentAgent] = { name: currentAgent, role: "worker", capabilities: [] };
				currentSection = `agents.${currentAgent}`;
				continue;
			}

			// Handle [teams.xxx]
			const teamMatch = section.match(/^teams\.(.+)$/);
			if (teamMatch) {
				currentTeam = teamMatch[1];
				currentAgent = "";
				teams[currentTeam] = { name: currentTeam, agents: [] };
				currentSection = `teams.${currentTeam}`;
				continue;
			}

			currentSection = section;
			currentAgent = "";
			currentTeam = "";
			if (!result[section]) result[section] = {};
			continue;
		}

		// Key = value pairs
		const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
		if (!kvMatch) continue;

		const [, key, rawValue] = kvMatch;
		let value: any = rawValue;

		// Check for multiline string start
		if (rawValue.startsWith('"""') && !rawValue.endsWith('"""')) {
			inMultilineString = true;
			multilineKey = key;
			multilineValue = rawValue.slice(3) + "\n";
			continue;
		}
		// Single-line triple-quoted string
		if (rawValue.startsWith('"""') && rawValue.endsWith('"""')) {
			continue; // Skip system prompts
		}

		// Parse value
		value = parseTomlValue(rawValue);

		// Store in correct location
		if (currentAgent) {
			agents[currentAgent][key] = value;
		} else if (currentTeam) {
			teams[currentTeam][key] = value;
		} else if (currentSection) {
			result[currentSection][key] = value;
		}
	}

	result._agents = agents;
	result._teams = teams;
	return result;
}

function parseTomlValue(raw: string): any {
	const trimmed = raw.trim();

	// Remove inline comments
	const commentless = trimmed.replace(/\s+#.*$/, "");

	// Boolean
	if (commentless === "true") return true;
	if (commentless === "false") return false;

	// Number
	if (/^-?\d+(\.\d+)?$/.test(commentless)) return Number(commentless);

	// String
	if (
		(commentless.startsWith('"') && commentless.endsWith('"')) ||
		(commentless.startsWith("'") && commentless.endsWith("'"))
	) {
		return commentless.slice(1, -1);
	}

	// Array of strings
	if (commentless.startsWith("[") && commentless.endsWith("]")) {
		const inner = commentless.slice(1, -1);
		if (!inner.trim()) return [];
		return inner
			.split(",")
			.map((s) => s.trim())
			.map((s) => {
				if (
					(s.startsWith('"') && s.endsWith('"')) ||
					(s.startsWith("'") && s.endsWith("'"))
				) {
					return s.slice(1, -1);
				}
				return s;
			});
	}

	return commentless;
}
