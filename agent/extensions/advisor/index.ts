/**
 * Advisor — consult a reviewer model for one recommended next move.
 *
 * One zero-param tool backed by ./engine.ts. The payload is always the same
 * bounded snapshot. Two things adapt to the ACTIVE model:
 *   1. Which advisor (reviewer) model is used  -> ADVISOR_DEFAULTS (by family).
 *   2. How the tool is described to the model  -> SOTA (in STRONG_MODELS) get a
 *      "use when stuck" description; others get a "use liberally" one. The tool
 *      is re-registered with class-specific text when the SOTA-ness changes.
 *
 * /advisor          - pick the advisor model, choose Auto (smart defaults), or turn off.
 * /advisor status   - show mode, resolved model, classification, call counts.
 * /advisor debug    - show debug log location and last payload sample.
 *
 * Merged from the former `advisor` and `senior-dev` extensions.
 * Advisor original - https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { showAdvisorPicker, showEffortPicker } from "./advisor-ui.js";
import { ADVISOR_TOOL_NAME, debugLogPath, engineStats, modelKey, resetEngineState, runAdvisor } from "./engine.js";

// ===========================================================================
// SMART DEFAULTS — edit here.
// ===========================================================================

type ModelFamily = "claude" | "gpt" | "openSource";

// Which reviewer model advises, based on the family of the ACTIVE model.
// Values are globs matched against your available models ("provider/id" or
// "provider/name"), so they tolerate dated ids (e.g. claude-opus-4-8-2026...).
const ADVISOR_DEFAULTS: Record<ModelFamily, string> = {
	claude: "*/gpt-5.5*", //        Claude active      -> GPT-5.5 advises
	gpt: "*/claude-opus-4-8*", //   GPT active         -> Claude Opus 4.8 advises
	openSource: "*/gpt-5.5*", //    Open-source active -> GPT-5.5 advises
};

// How the active model is sorted into a family. First match wins; order matters.
// Anything matching nothing here falls through to `openSource`.
const MODEL_FAMILY_MATCHERS: Array<[Exclude<ModelFamily, "openSource">, string[]]> = [
	["claude", ["anthropic/*", "*/claude-*", "*claude*"]],
	["gpt", ["openai/*", "openai-codex/*", "*/gpt-*", "*gpt-*", "*/o1*", "*/o3*", "*/o4*"]],
];

// Default reasoning effort used for auto-resolved advisor models.
const DEFAULT_EFFORT: ThinkingLevel = "high";

// SOTA models — these get the "use advisor when stuck" tool description; every
// other model gets the "use it liberally" description. Edit this list to taste.
// (Description axis — independent of the family-based ADVISOR_DEFAULTS above.)
const STRONG_MODELS = [
	"*/gpt-5.5*",
	"*/gpt-5.6*",
	"*/gpt-6*",
	"*/claude-opus-4-7*",
	"*/claude-opus-4.7*",
	"*/claude-opus-4-8*",
	"*/claude-opus-4.8*",
	"*/claude-opus-5*",
	"*/claude-fable-5*",
];

// ===========================================================================

const CONFIG_DIR = join(homedir(), ".config", "rpiv-advisor");
const ADVISOR_CONFIG_PATH = join(CONFIG_DIR, "advisor.json");
const CONFIG_FILE_MODE = 0o600;

const BASE_EFFORT_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high"];
const XHIGH_EFFORT_LEVEL: ThinkingLevel = "xhigh";

const AUTO_VALUE = "__auto__";
const NO_ADVISOR_VALUE = "__no_advisor__";
const OFF_VALUE = "__off__";
const CHECKMARK = " ✓";
const RECOMMENDED_EFFORT_SUFFIX = "  (recommended)";

// ---------------------------------------------------------------------------
// Config persistence. Empty/absent config => auto (smart defaults).
//   { off: true }           => disabled.
//   { modelKey, effort }    => manual override (used for every active model).
// ---------------------------------------------------------------------------

