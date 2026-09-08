import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import standaloneWorking from "../standalone-working.ts";

test("standalone working status uses the native editor with a clear input border", () => {
  let start: any, factory: any;
  standaloneWorking({ on: (_event: string, handler: unknown) => { start = handler; } } as ExtensionAPI);
  const ui = { setEditorComponent: (value: unknown) => { factory = value; } };
  for (const mode of ["rpc", "print", "json"]) {
    start({}, { mode, ui });
    assert.equal(factory, undefined);
  }
  start({}, { mode: "tui", ui });
  const editor = factory({ requestRender() {}, terminal: { rows: 24, columns: 100 } }, { borderColor: (text: string) => text }, { matches: (data: string, action: string) => data === "\x1b" && action === "app.interrupt" });
  assert.ok(editor instanceof CustomEditor);
  assert.equal(editor.embedWorkingStatus, false);
  editor.setText("draft input 界");
  // Even a supplied indicator must never enter this editor's border.
  editor.setWorkingStatusIndicator({ renderInBorder: () => "Working", renderSpinnerInBorder: () => "*" } as any);
  for (const width of [20, 40, 100, 140]) {
    const lines = editor.render(width);
    assert.equal(stripVTControlCharacters(lines[0]), "─".repeat(width));
    assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
    assert.ok(!lines.join("\n").includes("Working"));
  }
  assert.equal(editor.getText(), "draft input 界");
  let escaped = false;
  editor.onEscape = () => { escaped = true; };
  // Native app key handling remains in use, rather than a replacement input.
  assert.equal(editor.handleInput, CustomEditor.prototype.handleInput);
  editor.handleInput("\x1b");
  assert.equal(escaped, true);
});
