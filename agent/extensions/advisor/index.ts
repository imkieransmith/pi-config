/**
 * Advisor — consult a reviewer model for one recommended next move.
 *
 * One zero-param tool backed by ./engine.ts. Reviewer selection and effort are
 * configured in extension code; there is no runtime picker. Two things adapt to
 * the ACTIVE model:
 *   1. Which cross-family reviewer is used -> ADVISOR_DEFAULTS (by family).
 *   2. How often the tool should be used -> exceptional, gated, or routine
 *      usage derived from capability. The tool is re-registered when usage changes.
 *
 * /advisor status   - show automatic policy, resolved model, classification, call counts.
 * /advisor debug    - show debug log location and last payload sample.
 *
 * Merged from the former `advisor` and `senior-dev` extensions.
 * Advisor original - https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor
 */

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ADVISOR_TOOL_NAME, debugLogPath, engineStats, modelKey, resetEngineState, runAdvisor } from "./engine.js";
import {
	ADVISOR_DEFAULTS,
	advisorUsageForCapability,
	classifyCapability,
	classifyFamily,
	effortForModel,
	resolveBestCrossFamilyAvailable,
	resolveFirstAvailable,
	type AdvisorUsageMode,
	type ModelFamily,
} from "./model-policy.js";

// Default reasoning effort used for auto-resolved advisor models.
const DEFAULT_EFFORT: ThinkingLevel = "high";

// ---------------------------------------------------------------------------
// Advisor-model resolution
// ---------------------------------------------------------------------------

interface ResolvedAdvisor {
	model?: Model<Api>;
	effort?: ThinkingLevel;
	source: string;
	family: ModelFamily;
}

function availableModels(ctx: ExtensionContext): Model<Api>[] {
	return ctx.modelRegistry.getAvailable() as Model<Api>[];
}

function resolveAdvisor(ctx: ExtensionContext): ResolvedAdvisor {
	const family = classifyFamily(ctx.model);
	const models = availableModels(ctx);
	const configuredModel = resolveFirstAvailable(models, ADVISOR_DEFAULTS[family]);
	const model = configuredModel ?? resolveBestCrossFamilyAvailable(models, family);
	return {
		model,
		effort: effortForModel(model, DEFAULT_EFFORT),
		source: configuredModel ? `configured policy (${family})` : model ? `catalog fallback (${family})` : `unavailable (${family})`,
		family,
	};
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
	const text = r.model ? `advisor: ${r.model.provider}:${r.model.id} (${r.family})` : `advisor: none for ${r.family}`;
	ctx.ui.setStatus("advisor", text);
}

// ---------------------------------------------------------------------------
// Status / debug text
// ---------------------------------------------------------------------------

function usageModeLabel(mode: AdvisorUsageMode): string {
	if (mode === "exceptional") return "exceptional — use when stuck or for high-risk decisions";
	if (mode === "gated") return "gated — review substantive plans and consequential implementations";
	return "routine — review after planning and implementation";
}

