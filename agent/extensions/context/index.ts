/**
 * Agent-controlled captures stored durably, with a recent bounded appendix added after Pi compacts.
 *
 * The context_snapshot tool starts, finishes, discards, and inspects captures.
 *
 * Inspired by - https://swival.dev/pages/context-management.html
 */

import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { compact as runCompaction } from "@earendil-works/pi-coding-agent";
import { getText, row } from "../tool-pills/renderers.ts";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { randomBytes } from "node:crypto";
import {
  snapshotAppendix,
  stripTerminalSnapshotAppendix,
} from "./appendix.ts";

const STATE_CUSTOM_TYPE = "context-snapshot-state";
const STATE_VERSION = 1;
const SUMMARY_CAP = 5000;
const TOOL_OUTPUT_CAP = 6000;

type SnapshotAction = "start" | "finish" | "discard" | "status" | "list";

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

export interface ActiveCapture {
  id: string;
  label: string;
  createdAt: number;
  leafId?: string;
  changesObserved: boolean;
  changeReason?: string;
}

export interface DurableSummary {
  id: string;
  captureId: string;
  label: string;
  summary: string;
  forced: boolean;
  hadChanges: boolean;
  createdAt: number;
}

export interface SessionState {
  active?: ActiveCapture;
  summaries: DurableSummary[];
}


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
  return label || "capture";
}

function cleanSummary(raw: string | undefined): string {
  return truncate((raw ?? "").trim(), SUMMARY_CAP);
}

function emptyState(): SessionState {
  return { summaries: [] };
}

function getSessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

