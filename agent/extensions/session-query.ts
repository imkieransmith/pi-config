/**
 * Allows the model to query past sessions for context, decisions, code changes, or other information.
 *
 * Original - https://github.com/tomsej/pi-ext/tree/main/extensions/session-query
 */

import { complete, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	SessionManager,
	convertToLlm,
	getMarkdownTheme,
	serializeConversation,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const QUERY_SYSTEM_PROMPT = `You are a session context assistant. Given a session transcript and a question, provide a concise answer based on the session contents.

Focus on:
- Specific decisions, agreements, and the chosen approach
- What was agreed, what was explicitly rejected, what constraints were set
- File paths and code changes mentioned
- Key context the user is asking about

Be concise and direct. If the information isn't in the transcript, say so.
If the question asks about exact file contents, specific error messages, or precise tool output, note that these details may not be in the transcript and suggest retrying with detailed=true.`;

// Cache local summaries per session path.
const summaryCache = new Map<string, string>();
const TEXT_CAP = 12_000;
const JSON_CAP = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function truncate(text: string, cap: number): string {
	if (text.length <= cap) return text;
	return `${text.slice(0, cap)}\n[... truncated at ${cap} chars ...]`;
}

function redact(text: string): string {
	return text
		.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]")
		.replace(/\b(?:sk|pk|ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/g, "[REDACTED_TOKEN]")
		.replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,}]+/gi, "$1=[REDACTED]");
}

function stringify(value: unknown, cap = JSON_CAP): string {
	try {
		return truncate(JSON.stringify(value, null, 2), cap);
	} catch {
		return String(value);
	}
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((block) => {
			if (!isRecord(block)) return "";
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "thinking" && typeof block.thinking === "string") return `[thinking] ${block.thinking}`;
			if (block.type === "toolCall") return `[tool call] ${String(block.name ?? "unknown")} ${stringify(block.arguments, 2_000)}`;
			if (block.type === "image") return "[image]";
			return stringify(block, 1_000);
		})
		.filter(Boolean)
		.join("\n");
}

function section(title: string, items: string[]): string {
	const cleaned = items.map((item) => item.trim()).filter(Boolean);
	if (cleaned.length === 0) return "";
	return `## ${title}\n\n${cleaned.join("\n\n")}`;
}

function entryPrefix(entry: SessionEntry): string {
	const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : "unknown";
	const timestamp = isRecord(entry) && typeof entry.timestamp === "string" ? entry.timestamp : "unknown-time";
	return `[${timestamp}] (${id})`;
}

function formatMessageEntry(entry: SessionEntry & { type: "message" }): string {
	const message = entry.message as unknown;
	if (!isRecord(message)) return `${entryPrefix(entry)} message\n${stringify(message)}`;

	const role = typeof message.role === "string" ? message.role : "message";
	const text = textFromContent(message.content);
	const meta: string[] = [];
	if (typeof message.toolName === "string") meta.push(`tool=${message.toolName}`);
	if (typeof message.stopReason === "string") meta.push(`stop=${message.stopReason}`);
	if (typeof message.model === "string") meta.push(`model=${message.model}`);

	return `${entryPrefix(entry)} ${role}${meta.length > 0 ? ` (${meta.join(", ")})` : ""}\n${truncate(text || stringify(message), TEXT_CAP)}`;
}

function formatEvidenceState(entry: SessionEntry, data: Record<string, unknown>): string {
	const evidence = isRecord(data.entry) ? data.entry : undefined;
	if (!evidence) return `${entryPrefix(entry)} evidence-state\n${stringify(data)}`;

	return [
		`${entryPrefix(entry)} Evidence ${String(data.type ?? "event")}: ${String(evidence.id ?? "unknown-id")}`,
		`source: ${String(evidence.source ?? "")}`,
		`note: ${String(evidence.note ?? "")}`,
		`createdAt: ${String(evidence.createdAt ?? "")}`,
		`snippet:\n${String(evidence.snippet ?? "")}`,
	].join("\n");
}

function formatEvidenceProofEntry(entry: SessionEntry, data: Record<string, unknown>): string {
	return [
		`${entryPrefix(entry)} Evidence TUI ${String(data.kind ?? "output")}`,
		`createdAt: ${String(data.createdAt ?? "")}`,
		truncate(String(data.content ?? ""), TEXT_CAP),
	].join("\n");
}

