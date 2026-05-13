/**
 * Agent-controlled checkpoints whose summaries survive Pi's ordinary context compaction.
 *
 * /context - Show this command reference and current snapshot status.
 * /context help - Show this command reference.
 * /context status - Show the active checkpoint, dirty state, and recent saved summaries.
 * /context list - List saved durable summaries.
 * /context save [label] - Start a checkpoint before a large investigation. Only one checkpoint can be active.
 * /context cancel - Discard the active checkpoint without saving a summary.
 * /context compact - Ask Pi to compact now. Saved context snapshots are preserved in the compaction summary.
 *
 * Agent tool equivalent: ContextSnapshot can save, restore, cancel, status, and list.
 *
 * Inspired by - https://swival.dev/pages/context-management.html
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { compact as runCompaction } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { randomBytes } from "node:crypto";

const STATE_CUSTOM_TYPE = "context-snapshot-state";
const MESSAGE_CUSTOM_TYPE = "context-snapshot";
const STATE_VERSION = 1;
const SUMMARY_CAP = 5000;
const SUMMARY_CONTEXT_CAP = 8000;
const TOOL_OUTPUT_CAP = 6000;

type SnapshotAction = "save" | "restore" | "cancel" | "status" | "list";

type SnapshotStateEvent =
  | {
      version: 1;
      type: "save";
      checkpointId: string;
      label: string;
      createdAt: number;
      leafId?: string;
    }
  | {
      version: 1;
      type: "dirty";
      checkpointId: string;
      reason: string;
      toolName?: string;
      createdAt: number;
    }
  | {
      version: 1;
      type: "cancel";
      checkpointId: string;
      createdAt: number;
    }
  | {
      version: 1;
      type: "restore";
      checkpointId: string;
      summaryId: string;
      label: string;
      summary: string;
      forced: boolean;
      wasDirty: boolean;
      createdAt: number;
    };

export interface ActiveCheckpoint {
  id: string;
  label: string;
  createdAt: number;
  leafId?: string;
  dirty: boolean;
  dirtyReason?: string;
}

export interface SavedSummary {
  id: string;
  checkpointId: string;
  label: string;
  summary: string;
  forced: boolean;
  wasDirty: boolean;
  createdAt: number;
}

export interface SessionState {
  active?: ActiveCheckpoint;
  summaries: SavedSummary[];
}

export type SnapshotContext = ExtensionCommandContext | ExtensionContext;

const states = new Map<string, SessionState>();
const pendingMutations = new Map<string, { toolName: string; reason: string }>();

function now(): number {
  return Date.now();
}

function id(prefix: string): string {
  return `${prefix}${randomBytes(3).toString("hex")}`;
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n[... truncated at ${cap} chars ...]`;
}

function cleanLabel(raw: string | undefined): string {
  const label = (raw ?? "").trim();
  return label || "checkpoint";
}

function cleanSummary(raw: string | undefined): string {
  return truncate((raw ?? "").trim(), SUMMARY_CAP);
}

function emptyState(): SessionState {
  return { summaries: [] };
}

function getSessionId(ctx: SnapshotContext): string {
  return ctx.sessionManager.getSessionId();
}

export function stateFor(ctx: SnapshotContext): SessionState {
  const sessionId = getSessionId(ctx);
  let state = states.get(sessionId);
  if (!state) {
    state = hydrateState(ctx.sessionManager.getBranch());
    states.set(sessionId, state);
  }
  return state;
}

function resetState(sessionId: string): void {
  states.delete(sessionId);
}

function rebuildState(ctx: SnapshotContext): SessionState {
  const state = hydrateState(ctx.sessionManager.getBranch());
  states.set(getSessionId(ctx), state);
  return state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStateEntry(entry: SessionEntry): boolean {
  return entry.type === "custom" && entry.customType === STATE_CUSTOM_TYPE;
}

function getStateEvent(entry: SessionEntry): SnapshotStateEvent | undefined {
  if (!isStateEntry(entry)) return undefined;
  const data = entry.data;
  if (!isRecord(data) || data.version !== STATE_VERSION || typeof data.type !== "string") {
    return undefined;
  }

  return data as SnapshotStateEvent;
}

function hydrateState(entries: SessionEntry[]): SessionState {
  const state = emptyState();

  for (const entry of entries) {
    const event = getStateEvent(entry);
    if (!event) continue;

    if (event.type === "save") {
      state.active = {
        id: event.checkpointId,
        label: event.label,
        createdAt: event.createdAt,
        leafId: event.leafId,
        dirty: false,
      };
      continue;
    }

    if (event.type === "dirty" && state.active?.id === event.checkpointId) {
      state.active.dirty = true;
      state.active.dirtyReason = event.reason;
      continue;
    }

    if (event.type === "cancel" && state.active?.id === event.checkpointId) {
      state.active = undefined;
      continue;
    }

    if (event.type === "restore") {
      state.summaries.push({
        id: event.summaryId,
        checkpointId: event.checkpointId,
        label: event.label,
        summary: event.summary,
        forced: event.forced,
        wasDirty: event.wasDirty,
        createdAt: event.createdAt,
      });
      if (state.active?.id === event.checkpointId) state.active = undefined;
    }
  }

  return state;
}

function appendStateEvent(pi: ExtensionAPI, event: SnapshotStateEvent): void {
  pi.appendEntry(STATE_CUSTOM_TYPE, event);
}

export function saveCheckpoint(pi: ExtensionAPI, ctx: SnapshotContext, label: string | undefined): string {
  const state = stateFor(ctx);
  if (state.active) {
    throw new Error(
      `context checkpoint '${state.active.label}' is already active; restore or cancel it before saving another`,
    );
  }

  const checkpoint: ActiveCheckpoint = {
    id: id("c"),
    label: cleanLabel(label),
    createdAt: now(),
    leafId: ctx.sessionManager.getLeafId(),
    dirty: false,
  };

  state.active = checkpoint;
  appendStateEvent(pi, {
    version: STATE_VERSION,
    type: "save",
    checkpointId: checkpoint.id,
    label: checkpoint.label,
    createdAt: checkpoint.createdAt,
    leafId: checkpoint.leafId,
  });

  return checkpoint.id;
}

function cancelCheckpoint(pi: ExtensionAPI, ctx: SnapshotContext): string {
  const state = stateFor(ctx);
  if (!state.active) throw new Error("no active context checkpoint to cancel");

  const checkpoint = state.active;
  state.active = undefined;
  appendStateEvent(pi, {
    version: STATE_VERSION,
    type: "cancel",
    checkpointId: checkpoint.id,
    createdAt: now(),
  });

  return checkpoint.id;
}

export function restoreCheckpoint(
  pi: ExtensionAPI,
  ctx: SnapshotContext,
  summary: string,
  force: boolean,
): SavedSummary {
  const state = stateFor(ctx);
  if (!state.active) throw new Error("no active context checkpoint to restore");

  const checkpoint = state.active;
  if (checkpoint.dirty && !force) {
    throw new Error(
      `checkpoint '${checkpoint.label}' is dirty (${checkpoint.dirtyReason ?? "mutation observed"}); ` +
        "retry with force: true after confirming the summary accounts for those changes",
    );
  }

  const cleaned = cleanSummary(summary);
  if (!cleaned) throw new Error("summary is required for restore");

  const saved: SavedSummary = {
    id: id("s"),
    checkpointId: checkpoint.id,
    label: checkpoint.label,
    summary: cleaned,
    forced: force,
    wasDirty: checkpoint.dirty,
    createdAt: now(),
  };

  state.summaries.push(saved);
  state.active = undefined;
  appendStateEvent(pi, {
    version: STATE_VERSION,
    type: "restore",
    checkpointId: checkpoint.id,
    summaryId: saved.id,
    label: saved.label,
    summary: saved.summary,
    forced: saved.forced,
    wasDirty: saved.wasDirty,
    createdAt: saved.createdAt,
  });

  return saved;
}

function markDirty(pi: ExtensionAPI, ctx: ExtensionContext, reason: string, toolName?: string): void {
  const state = stateFor(ctx);
  const checkpoint = state.active;
  if (!checkpoint || checkpoint.dirty) return;

  checkpoint.dirty = true;
  checkpoint.dirtyReason = reason;
  appendStateEvent(pi, {
    version: STATE_VERSION,
    type: "dirty",
    checkpointId: checkpoint.id,
    reason,
    toolName,
    createdAt: now(),
  });
}

function isBashMutation(command: string): boolean {
  return (
    /(?:^|[^<])>>?\s*\S/.test(command) ||
    /\b(?:tee|sponge|cp|mv|install|mkdir|rmdir|touch|rm|chmod|chown|truncate)\b/i.test(command) ||
    /\b(?:sed\s+-i|perl\s+-pi)\b/i.test(command) ||
    /\b(?:git\s+(?:add|am|apply|checkout|clean|commit|merge|mv|rebase|reset|restore|rm|switch))\b/i.test(command) ||
    /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|upgrade|create)\b/i.test(command)
  );
}

function mutationFromToolCall(event: ToolCallEvent): { toolName: string; reason: string } | undefined {
  if (event.toolName === "write" || event.toolName === "edit") {
    return { toolName: event.toolName, reason: `${event.toolName} tool` };
  }

  if (event.toolName === "bash") {
    const command = typeof event.input?.command === "string" ? event.input.command : "";
    if (isBashMutation(command)) return { toolName: "bash", reason: "mutating bash command" };
  }

  if (/^(?:apply|patch|write|edit|update|delete|remove|move|rename|create)/i.test(event.toolName)) {
    return { toolName: event.toolName, reason: `mutation-like tool '${event.toolName}'` };
  }

  return undefined;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString();
}

function formatActive(active: ActiveCheckpoint | undefined): string {
  if (!active) return "active: none";

  const dirty = active.dirty
    ? `dirty (${active.dirtyReason ?? "mutation observed"})`
    : "clean";
  return `active: ${active.id} '${active.label}' - ${dirty} - ${formatDate(active.createdAt)}`;
}

function formatSummaryLine(summary: SavedSummary): string {
  const dirty = summary.wasDirty ? ", dirty" : "";
  const forced = summary.forced ? ", forced" : "";
  return `${summary.id}\t${summary.label}\t${formatDate(summary.createdAt)}${dirty}${forced}`;
}

function formatSummaryList(state: SessionState): string {
  if (state.summaries.length === 0) return "(no saved context summaries yet)";
  return state.summaries.map(formatSummaryLine).join("\n");
}

function formatStatus(state: SessionState): string {
  const lines = [
    "Context snapshots",
    formatActive(state.active),
    `saved summaries: ${state.summaries.length}`,
  ];

  if (state.summaries.length > 0) {
    lines.push("", "recent summaries:", formatSummaryList({
      ...state,
      summaries: state.summaries.slice(-5),
    }));
  }

  return truncate(lines.join("\n"), TOOL_OUTPUT_CAP);
}

function formatSavedSummary(summary: SavedSummary): string {
  return truncate(
    [
      `saved ${summary.id}: ${summary.label}`,
      summary.wasDirty
        ? "checkpoint was dirty; summary was accepted with force"
        : "checkpoint was clean",
      "",
      summary.summary,
    ].join("\n"),
    TOOL_OUTPUT_CAP,
  );
}

function preservedContext(state: SessionState): string | undefined {
  if (state.summaries.length === 0) return undefined;

  const chunks = state.summaries.map((summary) =>
    [
      `### ${summary.id}: ${summary.label}`,
      summary.wasDirty ? "(restored from a dirty checkpoint)" : undefined,
      summary.summary,
    ].filter(Boolean).join("\n"),
  );

  return truncate(
    [
      "## Preserved Context Snapshots",
      "The following summaries were explicitly saved before context was collapsed. Treat them as durable working memory.",
      "",
      ...chunks,
    ].join("\n\n"),
    SUMMARY_CONTEXT_CAP,
  );
}

function compactionInstructions(state: SessionState): string | undefined {
  const context = preservedContext(state);
  if (!context) return undefined;

  return [
    "Preserve these ContextSnapshot summaries verbatim or near-verbatim in the compaction summary.",
    context,
  ].join("\n\n");
}

function showCommandMessage(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({
    customType: MESSAGE_CUSTOM_TYPE,
    content: truncate(content, TOOL_OUTPUT_CAP),
    display: true,
    details: {},
  }, { triggerTurn: false });
}

function formatCommandHelp(): string {
  return [
    "Context snapshots",
    "",
    "/context",
    "  Show this command reference and current snapshot status.",
    "",
    "/context help",
    "  Show this command reference.",
    "",
    "/context status",
    "  Show the active checkpoint, dirty state, and recent saved summaries.",
    "",
    "/context list",
    "  List saved durable summaries.",
    "",
    "/context save <label>",
    "  Start a checkpoint before a large investigation. Only one checkpoint can be active.",
    "",
    "/context cancel",
    "  Discard the active checkpoint without saving a summary.",
    "",
    "/context compact",
    "  Ask Pi to compact now. Saved context snapshots are preserved in the compaction summary.",
    "",
    "Agent tool equivalent: ContextSnapshot can save, restore, cancel, status, and list.",
  ].join("\n");
}

function parseCommand(args: string): { action: string; rest: string } {
  const trimmed = (args ?? "").trim();
  if (!trimmed) return { action: "help", rest: "" };

  const [action, ...rest] = trimmed.split(/\s+/);
  return { action: action.toLowerCase(), rest: rest.join(" ") };
}

async function runCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const { action, rest } = parseCommand(args);

  try {
    if (action === "help" || action === "?") {
      showCommandMessage(pi, `${formatCommandHelp()}\n\nCurrent status:\n${formatStatus(stateFor(ctx))}`);
      return;
    }

    if (action === "status") {
      showCommandMessage(pi, formatStatus(stateFor(ctx)));
      return;
    }

    if (action === "list") {
      showCommandMessage(pi, formatSummaryList(stateFor(ctx)));
      return;
    }

    if (action === "save") {
      const checkpointId = saveCheckpoint(pi, ctx, rest);
      showCommandMessage(pi, `saved checkpoint ${checkpointId}: ${cleanLabel(rest)}`);
      return;
    }

    if (action === "cancel") {
      const checkpointId = cancelCheckpoint(pi, ctx);
      showCommandMessage(pi, `cancelled checkpoint ${checkpointId}`);
      return;
    }

    if (action === "compact") {
      const instructions = compactionInstructions(stateFor(ctx));
      if (instructions) {
        ctx.compact();
        showCommandMessage(pi, "compaction requested with preserved context snapshot instructions");
      } else {
        ctx.compact();
        showCommandMessage(pi, "compaction requested; no saved context snapshots yet");
      }
      return;
    }

    showCommandMessage(
      pi,
      `Unknown /context action '${action}'.\n\n${formatCommandHelp()}`,
    );
  } catch (error) {
    showCommandMessage(pi, error instanceof Error ? error.message : String(error));
  }
}

export default function (pi: ExtensionAPI) {
  // Lifecycle

  pi.on("session_start", async (_event, ctx) => {
    rebuildState(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    rebuildState(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    resetState(ctx.sessionManager.getSessionId());
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const context = preservedContext(stateFor(ctx));
    if (!context) return undefined;

    return {
      message: {
        customType: MESSAGE_CUSTOM_TYPE,
        content: context,
        display: false,
        details: { source: STATE_CUSTOM_TYPE },
      },
    };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const instructions = compactionInstructions(stateFor(ctx));
    if (!instructions) return undefined;

    if (!ctx.model) throw new Error("No model available for context snapshot compaction");

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok) throw new Error(auth.error);
    if (!auth.apiKey) {
      throw new Error(`No API key available for context snapshot compaction with ${ctx.model.provider}`);
    }

    const customInstructions = [instructions, event.customInstructions]
      .filter(Boolean)
      .join("\n\n");
    const compaction = await runCompaction(
      event.preparation,
      ctx.model,
      auth.apiKey,
      auth.headers,
      customInstructions,
      event.signal,
    );

    return { compaction };
  });

  pi.on("session_compact", async (_event, ctx) => {
    const state = stateFor(ctx);
    if (state.summaries.length === 0 || !ctx.hasUI) return;

    ctx.ui.notify(
      `context: ${state.summaries.length} saved summar${state.summaries.length === 1 ? "y" : "ies"} preserved`,
      "info",
    );
  });

  // Dirty tracking

  pi.on("tool_call", async (event) => {
    const mutation = mutationFromToolCall(event);
    if (!mutation) return undefined;

    pendingMutations.set(event.toolCallId, mutation);
    return undefined;
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const mutation = pendingMutations.get(event.toolCallId);
    pendingMutations.delete(event.toolCallId);
    if (!mutation) return;

    const suffix = event.isError ? "failed " : "";
    markDirty(pi, ctx, `${suffix}${mutation.reason}`, mutation.toolName);
  });

  // Commands

  pi.registerCommand("context", {
    description: "Manage durable context snapshots.",
    getArgumentCompletions: (prefix: string) => {
      const options = [
        { value: "help", description: "Show the command reference and current status." },
        { value: "status", description: "Show active checkpoint, dirty state, and recent summaries." },
        { value: "list", description: "List saved durable summaries." },
        { value: "save", description: "Start a checkpoint before a large investigation." },
        { value: "cancel", description: "Discard the active checkpoint." },
        { value: "compact", description: "Request compaction while preserving saved snapshots." },
      ];
      const normalized = (prefix ?? "").trim().toLowerCase();
      const items = options
        .filter((item) => item.value.startsWith(normalized))
        .map((item) => ({ value: item.value, label: item.value, description: item.description }));

      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await runCommand(pi, args, ctx);
    },
  });

  // Tool

  pi.registerTool({
    name: "ContextSnapshot",
    label: "ContextSnapshot",
    description:
      "Manage durable context checkpoints for long or exploratory work. " +
      "Call save before a large investigation, then call restore with a structured summary of what mattered. " +
      "Saved restore summaries are reintroduced after context compaction so important discoveries survive.",
    promptSnippet:
      "ContextSnapshot saves durable checkpoints and restore summaries for long investigations; use it to keep context compact without losing decisions, facts, files, or open questions.",
    promptGuidelines: [
      "Use ContextSnapshot save before a broad search, debugging session, design investigation, or any work likely to create throwaway context.",
      "Use ContextSnapshot restore when the investigation is complete or before switching tasks. Do not merely say 'summary'; write a continuation-ready recap.",
      "A good restore summary should cover: (1) the goal or question being investigated, (2) key facts discovered and decisions made, (3) files touched or inspected and why, and (4) outstanding questions, risks, or next steps.",
      "Keep restore summaries concise but specific. Preserve exact file paths, command names, API names, error messages, and user constraints when they matter.",
      "If mutations happened after save, restore may require force: true. Only force after the summary accounts for those changes.",
      "Set triggerCompact true on restore when the surrounding conversation should be compacted immediately after saving the durable summary.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      action: StringEnum(["save", "restore", "cancel", "status", "list"], {
        description: "Snapshot action to perform.",
      }),
      label: Type.Optional(Type.String({
        description: "Human-readable checkpoint label for save, such as 'auth bug investigation' or 'context extension design'.",
      })),
      summary: Type.Optional(Type.String({
        description:
          "Required for restore. Use a structured continuation summary covering goal, key facts/decisions, files touched or inspected and why, and outstanding questions/next steps.",
      })),
      force: Type.Optional(Type.Boolean({
        description: "Allow restore when the checkpoint observed file or command mutations. Use only after the summary accounts for those changes.",
      })),
      triggerCompact: Type.Optional(Type.Boolean({
        description: "After restore, request Pi compaction with snapshot preservation instructions.",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action as SnapshotAction;

      if (action === "status") {
        return { content: [{ type: "text", text: formatStatus(stateFor(ctx)) }], details: {} };
      }

      if (action === "list") {
        return {
          content: [{ type: "text", text: truncate(formatSummaryList(stateFor(ctx)), TOOL_OUTPUT_CAP) }],
          details: {},
        };
      }

      if (action === "save") {
        const checkpointId = saveCheckpoint(pi, ctx, params.label);
        return {
          content: [{
            type: "text",
            text: `saved checkpoint ${checkpointId}: ${cleanLabel(params.label)}`,
          }],
          details: {},
        };
      }

      if (action === "cancel") {
        const checkpointId = cancelCheckpoint(pi, ctx);
        return {
          content: [{ type: "text", text: `cancelled checkpoint ${checkpointId}` }],
          details: {},
        };
      }

      if (action === "restore") {
        const saved = restoreCheckpoint(pi, ctx, params.summary, params.force === true);
        if (params.triggerCompact === true) {
          ctx.compact();
        }

        return {
          content: [{ type: "text", text: formatSavedSummary(saved) }],
          details: {},
        };
      }

      throw new Error(`unknown action '${String(action)}'`);
    },
  });
}
