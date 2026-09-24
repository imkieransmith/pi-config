import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { redact_text, redact_value } from "./redact.ts";

const extensionDir = dirname(fileURLToPath(import.meta.url));

test("advisor runtime imports stay inside its directory package", async () => {
	for (const name of ["index.ts", "engine.ts", "brief.ts", "redact.ts", "row.ts"]) {
		const source = await readFile(resolve(extensionDir, name), "utf8");
		for (const match of source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
			const target = resolve(extensionDir, dirname(name), match[1]);
			assert.ok(!relative(extensionDir, target).startsWith(".."), `${name} imports outside the advisor directory: ${match[1]}`);
			await access(target);
		}
	}
});

test("advisor local redactor removes secrets from text and nested fields", () => {
	const text = redact_text("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456").redacted;
	assert.doesNotMatch(text, /abcdefghijklmnopqrstuvwxyz123456/);

	const value = redact_value({ apiKey: "synthetic-secret", nested: { token: "another-secret" } });
	assert.doesNotMatch(JSON.stringify(value), /synthetic-secret|another-secret/);
});
