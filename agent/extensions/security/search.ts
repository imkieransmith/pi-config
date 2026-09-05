import { createGrepToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { stat, readFile } from "node:fs/promises";
import { resolve, relative, basename } from "node:path";
import { classifyResolvedPath, resolveSecurityPath } from "./policy.ts";

/** Filter before returning results to Pi (including displays/details), not after streaming them. */
export function protectDiscovery<T extends ToolDefinition<any, any>>(tool: T): T {
  return {
    ...tool,
    async execute(id, args, signal, _update, ctx) {
      const root = await resolveSecurityPath((args as { path?: string }).path ?? ".", ctx.cwd);
      const cwd = await resolveSecurityPath(".", ctx.cwd);
      const directory = (await stat(root)).isDirectory();
      const cache = new Map<string, Promise<boolean>>();
      const allowed = (name: string): Promise<boolean> => {
        const candidate = directory ? resolve(root, name) : root;
        if (!cache.has(candidate)) cache.set(candidate, (async () => {
          try {
            const real = await resolveSecurityPath(candidate, ctx.cwd);
            return (await classifyResolvedPath(real, name, cwd, homedir(), "read")).action === "allow";
          } catch { return false; }
        })());
        return cache.get(candidate)!;
      };
      // Force native grep's readFile formatting path instead of its raw rg lineText
      // shortcut. Authorize the structured filename BEFORE any content is formatted.
      // This also handles filenames containing newlines or fake line delimiters.
      const hiddenNames: string[] = [];
      const input = args as { path?: string; context?: number; pattern: string };
      const source = tool.name === "grep" ? createGrepToolDefinition(ctx.cwd, { operations: {
        isDirectory: async path => (await stat(path)).isDirectory(),
        readFile: async path => {
          if (!await allowed(path)) {
            hiddenNames.push(directory ? relative(root, path).replaceAll("\\", "/") : basename(path));
            throw new Error("Protected search result");
          }
          return readFile(path, "utf8");
        },
      } }) : tool;
      const result = tool.name === "grep"
        ? await source.execute(id, { ...input, context: Math.max(1, input.context ?? 0) }, signal, undefined, ctx)
        : await tool.execute(id, args, signal, undefined, ctx);
      const output: string[] = [];
      let omitted = false;
      for (const item of result.content) {
        if (item.type !== "text") continue;
        let text = item.text;
        for (const name of hiddenNames) text = text.replaceAll(name, "[protected path]");
        for (const line of text.split("\n")) {
          if (!line) continue;
          if (line.includes("[protected path]")) { omitted = true; continue; }
          if (tool.name === "grep") {
            if (!input.context && !/:\d+: /.test(line)) continue;
            const separators = [...line.matchAll(/:\d+: |-\d+- /g)];
            if (!separators.length) continue; // Drop unstructured notices, never guess a filename.
            // Ambiguous delimiters in filenames/content must not conceal a protected path.
            const decisions = await Promise.all(separators.map(match => allowed(line.slice(0, match.index))));
            if (decisions.every(Boolean)) output.push(line); else omitted = true;
          } else {
            if (line.startsWith("[")) continue;
            if (await allowed(line.replace(/\/$/, ""))) output.push(line); else omitted = true;
          }
        }
      }
      const notices = [
        omitted ? "Protected paths omitted." : "",
        result.details ? "Search may be truncated; narrow the query if needed." : "",
      ].filter(Boolean);
      return {
        content: [{ type: "text", text: [...output, ...notices].join("\n") || "No accessible matches found" }],
        // Native truncation details can contain the original unfiltered content.
        details: undefined,
      };
    },
  };
}
