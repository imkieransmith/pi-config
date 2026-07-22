/**
 * Advisor engine — shared core for the advisor tool.
 *
 * Builds one bounded, token-budgeted snapshot of the current work and consults a
 * configured reviewer model for a single recommended next move. The same payload
 * is used regardless of the active model; only the *framing* the model sees
 * (liberal vs when-stuck) varies, and that lives in index.ts.
 *
 * Merged from the former `advisor` (rich diagnostic + images) and `senior-dev`
 * (bounded project packet + debug logging) extensions.
 */

import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, ImageContent, Message, Model, StopReason, TextContent, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

export const ADVISOR_TOOL_NAME = "advisor";
const CONTEXT_SNAPSHOT_STATE_TYPE = "context-snapshot-state";

// Per-section and total caps. Expressed in chars; the rough token estimate is
// chars/4. Targets keep a typical payload around ~10-15k tokens; the total cap
// (~50k tokens) only exists so a pathological session cannot blow up cost.
const PAYLOAD = {
	maxTotalChars: 200_000, // ~50k tokens hard ceiling
	maxToolSummaryChars: 2_500,
	maxTodoChars: 8_000, // ~2k tokens
	maxSnapshotChars: 12_000, // ~3k tokens
	maxSnapshotSummaries: 3,
	maxAdvisorResultChars: 6_000, // ~1.5k tokens
	maxConversationChars: 20_000, // ~5k tokens
	maxConversationMessages: 10,
	maxConversationMessageChars: 2_000,
};

const DEBUG = {
	enabled: true,
	dir: join(homedir(), ".pi", "agent", "advisor"),
	logFile: "debug.jsonl",
	payloadSampleEvery: 5, // save every Nth payload for inspection; 0 disables
	payloadSampleOnError: true,
};

export const ADVISOR_SYSTEM_PROMPT = readFileSync(
	fileURLToPath(new URL("./prompts/advisor-system.txt", import.meta.url)),
	"utf-8",
).trimEnd();

// ---------------------------------------------------------------------------
// Runtime state (in-memory, globalThis-keyed to survive module re-import)
// ---------------------------------------------------------------------------

interface RuntimeState {
	attemptedCalls: number;
	successfulCalls: number;
	lastError?: string;
	lastPayloadSamplePath?: string;
	lastCallAt?: number;
}

const STATE_KEY = Symbol.for("pi-advisor-engine-state");

function state(): RuntimeState {
	const g = globalThis as unknown as { [k: symbol]: RuntimeState | undefined };
	if (!g[STATE_KEY]) g[STATE_KEY] = { attemptedCalls: 0, successfulCalls: 0 };
	return g[STATE_KEY]!;
}

export function resetEngineState(): void {
	const s = state();
	s.attemptedCalls = 0;
	s.successfulCalls = 0;
	s.lastError = undefined;
	s.lastPayloadSamplePath = undefined;
	s.lastCallAt = undefined;
}

export function engineStats(): RuntimeState {
	return state();
}

export function debugLogPath(): string {
	return join(DEBUG.dir, DEBUG.logFile);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function approxTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

export function modelKey(model: { provider: string; id: string } | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

function truncateText(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[... truncated at ${maxChars.toLocaleString()} chars ...]`;
}

function visibleTextOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.filter((text) => text.trim().length > 0)
		.join("\n")
		.trim();
}

function formatTimestamp(value: unknown): string | undefined {
	let ms: number | undefined;
	if (typeof value === "number") ms = value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) ms = parsed;
	}
	if (ms === undefined || !Number.isFinite(ms)) return undefined;
	return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Payload extractors
// ---------------------------------------------------------------------------

function briefToolSummary(pi: ExtensionAPI): string {
	const active = new Set(pi.getActiveTools().filter((name) => name !== ADVISOR_TOOL_NAME));
	const tools = pi
		.getAllTools()
		.filter((tool: ToolInfo) => active.has(tool.name))
		.sort((a, b) => a.name.localeCompare(b.name));
	if (tools.length === 0) return "(no other active tools)";

	const lines = tools.map((tool) => {
		const firstLine = (tool.description || "").split("\n")[0].trim();
		const short = firstLine.length > 100 ? `${firstLine.slice(0, 99)}…` : firstLine;
		return `- ${tool.name}${short ? `: ${short}` : ""}`;
	});
	return truncateText(lines.join("\n"), PAYLOAD.maxToolSummaryChars);
}

function readTodoMd(ctx: ExtensionContext): string {
	try {
		const content = readFileSync(join(ctx.cwd, "TODO.md"), "utf-8").trim();
		return truncateText(content || "(TODO.md is empty)", PAYLOAD.maxTodoChars);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return `(TODO.md unavailable: ${message})`;
	}
}

function latestContextSnapshotSummaries(ctx: ExtensionContext): string {
	const summaries = ctx.sessionManager
		.getBranch()
		.map((entry) => {
			if (entry.type !== "custom" || entry.customType !== CONTEXT_SNAPSHOT_STATE_TYPE || !isRecord(entry.data)) return undefined;
			if (entry.data.type !== "restore" || typeof entry.data.summary !== "string") return undefined;
			return {
				id: typeof entry.data.summaryId === "string" ? entry.data.summaryId : "unknown",
				label: typeof entry.data.label === "string" ? entry.data.label : "context snapshot",
				summary: entry.data.summary,
				createdAt: entry.data.createdAt,
			};
		})
		.filter((s): s is { id: string; label: string; summary: string; createdAt: unknown } => s !== undefined)
		.slice(-PAYLOAD.maxSnapshotSummaries)
		.reverse();

	if (summaries.length === 0) return "(no ContextSnapshot durable summaries found)";

	const rendered = summaries
		.map((s) => {
			const when = formatTimestamp(s.createdAt);
			return [`### ${s.id}: ${s.label}${when ? ` (${when})` : ""}`, s.summary].join("\n");
		})
		.join("\n\n");
	return truncateText(rendered, PAYLOAD.maxSnapshotChars);
}

