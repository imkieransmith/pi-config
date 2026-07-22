export const ADVISOR_BRIEF_MAX_CHARS = 2_000;

export function normalizeAdvisorBrief(value: string): string {
	const brief = value.trim();
	if (!brief) throw new Error("advisor brief is required");
	if (brief.length > ADVISOR_BRIEF_MAX_CHARS) {
		throw new Error(`advisor brief must be at most ${ADVISOR_BRIEF_MAX_CHARS.toLocaleString()} characters`);
	}
	return brief;
}

export function renderAdvisorBrief(value: string): string {
	return `## Brief\n${normalizeAdvisorBrief(value)}`;
}
