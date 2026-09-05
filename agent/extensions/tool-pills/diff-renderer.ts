/** Use native edits and mutation queues; retain only a bounded display diff for writes. */
import { createEditToolDefinition, createWriteToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import { Text } from "@earendil-works/pi-tui";
import { redact_text, redact_value } from "../redact.ts";
import { pill } from "./pill.ts";
import { renderTextResult } from "./renderers.ts";

const MAX_PREVIEW_BYTES = 256_000;
const MAX_DIFF_CHARS = 32_000;
export function writeDiff(path: string, before: string, after: string): string {
  const patch = createTwoFilesPatch(path, path, before, after, "", "", { context: 3, timeout: 100 });
  if (patch === undefined) return "Write succeeded; diff preview exceeded its time limit";
  const safe = redact_text(patch).redacted;
  return safe.length > MAX_DIFF_CHARS ? `${safe.slice(0, MAX_DIFF_CHARS)}\n[Diff preview truncated]` : safe;
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
    renderCall(args, theme, context) {
      // Native rendering handles content previews, width, theme and expansion.
      return write.renderCall!(redact_value(args) as typeof args, theme, context);
    },
    renderResult(result, options, theme, context) {
      const preview = (result.details as { preview?: string } | undefined)?.preview;
      if (preview && !context.isError) return renderTextResult(preview.split("\n").map(line => theme.fg(line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext", line)).join("\n"), options.expanded, theme);
      return write.renderResult!({ ...result, details: undefined }, options, theme, context);
    },
  });
  const edit = createEditToolDefinition(cwd);
  pi.registerTool({
    ...edit,
    async execute(id, args, signal, _update, ctx) {
      const result = await edit.execute(id, args, signal, undefined, ctx);
      return { ...result, content: redact_value(result.content) as typeof result.content, details: redact_value(result.details) as typeof result.details };
    },
    renderCall(args, theme) {
      return new Text(`${pill("edit", theme)} ${theme.fg("accent", args.path ?? "")}`, 0, 0);
    },
  });
}
