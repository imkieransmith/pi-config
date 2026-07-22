export const SNIPPET_CAP = 1_024;
export const SOURCE_CAP = 2_048;
export const NOTE_CAP = 240;
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 50;
export const MAX_VERIFY_IDS = 20;
export const STATE_CUSTOM_TYPE = "evidence-state";
export const STATE_VERSION = 1;

export interface EvidenceEntry {
  id: string;
  source: string;
  note: string;
  snippet: string;
  createdAt: number;
}

export type EvidenceStateEvent = {
  version: 1;
  type: "add";
  entry: EvidenceEntry;
};

export interface NewEvidenceInput {
  source: unknown;
  note: unknown;
  snippet: unknown;
}

export interface EvidencePage {
  entries: EvidenceEntry[];
  total: number;
  limit: number;
  beforeId?: string;
  nextBeforeId?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isEvidenceEntry(value: unknown): value is EvidenceEntry {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.source === "string" &&
    typeof value.note === "string" &&
    typeof value.snippet === "string" &&
    typeof value.createdAt === "number";
}

export function getStateEvent(entry: unknown): EvidenceStateEvent | undefined {
  if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== STATE_CUSTOM_TYPE) {
    return undefined;
  }

  const data = entry.data;
  if (!isRecord(data) || data.version !== STATE_VERSION || data.type !== "add" || !isEvidenceEntry(data.entry)) {
    return undefined;
  }

  return data as unknown as EvidenceStateEvent;
}

export function hydrateEvidence(entries: readonly unknown[]): EvidenceEntry[] {
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

export function normalizeEvidenceId(raw: unknown): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  const bracketed = trimmed.match(/^\[([^\]]+)\]$/);
  if (bracketed) return bracketed[1].trim();

  const parenthesized = trimmed.match(/^\(([^)]+)\)$/);
  if (parenthesized) return parenthesized[1].trim();

  return trimmed;
}

function validateSingleLine(value: unknown, field: string, cap: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${field} is required`);
  if (normalized.length > cap) throw new Error(`${field} must be at most ${cap} characters`);
  if (/[\r\n\t]/.test(normalized)) throw new Error(`${field} must be a single line without tabs`);
  return normalized;
}

export function validateNewEvidence(input: NewEvidenceInput): Omit<EvidenceEntry, "id" | "createdAt"> {
  const source = validateSingleLine(input.source, "source", SOURCE_CAP);
  const note = validateSingleLine(input.note, "note", NOTE_CAP);
  const snippet = typeof input.snippet === "string" ? input.snippet.trim() : "";

  if (!snippet) throw new Error("snippet is required");
  if (snippet.length > SNIPPET_CAP) {
    throw new Error(`snippet must be at most ${SNIPPET_CAP} characters; select a smaller exact span`);
  }

  return { source, note, snippet };
}

export function findEvidenceDuplicate(
  store: readonly EvidenceEntry[],
  source: string,
  snippet: string,
): EvidenceEntry | undefined {
  return store.find((entry) => entry.source === source && entry.snippet === snippet);
}

function normalizeListLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return DEFAULT_LIST_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
  }
  return limit;
}

export function listEvidencePage(
  store: readonly EvidenceEntry[],
  options: { limit?: unknown; beforeId?: unknown } = {},
): EvidencePage {
  const limit = normalizeListLimit(options.limit);
  const beforeId = normalizeEvidenceId(options.beforeId);
  const newest = [...store].reverse();
  let start = 0;

  if (beforeId) {
    const cursorIndex = newest.findIndex((entry) => entry.id === beforeId);
    if (cursorIndex === -1) throw new Error(`evidence cursor '${beforeId}' not found`);
    start = cursorIndex + 1;
  }

  const entries = newest.slice(start, start + limit);
  const hasMore = start + entries.length < newest.length;
  const nextBeforeId = hasMore && entries.length > 0 ? entries[entries.length - 1].id : undefined;

  return {
    entries,
    total: store.length,
    limit,
    ...(beforeId ? { beforeId } : {}),
    ...(nextBeforeId ? { nextBeforeId } : {}),
  };
}

export function selectEvidenceForVerification(
  store: readonly EvidenceEntry[],
  rawIds: readonly unknown[],
): EvidenceEntry[] {
  const ids = [...new Set(rawIds.map(normalizeEvidenceId).filter(Boolean))];
  if (ids.length === 0) throw new Error("at least one evidence id is required");
  if (ids.length > MAX_VERIFY_IDS) throw new Error(`at most ${MAX_VERIFY_IDS} evidence ids can be verified at once`);

  const byId = new Map(store.map((entry) => [entry.id, entry]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`evidence id${missing.length === 1 ? "" : "s"} not found: ${missing.join(", ")}`);

  return ids.map((id) => byId.get(id)!);
}

function formatCompactField(value: string): string {
  return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

export function formatEvidenceLine(entry: EvidenceEntry): string {
  return `${formatCompactField(entry.id)}\t${formatCompactField(entry.source)}\t${formatCompactField(entry.note)}`;
}

export function formatEvidenceEntry(entry: EvidenceEntry): string {
  return `${formatEvidenceLine(entry)}\nsnippet:\n${entry.snippet}`;
}
