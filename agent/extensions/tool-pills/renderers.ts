import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { pill } from "./pill.js";

/** Max lines shown in collapsed (non-expanded) result view. */
const COLLAPSED_MAX_LINES = 15;

/** Extract the first text content from a tool result. */
export function getText(result: AgentToolResult<unknown>): string | undefined {
	const c = result.content.find((c) => c.type === "text");
	return c?.type === "text" ? c.text : undefined;
}

/** Render tool output text with collapsed truncation + expand hint. */
export function renderTextResult(
	text: string | undefined,
	expanded: boolean,
	theme: Theme,
	mode: "head" | "tail" = "head",
): Text {
	if (!text || !text.trim()) return new Text("", 0, 0);

	const lines = text.split("\n");

	if (expanded || lines.length <= COLLAPSED_MAX_LINES) {
		const output = lines.map((l) => theme.fg("toolOutput", l)).join("\n");
		return new Text(`\n${output}`, 0, 0);
	}

	const hidden = lines.length - COLLAPSED_MAX_LINES;
	const hint = theme.fg("dim", `... ${hidden} more lines (${keyHint("app.tools.expand", "to expand")})`);

	if (mode === "tail") {
		const visible = lines.slice(-COLLAPSED_MAX_LINES);
		const output = visible.map((l) => theme.fg("toolOutput", l)).join("\n");
		return new Text(`\n${hint}\n${output}`, 0, 0);
	}

	const visible = lines.slice(0, COLLAPSED_MAX_LINES);
	const output = visible.map((l) => theme.fg("toolOutput", l)).join("\n");
	return new Text(`\n${output}\n${hint}`, 0, 0);
}

/** Helper to register a basic tool (ls, read, find, grep) with pill + collapsed output. */
export function wrapBasicTool(
	pi: ExtensionAPI,
	orig: any,
	name: string,
	mkCallText: (args: any, theme: Theme) => string,
	mode: "head" | "tail" = "head",
): void {
	pi.registerTool({
		...orig,
		parameters: { ...orig.parameters },
		renderCall(args: any, theme: Theme, _ctx: any) {
			return new Text(pill(name, theme) + " " + mkCallText(args, theme), 0, 0);
		},
		renderResult(result: any, { expanded }: { expanded: boolean }, theme: Theme, _ctx: any) {
			return renderTextResult(getText(result), expanded, theme, mode);
		},
	});
}

export function renderBashCall(args: any, theme: Theme): Text {
	const cmd = args.command ?? "";
	const highlighted = highlightCode(cmd, "bash").join("\n");
	const isMultiLine = cmd.includes("\n") || cmd.length > 80;
	if (isMultiLine) {
		return new Text(pill("bash", theme) + "\n" + highlighted, 0, 0);
	}
	return new Text(pill("bash", theme) + " " + highlighted, 0, 0);
}

export function renderBashResult(result: any, { expanded }: { expanded: boolean }, theme: Theme): Text {
	return renderTextResult(getText(result), expanded, theme, "tail");
}
