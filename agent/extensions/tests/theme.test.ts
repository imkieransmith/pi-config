import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

const themePath = fileURLToPath(new URL("../../themes/classic-light.json", import.meta.url));

test("classic-light is a valid light theme", async () => {
  const dir = join(getPackageDir(), "dist/modes/interactive/theme");
  const { validateThemeJson } = await import(pathToFileURL(join(dir, "theme-json.js")).href);
  const { loadThemeFromPath } = await import(pathToFileURL(join(dir, "theme.js")).href);
  validateThemeJson("classic-light", JSON.parse(readFileSync(themePath, "utf8")));
  const theme = loadThemeFromPath(themePath, "truecolor");
  assert.equal(theme.name, "classic-light");
  assert.equal(theme.appearance, "light");
});

test("setup selects classic-light and the package includes it", () => {
  const base = JSON.parse(readFileSync(new URL("../../base-settings.json", import.meta.url), "utf8"));
  const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  assert.equal(base.theme, "classic-light");
  assert.deepEqual(pkg.pi.themes, ["./agent/themes"]);
});
