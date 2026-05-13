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
import { registerDiffTools } from "./diff-renderer.js";
import { renderBashCall, renderBashResult, wrapBasicTool } from "./renderers.js";

export { renderBashCall, renderBashResult };

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// ls
	wrapBasicTool(pi, createLsToolDefinition(cwd), "ls", (args, theme) =>
		theme.fg("accent", args.path || "."),
	);

	// read
	wrapBasicTool(pi, createReadToolDefinition(cwd), "read", (args, theme) => {
		let t = theme.fg("accent", args.path);
		if (args.offset || args.limit) {
			const parts: string[] = [];
			if (args.offset) parts.push(`L${args.offset}`);
			if (args.limit) parts.push(`${args.limit}L`);
			t += theme.fg("dim", ` ${parts.join(", ")}`);
		}
		return t;
	});

	// find
	wrapBasicTool(pi, createFindToolDefinition(cwd), "find", (args, theme) => {
		let t = theme.fg("accent", `"${args.pattern}"`);
		if (args.path) t += theme.fg("dim", ` in ${args.path}`);
		return t;
	});

	// grep
	wrapBasicTool(pi, createGrepToolDefinition(cwd), "grep", (args, theme) => {
		let t = theme.fg("accent", `"${args.pattern}"`);
		if (args.path) t += theme.fg("dim", ` in ${args.path}`);
		if (args.glob) t += theme.fg("dim", ` ${args.glob}`);
		return t;
	});

	// write + edit — diff renderer with pills, expand/collapse, fallbacks
	registerDiffTools(pi);
}
