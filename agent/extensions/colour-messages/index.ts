/**
 * Message background colours.
 *
 * Colours user messages, working/thinking/tool rows, and final assistant
 * responses without overriding tool renderers such as tool-pills.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Loader, visibleWidth } from "@earendil-works/pi-tui";

type RenderablePrototype = {
	render?: (width: number) => string[];
};

type PaintMode = "user" | "work" | "assistant";

const PATCHED = Symbol.for("pi-extension:colour-messages:patched-render");
const ORIGINAL_RENDER = Symbol.for("pi-extension:colour-messages:original-render");

const COLOURS: Record<PaintMode, string> = {
	user: "#e7f0ff",
	work: "#f3eafe",
	assistant: "#e8f7ed",
};

const CSI_BG_RE = /\x1b\[(?:48;2;\d+;\d+;\d+|48;5;\d+|4[0-7]|10[0-7])m/g;
const CSI_BG_RESET_RE = /\x1b\[49m/g;
const CSI_FULL_RESET_RE = /\x1b\[0m/g;

function hexToBgAnsi(hex: string): string {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[48;2;${r};${g};${b}m`;
}

function splitLeadingOsc(line: string): [string, string] {
	let index = 0;
	while (line.startsWith("\x1b]", index)) {
		const end = line.indexOf("\x07", index);
		if (end === -1) break;
		index = end + 1;
	}
	return [line.slice(0, index), line.slice(index)];
}

function paintLine(line: string, width: number, bgAnsi: string): string {
	const [prefix, rest] = splitLeadingOsc(line);
	const padded = rest + " ".repeat(Math.max(0, width - visibleWidth(rest)));
	const normalized = padded
		.replace(CSI_BG_RE, bgAnsi)
		.replace(CSI_BG_RESET_RE, bgAnsi)
		.replace(CSI_FULL_RESET_RE, `\x1b[0m${bgAnsi}`);
	return `${prefix}${bgAnsi}${normalized}\x1b[49m`;
}

function paintLines(lines: string[], width: number, bgAnsi: string): string[] {
	return lines.map((line) => paintLine(line, width, bgAnsi));
}

function patchRender(
	prototype: RenderablePrototype & Record<PropertyKey, unknown>,
	modeForInstance: PaintMode | ((instance: any) => PaintMode),
	colours: Record<PaintMode, string>,
): void {
	if (!prototype?.render || prototype[PATCHED]) return;

	const original = prototype.render;
	prototype[ORIGINAL_RENDER] = original;
	prototype[PATCHED] = true;

	prototype.render = function colourMessagesRender(this: any, width: number): string[] {
		const lines = original.call(this, width);
		if (!Array.isArray(lines) || lines.length === 0) return lines;

		const mode = typeof modeForInstance === "function" ? modeForInstance(this) : modeForInstance;
		return paintLines(lines, width, colours[mode]);
	};
}

// ===========================================================================
// MONKEY-PATCH (pi internals): this extension overrides the `render()` method on
// pi's private message/loader components, and to reach those classes it imports
// directly from pi's compiled `dist` directory. There is no public API for
// per-row background colours, so this is a deliberate reach into internals.
//
// Fragility / maintenance — this WILL break if pi changes any of:
//   - its dist layout or the entrypoint shape (resolvePiDistDir asserts the
//     running CLI lives in `.../@earendil-works/pi-coding-agent/dist`),
//   - the component file paths under modes/interactive/components/*.js,
//   - the exported class names (UserMessageComponent, AssistantMessageComponent,
//     ToolExecutionComponent) or their `render(width)` signature,
//   - AssistantMessageComponent's `hasToolCalls` field used to tell an
//     intermediate working turn from a final response.
// Failures are made loud on purpose: resolvePiDistDir throws with a diagnostic
// path, and patchRender no-ops if a prototype has no `render`. Re-verify these
// assumptions on every pi upgrade; a non-patching fix would require pi to expose
// a public row-styling / render hook.
// ===========================================================================
function resolvePiDistDir(): string {
	if (!process.argv[1]) {
		throw new Error("Could not locate the running pi CLI entrypoint: process.argv[1] is empty");
	}

	let cliPath = process.argv[1];
	try {
		cliPath = realpathSync(cliPath);
	} catch {
		// Keep the original path if realpath fails; dirname() below still gives a useful diagnostic.
	}

	const distDir = dirname(cliPath);
	if (basename(distDir) !== "dist" || !cliPath.includes("@earendil-works/pi-coding-agent")) {
		throw new Error(`Could not locate pi dist directory from running entrypoint: ${cliPath}`);
	}

	return distDir;
}

async function importPiInternal<T = any>(distRelativePath: string): Promise<T> {
	return import(pathToFileURL(join(resolvePiDistDir(), distRelativePath)).href) as Promise<T>;
}

export default async function (_pi: ExtensionAPI) {
	const colours: Record<PaintMode, string> = {
		user: hexToBgAnsi(COLOURS.user),
		work: hexToBgAnsi(COLOURS.work),
		assistant: hexToBgAnsi(COLOURS.assistant),
	};

	const [{ UserMessageComponent }, { AssistantMessageComponent }, { ToolExecutionComponent }] = await Promise.all([
		importPiInternal<{ UserMessageComponent: new (...args: any[]) => any }>(
			"modes/interactive/components/user-message.js",
		),
		importPiInternal<{ AssistantMessageComponent: new (...args: any[]) => any }>(
			"modes/interactive/components/assistant-message.js",
		),
		importPiInternal<{ ToolExecutionComponent: new (...args: any[]) => any }>(
			"modes/interactive/components/tool-execution.js",
		),
	]);

	patchRender(UserMessageComponent.prototype, "user", colours);
	patchRender(ToolExecutionComponent.prototype, "work", colours);
	patchRender(Loader.prototype, "work", colours);

	// Assistant messages that include tool calls are intermediate working turns;
	// final assistant responses have no tool calls and get the assistant colour.
	patchRender(
		AssistantMessageComponent.prototype,
		(instance: { hasToolCalls?: boolean }) => (instance.hasToolCalls ? "work" : "assistant"),
		colours,
	);
}
