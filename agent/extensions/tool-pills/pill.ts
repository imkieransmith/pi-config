/**
 * Shared pill badge renderer for tool headers.
 *
 * Produces an inverted-colour badge like ` write `: theme roles for Pi's built-in
 * tools, one deep blue for tools added by these extensions.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";

/** Map tool name → theme semantic colour role for the pill badge. */
const TOOL_ROLES: Record<string, string> = {
	ls: "success",
	read: "success",
	find: "mdCode",
	grep: "mdCode",
	bash: "error",
	write: "accent",
	create: "accent",
	edit: "warning",
};

/** Deep blue for every tool we add ourselves, to echo the blue of user messages. */
const OWN_TOOL_FG = "\x1b[38;2;47;95;159m"; // #2f5f9f

/** Render an inverted-colour pill badge: ` name ` */
export function pill(name: string, theme: Theme): string {
	const role = TOOL_ROLES[name];
	const text = role ? theme.fg(role as any, ` ${name} `) : `${OWN_TOOL_FG} ${name} \x1b[39m`;
	return theme.bold(theme.inverse(text));
}