function formatContextSnapshotState(entry: SessionEntry, data: Record<string, unknown>): string {
	const persistedType = String(data.type ?? "event");
	const publicTypes: Record<string, string> = {
		save: "start",
		dirty: "changes_observed",
		cancel: "discard",
		restore: "finish",
	};
	const type = publicTypes[persistedType] ?? persistedType;
	const lines = [`${entryPrefix(entry)} ContextSnapshot ${type}`];
	const fields = [
		["checkpointId", "captureId"],
		["summaryId", "summaryId"],
		["label", "label"],
		["reason", "reason"],
		["toolName", "toolName"],
		["forced", "forced"],
		["wasDirty", "changesObserved"],
		["createdAt", "createdAt"],
		["leafId", "leafId"],
	] as const;

	for (const [persistedKey, displayKey] of fields) {
		if (persistedKey in data) lines.push(`${displayKey}: ${String(data[persistedKey])}`);
	}
	if (typeof data.summary === "string") lines.push(`durableSummary:\n${data.summary}`);

	return lines.join("\n");
}

function formatCustomEntry(entry: SessionEntry): string {
	const customType = isRecord(entry) && typeof entry.customType === "string" ? entry.customType : "custom";
	const data = isRecord(entry) ? entry.data : undefined;

	if (customType === "evidence-state" && isRecord(data)) return formatEvidenceState(entry, data);
	if (customType === "evidence-proof" && isRecord(data)) return formatEvidenceProofEntry(entry, data);
	if (customType === "context-snapshot-state" && isRecord(data)) return formatContextSnapshotState(entry, data);

	return `${entryPrefix(entry)} custom ${customType}\n${stringify(data)}`;
}

function formatCustomMessageEntry(entry: SessionEntry): string {
	const customType = isRecord(entry) && typeof entry.customType === "string" ? entry.customType : "custom-message";
	const content = isRecord(entry) ? entry.content : undefined;
	const details = isRecord(entry) ? entry.details : undefined;
	const display = isRecord(entry) && typeof entry.display === "boolean" ? entry.display : undefined;
	const parts = [
		`${entryPrefix(entry)} custom_message ${customType}${display === undefined ? "" : ` display=${display}`}`,
		truncate(textFromContent(content) || stringify(content), TEXT_CAP),
	];
	if (details !== undefined) parts.push(`details:\n${stringify(details, 2_000)}`);
	return parts.join("\n");
}

function formatNonMessageEntry(entry: SessionEntry, includeRaw = false): string {
	let formatted: string;
	switch (entry.type) {
		case "custom":
			formatted = formatCustomEntry(entry);
			break;
		case "custom_message":
			formatted = formatCustomMessageEntry(entry);
			break;
		case "compaction":
			formatted = `${entryPrefix(entry)} compaction tokensBefore=${String((entry as { tokensBefore?: unknown }).tokensBefore ?? "")}\n${String((entry as { summary?: unknown }).summary ?? "")}`;
			break;
		case "branch_summary":
			formatted = `${entryPrefix(entry)} branch_summary from=${String((entry as { fromId?: unknown }).fromId ?? "")}\n${String((entry as { summary?: unknown }).summary ?? "")}`;
			break;
		case "model_change":
			formatted = `${entryPrefix(entry)} model_change provider=${String((entry as { provider?: unknown }).provider ?? "")} model=${String((entry as { modelId?: unknown }).modelId ?? "")}`;
			break;
		case "thinking_level_change":
			formatted = `${entryPrefix(entry)} thinking_level_change ${String((entry as { thinkingLevel?: unknown }).thinkingLevel ?? "")}`;
			break;
		case "label":
			formatted = `${entryPrefix(entry)} label target=${String((entry as { targetId?: unknown }).targetId ?? "")} label=${String((entry as { label?: unknown }).label ?? "")}`;
			break;
		case "session_info":
			formatted = `${entryPrefix(entry)} session_info name=${String((entry as { name?: unknown }).name ?? "")}`;
			break;
		default:
			formatted = `${entryPrefix(entry)} ${entry.type}\n${stringify(entry)}`;
	}

	if (!includeRaw) return formatted;
	return `${formatted}\nraw:\n${stringify(entry)}`;
}

function buildSessionSummary(entries: SessionEntry[]): string {
	const messages: string[] = [];
	const customAndState: string[] = [];
	const sessionEvents: string[] = [];

	for (const entry of entries) {
		if (entry.type === "message") {
			messages.push(formatMessageEntry(entry as SessionEntry & { type: "message" }));
		} else if (entry.type === "custom" || entry.type === "custom_message") {
			customAndState.push(formatNonMessageEntry(entry));
		} else {
			sessionEvents.push(formatNonMessageEntry(entry));
		}
	}

	return redact([
		section("Session Events", sessionEvents),
		section("Extension State And Custom Messages", customAndState),
		section("Message Transcript", messages),
	].filter(Boolean).join("\n\n---\n\n"));
}

function buildRawEntryAppendix(entries: SessionEntry[]): string {
	const nonMessages = entries.filter((entry) => entry.type !== "message");
	if (nonMessages.length === 0) return "";
	return redact(section("Raw And Custom Session Entries", nonMessages.map((entry) => formatNonMessageEntry(entry, true))));
}

