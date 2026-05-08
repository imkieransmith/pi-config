/**
 * Evidence extension — durable store + compaction bridge.
 *
 * Provides three tools for the model to save citable evidence during a session:
 *   EvidenceAdd   – store a snippet with source + one-line note
 *   EvidenceGet   – retrieve a single entry by ID
 *   EvidenceList  – list all entries (ID, source, note)
 *
 * Evidence entries are appended as custom session entries and hydrated from the
 * active branch, so they survive /reload and session resume just like ordinary
 * session history.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomBytes } from "node:crypto";

const SNIPPET_CAP = 1024;
const COMMAND_CUSTOM_TYPE = "evidence-proof";
const STATE_CUSTOM_TYPE = "evidence-state";
const STATE_VERSION = 1;

interface EvidenceEntry {
  id: string;
  source: string;
  note: string;
  snippet: string;
  createdAt: number;
}

type EvidenceStateEvent = {
  version: 1;
  type: "add";
  entry: EvidenceEntry;
};

type EvidenceContext = ExtensionCommandContext | ExtensionContext;

// Keyed by Pi session ID so concurrent sessions don't bleed into each other.
const stores = new Map<string, EvidenceEntry[]>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEvidenceEntry(value: unknown): value is EvidenceEntry {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.source === "string" &&
    typeof value.note === "string" &&
    typeof value.snippet === "string" &&
    typeof value.createdAt === "number";
}

function isEvidenceStateEntry(entry: SessionEntry): boolean {
  return entry.type === "custom" && entry.customType === STATE_CUSTOM_TYPE;
}

function getStateEvent(entry: SessionEntry): EvidenceStateEvent | undefined {
  if (!isEvidenceStateEntry(entry)) return undefined;
  const data = entry.data;
  if (!isRecord(data) || data.version !== STATE_VERSION || data.type !== "add" || !isEvidenceEntry(data.entry)) {
    return undefined;
  }

  return data as EvidenceStateEvent;
}

function hydrateStore(entries: SessionEntry[]): EvidenceEntry[] {
  const hydrated: EvidenceEntry[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const event = getStateEvent(entry);
    if (!event || seen.has(event.entry.id)) continue;
    hydrated.push(event.entry);
    seen.add(event.entry.id);
  }

  return hydrated;
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

function formatEvidenceLine(entry: EvidenceEntry): string {
  return `${entry.id}\t${entry.source}\t${entry.note}`;
}

function formatEvidenceEntry(entry: EvidenceEntry): string {
  return `${formatEvidenceLine(entry)}\nsnippet:\n${entry.snippet}`;
}

function formatEvidenceList(store: EvidenceEntry[]): string {
  if (store.length === 0) return "(no evidence stored yet)";
  return store.map(formatEvidenceLine).join("\n");
}

function normalizeEvidenceId(raw: string): string {
  const trimmed = raw.trim();
  const bracketed = trimmed.match(/^\[([^\]]+)\]$/);
  if (bracketed) return bracketed[1].trim();

  const parenthesized = trimmed.match(/^\(([^)]+)\)$/);
  if (parenthesized) return parenthesized[1].trim();

  return trimmed;
}

function generateEvidenceId(store: EvidenceEntry[]): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = "e" + randomBytes(3).toString("hex");
    if (!store.some((entry) => entry.id === id)) return id;
  }

  throw new Error("could not generate a unique evidence id");
}

const BRIDGE = (n: number): string =>
  `[Preserved evidence from earlier in the conversation follows.] ` +
  `${n} evidence entr${n === 1 ? "y remains" : "ies remain"} available via ` +
  `EvidenceList, EvidenceGet, /proof, and /evidence.`;

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

    // sendUserMessage may not exist in all Pi versions; degrade gracefully.
    pi.sendUserMessage?.(BRIDGE(store.length), { deliverAs: "followUp" });
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  const showEvidenceMessage = (content: string) => {
    pi.sendMessage({
      customType: COMMAND_CUSTOM_TYPE,
      content,
      display: true,
      details: {},
    }, { triggerTurn: false });
  };

  const evidenceCommand = {
    description: "Show a saved evidence entry by ID.",
    getArgumentCompletions: (prefix: string) => {
      const normalizedPrefix = normalizeEvidenceId(prefix ?? "");
      const items = getSessionStore(activeSessionId ?? "")
        .map((entry) => ({
          value: entry.id,
          label: entry.id,
          description: entry.note,
        }))
        .filter((item) => item.value.startsWith(normalizedPrefix));

      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const store = bucket(ctx);
      const id = normalizeEvidenceId(args ?? "");

      if (!id) {
        showEvidenceMessage(
          `Usage: /proof <evidence_id> or /evidence <evidence_id>\n\n${formatEvidenceList(store)}`,
        );
        return;
      }

      const entry = store.find((item) => item.id === id);
      if (!entry) {
        showEvidenceMessage(
          `evidence id '${id}' not found\n\nRun /evidence with no arguments to list stored evidence IDs.`,
        );
        return;
      }

      showEvidenceMessage(formatEvidenceEntry(entry));
    },
  };

  pi.registerCommand("proof", evidenceCommand);
  pi.registerCommand("evidence", evidenceCommand);

  // ── Tools ─────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "EvidenceAdd",
    label: "EvidenceAdd",
    description:
      "Save a short evidence snippet with its source and a one-line note. " +
      "Use for any fact you will cite in your final answer. Snippet is capped at 1 KB.",
    parameters: Type.Object({
      source: Type.String({ description: "URL or identifier of the origin" }),
      note: Type.String({ description: "One-line summary for later recall" }),
      snippet: Type.String({ description: "The exact citable span (≤1 KB)" }),
    }),
    async execute(_toolCallId, { source, note, snippet }, _signal, _onUpdate, ctx) {
      const src = (source ?? "").trim();
      const n = (note ?? "").trim();
      let sn = (snippet ?? "").trim();

      if (!src) throw new Error("source is required (URL or identifier)");
      if (!n) throw new Error("note is required (one-line summary)");
      if (!sn) throw new Error("snippet is required");

      if (sn.length > SNIPPET_CAP) {
        sn = sn.slice(0, SNIPPET_CAP) + `\n[... truncated at ${SNIPPET_CAP} chars ...]`;
      }

      const store = bucket(ctx);
      const entry: EvidenceEntry = {
        id: generateEvidenceId(store),
        source: src,
        note: n,
        snippet: sn,
        createdAt: Date.now(),
      };
      store.push(entry);
      appendEvidenceEntry(pi, entry);

      return { content: [{ type: "text", text: `stored ${entry.id}: ${n}` }], details: {} };
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
      const eid = (id ?? "").trim();
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
    name: "EvidenceList",
    label: "EvidenceList",
    description: "List all evidence entries in this session: ID, source, one-line note.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const b = bucket(ctx);
      return { content: [{ type: "text", text: formatEvidenceList(b) }], details: {} };
    },
  });
}
