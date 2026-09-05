// Superset pi extension v1
/**
 * Superset Notification Extension for pi
 *
 * Emits Claude-Code-compatible lifecycle hooks to Superset's notify.sh so
 * the host UI gets a "working" indicator (and completion chime) for pi
 * sessions, the same way it does for Claude Code, Codex, etc.
 *
 * Mapping:
 *   pi `before_agent_start`  → Claude `UserPromptSubmit`  → Superset `Start`
 *   pi `tool_execution_end`  → Claude `PostToolUse`       → progress signal
 *   pi `agent_settled`           → Claude `Stop`              → completion / chime
 *   pi `session_shutdown`    → Claude `SessionEnd`              → cleanup on quit/reload
 *
 * Activates only when running inside a v2 Superset terminal (detected via
 * SUPERSET_TERMINAL_ID). Outside Superset it's a complete no-op. If notify.sh
 * is missing it's also a no-op (Superset uninstalled / never installed).
 *
 * Hook dispatch is fire-and-forget: failures to spawn or curl never
 * affect the agent loop. notify.sh has its own connect/max timeouts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
	// Only activate inside a v2 Superset terminal.
	if (!process.env.SUPERSET_TERMINAL_ID) return;

	const supersetHome =
		process.env.SUPERSET_HOME_DIR || join(homedir(), ".superset");
	const notifyScript = join(supersetHome, "hooks", "notify.sh");
	if (!existsSync(notifyScript)) return;

	const fire = (eventName: string) => {
		try {
			const child = spawn(notifyScript, [], {
				stdio: ["pipe", "ignore", "ignore"],
				detached: true,
				env: { ...process.env, SUPERSET_AGENT_ID: "pi" },
			});
			child.on("error", () => {
				/* swallow — never let hook failures affect pi */
			});
			child.stdin?.on("error", () => {
				/* swallow — happens if notify.sh exits before we finish writing */
			});
			child.stdin?.end(JSON.stringify({ hook_event_name: eventName }));
			child.unref();
		} catch {
			// spawn() can throw synchronously (EACCES, ENOENT). Stay silent.
		}
	};

	const skip = (ctx: { mode: string }) => ctx.mode !== "tui";

	// Earliest signal pi is alive in this terminal — pi-mono fires
	// `session_start` once per session before any prompt arrives, which lets
	// the host bind the pane icon before the user types.
	pi.on("session_start", (_event, ctx) => {
		if (skip(ctx)) return;
		fire("SessionStart");
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (skip(ctx)) return;
		fire("UserPromptSubmit");
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		if (skip(ctx)) return;
		fire("PostToolUse");
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (skip(ctx)) return;
		fire("Stop");
	});

	// Ensure we mark the agent as "stopped" if pi is killed mid-run, so the
	// Superset working indicator doesn't get stuck on. Fires on Ctrl+C,
	// SIGTERM, SIGHUP, /quit, /reload, /new, /resume, /fork.
	pi.on("session_shutdown", (_event, ctx) => {
		if (skip(ctx)) return;
		fire("SessionEnd");
	});
}