interface AdvisorConfig {
	off?: boolean;
	modelKey?: string;
	effort?: ThinkingLevel;
}

function loadAdvisorConfig(): AdvisorConfig {
	if (!existsSync(ADVISOR_CONFIG_PATH)) return {};
	try {
		return JSON.parse(readFileSync(ADVISOR_CONFIG_PATH, "utf-8")) as AdvisorConfig;
	} catch {
		return {};
	}
}

function saveAdvisorConfig(config: AdvisorConfig): void {
	try {
		mkdirSync(dirname(ADVISOR_CONFIG_PATH), { recursive: true });
		writeFileSync(ADVISOR_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
		chmodSync(ADVISOR_CONFIG_PATH, CONFIG_FILE_MODE);
	} catch {
		// best effort only
	}
}

function parseModelKey(key: string): { provider: string; modelId: string } | undefined {
	const sep = key.indexOf(":") >= 1 ? ":" : key.indexOf("/") >= 1 ? "/" : undefined;
	if (!sep) return undefined;
	const idx = key.indexOf(sep);
	return { provider: key.slice(0, idx), modelId: key.slice(idx + 1) };
}

// ---------------------------------------------------------------------------
// Module state (loaded from config each session)
// ---------------------------------------------------------------------------

let advisorOff = false;
let overrideModelKey: string | undefined;
let overrideEffort: ThinkingLevel | undefined;

function loadStateFromConfig(): void {
	const config = loadAdvisorConfig();
	advisorOff = config.off === true;
	overrideModelKey = config.modelKey;
	overrideEffort = config.effort;
}

// ---------------------------------------------------------------------------
// Glob matching + classification
// ---------------------------------------------------------------------------

function globToRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

function matchesAny(value: string, patterns: string[]): boolean {
	return patterns.some((pattern) => globToRegex(pattern).test(value));
}

function modelMatchKeys(model: { provider: string; id: string; name?: string }): string[] {
	return [`${model.provider}/${model.id}`, `${model.provider}/${model.name ?? model.id}`];
}

function classifyFamily(model: { provider: string; id: string; name?: string } | undefined): ModelFamily {
	if (!model) return "openSource";
	const keys = modelMatchKeys(model);
	for (const [family, patterns] of MODEL_FAMILY_MATCHERS) {
		if (keys.some((key) => matchesAny(key, patterns))) return family;
	}
	return "openSource";
}

function isSota(model: { provider: string; id: string; name?: string } | undefined): boolean {
	// SOTA = the active model matches STRONG_MODELS (curated GPT/Claude list).
	if (!model) return false;
	return modelMatchKeys(model).some((key) => matchesAny(key, STRONG_MODELS));
}

// ---------------------------------------------------------------------------
// Advisor-model resolution
// ---------------------------------------------------------------------------

interface ResolvedAdvisor {
	model?: Model<Api>;
	effort?: ThinkingLevel;
	source: string;
	family: ModelFamily;
}

function resolveByGlob(ctx: ExtensionContext, glob: string): Model<Api> | undefined {
	return ctx.modelRegistry.getAvailable().find((m) => matchesAny(`${m.provider}/${m.id}`, [glob]) || matchesAny(`${m.provider}/${m.name ?? m.id}`, [glob])) as
		| Model<Api>
		| undefined;
}

function findModelByKey(ctx: ExtensionContext, key: string): Model<Api> | undefined {
	const parsed = parseModelKey(key);
	if (parsed) {
		const exact = ctx.modelRegistry.find(parsed.provider, parsed.modelId) as Model<Api> | undefined;
		if (exact) return exact;
	}
	return resolveByGlob(ctx, key.replace(":", "/"));
}

function resolveAdvisor(ctx: ExtensionContext): ResolvedAdvisor {
	const family = classifyFamily(ctx.model);
	if (advisorOff) return { source: "off", family };
	if (overrideModelKey) {
		const model = findModelByKey(ctx, overrideModelKey);
		if (model) return { model, effort: overrideEffort ?? DEFAULT_EFFORT, source: "manual override", family };
	}
	const model = resolveByGlob(ctx, ADVISOR_DEFAULTS[family]);
	return { model, effort: DEFAULT_EFFORT, source: `default (${family})`, family };
}

// ---------------------------------------------------------------------------
// Active-tool + status helpers
// ---------------------------------------------------------------------------

function ensureActive(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	if (!active.includes(ADVISOR_TOOL_NAME)) pi.setActiveTools([...active, ADVISOR_TOOL_NAME]);
}

function ensureInactive(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	if (active.includes(ADVISOR_TOOL_NAME)) pi.setActiveTools(active.filter((name) => name !== ADVISOR_TOOL_NAME));
}

function isActive(pi: ExtensionAPI): boolean {
	return pi.getActiveTools().includes(ADVISOR_TOOL_NAME);
}

function setStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const r = resolveAdvisor(ctx);
	const text = advisorOff
		? "advisor: off"
		: r.model
			? `advisor: ${r.model.provider}:${r.model.id} (${r.family})`
			: `advisor: none for ${r.family}`;
	ctx.ui.setStatus("advisor", text);
}

