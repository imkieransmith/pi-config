import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "response-metrics";

export type ResponseMetricsData = {
  elapsedMs: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
};

type ActiveRun = {
  startedAt: number;
  assistantMessages: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
};

function startRun(): ActiveRun {
  return {
    startedAt: Date.now(),
    assistantMessages: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function isAssistantMessage(message: { role: string }): message is AssistantMessage {
  return message.role === "assistant";
}

export function formatDuration(elapsedMs: number): string {
  const ms = Math.max(0, Math.round(elapsedMs));
  if (ms < 1_000) return `${ms}ms`;

  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

export function formatTokens(tokens: number): string {
  const value = Math.max(0, Math.round(tokens));
  if (value < 1_000) return value.toString();
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatMetricsRow(metrics: ResponseMetricsData): string {
  const tools = `${metrics.toolCalls} ${metrics.toolCalls === 1 ? "tool call" : "tool calls"}`;
  return `⏱ ${formatDuration(metrics.elapsedMs)} │ ${tools} │ ↑ ${formatTokens(metrics.inputTokens)} │ ↓ ${formatTokens(metrics.outputTokens)}`;
}

function isMetricsData(value: unknown): value is ResponseMetricsData {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<ResponseMetricsData>;
  return [data.elapsedMs, data.toolCalls, data.inputTokens, data.outputTokens]
    .every((item) => typeof item === "number" && Number.isFinite(item));
}

export default function (pi: ExtensionAPI) {
  let activeRun: ActiveRun | undefined;

  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
    const metrics = isMetricsData(entry.data) ? entry.data : undefined;
    const row = metrics ? formatMetricsRow(metrics) : "Response metrics unavailable";

    return {
      invalidate() {},
      render(width: number): string[] {
        return [truncateToWidth(theme.fg("dim", row), Math.max(0, width))];
      },
    };
  });

  pi.on("session_start", async () => {
    activeRun = undefined;
  });

  pi.on("before_agent_start", async () => {
    activeRun = startRun();
  });

  // Most runs begin with before_agent_start. This fallback also covers an
  // extension-triggered agent loop that starts without a new user prompt.
  pi.on("agent_start", async () => {
    activeRun ??= startRun();
  });

  pi.on("tool_execution_start", async () => {
    if (activeRun) activeRun.toolCalls += 1;
  });

  pi.on("message_end", async (event) => {
    if (!activeRun || !isAssistantMessage(event.message)) return;
    activeRun.assistantMessages += 1;
    activeRun.inputTokens += event.message.usage.input;
    activeRun.outputTokens += event.message.usage.output;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const completedRun = activeRun;
    activeRun = undefined;

    if (!completedRun || completedRun.assistantMessages === 0 || ctx.mode !== "tui") return;

    const metrics: ResponseMetricsData = {
      elapsedMs: Math.max(0, Date.now() - completedRun.startedAt),
      toolCalls: completedRun.toolCalls,
      inputTokens: completedRun.inputTokens,
      outputTokens: completedRun.outputTokens,
    };

    pi.appendEntry(ENTRY_TYPE, metrics);
  });
}
