import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { composite, paintClouds, renderRow, textFade, type Cell, type CloudBank, type RGB } from "./cloud-bank.ts";

const text = { x: 45, y: 13, w: 54, h: 22 };
const paper: RGB = [248, 248, 248];
const hash = (...arrays: Array<Float32Array | Uint8Array>) => {
	const h = createHash("sha256");
	for (const a of arrays) h.update(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
	return h.digest("hex");
};
function raster(clouds: CloudBank, ms: number): Uint8Array {
	const cells = composite(clouds, paper, ms);
	return Uint8Array.from(cells.flatMap(row => [...row.flatMap(c => c.fg), ...row.flatMap(c => c.bg)]));
}

// Captured from the chosen blue/warm-cream preview, with only its opacity
// raised from .17 to the requested .20 before changing the live generator.
// No tests or runtime code depend on the temporary study.
const approved = [
	{ seed: 7, shape: "309e35d903d0520c991220d36f97bf2d9f00d735ecf63edffbbf38518190774a", frames: [
		"1f2e78c57640646ded5346b8935a7a9962c259f0c7cc49a5b7787478701a4d65",
		"7582645674a3ed79bfbd9de1c49ac2269a1d7341c914879d0c89b8173993e423",
		"37ae3f78c293a14c645ad5ec07f043533a8d8cb01ee1b904f1310bd455870a38",
	] },
	{ seed: 23, shape: "f997a87f3762fc470b93bef0d6e9b5216c1614c40353134d6664a97bb861468e", frames: [
		"e2cf50c81060240cbf429f36465ca8bb871f5606358a785997f0fe0a05e240a0",
		"ecec9d71e050cace44675f2c7bf4127fdfb15df53e532ceb3688bac9fb63dd51",
		"2b6794200ed8b844a291b6dcf9c7aee018c76849f94539e1ee148b945a3548e8",
	] },
	{ seed: 81, shape: "1d3c7e722f8d9e7260991fe271a9d37bc846df089b797729d14698e80c94fc5a", frames: [
		"01f166048402dc58f2b259371469e71c3f240b7f5121c7a616e6f6a957c3a8a2",
		"16abc15f669eb6b64c1805beb1fd60347a762378c81e81bec52c2f9ff677c1c7",
		"867b56dd9b13505f6bf74392831e74a5828ec029fda6ec912e3bb886e8acafa9",
	] },
];

test("cloud shapes and breathing frames match the warm-cream preview at .20 opacity", () => {
	for (const fixture of approved) {
		const clouds = paintClouds(fixture.seed, 144, 48, text);
		assert.equal(hash(clouds.alpha, clouds.angle), fixture.shape);
		for (const [i, ms] of [0, 2200, 7000].entries()) assert.equal(hash(raster(clouds, ms)), fixture.frames[i]);
	}
});

test("clouds are seeded and keep a full lower bank across 100 seeds and three sizes", () => {
	for (const [width, height] of [[80, 32], [144, 48], [200, 60]]) {
		const bounds = { x: Math.floor((width - 48) / 2) - 3, y: Math.floor((height - 20) / 2) - 1, w: 54, h: 22 };
		for (let seed = 0; seed < 100; seed++) {
			const clouds = paintClouds(seed, width, height, bounds);
			let lower = 0, filled = 0;
			for (let y = 0; y < height * 2; y++) for (let x = 0; x < width; x++) {
				const a = clouds.alpha[y * width + x];
				assert.ok(Number.isFinite(a) && a >= 0 && a <= .200001);
				const inside = x >= bounds.x && x < bounds.x + bounds.w && y >= bounds.y * 2 && y < (bounds.y + bounds.h) * 2;
				if (inside) assert.ok(a < .10, "Text stays subdued, not erased");
				if (y >= height * 1.5) { lower++; if (a > .01) filled++; }
			}
			assert.ok(filled / lower > .9, `Sparse lower bank: ${width}x${height}, seed ${seed}`);
		}
	}
	assert.deepEqual(paintClouds(7, 144, 48, text), paintClouds(7, 144, 48, text));
	assert.notDeepEqual(paintClouds(7, 144, 48, text).alpha, paintClouds(8, 144, 48, text).alpha);
});

test("text fade is smooth and leaves cloud colour through the former cutout", () => {
	assert.ok(Math.abs(textFade(72, 48, text) - .15) < 1e-12);
	const clouds = paintClouds(7, 144, 48, text);
	let painted = 0;
	for (let y = 26; y < 70; y++) for (let x = 45; x < 99; x++) {
		const fade = textFade(x + .5, y + .5, text);
		assert.ok(fade >= .15 && fade < .5);
		assert.ok(Math.abs(fade - textFade(x + 1.5, y + .5, text)) < .02);
		assert.ok(Math.abs(fade - textFade(x + .5, y + 1.5, text)) < .02);
		if (clouds.alpha[y * 144 + x] > 0) painted++;
	}
	assert.ok(painted > 500);
});

test("dither stays fixed while breathing blends into light, dark and black paper", () => {
	const clouds = paintClouds(23, 144, 48, text);
	const before = hash(clouds.alpha, clouds.colour, clouds.angle);
	for (let i = 0; i < clouds.alpha.length; i++) {
		const level = clouds.alpha[i] / (.20 * textFade(i % 144 + .5, Math.floor(i / 144) + .5, text)) * 4;
		assert.ok(Math.abs(level - Math.round(level)) < 1e-6);
	}
	for (const background of [paper, [24, 24, 24], [0, 0, 0]] as RGB[]) {
		const frames = [0, 2200, 7000].map(ms => composite(clouds, background, ms));
		for (const frame of frames) for (const row of frame) for (const cell of row) {
			assert.ok([...cell.fg, ...cell.bg].every(v => Number.isInteger(v) && v >= 0 && v <= 255));
		}
		assert.notDeepEqual(frames[0], frames[1]);
		assert.deepEqual(composite(clouds, background, 9000), frames[0]);
	}
	assert.ok(composite(clouds, [0, 0, 0], 0).some(row => row.some(c => c.bg.some(v => v > 0))));
	assert.equal(hash(clouds.alpha, clouds.colour, clouds.angle), before);
});

// Small SGR reader for checking the state that an actual terminal sees.
function glyphs(line: string) {
	let fg: RGB | undefined, bg: RGB | undefined, bold = false, italic = false, column = 0;
	const result: { text: string; width: number; column: number; fg?: RGB; bg?: RGB; bold: boolean; italic: boolean }[] = [];
	for (const match of line.matchAll(/\x1b\[([\d;]*)m|([^\x1b]+)/gu)) {
		if (match[1] !== undefined) {
			const codes = match[1].split(";").map(Number);
			for (let i = 0; i < codes.length; i++) {
				const code = codes[i];
				if (code === 0) { fg = bg = undefined; bold = italic = false; }
				if (code === 1) bold = true;
				if (code === 22) bold = false;
				if (code === 3) italic = true;
				if (code === 23) italic = false;
				if (code === 39) fg = undefined;
				if (code === 49) bg = undefined;
				if ((code === 38 || code === 48) && codes[i + 1] === 2) {
					const rgb = codes.slice(i + 2, i + 5) as RGB;
					if (code === 38) fg = rgb; else bg = rgb;
					i += 4;
				}
			}
		} else for (const { segment } of new Intl.Segmenter().segment(match[2])) {
			const width = visibleWidth(segment);
			result.push({ text: segment, width, column, fg, bg, bold, italic });
			column += width;
		}
	}
	return result;
}
const sampleRow = (length: number): Cell[] => Array.from({ length }, (_, i) => ({ fg: [200 + i, 210, 220], bg: [210 + i, 220, 230] }));

test("themed text keeps its styles and sampled background, including wide and combined glyphs", () => {
	const row = sampleRow(30);
	const line = "\x1b[1m\x1b[38;2;60;80;90mA\x1b[39m \x1b[3m界\x1b[0m e\u0301 👩‍💻";
	const rendered = renderRow(row, line, 3);
	assert.equal(visibleWidth(rendered), 30);
	const drawn = glyphs(rendered), letters = drawn.filter(g => g.text !== "▀");
	assert.deepEqual(letters.map(g => g.text), ["A", "界", "e\u0301", "👩‍💻"]);
	assert.deepEqual(letters.map(g => g.width), [1, 2, 1, 2]);
	assert.deepEqual(letters[0].fg, [60, 80, 90]);
	assert.equal(letters[0].bold, true);
	assert.equal(letters[1].bold, true);
	assert.equal(letters[1].italic, true);
	assert.equal(letters[2].bold, false);
	assert.equal(letters[2].italic, false);
	for (const g of drawn) {
		if (g.text === "▀") {
			assert.deepEqual(g.fg, row[g.column].fg);
			assert.deepEqual(g.bg, row[g.column].bg);
			assert.equal(g.bold, false);
			assert.equal(g.italic, false);
		} else {
			const bg: RGB = [0, 0, 0];
			for (let x = g.column; x < g.column + g.width; x++) for (let c = 0; c < 3; c++) bg[c] += (row[x].fg[c] + row[x].bg[c]) / (g.width * 2);
			assert.deepEqual(g.bg, bg.map(Math.floor));
		}
	}
	assert.equal(renderRow(row, "   ", 3), renderRow(row));
	assert.equal(renderRow(row, ""), renderRow(row));
});

test("text background overrides a prefix reset or explicit background and never splits a wide glyph", () => {
	const row = sampleRow(5);
	const line = "\x1b[0m\x1b[48;2;1;2;3m\x1b[38;2;9;8;7m界界";
	const rendered = renderRow(row, line, 3);
	assert.equal(visibleWidth(rendered), 5);
	assert.equal(stripTerminalSequences(rendered), "▀▀▀界");
	assert.deepEqual(glyphs(rendered).at(-1)?.bg, [208, 215, 225]);
	assert.deepEqual(glyphs(rendered).at(-1)?.fg, [9, 8, 7]);
	assert.equal(stripTerminalSequences(renderRow(row, "界", 4)), "▀▀▀▀▀");
	assert.equal(renderRow([], "A"), "");
});
