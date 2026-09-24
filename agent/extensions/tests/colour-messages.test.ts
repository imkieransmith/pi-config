import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import colourMessages, { dropGapsBetweenBlocks, paintLine, patchRender } from "../colour-messages/index.ts";

// Use the same bundled classes as the CLI, not unbundled lookalikes.
test("message colours leave the native shared loader unchanged across startup and reload", async t => {
  const cli = join(getPackageDir(), "dist/bundle/cli.js");
  const cliRuntime = join(getPackageDir(), "dist/bundle/cli-runtime.js");
  assert.ok(readFileSync(cli, "utf8").includes('createRequire(import.meta.url)("./cli-runtime.js")'));
  const chunk = readFileSync(cliRuntime, "utf8").match(/import\{[^}]*\bmain\b[^}]*\}from"([^"]+)"/)![1];
  const runtime = await import(new URL(chunk, pathToFileURL(cliRuntime)).href);
  const probe = new runtime.BorderedLoader({ requestRender() {} }, { fg: (_: string, text: string) => text }, "Working", { cancellable: false });
  probe.loader.stop();
  const loaderPrototype = Object.getPrototypeOf(probe.loader);
  const nativeRender = loaderPrototype.render;
  const userRender = runtime.UserMessageComponent.prototype.render;
  const widths = [8, 40, 100, 140];
  const baseline = widths.map(width => probe.loader.render(width));
  const argv = process.argv[1];
  process.argv[1] = cli;
  let shutdown = () => {};
  t.after(() => { shutdown(); probe.dispose(); process.argv[1] = argv; });

  for (let reload = 0; reload < 2; reload++) {
    const hooks = new Map<string, Function>();
    colourMessages({ on: (event: string, fn: Function) => hooks.set(event, fn) } as unknown as ExtensionAPI);
    shutdown = () => hooks.get("session_shutdown")!();
    await hooks.get("session_start")!({}, { mode: "tui", ui: { theme: { getBgAnsi: () => "\x1b[48;2;1;2;3m" } } });
    assert.notEqual(runtime.UserMessageComponent.prototype.render, userRender, "message colours still load");
    assert.equal(loaderPrototype.render, nativeRender, "The shared Loader also renders the inline editor status; do not wrap or pad it");
    assert.deepEqual(widths.map(width => probe.loader.render(width)), baseline);
    shutdown();
    assert.equal(runtime.UserMessageComponent.prototype.render, userRender);
  }
});

test("user messages swap Pi's background for ours across the whole line", () => {
  const pi = "\x1b[48;2;232;232;232m", ours = "\x1b[48;2;244;238;226m";
  const line = paintLine(`${pi} hi \x1b[49m`, 8, ours, [pi]);
  assert.ok(!line.includes(pi));
  assert.equal(line, `${ours}${ours} hi ${ours}    \x1b[49m`);
});

test("tool rows can drop Pi's blank line above them", () => {
  const proto: any = { render: () => ["", "row"] };
  const undo = patchRender(proto, "work", { user: "", work: "", assistant: "" }, { dropLeadingBlank: true });
  assert.deepEqual(proto.render(3).map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, "")), ["row"]);
  undo();
  assert.deepEqual(proto.render(3), ["", "row"]);
});

test("endWithBlank adds one blank line only when chosen and needed", () => {
  const proto: any = { render: function (this: any) { return this.lines; } };
  const undo = patchRender(proto, "work", { user: "", work: "", assistant: "" }, { endWithBlank: (i: any) => i.hasToolCalls });
  const strip = (lines: string[]) => lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, "").trim());
  assert.deepEqual(strip(proto.render.call({ lines: ["", "thinking"], hasToolCalls: true }, 10)), ["", "thinking", ""]);
  assert.deepEqual(strip(proto.render.call({ lines: ["", "thinking", ""], hasToolCalls: true }, 10)), ["", "thinking", ""]);
  assert.deepEqual(strip(proto.render.call({ lines: ["", "final"], hasToolCalls: false }, 10)), ["", "final"]);
  undo();
});

test("blank spacers between two coloured blocks are skipped when drawing", () => {
  class Container {
    children: any[] = [];
    render(width: number): string[] { return this.children.flatMap((c) => c.render(width)); }
  }
  class Spacer { render() { return [""]; } }
  class User { render() { return ["user"]; } }
  class Summary { render() { return ["summary"]; } }
  const painted: any = { render: () => ["block"] };
  patchRender(painted, "work", { user: "", work: "", assistant: "" });
  const status = { render: () => ["status"] };
  const chat = new Container();
  chat.children = [Object.create(painted), new Spacer(), new User(), new Spacer(), new Summary(), new Spacer(), new User(), new Spacer(), status, new Spacer(), new User()];
  const undo = dropGapsBetweenBlocks(Container, [User, Summary], [Summary]);
  const [block, ...rest] = chat.render(10);
  assert.match(block, /^block/);
  assert.deepEqual(rest, ["user", "", "summary", "user", "", "status", "", "user"]);
  assert.equal(chat.children.length, 11, "children are restored after drawing");
  undo();
  assert.equal(chat.render(10).length, 11);
});
