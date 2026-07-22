/**
 * Allow the model to store and fetch evidence snippets to use as citations in answers.
 *
 * Agent tools:
 * EvidenceAdd - validate and store an exact snippet with source + one-line note.
 * EvidenceGet - retrieve a single entry by ID.
 * EvidenceVerify - retrieve full snippets for every final citation.
 * EvidenceList - discover entries in bounded newest-first cursor pages.
 *
 * Original - https://github.com/itayinbarr/little-coder/tree/main/.pi/extensions/evidence
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MAX_VERIFY_IDS,
  NOTE_CAP,
  SNIPPET_CAP,
  SOURCE_CAP,
  STATE_CUSTOM_TYPE,
  STATE_VERSION,
  findEvidenceDuplicate,
  formatEvidenceEntry,
  formatEvidenceLine,
  hydrateEvidence,
  listEvidencePage,
  normalizeEvidenceId,
  selectEvidenceForVerification,
  validateNewEvidence,
  type EvidencePage,
  type EvidenceEntry,
  type EvidenceStateEvent,
} from "./evidence/core.ts";

const COMMAND_CUSTOM_TYPE = "evidence-proof";
const COMMAND_ENTRY_VERSION = 1;

type EvidenceDisplayKind = "proof" | "list" | "usage" | "error";

interface EvidenceDisplayEntry {
  version: 1;
  kind: EvidenceDisplayKind;
  content: string;
  createdAt: number;
}

type EvidenceContext = ExtensionCommandContext | ExtensionContext;

// Keyed by Pi session ID so concurrent sessions don't bleed into each other.
const stores = new Map<string, EvidenceEntry[]>();

function hydrateStore(entries: SessionEntry[]): EvidenceEntry[] {
  return hydrateEvidence(entries);
}

function rebuildStore(ctx: EvidenceContext): EvidenceEntry[] {
  const store = hydrateStore(ctx.sessionManager.getBranch());
  stores.set(ctx.sessionManager.getSessionId(), store);
  return store;
}

function bucket(ctx: EvidenceContext): EvidenceEntry[] {
  const key = ctx.sessionManager.getSessionId();
  let b = stores.get(key);
  if (!b) {
    b = rebuildStore(ctx);
  }
  return b;
}

function getSessionStore(sessionId: string): EvidenceEntry[] {
  return stores.get(sessionId) ?? [];
}

function resetSessionStore(sessionId: string): void {
  stores.delete(sessionId);
}

function appendEvidenceEntry(pi: ExtensionAPI, entry: EvidenceEntry): void {
  pi.appendEntry(STATE_CUSTOM_TYPE, {
    version: STATE_VERSION,
    type: "add",
    entry,
  } satisfies EvidenceStateEvent);
}

function formatEvidencePage(page: EvidencePage): string {
  if (page.total === 0) return "(no evidence stored yet)";

  const lines = page.entries.map(formatEvidenceLine);
  lines.push("", `showing ${page.entries.length} of ${page.total} entries (newest first)`);
  if (page.nextBeforeId) {
    lines.push(`nextBeforeId: ${page.nextBeforeId}`);
  }
  return lines.join("\n");
}

function generateEvidenceId(store: EvidenceEntry[]): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = "e" + randomBytes(3).toString("hex");
    if (!store.some((entry) => entry.id === id)) return id;
  }

  throw new Error("could not generate a unique evidence id");
}

export default function (pi: ExtensionAPI) {
  let activeSessionId: string | undefined;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    activeSessionId = ctx.sessionManager.getSessionId();
    rebuildStore(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    activeSessionId = ctx.sessionManager.getSessionId();
    rebuildStore(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    resetSessionStore(sessionId);
    if (activeSessionId === sessionId) activeSessionId = undefined;
  });

  pi.on("session_compact", async (_event, ctx) => {
    const store = bucket(ctx);
    if (store.length === 0) return;

    if (ctx.hasUI) {
      ctx.ui.notify(
        `evidence: ${store.length} entr${store.length === 1 ? "y" : "ies"} preserved across compaction`,
        "info",
      );
    }
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  pi.registerEntryRenderer<EvidenceDisplayEntry>(COMMAND_CUSTOM_TYPE, (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data || data.version !== COMMAND_ENTRY_VERSION || typeof data.content !== "string") {
      return new Text(theme.fg("error", "[evidence] invalid display entry"), 0, 0);
    }

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const title = data.kind === "error"
      ? theme.fg("error", "[evidence]")
      : theme.fg("accent", "[evidence]");
    let content = `${title}\n${theme.fg(data.kind === "error" ? "error" : "muted", data.content)}`;
    if (expanded) content += `\n${theme.fg("dim", new Date(data.createdAt).toLocaleString())}`;
    box.addChild(new Text(content, 0, 0));
    return box;
  });

  const showEvidenceEntry = (content: string, kind: EvidenceDisplayKind) => {
    pi.appendEntry(COMMAND_CUSTOM_TYPE, {
      version: COMMAND_ENTRY_VERSION,
      kind,
      content,
      createdAt: Date.now(),
    } satisfies EvidenceDisplayEntry);
  };

  const evidenceCommand = {
    description: "Show TUI-only evidence proof by ID or browse paginated evidence.",
    getArgumentCompletions: (prefix: string) => {
      const rawPrefix = (prefix ?? "").trim();
      const pageMatch = rawPrefix.match(/^page\s+(.*)$/i);
      const normalizedPrefix = normalizeEvidenceId(pageMatch?.[1] ?? rawPrefix);
      const entries = [...getSessionStore(activeSessionId ?? "")].reverse();
      const items = entries
        .map((entry) => ({
          value: pageMatch ? `page ${entry.id}` : entry.id,
          label: entry.id,
          description: pageMatch ? `Show entries older than: ${entry.note}` : entry.note,
        }))
        .filter((item) => normalizeEvidenceId(item.label).startsWith(normalizedPrefix));

      if (!rawPrefix || "page".startsWith(rawPrefix.toLowerCase())) {
        items.unshift({ value: "page ", label: "page", description: "Show an older evidence page by cursor." });
      }
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const store = bucket(ctx);
      const raw = (args ?? "").trim();

      if (!raw) {
        showEvidenceEntry(
          `Usage: /proof <evidence_id> or /evidence page <before_id> [limit]\n\n${formatEvidencePage(listEvidencePage(store))}`,
          "list",
        );
        return;
      }

      const pageMatch = raw.match(/^page\s+(\S+)(?:\s+(\S+))?$/i);
      if (pageMatch) {
        const limit = pageMatch[2] === undefined ? undefined : Number(pageMatch[2]);
        try {
          showEvidenceEntry(formatEvidencePage(listEvidencePage(store, {
            beforeId: pageMatch[1],
            limit,
          })), "list");
        } catch (error) {
          showEvidenceEntry(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      if (/^page(?:\s|$)/i.test(raw)) {
        showEvidenceEntry("Usage: /evidence page <before_id> [limit]", "usage");
        return;
      }

      const id = normalizeEvidenceId(raw);
      const entry = store.find((item) => item.id === id);
      if (!entry) {
        showEvidenceEntry(
          `evidence id '${id}' not found\n\nRun /evidence with no arguments to list recent evidence IDs.`,
          "error",
        );
        return;
      }

      showEvidenceEntry(formatEvidenceEntry(entry), "proof");
    },
  };

  pi.registerCommand("proof", evidenceCommand);
  pi.registerCommand("evidence", evidenceCommand);

  // ── Tools ─────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "EvidenceAdd",
    label: "EvidenceAdd",
    description:
      "Save an exact evidence snippet with its source and a one-line claim note. " +
      `Snippets above ${SNIPPET_CAP} characters are rejected rather than altered.`,
    parameters: Type.Object({
      source: Type.String({
        description: "Single-line URL or source identifier",
        minLength: 1,
        maxLength: SOURCE_CAP,
        pattern: "^[^\\r\\n\\t]+$",
      }),
      note: Type.String({
        description: "Single-line claim-shaped summary",
        minLength: 1,
        maxLength: NOTE_CAP,
        pattern: "^[^\\r\\n\\t]+$",
      }),
      snippet: Type.String({
        description: `Exact citable span (at most ${SNIPPET_CAP} characters)`,
        minLength: 1,
        maxLength: SNIPPET_CAP,
      }),
    }),
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      const validated = validateNewEvidence(input);
      const store = bucket(ctx);
      const duplicate = findEvidenceDuplicate(store, validated.source, validated.snippet);
      if (duplicate) {
        return {
          content: [{ type: "text", text: `existing ${duplicate.id}: ${duplicate.note}` }],
          details: { id: duplicate.id, duplicate: true },
        };
      }

      const entry: EvidenceEntry = {
        id: generateEvidenceId(store),
        ...validated,
        createdAt: Date.now(),
      };
      store.push(entry);
      appendEvidenceEntry(pi, entry);

      return {
        content: [{ type: "text", text: `stored ${entry.id}: ${entry.note}` }],
        details: { id: entry.id, duplicate: false },
      };
    },
  });

  pi.registerTool({
    name: "EvidenceGet",
    label: "EvidenceGet",
    description: "Retrieve a previously-saved evidence entry by its ID.",
    parameters: Type.Object({
      id: Type.String({ description: "Evidence ID returned by EvidenceAdd or EvidenceList" }),
    }),
    async execute(_toolCallId, { id }, _signal, _onUpdate, ctx) {
      const eid = normalizeEvidenceId(id);
      if (!eid) throw new Error("id is required");

      const entry = bucket(ctx).find((x) => x.id === eid);
      if (!entry) throw new Error(`evidence id '${eid}' not found`);

      return {
        content: [{
          type: "text",
          text: formatEvidenceEntry(entry),
        }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "EvidenceVerify",
    label: "EvidenceVerify",
    description:
      "Retrieve the full source, note, and exact snippet for every evidence ID cited in a final answer. " +
      "Fails if any ID is missing so claim support can be checked before responding.",
    parameters: Type.Object({
      ids: Type.Array(Type.String({
        description: "Evidence ID, optionally wrapped in brackets or parentheses",
        minLength: 1,
      }), {
        description: `One to ${MAX_VERIFY_IDS} cited evidence IDs`,
        minItems: 1,
        maxItems: MAX_VERIFY_IDS,
      }),
    }),
    async execute(_toolCallId, { ids }, _signal, _onUpdate, ctx) {
      const entries = selectEvidenceForVerification(bucket(ctx), ids);
      return {
        content: [{
          type: "text",
          text: entries.map(formatEvidenceEntry).join("\n\n---\n\n"),
        }],
        details: { ids: entries.map((entry) => entry.id), count: entries.length },
      };
    },
  });

  pi.registerTool({
    name: "EvidenceList",
    label: "EvidenceList",
    description:
      `List evidence newest-first in cursor pages (default ${DEFAULT_LIST_LIMIT}, maximum ${MAX_LIST_LIMIT}). ` +
      "Use nextBeforeId as beforeId to retrieve the next older page.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({
        description: `Page size from 1 to ${MAX_LIST_LIMIT}`,
        minimum: 1,
        maximum: MAX_LIST_LIMIT,
      })),
      beforeId: Type.Optional(Type.String({
        description: "Exclusive cursor from a previous page's nextBeforeId",
        minLength: 1,
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const page = listEvidencePage(bucket(ctx), params);
      return {
        content: [{ type: "text", text: formatEvidencePage(page) }],
        details: {
          total: page.total,
          count: page.entries.length,
          nextBeforeId: page.nextBeforeId,
        },
      };
    },
  });
}
