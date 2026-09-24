/**
 * Owns the agent's bash tool. Every agent command runs inside the OS sandbox
 * set up in ./operations.ts; its output is redacted before display or storage.
 *
 * Your own `!` commands run outside the sandbox. Both get RTK output
 * compression (./rtk.ts) when RTK supports the command.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { explainLater, startExplaining } from "../tool-pills/explain.ts";
import { bashRow } from "../tool-pills/renderers.ts";
import { redact_value } from "../redact.ts";
import { SANDBOX_NOTE, sandboxedBashOperations } from "./operations.ts";
import { clearRtkCache, rtkRewrite } from "./rtk.ts";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    clearRtkCache();
    startExplaining(ctx);
  });

  const tool = createBashToolDefinition(process.cwd(), { operations: sandboxedBashOperations(process.cwd()) });
  pi.registerTool({
    ...tool,
    description: `${tool.description}\n\n${SANDBOX_NOTE}`,
    async execute(id, args, signal, _update, ctx) {
      const command = await rtkRewrite(args.command, signal);
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
    const command = await rtkRewrite(event.command);
    if (command === event.command) return;
    return { operations: { exec: (original, cwd, options) => local.exec(original === event.command ? command : original, cwd, options) } };
  });
}
