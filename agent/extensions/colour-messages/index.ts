/**
 * Message background colours.
 *
 * User messages are blue and final responses green. Work in between (thinking,
 * text alongside tool calls, and the tool rows themselves) uses the theme's
 * custom message colour, the purple of compaction summaries, as one block.
 * Failed tool rows keep the theme's red.
 * Leave loaders alone: Pi also uses them inside the editor's top border.
 */

import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

type RenderablePrototype = {
	render?: (width: number) => string[];
};

type PaintMode = "user" | "work" | "assistant";

const PATCHED = Symbol.for("pi-extension:colour-messages:patched-render");
const ORIGINAL_RENDER = Symbol.for("pi-extension:colour-messages:original-render");

const USER_COLOUR = "#e7f0ff";
const ASSISTANT_COLOUR = "#e8f7ed";

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

/** `swap` lists backgrounds Pi already painted that should become `bgAnsi`. */
export function paintLine(line: string, width: number, bgAnsi: string, swap: string[] = []): string {
	const [prefix, raw] = splitLeadingOsc(line);
	const rest = swap.reduce((text, ansi) => text.replaceAll(ansi, bgAnsi), raw);
	const padded = rest + " ".repeat(Math.max(0, width - visibleWidth(rest)));
	const normalized = padded
		.replace(CSI_BG_RESET_RE, bgAnsi)
		.replace(CSI_FULL_RESET_RE, `\x1b[0m${bgAnsi}`);
	return `${prefix}${bgAnsi}${normalized}\x1b[49m`;
}

function paintLines(lines: string[], width: number, bgAnsi: string, swap?: string[]): string[] {
	return lines.map((line) => paintLine(line, width, bgAnsi, swap));
}

const FOOTER = Symbol.for("pi-extension:colour-messages:footer");

/**
 * Makes a custom entry read as the bottom of the final response above it: same
 * background, and no blank line between them. `host` is Pi's entry component,
 * which is `this` inside an entry renderer. Pi puts a blank line above every
 * entry; the final response already ends with one.
 */
export function joinFinalResponse(host: unknown): void {
	const component = host as ({ render?: (width: number) => string[] } & Record<PropertyKey, unknown>) | undefined;
	if (!component?.render || component[FOOTER]) return;
	const original = component.render;
	const bgAnsi = hexToBgAnsi(ASSISTANT_COLOUR);
	component[FOOTER] = true;
	component.render = function (this: unknown, width: number): string[] {
		const lines = original.call(this, width);
		return paintLines(lines[0] === "" ? lines.slice(1) : lines, width, bgAnsi);
	};
}

export function patchRender(
	prototype: RenderablePrototype & Record<PropertyKey, unknown>,
	modeForInstance: PaintMode | ((instance: any) => PaintMode),
	colours: Record<PaintMode, string>,
	{ swap, dropLeadingBlank = false, endWithBlank }: {
		swap?: string[];
		dropLeadingBlank?: boolean;
		/** Adds a blank line after instances whose last line has text. */
		endWithBlank?: (instance: any) => boolean;
	} = {},
): () => void {
  if (!prototype?.render) return () => {};
  const original = (prototype[ORIGINAL_RENDER] as typeof prototype.render | undefined) ?? prototype.render;
	prototype[ORIGINAL_RENDER] = original;
	prototype[PATCHED] = true;

	prototype.render = function colourMessagesRender(this: any, width: number): string[] {
		let lines = original.call(this, width);
		if (!Array.isArray(lines) || lines.length === 0) return lines;
		if (dropLeadingBlank && lines[0] === "") lines = lines.slice(1);
		if (endWithBlank?.(this) && visibleWidth(lines[lines.length - 1].trim()) > 0) lines = [...lines, ""];

		const mode = typeof modeForInstance === "function" ? modeForInstance(this) : modeForInstance;
		return paintLines(lines, width, colours[mode], swap);
	};
  const patched = prototype.render;
  return () => {
    if (prototype.render !== patched) return;
    prototype.render = original;
    delete prototype[ORIGINAL_RENDER];
    delete prototype[PATCHED];
  };
}

/**
 * Pi puts a blank Spacer above each user message and summary block, which
 * shows as an unpainted line between two coloured blocks. Skip it while
 * drawing when both neighbours are coloured, since they carry their own
 * padding. Plain status lines (reload notices, errors) keep it as their gap.
 * Deciding at draw time also covers messages added before this patch loaded.
 */
