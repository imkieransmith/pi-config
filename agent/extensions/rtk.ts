/**
 * Best-effort RTK output compression without changing the checked command's arguments.
 * Based on https://github.com/sherif-fanous/pi-rtk
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { renderBashCall, renderBashResult } from "./tool-pills/renderers.ts";
import { redact_value } from "./redact.ts";

const run = promisify(execFile);
const CACHE_LIMIT = 256;

export default function (pi: ExtensionAPI) {
  const cache = new Map<string, string>();
  let attempts = 0, rewrites = 0;
  async function rewrite(command: string, signal?: AbortSignal): Promise<string> {
    // Shell composition and substitutions require a shell parser. Leave them untouched.
    if (/[\n;&|`$()<>]/.test(command)) return command;
    const cached = cache.get(command);
    if (cached) return cached;
    attempts++;
    let result = command;
    try {
      const { stdout } = await run("rtk", ["rewrite", command], { timeout: 1500, maxBuffer: 64_000, signal });
      const proposed = stdout.trimEnd();
      // RTK may propose argument/subcommand changes. Accept only an exact prefix,
      // so neither safety gate can approve one target and execute another.
      if (proposed === `rtk ${command}`) { result = proposed; rewrites++; }
    } catch { /* Unavailable/unsupported RTK leaves Bash usable. */ }
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(command, result);
    return result;
  }
  pi.on("session_start", () => { cache.clear(); attempts = 0; rewrites = 0; });
  const tool = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...tool,
    async execute(id, args, signal, _update, ctx) {
      const command = await rewrite(args.command, signal);
      // Withhold raw streaming text; final output is redacted before display/storage.
      const result = await tool.execute(id, { ...args, command }, signal, undefined, ctx);
      return { ...result, content: redact_value(result.content) as typeof result.content, details: redact_value(result.details) as typeof result.details };
    },
    renderCall: renderBashCall,
    renderResult: renderBashResult,
  });
  const local = createLocalBashOperations();
  pi.on("user_bash", async event => {
    if (event.excludeFromContext) return;
    const command = await rewrite(event.command);
    if (command === event.command) return;
    return { operations: { exec: (original, cwd, options) => local.exec(original === event.command ? command : original, cwd, options) } };
  });
  pi.registerCommand("rtk", {
    description: "Show bounded RTK rewrite statistics",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`RTK: ${rewrites}/${attempts} rewrites; ${cache.size}/${CACHE_LIMIT} cached. Only unchanged command/arguments with an RTK prefix are accepted.`, "info");
    },
  });
}
