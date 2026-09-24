/**
 * Watercolour haze for the landing page.
 *
 * Each cell is a `▀` half block: the top half takes the text colour and the
 * bottom half the background colour, so every cell holds two square "pixels".
 * A few see-through washes, shaped by noise, are glazed over the paper: they
 * multiply where they overlap, thicken towards the screen edges, and fade
 * smoothly to bare paper round the `clear` rectangle where the text goes.
 */

export type RGB = [number, number, number];
export interface Cell { ch: string; fg?: RGB; bg?: RGB }
export interface Rect { x: number; y: number; w: number; h: number }

// ── Noise and maths ──────────────────────────────────────────────────────────

/** Seeded random numbers (mulberry32), so a seed always paints the same page. */
export function random(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** 2D Perlin noise: smooth random hills, roughly -0.5..0.5. */
function perlin(seed: number): (x: number, y: number) => number {
	const rand = random(seed);
	const p = Array.from({ length: 256 }, (_, i) => i);
	for (let i = 255; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[p[i], p[j]] = [p[j], p[i]];
	}
	const perm = [...p, ...p];
	const grad = (h: number, x: number, y: number) => {
		const g = h & 7;
		const u = g < 4 ? x : y;
		const v = g < 4 ? y : x;
		return ((g & 1) ? -u : u) + ((g & 2) ? -2 * v : 2 * v);
	};
	const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
	return (x, y) => {
		const xi = Math.floor(x), yi = Math.floor(y);
		const xf = x - xi, yf = y - yi;
		const X = xi & 255, Y = yi & 255;
		const aa = perm[perm[X] + Y], ab = perm[perm[X] + Y + 1];
		const ba = perm[perm[X + 1] + Y], bb = perm[perm[X + 1] + Y + 1];
		const u = fade(xf), v = fade(yf);
		const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
		const x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
		return lerp(x1, x2, v) * 0.5;
	};
}

/** Layers of noise at doubling detail. */
function fbm(noise: (x: number, y: number) => number, x: number, y: number, octaves: number): number {
	let sum = 0, amp = 0.5, freq = 1;
	for (let i = 0; i < octaves; i++) {
		sum += amp * noise(x * freq, y * freq);
		freq *= 2.03;
		amp *= 0.5;
	}
	return sum;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const smooth = (a: number, b: number, v: number) => {
	const t = clamp((v - a) / (b - a));
	return t * t * (3 - 2 * t);
};
export const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// ── Washes ───────────────────────────────────────────────────────────────────

const BLUE = ["#3a6ea5", "#4f86b8", "#3f8ea3"].map(hex);
const GREEN = ["#2f8f6a", "#4f9e5c", "#72a84a"].map(hex);

function gradient(stops: RGB[], t: number): RGB {
	const f = clamp(t) * (stops.length - 1);
	const i = Math.min(stops.length - 2, Math.floor(f));
	const u = f - i;
	return [lerp(stops[i][0], stops[i + 1][0], u), lerp(stops[i][1], stops[i + 1][1], u), lerp(stops[i][2], stops[i + 1][2], u)];
}

/** One see-through layer of paint: where it lies, how thick, and its colours. */
interface Wash { palette: RGB[]; strength: number; bias: number; scale: number }

/**
 * Washes glazed over each other. Pixels are 1 world unit square: a cell is
 * 1 unit wide and 2 tall, so a W × H cell screen is W × 2H pixels.
 */
const WASHES: Wash[] = [
	{ palette: BLUE, strength: 0.23, bias: 0.1, scale: 1 / 40 },
	{ palette: BLUE, strength: 0.15, bias: -0.1, scale: 1 / 30 },
	{ palette: GREEN, strength: 0.29, bias: -0.08, scale: 1 / 36 },
];

/**
 * Each wash painted once, kept apart so frames can re-blend them cheaply.
 * Per pixel: how much paint each wash lays down, its colour, and its angle
 * round the screen centre (-π..π), so motion can travel round the frame.
 */
export interface Washes { width: number; height: number; alpha: Float32Array[]; colour: Float32Array[]; angle: Float32Array }

export function paintWashes(seed: number, width: number, height: number, clear: Rect): Washes {
	const W = width, H = height * 2;
	const x0 = clear.x, x1 = clear.x + clear.w, y0 = clear.y * 2, y1 = (clear.y + clear.h) * 2;
	/** 0 in the clear zone, rising to 1 a little way out. */
	const mask = (X: number, Y: number) => smooth(1, 12, Math.hypot(Math.max(x0 - X, 0, X - x1), 1.2 * Math.max(y0 - Y, 0, Y - y1)));
	/** How far towards the screen edge a point is: 0 at the centre, 1 at the rim. */
	const rim = (X: number, Y: number) => Math.max(Math.abs(X / W - 0.5) * 2, Math.abs(Y / H - 0.5) * 2 * 0.9);
	const layers = WASHES.map((wash, i) => ({ wash, noise: [0, 1, 2, 3, 4].map((k) => perlin(seed * 13 + i * 5 + k)) }));
	const alpha = WASHES.map(() => new Float32Array(W * H));
	const colour = WASHES.map(() => new Float32Array(W * H * 3));
	const angle = new Float32Array(W * H);

	for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
		const X = px + 0.5, Y = py + 0.5, i = py * W + px;
		const m = mask(X, Y);
		angle[i] = Math.atan2((Y - H / 2) / H, (X - W / 2) / W);
		layers.forEach(({ wash, noise: [n1, n2, n3, n4, n5] }, l) => {
			const s = wash.scale;
			// Warp the coordinates by other noise, which streaks the wash into tendrils.
			const qx = fbm(n1, X * s, Y * s, 4), qy = fbm(n2, X * s + 5.2, Y * s + 1.3, 4);
			const base = fbm(n3, X * s + 2.2 * qx, Y * s + 2.2 * qy, 5);
			if (m <= 0) return;
			const mottle = 1 + 0.2 * fbm(n4, X * 0.12, Y * 0.12, 2);
			const h = clamp(smooth(0.45, 1.15, wash.bias + base * 1.4 + 0.65 * rim(X, Y)) * mottle * m);
			if (h <= 0.002) return;
			// Pigment gathers where a wash dried, leaving faint darker tide lines.
			const tide = Math.exp(-(((h - 0.3) / 0.05) ** 2)) * 0.12;
			alpha[l][i] = wash.strength * (h ** 0.9 + tide);
			const c = gradient(wash.palette, clamp(0.5 + fbm(n5, X * s * 0.5, Y * s * 0.5, 3) * 1.8));
			colour[l].set(c, i * 3);
		});
	}
	return { width, height, alpha, colour, angle };
}

/**
 * Glaze the washes onto the paper and return the page as cells.
 * `strength(layer, pixel)` scales each wash at each pixel.
 */
export function composite(w: Washes, paper: RGB, strength: (layer: number, pixel: number) => number): Cell[][] {
	const W = w.width;
	const pixel = (i: number): { rgb: RGB; paint: number } => {
		let r = paper[0], g = paper[1], b = paper[2], paint = 0;
		for (let l = 0; l < w.alpha.length; l++) {
			const a = w.alpha[l][i] * strength(l, i);
			if (a <= 0) continue;
			const c = w.colour[l];
			r *= 1 - a * (1 - c[i * 3] / 255);
			g *= 1 - a * (1 - c[i * 3 + 1] / 255);
			b *= 1 - a * (1 - c[i * 3 + 2] / 255);
			paint += a;
		}
		return { rgb: [r, g, b], paint };
	};
	const rows: Cell[][] = [];
	for (let y = 0; y < w.height; y++) {
		const row: Cell[] = [];
		for (let x = 0; x < W; x++) {
			const top = pixel(y * 2 * W + x), bottom = pixel((y * 2 + 1) * W + x);
			row.push(top.paint < 0.008 && bottom.paint < 0.008 ? { ch: " " } : { ch: "▀", fg: top.rgb, bg: bottom.rgb });
		}
		rows.push(row);
	}
	return rows;
}

// ── ANSI ─────────────────────────────────────────────────────────────────────

const fgCode = ([r, g, b]: RGB) => `\x1b[38;2;${r | 0};${g | 0};${b | 0}m`;
const bgCode = ([r, g, b]: RGB) => `\x1b[48;2;${r | 0};${g | 0};${b | 0}m`;
const same = (a?: RGB, b?: RGB) => a === b || (!!a && !!b && (a[0] | 0) === (b[0] | 0) && (a[1] | 0) === (b[1] | 0) && (a[2] | 0) === (b[2] | 0));

/** Turn cells into one terminal line, only sending colour codes when they change. */
export function cellsToAnsi(cells: Cell[]): string {
	let out = "", fg: RGB | undefined, bg: RGB | undefined;
	for (const cell of cells) {
		const wantFg = cell.ch === " " ? fg : cell.fg;
		if (!same(bg, cell.bg)) { out += cell.bg ? bgCode(cell.bg) : "\x1b[49m"; bg = cell.bg; }
		if (!same(fg, wantFg)) { out += wantFg ? fgCode(wantFg) : "\x1b[39m"; fg = wantFg; }
		out += cell.ch;
	}
	return fg || bg ? `${out}\x1b[0m` : out;
}
