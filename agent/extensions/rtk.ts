/**
 * Best-effort RTK output compression without changing the checked command's arguments.
 * Owns the agent's bash tool, so it also routes commands through ./shared/sandbox.ts.
 * Based on https://github.com/sherif-fanous/pi-rtk
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { explainLater, startExplaining } from "./tool-pills/explain.ts";
import { bashRow } from "./tool-pills/renderers.ts";
import { redact_value } from "./redact.ts";
import { SANDBOX_NOTE, sandboxedBashOperations } from "./shared/sandbox.ts";

const run = promisify(execFile);
const CACHE_LIMIT = 256;

export default function (pi: ExtensionAPI) {
  const cache = new Map<string, string>();
  async function rewrite(command: string, signal?: AbortSignal): Promise<string> {
    // Shell composition and substitutions require a shell parser. Leave them untouched.
    if (/[\n;&|`$()<>]/.test(command)) return command;
    const cached = cache.get(command);
    if (cached) return cached;
    let result = command;
    try {
      const { stdout } = await run("rtk", ["rewrite", command], { timeout: 1500, maxBuffer: 64_000, signal });
      const proposed = stdout.trimEnd();
      // RTK may propose argument/subcommand changes. Accept only an exact prefix,
      // so neither safety gate can approve one target and execute another.
      if (proposed === `rtk ${command}`) result = proposed;
    } catch { /* Unavailable/unsupported RTK leaves Bash usable. */ }
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(command, result);
    return result;
  }
  pi.on("session_start", (_event, ctx) => {
    cache.clear();
    startExplaining(ctx);
  });
  // The agent's commands run sandboxed; the user's own `!` commands below do not.
  const tool = createBashToolDefinition(process.cwd(), { operations: sandboxedBashOperations(process.cwd()) });
  pi.registerTool({
    ...tool,
    description: `${tool.description}\n\n${SANDBOX_NOTE}`,
    async execute(id, args, signal, _update, ctx) {
      const command = await rewrite(args.command, signal);
      // Withhold raw streaming text; final output is redacted before display/storage.
      const result = await tool.execute(id, { ...args, command }, signal, undefined, ctx);
      return { ...result, content: redact_value(result.content) as typeof result.content, details: redact_value(result.details) as typeof result.details };
    },
    ...bashRow,
    renderCall(args, theme, ctx) {
      explainLater(args.command, ctx);
      return bashRow.renderCall(args, theme, ctx);
    },
  });
  const local = createLocalBashOperations();
  pi.on("user_bash", async event => {
    if (event.excludeFromContext) return;
    const command = await rewrite(event.command);
    if (command === event.command) return;
    return { operations: { exec: (original, cwd, options) => local.exec(original === event.command ? command : original, cwd, options) } };
  });
}