function getOrBuildSummary(sessionPath: string, entries: SessionEntry[]): string {
	const cached = summaryCache.get(sessionPath);
	if (cached) return cached;

	const summary = buildSessionSummary(entries);
	if (summary) summaryCache.set(sessionPath, summary);
	return summary;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "session_query",
		label: "Session Query",
		description:
			"Query a previous pi session file for context, decisions, or information. Use when you need to look up what happened in a parent session or any other session.",
		renderResult: (result, _options, theme, _ctx) => {
			const container = new Container();

			const firstContent = result.content[0];
			if (firstContent && firstContent.type === "text") {
				const text = firstContent.text;
				const match = text.match(/\*\*Query:\*\* (.+?)\n\n---\n\n([\s\S]+)/);

				if (match) {
					const [, query, answer] = match;
					container.addChild(new Text(theme.bold("Query: ") + theme.fg("accent", query), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(answer.trim(), 0, 0, getMarkdownTheme(), {
						color: (text: string) => theme.fg("toolOutput", text),
					}));
				} else {
					container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
				}
			}

			return container;
		},
		parameters: Type.Object({
			sessionPath: Type.String({
				description: "Full path to the session file (e.g., /home/user/.pi/agent/sessions/.../session.jsonl)",
			}),
			question: Type.String({
				description: "What you want to know about that session (e.g., 'What files were modified?' or 'What approach was chosen?')",
			}),
			detailed: Type.Optional(Type.Boolean({
				description: "Use full serialized conversation plus raw/custom entries instead of the local searchable summary. Set true only when you need exact file contents, specific error messages, or precise tool output that isn't in the transcript. Much slower and more expensive.",
			})),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { sessionPath, question, detailed } = params;

			const errorResult = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: { error: true },
			});

			if (!sessionPath.endsWith(".jsonl")) {
				return errorResult(`Error: Invalid session path. Expected a .jsonl file, got: ${sessionPath}`);
			}

			try {
				const fs = await import("node:fs");
				if (!fs.existsSync(sessionPath)) {
					return errorResult(`Error: Session file not found: ${sessionPath}`);
				}
			} catch (err) {
				return errorResult(`Error checking session file: ${err}`);
			}

			onUpdate?.({
				content: [{ type: "text", text: `Query${detailed ? " (detailed)" : ""}: ${question}` }],
				details: { status: "loading", question, detailed: !!detailed },
			});

			let sessionManager: SessionManager;
			try {
				sessionManager = SessionManager.open(sessionPath);
			} catch (err) {
				return errorResult(`Error loading session: ${err}`);
			}

			const branch = sessionManager.getBranch();
			const messages = branch
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message);

			if (branch.length === 0) {
				return {
					content: [{ type: "text" as const, text: "Session is empty - no entries found." }],
					details: { empty: true },
				};
			}

			const llmMessages = messages.length > 0 ? convertToLlm(messages) : [];

			// Default: local searchable summary (messages plus custom/session entries)
			// Detailed: full serialized conversation plus raw/custom entry appendix
			let contextText: string;
			let contextLabel: string;
			if (detailed) {
				const conversation = llmMessages.length > 0 ? serializeConversation(llmMessages) : "";
				const appendix = buildRawEntryAppendix(branch);
				contextText = [conversation, appendix].filter(Boolean).join("\n\n---\n\n");
				contextLabel = "Full Session Conversation And Entries";
			} else {
				contextText = getOrBuildSummary(sessionPath, branch);
				contextLabel = "Session Transcript And Entries";
				if (!contextText && llmMessages.length > 0) {
					contextText = serializeConversation(llmMessages);
					contextLabel = "Full Session Conversation";
				}
			}

			// Always use the current session's model — it's available and the user chose it.
			const queryModel = ctx.model;
			if (!queryModel) {
				return errorResult("Error: No model available to analyze the session.");
			}

			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(queryModel);
				if (!auth.ok) {
					return errorResult(`Error querying session: ${auth.error}`);
				}

				const userMessage: Message = {
					role: "user",
					content: [
						{
							type: "text",
							text: `## ${contextLabel}\n\n${contextText}\n\n## Question\n\n${question}`,
						},
					],
					timestamp: Date.now(),
				};

				const response = await complete(
					queryModel,
					{ systemPrompt: QUERY_SYSTEM_PROMPT, messages: [userMessage] },
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						signal,
					},
				);

				if (response.stopReason === "aborted") {
					return {
						content: [{ type: "text" as const, text: "Query was cancelled." }],
						details: { cancelled: true },
					};
				}

				const answer = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");

				return {
					content: [{ type: "text" as const, text: `**Query:** ${question}\n\n---\n\n${answer}` }],
					details: {
						sessionPath,
						question,
						detailed: !!detailed,
						messageCount: messages.length,
					},
				};
			} catch (err) {
				return errorResult(`Error querying session: ${err}`);
			}
		},
	});
}