// ---------------------------------------------------------------------------
// Status / debug text
// ---------------------------------------------------------------------------

function modeLabel(): string {
	if (advisorOff) return "off";
	if (overrideModelKey) return "manual override";
	return "auto (smart defaults)";
}

function statusText(pi: ExtensionAPI, ctx: ExtensionContext): string {
	const stats = engineStats();
	const r = resolveAdvisor(ctx);
	return [
		"advisor status",
		`mode: ${modeLabel()}`,
		`active model: ${modelKey(ctx.model) ?? "(none)"} (family: ${r.family})`,
		`resolved advisor: ${r.model ? `${r.model.provider}:${r.model.id}` : "(none available)"}${r.model ? ` — ${r.source}` : ""}`,
		`effort: ${r.effort ?? "(model default)"}`,
		`role: ${isSota(ctx.model) ? "SOTA — use when stuck" : "non-SOTA — use liberally"}`,
		`tool active: ${isActive(pi)}`,
		"defaults: " + (Object.keys(ADVISOR_DEFAULTS) as ModelFamily[]).map((f) => `${f}→${ADVISOR_DEFAULTS[f]}`).join(", "),
		`calls this session: ${stats.attemptedCalls} attempted, ${stats.successfulCalls} successful`,
		`debug log: ${debugLogPath()}`,
		stats.lastError ? `last error: ${stats.lastError}` : undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function debugText(): string {
	const stats = engineStats();
	return [
		"advisor debug",
		`debug log: ${debugLogPath()}`,
		stats.lastPayloadSamplePath ? `last payload sample: ${stats.lastPayloadSamplePath}` : "last payload sample: (none yet this session)",
		`attempted/successful: ${stats.attemptedCalls}/${stats.successfulCalls}`,
		stats.lastError ? `last error: ${stats.lastError}` : undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

// Two descriptions of the SAME tool, chosen by SOTA-ness of the active model.
// SOTA (in STRONG_MODELS) -> classic "escalate when stuck". Others -> use it
// liberally as a quality habit. Worded matter-of-factly so it never implies the
// model is weak. pi injects promptSnippet/promptGuidelines for active tools, so
// re-registering swaps description, snippet, and guidelines together.
interface ToolText {
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
}

const SOTA_TOOL: ToolText = {
	description:
		"Consult a stronger reviewer model for guidance. When you hit something hard — a complex decision, an ambiguous failure, or a problem you keep circling without progress — escalate to the advisor for a second opinion, then resume. It sends a bounded snapshot of the current work (recent conversation, TODO.md, ContextSnapshot summaries, active tools, and any images from your latest message) and returns one recommended next move. Takes NO parameters.",
	promptSnippet:
		"Escalate to the advisor (a stronger reviewer model) when stuck — hard decisions, ambiguous failures, or errors you can't resolve.",
	promptGuidelines: [
		"Call `advisor` when you are genuinely stuck — a complex decision, an ambiguous failure, repeated errors, or before a risky or irreversible change.",
		"Give its guidance serious weight; follow it unless direct project evidence contradicts it.",
		"If you have evidence that conflicts with its advice, raise the conflict in one more `advisor` call rather than silently switching course.",
	],
};

const LIBERAL_TOOL: ToolText = {
	description:
		"Consult a strong reviewer model as a second set of eyes. Lean on it freely — it is a fast, low-cost way to pressure-test your thinking and raise the quality of your work. It sends a bounded snapshot of the current work (recent conversation, TODO.md, ContextSnapshot summaries, active tools, and any images from your latest message) and returns one recommended next move. Takes NO parameters.",
	promptSnippet:
		"Consult the advisor (a strong reviewer model) freely — especially after planning and after implementing — to pressure-test your work and get a recommended next move.",
	promptGuidelines: [
		"Use `advisor` liberally — treat it as a standard step, not a last resort. A quick second opinion routinely catches gaps and sharpens the result.",
		"After you draft a plan, call `advisor` to confirm nothing important is missing before you start, then fold its feedback in.",
		"After you implement, call `advisor` to check the work is complete and correct before you wrap up.",
		"Whenever a decision is non-obvious or you want a sanity check, call it — verifying is cheaper than reworking.",
		"Treat its guidance as directing your approach unless direct project evidence contradicts it.",
	],
};

let lastRegisteredSota: boolean | undefined;

function registerAdvisorTool(pi: ExtensionAPI, sota: boolean): void {
	const text = sota ? SOTA_TOOL : LIBERAL_TOOL;
	pi.registerTool({
		name: ADVISOR_TOOL_NAME,
		label: "Advisor",
		description: text.description,
		promptSnippet: text.promptSnippet,
		promptGuidelines: text.promptGuidelines,
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal, onUpdate, ctx) {
			const r = resolveAdvisor(ctx);
			if (!r.model) {
				const reason = advisorOff
					? "Advisor is turned off. Use /advisor to enable it."
					: `No advisor model available for the active model family (${r.family}). Check ADVISOR_DEFAULTS or use /advisor.`;
				return { content: [{ type: "text", text: reason }], details: { errorMessage: reason } };
			}
			return runAdvisor(ctx, pi, {
				model: r.model,
				effort: r.effort,
				classification: r.family,
				signal,
				onUpdate,
			});
		},
	});
	lastRegisteredSota = sota;
}

// Re-register with class-appropriate text when the active model's SOTA-ness
// changes. pi keys tools by name, so this overwrites the definition + refreshes.
function syncToolForModel(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const sota = isSota(ctx.model);
	if (sota !== lastRegisteredSota) registerAdvisorTool(pi, sota);
}

// ---------------------------------------------------------------------------
// /advisor command
// ---------------------------------------------------------------------------

function openPicker(pi: ExtensionAPI) {
	return async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) {
			ctx.ui.notify("/advisor requires interactive mode", "error");
			return;
		}

		const available = ctx.modelRegistry.getAvailable();
		const autoActive = !advisorOff && !overrideModelKey;

		const items: SelectItem[] = [
			{ value: AUTO_VALUE, label: `Auto — smart defaults by active model${autoActive ? CHECKMARK : ""}` },
			...available.map((m) => {
				const key = `${m.provider}:${m.id}`;
				return { value: key, label: `${m.name}  (${m.provider})${key === overrideModelKey ? CHECKMARK : ""}` };
			}),
			{ value: NO_ADVISOR_VALUE, label: `No advisor (off)${advisorOff ? CHECKMARK : ""}` },
		];

		const choice = await showAdvisorPicker(ctx, items);
		if (!choice) return;

		if (choice === AUTO_VALUE) {
			advisorOff = false;
			overrideModelKey = undefined;
			overrideEffort = undefined;
			saveAdvisorConfig({});
			ctx.ui.notify("Advisor: auto (smart defaults by active model)", "info");
			setStatus(ctx);
			return;
		}

		if (choice === NO_ADVISOR_VALUE) {
			advisorOff = true;
			overrideModelKey = undefined;
			overrideEffort = undefined;
			saveAdvisorConfig({ off: true });
			ensureInactive(pi);
			ctx.ui.notify("Advisor disabled", "info");
			setStatus(ctx);
			return;
		}

		const picked = available.find((m) => `${m.provider}:${m.id}` === choice);
		if (!picked) {
			ctx.ui.notify(`Advisor selection not found: ${choice}`, "error");
			return;
		}

		let effortChoice: ThinkingLevel | undefined;
		if (picked.reasoning) {
			const levels = getSupportedThinkingLevels(picked).includes("xhigh") ? [...BASE_EFFORT_LEVELS, XHIGH_EFFORT_LEVEL] : BASE_EFFORT_LEVELS;
			const effortItems: SelectItem[] = [
				{ value: OFF_VALUE, label: "off" },
				...levels.map((level) => ({ value: level, label: level === DEFAULT_EFFORT ? `${level}${RECOMMENDED_EFFORT_SUFFIX}` : level })),
			];
			const effortResult = await showEffortPicker(ctx, effortItems, overrideEffort ?? DEFAULT_EFFORT, DEFAULT_EFFORT);
			if (!effortResult) return;
			effortChoice = effortResult === OFF_VALUE ? undefined : (effortResult as ThinkingLevel);
		}

		advisorOff = false;
		overrideModelKey = `${picked.provider}:${picked.id}`;
		overrideEffort = effortChoice;
		saveAdvisorConfig({ modelKey: overrideModelKey, effort: effortChoice });
		ensureActive(pi);
		ctx.ui.notify(`Advisor: ${overrideModelKey}${effortChoice ? `, ${effortChoice}` : ""} (override)`, "info");
		setStatus(ctx);
	};
}

function registerAdvisorCommand(pi: ExtensionAPI): void {
	const picker = openPicker(pi);
	pi.registerCommand("advisor", {
		description: "Configure the advisor model (or Auto/off), or show status/debug",
		getArgumentCompletions: (prefix: string) => {
			const trimmed = (prefix ?? "").trim().toLowerCase();
			return ["status", "debug"]
				.filter((action) => action.startsWith(trimmed))
				.map((action) => ({ value: action, label: action, description: action === "status" ? "Show advisor status." : "Show debug log location." }));
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			const action = (args ?? "").trim().toLowerCase();
			if (action === "status") {
				ctx.ui.notify(statusText(pi, ctx), "info");
				return;
			}
			if (action === "debug") {
				ctx.ui.notify(debugText(), "info");
				return;
			}
			await picker(ctx);
		},
	});
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

function registerHooks(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		resetEngineState();
		loadStateFromConfig();
		syncToolForModel(pi, ctx);
		setStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		syncToolForModel(pi, ctx);
		setStatus(ctx);
	});

	// Available whenever a model resolves for the current active model. The tool
	// text (when-stuck vs liberal) is class-specific; pi injects its
	// promptSnippet/promptGuidelines for active tools, so no manual prompt edit.
	pi.on("before_agent_start", async (_event, ctx) => {
		syncToolForModel(pi, ctx);
		const r = resolveAdvisor(ctx);
		if (!r.model) {
			ensureInactive(pi);
			return undefined;
		}
		ensureActive(pi);
		setStatus(ctx);
		return undefined;
	});
}

export default function (pi: ExtensionAPI) {
	registerAdvisorTool(pi, false);
	registerAdvisorCommand(pi);
	registerHooks(pi);
}