function mostRecentAdvisorResult(ctx: ExtensionContext): string {
	const results = ctx.sessionManager
		.getBranch()
		.map((entry) => {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== ADVISOR_TOOL_NAME) return undefined;
			const text = visibleTextOfContent(entry.message.content);
			if (!text) return undefined;
			return {
				status: entry.message.isError ? "error" : "ok",
				text,
				timestamp: formatTimestamp((entry.message as unknown as Record<string, unknown>).timestamp),
			};
		})
		.filter((r): r is { status: string; text: string; timestamp: string | undefined } => r !== undefined);

	const latest = results.at(-1);
	if (!latest) return "(no prior advisor guidance this session)";
	const title = `Previous advisor result${latest.timestamp ? ` (${latest.timestamp})` : ""} — ${latest.status}`;
	return `${title}\n${truncateText(latest.text, PAYLOAD.maxAdvisorResultChars)}`;
}

function recentConversation(ctx: ExtensionContext): string {
	const messages = ctx.sessionManager
		.getBranch()
		.map((entry) => {
			if (entry.type !== "message") return undefined;
			const { message } = entry;
			if (message.role !== "user" && message.role !== "assistant") return undefined;
			const text = visibleTextOfContent(message.content);
			if (!text) return undefined;
			return {
				role: message.role,
				text: truncateText(text, PAYLOAD.maxConversationMessageChars),
				timestamp: formatTimestamp((message as unknown as Record<string, unknown>).timestamp),
			};
		})
		.filter((m): m is { role: "user" | "assistant"; text: string; timestamp: string | undefined } => m !== undefined)
		.slice(-PAYLOAD.maxConversationMessages);

	if (messages.length === 0) return "(no recent user/assistant text found)";

	const rendered = messages
		.map((m, index) => {
			const role = m.role === "user" ? "USER" : "ASSISTANT";
			return `### ${index + 1}. ${role}${m.timestamp ? ` (${m.timestamp})` : ""}\n${m.text}`;
		})
		.join("\n\n---\n\n");
	return truncateText(rendered, PAYLOAD.maxConversationChars);
}

// ---------------------------------------------------------------------------
// Latest user-message images (ported from the former advisor extension)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function isImageContent(part: unknown): part is ImageContent {
	const record = asRecord(part);
	return record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string";
}

function latestUserMessageRange(messages: Message[]): { start: number; end: number } | undefined {
	let end = -1;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i]?.role === "user") {
			end = i;
			break;
		}
	}
	if (end < 0) return undefined;
	let start = end;
	while (start > 0 && messages[start - 1]?.role === "user") start -= 1;
	return { start, end };
}

interface LatestUserImages {
	message?: Message;
	imageCount: number;
}

