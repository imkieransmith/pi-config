/**
 * Advisor — consult one fixed reviewer model for one recommended next move.
 *
 * The tool requires a short brief and always uses openai-codex/gpt-5.6-sol with
 * one static usage contract and no active-model-dependent policy.
 *
 * /advisor status   - show the configured reviewer and call counts.
 * /advisor debug    - show the debug log location and last payload sample.
 *
 * Merged from the former `advisor` and `senior-dev` extensions.
 * Advisor original - https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor
 */

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ADVISOR_BRIEF_MAX_CHARS, normalizeAdvisorBrief } from "./brief.ts";
import { ADVISOR_TOOL_NAME, debugLogPath, engineStats, modelKey, resetEngineState, runAdvisor } from "./engine.ts";

const ADVISOR_PROVIDER = "openai-codex";
const ADVISOR_MODEL_ID = "gpt-5.6-sol";
const DEFAULT_EFFORT: ThinkingLevel = "high";

interface ResolvedAdvisor {
	model?: Model<Api>;
	effort?: ThinkingLevel;
}

function resolveAdvisor(ctx: ExtensionContext): ResolvedAdvisor {
	const model = ctx.modelRegistry.find(ADVISOR_PROVIDER, ADVISOR_MODEL_ID) as Model<Api> | undefined;
	return {
		model,
		effort: model?.reasoning ? DEFAULT_EFFORT : undefined,
	};
}

function configuredAdvisorKey(): string {
	return `${ADVISOR_PROVIDER}/${ADVISOR_MODEL_ID}`;
}

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
	ctx.ui.setStatus("advisor", r.model ? `advisor: ${configuredAdvisorKey()}` : `advisor: ${configuredAdvisorKey()} unavailable`);
}

function statusText(pi: ExtensionAPI, ctx: ExtensionContext): string {
	const stats = engineStats();
	const r = resolveAdvisor(ctx);
	return [
		"advisor status",
		`configured advisor: ${configuredAdvisorKey()}`,
		`resolved: ${r.model ? modelKey(r.model) : "(model unavailable)"}`,
		`effort: ${r.effort ?? "model default (non-reasoning)"}`,
		`tool active: ${isActive(pi)}`,
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

function registerAdvisorTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: ADVISOR_TOOL_NAME,
		label: "Advisor",
		description: "Ask the advisor for one next step or a check of your approach. Call it after two failed tries, before a change that is hard to undo, when you cannot choose between options, or when you want to check your plan. Pass a short brief with what you are doing and what you want checked.",
		promptSnippet: "Ask the advisor after two failed tries, before a change that is hard to undo, when you cannot choose between options, or when you want to check your plan.",
		promptGuidelines: [
			"When you call `advisor`, pass a short brief that says what you are doing, any steps tried or planned, and what you want checked.",
			"Check its advice against the code, tool results, and tests. Call it again only after you try its advice or learn something new.",
		],
		parameters: Type.Object({
			brief: Type.String({
				minLength: 1,
				maxLength: ADVISOR_BRIEF_MAX_CHARS,
				description: "State what you are doing, any steps tried or planned, and what you want the advisor to check.",
			}),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const brief = normalizeAdvisorBrief(params.brief);
			const r = resolveAdvisor(ctx);
			if (!r.model) {
				throw new Error(
					`Configured advisor model ${configuredAdvisorKey()} is unavailable. Check model availability and authentication, then proceed with your own judgment.`,
				);
			}
			const result = await runAdvisor(ctx, pi, {
				model: r.model,
				effort: r.effort,
				brief,
				signal,
				onUpdate,
			});
			if (result.details?.errorMessage) {
				throw new Error(`Advisor unavailable: ${result.details.errorMessage}. Proceed with your own judgment.`);
			}
			return result;
		},
	});
}

function registerAdvisorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("advisor", {
		description: "Show fixed advisor status or debug information",
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

function registerHooks(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		resetEngineState();
		setStatus(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!resolveAdvisor(ctx).model) {
			ensureInactive(pi);
			setStatus(ctx);
			return undefined;
		}
		ensureActive(pi);
		setStatus(ctx);
		return undefined;
	});
}

export default function (pi: ExtensionAPI) {
	registerAdvisorTool(pi);
	registerAdvisorCommand(pi);
	registerHooks(pi);
}