export function stateFor(ctx: ExtensionContext): SessionState {
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

function rebuildState(ctx: ExtensionContext): SessionState {
  const state = hydrateState(ctx.sessionManager.getBranch());
  states.set(getSessionId(ctx), state);
  return state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStateEntry(entry: SessionEntry): entry is CustomEntry {
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

    // Persisted V1 event names remain unchanged for existing sessions.
    if (event.type === "save") {
      state.active = {
        id: event.checkpointId,
        label: event.label,
        createdAt: event.createdAt,
        leafId: event.leafId,
        changesObserved: false,
      };
      continue;
    }

    if (event.type === "dirty" && state.active?.id === event.checkpointId) {
      state.active.changesObserved = true;
      state.active.changeReason = event.reason;
      continue;
    }

    if (event.type === "cancel" && state.active?.id === event.checkpointId) {
      state.active = undefined;
      continue;
    }

    if (event.type === "restore") {
      state.summaries.push({
        id: event.summaryId,
        captureId: event.checkpointId,
        label: event.label,
        summary: event.summary,
        forced: event.forced,
        hadChanges: event.wasDirty,
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

export function startCapture(pi: ExtensionAPI, ctx: ExtensionContext, label: string | undefined): string {
  const state = stateFor(ctx);
  if (state.active) {
    throw new Error(
      `context capture '${state.active.label}' is already active; finish or discard it before starting another`,
    );
  }

  const capture: ActiveCapture = {
    id: id("c"),
    label: cleanLabel(label),
    createdAt: now(),
    leafId: ctx.sessionManager.getLeafId() ?? undefined,
    changesObserved: false,
  };

  state.active = capture;
  appendStateEvent(pi, {
    version: STATE_VERSION,
    type: "save",
    checkpointId: capture.id,
    label: capture.label,
    createdAt: capture.createdAt,
    leafId: capture.leafId,
  });

  return capture.id;
}

function discardCapture(pi: ExtensionAPI, ctx: ExtensionContext): string {
  const state = stateFor(ctx);
  if (!state.active) throw new Error("no active context capture to discard");

  const capture = state.active;
  state.active = undefined;
  appendStateEvent(pi, {
    version: STATE_VERSION,
    type: "cancel",
    checkpointId: capture.id,
    createdAt: now(),
  });

  return capture.id;
}

export function finishCapture(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  summary: string | undefined,
  force: boolean,
): DurableSummary {
  const state = stateFor(ctx);
  if (!state.active) throw new Error("no active context capture to finish");

  const capture = state.active;
  if (capture.changesObserved && !force) {
    throw new Error(
      `capture '${capture.label}' has observed changes (${capture.changeReason ?? "mutation observed"}); ` +
        "retry with force: true after confirming the durable summary accounts for those changes",
    );
  }

  const cleaned = cleanSummary(summary);
  if (!cleaned) throw new Error("durable summary is required to finish a capture");

  const durableSummary: DurableSummary = {
    id: id("s"),
    captureId: capture.id,
    label: capture.label,
    summary: cleaned,
    forced: force,
    hadChanges: capture.changesObserved,
    createdAt: now(),
  };

  state.summaries.push(durableSummary);
  state.active = undefined;
  appendStateEvent(pi, {
    version: STATE_VERSION,
    type: "restore",
    checkpointId: capture.id,
    summaryId: durableSummary.id,
    label: durableSummary.label,
    summary: durableSummary.summary,
    forced: durableSummary.forced,
    wasDirty: durableSummary.hadChanges,
    createdAt: durableSummary.createdAt,
  });

  return durableSummary;
}

function markChangesObserved(pi: ExtensionAPI, ctx: ExtensionContext, reason: string, toolName?: string): void {
  const state = stateFor(ctx);
  const capture = state.active;
  if (!capture || capture.changesObserved) return;

  capture.changesObserved = true;
  capture.changeReason = reason;
  appendStateEvent(pi, {
    version: STATE_VERSION,
    type: "dirty",
    checkpointId: capture.id,
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

function formatActive(active: ActiveCapture | undefined): string {
  if (!active) return "active capture: none";

  const changeState = active.changesObserved
    ? `changes observed (${active.changeReason ?? "mutation observed"})`
    : "no changes observed";
  return `active capture: ${active.id} '${active.label}' - ${changeState} - ${formatDate(active.createdAt)}`;
}

function formatSummaryLine(summary: DurableSummary): string {
  const changes = summary.hadChanges ? ", changes observed" : "";
  const forced = summary.forced ? ", forced" : "";
  return `${summary.id}\t${summary.label}\t${formatDate(summary.createdAt)}${changes}${forced}`;
}

function formatSummaryList(state: SessionState): string {
  if (state.summaries.length === 0) return "(no durable context summaries yet)";
  return [...state.summaries].reverse().map(formatSummaryLine).join("\n");
}

function formatStatus(state: SessionState): string {
  const lines = [
    "Context snapshots",
    formatActive(state.active),
    `durable summaries: ${state.summaries.length}`,
  ];

  if (state.summaries.length > 0) {
    lines.push("", "recent durable summaries:", formatSummaryList({
      ...state,
      summaries: state.summaries.slice(-5),
    }));
  }

  return truncate(lines.join("\n"), TOOL_OUTPUT_CAP);
}

function formatFinishedSummary(summary: DurableSummary): string {
  return truncate(
    [
      `finished capture ${summary.captureId} '${summary.label}'; saved durable summary ${summary.id}`,
      summary.hadChanges
        ? "changes were observed; durable summary was accepted with force"
        : "no changes were observed during the capture",
      "",
      summary.summary,
    ].join("\n"),
    TOOL_OUTPUT_CAP,
  );
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

  pi.on("session_before_compact", async (event, ctx) => {
    const appendix = snapshotAppendix(stateFor(ctx).summaries);
    const previousSummary = stripTerminalSnapshotAppendix(event.preparation.previousSummary);
    const cleanedPreviousAppendix = previousSummary !== event.preparation.previousSummary;
    if (!appendix && !cleanedPreviousAppendix) return undefined;

    if (!ctx.model) throw new Error("No model available for context snapshot compaction");

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok) throw new Error(auth.error);

    const provider = ctx.modelRegistry.getProvider(ctx.model.provider);
    if (!provider) throw new Error(`Provider ${ctx.model.provider} is unavailable`);

    const model = auth.baseUrl ? { ...ctx.model, baseUrl: auth.baseUrl } : ctx.model;
    const headers = auth.headers
      ? Object.fromEntries(Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : undefined;
    const compaction = await runCompaction(
      {
        ...event.preparation,
        previousSummary,
      },
      model,
      auth.apiKey,
      headers,
      event.customInstructions,
      event.signal,
      ctx.thinkingLevel,
      provider.streamSimple.bind(provider),
      auth.env,
    );

    return {
      compaction: {
        ...compaction,
        summary: appendix
          ? `${compaction.summary.trimEnd()}\n\n${appendix}`
          : compaction.summary,
      },
    };
  });

  // Change tracking

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
    markChangesObserved(pi, ctx, `${suffix}${mutation.reason}`, mutation.toolName);
  });

  // Tool

  pi.registerTool({
    name: "context_snapshot",
    label: "context_snapshot",
    description:
      "Bracket substantial work in a durable context capture. " +
      "Call start before the work, then finish with a structured continuation summary; use discard if nothing should be preserved. " +
      "Finished summaries remain in session state, and a recent bounded set is appended only when Pi compacts. " +
      "context_snapshot never rolls back files or conversation state and never requests compaction.",
    promptSnippet:
      "context_snapshot starts and finishes durable work captures; summaries remain on disk and recent summaries return in Pi's next compaction result.",
    promptGuidelines: [
      "Use context_snapshot start before a broad search, debugging session, design investigation, or any work likely to create throwaway context.",
      "Use context_snapshot finish when the capture is complete or before switching tasks. Finish closes the capture and saves durable context; it does not roll anything back.",
      "A good finish summary should cover: (1) the goal or question being investigated, (2) key facts discovered and decisions made, (3) files touched or inspected and why, and (4) outstanding questions, risks, or next steps.",
      "Keep durable summaries concise but specific. Preserve exact file paths, command names, API names, error messages, and user constraints when they matter.",
      "Finishing stores the summary without reinjecting it on ordinary turns; recent summaries are appended when Pi next compacts.",
      "If changes were observed after start, finish may require force: true. Only force after the summary accounts for those changes.",
      "Use context_snapshot discard only when the active capture should close without a durable summary.",
      "context_snapshot must not trigger or request compaction; compaction is controlled by the user or Pi.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      action: StringEnum(["start", "finish", "discard", "status", "list"], {
        description: "Snapshot action to perform.",
      }),
      label: Type.Optional(Type.String({
        description: "Human-readable capture label for start, such as 'auth bug investigation' or 'context extension design'.",
      })),
      summary: Type.Optional(Type.String({
        description:
          "Required for finish. Use a structured continuation summary covering goal, key facts/decisions, files touched or inspected and why, and outstanding questions/next steps.",
      })),
      force: Type.Optional(Type.Boolean({
        description: "Allow finish when the capture observed file or command mutations. Use only after the durable summary accounts for those changes.",
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

      if (action === "start") {
        const captureId = startCapture(pi, ctx, params.label);
        return {
          content: [{
            type: "text",
            text: `started capture ${captureId}: ${cleanLabel(params.label)}`,
          }],
          details: {},
        };
      }

      if (action === "discard") {
        const captureId = discardCapture(pi, ctx);
        return {
          content: [{ type: "text", text: `discarded capture ${captureId}` }],
          details: {},
        };
      }

      if (action === "finish") {
        const durableSummary = finishCapture(pi, ctx, params.summary, params.force === true);

        return {
          content: [{ type: "text", text: formatFinishedSummary(durableSummary) }],
          details: {},
        };
      }

      throw new Error(`unknown action '${String(action)}'`);
    },
    ...row<{ action?: string; label?: string; summary?: string }>({
      name: "snapshot",
      // Finish shows the summary's opening words; expanding shows the whole saved summary.
      call: ({ action = "", label, summary }, theme) => `${theme.fg("dim", action)} ${label ?? summary ?? ""}`.trimEnd(),
      note: (result) => getText(result).match(/\b(?:started|discarded) capture (\w+)|saved durable summary (\w+)/)?.slice(1).find(Boolean) ?? "",
    }),
  });
}
