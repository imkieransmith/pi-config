/**
 * Routine SOTA steering for selected coding models.
 * Keeps advisor as the exceptional unblocker tool, while senior_dev gives DeepSeek/OpenCode-style models frequent architectural and debugging direction.
 *
 * /senior-dev - Show senior-dev status.
 * /senior-dev status - Show configured senior model, active model classification, call counts, and debug log path.
 * /senior-dev debug - Show debug/logging status, including the last saved payload sample if any.
 * /senior-dev enable - Manually enable senior_dev for this session, even on strong models.
 * /senior-dev disable - Manually disable senior_dev for this session.
 * /senior-dev auto - Return to automatic model-aware activation.
 *
 * Agent tool equivalent: senior_dev asks a configured senior model for one recommended next move.
 */

import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, ImageContent, Message, Model, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { completeSimple, StringEnum } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const TOOL_NAME = "senior_dev";
const COMMAND_NAME = "senior-dev";

const CONFIG = {
	// Personal inline config. Edit this file directly if you want to change behaviour.
	// Use the Codex provider so ChatGPT/Codex subscription OAuth is reused instead of requiring OPENAI_API_KEY.
	seniorModel: "openai-codex/gpt-5.5",
	seniorThinkingLevel: "high" as ThinkingLevel | undefined,
	disableForStrongModels: true,
	weakModelMatchers: [
		"deepseek/*",
		"*/deepseek-v4*",
		"opencode-go/*",
		"*/plan*",
	],
	strongModelMatchers: [
		"openai-codex/gpt-5.5*",
		"openai/gpt-5.5*",
		"*/gpt-5.5*",
		"anthropic/claude-opus-*",
		"anthropic/claude-4.7-opus*",
		"anthropic/claude-opus-4-7*",
	],
	debug: {
		enabled: true,
		dir: join(homedir(), ".pi", "agent", "senior-dev"),
		logFile: "debug.jsonl",
		// Save every Nth full payload for inspection. Set to 0 to disable periodic sampling.
		payloadSampleEvery: 5,
		payloadSampleOnError: true,
	},
};

type ModelClass = "weak" | "strong" | "neutral";
type ManualOverride = "enabled" | "disabled" | undefined;
type SeniorStage = "planning" | "architecture" | "implementation" | "debugging" | "review" | "other";

interface SeniorParams {
	question: string;
	stage?: SeniorStage;
	current_plan?: string;
	uncertainty?: string;
	files_or_symbols?: string[];
}

interface SeniorDetails {
	seniorModel?: string;
	activeModel?: string;
	stage?: SeniorStage;
	classification?: ModelClass;
	payloadChars?: number;
	estimatedPayloadTokens?: number;
	responseChars?: number;
	usage?: Usage;
	stopReason?: string;
	errorMessage?: string;
	latencyMs?: number;
	debugLog?: string;
	payloadSamplePath?: string;
	callNumber?: number;
}

interface RuntimeState {
	manualOverride: ManualOverride;
	attemptedCalls: number;
	successfulCalls: number;
	lastError?: string;
	lastPayloadSamplePath?: string;
	lastCallAt?: number;
}

const STATE_KEY = Symbol.for("pi-senior-dev-state");

function state(): RuntimeState {
	const g = globalThis as unknown as { [key: symbol]: RuntimeState | undefined };
	if (!g[STATE_KEY]) {
		g[STATE_KEY] = { manualOverride: undefined, attemptedCalls: 0, successfulCalls: 0 };
	}
	return g[STATE_KEY]!;
}

function resetSessionState(): void {
	const s = state();
	s.manualOverride = undefined;
	s.attemptedCalls = 0;
	s.successfulCalls = 0;
	s.lastError = undefined;
	s.lastPayloadSamplePath = undefined;
	s.lastCallAt = undefined;
}

function globToRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

function matchesAny(value: string, patterns: string[]): boolean {
	return patterns.some((pattern) => globToRegex(pattern).test(value));
}

