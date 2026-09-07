import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import colourMessages from "../colour-messages/index.ts";

// Use the same bundled classes as the CLI, not unbundled lookalikes.
test("message colours leave the native shared loader unchanged across startup and reload", async t => {
  const cli = join(getPackageDir(), "dist/bundle/cli.js");
  const chunk = readFileSync(cli, "utf8").match(/import\{[^}]*\bmain\b[^}]*\}from"([^"]+)"/)![1];
  const runtime = await import(new URL(chunk, pathToFileURL(cli)).href);
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
    await hooks.get("session_start")!({}, { mode: "tui" });
    assert.notEqual(runtime.UserMessageComponent.prototype.render, userRender, "message colours still load");
    assert.equal(loaderPrototype.render, nativeRender, "The shared Loader also renders the inline editor status; do not wrap or pad it");
    assert.deepEqual(widths.map(width => probe.loader.render(width)), baseline);
    shutdown();
    assert.equal(runtime.UserMessageComponent.prototype.render, userRender);
  }
});
