/**
 * Allow the model to send a condensed/summarised package of the conversation to another model for guidance.
 *
 * /advisor - pick the advisor model.
 *
 * Original - https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    registerAdvisorBeforeAgentStart,
    registerAdvisorCommand,
    registerAdvisorPermissionGate,
    registerAdvisorTool,
    restoreAdvisorState,
} from "./advisor.js";

export default function (pi: ExtensionAPI) {
    registerAdvisorTool(pi);
    registerAdvisorCommand(pi);
    registerAdvisorPermissionGate(pi);
    registerAdvisorBeforeAgentStart(pi);

    pi.on("session_start", async (_event, ctx) => {
        restoreAdvisorState(ctx, pi);
    });
}
