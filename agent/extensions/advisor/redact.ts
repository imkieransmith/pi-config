/**
 * Small, local redactor for advisor errors and debug logs.
 *
 * Keep this inside the advisor directory. Some hosts copy directory extensions as
 * isolated units, so the advisor must not import a sibling extension.
 */

interface SecretPattern {
	name: string;
	pattern: RegExp;
}

interface RedactionResult {
	redacted: string;
	count: number;
}

const SECRET_PATTERNS: SecretPattern[] = [
	{ name: "AWS Access Key", pattern: /AKIA[A-Z0-9]{16}/g },
	{ name: "AWS Temp Access Key", pattern: /ASIA[A-Z0-9]{16}/g },
	{
		name: "AWS Secret Key",
		pattern: /\b(?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key|secret_access_key|SecretAccessKey)\b\s*[:=]\s*["']?[A-Za-z0-9/+=]{40,}["']?/g,
	},
	{ name: "Bearer Token", pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/g },
	{ name: "OpenAI/Anthropic API Key", pattern: /sk-[a-zA-Z0-9._-]{20,}/g },
	{ name: "Stripe Live Key", pattern: /sk_live_[a-zA-Z0-9]{20,}/g },
	{ name: "Stripe Test Key", pattern: /sk_test_[a-zA-Z0-9]{20,}/g },
	{
		name: "Hetzner Token",
		pattern: /(?:HCLOUD_TOKEN|hcloud_token|token)\s*[:=]\s*["']?[a-f0-9]{64}\b/g,
	},
	{
		name: "Private Key",
		pattern: /-----BEGIN\s+[\w\s]*PRIVATE\s+KEY-----[\s\S]*?-----END\s+[\w\s]*PRIVATE\s+KEY-----/g,
	},
	{
		name: "Connection String with Password",
		pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^:\s/?#]+:[^@\s/?#]+@/gi,
	},
	{
		name: "Generic Password Field",
		pattern: /\b(?:[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY)|password|passwd|secret|token|api[_-]?key)\b["']?[ \t]*[:=][ \t]*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z0-9._:/+=@!-]{8,})/gi,
	},
	{
		name: "Generic Secret Phrase",
		pattern: /\b(?:password|passwd|secret|token|api[_-]?key)\b\s+(?:is|was|seen|value|header)\s+["']?[A-Za-z0-9._:/+=@!-]{12,}["']?/gi,
	},
	{ name: "Tavily API Key", pattern: /tvly-[a-zA-Z0-9_-]{20,}/g },
	{ name: "Kagi API Key", pattern: /\bkagi\b[^\n]{0,40}?[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/gi },
	{ name: "Brave API Key", pattern: /BSA[A-Z0-9]{20,}/g },
	{ name: "Firecrawl API Key", pattern: /fc-[a-f0-9]{32}/g },
	{ name: "GitHub Token", pattern: /gh[pousr]_[a-zA-Z0-9]{36,}/g },
	{ name: "GitHub Fine-grained PAT", pattern: /github_pat_[a-zA-Z0-9_]{20,}/g },
];

export function redact_text(text: string): RedactionResult {
	let count = 0;
	let redacted = text;

	for (const secret of SECRET_PATTERNS) {
		secret.pattern.lastIndex = 0;
		redacted = redacted.replace(secret.pattern, () => {
			count += 1;
			return `[REDACTED:${secret.name}]`;
		});
	}

	return { redacted, count };
}

export function redact_value(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
	if (typeof value === "string") return redact_text(value).redacted;
	if (!value || typeof value !== "object") return value;
	if ((value as { type?: unknown }).type === "image") return value;
	if (seen.has(value)) return seen.get(value);

	if (Array.isArray(value)) {
		const output: unknown[] = [];
		seen.set(value, output);
		for (const child of value) output.push(redact_value(child, seen));
		return output;
	}

	const output: Record<string, unknown> = {};
	seen.set(value, output);
	for (const [key, child] of Object.entries(value)) {
		output[key] = /^(?:password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(key) && typeof child === "string"
			? "[REDACTED:Secret field]"
			: redact_value(child, seen);
	}
	return output;
}
