import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import landing from "./index.ts";

type Header = { render(width: number): string[]; invalidate(): void; dispose(): void };
function setup(t: TestContext) {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const hooks = new Map<string, Function>();
	let tools = ["read", "write"], renders = 0, thinking = "high";
	const pi = {
		on(name: string, fn: Function) { hooks.set(name, fn); },
		getCommands: () => [], getActiveTools: () => tools, getThinkingLevel: () => thinking,
	} as unknown as ExtensionAPI;
	const theme = {
		fg: (_role: string, s: string) => `\x1b[38;2;105;113;113m${s}\x1b[39m`,
		bold: (s: string) => `\x1b[1m${s}\x1b[22m`, italic: (s: string) => `\x1b[3m${s}\x1b[23m`,
	} as Theme;
	const queries: { resolve: (colour: { r: number; g: number; b: number } | undefined) => void; reject: (error: Error) => void }[] = [];
	const headers: Header[] = [];
	const tui = {
		terminal: { rows: 53 },
		requestRender() { renders++; },
		queryTerminalBackgroundColor() {
			return new Promise<{ r: number; g: number; b: number } | undefined>((resolve, reject) => queries.push({ resolve, reject }));
		},
	};
	const ctx = {
		mode: "tui", cwd: "/code/my-app", model: { id: "model-one" },
		ui: { setHeader(factory: (tui: unknown, theme: Theme) => Header) {
			headers.at(-1)?.dispose();
			headers.push(factory(tui, theme));
		} },
	} as unknown as ExtensionContext;
	landing(pi);
	t.after(() => headers.forEach(header => header.dispose()));
	return {
		ctx, tui, headers, queries, theme,
		start: () => hooks.get("session_start")!({}, ctx),
		emit: (name: string) => hooks.get(name)!({}, ctx),
		setTools: (value: string[]) => { tools = value; },
		setThinking: (value: string) => { thinking = value; },
		renders: () => renders,
	};
}

test("landing starts on each session, caches time slots and freezes on the last drawn frame", t => {
	const h = setup(t);
	h.start();
	const first = h.headers[0], frame = first.render(144);
	assert.equal(frame.length, 48);
	assert.ok(frame.every(line => visibleWidth(line) === 144));
	t.mock.timers.tick(50);
	assert.equal(first.render(144), frame, "Keypress within a frame should reuse its rows");
	t.mock.timers.tick(100);
	assert.equal(h.renders(), 1);
	const next = first.render(144);
	assert.notDeepEqual(next, frame);
	t.mock.timers.tick(60);
	h.emit("agent_start");
	t.mock.timers.tick(9000);
	assert.equal(h.renders(), 1);
	assert.equal(first.render(144), next, "Freeze the shown frame, not an unseen later time");
	h.start();
	assert.equal(h.headers.length, 2);
	h.headers[1].render(144);
	first.dispose(); // A late old disposer must not stop the replacement header.
	t.mock.timers.tick(150);
	assert.equal(h.renders(), 2);
	h.emit("session_shutdown");
	t.mock.timers.tick(9000);
	assert.equal(h.renders(), 2);
});

test("frozen landing updates equal-width model/tool labels and theme changes", t => {
	const h = setup(t);
	h.start();
	const header = h.headers[0];
	header.render(144);
	h.emit("agent_start");
	h.ctx.model!.id = "model-two";
	const changed = header.render(144);
	assert.ok(changed.some(line => stripTerminalSequences(line).includes("model-two")));
	assert.ok(!changed.some(line => stripTerminalSequences(line).includes("model-one")));
	h.setTools(["edit", "write"]);
	const tools = header.render(144);
	assert.ok(tools.some(line => stripTerminalSequences(line).includes("edit")));
	h.setThinking("off");
	assert.ok(header.render(144).some(line => stripTerminalSequences(line).includes("thinking")));
	h.theme.fg = (_role, s) => `\x1b[38;2;50;70;90m${s}\x1b[39m`;
	header.invalidate();
	assert.ok(header.render(144).some(line => line.includes("\x1b[38;2;50;70;90m")));
});

test("background replies redraw the active header but ignore disposed ones", async t => {
	const h = setup(t);
	h.start();
	const old = h.headers[0];
	old.render(144);
	h.start();
	const current = h.headers[1], light = current.render(144);
	h.queries[0].resolve({ r: 0, g: 0, b: 0 });
	await Promise.resolve();
	assert.equal(h.renders(), 0);
	assert.equal(current.render(144), light);
	h.emit("agent_start");
	h.queries[1].resolve({ r: 24, g: 24, b: 24 });
	await Promise.resolve();
	assert.equal(h.renders(), 1);
	assert.notDeepEqual(current.render(144), light, "A background reply still updates a frozen frame");
	h.start();
	h.headers[2].dispose();
	h.queries[2].resolve({ r: 255, g: 255, b: 255 });
	await Promise.resolve();
	assert.equal(h.renders(), 1);
	h.start();
	h.queries[3].reject(new Error("Unsupported terminal query"));
	await Promise.resolve();
	assert.ok(h.headers[3].render(144).length > 0);
});

test("landing handles resize and narrow widths without splitting styled Unicode", t => {
	const h = setup(t);
	h.ctx.cwd = "/code/界-cafe\u0301-👩‍💻";
	h.start();
	const header = h.headers[0];
	for (const rows of [8, 24, 53]) {
		h.tui.terminal.rows = rows;
		for (const width of [0, 1, 4, 8, 40, 59, 60, 100, 144]) {
			assert.ok(header.render(width).every(line => visibleWidth(line) <= width), `${width} columns, ${rows} rows`);
		}
	}
	assert.ok(header.render(144).some(line => stripTerminalSequences(line).includes("界-cafe\u0301-👩‍💻")));
	assert.equal(header.render(100)[0] && visibleWidth(header.render(100)[0]), 100);
});

test("landing does not register UI or start timers outside TUI", t => {
	const h = setup(t);
	for (const mode of ["rpc", "json", "print"] as const) {
		Object.assign(h.ctx, { mode });
		h.start();
	}
	t.mock.timers.tick(9000);
	assert.equal(h.headers.length, 0);
	assert.equal(h.queries.length, 0);
	assert.equal(h.renders(), 0);
});
