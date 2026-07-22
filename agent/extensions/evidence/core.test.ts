import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  NOTE_CAP,
  SNIPPET_CAP,
  SOURCE_CAP,
  findEvidenceDuplicate,
  formatEvidenceLine,
  hydrateEvidence,
  listEvidencePage,
  normalizeEvidenceId,
  selectEvidenceForVerification,
  validateNewEvidence,
  type EvidenceEntry,
} from "./core.ts";

function evidence(id: string, overrides: Partial<EvidenceEntry> = {}): EvidenceEntry {
  return {
    id,
    source: `https://example.test/${id}`,
    note: `Claim ${id}`,
    snippet: `Exact snippet ${id}`,
    createdAt: Number(id.replace(/\D/g, "")) || 1,
    ...overrides,
  };
}

function state(entry: EvidenceEntry) {
  return {
    type: "custom",
    customType: "evidence-state",
    data: { version: 1, type: "add", entry },
  };
}

test("hydrates V1 evidence from only the supplied branch path", () => {
  const first = evidence("e000001");
  const otherBranch = evidence("e000002");
  const legacyOversized = evidence("e000003", { snippet: "x".repeat(SNIPPET_CAP + 50) });

  assert.deepEqual(hydrateEvidence([state(first), state(legacyOversized)]), [first, legacyOversized]);
  assert.deepEqual(hydrateEvidence([state(otherBranch)]), [otherBranch]);
});

test("keeps the first V1 event when duplicate IDs exist", () => {
  const first = evidence("e000001");
  const duplicateId = evidence("e000001", { note: "Later duplicate" });
  assert.deepEqual(hydrateEvidence([state(first), state(duplicateId)]), [first]);
});

test("normalizes plain, bracketed, and parenthesized evidence IDs", () => {
  assert.equal(normalizeEvidenceId(" eabc123 "), "eabc123");
  assert.equal(normalizeEvidenceId("[eabc123]"), "eabc123");
  assert.equal(normalizeEvidenceId("(eabc123)"), "eabc123");
});

test("validates and trims new evidence without altering internal snippet text", () => {
  assert.deepEqual(validateNewEvidence({
    source: " https://example.test/source ",
    note: " Supported claim ",
    snippet: "  first line\nsecond line  ",
  }), {
    source: "https://example.test/source",
    note: "Supported claim",
    snippet: "first line\nsecond line",
  });
});

test("rejects malformed and oversized new evidence", () => {
  assert.throws(() => validateNewEvidence({ source: "", note: "claim", snippet: "text" }), /source is required/);
  assert.throws(() => validateNewEvidence({ source: "url\nnext", note: "claim", snippet: "text" }), /single line/);
  assert.throws(() => validateNewEvidence({ source: "url", note: "claim\tother", snippet: "text" }), /single line/);
  assert.throws(() => validateNewEvidence({ source: "s".repeat(SOURCE_CAP + 1), note: "claim", snippet: "text" }), /source must be/);
  assert.throws(() => validateNewEvidence({ source: "url", note: "n".repeat(NOTE_CAP + 1), snippet: "text" }), /note must be/);
  assert.throws(() => validateNewEvidence({ source: "url", note: "claim", snippet: "x".repeat(SNIPPET_CAP + 1) }), /smaller exact span/);
});

test("finds exact source and snippet duplicates regardless of note", () => {
  const existing = evidence("e000001", { source: "source", snippet: "span", note: "first claim" });
  assert.equal(findEvidenceDuplicate([existing], "source", "span"), existing);
  assert.equal(findEvidenceDuplicate([existing], "source", "different"), undefined);
});

test("escapes legacy tabs and newlines in compact list fields", () => {
  const legacy = evidence("e000001", { source: "source\nline", note: "claim\tother" });
  assert.equal(formatEvidenceLine(legacy), "e000001\tsource\\nline\tclaim\\tother");
});

test("paginates newest-first with an exclusive cursor", () => {
  const store = [evidence("e000001"), evidence("e000002"), evidence("e000003"), evidence("e000004")];
  const first = listEvidencePage(store, { limit: 2 });
  assert.deepEqual(first.entries.map((entry) => entry.id), ["e000004", "e000003"]);
  assert.equal(first.nextBeforeId, "e000003");
  assert.equal(first.total, 4);

  const second = listEvidencePage(store, { limit: 2, beforeId: first.nextBeforeId });
  assert.deepEqual(second.entries.map((entry) => entry.id), ["e000002", "e000001"]);
  assert.equal(second.nextBeforeId, undefined);
});

test("uses a bounded default page and rejects invalid limits and cursors", () => {
  const store = Array.from({ length: DEFAULT_LIST_LIMIT + 2 }, (_, index) => evidence(`e${String(index).padStart(6, "0")}`));
  assert.equal(listEvidencePage(store).entries.length, DEFAULT_LIST_LIMIT);
  assert.throws(() => listEvidencePage(store, { limit: 0 }), /limit must be/);
  assert.throws(() => listEvidencePage(store, { limit: MAX_LIST_LIMIT + 1 }), /limit must be/);
  assert.throws(() => listEvidencePage(store, { beforeId: "emissing" }), /cursor 'emissing' not found/);
});

test("selects unique verification entries in requested order", () => {
  const first = evidence("e000001");
  const second = evidence("e000002");
  const selected = selectEvidenceForVerification([first, second], ["(e000002)", "e000001", "e000002"]);
  assert.deepEqual(selected, [second, first]);
  assert.throws(() => selectEvidenceForVerification([first], ["emissing"]), /not found: emissing/);
  assert.throws(() => selectEvidenceForVerification([first], []), /at least one/);
});
