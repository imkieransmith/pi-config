/**
 * `npm run setup`: copies keys from base-settings.json (tracked) into
 * settings.json (local, ignored) where they're missing. Local values win.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Settings = Record<string, unknown>;

const isObject = (value: unknown): value is Settings => typeof value === "object" && value !== null && !Array.isArray(value);

/** Returns the merged settings and the dotted keys it added. */
export function fillMissing(base: Settings, local: Settings, prefix = ""): { settings: Settings; added: string[] } {
  const out: Settings = { ...local };
  const added: string[] = [];
  for (const [key, value] of Object.entries(base)) {
    if (!(key in out)) {
      out[key] = value;
      added.push(prefix + key);
    } else if (isObject(value)) {
      const current = out[key];
      if (!isObject(current)) continue;
      const inner = fillMissing(value, current, `${prefix}${key}.`);
      out[key] = inner.settings;
      added.push(...inner.added);
    }
  }
  return { settings: out, added };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = dirname(fileURLToPath(import.meta.url));
  const file = join(dir, "settings.json");
  const base = JSON.parse(readFileSync(join(dir, "base-settings.json"), "utf8"));
  const local = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const { settings, added } = fillMissing(base, local);
  if (added.length) writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(added.length ? `Added to settings.json: ${added.join(", ")}` : "settings.json already has every base key.");
}