function statusText(pi: ExtensionAPI, ctx: ExtensionContext): string {
	const stats = engineStats();
	const r = resolveAdvisor(ctx);
	const tier = classifyCapability(ctx.model);
	const usageMode = advisorUsageForCapability(tier);
	return [
		"advisor status",
		"mode: automatic extension policy",
		`active model: ${modelKey(ctx.model) ?? "(none)"} (family: ${r.family}, capability: ${tier})`,
		`resolved advisor: ${r.model ? `${r.model.provider}:${r.model.id}` : "(none available)"}${r.model ? ` — ${r.source}` : ""}`,
		`effort: ${r.effort ?? "model default (non-reasoning)"}`,
		`advisor usage: ${usageModeLabel(usageMode)}`,
		`tool active: ${isActive(pi)}`,
		"defaults: " +
			(Object.keys(ADVISOR_DEFAULTS) as ModelFamily[])
				.map((family) => `${family}→${ADVISOR_DEFAULTS[family][0]}`)
				.join(", "),
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

// Three descriptions of the SAME tool, selected by advisor-usage mode. Pi
// injects promptSnippet/promptGuidelines for active tools, so re-registering
// swaps description, snippet, and guidelines together.
interface ToolText {
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
}

const EXCEPTIONAL_TOOL: ToolText = {
	description:
		"Consult an independent advisor (a different model) for one recommended next move. Use it after two or more failed attempts at the same problem, before a hard-to-reverse change, or when torn between approaches. It sees only a bounded snapshot of recent work, so state your diagnosis or plan before calling. No parameters.",
	promptSnippet:
		"Consult the advisor when repeatedly stuck or before hard-to-reverse changes.",
	promptGuidelines: [
		"Call `advisor` after two failed attempts at the same problem, before a hard-to-reverse change, or when torn between approaches. Write out your diagnosis and leading option first — it only sees the recent conversation.",
		"Treat its answer as a peer's: verify against project evidence, and don't re-call the same question without new information.",
	],
};

const GATED_TOOL: ToolText = {
	description:
		"Consult an independent advisor (a different model) for one recommended next move. For non-trivial work — multiple files, architecture or data changes, costly to redo — call it after drafting your plan and again after implementing and validating. It sees only a bounded snapshot of recent work, so summarize your plan or results before calling. No parameters.",
	promptSnippet:
		"Review non-trivial work with the advisor: after planning, and again after implementation.",
	promptGuidelines: [
		"For non-trivial work, call `advisor` after drafting the plan and again after implementation and validation — don't wait until stuck. Summarize your plan or changes first; it only sees the recent conversation.",
		"Incorporate what checks out against project evidence; note anything you choose not to act on. Don't re-call without new information.",
	],
};

const ROUTINE_TOOL: ToolText = {
	description:
		"Consult a stronger advisor (a different model) for one recommended next move. For anything beyond a quick, verifiable fix, call it after drafting your plan and again after implementing — and whenever you're unsure how to proceed. It sees only a bounded snapshot of recent work, so write out your plan or problem before calling. No parameters.",
	promptSnippet:
		"Call the advisor routinely: after planning, after implementation, and whenever unsure.",
	promptGuidelines: [
		"Call `advisor` after drafting your plan, again after implementation, and whenever unsure — it's a standard step, not a last resort. Write out your plan or problem first; it only sees the recent conversation.",
		"Follow its recommendation unless direct evidence contradicts it — then trust the evidence and say so. Re-call only after acting on its advice or learning something new.",
	],
};

let lastRegisteredUsageMode: AdvisorUsageMode | undefined;

function registerAdvisorTool(pi: ExtensionAPI, usageMode: AdvisorUsageMode): void {
	const text = usageMode === "exceptional" ? EXCEPTIONAL_TOOL : usageMode === "gated" ? GATED_TOOL : ROUTINE_TOOL;
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
				throw new Error(
					`No advisor model is available for the active model family (${r.family}). Check ADVISOR_DEFAULTS in model-policy.ts and proceed with your own judgment.`,
				);
			}
			const capability = classifyCapability(ctx.model);
			const result = await runAdvisor(ctx, pi, {
				model: r.model,
				effort: r.effort,
				classification: `${r.family}/${capability}/${advisorUsageForCapability(capability)}`,
				signal,
				onUpdate,
			});
			if (result.details?.errorMessage) {
				throw new Error(`Advisor unavailable: ${result.details.errorMessage}. Proceed with your own judgment.`);
			}
			return result;
		},
	});
	lastRegisteredUsageMode = usageMode;
}

// Re-register when the usage policy derived from the active model changes. Pi
// keys tools by name, so this overwrites the definition and refreshes its prompt.
function syncToolForModel(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const usageMode = advisorUsageForCapability(classifyCapability(ctx.model));
	if (usageMode !== lastRegisteredUsageMode) registerAdvisorTool(pi, usageMode);
}

// ---------------------------------------------------------------------------
// /advisor command
// ---------------------------------------------------------------------------

function registerAdvisorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("advisor", {
		description: "Show code-driven advisor policy status or debug information",
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
			ctx.ui.notify("Usage: /advisor status|debug", "info");
		},
	});
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

function registerHooks(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		resetEngineState();
		syncToolForModel(pi, ctx);
		setStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		syncToolForModel(pi, ctx);
		setStatus(ctx);
	});

	// Available whenever a model resolves for the current active model. Tool text
	// carries the usage policy; Pi injects its prompt metadata for active tools.
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
	registerAdvisorTool(pi, "routine");
	registerAdvisorCommand(pi);
	registerHooks(pi);
}