function buildLatestUserImagesMessage(messages: Message[]): LatestUserImages {
	const range = latestUserMessageRange(messages);
	if (!range) return { imageCount: 0 };

	const content: Array<TextContent | ImageContent> = [];
	const labels: string[] = [];
	let imageCount = 0;

	for (let index = range.start; index <= range.end; index += 1) {
		const message = messages[index];
		if (!message || message.role !== "user" || typeof message.content === "string") continue;
		const images = message.content.filter(isImageContent);
		if (images.length === 0) continue;
		labels.push(`#${index + 1} (${images.length} image${images.length === 1 ? "" : "s"})`);
		for (const image of images) {
			content.push(image);
			imageCount += 1;
		}
	}

	if (imageCount === 0) return { imageCount: 0 };

	content.unshift({
		type: "text",
		text: [
			"## Latest User Message Images",
			`Forwarding ${imageCount} image(s) attached to the latest user message(s): ${labels.join(", ")}.`,
			"These images are part of the user request; the text snapshot may only contain placeholders. Inspect the attached image content directly when relevant.",
		].join("\n"),
	});

	return { message: { role: "user", content, timestamp: Date.now() }, imageCount };
}

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

export interface AdvisorPayloadStats {
	chars: number; // text-only (system prompt + packet); excludes image data
	approxTokens: number;
	imageCount: number;
}

export interface AdvisorPayload {
	messages: Message[];
	packetText: string;
	stats: AdvisorPayloadStats;
}

export function buildAdvisorPayload(ctx: ExtensionContext, pi: ExtensionAPI): AdvisorPayload {
	const branch = ctx.sessionManager.getBranch();
	const agentMessages = branch
		.filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
		.map((e) => e.message);
	const llmMessages = convertToLlm(agentMessages);
	const images = buildLatestUserImagesMessage(llmMessages);

	const packetText = truncateText(
		[
			"# Advisor consultation",
			"Bounded diagnostic snapshot of the current work. Raw tool traffic, model thinking, large outputs, and older turns are omitted to control cost. Treat omissions as uncertainty: if a critical fact is missing, say exactly what to inspect next.",
			"",
			"## Runtime",
			`cwd: ${ctx.cwd}`,
			`active model: ${modelKey(ctx.model) ?? "(unknown)"}`,
			"",
			"## Active tools",
			briefToolSummary(pi),
			"",
			"## TODO.md",
			readTodoMd(ctx),
			"",
			"## Recent ContextSnapshot durable summaries",
			latestContextSnapshotSummaries(ctx),
			"",
			"## Most recent prior advisor guidance",
			mostRecentAdvisorResult(ctx),
			"",
			"## Recent conversation (user/assistant text only)",
			recentConversation(ctx),
			"",
			"## What to return",
			"Give one recommended next move with concise rationale and checks, using the required headings. If this snapshot is missing critical evidence, say exactly what the executor should inspect.",
		].join("\n"),
		PAYLOAD.maxTotalChars,
	);

	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: packetText }], timestamp: Date.now() },
		...(images.message ? [images.message] : []),
	];

	const chars = ADVISOR_SYSTEM_PROMPT.length + packetText.length;
	return {
		messages,
		packetText,
		stats: { chars, approxTokens: approxTokens(chars), imageCount: images.imageCount },
	};
}

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------

function ensureDebugDir(): void {
	if (!DEBUG.enabled) return;
	try {
		mkdirSync(DEBUG.dir, { recursive: true, mode: 0o700 });
		chmodSync(DEBUG.dir, 0o700);
	} catch {
		// best effort
	}
}

function appendDebug(record: Record<string, unknown>): void {
	if (!DEBUG.enabled) return;
	ensureDebugDir();
	const file = debugLogPath();
	try {
		// Correct an existing log before appending; new logs are private at creation.
		try {
			chmodSync(file, 0o600);
		} catch {
			// File may not exist yet.
		}
		appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600 });
		chmodSync(file, 0o600);
	} catch {
		// debug logging must never break the tool
	}
}

function shouldSavePayload(callNumber: number, success: boolean): boolean {
	if (!DEBUG.enabled) return false;
	if (!success && DEBUG.payloadSampleOnError) return true;
	return DEBUG.payloadSampleEvery > 0 && callNumber % DEBUG.payloadSampleEvery === 0;
}

function writePayloadSample(callNumber: number, payload: string): string | undefined {
	if (!DEBUG.enabled) return undefined;
	ensureDebugDir();
	const file = join(DEBUG.dir, `payload-${String(callNumber).padStart(4, "0")}-${Date.now()}.md`);
	try {
		writeFileSync(file, payload, { encoding: "utf-8", mode: 0o600, flag: "wx" });
		state().lastPayloadSamplePath = file;
		return file;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface AdvisorDetails {
	advisorModel?: string;
	activeModel?: string;
	classification?: string;
	effort?: ThinkingLevel;
	payloadChars?: number;
	estimatedPayloadTokens?: number;
	imageCount?: number;
	responseChars?: number;
	usage?: Usage;
	stopReason?: StopReason | string;
	errorMessage?: string;
	latencyMs?: number;
	debugLog?: string;
	payloadSamplePath?: string;
	callNumber?: number;
}

export interface RunAdvisorParams {
	model: Model<Api>;
	effort: ThinkingLevel | undefined;
	classification: string;
	signal?: AbortSignal;
	onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details?: AdvisorDetails }) => void;
}

