/**
 * Compact read rows and write/edit diffs.
 * Security owns discovery tools; Sandbox owns bash. Shared row helpers live in ../shared/.
 *
 * Original - https://github.com/tomsej/pi-ext/tree/main/extensions/tool-pills
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerDiffTools } from "./diff-renderer.js";
import { wrapBasicTool } from "../shared/tool-rows.ts";

export default function (pi: ExtensionAPI) {
  wrapBasicTool(pi, createReadToolDefinition(process.cwd()), { name: "read", call: (args: any, theme) => {
    let text = theme.fg("accent", args.path);
    if (args.offset || args.limit) {
      const parts: string[] = [];
      if (args.offset) parts.push(`L${args.offset}`);
      if (args.limit) parts.push(`${args.limit}L`);
      text += theme.fg("dim", ` ${parts.join(", ")}`);
    }
    return text;
  } });
  registerDiffTools(pi);
}