function modelKey(model: { provider: string; id: string } | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

function classifyModel(model: { provider: string; id: string; name?: string } | undefined): ModelClass {
	if (!model) return "neutral";
	const keys = [`${model.provider}/${model.id}`, `${model.provider}/${model.name ?? model.id}`];
	if (keys.some((key) => matchesAny(key, CONFIG.strongModelMatchers))) return "strong";
	if (keys.some((key) => matchesAny(key, CONFIG.weakModelMatchers))) return "weak";
	return "neutral";
}

function parseConfiguredModel(value: string): { provider: string; modelId: string } | undefined {
	const slash = value.indexOf("/");
	if (slash > 0) return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
	const colon = value.indexOf(":");
	if (colon > 0) return { provider: value.slice(0, colon), modelId: value.slice(colon + 1) };
	return undefined;
}

function ensureActive(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	if (!active.includes(TOOL_NAME)) pi.setActiveTools([...active, TOOL_NAME]);
}

function ensureInactive(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	if (active.includes(TOOL_NAME)) pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
}

function isSeniorActive(pi: ExtensionAPI): boolean {
	return pi.getActiveTools().includes(TOOL_NAME);
}

function applyActiveToolPolicy(pi: ExtensionAPI, ctx?: ExtensionContext): ModelClass {
	const classification = classifyModel(ctx?.model);
	const override = state().manualOverride;

	if (override === "enabled") {
		ensureActive(pi);
		return classification;
	}
	if (override === "disabled") {
		ensureInactive(pi);
		return classification;
	}
	if (classification === "weak") {
		ensureActive(pi);
		return classification;
	}
	if (CONFIG.disableForStrongModels) {
		ensureInactive(pi);
		return classification;
	}
	return classification;
}

function debugLogPath(): string {
	return join(CONFIG.debug.dir, CONFIG.debug.logFile);
}

function ensureDebugDir(): void {
	if (!CONFIG.debug.enabled) return;
	try {
		mkdirSync(CONFIG.debug.dir, { recursive: true });
	} catch {
		// best effort only
	}
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function compactJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return JSON.stringify({ unserializable: String(value) });
	}
}

function approxTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return safeJson(content);
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return String(part);
			const p = part as Record<string, unknown>;
			if (p.type === "text") return String(p.text ?? "");
			if (p.type === "thinking") return `<thinking>\n${String(p.thinking ?? "")}\n</thinking>`;
			if (p.type === "image") {
				const mime = typeof p.mimeType === "string" ? p.mimeType : "image";
				const chars = typeof p.data === "string" ? p.data.length : 0;
				return `[image omitted from text diagnostic: ${mime}, ${chars.toLocaleString()} base64 chars]`;
			}
			if (p.type === "toolCall") return `Tool call: ${String(p.name ?? "unknown")}\nArguments: ${safeJson(p.arguments ?? {})}`;
			return safeJson(p);
		})
		.join("\n");
}

function stripInflightSeniorDevCall(messages: AgentMessage[]): AgentMessage[] {
	if (messages.length === 0) return messages;
	const last = messages[messages.length - 1];
	if (last.role !== "assistant") return messages;
	const filtered = last.content.filter((part) => !(part.type === "toolCall" && part.name === TOOL_NAME));
	if (filtered.length === last.content.length) return messages;
	if (filtered.length === 0) return messages.slice(0, -1);
	return [...messages.slice(0, -1), { ...last, content: filtered }];
}

function serializeAgentMessage(message: AgentMessage, index: number): string {
	if (message.role === "user") {
		return `## ${index + 1}. USER\n${textOfContent(message.content)}`;
	}
	if (message.role === "assistant") {
		const meta = [`model=${message.provider}/${message.model}`, `stop=${message.stopReason}`].join(" ");
		return `## ${index + 1}. ASSISTANT (${meta})\n${textOfContent(message.content)}`;
	}
	if (message.role === "toolResult") {
		const body = [
			`Tool: ${message.toolName}`,
			`Status: ${message.isError ? "error" : "ok"}`,
			`Content:\n${textOfContent(message.content)}`,
			message.details === undefined ? undefined : `Details:\n${safeJson(message.details)}`,
		]
			.filter((x): x is string => x !== undefined)
			.join("\n\n");
		return `## ${index + 1}. TOOL RESULT\n${body}`;
	}
	if (message.role === "bashExecution") {
		return `## ${index + 1}. USER BASH\nCommand: ${message.command}\nExit: ${message.exitCode ?? "unknown"}\nCancelled: ${message.cancelled}\nTruncated by bash tool: ${message.truncated}\nOutput:\n${message.output}`;
	}
	if (message.role === "custom") {
		return `## ${index + 1}. CUSTOM (${message.customType})\n${textOfContent(message.content)}${message.details === undefined ? "" : `\n\nDetails:\n${safeJson(message.details)}`}`;
	}
	if (message.role === "branchSummary") {
		return `## ${index + 1}. BRANCH SUMMARY\n${message.summary}`;
	}
	if (message.role === "compactionSummary") {
		return `## ${index + 1}. COMPACTION SUMMARY (${message.tokensBefore.toLocaleString()} tokens before compaction)\n${message.summary}`;
	}
	return `## ${index + 1}. MESSAGE\n${safeJson(message)}`;
}

