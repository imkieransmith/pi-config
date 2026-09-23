/** Use native edits and mutation queues; retain only a bounded display diff for writes. */
import { createEditToolDefinition, createWriteToolDefinition, type ExtensionAPI, renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import { redact_text, redact_value } from "../redact.ts";
import { countNote, row } from "./renderers.ts";

const MAX_PREVIEW_BYTES = 256_000;
const MAX_DIFF_CHARS = 32_000;
export function writeDiff(path: string, before: string, after: string): string {
  const patch = createTwoFilesPatch(path, path, before, after, "", "", { context: 3, timeout: 100 });
  if (patch === undefined) return "Write succeeded; diff preview exceeded its time limit";
  const safe = redact_text(patch).redacted;
  return safe.length > MAX_DIFF_CHARS ? `${safe.slice(0, MAX_DIFF_CHARS)}\n[Diff preview truncated]` : safe;
}

/** "+3 −1" from diff lines. Pi's edit diffs prefix line numbers, unified patches don't. */
export function diffNote(diff: string): string {
  const lines = diff.split("\n").filter(l => !l.startsWith("+++") && !l.startsWith("---"));
  const added = lines.filter(l => l.startsWith("+")).length;
  const removed = lines.filter(l => l.startsWith("-")).length;
  return added || removed ? `+${added} \u2212${removed}` : "no change";
}

const pathCall = (args: { path?: string }, theme: Theme) => theme.fg("accent", args.path ?? "");

function colourPatch(patch: string, theme: Theme): string {
  return patch.split("\n").map(line => theme.fg(line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext", line)).join("\n");
}

export function registerDiffTools(pi: ExtensionAPI): void {
  const cwd = process.cwd();
  const write = createWriteToolDefinition(cwd);
  pi.registerTool({
    ...write,
    async execute(id, args, signal, _update, ctx) {
      let preview: string | undefined;
      const operation = createWriteToolDefinition(ctx.cwd, {
        operations: {
          mkdir: async dir => { await mkdir(dir, { recursive: true }); },
          async writeFile(path, content) {
            // Pi calls this inside its per-file mutation queue, so concurrent writes
            // cannot take their baseline before an earlier write has finished.
            let before: string | undefined;
            try { if ((await stat(path)).size <= MAX_PREVIEW_BYTES) before = await readFile(path, "utf8"); }
            catch { /* A missing/unreadable preview must not change native write behavior. */ }
            if (signal?.aborted) throw new Error("Operation aborted");
            await writeFile(path, content, "utf8");
            if (before !== undefined && Buffer.byteLength(content) <= MAX_PREVIEW_BYTES) {
              try { preview = before === content ? "No content change" : writeDiff(args.path, before, content); }
              catch { preview = "Write succeeded; diff preview unavailable"; }
            }
          },
        },
      });
      const result = await operation.execute(id, args, signal, undefined, ctx);
      return { ...result, details: preview ? { preview } : undefined };
    },
    // A write without a preview created the file (or it was too large to diff): show its content.
    ...row<{ path?: string; content?: string }>({
      name: "write",
      call: pathCall,
      note: (result, args) => {
        const preview: string | undefined = result.details?.preview;
        if (!preview) return `new, ${countNote((args.content ?? "").split("\n").length, "line")}`;
        return preview.includes("\n@@") ? diffNote(preview) : preview === "No content change" ? "no change" : "written";
      },
      body: (result, theme, args) => result.details?.preview
        ? colourPatch(result.details.preview, theme)
        : theme.fg("toolDiffAdded", redact_text(args.content ?? "").redacted),
    }),
  });
  const edit = createEditToolDefinition(cwd);
  pi.registerTool({
    ...edit,
    async execute(id, args, signal, _update, ctx) {
      const result = await edit.execute(id, args, signal, undefined, ctx);
      return { ...result, content: redact_value(result.content) as typeof result.content, details: redact_value(result.details) as typeof result.details };
    },
    ...row<{ path?: string }>({
      name: "edit",
      call: pathCall,
      note: result => diffNote(result.details?.diff ?? ""),
      body: result => renderDiff(result.details?.diff ?? ""),
    }),
  });
}
