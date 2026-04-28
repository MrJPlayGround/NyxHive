import { useEffect } from "react";
import { Bot, ChevronDown } from "lucide-react";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Badge } from "../ui/badge";
import { useAgentsStore } from "../../stores/agents";

interface AgentSelectorProps {
	activeAgent: string;
	onSelect: (agent: string) => void;
}

export function AgentSelector({ activeAgent, onSelect }: AgentSelectorProps) {
	const { agents, fetchAgents } = useAgentsStore();

	useEffect(() => {
		if (agents.length === 0) fetchAgents();
	}, [agents.length, fetchAgents]);

	const current = agents.find((a) => a.id === activeAgent) ?? {
		id: activeAgent,
		name: activeAgent,
		role: "",
		status: "idle" as const,
	};

	const statusColor = {
		idle: "bg-emerald-500",
		running: "bg-amber-500",
		error: "bg-red-500",
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="outline" size="sm" className="gap-2">
					<Bot className="h-4 w-4" />
					{current.name}
					<div className={`h-2 w-2 rounded-full ${statusColor[current.status]}`} />
					<ChevronDown className="h-3 w-3 opacity-50" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				{agents
					.filter((a) => a.enabled)
					.map((agent) => (
						<DropdownMenuItem
							key={agent.id}
							onClick={() => onSelect(agent.id)}
							className="gap-2"
						>
							<div className={`h-2 w-2 rounded-full ${statusColor[agent.status]}`} />
							<span>{agent.name}</span>
							<Badge variant="secondary" className="ml-auto text-xs">
								{agent.role}
							</Badge>
						</DropdownMenuItem>
					))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
