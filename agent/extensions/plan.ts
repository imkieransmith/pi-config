/** A shortcut to the planning skill. Capture handling belongs to the skill, not this command. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("plan", {
    description: "Scope work with the write-plan skill. Usage: /plan <request>",
    handler: async (args, ctx) => {
      const request = args.trim();
      if (!request) { ctx.ui.notify("Usage: /plan <request>", "info"); return; }
      if (!pi.getCommands().some(command => command.name === "skill:write-plan")) {
        ctx.ui.notify("write-plan skill is not loaded. Run /reload after installing it.", "error");
        return;
      }
      await ctx.waitForIdle();
      pi.sendUserMessage(`/skill:write-plan ${request}`, { expandPromptTemplates: true });
    },
  });
}
