/** Apply the reviewed Chromium Mach-registration patch. No package downloads. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Edit = { oldText: string; newText: string; count: number };
type FilePatch = { path: string; sha256: string; edits: Edit[] };
export const sandboxPatch: { version: string; files: FilePatch[] } = JSON.parse(
  readFileSync(new URL("./runtime-patch.json", import.meta.url), "utf8"),
);
const require = createRequire(import.meta.url);
export const sandboxRuntimeDir = dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json"));
const hash = (source: string) => createHash("sha256").update(source).digest("hex");

function replace(source: string, from: string, to: string, count: number): string {
  const parts = source.split(from);
  if (parts.length - 1 !== count) throw new Error("Patch text does not match the reviewed runtime");
  return parts.join(to);
}

function preparePatch(directory: string) {
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (pkg.name !== "@anthropic-ai/sandbox-runtime" || pkg.version !== sandboxPatch.version) {
    throw new Error(`Sandbox patch requires @anthropic-ai/sandbox-runtime ${sandboxPatch.version}; found ${pkg.name} ${pkg.version}`);
  }
  // Check every file before writing any. Unknown or partly edited files fail closed.
  return sandboxPatch.files.map(file => {
    const filename = join(directory, file.path);
    const source = readFileSync(filename, "utf8");
    if (hash(source) === file.sha256) {
      const patched = file.edits.reduce((text, edit) => replace(text, edit.oldText, edit.newText, edit.count), source);
      return { filename, patched, needed: true };
    }
    try {
      const original = [...file.edits].reverse().reduce(
        (text, edit) => replace(text, edit.newText, edit.oldText, edit.count), source,
      );
      if (hash(original) === file.sha256) return { filename, patched: source, needed: false };
    } catch { /* Report the file below, not a partial patch instruction. */ }
    throw new Error(`Sandbox patch refuses unexpected contents: ${filename}`);
  });
}

export function applySandboxPatch(directory = sandboxRuntimeDir): number {
  const files = preparePatch(directory);
  for (const file of files) if (file.needed) writeFileSync(file.filename, file.patched);
  return files.filter(file => file.needed).length;
}

/** Call before sandbox startup, including when npm lifecycle scripts were skipped. */
export function checkSandboxPatch(directory = sandboxRuntimeDir): void {
  if (preparePatch(directory).some(file => file.needed)) {
    throw new Error("Sandbox runtime patch is missing. Run npm run setup:sandbox in the Pi config repo, then restart Pi.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = applySandboxPatch();
  console.log(count ? `Patched ${count} sandbox-runtime files for Chromium Mach registration.` : "Sandbox runtime patch already applied.");
}
