/**
 * Pale blue/warm-cream clouds for the landing page. Each terminal cell contains two
 * half-block samples. Shape and ordered texture stay fixed; only opacity breathes.
 */
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

export type RGB = [number, number, number];
export interface Cell { fg: RGB; bg: RGB }
export interface Rect { x: number; y: number; w: number; h: number }
export interface CloudBank {
	width: number;
	height: number;
	alpha: Float32Array;
	colour: Float32Array;
	angle: Float32Array;
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => {
	const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

/** Mulberry32: a seed always produces the same cloud shapes. */
function random(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type Noise = (x: number, y: number) => number;

/** Smooth 2D noise with eight unit-length gradients. */
function noise2(seed: number): Noise {
	const rand = random(seed);
	const p = Array.from({ length: 256 }, (_, i) => i);
	for (let i = 255; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[p[i], p[j]] = [p[j], p[i]];
	}
	const perm = [...p, ...p];
	const gradients = Array.from({ length: 8 }, (_, i) => [Math.cos(i * Math.PI / 4), Math.sin(i * Math.PI / 4)]);
	const dot = (hash: number, x: number, y: number) => {
		const g = gradients[hash & 7];
		return g[0] * x + g[1] * y;
	};
	const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
	return (x, y) => {
		const ix = Math.floor(x), iy = Math.floor(y), X = ix & 255, Y = iy & 255;
		const dx = x - ix, dy = y - iy, u = fade(dx), v = fade(dy);
		return mix(
			mix(dot(perm[perm[X] + Y], dx, dy), dot(perm[perm[X + 1] + Y], dx - 1, dy), u),
			mix(dot(perm[perm[X] + Y + 1], dx, dy - 1), dot(perm[perm[X + 1] + Y + 1], dx - 1, dy - 1), u), v,
		);
	};
}

/** Three scales of detail, with most weight on the broadest shapes. */
function fbm(n: Noise, x: number, y: number): number {
	return .62 * n(x, y) + .26 * n(x * 1.97 + 13, y * 1.97 + 7) + .12 * n(x * 3.89 + 3, y * 3.89 + 19);
}

/** A soft oval fade, not an empty rectangle. Text bounds use terminal rows. */
export function textFade(X: number, Y: number, text: Rect): number {
	const dx = (X - text.x - text.w / 2) / (text.w * .7);
	const dy = (Y - text.y * 2 - text.h) / (text.h * 1.4);
	return 1 - .85 * Math.exp(-.5 * (dx * dx + dy * dy));
}

const BLUE: RGB = [84, 139, 208], CREAM: RGB = [169, 130, 79];
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Paint once per size/seed. One cell is one sample wide and two samples tall. */
export function paintClouds(seed: number, width: number, height: number, text: Rect): CloudBank {
	const H = height * 2, count = width * H;
	const n = noise2(seed + 101), warp = noise2(seed + 202), hue = noise2(seed + 303);
	const alpha = new Float32Array(count), colour = new Float32Array(count * 3), angle = new Float32Array(count);
	for (let y = 0; y < H; y++) for (let x = 0; x < width; x++) {
		const X = x + .5, Y = y + .5, i = y * width + x;
		angle[i] = Math.atan2((Y - H / 2) / H, (X - width / 2) / width);
		const w = fbm(warp, X * (1 / 42) * .65, Y * (1 / 42) * .65);
		// The height term keeps the lower bank full across seeds. Noise shapes its edges.
		const coverage = smooth(-.06, .18, .65 * fbm(n, X / 34 + 1.1 * w, Y / 40) + .64 * Y / H - .21);
		const volume = .68 + .32 * smooth(-.25, .25, fbm(n, X / 26 + 17, Y / 30 + 9));
		const tint = smooth(-.1, .1, fbm(hue, X / 95 + 7, Y / 95 + 3));
		for (let c = 0; c < 3; c++) colour[i * 3 + c] = mix(BLUE[c], CREAM[c], tint);
		// Five fixed coverage levels. Breathing never changes the dither pattern.
		const threshold = (BAYER[(y & 3) * 4 + (x & 3)] + .5) / 16;
		const q = coverage * volume * 4, base = Math.floor(q);
		const deposit = (base + (q - base > threshold ? 1 : 0)) / 4;
		alpha[i] = .20 * deposit * textFade(X, Y, text);
	}
	return { width, height, alpha, colour, angle };
}

/** Direct colour blending works on both light and dark terminal backgrounds. */
export function composite(clouds: CloudBank, paper: RGB, ms: number): Cell[][] {
	const phase = 2 * Math.PI * ms / 9000;
	const pixel = (i: number): RGB => {
		const breath = (1 + .45 * Math.sin(phase - clouds.angle[i])) / 1.45;
		const a = clouds.alpha[i] * breath;
		return [0, 1, 2].map(c => Math.floor(mix(paper[c], clouds.colour[i * 3 + c], a))) as RGB;
	};
	return Array.from({ length: clouds.height }, (_, y) => Array.from({ length: clouds.width }, (_, x) => ({
		fg: pixel(y * 2 * clouds.width + x),
		bg: pixel((y * 2 + 1) * clouds.width + x),
	})));
}

const fgCode = ([r, g, b]: RGB) => `\x1b[38;2;${r | 0};${g | 0};${b | 0}m`;
const bgCode = ([r, g, b]: RGB) => `\x1b[48;2;${r | 0};${g | 0};${b | 0}m`;
const same = (a: RGB | undefined, b: RGB) => a && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

function cellsToAnsi(cells: Cell[]): string {
	let out = "", fg: RGB | undefined, bg: RGB | undefined;
	for (const cell of cells) {
		if (!same(bg, cell.bg)) { out += bgCode(cell.bg); bg = cell.bg; }
		if (!same(fg, cell.fg)) { out += fgCode(cell.fg); fg = cell.fg; }
		out += "▀";
	}
	return out ? `${out}\x1b[0m` : out;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Place themed text over the clouds, leaving gaps and blank lines untouched.
 * A glyph occupies a whole cell (or two for wide glyphs), so its background is
 * the mean of the samples it covers. Preserve complete combining/emoji clusters.
 */
export function renderRow(cells: Cell[], text = "", x = 0): string {
	let out = "", column = 0, cursor = 0;
	for (const { segment } of segmenter.segment(stripTerminalSequences(text))) {
		const width = visibleWidth(segment), start = x + column;
		if (start + width > cells.length) break;
		if (width > 0 && start >= 0 && !/^\s+$/u.test(segment)) {
			out += cellsToAnsi(cells.slice(cursor, start));
			const bg: RGB = [0, 0, 0];
			for (let i = start; i < start + width; i++) for (let c = 0; c < 3; c++) {
				bg[c] += (cells[i].fg[c] + cells[i].bg[c]) / (2 * width);
			}
			const styled = sliceByColumn(text, column, width, true);
			// Prefixes may contain a reset. Apply our background after them, directly
			// before the complete grapheme, not before its ANSI styling.
			out += `\x1b[0m${styled.slice(0, -segment.length)}${bgCode(bg)}${segment}\x1b[0m`;
			cursor = start + width;
		}
		column += width;
	}
	return out + cellsToAnsi(cells.slice(cursor));
}
