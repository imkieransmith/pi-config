import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type ActiveCheckpoint,
  restoreCheckpoint,
  saveCheckpoint,
  stateFor,
  type SnapshotContext,
} from "./context.js";

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
    "  Restore any active ContextSnapshot checkpoint, save a fresh checkpoint, load the plan-first skill, and forward <message> to the agent.",
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

function formatPlanRestoreSummary(ctx: SnapshotContext, active: ActiveCheckpoint, request: string): string {
  const dirty = active.dirty
    ? `The checkpoint was dirty (${active.dirtyReason ?? "mutation observed"}); this forced restore intentionally closes that dirty checkpoint before starting /plan.`
    : "The checkpoint was clean.";

  return [
    "Goal: Close the active ContextSnapshot checkpoint before deterministic /plan handoff.",
    `Key facts: /plan was invoked for: ${request}. Previous checkpoint ${active.id} '${active.label}' is being restored with force so a fresh planning checkpoint can start. ${dirty}`,
    "Files: No file list was inferred automatically by /plan; consult the preserved recent conversation digest and prior tool results for exact paths.",
    "Recent conversation digest:",
    recentConversationDigest(ctx),
    "Outstanding: Continue with the new /plan request after saving a fresh checkpoint and loading the plan-first skill.",
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

  const planFirstCommand = pi.getCommands().find((command) => command.name === "skill:plan-first");
  if (!planFirstCommand) {
    showCommandMessage(pi, "Cannot start /plan: plan-first skill is not currently loaded/discovered. Run /reload and try again.");
    return;
  }

  await ctx.waitForIdle();
  const state = stateFor(ctx);
  const restoredLabel = state.active?.label;

  if (state.active) {
    restoreCheckpoint(pi, ctx, formatPlanRestoreSummary(ctx, state.active, request), true);
  }

  const checkpointId = saveCheckpoint(pi, ctx, planLabel(request));
  const restoredText = restoredLabel ? `Restored previous checkpoint '${restoredLabel}', then ` : "";
  showCommandMessage(
    pi,
    `${restoredText}saved fresh planning checkpoint ${checkpointId}. Forwarding request with plan-first loaded.`,
  );
  pi.sendUserMessage(`/skill:plan-first ${request}`);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("plan", {
    description: "Start deterministic plan-first workflow with ContextSnapshot handoff. Usage: /plan <message>",
    getArgumentCompletions: () => null,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await runPlanCommand(pi, args, ctx);
    },
  });
}
