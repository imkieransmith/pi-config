export const SNAPSHOT_APPENDIX_START = '<context-snapshot-appendix version="1">';
export const SNAPSHOT_APPENDIX_END = "</context-snapshot-appendix>";
export const LEGACY_SNAPSHOT_APPENDIX_HEADING = "## Recent ContextSnapshot Summaries";
export const LEGACY_SNAPSHOT_APPENDIX_INTRO =
  "These recent durable summaries retain high-detail working context across compaction.";
export const SNAPSHOT_APPENDIX_TARGET = 15_000;
export const MIN_APPENDIX_SUMMARIES = 3;

export interface SnapshotAppendixSummary {
  id: string;
  label: string;
  summary: string;
  hadChanges: boolean;
  createdAt: number;
}

function escapeProtocolDelimiters(text: string): string {
  return text
    .replaceAll(SNAPSHOT_APPENDIX_START, "&lt;context-snapshot-appendix version=\"1\"&gt;")
    .replaceAll(SNAPSHOT_APPENDIX_END, "&lt;/context-snapshot-appendix&gt;");
}

function formatAppendixSummary(summary: SnapshotAppendixSummary): string {
  return [
    `### ${summary.id}: ${escapeProtocolDelimiters(summary.label)}`,
    `captured: ${new Date(summary.createdAt).toISOString()}`,
    summary.hadChanges
      ? "status: finished after changes were observed"
      : "status: finished with no changes observed",
    "",
    escapeProtocolDelimiters(summary.summary),
  ].join("\n");
}

export function renderSnapshotAppendix(summaries: readonly SnapshotAppendixSummary[]): string {
  return [
    SNAPSHOT_APPENDIX_START,
    LEGACY_SNAPSHOT_APPENDIX_HEADING,
    "These durable captures are ordered oldest to newest.",
    "When entries conflict, later entries supersede earlier entries; use the newest applicable entry as current state.",
    "",
    ...summaries.map(formatAppendixSummary),
    SNAPSHOT_APPENDIX_END,
  ].join("\n\n");
}

export function snapshotAppendix(
  summaries: readonly SnapshotAppendixSummary[],
  target = SNAPSHOT_APPENDIX_TARGET,
  minimum = MIN_APPENDIX_SUMMARIES,
): string | undefined {
  if (summaries.length === 0) return undefined;

  const selectedNewestFirst: SnapshotAppendixSummary[] = [];
  for (let index = summaries.length - 1; index >= 0; index -= 1) {
    const candidateNewestFirst = [...selectedNewestFirst, summaries[index]];
    const candidate = renderSnapshotAppendix([...candidateNewestFirst].reverse());
    if (selectedNewestFirst.length < minimum || candidate.length <= target) {
      selectedNewestFirst.push(summaries[index]);
      continue;
    }
    break;
  }

  return renderSnapshotAppendix([...selectedNewestFirst].reverse());
}

function stripMarkedTerminalAppendix(summary: string): string | undefined {
  const withoutTrailingWhitespace = summary.trimEnd();
  if (!withoutTrailingWhitespace.endsWith(SNAPSHOT_APPENDIX_END)) return undefined;

  const endIndex = withoutTrailingWhitespace.lastIndexOf(SNAPSHOT_APPENDIX_END);
  const startIndex = withoutTrailingWhitespace.lastIndexOf(SNAPSHOT_APPENDIX_START, endIndex);
  if (startIndex < 0) return undefined;

  return withoutTrailingWhitespace.slice(0, startIndex).trimEnd();
}

function stripLegacyTerminalAppendix(summary: string): string | undefined {
  const legacyPrefix = `${LEGACY_SNAPSHOT_APPENDIX_HEADING}\n\n${LEGACY_SNAPSHOT_APPENDIX_INTRO}`;
  const startIndex = summary.lastIndexOf(legacyPrefix);
  if (startIndex < 0) return undefined;

  const startsAtLineBoundary = startIndex === 0 || summary[startIndex - 1] === "\n";
  const candidate = summary.slice(startIndex);
  const containsSnapshot = /(?:^|\n)### s[0-9a-f]+:\s*[^\n]+/i.test(candidate);
  if (!startsAtLineBoundary || !containsSnapshot) return undefined;

  return summary.slice(0, startIndex).trimEnd();
}

export function stripTerminalSnapshotAppendix(previousSummary: string | undefined): string | undefined {
  if (previousSummary === undefined) return undefined;

  const marked = stripMarkedTerminalAppendix(previousSummary);
  if (marked !== undefined) return marked;

  const legacy = stripLegacyTerminalAppendix(previousSummary);
  return legacy ?? previousSummary;
}
