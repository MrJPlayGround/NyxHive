import { useNavigate } from "react-router-dom";
import { cn } from "../../lib/utils";
import type { Agent } from "../../stores/agents";

const statusColors = {
	idle: "bg-[var(--nyx-accent)]",
	running: "bg-[var(--nyx-warn)] shadow-[0_0_6px_var(--nyx-warn)]",
	error: "bg-[var(--nyx-danger)] shadow-[0_0_6px_var(--nyx-danger)]",
};

const roleColors: Record<string, string> = {
	lead: "from-[var(--nyx-accent)] to-[var(--nyx-accent-2)]",
	worker: "from-[var(--nyx-accent-2)] to-[#6b8cdb]",
	coder: "from-emerald-500 to-teal-400",
	default: "from-zinc-500 to-zinc-400",
};

export function AgentStrip({ agents }: { agents: Agent[] }) {
	const navigate = useNavigate();

	if (agents.length === 0) return null;

	return (
		<div className="flex flex-wrap gap-2">
			{agents.map((agent) => {
				const gradient = roleColors[agent.role] ?? roleColors.default;
				const initial = agent.name.charAt(0).toUpperCase();

				return (
					<button
						key={agent.id}
						onClick={() => navigate(`/agents?focus=${agent.id}`)}
						className={cn(
							"flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-all duration-150",
							agent.status === "running"
								? "border-[rgb(var(--nyx-accent-rgb)/0.15)] bg-[var(--nyx-accent-dim)]"
								: agent.status === "error"
									? "border-[rgba(244,112,104,0.15)] bg-[var(--nyx-danger-dim)]"
									: "border-[var(--nyx-line)] bg-[rgba(255,255,255,0.02)] hover:border-[var(--nyx-line-strong)]",
						)}
					>
						<div className={cn(
							"flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-bold",
							`bg-gradient-to-br ${gradient} text-white`,
						)}>
							{initial}
						</div>
						<div className="min-w-0">
							<div className="text-sm font-medium leading-tight">{agent.name}</div>
							{agent.status === "running" && agent.currentTask ? (
								<div className="max-w-[180px] truncate text-[11px] text-[var(--nyx-muted)]">{agent.currentTask}</div>
							) : (
								<div className="text-[11px] text-[var(--nyx-muted)]">{agent.role}</div>
							)}
						</div>
						<div className={cn("ml-1 h-2 w-2 shrink-0 rounded-full", statusColors[agent.status])} />
					</button>
				);
			})}
		</div>
	);
}