function extractText(response: Message): string {
	if (response.role !== "assistant") return "";
	return response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export async function runAdvisor(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	params: RunAdvisorParams,
): Promise<AgentToolResult<AdvisorDetails>> {
	const s = state();
	s.attemptedCalls += 1;
	s.lastCallAt = Date.now();
	const callNumber = s.attemptedCalls;
	const started = Date.now();

	const advisorLabel = modelKey(params.model) ?? `${params.model.provider}/${params.model.id}`;
	const activeModel = modelKey(ctx.model) ?? "unknown";
	let payloadText = "";
	let payloadChars = 0;
	let estimatedPayloadTokens = 0;
	let imageCount = 0;
	let payloadSamplePath: string | undefined;

	const baseDetails = (): AdvisorDetails => ({
		advisorModel: advisorLabel,
		activeModel,
		classification: params.classification,
		effort: params.effort,
		payloadChars,
		estimatedPayloadTokens,
		imageCount,
		debugLog: debugLogPath(),
		callNumber,
	});

	const finishDebug = (record: Record<string, unknown>) => {
		appendDebug({
			timestamp: new Date().toISOString(),
			callNumber,
			sessionFile: ctx.sessionManager.getSessionFile?.(),
			cwd: ctx.cwd,
			advisorModel: advisorLabel,
			activeModel,
			classification: params.classification,
			effort: params.effort,
			payloadChars,
			estimatedPayloadTokens,
			imageCount,
			payloadSamplePath,
			latencyMs: Date.now() - started,
			...record,
		});
	};

	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(params.model);
		if (!auth.ok || !auth.apiKey) {
			const error = !auth.ok
				? auth.error
				: `No request auth available for ${params.model.provider}. If using subscription/OAuth, run /login ${params.model.provider}; otherwise add that provider's API key.`;
			s.lastError = error;
			finishDebug({ success: false, error });
			return { content: [{ type: "text", text: `advisor failed: ${error}` }], details: { ...baseDetails(), errorMessage: error } };
		}

		const payload = buildAdvisorPayload(ctx, pi);
		payloadText = payload.packetText;
		payloadChars = payload.stats.chars;
		estimatedPayloadTokens = payload.stats.approxTokens;
		imageCount = payload.stats.imageCount;

		params.onUpdate?.({
			content: [
				{
					type: "text",
					text: `Consulting advisor (${advisorLabel}${params.effort ? `, ${params.effort}` : ""}) — ~${estimatedPayloadTokens.toLocaleString()} tokens${imageCount ? `, ${imageCount} image(s)` : ""}…`,
				},
			],
			details: baseDetails(),
		});

		const response = await completeSimple(
			params.model,
			{ systemPrompt: ADVISOR_SYSTEM_PROMPT, messages: payload.messages, tools: [] },
			{ apiKey: auth.apiKey, headers: auth.headers, signal: params.signal, reasoning: params.effort },
		);

		const text = extractText(response);
		const latencyMs = Date.now() - started;
		const success = response.stopReason !== "error" && response.stopReason !== "aborted" && Boolean(text);
		payloadSamplePath = shouldSavePayload(callNumber, success) ? writePayloadSample(callNumber, payloadText) : undefined;

		if (!success) {
			const error = response.stopReason === "aborted" ? "advisor call was aborted" : response.errorMessage || "advisor returned no text";
			s.lastError = error;
			finishDebug({ success: false, stopReason: response.stopReason, error, usage: response.usage, responseChars: text.length });
			return {
				content: [{ type: "text", text: `advisor failed: ${error}` }],
				details: { ...baseDetails(), responseChars: text.length, usage: response.usage, stopReason: response.stopReason, errorMessage: error, latencyMs, payloadSamplePath },
			};
		}

		s.successfulCalls += 1;
		s.lastError = undefined;
		finishDebug({ success: true, stopReason: response.stopReason, usage: response.usage, responseChars: text.length });
		return {
			content: [{ type: "text", text }],
			details: { ...baseDetails(), responseChars: text.length, usage: response.usage, stopReason: response.stopReason, latencyMs, payloadSamplePath },
		};
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		s.lastError = error;
		payloadSamplePath = shouldSavePayload(callNumber, false) && payloadText ? writePayloadSample(callNumber, payloadText) : undefined;
		finishDebug({ success: false, error });
		return { content: [{ type: "text", text: `advisor threw: ${error}` }], details: { ...baseDetails(), errorMessage: error, payloadSamplePath } };
	}
}
