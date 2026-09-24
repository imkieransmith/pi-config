/**
 * Landing page: a watercolour haze round the first screen, with the commands,
 * skills and tools on a clear card in the middle. A new page is painted each
 * launch. It breathes until the first prompt, and scrolls away with the chat.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { cellsToAnsi, composite, hex, paintWashes, type RGB, type Washes } from "./watercolour.ts";

/** Rows below the page: Pi's blank row above the editor, the editor's borders and input line, and the footer. */
const RESERVED_ROWS = 5;

// Breathing: each wash swells and fades on its own cycle. Adding a pixel's angle round
// the centre to the timing makes the swell travel round the frame as a wave; the washes'
// different periods send their waves round at different speeds.
const BREATH_DEPTH = 0.45;
const BREATHS = [{ period: 9000, phase: 0 }, { period: 12000, phase: 2.1 }, { period: 10500, phase: 4.2 }];
const breathe = (ms: number, angle: Float32Array) => {
	const phases = BREATHS.map((b) => (2 * Math.PI * ms) / b.period + b.phase);
	// Peaks reach each wash's full strength; troughs fade to (1 - depth) / (1 + depth) of it.
	return (layer: number, pixel: number) => (1 + BREATH_DEPTH * Math.sin(phases[layer] - angle[pixel])) / (1 + BREATH_DEPTH);
};

/** Every frame redraws the whole page (~100KB), so keep the rate modest. */
const FRAME_MS = 150;

/** The text on the clear card: title, where you are, then what's loaded. */
export function renderCard(pi: ExtensionAPI, theme: Theme, width: number, where: string): string[] {
	if (width < 1) return [];
	const commands = pi.getCommands().filter((c) => c.source !== "skill").map((c) => `/${c.name}`).sort();
	const skills = pi.getCommands().filter((c) => c.source === "skill").map((c) => c.name.replace(/^skill:/, ""));
	const label = 10;
	const section = (name: string, items: string[], colour: "accent" | "muted") => {
		if (!items.length) return [];
		const wrapped = wrapTextWithAnsi(items.join("  "), Math.max(1, width - label));
		return wrapped.map((line, i) => theme.fg("dim", (i ? "" : name).padEnd(label)) + theme.fg(colour, line));
	};
	const lines = [
		theme.bold(theme.fg("accent", "pi")) + theme.fg("dim", `  v${VERSION}`),
		theme.fg("muted", where),
		"",
		...section("commands", commands, "accent"),
		...section("skills", skills, "muted"),
		...section("tools", pi.getActiveTools(), "muted"),
	];
	return lines.map((line) => truncateToWidth(line, width));
}

interface Scene { key: string; washes: Washes; cardX: number; cardY: number }

export default function (pi: ExtensionAPI) {
	let stop = () => {};
	pi.on("agent_start", () => stop());
	pi.on("session_shutdown", () => stop());

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader((tui, theme) => {
			const seed = Math.floor(Math.random() * 1e9);
			const started = Date.now();
			let paper: RGB = hex("#f8f8f8");
			let scene: Scene | undefined;
			let frozenAt: number | undefined;
			let drawn: { at: number; key: string; rows: string[] } | undefined;

			// Animation: redraw on a timer until the first prompt, then freeze on the last frame.
			let timer: ReturnType<typeof setTimeout> | undefined;
			const tick = () => {
				tui.requestRender();
				timer = setTimeout(tick, FRAME_MS);
			};
			timer = setTimeout(tick, FRAME_MS);
			stop = () => {
				clearTimeout(timer);
				frozenAt ??= Date.now() - started;
			};

			// Blend the paint into the terminal's real background colour.
			tui.queryTerminalBackgroundColor({ timeoutMs: 500 }).then((c) => {
				if (!c) return;
				paper = [c.r, c.g, c.b];
				drawn = undefined;
				tui.requestRender();
			}, () => {});

			const where = () => [basename(ctx.cwd) || ctx.cwd, ctx.model?.id, pi.getThinkingLevel()].filter(Boolean).join(" · ");

			return {
				dispose: () => stop(),
				invalidate() { drawn = undefined; },
				render(width: number): string[] {
					const height = Math.max(0, tui.terminal.rows - RESERVED_ROWS);
					const cardW = Math.min(68, width - 4);
					const card = renderCard(pi, theme, cardW, where());
					if (width < 60 || height < card.length + 8) return ["", ...card.map((l) => ` ${l}`), ""];

					const key = `${width}x${height}x${card.length}`;
					if (scene?.key !== key) {
						const cardX = Math.floor((width - cardW) / 2), cardY = Math.floor((height - card.length) / 2);
						const clear = { x: cardX - 3, y: cardY - 1, w: cardW + 6, h: card.length + 2 };
						scene = { key, washes: paintWashes(seed, width, height, clear), cardX, cardY };
					}

					// Pi also redraws on every keypress; reuse the frame unless time has moved on.
					const at = frozenAt ?? Date.now() - started;
					if (drawn?.key === key && drawn.at === at) return drawn.rows;
					const cells = composite(scene.washes, paper, breathe(at, scene.washes.angle));
					const rows = cells.map(cellsToAnsi);
					card.forEach((line, i) => {
						const y = scene!.cardY + i, x0 = scene!.cardX, x1 = x0 + cardW;
						const cardLine = line + " ".repeat(Math.max(0, cardW - visibleWidth(line)));
						rows[y] = `${cellsToAnsi(cells[y].slice(0, x0))}${cardLine}\x1b[0m${cellsToAnsi(cells[y].slice(x1))}`;
					});
					drawn = { at, key, rows };
					return rows;
				},
			};
		});
	});
}
