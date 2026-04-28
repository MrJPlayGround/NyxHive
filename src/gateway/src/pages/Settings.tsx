import {
	Settings as SettingsIcon,
	Clock,
	Radio,
	Smartphone,
	Activity,
	BrainCircuit,
	Palette,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { cn } from "../lib/utils";
import { ConfigPage } from "./Config";
import { SchedulerPage } from "./Scheduler";
import { ChannelsPage } from "./Channels";
import { DevicesPage } from "./Devices";
import { SystemPage } from "./System";
import { ProceduralSkillsPage } from "./ProceduralSkills";
import { AppearancePage } from "./Appearance";
import type { LucideIcon } from "lucide-react";

interface SettingsTab {
	id: string;
	label: string;
	icon: LucideIcon;
	component: React.ComponentType;
}

const tabs: SettingsTab[] = [
	{ id: "system", label: "System", icon: Activity, component: SystemPage },
	{
		id: "appearance",
		label: "Appearance",
		icon: Palette,
		component: AppearancePage,
	},
	{
		id: "config",
		label: "Config",
		icon: SettingsIcon,
		component: ConfigPage,
	},
	{
		id: "scheduler",
		label: "Scheduler",
		icon: Clock,
		component: SchedulerPage,
	},
	{
		id: "channels",
		label: "Channels",
		icon: Radio,
		component: ChannelsPage,
	},
	{
		id: "devices",
		label: "Devices",
		icon: Smartphone,
		component: DevicesPage,
	},
	{
		id: "skills",
		label: "Skills",
		icon: BrainCircuit,
		component: ProceduralSkillsPage,
	},
];

export function SettingsPage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const activeTab = searchParams.get("tab") ?? "system";
	const setActiveTab = (tab: string) => setSearchParams({ tab }, { replace: true });
	const active = tabs.find((t) => t.id === activeTab) ?? tabs[0];
	const ActiveComponent = active.component;

	return (
		<div>
			<h1 className="text-2xl font-semibold">Settings</h1>
			<p className="mt-1 text-sm text-zinc-400">
				System configuration and monitoring
			</p>

			<div className="mt-4 flex gap-1 overflow-x-auto border-b border-zinc-800 pb-px">
				{tabs.map((tab) => {
					const Icon = tab.icon;
					return (
						<button
							key={tab.id}
							onClick={() => setActiveTab(tab.id)}
							className={cn(
								"flex shrink-0 items-center gap-2 rounded-t-md px-3 py-2 text-sm font-medium transition-colors",
								activeTab === tab.id
									? "border-b-2 border-white text-white"
									: "text-zinc-500 hover:text-zinc-300",
							)}
						>
							<Icon className="h-3.5 w-3.5" />
							{tab.label}
						</button>
					);
				})}
			</div>

			<div className="mt-6">
				<ActiveComponent />
			</div>
		</div>
	);
}
