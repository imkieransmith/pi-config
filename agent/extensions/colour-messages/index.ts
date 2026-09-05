/**
 * Message background colours.
 *
 * Colours user messages, working/thinking/tool rows, and final assistant
 * responses without overriding tool renderers such as tool-pills.
 */

import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

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

export function paintLine(line: string, width: number, bgAnsi: string): string {
	const [prefix, rest] = splitLeadingOsc(line);
	const padded = rest + " ".repeat(Math.max(0, width - visibleWidth(rest)));
	const normalized = padded
		.replace(CSI_BG_RESET_RE, bgAnsi)
		.replace(CSI_FULL_RESET_RE, `\x1b[0m${bgAnsi}`);
	return `${prefix}${bgAnsi}${normalized}\x1b[49m`;
}

function paintLines(lines: string[], width: number, bgAnsi: string): string[] {
	return lines.map((line) => paintLine(line, width, bgAnsi));
}

export function patchRender(
	prototype: RenderablePrototype & Record<PropertyKey, unknown>,
	modeForInstance: PaintMode | ((instance: any) => PaintMode),
	colours: Record<PaintMode, string>,
): () => void {
  if (!prototype?.render) return () => {};
  const original = (prototype[ORIGINAL_RENDER] as typeof prototype.render | undefined) ?? prototype.render;
	prototype[ORIGINAL_RENDER] = original;
	prototype[PATCHED] = true;

	prototype.render = function colourMessagesRender(this: any, width: number): string[] {
		const lines = original.call(this, width);
		if (!Array.isArray(lines) || lines.length === 0) return lines;

		const mode = typeof modeForInstance === "function" ? modeForInstance(this) : modeForInstance;
		return paintLines(lines, width, colours[mode]);
	};
  const patched = prototype.render;
  return () => {
    if (prototype.render !== patched) return;
    prototype.render = original;
    delete prototype[ORIGINAL_RENDER];
    delete prototype[PATCHED];
  };
}

// ===========================================================================
// MONKEY-PATCH (pi internals): this extension overrides the `render()` method on
// pi's private message/loader components. The CLI bundles those classes into a
// hashed chunk, so importing the unbundled files under `dist/modes` would patch
// different class objects and have no effect. This extension reads the running
// CLI's main-chunk import, then imports that same module instance.
//
// Fragility / maintenance — this WILL break if pi changes any of:
//   - the `dist/bundle/cli.js` entrypoint shape,
//   - the main chunk's exported class names (UserMessageComponent,
//     AssistantMessageComponent, ToolExecutionComponent, BorderedLoader),
//   - those classes' `render(width)` methods,
//   - BorderedLoader's `loader` field used to reach the private Loader class,
//   - AssistantMessageComponent's `hasToolCalls` field used to tell an
//     intermediate working turn from a final response.
// Failures are made loud on purpose. Re-verify these assumptions on every pi
// upgrade; a non-patching fix would require pi to expose a public row-styling or
// render hook.
// ===========================================================================
function resolvePiRuntimeModuleUrl(): string {
	if (!process.argv[1]) {
		throw new Error("Could not locate the running pi CLI entrypoint: process.argv[1] is empty");
	}

	let cliPath = process.argv[1];
	try {
		cliPath = realpathSync(cliPath);
	} catch {
		// Keep the original path so the error below includes the path pi provided.
	}

	const bundleDir = dirname(cliPath);
	const distDir = dirname(bundleDir);
	if (
		basename(cliPath) !== "cli.js" ||
		basename(bundleDir) !== "bundle" ||
		basename(distDir) !== "dist" ||
		!cliPath.includes("@earendil-works/pi-coding-agent")
	) {
		throw new Error(`Could not locate pi's bundled CLI from running entrypoint: ${cliPath}`);
	}

	const cliSource = readFileSync(cliPath, "utf8");
	const mainChunkImport = cliSource.match(/import\{[^}]*\bmain\b[^}]*\}from"([^"]+)"/);
	if (!mainChunkImport?.[1]) {
		throw new Error(`Could not locate pi's main bundle chunk import in: ${cliPath}`);
	}

	return new URL(mainChunkImport[1], pathToFileURL(cliPath)).href;
}

function resolveLoaderPrototype(
	BorderedLoader: new (...args: any[]) => any,
): RenderablePrototype & Record<PropertyKey, unknown> {
	const probe = new BorderedLoader(
		{ requestRender() {} },
		{ fg: (_colour: string, text: string) => text },
		"",
		{ cancellable: false },
	);

	try {
		const prototype = Object.getPrototypeOf(probe.loader) as RenderablePrototype & Record<PropertyKey, unknown>;
		if (!prototype?.render) {
			throw new Error("Could not locate pi's private Loader prototype through BorderedLoader");
		}
		return prototype;
	} finally {
		probe.dispose();
	}
}

export default function (pi: ExtensionAPI) {
  let undo: Array<() => void> = [];
  const restore = () => { for (const dispose of undo) dispose(); undo = []; };
  pi.on("session_shutdown", restore);
  pi.on("session_start", async (_event, ctx) => {
    restore();
    if (ctx.mode !== "tui") return;
    const colours = {
      user: hexToBgAnsi(COLOURS.user), work: hexToBgAnsi(COLOURS.work), assistant: hexToBgAnsi(COLOURS.assistant),
    };
    const { UserMessageComponent, AssistantMessageComponent, ToolExecutionComponent, BorderedLoader } = await import(resolvePiRuntimeModuleUrl());
    undo = [
      patchRender(UserMessageComponent.prototype, "user", colours),
      patchRender(ToolExecutionComponent.prototype, "work", colours),
      patchRender(resolveLoaderPrototype(BorderedLoader), "work", colours),
      patchRender(AssistantMessageComponent.prototype, (instance: { hasToolCalls?: boolean }) => instance.hasToolCalls ? "work" : "assistant", colours),
    ];
  });
}
