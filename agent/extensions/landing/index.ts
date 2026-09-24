/**
 * Landing page: a pale, dithered cloud bank with commands, skills and tools
 * over a soft fade in the middle. A new page is painted each
 * launch. It breathes until the first prompt, and scrolls away with the chat.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { composite, paintClouds, renderRow, type RGB, type CloudBank } from "./cloud-bank.ts";

/** Rows below the page: Pi's blank row above the editor, the editor's borders and input line, and the footer. */
const RESERVED_ROWS = 5;

/** Every frame redraws the whole page (~100KB), so keep the rate modest. */
const FRAME_MS = 150;

/** Card grid: items sit this far in under their label, with this gap between columns. */
const INDENT = 2, GAP = 3;
/** Widest the card grows, when the terminal has room. */
const MAX_CARD = 80;

/** The logo's four-by-four shape, with two columns per square terminal block. */
const LOGO = ["██████", "██  ██", "████  ██", "██    ██"];

/**
 * Two columns shared by every section, so they line up. Each column is as wide
 * as the longest item; if two won't fit, the grid falls back to one.
 */
function columns(items: string[], width: number): { cols: number; cell: number } {
	const cell = Math.max(0, ...items.map((item) => visibleWidth(item)));
	const cols = INDENT + 2 * cell + GAP <= width ? 2 : 1;
	return { cols, cell };
}

/** Lay items out row by row. */
function grid(items: string[], { cols, cell }: { cols: number; cell: number }): string[] {
	return Array.from({ length: Math.ceil(items.length / cols) }, (_, row) => items
		.slice(row * cols, (row + 1) * cols)
		.map((item) => item + " ".repeat(cell - visibleWidth(item)))
		.join(" ".repeat(GAP))
		.trimEnd());
}

/** The centred text: title, where you are, then what's loaded. */
export function renderCard(pi: ExtensionAPI, theme: Theme, width: number, where: string): string[] {
	if (width < 1) return [];
	const sort = (items: string[]) => items.sort((a, b) => a.localeCompare(b));
	const commands = sort(pi.getCommands().filter((c) => c.source !== "skill").map((c) => `/${c.name}`));
	const skills = sort(pi.getCommands().filter((c) => c.source === "skill").map((c) => c.name.replace(/^skill:/, "")));
	const tools = sort([...pi.getActiveTools()]);
	const layout = columns([...commands, ...skills, ...tools], width);
	const section = (name: string, items: string[]) => items.length
		? [theme.bold(theme.fg("accent", name)), ...grid(items, layout).map((row) => " ".repeat(INDENT) + theme.fg("muted", row))]
		: [];
	const sections = [
		section("commands", commands),
		section("skills", skills),
		section("tools", tools),
	].filter((lines) => lines.length > 0);
	// Version and location share a line when they fit; otherwise each gets its own.
	const version = `v${VERSION}`;
	const header = visibleWidth(`${version} - ${where}`) <= width
		? [theme.fg("dim", `${version} - `) + theme.fg("muted", where)]
		: [theme.fg("dim", version), theme.fg("muted", where)];
	const lines = [
		...LOGO.map((row) => theme.fg("accent", row)),
		"",
		...header,
		"",
		...sections.flatMap((lines, i) => i ? ["", ...lines] : lines),
	];
	return lines.map((line) => truncateToWidth(line, width));
}

/** Project, model and thinking level, e.g. "my-app - gpt-6-sol (high)". */
export function describeWhere(cwd: string, model: string | undefined, thinking: string): string {
	const level = thinking === "off" ? "no thinking" : thinking;
	return [basename(cwd) || cwd, model && `${model} (${level})`].filter(Boolean).join(" - ");
}

interface Scene { key: string; clouds: CloudBank; cardX: number; cardY: number }

export default function (pi: ExtensionAPI) {
	let stop = () => {};
	pi.on("agent_start", () => stop());
	pi.on("session_shutdown", () => stop());

	pi.on("session_start", (_event, ctx) => {
		stop();
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader((tui, theme) => {
			const seed = Math.floor(Math.random() * 1e9);
			const started = Date.now();
			let paper: RGB = [248, 248, 248];
			let scene: Scene | undefined;
			let frozenAt: number | undefined;
			let drawn: { at: number; key: string; rows: string[] } | undefined;
			let disposed = false;
			const frameTime = () => Math.floor((Date.now() - started) / FRAME_MS) * FRAME_MS;

			// Animation: redraw on a timer until the first prompt, then freeze on the last frame.
			let timer: ReturnType<typeof setTimeout> | undefined;
			const tick = () => {
				tui.requestRender();
				timer = setTimeout(tick, FRAME_MS);
			};
			timer = setTimeout(tick, FRAME_MS);
			const freeze = () => {
				clearTimeout(timer);
				frozenAt ??= drawn?.at ?? frameTime();
			};
			stop = freeze;

			// Blend the paint into the terminal's real background colour.
			tui.queryTerminalBackgroundColor({ timeoutMs: 500 }).then((c) => {
				if (!c || disposed) return;
				paper = [c.r, c.g, c.b];
				drawn = undefined;
				tui.requestRender();
			}, () => {});

			const where = () => describeWhere(ctx.cwd, ctx.model?.id, pi.getThinkingLevel());

			return {
				dispose() { disposed = true; freeze(); },
				invalidate() { drawn = undefined; },
				render(width: number): string[] {
					if (width < 1) return [];
					const height = Math.max(0, tui.terminal.rows - RESERVED_ROWS);
					const card = renderCard(pi, theme, Math.min(MAX_CARD, width - 4), where());
					if (width < 60 || height < card.length + 6) return ["", ...card.map((l) => truncateToWidth(` ${l}`, width)), ""];

					// Size the card to its widest line, so the text sits in the middle and the paint comes close.
					const cardW = Math.max(...card.map((l) => visibleWidth(l)));
					const key = `${width}x${height}x${card.length}x${cardW}`;
					if (scene?.key !== key) {
						const cardX = Math.floor((width - cardW) / 2), cardY = Math.floor((height - card.length) / 2);
						const text = { x: cardX - 3, y: cardY - 1, w: cardW + 6, h: card.length + 2 };
						scene = { key, clouds: paintClouds(seed, width, height, text), cardX, cardY };
					}

					// Keypresses reuse this time slot. Text changes still redraw a frozen page.
					const at = frozenAt ?? frameTime();
					const frameKey = `${key}|${paper.join(",")}|${card.join("\n")}`;
					if (drawn?.key === frameKey && drawn.at === at) return drawn.rows;
					const cells = composite(scene.clouds, paper, at);
					const rows = cells.map((row, y) => renderRow(row, card[y - scene!.cardY] ?? "", scene!.cardX));
					drawn = { at, key: frameKey, rows };
					return rows;
				},
			};
		});
	});
}
