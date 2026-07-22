/**
 * A tool to force the use of the plan skill and a ContextSnapshot capture.
 * - An existing capture will be finished with a comprehensive durable summary.
 * - A new capture will be started.
 * - The write-plan skill is loaded in full.
 *
 * /plan [message] - finish the prior capture and build a new plan.
 *
 * Plan skill original - https://www.reddit.com/r/LocalLLaMA/comments/1stjwg5/been_using_pi_coding_agent_with_local_qwen36_35b/
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type ActiveCapture,
  finishCapture,
  startCapture,
  stateFor,
  type SnapshotContext,
} from "./context/index.js";

const MESSAGE_CUSTOM_TYPE = "plan-command";
const TOOL_OUTPUT_CAP = 6000;

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n[... truncated at ${cap} chars ...]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function showCommandMessage(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({
    customType: MESSAGE_CUSTOM_TYPE,
    content: truncate(content, TOOL_OUTPUT_CAP),
    display: true,
    details: {},
  }, { triggerTurn: false });
}

function formatPlanHelp(): string {
  return [
    "Plan command",
    "",
    "/plan <message>",
    "  Finish any active ContextSnapshot capture, start a fresh capture, load the write-plan skill, and forward <message> to the agent.",
    "",
    "Example:",
    "  /plan add OAuth refresh tests",
  ].join("\n");
}

function planLabel(request: string): string {
  const words = request
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);

  return words.length > 0 ? `plan-${words.join("-")}` : "plan-request";
}

function textFromMessage(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  return content
    .map((block) => {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return "";
      return block.text;
    })
    .filter(Boolean)
    .join("\n");
}

function recentConversationDigest(ctx: SnapshotContext, maxEntries = 8): string {
  const lines: string[] = [];
  const branch = ctx.sessionManager.getBranch();

  for (const entry of branch.slice(-maxEntries)) {
    if (entry.type !== "message" || !("message" in entry)) continue;
    const message = entry.message as unknown;
    if (!isRecord(message)) continue;
    const role = typeof message.role === "string" ? message.role : "message";
    if (role !== "user" && role !== "assistant") continue;
    const text = textFromMessage(message)?.replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push(`- ${role}: ${truncate(text, 500)}`);
  }

  return lines.length > 0
    ? lines.join("\n")
    : "- No recent user/assistant messages were available to summarize deterministically.";
}

function formatPlanFinishSummary(ctx: SnapshotContext, active: ActiveCapture, request: string): string {
  const changes = active.changesObserved
    ? `Changes were observed (${active.changeReason ?? "mutation observed"}); this forced finish intentionally closes the capture after recording those changes.`
    : "No changes were observed during the capture.";

  return [
    "Goal: Finish the active ContextSnapshot capture before deterministic /plan handoff.",
    `Key facts: /plan was invoked for: ${request}. Previous capture ${active.id} '${active.label}' is being finished with force so a fresh planning capture can start. ${changes}`,
    "Files: No file list was inferred automatically by /plan; consult the preserved recent conversation digest and prior tool results for exact paths.",
    "Recent conversation digest:",
    recentConversationDigest(ctx),
    "Outstanding: Continue with the new /plan request after starting a fresh capture and loading the write-plan skill.",
  ].join("\n");
}

async function runPlanCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const request = (args ?? "").trim();
  if (!request) {
    showCommandMessage(pi, formatPlanHelp());
    return;
  }

  const planFirstCommand = pi.getCommands().find((command) => command.name === "skill:write-plan");
  if (!planFirstCommand) {
    showCommandMessage(pi, "Cannot start /plan: write-plan skill is not currently loaded/discovered. Run /reload and try again.");
    return;
  }

  await ctx.waitForIdle();
  const state = stateFor(ctx);
  const finishedLabel = state.active?.label;

  if (state.active) {
    finishCapture(pi, ctx, formatPlanFinishSummary(ctx, state.active, request), true);
  }

  const captureId = startCapture(pi, ctx, planLabel(request));
  const finishedText = finishedLabel ? `Finished previous capture '${finishedLabel}', then ` : "";
  showCommandMessage(
    pi,
    `${finishedText}started fresh planning capture ${captureId}. Forwarding request with write-plan loaded.`,
  );
  pi.sendUserMessage(`/skill:write-plan ${request}`);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("plan", {
    description: "Start deterministic write-plan workflow with ContextSnapshot handoff. Usage: /plan <message>",
    getArgumentCompletions: () => null,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await runPlanCommand(pi, args, ctx);
    },
  });
}
