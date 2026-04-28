import { useEffect } from "react";
import { useUiPrefs } from "../stores/ui-prefs";

/** Syncs the active theme to document.documentElement.dataset.theme */
export function useThemeSync() {
	const theme = useUiPrefs((s) => s.theme);

	useEffect(() => {
		document.documentElement.dataset.theme = theme;
	}, [theme]);
}
