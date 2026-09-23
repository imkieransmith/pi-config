/**
 * Coloured tool pills + diff renderer.
 *
 * Original - https://github.com/tomsej/pi-ext/tree/main/extensions/tool-pills
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { protectDiscovery } from "../security/search.ts";
import { registerDiffTools } from "./diff-renderer.js";
import { countNote, getText, wrapBasicTool } from "./renderers.js";

/** Counts output lines, ignoring Pi's "No matches found" style messages and truncation notes. */
const lineCount = (one: string, many: string) => (result: any) => {
	const lines = getText(result).split("\n").filter(l => l.trim() && !/^[[(].*[\])]$/.test(l.trim()));
	return lines.length === 1 && /^No \w+ found/.test(lines[0]) ? `no ${many}` : countNote(lines.length, one, many);
};

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// ls
	wrapBasicTool(pi, protectDiscovery(createLsToolDefinition(cwd)), {
		name: "ls",
		call: (args: any, theme) => theme.fg("accent", args.path || "."),
		note: lineCount("entry", "entries"),
	});

	// read
	wrapBasicTool(pi, createReadToolDefinition(cwd), { name: "read", call: (args: any, theme) => {
		let t = theme.fg("accent", args.path);
		if (args.offset || args.limit) {
			const parts: string[] = [];
			if (args.offset) parts.push(`L${args.offset}`);
			if (args.limit) parts.push(`${args.limit}L`);
			t += theme.fg("dim", ` ${parts.join(", ")}`);
		}
		return t;
	} });

	// find
	wrapBasicTool(pi, protectDiscovery(createFindToolDefinition(cwd)), {
		name: "find",
		call: (args: any, theme) => {
			let t = theme.fg("accent", `"${args.pattern}"`);
			if (args.path) t += theme.fg("dim", ` in ${args.path}`);
			return t;
		},
		note: lineCount("file", "files"),
	});

	// grep
	wrapBasicTool(pi, protectDiscovery(createGrepToolDefinition(cwd)), {
		name: "grep",
		call: (args: any, theme) => {
			let t = theme.fg("accent", `"${args.pattern}"`);
			if (args.path) t += theme.fg("dim", ` in ${args.path}`);
			if (args.glob) t += theme.fg("dim", ` ${args.glob}`);
			return t;
		},
		note: lineCount("match", "matches"),
	});

	// write + edit — diff renderer with pills, expand/collapse, fallbacks
	registerDiffTools(pi);
}
