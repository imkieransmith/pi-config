export type ModelFamily = "claude" | "gpt" | "other";
export type CapabilityTier = "frontier" | "strong" | "standard";
export type AdvisorUsageMode = "exceptional" | "gated" | "routine";

export interface ModelIdentity {
	provider: string;
	id: string;
	name?: string;
}

/**
 * Ordered advisor candidates by active-model family. Prefer direct subscription
 * providers, then OpenRouter, then a narrow provider-agnostic fallback. Every
 * concrete ID is present in Pi 0.80.6's model catalog; no future names.
 */
export const ADVISOR_DEFAULTS: Record<ModelFamily, readonly string[]> = {
	claude: [
		"openai-codex/gpt-5.6-sol",
		"openai/gpt-5.6-sol",
		"openrouter/openai/gpt-5.6-sol",
		"*/gpt-5.6-sol",
		"openai-codex/gpt-5.5",
		"openrouter/openai/gpt-5.5",
		"*/gpt-5.5",
	],
	gpt: [
		"anthropic/claude-opus-4-8",
		"openrouter/anthropic/claude-opus-4.8",
		"*/claude-opus-4-8",
		"*/claude-opus-4.8",
		"anthropic/claude-fable-5",
		"openrouter/anthropic/claude-fable-5",
		"*/claude-fable-5",
		"anthropic/claude-sonnet-5",
		"openrouter/anthropic/claude-sonnet-5",
		"*/claude-sonnet-5",
	],
	other: [
		"openai-codex/gpt-5.6-sol",
		"openai/gpt-5.6-sol",
		"openrouter/openai/gpt-5.6-sol",
		"*/gpt-5.6-sol",
		"anthropic/claude-opus-4-8",
		"openrouter/anthropic/claude-opus-4.8",
		"*/claude-opus-4-8",
		"*/claude-opus-4.8",
	],
};

const MODEL_FAMILY_MATCHERS: Array<[Exclude<ModelFamily, "other">, readonly string[]]> = [
	["claude", ["anthropic/*", "*/claude-*"]],
	["gpt", ["openai/*", "openai-codex/*", "*/gpt-*", "*gpt-*", "*/o1*", "*/o3*", "*/o4*"]],
];

/**
 * Approved model variants are explicit: GPT `-pro` and Claude `-fast` variants
 * share their base model's tier; Grok 4.5 and GLM 5.2 remain exact by policy.
 */
const FRONTIER_MODELS = ["*/gpt-5.6-sol", "*/gpt-5.6-sol-pro", "*/claude-fable-5"];

/** Models that benefit most at explicit planning, decision, and verification gates. */
const STRONG_MODELS = [
	"*/gpt-5.6-terra",
	"*/gpt-5.6-terra-pro",
	"*/gpt-5.6-luna",
	"*/gpt-5.6-luna-pro",
	"*/gpt-5.5",
	"*/gpt-5.5-pro",
	"*/claude-opus-4-7",
	"*/claude-opus-4.7",
	"*/claude-opus-4.7-fast",
	"*/claude-opus-4-8",
	"*/claude-opus-4.8",
	"*/claude-opus-4.8-fast",
	"*/claude-sonnet-5",
	"*/grok-4.5",
	"*/glm-5.2",
];

export function globToRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

export function matchesAny(value: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => globToRegex(pattern).test(value));
}

export function modelMatchKeys(model: ModelIdentity): string[] {
	return [`${model.provider}/${model.id}`, `${model.provider}/${model.name ?? model.id}`];
}

export function classifyFamily(model: ModelIdentity | undefined): ModelFamily {
	if (!model) return "other";
	const keys = modelMatchKeys(model);
	for (const [family, patterns] of MODEL_FAMILY_MATCHERS) {
		if (keys.some((key) => matchesAny(key, patterns))) return family;
	}
	return "other";
}

export function classifyCapability(model: ModelIdentity | undefined): CapabilityTier {
	if (!model) return "standard";
	const keys = modelMatchKeys(model);
	if (keys.some((key) => matchesAny(key, FRONTIER_MODELS))) return "frontier";
	if (keys.some((key) => matchesAny(key, STRONG_MODELS))) return "strong";
	return "standard";
}

/**
 * Deliberately inverse: stronger active models need less frequent external review.
 * Capability and call frequency remain separate axes so this can evolve safely.
 */
export function advisorUsageForCapability(tier: CapabilityTier): AdvisorUsageMode {
	if (tier === "frontier") return "exceptional";
	if (tier === "strong") return "gated";
	return "routine";
}

export function effortForModel<T>(model: { reasoning?: boolean } | undefined, effort: T): T | undefined {
	return model?.reasoning ? effort : undefined;
}

export function resolveFirstAvailable<T extends ModelIdentity>(models: readonly T[], patterns: readonly string[]): T | undefined {
	for (const pattern of patterns) {
		const match = models.find((model) => modelMatchKeys(model).some((key) => matchesAny(key, [pattern])));
		if (match) return match;
	}
	return undefined;
}

/**
 * Conservative catalog fallback used only after configured candidates fail.
 * `other` is deliberately excluded because it combines unrelated model families.
 */
export function resolveBestCrossFamilyAvailable<T extends ModelIdentity>(
	models: readonly T[],
	activeFamily: ModelFamily,
): T | undefined {
	const capabilityRank: Record<Exclude<CapabilityTier, "standard">, number> = { frontier: 0, strong: 1 };
	return models
		.filter((model) => {
			const family = classifyFamily(model);
			return family !== "other" && family !== activeFamily && classifyCapability(model) !== "standard";
		})
		.slice()
		.sort((a, b) => {
			const aTier = classifyCapability(a) as Exclude<CapabilityTier, "standard">;
			const bTier = classifyCapability(b) as Exclude<CapabilityTier, "standard">;
			const tierDelta = capabilityRank[aTier] - capabilityRank[bTier];
			if (tierDelta !== 0) return tierDelta;
			const providerDelta = Number(a.provider === "openrouter") - Number(b.provider === "openrouter");
			if (providerDelta !== 0) return providerDelta;
			return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
		})[0];
}

