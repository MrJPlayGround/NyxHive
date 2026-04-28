import { Check } from "lucide-react";
import { cn } from "../lib/utils";
import { useUiPrefs, GATEWAY_THEMES, type GatewayTheme } from "../stores/ui-prefs";

const THEME_SWATCHES: Record<GatewayTheme, string[]> = {
	aether: ["rgb(106, 173, 255)", "rgb(139, 196, 255)", "#080c12"],
	signal: ["rgb(100, 214, 154)", "rgb(167, 243, 197)", "#070b0a"],
	emberless: ["rgb(255, 122, 138)", "rgb(255, 192, 199)", "#0c080a"],
	mono: ["rgb(214, 214, 214)", "rgb(255, 255, 255)", "#070707"],
};

export function AppearancePage() {
	const theme = useUiPrefs((s) => s.theme);
	const setTheme = useUiPrefs((s) => s.setTheme);

	return (
		<div className="max-w-xl">
			<h2 className="text-lg font-semibold text-[var(--nyx-text)]">Theme</h2>
			<p className="mt-1 text-sm text-[var(--nyx-muted)]">
				Choose an accent palette for the gateway.
			</p>

			<div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
				{GATEWAY_THEMES.map((t) => {
					const active = theme === t.id;
					const swatches = THEME_SWATCHES[t.id];
					return (
						<button
							key={t.id}
							type="button"
							onClick={() => setTheme(t.id)}
							className={cn(
								"relative flex flex-col items-start rounded-lg border p-3 text-left transition-colors",
								active
									? "border-[var(--nyx-accent)] bg-[var(--nyx-accent-dim)]"
									: "border-[var(--nyx-line)] bg-[var(--nyx-panel)] hover:border-[var(--nyx-line-strong)]",
							)}
						>
							{active && (
								<span className="absolute top-2 right-2 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--nyx-accent)] text-[var(--nyx-bg)]">
									<Check className="h-3 w-3" />
								</span>
							)}
							<div className="mb-2 flex gap-1.5">
								{swatches.map((color, i) => (
									<span
										key={i}
										className="h-5 w-5 rounded-full border border-white/10"
										style={{ backgroundColor: color }}
									/>
								))}
							</div>
							<span className={cn("text-sm font-medium", active ? "text-[var(--nyx-accent)]" : "text-[var(--nyx-text)]")}>
								{t.label}
							</span>
							<span className="text-[11px] text-[var(--nyx-muted)]">
								{t.description}
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}
