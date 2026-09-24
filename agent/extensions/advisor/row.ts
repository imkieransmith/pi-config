/**
 * Compact one-line row for the advisor tool: pill, brief and a note on the right;
 * expanding shows the whole brief and the advice.
 *
 * A trimmed copy of tool-pills/renderers.ts `row()`, kept here because the advisor
 * folder must not import from outside itself. tests/tool-rows.test.ts checks
 * that both draw the same lines.
 */
import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2] & { state: { note?: string; hasBody?: boolean } };

/** Same deep blue as tool-pills uses for tools these extensions add. */
const PILL_FG = "\x1b[38;2;47;95;159m";

function text(result: AgentToolResult<any>): string {
	const c = result.content.find((c) => c.type === "text");
	return c?.type === "text" ? c.text : "";
}

function note(result: AgentToolResult<any>): string {
	if ((result.details as { errorMessage?: string } | undefined)?.errorMessage) return "failed";
	const n = text(result).trimEnd().split("\n").length;
	return text(result).trim() ? `${n} ${n === 1 ? "line" : "lines"}` : "no output";
}

function tinted(ctx: RenderContext, theme: Theme, ...children: Component[]): Box {
	const role = ctx.isPartial ? "toolPendingBg" : ctx.isError ? "toolErrorBg" : "toolSuccessBg";
	const box = new Box(1, 0, (t) => theme.bg(role, t.replaceAll("\x1b[0m", `\x1b[0m${theme.getBgAnsi(role)}`)));
	for (const child of children) box.addChild(child);
	return box;
}

function header(head: string, noteText: string, width: number, expanded: boolean, theme: Theme): string[] {
	const noteWidth = visibleWidth(noteText);
	const room = Math.max(10, width - (noteWidth ? noteWidth + 2 : 0));
	const [first, ...rest] = head.split("\n");
	const lines = expanded
		? [...wrapTextWithAnsi(first, room), "", ...rest.flatMap((line) => wrapTextWithAnsi(line, room))]
		: [truncateToWidth(rest.length ? `${first}${theme.fg("dim", " …")}` : first, room)];
	lines[0] += " ".repeat(Math.max(1, width - visibleWidth(lines[0]) - noteWidth)) + noteText;
	return lines;
}

export const advisorRow = {
	renderShell: "self" as const,
	renderCall(args: { brief?: string }, theme: Theme, ctx: RenderContext): Component {
		ctx.state.hasBody = false;
		return tinted(ctx, theme, {
			invalidate() {},
			render: (width: number) => {
				const done = !ctx.isPartial;
				const noteText = theme.fg(ctx.isError ? "error" : "dim", [ctx.state.note, done ? (ctx.expanded ? "▾" : "▸") : ""].filter(Boolean).join(" "));
				const pill = theme.bold(theme.inverse(`${PILL_FG} advisor \x1b[39m`));
				return ["", ...header(`${pill} ${args.brief ?? ""}`, noteText, width, ctx.expanded, theme), ...(ctx.state.hasBody ? [] : [""])];
			},
		});
	},
	renderResult(result: AgentToolResult<any>, { expanded }: { expanded: boolean }, theme: Theme, ctx: RenderContext): Component {
		ctx.state.note = ctx.isPartial ? undefined : ctx.isError ? "error" : note(result);
		if (!expanded) return new Text("", 0, 0);
		ctx.state.hasBody = true;
		const body = ctx.isError ? theme.fg("error", text(result).trim()) : theme.fg("toolOutput", text(result).trimEnd());
		return tinted(ctx, theme, new Text(body, 0, 0), new Spacer(1));
	},
};