export function dropGapsBetweenBlocks(
	container: { prototype: { render(width: number): string[] } },
	opensBlock: Array<new (...args: any[]) => unknown>,
	paintedBlock: Array<new (...args: any[]) => unknown>,
): () => void {
	const original = container.prototype.render;
	const isPainted = (item: any) =>
		Boolean(item?.[PATCHED] || item?.[FOOTER]) || paintedBlock.some((type) => item instanceof type);
	container.prototype.render = function (this: { children: unknown[] }, width: number) {
		const children = this.children;
		const kept = children.filter((child: any, i) =>
			!(child?.constructor?.name === "Spacer" && isPainted(children[i - 1]) && opensBlock.some((type) => children[i + 1] instanceof type)));
		if (kept.length === children.length) return original.call(this, width);
		this.children = kept;
		try {
			return original.call(this, width);
		} finally {
			this.children = children;
		}
	};
	const patched = container.prototype.render;
	return () => {
		if (container.prototype.render === patched) container.prototype.render = original;
	};
}

// ===========================================================================
// MONKEY-PATCH (pi internals): this extension overrides the `render()` method on
// pi's private message components. The CLI bundles those classes into a
// hashed chunk, so importing the unbundled files under `dist/modes` would patch
// different class objects and have no effect. The CLI entrypoint now loads
// cli-runtime.js, which imports the main chunk. Import that same module instance.
//
// Fragility / maintenance — this WILL break if pi changes any of:
//   - the `dist/bundle/cli.js` / `cli-runtime.js` entrypoint shape,
//   - the main chunk's exported class names (UserMessageComponent,
//     AssistantMessageComponent, ToolExecutionComponent, Container),
//   - the unexported Spacer class keeping its name, and Pi adding one to
//     chatContainer just before each user message and summary block,
//   - those classes' `render(width)` methods,
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
	if (!cliSource.includes('createRequire(import.meta.url)("./cli-runtime.js")')) {
		throw new Error(`Could not locate pi's CLI runtime loader in: ${cliPath}`);
	}

	const runtimePath = join(bundleDir, "cli-runtime.js");
	const runtimeSource = readFileSync(runtimePath, "utf8");
	const mainChunkImport = runtimeSource.match(/import\{[^}]*\bmain\b[^}]*\}from"([^"]+)"/);
	if (!mainChunkImport?.[1]) {
		throw new Error(`Could not locate pi's main bundle chunk import in: ${runtimePath}`);
	}

	return new URL(mainChunkImport[1], pathToFileURL(runtimePath)).href;
}

export default function (pi: ExtensionAPI) {
  let undo: Array<() => void> = [];
  const restore = () => { for (const dispose of undo) dispose(); undo = []; };
  pi.on("session_shutdown", restore);
  pi.on("session_start", async (_event, ctx) => {
    restore();
    if (ctx.mode !== "tui") return;
    const theme = ctx.ui.theme;
    const colours = {
      user: hexToBgAnsi(USER_COLOUR), work: theme.getBgAnsi("customMessageBg"), assistant: hexToBgAnsi(ASSISTANT_COLOUR),
    };
    const {
      UserMessageComponent, AssistantMessageComponent, ToolExecutionComponent, Container,
      CompactionSummaryMessageComponent, BranchSummaryMessageComponent,
    } = await import(resolvePiRuntimeModuleUrl());
    const summaries = [CompactionSummaryMessageComponent, BranchSummaryMessageComponent];
    undo = [
      dropGapsBetweenBlocks(Container, [UserMessageComponent, ...summaries], summaries),
      // Pi paints user messages with the theme's userMessageBg; swap it for ours.
      patchRender(UserMessageComponent.prototype, "user", colours, { swap: [theme.getBgAnsi("userMessageBg")] }),
      // Tool rows carry their own top/bottom padding (tool-pills), so drop Pi's blank line above each one.
      // Pi still maps clicks as if that line were there, so only the top padding line ignores clicks.
      // Running and finished tools join the work block; failed ones keep toolErrorBg.
      patchRender(ToolExecutionComponent.prototype, "work", colours, {
        dropLeadingBlank: true,
        swap: [theme.getBgAnsi("toolPendingBg"), theme.getBgAnsi("toolSuccessBg")],
      }),
      // Pi pads assistant text above but not below. Working text also sits directly above its
      // tools, which no longer have a gap of their own.
      patchRender(AssistantMessageComponent.prototype, (instance: { hasToolCalls?: boolean }) => instance.hasToolCalls ? "work" : "assistant", colours, {
        endWithBlank: () => true,
      }),
    ];
  });
}
