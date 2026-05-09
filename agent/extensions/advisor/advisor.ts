/**
 * advisor tool + /advisor command — Advisor-strategy pattern.
 *
 * Lets the executor model consult a stronger advisor model (e.g. Opus) via an
 * in-process completeSimple() call with a bounded diagnostic extract by default,
 * or an explicit full-branch payload when selected. Advisor has no tools, never emits user-facing output, and returns
 * guidance (plan, correction, or stop signal) that the executor resumes with.
 *
 * Default state is OFF — the tool is registered at load but a before_agent_start
 * handler strips it from the active tool list each turn while no advisor model
 * is selected. /advisor opens a selector panel (ctx.ui.custom) to pick an
 * advisor model from ctx.modelRegistry.getAvailable() and toggles the tool in
 * via pi.setActiveTools(). Selection is in-memory and resets each session.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model, StopReason, Usage } from "@earendil-works/pi-ai";
import { completeSimple, getSupportedThinkingLevels, type Message, type ThinkingLevel } from "@earendil-works/pi-ai";
import {
    type AgentToolResult,
    type AgentToolUpdateCallback,
    convertToLlm,
    type ExtensionAPI,
    type ExtensionContext,
    type SessionEntry,
    type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { showAdvisorPicker, showContextModePicker, showEffortPicker } from "./advisor-ui.js";

// ---------------------------------------------------------------------------
// Constants — grouped by concern, flat named consts (no namespaced objects)
// ---------------------------------------------------------------------------

// Tool identity
export const ADVISOR_TOOL_NAME = "advisor";
const TOOL_LABEL = "Advisor";

// Persistence
const CONFIG_DIR = join(homedir(), ".config", "rpiv-advisor");
const ADVISOR_CONFIG_PATH = join(CONFIG_DIR, "advisor.json");
const CONFIG_FILE_MODE = 0o600;

// Selector sentinels — double-underscore form is collision-proof against real provider:id keys
const NO_ADVISOR_VALUE = "__no_advisor__";
const OFF_VALUE = "__off__";

// Context modes
export type AdvisorContextMode = "diagnostic" | "full_branch" | "nuclear";
const DEFAULT_CONTEXT_MODE: AdvisorContextMode = "diagnostic";
const DIAGNOSTIC_MESSAGE_BUDGET = 24;
const DIAGNOSTIC_CHAR_BUDGET = 60_000;
const DIAGNOSTIC_TEXT_PART_CHAR_LIMIT = 12_000;
const DIAGNOSTIC_TOOL_PART_CHAR_LIMIT = 4_000;
const DIAGNOSTIC_PRIOR_USER_CHAR_LIMIT = 4_000;
const DIAGNOSTIC_DETAIL_CHAR_LIMIT = 4_000;

// Effort levels
const BASE_EFFORT_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high"];
const XHIGH_EFFORT_LEVEL: ThinkingLevel = "xhigh";
const DEFAULT_EFFORT: ThinkingLevel = "medium";
const RECOMMENDED_EFFORT_SUFFIX = "  (recommended)";

// UI — labels used by command flow; panel prose/titles live in advisor-ui.ts
const CHECKMARK = " ✓";

// Messages (static)
const MSG_ADVISOR_DISABLED = "Advisor disabled";
const MSG_REQUIRES_INTERACTIVE = "/advisor requires interactive mode";
const MSG_ADVISOR_NUDGE = "Please advise on the executor's situation above.";
const MSG_ADVISOR_PERMISSION_TITLE = "Allow advisor call?";
const MSG_ADVISOR_PERMISSION_DENIED = "Advisor call blocked by the user: this problem doesn't require escalation to the advisor yet, have another go at it yourself, think through the problem carefully, what has been missed? Why?";
const MSG_ADVISOR_PERMISSION_NO_UI = "Advisor call requires user approval (no UI to confirm)";

// Errors (static)
const ERR_NO_MODEL = "No advisor model is configured. The user can enable one with the /advisor command.";
const ERR_CALL_ABORTED = "Advisor call was cancelled before it completed.";
const ERR_EMPTY_RESPONSE = "Advisor returned no text content.";
const ERR_NO_MODEL_SELECTED = "no advisor model selected";
const ERR_EMPTY_RESPONSE_DETAIL = "empty response";
const ERR_ABORTED_DETAIL = "aborted";
const ERR_UNKNOWN = "unknown error";

// Errors/messages (parameterized)
const errMisconfigured = (label: string, err: string) => `Advisor (${label}) is misconfigured: ${err}`;
const errNoApiKey = (label: string) => `Advisor (${label}) has no API key available.`;
const errNoApiKeyDetail = (provider: string) => `no API key for ${provider}`;
const errCallFailed = (err: string | undefined) => `Advisor call failed: ${err ?? ERR_UNKNOWN}`;
const errCallThrew = (msg: string) => `Advisor call threw: ${msg}`;
const errSelectionNotFound = (choice: string) => `Advisor selection not found: ${choice}`;
const errModelUnavailable = (key: string) => `Previously configured advisor model ${key} is no longer available`;
const msgAdvisorEnabled = (label: string, effort: ThinkingLevel | undefined, mode: AdvisorContextMode) =>
    `Advisor: ${label}${effort ? `, ${effort}` : ""}, ${contextModeLabel(mode)}`;
const msgAdvisorRestored = (label: string, effort: ThinkingLevel | undefined, mode: AdvisorContextMode) =>
    `Advisor restored: ${label}${effort ? `, ${effort}` : ""}, ${contextModeLabel(mode)}`;
const msgConsulting = (
    label: string,
    effort: ThinkingLevel | undefined,
    mode: AdvisorContextMode,
    stats: AdvisorPayloadStats,
) =>
    `Consulting advisor (${label}${effort ? `, ${effort}` : ""}, ${contextModeLabel(mode)}) — ${stats.messageCount} messages, ~${stats.approxTokens.toLocaleString()} rough tokens…`;
const msgAdvisorPermissionDetail = (
    label: string | undefined,
    effort: ThinkingLevel | undefined,
    mode: AdvisorContextMode,
    stats: AdvisorPayloadStats,
) => {
    const target = label ? `Advisor model: ${label}${effort ? ` (${effort})` : ""}.` : "No advisor model is currently selected.";
    return [
        "The agent wants to consult the advisor tool.",
        target,
        `Context mode: ${contextModeLabel(mode)}. ${contextModeWarning(mode)}`,
        `Preflight estimate: ${stats.messageCount} messages, ${stats.chars.toLocaleString()} chars, ~${stats.approxTokens.toLocaleString()} rough tokens.`,
        `Breakdown: ${stats.inventoryChars.toLocaleString()} inventory chars, ${stats.contextChars.toLocaleString()} context chars.`,
        `Inventory: ${stats.activeToolCount} active executor tools${stats.inventoryIncluded ? "" : " (none forwarded)"}; advisor itself is excluded.`,
        mode === "diagnostic"
            ? `Diagnostic extract: ${stats.forwardedBranchMessageCount}/${stats.branchMessageCount} branch messages represented; ${stats.diagnosticOmittedBranchMessages.toLocaleString()} older messages omitted; ${stats.diagnosticTruncated ? "large content was truncated" : "no truncation needed"}.`
            : `Full branch: ${stats.forwardedBranchMessageCount}/${stats.branchMessageCount} branch messages forwarded.`,
    ].join("\n\n");
};

// ---------------------------------------------------------------------------
// Config file persistence (cross-session)
// ---------------------------------------------------------------------------

interface AdvisorConfig {
    modelKey?: string;
    effort?: ThinkingLevel;
    contextMode?: AdvisorContextMode;
}

export function loadAdvisorConfig(): AdvisorConfig {
    if (!existsSync(ADVISOR_CONFIG_PATH)) return {};
    try {
        return JSON.parse(readFileSync(ADVISOR_CONFIG_PATH, "utf-8")) as AdvisorConfig;
    } catch {
        return {};
    }
}

export function saveAdvisorConfig(
    key: string | undefined,
    effort: ThinkingLevel | undefined,
    contextMode: AdvisorContextMode | undefined,
): void {
    const config: AdvisorConfig = {};
    if (key) config.modelKey = key;
    if (effort) config.effort = effort;
    if (contextMode) config.contextMode = contextMode;
    try {
        mkdirSync(dirname(ADVISOR_CONFIG_PATH), { recursive: true });
        writeFileSync(ADVISOR_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    } catch {
        // write may fail on disk-full or permission errors — best effort only
    }
    try {
        chmodSync(ADVISOR_CONFIG_PATH, CONFIG_FILE_MODE);
    } catch {
        // chmod may fail on some filesystems — best effort only
    }
}

function parseModelKey(key: string): { provider: string; modelId: string } | undefined {
    const idx = key.indexOf(":");
    if (idx < 1) return undefined;
    return { provider: key.slice(0, idx), modelId: key.slice(idx + 1) };
}

function isAdvisorContextMode(value: unknown): value is AdvisorContextMode {
    return value === "full_branch" || value === "nuclear" || value === "diagnostic";
}

function normalizeContextMode(value: string | undefined): AdvisorContextMode {
    return isAdvisorContextMode(value) ? value : DEFAULT_CONTEXT_MODE;
}

function contextModeLabel(mode: AdvisorContextMode): string {
    if (mode === "full_branch") return "full branch";
    if (mode === "nuclear") return "nuclear";
    return "diagnostic";
}

function contextModeWarning(mode: AdvisorContextMode): string {
    if (mode === "diagnostic") {
        return "Diagnostic mode forwards a bounded text extract of recent context. If that is insufficient, rerun in full-branch mode.";
    }
    if (mode === "nuclear") {
        return "NUCLEAR mode forwards the whole sanitized branch and is intended for premium-model, high-cost escalation only.";
    }
    return "Full-branch mode forwards the whole sanitized branch. This can be expensive.";
}

// ---------------------------------------------------------------------------
// System prompt — loaded once at module init from prompts/advisor-system.txt
// ---------------------------------------------------------------------------

export const ADVISOR_SYSTEM_PROMPT = readFileSync(
    fileURLToPath(new URL("./prompts/advisor-system.txt", import.meta.url)),
    "utf-8",
).trimEnd();

// ---------------------------------------------------------------------------
// Inventory state + serializer — stable tool-inventory Message for cache parity
//
// globalThis-keyed to survive module re-import on /new, /fork, /resume (mirrors
// rpiv-btw/btw.ts:37, 87-98). Single-slot cache — the Pi tool registry is
// process-scoped, so per-session keying would be redundant. Cache invalidates
// when active tool names, descriptions, or parameter schemas change.
// ---------------------------------------------------------------------------

const ADVISOR_STATE_KEY = Symbol.for("rpiv-advisor");

interface AdvisorState {
    inventorySignature?: string;
    inventoryMessage?: Message;
}

function getAdvisorRuntimeState(): AdvisorState {
    const g = globalThis as unknown as { [k: symbol]: AdvisorState | undefined };
    let state = g[ADVISOR_STATE_KEY];
    if (!state) {
        state = {};
        g[ADVISOR_STATE_KEY] = state;
    }
    return state;
}

// Recursive key-sorted JSON serializer — matches JSON.stringify semantics
// (drops `undefined` in objects, emits `null` for `undefined` in arrays) but
// guarantees stable key ordering across V8 insertion-order variation. Required
// because nested TypeBox schemas may be authored in any order, and prompt
// caching is byte-sensitive.
export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
    }
    const obj = value as Record<string, unknown>;
    const entries: string[] = [];
    for (const k of Object.keys(obj).sort()) {
        const v = obj[k];
        if (v === undefined) continue;
        entries.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
    }
    return `{${entries.join(",")}}`;
}

function buildInventoryBlock(tools: ToolInfo[]): string {
    // Omit `sourceInfo` — its `path` field is install-location-dependent and
    // would bust cache parity across machines/reinstalls.
    return tools
        .map((t) => `### ${t.name}\n${t.description}\n\nParameters: ${stableStringify(t.parameters)}`)
        .join("\n\n---\n\n");
}

// Strip the executor's in-flight advisor() toolCall from the tail assistant
// message. That call is what invoked *us* — there is no matching toolResult
// yet, and providers (Anthropic, GLM/zai, OpenAI) reject payloads with orphan
// toolCalls. Name-targeted to leave any other trailing toolCalls visible.
export function stripInflightAdvisorCall(messages: Message[]): Message[] {
    if (messages.length === 0) return messages;
    const last = messages[messages.length - 1];
    if (last.role !== "assistant") return messages;
    const filtered = last.content.filter((c) => !(c.type === "toolCall" && c.name === ADVISOR_TOOL_NAME));
    if (filtered.length === last.content.length) return messages;
    if (filtered.length === 0) return messages.slice(0, -1);
    return [...messages.slice(0, -1), { ...last, content: filtered }];
}

// Some providers (recent Anthropic Claude models) reject payloads ending on an
// assistant turn ("This model does not support assistant message prefill. The
// conversation must end with a user message."). After stripInflightAdvisorCall
// the tail can be assistant (e.g. the executor wrote thinking text before
// calling advisor). Append a minimal user-role nudge to guarantee user-tail.
export function ensureUserTailForAdvisor(messages: Message[]): Message[] {
    if (messages.length === 0) return messages;
    const last = messages[messages.length - 1];
    if (last.role !== "assistant") return messages;
    const nudge: Message = {
        role: "user",
        content: [{ type: "text", text: MSG_ADVISOR_NUDGE }],
        timestamp: Date.now(),
    };
    return [...messages, nudge];
}

function activeToolInventory(pi: ExtensionAPI): ToolInfo[] {
    const activeToolNames = new Set(pi.getActiveTools().filter((name) => name !== ADVISOR_TOOL_NAME));
    return pi.getAllTools().filter((tool) => activeToolNames.has(tool.name));
}

function toolInventorySignature(tools: ToolInfo[]): string {
    return stableStringify(
        tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        })),
    );
}

// Returns `undefined` when no active executor tools exist so callers can skip
// prepending an empty block that would still cost a cache unit.
export function getInventoryMessage(tools: ToolInfo[]): Message | undefined {
    if (tools.length === 0) return undefined;
    const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const signature = toolInventorySignature(sorted);
    const state = getAdvisorRuntimeState();
    if (state.inventorySignature === signature && state.inventoryMessage) {
        return state.inventoryMessage;
    }
    const text = `## Active Executor Tools\n\n${buildInventoryBlock(sorted)}`;
    const message: Message = {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
    };
    state.inventorySignature = signature;
    state.inventoryMessage = message;
    return message;
}

// ---------------------------------------------------------------------------
// Module state — in-memory, resets each session
// ---------------------------------------------------------------------------

let selectedAdvisor: Model<Api> | undefined;
let selectedAdvisorEffort: ThinkingLevel | undefined;
let selectedAdvisorContextMode: AdvisorContextMode = DEFAULT_CONTEXT_MODE;

export function getAdvisorModel(): Model<Api> | undefined {
    return selectedAdvisor;
}

export function setAdvisorModel(model: Model<Api> | undefined): void {
    selectedAdvisor = model;
}

export function getAdvisorEffort(): ThinkingLevel | undefined {
    return selectedAdvisorEffort;
}

export function setAdvisorEffort(effort: ThinkingLevel | undefined): void {
    selectedAdvisorEffort = effort;
}

export function getAdvisorContextMode(): AdvisorContextMode {
    return selectedAdvisorContextMode;
}

export function setAdvisorContextMode(mode: AdvisorContextMode): void {
    selectedAdvisorContextMode = mode;
}

// ---------------------------------------------------------------------------
// Session restoration — called from index.ts session_start handler
// ---------------------------------------------------------------------------

export function restoreAdvisorState(ctx: ExtensionContext, pi: ExtensionAPI): void {
    const config = loadAdvisorConfig();
    if (!config.modelKey) return;

    const parsed = parseModelKey(config.modelKey);
    if (!parsed) return;

    const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
    if (!model) {
        if (ctx.hasUI) {
            ctx.ui.notify(errModelUnavailable(config.modelKey), "warning");
        }
        return;
    }

    const contextMode = normalizeContextMode(config.contextMode);
    setAdvisorModel(model);
    setAdvisorContextMode(contextMode);
    if (config.effort) {
        setAdvisorEffort(config.effort);
    }

    const active = pi.getActiveTools();
    if (!active.includes(ADVISOR_TOOL_NAME)) {
        pi.setActiveTools([...active, ADVISOR_TOOL_NAME]);
    }

    if (ctx.hasUI) {
        ctx.ui.notify(msgAdvisorRestored(`${model.provider}:${model.id}`, config.effort, contextMode), "info");
    }
}

// ---------------------------------------------------------------------------
// Core execute logic — curate context, call advisor, return structured result
// ---------------------------------------------------------------------------

export interface AdvisorPayloadStats {
    chars: number;
    approxTokens: number;
    messageCount: number;
    inventoryChars: number;
    contextChars: number;
    contextMode: AdvisorContextMode;
    activeToolCount: number;
    branchMessageCount: number;
    forwardedBranchMessageCount: number;
    diagnosticOmittedBranchMessages: number;
    diagnosticTruncated: boolean;
    inventoryIncluded: boolean;
}

export interface AdvisorPayload {
    messages: Message[];
    mode: AdvisorContextMode;
    stats: AdvisorPayloadStats;
}

export interface AdvisorDetails {
    advisorModel?: string;
    effort?: ThinkingLevel;
    contextMode?: AdvisorContextMode;
    payloadStats?: AdvisorPayloadStats;
    usage?: Usage;
    stopReason?: StopReason;
    errorMessage?: string;
}

interface RenderedText {
    text: string;
    truncated: boolean;
}

interface DiagnosticContextResult {
    message: Message;
    representedCount: number;
    omittedCount: number;
    truncated: boolean;
}

function truncateText(text: string, maxChars: number): RenderedText {
    if (text.length <= maxChars) return { text, truncated: false };
    const omitted = text.length - maxChars;
    const marker = `\n...[truncated ${omitted.toLocaleString()} chars]`;
    const keep = Math.max(0, maxChars - marker.length);
    return { text: `${text.slice(0, keep)}${marker}`, truncated: true };
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function sanitizeForDiagnostic(value: unknown, stringLimit = DIAGNOSTIC_TOOL_PART_CHAR_LIMIT, depth = 0): unknown {
    if (typeof value === "string") {
        return truncateText(value, stringLimit).text;
    }
    if (value === null || typeof value !== "object") return value;
    if (depth >= 6) return "[omitted nested object]";
    if (Array.isArray(value)) {
        const items = value.slice(0, 50).map((item) => sanitizeForDiagnostic(item, stringLimit, depth + 1));
        if (value.length > items.length) items.push(`[omitted ${value.length - items.length} array item(s)]`);
        return items;
    }
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
        const item = input[key];
        if ((key === "data" || key === "base64") && typeof item === "string" && item.length > 120) {
            output[key] = `[omitted ${item.length.toLocaleString()} chars]`;
            continue;
        }
        output[key] = sanitizeForDiagnostic(item, stringLimit, depth + 1);
    }
    return output;
}

function renderUnknown(value: unknown, maxChars: number): RenderedText {
    const raw =
        typeof value === "string"
            ? value
            : (() => {
                  try {
                      const rendered = stableStringify(sanitizeForDiagnostic(value, maxChars));
                      return typeof rendered === "string" ? rendered : "";
                  } catch {
                      return String(value ?? "");
                  }
              })();
    return truncateText(raw, maxChars);
}

function renderTextOrImagePart(part: unknown, textLimit: number): RenderedText {
    const record = asRecord(part);
    if (record.type === "text") {
        return renderUnknown(record.text, textLimit);
    }
    if (record.type === "image") {
        const mime = typeof record.mimeType === "string" ? record.mimeType : "image";
        const dataLength = typeof record.data === "string" ? record.data.length : 0;
        return { text: `[image: ${mime}; ${dataLength.toLocaleString()} data chars omitted]`, truncated: dataLength > 0 };
    }
    return renderUnknown(record, textLimit);
}

function renderAssistantPart(part: unknown): RenderedText {
    const record = asRecord(part);
    if (record.type === "text") return renderUnknown(record.text, DIAGNOSTIC_TEXT_PART_CHAR_LIMIT);
    if (record.type === "thinking") {
        const rendered = renderUnknown(record.thinking, DIAGNOSTIC_TEXT_PART_CHAR_LIMIT);
        return { text: `THINKING\n${rendered.text}`, truncated: rendered.truncated };
    }
    if (record.type === "toolCall") {
        const name = typeof record.name === "string" ? record.name : "unknown";
        const rendered = renderUnknown(record.arguments, DIAGNOSTIC_TOOL_PART_CHAR_LIMIT);
        return { text: `TOOL CALL: ${name}\nArguments: ${rendered.text}`, truncated: rendered.truncated };
    }
    return renderUnknown(record, DIAGNOSTIC_TOOL_PART_CHAR_LIMIT);
}

function userMessageText(message: Message, maxChars: number): RenderedText {
    if (message.role !== "user") return { text: "", truncated: false };
    if (typeof message.content === "string") return truncateText(message.content, maxChars);
    let truncated = false;
    const text = message.content
        .map((part) => {
            const rendered = renderTextOrImagePart(part, maxChars);
            truncated ||= rendered.truncated;
            return rendered.text;
        })
        .join("\n")
        .trim();
    return { text, truncated };
}

function renderDiagnosticMessage(message: Message, absoluteIndex: number): RenderedText {
    let truncated = false;
    let body: string;

    if (message.role === "user") {
        const rendered = userMessageText(message, DIAGNOSTIC_TEXT_PART_CHAR_LIMIT);
        truncated ||= rendered.truncated;
        body = rendered.text;
    } else if (message.role === "assistant") {
        body = message.content
            .map((part, partIndex) => {
                const rendered = renderAssistantPart(part);
                truncated ||= rendered.truncated;
                return `  [${partIndex + 1}] ${rendered.text}`;
            })
            .join("\n");
    } else {
        const parts = message.content.map((part, partIndex) => {
            const rendered = renderTextOrImagePart(part, DIAGNOSTIC_TOOL_PART_CHAR_LIMIT);
            truncated ||= rendered.truncated;
            return `  [${partIndex + 1}] ${rendered.text}`;
        });
        const details = message.details === undefined ? undefined : renderUnknown(message.details, DIAGNOSTIC_DETAIL_CHAR_LIMIT);
        if (details?.truncated) truncated = true;
        body = [
            `Tool: ${message.toolName}`,
            `Status: ${message.isError ? "error" : "ok"}`,
            ...parts,
            details ? `Details: ${details.text}` : undefined,
        ]
            .filter((line): line is string => line !== undefined)
            .join("\n");
    }

    return {
        text: `#${absoluteIndex + 1} ${message.role.toUpperCase()}\n${body || "(empty)"}`,
        truncated,
    };
}

function buildDiagnosticContextMessage(messages: Message[]): DiagnosticContextResult {
    const tailStart = Math.max(0, messages.length - DIAGNOSTIC_MESSAGE_BUDGET);
    const tail = messages.slice(tailStart);
    let truncated = false;

    const priorUser = tail.some((message) => message.role === "user")
        ? undefined
        : [...messages.slice(0, tailStart)].reverse().find((message) => message.role === "user");
    const priorUserText = priorUser ? userMessageText(priorUser, DIAGNOSTIC_PRIOR_USER_CHAR_LIMIT) : undefined;
    if (priorUserText?.truncated) truncated = true;

    const renderedMessages = tail.map((message, idx) => {
        const rendered = renderDiagnosticMessage(message, tailStart + idx);
        truncated ||= rendered.truncated;
        return rendered.text;
    });

    let representedCount = renderedMessages.length;
    let body = renderedMessages.join("\n\n---\n\n") || "(no recent messages)";
    while (body.length > DIAGNOSTIC_CHAR_BUDGET && renderedMessages.length > 1) {
        renderedMessages.shift();
        representedCount -= 1;
        truncated = true;
        body = renderedMessages.join("\n\n---\n\n");
    }

    const omittedCount = Math.max(0, messages.length - representedCount);
    const header = [
        "## Diagnostic Context Extract",
        "This is a bounded, text-only extract of the recent executor trace. Older messages and large tool outputs may be omitted or truncated to control advisor cost.",
        `Raw branch messages: ${messages.length.toLocaleString()}. Represented recent messages: ${representedCount.toLocaleString()}. Omitted older messages: ${omittedCount.toLocaleString()}.`,
        priorUserText?.text ? `## Most Recent Prior User Message\n${priorUserText.text}` : undefined,
        "## Recent Trace",
    ].filter((line): line is string => line !== undefined);

    const clipped = truncateText(`${header.join("\n\n")}\n\n${body}`, DIAGNOSTIC_CHAR_BUDGET);
    truncated ||= clipped.truncated;

    return {
        message: {
            role: "user",
            content: [{ type: "text", text: clipped.text }],
            timestamp: Date.now(),
        },
        representedCount,
        omittedCount,
        truncated,
    };
}

function roughPayloadStats(
    messages: Message[],
    inventoryMessage: Message | undefined,
    contextMessages: Message[],
    mode: AdvisorContextMode,
    activeToolCount: number,
    branchMessageCount: number,
    forwardedBranchMessageCount: number,
    diagnosticOmittedBranchMessages: number,
    diagnosticTruncated: boolean,
): AdvisorPayloadStats {
    const chars = JSON.stringify({ systemPrompt: ADVISOR_SYSTEM_PROMPT, messages, tools: [] }).length;
    const inventoryChars = inventoryMessage ? JSON.stringify([inventoryMessage]).length : 0;
    const contextChars = JSON.stringify(contextMessages).length;
    return {
        chars,
        approxTokens: Math.ceil(chars / 4),
        messageCount: messages.length,
        inventoryChars,
        contextChars,
        contextMode: mode,
        activeToolCount,
        branchMessageCount,
        forwardedBranchMessageCount,
        diagnosticOmittedBranchMessages,
        diagnosticTruncated,
        inventoryIncluded: Boolean(inventoryMessage),
    };
}

export function buildAdvisorPayload(ctx: ExtensionContext, pi: ExtensionAPI): AdvisorPayload {
    // Live-read every call — advisor runs mid-turn so any message_end snapshot
    // is always one turn stale. convertToLlm is pass-through for user/assistant/
    // toolResult (messages.js:111-114), so element refs are stable across calls
    // via the session store — content-stable output without a snapshot layer.
    const mode = getAdvisorContextMode();
    const branch = ctx.sessionManager.getBranch();
    const agentMessages = branch
        .filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
        .map((e) => e.message);
    const sanitizedBranchMessages = stripInflightAdvisorCall(convertToLlm(agentMessages));
    const activeTools = activeToolInventory(pi);
    const inventoryMessage = getInventoryMessage(activeTools);

    let contextMessages: Message[];
    let forwardedBranchMessageCount: number;
    let diagnosticOmittedBranchMessages = 0;
    let diagnosticTruncated = false;

    if (mode === "diagnostic") {
        const diagnostic = buildDiagnosticContextMessage(sanitizedBranchMessages);
        contextMessages = [
            diagnostic.message,
            { role: "user", content: [{ type: "text", text: MSG_ADVISOR_NUDGE }], timestamp: Date.now() },
        ];
        forwardedBranchMessageCount = diagnostic.representedCount;
        diagnosticOmittedBranchMessages = diagnostic.omittedCount;
        diagnosticTruncated = diagnostic.truncated;
    } else {
        contextMessages = ensureUserTailForAdvisor(sanitizedBranchMessages);
        forwardedBranchMessageCount = contextMessages.length;
    }

    const messages: Message[] = inventoryMessage ? [inventoryMessage, ...contextMessages] : contextMessages;
    const stats = roughPayloadStats(
        messages,
        inventoryMessage,
        contextMessages,
        mode,
        activeTools.length,
        sanitizedBranchMessages.length,
        forwardedBranchMessageCount,
        diagnosticOmittedBranchMessages,
        diagnosticTruncated,
    );
    return { messages, mode, stats };
}

function buildErrorResult(
    advisorLabel: string | undefined,
    userText: string,
    errorMessage: string,
): AgentToolResult<AdvisorDetails> {
    const effort = getAdvisorEffort();
    const contextMode = getAdvisorContextMode();
    return {
        content: [{ type: "text", text: userText }],
        details: advisorLabel
            ? { advisorModel: advisorLabel, effort, contextMode, errorMessage }
            : { effort, contextMode, errorMessage },
    };
}

async function executeAdvisor(
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<AdvisorDetails> | undefined,
): Promise<AgentToolResult<AdvisorDetails>> {
    const advisor = getAdvisorModel();
    if (!advisor) {
        return buildErrorResult(undefined, ERR_NO_MODEL, ERR_NO_MODEL_SELECTED);
    }
    const advisorLabel = `${advisor.provider}:${advisor.id}`;
    const effort = getAdvisorEffort();

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(advisor);
    if (!auth.ok) {
        return buildErrorResult(advisorLabel, errMisconfigured(advisorLabel, auth.error), auth.error);
    }
    if (!auth.apiKey) {
        return buildErrorResult(advisorLabel, errNoApiKey(advisorLabel), errNoApiKeyDetail(advisor.provider));
    }

    const payload = buildAdvisorPayload(ctx, pi);

    onUpdate?.({
        content: [{ type: "text", text: msgConsulting(advisorLabel, effort, payload.mode, payload.stats) }],
        details: { advisorModel: advisorLabel, effort, contextMode: payload.mode, payloadStats: payload.stats },
    });

    try {
        const response = await completeSimple(
            advisor,
            // `tools: []` reaffirms the "never calls tools" contract even when
            // `messages` contains prior toolCall/toolResult blocks (btw.ts:235).
            { systemPrompt: ADVISOR_SYSTEM_PROMPT, messages: payload.messages, tools: [] },
            { apiKey: auth.apiKey, headers: auth.headers, signal, reasoning: effort },
        );

        if (response.stopReason === "aborted") {
            return {
                content: [{ type: "text", text: ERR_CALL_ABORTED }],
                details: {
                    advisorModel: advisorLabel,
                    effort,
                    contextMode: payload.mode,
                    payloadStats: payload.stats,
                    usage: response.usage,
                    stopReason: response.stopReason,
                    errorMessage: response.errorMessage ?? ERR_ABORTED_DETAIL,
                },
            };
        }

        if (response.stopReason === "error") {
            return {
                content: [{ type: "text", text: errCallFailed(response.errorMessage) }],
                details: {
                    advisorModel: advisorLabel,
                    effort,
                    contextMode: payload.mode,
                    payloadStats: payload.stats,
                    usage: response.usage,
                    stopReason: response.stopReason,
                    errorMessage: response.errorMessage,
                },
            };
        }

        const advisorText = response.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n")
            .trim();

        if (!advisorText) {
            return {
                content: [{ type: "text", text: ERR_EMPTY_RESPONSE }],
                details: {
                    advisorModel: advisorLabel,
                    effort,
                    contextMode: payload.mode,
                    payloadStats: payload.stats,
                    usage: response.usage,
                    stopReason: response.stopReason,
                    errorMessage: ERR_EMPTY_RESPONSE_DETAIL,
                },
            };
        }

        return {
            content: [{ type: "text", text: advisorText }],
            details: {
                advisorModel: advisorLabel,
                effort,
                contextMode: payload.mode,
                payloadStats: payload.stats,
                usage: response.usage,
                stopReason: response.stopReason,
            },
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return buildErrorResult(advisorLabel, errCallThrew(message), message);
    }
}

// ---------------------------------------------------------------------------
// Tool registration — zero-param schema, curated description/snippet/guidelines
// ---------------------------------------------------------------------------

const AdvisorParams = Type.Object({});

const ADVISOR_DESCRIPTION =
    "Escalate to a stronger reviewer model for guidance. When you need " +
    "stronger judgment — a complex decision, an ambiguous failure, a problem " +
    "you're circling without progress — escalate to the advisor model for " +
    "guidance, then resume. Takes NO parameters — the extension forwards the " +
    "configured context mode: bounded diagnostic by default, or raw full branch/nuclear when selected.";

const ADVISOR_PROMPT_SNIPPET =
    "Escalate to a stronger reviewer model for guidance when stuck, errors recurring, user reporting issues still happening.";

const ADVISOR_PROMPT_GUIDELINES: string[] = [
    "Call `advisor` when stuck — errors recurring, approach not converging, results that don't fit, when considering a change of approach, or if the user says the issue keeps happening.",
    "Give the advisor's advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim, adapt — a passing self-test is not evidence the advice is wrong, it's evidence your test doesn't check what the advice is checking.",
    "If you've already retrieved data pointing one way and the advisor points another, don't silently switch — surface the conflict in one more `advisor` call (\"I found X, you suggest Y, which constraint breaks the tie?\"). A reconcile call is cheaper than committing to the wrong branch.",
];

export function registerAdvisorTool(pi: ExtensionAPI): void {
    pi.registerTool({
        name: ADVISOR_TOOL_NAME,
        label: TOOL_LABEL,
        description: ADVISOR_DESCRIPTION,
        promptSnippet: ADVISOR_PROMPT_SNIPPET,
        promptGuidelines: ADVISOR_PROMPT_GUIDELINES,
        parameters: AdvisorParams,

        async execute(_toolCallId, _params, signal, onUpdate, ctx) {
            return executeAdvisor(ctx, pi, signal, onUpdate);
        },
    });
}

// ---------------------------------------------------------------------------
// tool_call handler — ask user before spending advisor tokens / forwarding context
// ---------------------------------------------------------------------------

export function registerAdvisorPermissionGate(pi: ExtensionAPI): void {
    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== ADVISOR_TOOL_NAME) return undefined;

        const advisor = getAdvisorModel();
        const label = advisor ? `${advisor.provider}:${advisor.id}` : undefined;
        const effort = getAdvisorEffort();
        const payload = buildAdvisorPayload(ctx, pi);

        if (!ctx.hasUI) {
            return { block: true, reason: MSG_ADVISOR_PERMISSION_NO_UI };
        }

        const ok = await ctx.ui.confirm(
            MSG_ADVISOR_PERMISSION_TITLE,
            msgAdvisorPermissionDetail(label, effort, payload.mode, payload.stats),
        );
        if (!ok) {
            ctx.ui.notify(MSG_ADVISOR_PERMISSION_DENIED, "warning");
            return { block: true, reason: MSG_ADVISOR_PERMISSION_DENIED };
        }

        return undefined;
    });
}

// ---------------------------------------------------------------------------
// before_agent_start handler — strip advisor from active tools when disabled
// ---------------------------------------------------------------------------

export function registerAdvisorBeforeAgentStart(pi: ExtensionAPI): void {
    pi.on("before_agent_start", async () => {
        if (!getAdvisorModel()) {
            const active = pi.getActiveTools();
            if (active.includes(ADVISOR_TOOL_NAME)) {
                pi.setActiveTools(active.filter((n) => n !== ADVISOR_TOOL_NAME));
            }
        }
    });
}

// ---------------------------------------------------------------------------
// /advisor slash command — opens selector panel for picking the advisor model
// ---------------------------------------------------------------------------

function modelKey(m: { provider: string; id: string }): string {
    return `${m.provider}:${m.id}`;
}

export function registerAdvisorCommand(pi: ExtensionAPI): void {
    pi.registerCommand("advisor", {
        description: "Configure the advisor model for the advisor-strategy pattern",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI) {
                ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
                return;
            }

            const availableModels = ctx.modelRegistry.getAvailable();
            const current = getAdvisorModel();
            const currentKey = current ? modelKey(current) : undefined;

            const items: SelectItem[] = availableModels.map((m) => {
                const key = modelKey(m);
                const check = key === currentKey ? CHECKMARK : "";
                return { value: key, label: `${m.name}  (${m.provider})${check}` };
            });
            items.push({
                value: NO_ADVISOR_VALUE,
                label: currentKey === undefined ? `No advisor${CHECKMARK}` : "No advisor",
            });

            const choice = await showAdvisorPicker(ctx, items);
            if (!choice) {
                return;
            }

            const activeTools = pi.getActiveTools();
            const activeHas = activeTools.includes(ADVISOR_TOOL_NAME);

            if (choice === NO_ADVISOR_VALUE) {
                setAdvisorModel(undefined);
                setAdvisorEffort(undefined);
                setAdvisorContextMode(DEFAULT_CONTEXT_MODE);
                saveAdvisorConfig(undefined, undefined, undefined);
                if (activeHas) {
                    pi.setActiveTools(activeTools.filter((n) => n !== ADVISOR_TOOL_NAME));
                }
                ctx.ui.notify(MSG_ADVISOR_DISABLED, "info");
                return;
            }

            const picked = availableModels.find((m) => modelKey(m) === choice);
            if (!picked) {
                ctx.ui.notify(errSelectionNotFound(choice), "error");
                return;
            }

            // Effort picker — only for reasoning-capable models
            let effortChoice: ThinkingLevel | undefined;
            if (picked.reasoning) {
                const levels = getSupportedThinkingLevels(picked).includes("xhigh")
                    ? [...BASE_EFFORT_LEVELS, XHIGH_EFFORT_LEVEL]
                    : BASE_EFFORT_LEVELS;

                const effortItems: SelectItem[] = [
                    { value: OFF_VALUE, label: "off" },
                    ...levels.map((level) => ({
                        value: level,
                        label: level === DEFAULT_EFFORT ? `${level}${RECOMMENDED_EFFORT_SUFFIX}` : level,
                    })),
                ];

                const effortResult = await showEffortPicker(ctx, effortItems, getAdvisorEffort(), DEFAULT_EFFORT);
                if (!effortResult) {
                    return;
                }
                effortChoice = effortResult === OFF_VALUE ? undefined : (effortResult as ThinkingLevel);
            }

            const currentMode = getAdvisorContextMode();
            const modeItems: SelectItem[] = [
                {
                    value: "diagnostic",
                    label: `Diagnostic — bounded extract${currentMode === "diagnostic" ? CHECKMARK : ""}`,
                    description: "Default. Text-only recent trace with hard message/output/char caps.",
                },
                {
                    value: "full_branch",
                    label: `Full branch — expensive exact trace${currentMode === "full_branch" ? CHECKMARK : ""}`,
                    description: "Raw whole branch plus active tool inventory; can be very large.",
                },
                {
                    value: "nuclear",
                    label: `Nuclear — full branch + premium${currentMode === "nuclear" ? CHECKMARK : ""}`,
                    description: "Raw whole branch for premium-model escalation; strongest warning before each call.",
                },
            ];
            const modeResult = await showContextModePicker(ctx, modeItems, currentMode);
            if (!modeResult) {
                return;
            }
            const contextMode = normalizeContextMode(modeResult);

            setAdvisorEffort(effortChoice);
            setAdvisorContextMode(contextMode);
            setAdvisorModel(picked);
            saveAdvisorConfig(modelKey(picked), effortChoice, contextMode);
            if (!activeHas) {
                pi.setActiveTools([...activeTools, ADVISOR_TOOL_NAME]);
            }
            ctx.ui.notify(msgAdvisorEnabled(modelKey(picked), effortChoice, contextMode), "info");
        },
    });
}
