/**
 * Pi extension that uses `rtk rewrite` to optimize shell commands.
 *
 * The extension participates in two Pi execution paths:
 * - agent-initiated `bash` tool calls via a replacement bash tool
 * - user-issued `!<cmd>` shell commands via the `user_bash` event
 *
 * In both paths, optimization is best-effort: when `rtk rewrite` succeeds,
 * Pi executes the rewritten command; when rewrite fails, times out, or `rtk`
 * is unavailable, execution falls back to Pi's normal shell behavior.
 *
 * Commands entered with `!!<cmd>` are intentionally not intercepted so the
 * user's choice to exclude shell output from model context is preserved.
 */

import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createLocalBashOperations,
  highlightCode,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";

const REWRITE_TIMEOUT_MS = 5000;
const MESSAGE_CUSTOM_TYPE = "rtk-rewrite";
const COLLAPSED_MAX_LINES = 15;

type RewriteStats = {
  attempts: number;
  rewrites: number;
  failures: number;
  lastOriginal?: string;
  lastRewritten?: string;
};

const rewriteCache = new Map<string, string | undefined>();
const stats: RewriteStats = { attempts: 0, rewrites: 0, failures: 0 };

function rtkRewriteCommand(command: string): string | undefined {
  if (rewriteCache.has(command)) return rewriteCache.get(command);

  stats.attempts++;
  stats.lastOriginal = command;

  try {
    const rewritten = execFileSync("rtk", ["rewrite", command], {
      encoding: "utf-8",
      timeout: REWRITE_TIMEOUT_MS,
    }).trimEnd();
    const result = rewritten && rewritten !== command ? rewritten : undefined;
    if (result) {
      stats.rewrites++;
      stats.lastRewritten = result;
    }
    rewriteCache.set(command, result);
    return result;
  } catch {
    stats.failures++;
    rewriteCache.set(command, undefined);
    return undefined;
  }
}

function formatStatus(): string {
  return [
    "rtk rewrite",
    "status: active, best-effort",
    `attempts: ${stats.attempts}`,
    `rewrites: ${stats.rewrites}`,
    `failures: ${stats.failures}`,
    `cache entries: ${rewriteCache.size}`,
    stats.lastOriginal ? `last original: ${stats.lastOriginal}` : undefined,
    stats.lastRewritten ? `last rewritten: ${stats.lastRewritten}` : undefined,
  ].filter(Boolean).join("\n");
}

function showCommandMessage(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({
    customType: MESSAGE_CUSTOM_TYPE,
    content,
    display: true,
    details: {},
  }, { triggerTurn: false });
}

function bashPill(theme: Theme): string {
  return theme.bold(theme.inverse(theme.fg("error", " bash ")));
}

function getText(result: AgentToolResult<unknown>): string | undefined {
  const c = result.content.find((c) => c.type === "text");
  return c?.type === "text" ? c.text : undefined;
}

function renderBashCall(args: any, theme: Theme): Text {
  const cmd = args.command ?? "";
  const highlighted = highlightCode(cmd, "bash").join("\n");
  const isMultiLine = cmd.includes("\n") || cmd.length > 80;
  if (isMultiLine) {
    return new Text(`${bashPill(theme)}\n${highlighted}`, 0, 0);
  }
  return new Text(`${bashPill(theme)} ${highlighted}`, 0, 0);
}

function renderBashResult(result: AgentToolResult<unknown>, { expanded }: { expanded: boolean }, theme: Theme): Text {
  const text = getText(result);
  if (!text || !text.trim()) return new Text("", 0, 0);

  const lines = text.split("\n");
  if (expanded || lines.length <= COLLAPSED_MAX_LINES) {
    return new Text(`\n${lines.map((l) => theme.fg("toolOutput", l)).join("\n")}`, 0, 0);
  }

  const hidden = lines.length - COLLAPSED_MAX_LINES;
  const hint = theme.fg("dim", `... ${hidden} more lines (${keyHint("app.tools.expand", "to expand")})`);
  const output = lines.slice(-COLLAPSED_MAX_LINES).map((l) => theme.fg("toolOutput", l)).join("\n");
  return new Text(`\n${hint}\n${output}`, 0, 0);
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const localBashOperations = createLocalBashOperations();

  const bashTool = createBashTool(cwd, {
    spawnHook: ({ command, cwd, env }) => {
      return { command: rtkRewriteCommand(command) ?? command, cwd, env };
    },
  });

  pi.registerTool({
    ...bashTool,
    parameters: { ...bashTool.parameters },
    renderCall: renderBashCall,
    renderResult: renderBashResult,
  });

  pi.on("user_bash", (event) => {
    if (event.excludeFromContext) {
      return;
    }

    const initialRewrite = rtkRewriteCommand(event.command);
    if (!initialRewrite) {
      return;
    }

    return {
      operations: {
        exec: (command, cwd, options) => {
          return localBashOperations.exec(
            command === event.command ? initialRewrite : rtkRewriteCommand(command) ?? command,
            cwd,
            options,
          );
        },
      },
    };
  });

  pi.registerCommand("rtk", {
    description: "Show rtk rewrite status.",
    getArgumentCompletions: (prefix: string) => {
      return "status".startsWith((prefix ?? "").trim().toLowerCase())
        ? [{ value: "status", label: "status", description: "Show rewrite stats and last rewrite." }]
        : null;
    },
    handler: async (_args: string) => {
      showCommandMessage(pi, formatStatus());
    },
  });
}
