import assert from "node:assert/strict";
import test from "node:test";
import {
	ADVISOR_BRIEF_MAX_CHARS,
	normalizeAdvisorBrief,
	renderAdvisorBrief,
} from "./brief.ts";

test("keeps valid brief text", () => {
	assert.equal(normalizeAdvisorBrief("Check whether this plan handles retries."), "Check whether this plan handles retries.");
});

test("trims surrounding whitespace", () => {
	assert.equal(normalizeAdvisorBrief("  Check this approach.\n"), "Check this approach.");
});

test("rejects a blank brief", () => {
	assert.throws(() => normalizeAdvisorBrief(" \n\t "), /advisor brief is required/);
});

test("accepts the limit and rejects longer text", () => {
	assert.equal(normalizeAdvisorBrief("a".repeat(ADVISOR_BRIEF_MAX_CHARS)).length, ADVISOR_BRIEF_MAX_CHARS);
	assert.throws(
		() => normalizeAdvisorBrief("a".repeat(ADVISOR_BRIEF_MAX_CHARS + 1)),
		/advisor brief must be at most 2,000 characters/,
	);
});

test("renders the normalized brief section", () => {
	assert.equal(renderAdvisorBrief("  Is this plan safe?  "), "## Brief\nIs this plan safe?");
});