function sessionMessages(ctx: ExtensionContext): AgentMessage[] {
	const branch = ctx.sessionManager.getBranch();
	return branch
		.map((entry: SessionEntry): AgentMessage | undefined => {
			if (entry.type === "message") return entry.message;
			if (entry.type === "compaction") {
				return {
					role: "compactionSummary",
					summary: entry.summary,
					tokensBefore: entry.tokensBefore,
					timestamp: new Date(entry.timestamp).getTime(),
				};
			}
			if (entry.type === "branch_summary") {
				return {
					role: "branchSummary",
					summary: entry.summary,
					fromId: entry.fromId,
					timestamp: new Date(entry.timestamp).getTime(),
				};
			}
			return undefined;
		})
		.filter((message): message is AgentMessage => message !== undefined);
}

function activeToolInventory(pi: ExtensionAPI): string {
	const active = new Set(pi.getActiveTools().filter((name) => name !== TOOL_NAME));
	const tools = pi.getAllTools().filter((tool) => active.has(tool.name));
	if (tools.length === 0) return "(no active executor tools)";
	return tools
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((tool) => [`### ${tool.name}`, tool.description, `Parameters: ${compactJson(tool.parameters)}`].join("\n"))
		.join("\n\n---\n\n");
}

function buildSeniorSystemPrompt(): string {
	return [
		"You are the senior engineer advising a coding agent that has explicitly asked for guidance.",
		"Your job is to direct the agent's thinking and approach. Be decisive.",
		"Return ONE recommended next move, not a menu of options or a brainstorming list.",
		"Call out bad assumptions, missing evidence, architectural risks, and concrete verification steps.",
		"Do not ask the user questions unless truly blocking. Prefer instructing the agent what to inspect or do next.",
		"Do not suggest modifying, replacing, or routing through the existing advisor tool. advisor remains a separate exceptional-unblocker workflow.",
		"Format your answer with these headings: Recommendation, Rationale, Next Move, Checks/Risks.",
	].join("\n");
}

function buildPayload(params: SeniorParams, ctx: ExtensionContext, pi: ExtensionAPI): { text: string; chars: number; estimatedTokens: number } {
	const messages = stripInflightSeniorDevCall(sessionMessages(ctx));
	const transcript = messages.map(serializeAgentMessage).join("\n\n---\n\n") || "(no conversation messages found)";
	const contextUsage = ctx.getContextUsage();
	const activeModel = modelKey(ctx.model) ?? "(none)";
	const classification = classifyModel(ctx.model);
	const activeTools = activeToolInventory(pi);
	const systemPrompt = ctx.getSystemPrompt();
	const sessionFile = ctx.sessionManager.getSessionFile?.() ?? "(ephemeral)";

	const payload = [
		"# Senior Dev Consultation Packet",
		"This packet is for a senior model that guides the active coding agent. It is diagnostic context, not a user-facing prompt.",
		"",
		"## Agent request to senior_dev",
		`Stage: ${params.stage ?? "other"}`,
		`Question: ${params.question}`,
		params.current_plan ? `Current plan:\n${params.current_plan}` : undefined,
		params.uncertainty ? `Uncertainty / concern:\n${params.uncertainty}` : undefined,
		params.files_or_symbols?.length ? `Files or symbols in focus:\n${params.files_or_symbols.map((x) => `- ${x}`).join("\n")}` : undefined,
		"",
		"## Runtime context",
		`cwd: ${ctx.cwd}`,
		`session: ${sessionFile}`,
		`active model: ${activeModel}`,
		`model classification: ${classification}`,
		`thinking level: ${String((pi as unknown as { getThinkingLevel?: () => string }).getThinkingLevel?.() ?? "unknown")}`,
		contextUsage ? `context usage estimate: ${contextUsage.tokens.toLocaleString()} tokens` : "context usage estimate: unavailable",
		"",
		"## Active executor tools",
		activeTools,
		"",
		"## Current system prompt / instructions seen by the agent",
		systemPrompt || "(empty)",
		"",
		"## Conversation and tool trace",
		transcript,
		"",
		"## What the senior model should return",
		"Give the agent one recommended next move, with concise rationale and checks. If the trace is missing critical evidence, say exactly what to inspect next.",
	]
		.filter((part): part is string => part !== undefined)
		.join("\n");

	return { text: payload, chars: payload.length, estimatedTokens: approxTokens(payload.length) };
}

