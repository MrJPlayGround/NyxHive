import { describe, expect, test } from "bun:test";
import { formatLogEntry, logMatchesSearch, meetsMinLevel } from "./log-display";

describe("log display formatting", () => {
	test("summarizes codex command completion without shell wrapper noise", () => {
		const display = formatLogEntry({
			level: "info",
			module: "nyxai",
			timestamp: Date.now(),
			message: `[nyxai] [invoke] [msg=c8c305fd ch=gateway agent=Nyx] turn=1 elapsed=84s codex_command_done=/bin/zsh -lc "sed -n '1,280p' /home/user/dev/nyxhive/src/cli/stop.ts" exit=0`,
		});

		expect(display.module).toBe("invoke");
		expect(display.title).toBe("Command finished");
		expect(display.detail).toContain("sed -n");
		expect(display.detail).toContain("nyxhive/src/cli/stop.ts");
		expect(display.detail).not.toContain("/bin/zsh -lc");
		expect(display.chips).toContain("Nyx");
		expect(display.chips).toContain("# gateway");
		expect(display.chips).toContain("exit 0");
	});

	test("marks non-zero command exits as warning rows", () => {
		const display = formatLogEntry({
			level: "info",
			timestamp: Date.now(),
			message: `[nyxai] [invoke] codex_command_done=/bin/zsh -lc "cat missing" exit=1`,
		});

		expect(display.title).toBe("Command failed");
		expect(display.level).toBe("warn");
		expect(display.tone).toBe("warn");
	});

	test("turns alive pings into readable activity", () => {
		const display = formatLogEntry({
			level: "info",
			timestamp: Date.now(),
			message: `[nyxai] [invoke] [msg=abc ch=gateway agent=Nyx] alive=94s command=item_40 running=3s`,
		});

		expect(display.title).toBe("Nyx is working... (running 3s)");
		expect(display.tone).toBe("muted");
	});

	test("formats completed backend runs with readable duration", () => {
		const display = formatLogEntry({
			level: "info",
			timestamp: Date.now(),
			message: "[invoke] backend=codex completed duration=235823ms tokens=0+0 cost=$0.0000 turns=1",
		});

		expect(display.title).toBe("codex run completed");
		expect(display.detail).toContain("236s");
		expect(display.detail).not.toContain("NaN");
	});

	test("searches display and raw fields", () => {
		const entry = {
			level: "info" as const,
			timestamp: Date.now(),
			message: `[nyxai] [invoke] codex_command_start=/bin/zsh -lc "bun test src/gateway/src"`,
		};

		expect(logMatchesSearch(entry, "command started")).toBe(true);
		expect(logMatchesSearch(entry, "gateway")).toBe(true);
		expect(logMatchesSearch(entry, "not-present")).toBe(false);
	});

	test("filters by minimum level", () => {
		expect(meetsMinLevel({ level: "info", message: "", timestamp: 0 }, "warn")).toBe(false);
		expect(meetsMinLevel({ level: "error", message: "", timestamp: 0 }, "warn")).toBe(true);
		expect(meetsMinLevel({ level: "debug", message: "", timestamp: 0 }, "all")).toBe(true);
		expect(
			meetsMinLevel(
				{
					level: "info",
					message: `[nyxai] [invoke] codex_command_done=/bin/zsh -lc "cat missing" exit=1`,
					timestamp: 0,
				},
				"warn",
			),
		).toBe(true);
	});
});
