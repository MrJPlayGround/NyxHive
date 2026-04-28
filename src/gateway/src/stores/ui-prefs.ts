import { create } from "zustand";
import { persist } from "zustand/middleware";

export type GatewayTheme = "aether" | "signal" | "emberless" | "mono";

export const GATEWAY_THEMES: { id: GatewayTheme; label: string; description: string }[] = [
	{ id: "aether", label: "Aether", description: "Blue signal — default" },
	{ id: "signal", label: "Signal", description: "Mint operator accent" },
	{ id: "emberless", label: "Emberless", description: "Coral operator accent" },
	{ id: "mono", label: "Mono", description: "High contrast" },
];

interface UiPrefs {
	theme: GatewayTheme;
	showReasoning: boolean;
	showToolCalls: boolean;
	focusMode: boolean;
	setTheme: (theme: GatewayTheme) => void;
	toggleReasoning: () => void;
	toggleToolCalls: () => void;
	toggleFocusMode: () => void;
}

export const useUiPrefs = create<UiPrefs>()(persist((set) => ({
	theme: "aether",
	showReasoning: true,
	showToolCalls: true,
	focusMode: false,
	setTheme: (theme) => set({ theme }),
	toggleReasoning: () => set((s) => ({ showReasoning: !s.showReasoning })),
	toggleToolCalls: () => set((s) => ({ showToolCalls: !s.showToolCalls })),
	toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode })),
}), {
	name: "nyxhive-ui-prefs",
}));