function resolveSeniorModel(ctx: ExtensionContext): Model<Api> | undefined {
	const parsed = parseConfiguredModel(CONFIG.seniorModel);
	if (!parsed) return undefined;
	return ctx.modelRegistry.find(parsed.provider, parsed.modelId) as Model<Api> | undefined;
}

function extractText(response: Message): string {
	if (response.role !== "assistant") return "";
	return response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function shouldSavePayload(callNumber: number, success: boolean): boolean {
	if (!CONFIG.debug.enabled) return false;
	if (!success && CONFIG.debug.payloadSampleOnError) return true;
	return CONFIG.debug.payloadSampleEvery > 0 && callNumber % CONFIG.debug.payloadSampleEvery === 0;
}

function writePayloadSample(callNumber: number, payload: string): string | undefined {
	if (!CONFIG.debug.enabled) return undefined;
	ensureDebugDir();
	const file = join(CONFIG.debug.dir, `payload-${String(callNumber).padStart(4, "0")}-${Date.now()}.md`);
	try {
		writeFileSync(file, payload, "utf-8");
		try {
			chmodSync(file, 0o600);
		} catch {
			// best effort only
		}
		state().lastPayloadSamplePath = file;
		return file;
	} catch {
		return undefined;
	}
}

function appendDebug(record: Record<string, unknown>): void {
	if (!CONFIG.debug.enabled) return;
	ensureDebugDir();
	try {
		appendFileSync(debugLogPath(), `${compactJson(record)}\n`, "utf-8");
	} catch {
		// debug logging must never break the tool
	}
}

async function executeSeniorDev(
	params: SeniorParams,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: { content: Array<{ type: "text"; text: string }>; details?: SeniorDetails }) => void) | undefined,
) {
	const s = state();
	s.attemptedCalls += 1;
	s.lastCallAt = Date.now();
	const callNumber = s.attemptedCalls;
	const started = Date.now();
	const classification = classifyModel(ctx.model);
	const activeModel = modelKey(ctx.model) ?? "unknown";
	const senior = resolveSeniorModel(ctx);
	const seniorLabel = senior ? modelKey(senior) : CONFIG.seniorModel;
	let payloadText = "";
	let payloadChars = 0;
	let estimatedPayloadTokens = 0;
	let payloadSamplePath: string | undefined;

	const finishDebug = (record: Record<string, unknown>) => {
		appendDebug({
			timestamp: new Date().toISOString(),
			callNumber,
			sessionFile: ctx.sessionManager.getSessionFile?.(),
			sessionId: ctx.sessionManager.getSessionId?.(),
			cwd: ctx.cwd,
			activeModel,
			modelClassification: classification,
			seniorModel: seniorLabel,
			stage: params.stage ?? "other",
			payloadChars,
			estimatedPayloadTokens,
			payloadSamplePath,
			latencyMs: Date.now() - started,
			...record,
		});
	};

	try {
		const override = state().manualOverride;
		if (classification !== "weak" && override !== "enabled") {
			ensureInactive(pi);
			const message = `senior_dev is disabled in automatic mode for ${classification} model ${activeModel}. It auto-activates only for configured weak models; use /senior-dev enable to override.`;
			s.lastError = message;
			finishDebug({ success: false, skipped: true, error: message });
			return {
				content: [{ type: "text", text: message }],
				details: { seniorModel: seniorLabel, activeModel, stage: params.stage, classification, errorMessage: message, debugLog: debugLogPath(), callNumber } satisfies SeniorDetails,
			};
		}

		if (!senior) {
			const error = `Configured senior model not found: ${CONFIG.seniorModel}`;
			s.lastError = error;
			finishDebug({ success: false, error });
			return {
				content: [{ type: "text", text: error }],
				details: { seniorModel: CONFIG.seniorModel, activeModel, stage: params.stage, classification, errorMessage: error, debugLog: debugLogPath(), callNumber } satisfies SeniorDetails,
			};
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(senior);
		if (!auth.ok || !auth.apiKey) {
			const error = !auth.ok ? auth.error : `No request auth available for ${senior.provider}. If using ChatGPT/Codex subscription auth, run /login ${senior.provider}; if using API auth, add that provider's API key.`;
			s.lastError = error;
			finishDebug({ success: false, error });
			return {
				content: [{ type: "text", text: `senior_dev failed: ${error}` }],
				details: { seniorModel: seniorLabel, activeModel, stage: params.stage, classification, errorMessage: error, debugLog: debugLogPath(), callNumber } satisfies SeniorDetails,
			};
		}

		const payload = buildPayload(params, ctx, pi);
		payloadText = payload.text;
		payloadChars = payload.chars;
		estimatedPayloadTokens = payload.estimatedTokens;

		onUpdate?.({
			content: [{ type: "text", text: `Consulting senior_dev (${seniorLabel}, ${CONFIG.seniorThinkingLevel ?? "no extra thinking"}) — ${payloadChars.toLocaleString()} chars, ~${estimatedPayloadTokens.toLocaleString()} rough tokens…` }],
			details: { seniorModel: seniorLabel, activeModel, stage: params.stage, classification, payloadChars, estimatedPayloadTokens, debugLog: debugLogPath(), callNumber },
		});

		const response = await completeSimple(
			senior,
			{
				systemPrompt: buildSeniorSystemPrompt(),
				messages: [{ role: "user", content: [{ type: "text", text: payloadText }], timestamp: Date.now() }],
				tools: [],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, signal, reasoning: CONFIG.seniorThinkingLevel },
		);

		const seniorText = extractText(response);
		const latencyMs = Date.now() - started;
		const success = response.stopReason !== "error" && response.stopReason !== "aborted" && Boolean(seniorText);
		payloadSamplePath = shouldSavePayload(callNumber, success) ? writePayloadSample(callNumber, payloadText) : undefined;

		if (!success) {
			const error = response.stopReason === "aborted" ? "senior_dev call was aborted" : response.errorMessage || "senior_dev returned no text";
			s.lastError = error;
			finishDebug({ success: false, stopReason: response.stopReason, error, usage: response.usage, responseChars: seniorText.length });
			return {
				content: [{ type: "text", text: `senior_dev failed: ${error}` }],
				details: { seniorModel: seniorLabel, activeModel, stage: params.stage, classification, payloadChars, estimatedPayloadTokens, responseChars: seniorText.length, usage: response.usage, stopReason: response.stopReason, errorMessage: error, latencyMs, debugLog: debugLogPath(), payloadSamplePath, callNumber } satisfies SeniorDetails,
			};
		}

		s.successfulCalls += 1;
		s.lastError = undefined;
		finishDebug({ success: true, stopReason: response.stopReason, usage: response.usage, responseChars: seniorText.length });

		return {
			content: [{ type: "text", text: seniorText }],
			details: { seniorModel: seniorLabel, activeModel, stage: params.stage, classification, payloadChars, estimatedPayloadTokens, responseChars: seniorText.length, usage: response.usage, stopReason: response.stopReason, latencyMs, debugLog: debugLogPath(), payloadSamplePath, callNumber } satisfies SeniorDetails,
		};
	} catch (err) {
		const latencyMs = Date.now() - started;
		const error = err instanceof Error ? err.message : String(err);
		s.lastError = error;
		payloadSamplePath = shouldSavePayload(callNumber, false) && payloadText ? writePayloadSample(callNumber, payloadText) : undefined;
		finishDebug({ success: false, error });
		return {
			content: [{ type: "text", text: `senior_dev threw: ${error}` }],
			details: { seniorModel: seniorLabel, activeModel, stage: params.stage, classification, payloadChars, estimatedPayloadTokens, errorMessage: error, latencyMs, debugLog: debugLogPath(), payloadSamplePath, callNumber } satisfies SeniorDetails,
		};
	}
}

const SeniorParamsSchema = Type.Object({
	question: Type.String({ description: "The concrete decision, plan, bug, or concern the senior model should guide. Ask for direction before acting." }),
	stage: Type.Optional(StringEnum(["planning", "architecture", "implementation", "debugging", "review", "other"] as const, { description: "Where you are in the work." })),
	current_plan: Type.Optional(Type.String({ description: "Your current intended approach, if you have one." })),
	uncertainty: Type.Optional(Type.String({ description: "What you are unsure about, what failed, or what might be risky." })),
	files_or_symbols: Type.Optional(Type.Array(Type.String(), { description: "Files, functions, types, commands, or symbols that seem relevant." })),
});

function registerSeniorTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Senior Dev",
		description: "Consult a senior developer for routine steering. Use senior_dev liberally before architectural decisions, non-trivial plans, uncertain debugging, repeated failures, and final review. The senior model returns one recommended next move.",
		promptSnippet: "Consult a senior developer for routine steering before architecture, planning, debugging, and review.",
		promptGuidelines: [
			"Use `senior_dev` liberally before architecture decisions, before non-trivial implementation plans, when debugging is uncertain, after repeated failures, and before final review.",
			"Treat `senior_dev` as the senior engineer directing your approach. It will return one recommended next move; follow it unless direct project evidence contradicts it.",
			"Do not use `senior_dev` as a replacement for `advisor`. The `advisor` tool remains reserved for exceptional unblocker situations.",
		],
		parameters: SeniorParamsSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeSeniorDev(params as SeniorParams, ctx, pi, signal, onUpdate);
		},
		renderCall(args, theme) {
			const stage = args.stage ? ` ${args.stage}` : "";
			const question = args.question ? String(args.question) : "...";
			const preview = question.length > 90 ? `${question.slice(0, 90)}…` : question;
			return new Text(`${theme.fg("toolTitle", theme.bold("senior_dev"))}${theme.fg("muted", stage)}\n  ${theme.fg("dim", preview)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as SeniorDetails | undefined;
			const content = result.content.find((part) => part.type === "text") as { type: "text"; text: string } | undefined;
			const text = content?.text ?? "(no response)";
			const isError = Boolean(details?.errorMessage);
			const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const title = `${icon} ${theme.fg("toolTitle", theme.bold("senior_dev"))}${details?.seniorModel ? theme.fg("muted", ` ${details.seniorModel}`) : ""}`;

			if (expanded) {
				const container = new Container();
				container.addChild(new Text(title, 0, 0));
				const meta = [
					details?.stage ? `stage: ${details.stage}` : undefined,
					details?.payloadChars ? `payload: ${details.payloadChars.toLocaleString()} chars (~${details.estimatedPayloadTokens?.toLocaleString()} rough tokens)` : undefined,
					details?.usage ? `usage: ↑${details.usage.input.toLocaleString()} ↓${details.usage.output.toLocaleString()} total ${details.usage.totalTokens.toLocaleString()} tokens` : undefined,
					details?.latencyMs ? `latency: ${details.latencyMs.toLocaleString()}ms` : undefined,
					details?.debugLog ? `debug: ${details.debugLog}` : undefined,
					details?.payloadSamplePath ? `payload sample: ${details.payloadSamplePath}` : undefined,
				]
					.filter((line): line is string => Boolean(line))
					.join("\n");
				if (meta) container.addChild(new Text(theme.fg("dim", meta), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
				return container;
			}

			const firstLines = text.split("\n").filter((line) => line.trim()).slice(0, 6).join("\n");
			const meta = details?.payloadChars ? `\n${theme.fg("dim", `${details.payloadChars.toLocaleString()} chars sent · Ctrl+O to expand`)}` : "";
			return new Text(`${title}\n${theme.fg(isError ? "error" : "toolOutput", firstLines || "(empty)")}${meta}`, 0, 0);
		},
	});
}

function seniorGuidance(pi: ExtensionAPI, ctx: ExtensionContext, classification: ModelClass): string | undefined {
	const override = state().manualOverride;
	const active = isSeniorActive(pi);
	if (!active) return undefined;
	if (classification !== "weak" && override !== "enabled") return undefined;
	return [
		"`senior_dev` is available for routine senior-model steering.",
		"Use `senior_dev` liberally before making architectural decisions, before non-trivial implementation plans, when debugging is uncertain, after repeated failures, and before final review.",
		"When calling `senior_dev`, state your concrete question, current plan, uncertainty, and relevant files/symbols. The senior model will provide one recommended next move.",
		"Treat `senior_dev` guidance as directing your approach unless direct project evidence contradicts it.",
		"Do not confuse `senior_dev` with `advisor`: advisor is still only for exceptional unblocker situations.",
	].join("\n");
}

function registerPolicyHooks(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		resetSessionState();
		const classification = applyActiveToolPolicy(pi, ctx);
		if (ctx.hasUI) ctx.ui.setStatus("senior-dev", `senior-dev: ${classification}${isSeniorActive(pi) ? " active" : " off"}`);
	});

	pi.on("model_select", async (_event, ctx) => {
		const classification = applyActiveToolPolicy(pi, ctx);
		if (ctx.hasUI) ctx.ui.setStatus("senior-dev", `senior-dev: ${classification}${isSeniorActive(pi) ? " active" : " off"}`);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const classification = applyActiveToolPolicy(pi, ctx);
		if (ctx.hasUI) ctx.ui.setStatus("senior-dev", `senior-dev: ${classification}${isSeniorActive(pi) ? " active" : " off"}`);
		const guidance = seniorGuidance(pi, ctx, classification);
		if (!guidance) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n## senior_dev guidance\n${guidance}` };
	});
}

