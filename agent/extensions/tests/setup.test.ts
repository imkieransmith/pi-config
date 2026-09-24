import assert from "node:assert/strict";
import test from "node:test";
import { fillMissing } from "../../setup.ts";

test("setup fills missing base keys and keeps local values", () => {
  const base = { theme: "light", terminal: { showImages: false }, advisor: { model: "a/b", effort: "high" } };
  const local = { theme: "dark", defaultModel: "x", advisor: { model: "c/d" } };
  const { settings, added } = fillMissing(base, local);
  assert.deepEqual(settings, { theme: "dark", defaultModel: "x", advisor: { model: "c/d", effort: "high" }, terminal: { showImages: false } });
  assert.deepEqual(added, ["terminal", "advisor.effort"]);
  assert.deepEqual(fillMissing(base, settings).added, []);
});
