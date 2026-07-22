import assert from "node:assert/strict";
import test from "node:test";
import {
  LEGACY_SNAPSHOT_APPENDIX_HEADING,
  LEGACY_SNAPSHOT_APPENDIX_INTRO,
  SNAPSHOT_APPENDIX_END,
  SNAPSHOT_APPENDIX_START,
  renderSnapshotAppendix,
  snapshotAppendix,
  stripTerminalSnapshotAppendix,
  type SnapshotAppendixSummary,
} from "./appendix.ts";

function summary(
  id: string,
  createdAt: number,
  text = `complete ${id}`,
  hadChanges = true,
): SnapshotAppendixSummary {
  return {
    id,
    label: `capture-${id}`,
    summary: text,
    hadChanges,
    createdAt,
  };
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

test("renders a marked chronological appendix with timestamps, statuses, and precedence guidance", () => {
  const older = summary("s000001", Date.UTC(2026, 0, 1), "older state", false);
  const newer = summary("s000002", Date.UTC(2026, 0, 2), "newer state");
  const rendered = renderSnapshotAppendix([older, newer]);

  assert.ok(rendered.startsWith(SNAPSHOT_APPENDIX_START));
  assert.ok(rendered.endsWith(SNAPSHOT_APPENDIX_END));
  assert.match(rendered, /ordered oldest to newest/i);
  assert.match(rendered, /later entries supersede earlier entries/i);
  assert.match(rendered, /captured: 2026-01-01T00:00:00\.000Z/);
  assert.match(rendered, /status: finished with no changes observed/);
  assert.match(rendered, /status: finished after changes were observed/);
  assert.ok(rendered.indexOf("s000001") < rendered.indexOf("s000002"));
});

test("guarantees the latest three complete summaries even below the soft target", () => {
  const summaries = [
    summary("s000001", 1, "oldest unique body"),
    summary("s000002", 2, "second unique body"),
    summary("s000003", 3, "third unique body"),
    summary("s000004", 4, "newest unique body"),
  ];
  const rendered = snapshotAppendix(summaries, 1, 3);

  assert.ok(rendered);
  assert.doesNotMatch(rendered, /oldest unique body/);
  assert.match(rendered, /second unique body/);
  assert.match(rendered, /third unique body/);
  assert.match(rendered, /newest unique body/);
  assert.ok(rendered.indexOf("s000002") < rendered.indexOf("s000003"));
  assert.ok(rendered.indexOf("s000003") < rendered.indexOf("s000004"));
});

test("adds contiguous older summaries within the target and never splits one", () => {
  const longBody = `BEGIN-${"x".repeat(500)}-END`;
  const summaries = [
    summary("s000001", 1, longBody),
    summary("s000002", 2),
    summary("s000003", 3),
    summary("s000004", 4),
  ];
  const threeNewestLength = renderSnapshotAppendix(summaries.slice(1)).length;
  const rendered = snapshotAppendix(summaries, threeNewestLength, 3);

  assert.ok(rendered);
  assert.doesNotMatch(rendered, /BEGIN-/);
  assert.doesNotMatch(rendered, /-END/);

  const all = snapshotAppendix(summaries, Number.POSITIVE_INFINITY, 3);
  assert.match(all ?? "", new RegExp(longBody));
});

test("escapes delimiter text inside snapshot content so only the outer boundary is machine-readable", () => {
  const quoted = `${SNAPSHOT_APPENDIX_START} discussed with ${SNAPSHOT_APPENDIX_END}`;
  const appendix = renderSnapshotAppendix([summary("s000001", 1, quoted)]);

  assert.equal(occurrences(appendix, SNAPSHOT_APPENDIX_START), 1);
  assert.equal(occurrences(appendix, SNAPSHOT_APPENDIX_END), 1);
  assert.match(appendix, /&lt;context-snapshot-appendix/);
  assert.equal(stripTerminalSnapshotAppendix(`base\n\n${appendix}`), "base");
});

test("strips one complete terminal marked appendix and trailing whitespace", () => {
  const base = "## Goal\nCurrent base summary";
  const appendix = renderSnapshotAppendix([summary("s000001", 1)]);
  assert.equal(stripTerminalSnapshotAppendix(`${base}\n\n${appendix}\n  \n`), base);
});

test("uses the last matching marked start delimiter", () => {
  const baseWithIncompleteMarker = `base\n\n${SNAPSHOT_APPENDIX_START}\nquoted fragment`;
  const appendix = renderSnapshotAppendix([summary("s000001", 1)]);
  assert.equal(
    stripTerminalSnapshotAppendix(`${baseWithIncompleteMarker}\n\n${appendix}`),
    baseWithIncompleteMarker,
  );
});

test("preserves incomplete, non-terminal, absent, and empty marked input", () => {
  const incomplete = `base\n${SNAPSHOT_APPENDIX_START}\ncontent`;
  const nonTerminal = `${renderSnapshotAppendix([summary("s000001", 1)])}\nnot terminal`;

  assert.equal(stripTerminalSnapshotAppendix(incomplete), incomplete);
  assert.equal(stripTerminalSnapshotAppendix(nonTerminal), nonTerminal);
  assert.equal(stripTerminalSnapshotAppendix(undefined), undefined);
  assert.equal(stripTerminalSnapshotAppendix(""), "");
});

test("strips the exact terminal legacy appendix format", () => {
  const base = "## Goal\nLegacy-compatible base";
  const legacy = [
    LEGACY_SNAPSHOT_APPENDIX_HEADING,
    LEGACY_SNAPSHOT_APPENDIX_INTRO,
    "### sabcdef: old-capture",
    "old summary body",
  ].join("\n\n");

  assert.equal(stripTerminalSnapshotAppendix(`${base}\n\n${legacy}`), base);
});

test("preserves quoted or incomplete legacy headings", () => {
  const quoted = `## Critical Context\nThe text '${LEGACY_SNAPSHOT_APPENDIX_HEADING}' may appear in discussion.`;
  const incomplete = `${LEGACY_SNAPSHOT_APPENDIX_HEADING}\n\n${LEGACY_SNAPSHOT_APPENDIX_INTRO}\n\nno snapshot heading`;

  assert.equal(stripTerminalSnapshotAppendix(quoted), quoted);
  assert.equal(stripTerminalSnapshotAppendix(incomplete), incomplete);
});

test("strip and refresh leaves exactly one appendix without obsolete snapshot text", () => {
  const base = "## Goal\nCurrent generated summary";
  const oldAppendix = renderSnapshotAppendix([
    summary("s000001", 1, "obsolete snapshot state"),
  ]);
  const cleaned = stripTerminalSnapshotAppendix(`${base}\n\n${oldAppendix}`);
  const refreshed = `${cleaned}\n\n${renderSnapshotAppendix([
    summary("s000002", 2, "fresh snapshot state"),
  ])}`;

  assert.equal(occurrences(refreshed, SNAPSHOT_APPENDIX_START), 1);
  assert.equal(occurrences(refreshed, SNAPSHOT_APPENDIX_END), 1);
  assert.doesNotMatch(refreshed, /obsolete snapshot state/);
  assert.match(refreshed, /fresh snapshot state/);
  assert.equal(stripTerminalSnapshotAppendix(refreshed), base);
});