function statusText(pi: ExtensionAPI, ctx: ExtensionContext): string {
	const s = state();
	const classification = classifyModel(ctx.model);
	return [
		`senior-dev status`,
		`configured senior model: ${CONFIG.seniorModel}${CONFIG.seniorThinkingLevel ? ` (${CONFIG.seniorThinkingLevel})` : ""}`,
		`active model: ${modelKey(ctx.model) ?? "(none)"}`,
		`classification: ${classification}`,
		`tool active: ${isSeniorActive(pi)}`,
		`auto policy: active only for configured weak models; strong/neutral models are hidden unless manually enabled`,
		`manual override: ${s.manualOverride ?? "none"}`,
		`attempted calls this session: ${s.attemptedCalls}`,
		`successful calls this session: ${s.successfulCalls}`,
		`debug log: ${debugLogPath()}`,
		s.lastPayloadSamplePath ? `last payload sample: ${s.lastPayloadSamplePath}` : undefined,
		s.lastError ? `last error: ${s.lastError}` : undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function registerCommand(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Manage senior-dev routine steering tool",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "enable") {
				state().manualOverride = "enabled";
				ensureActive(pi);
				ctx.ui.notify("senior_dev manually enabled for this session", "info");
				return;
			}
			if (action === "disable") {
				state().manualOverride = "disabled";
				ensureInactive(pi);
				ctx.ui.notify("senior_dev manually disabled for this session", "info");
				return;
			}
			if (action === "auto") {
				state().manualOverride = undefined;
				applyActiveToolPolicy(pi, ctx);
				ctx.ui.notify("senior_dev returned to automatic model-aware policy", "info");
				return;
			}
			if (action === "status" || action === "debug") {
				ctx.ui.notify(statusText(pi, ctx), "info");
				return;
			}
			ctx.ui.notify(`Usage: /${COMMAND_NAME} status|debug|enable|disable|auto`, "warning");
		},
	});
}

export default function (pi: ExtensionAPI) {
	registerSeniorTool(pi);
	registerCommand(pi);
	registerPolicyHooks(pi);
}
