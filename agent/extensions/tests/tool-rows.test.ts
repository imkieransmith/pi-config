import assert from "node:assert/strict";
import test from "node:test";
import { bashRow } from "../tool-pills/renderers.ts";
import { diffNote } from "../tool-pills/diff-renderer.ts";

const theme: any = { fg: (_: string, t: string) => t, bg: (_: string, t: string) => t, bold: (t: string) => t, inverse: (t: string) => t, getBgAnsi: () => "" };
const command = "cd /Users/kieran/.pi && npm test 2>&1 | grep -E 'pass|fail'; npm run typecheck 2>&1 | grep -c error; git status --short";

/** Renders one tool row the way Pi does: call first, then result, then draw. */
function draw(result: any, { expanded = false, isError = false, isPartial = false } = {}) {
  const ctx: any = { state: {}, expanded, isError, isPartial, args: { command } };
  const call = bashRow.renderCall({ command }, theme, ctx);
  const body = result ? bashRow.renderResult(result, { expanded }, theme, ctx) : undefined;
  return [...call.render(60), ...(body?.render(60) ?? [])].map(l => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
}

const output = { content: [{ type: "text", text: "pass 82\nfail 0\n M README.md\n" }] };

test("collapsed rows are one line with a note on the right", () => {
  const lines = draw(output);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 59); // 60 columns minus the right padding
  assert.match(lines[0], /^ +bash +cd \/Users\/kieran\/\.pi && npm test.*\.\.\. +3 lines ▸$/);
});

test("cut rows keep their tint after the ellipsis", () => {
  const tintTheme = { ...theme, bg: (_: string, t: string) => `<bg>${t}</bg>`, getBgAnsi: () => "<bg>" };
  const ctx: any = { state: {}, expanded: false, isError: false, isPartial: false, args: { command } };
  const [line] = bashRow.renderCall({ command }, tintTheme, ctx).render(60);
  assert.ok(line.includes("\x1b[0m"));
  assert.ok(line.split("\x1b[0m").slice(1).every(part => part.startsWith("<bg>")));
});

test("expanded rows show the full command and output", () => {
  const lines = draw(output, { expanded: true });
  assert.match(lines[0], /3 lines ▾$/);
  assert.ok(lines.some(l => l.includes("git status --short")));
  assert.deepEqual(lines.slice(-3).map(l => l.trim()), ["pass 82", "fail 0", "M README.md"]);
});

test("failed rows stay collapsed and show the exit code", () => {
  const lines = draw({ content: [{ type: "text", text: "boom\n\nCommand exited with code 2" }] }, { isError: true });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /exit 2 ▸$/);
});

test("running rows have no note or toggle marker", () => {
  const lines = draw(undefined, { isPartial: true });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /[▸▾]/);
});

test("diff notes count added and removed lines", () => {
  assert.equal(diffNote("--- a\n+++ a\n@@ -1 +1,2 @@\n-old\n+new\n+more\n same"), "+2 \u22121");
  assert.equal(diffNote(" 1 same\n-2 old\n+2 new"), "+1 \u22121");
  assert.equal(diffNote(""), "no change");
});
