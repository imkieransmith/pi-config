/**
 * Pi startup overview. A compact, functional header that reminds you what this
 * setup adds: the slash commands you can run, plus the skills and extensions
 * loaded this session. Runtime state (cwd, context, model, thinking level) is
 * intentionally left to the footer rather than duplicated here.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type ResourceInfo = {
  name: string;
  title: string;
  description: string;
  filePath: string;
};

// Startup overview tuning. Keep this compact — the footer already shows cwd,
// context, model, and thinking level, so this view focuses on what you can run.
const MAX_COMMANDS = 22; // cap the command list height; overflow shows "+N more"
const NAME_COLUMN = 16; // alignment width for the "/command" column

type CommandInfo = {
  name: string;
  description: string;
};

const EXTENSION_MANIFEST: Record<string, { title: string; description: string }> = {
  "advisor": {
    title: "Advisor",
    description: "Consult a configured reviewer model for a recommended next move on the current work.",
  },
  "ask-user-question": {
    title: "Ask User Question",
    description: "Interactive multiple-choice clarification tool for agents.",
  },
  "colour-messages": {
    title: "Colour Messages",
    description: "Background colours for user, working, and final assistant rows.",
  },
  "confirm-destructive.ts": {
    title: "Confirm Destructive",
    description: "Confirm destructive tool calls and bash commands before they run.",
  },
  "context.ts": {
    title: "Context Snapshot",
    description: "Durable captures with bounded post-compaction recall.",
  },
  "custom-footer": {
    title: "Custom Footer",
    description: "Compact powerline-style footer with path, context, and model info.",
  },
  "evidence.ts": {
    title: "Evidence Store",
    description: "Validated durable snippets with paginated discovery, exact verification, and TUI-only proof.",
  },
  "meep.ts": {
    title: "Meep",
    description: "Says meep when the model is done working.",
  },
  "plan.ts": {
    title: "Plan Command",
    description: "Deterministic /plan handoff that manages ContextSnapshot captures.",
  },
  "redact.ts": {
    title: "Redact Sensitive Data",
    description: "Redact secrets from tool output.",
  },
  "resource-overview.ts": {
    title: "Resource Overview",
    description: "Richer startup overview for loaded skills and extensions.",
  },
  "response-metrics.ts": {
    title: "Response Metrics",
    description: "Persist elapsed time, tool calls, and token usage beneath each completed response.",
  },
  "rtk.ts": {
    title: "RTK Rewrite",
    description: "Best-effort shell command optimization via rtk rewrite.",
  },
  "security.ts": {
    title: "Security Guard",
    description: "Confirms or blocks risky commands and sensitive file access.",
  },
  "session-query.ts": {
    title: "Session Query",
    description: "Query previous sessions, including custom state and summaries.",
  },
  "superset-hooks.ts": {
    title: "Superset Hooks",
    description: "Emit Superset lifecycle hooks so the host shows a working indicator.",
  },
  "tool-pills": {
    title: "Tool Pills",
    description: "Compact colored tool call/result rendering and syntax-highlighted diffs.",
  },
};

function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    result.push(item);
  }
  return result;
}

function safeStat(filePath: string) {
  try {
    return statSync(filePath);
  } catch {
    return undefined;
  }
}

function safeRead(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function directSubdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .map((entry) => path.join(dir, entry))
      .filter((entryPath) => safeStat(entryPath)?.isDirectory());
  } catch {
    return [];
  }
}

function directFiles(dir: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(predicate)
      .map((entry) => path.join(dir, entry))
      .filter((entryPath) => safeStat(entryPath)?.isFile());
  } catch {
    return [];
  }
}

function discoverSkillFiles(cwd: string): string[] {
  const roots = [
    path.join(os.homedir(), ".pi", "agent", "skills"),
    path.join(cwd, ".pi", "skills"),
  ];
  const files: string[] = [];

  for (const root of roots) {
    for (const subdir of directSubdirs(root)) {
      const skillFile = path.join(subdir, "SKILL.md");
      if (safeStat(skillFile)?.isFile()) files.push(skillFile);
    }
    files.push(...directFiles(root, (name) => name.endsWith(".md")));
  }

  return unique(files, (file) => path.resolve(file));
}

function discoverExtensionEntrypoints(cwd: string): string[] {
  const roots = [
    path.join(os.homedir(), ".pi", "agent", "extensions"),
    path.join(cwd, ".pi", "extensions"),
  ];
  const files: string[] = [];

  for (const root of roots) {
    files.push(...directFiles(root, (name) => name.endsWith(".ts")));
    for (const subdir of directSubdirs(root)) {
      const indexFile = path.join(subdir, "index.ts");
      if (safeStat(indexFile)?.isFile()) files.push(indexFile);
    }
  }

  return unique(files, (file) => path.resolve(file));
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return {};

  const data: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const item = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!item) continue;
    const [, key, rawValue] = item;
    data[key] = rawValue.trim().replace(/^['"]|['"]$/g, "");
  }
  return data;
}

function skillNameFromPath(filePath: string): string {
  return path.basename(path.dirname(filePath));
}

function loadSkills(cwd: string): ResourceInfo[] {
  return discoverSkillFiles(cwd)
    .map((filePath) => {
      const frontmatter = parseFrontmatter(safeRead(filePath));
      const name = frontmatter.name || path.basename(filePath, ".md") || skillNameFromPath(filePath);
      const title = frontmatter.title || name;
      const description = frontmatter.description || "No description provided.";
      return { name, title, description, filePath };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function extensionNameFromEntrypoint(filePath: string): string {
  if (path.basename(filePath) === "index.ts") return path.basename(path.dirname(filePath));
  return path.basename(filePath);
}

function titleFromName(name: string): string {
  return name
    .replace(/\.ts$/, "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function commentDescription(source: string): string | undefined {
  const block = source.match(/^\/\*\*([\s\S]*?)\*\//)?.[1];
  const firstLine = block
    ?.split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .find((line) => line.length > 0 && !line.endsWith("Extension."));
  return firstLine;
}

function loadExtensions(cwd: string): ResourceInfo[] {
  return discoverExtensionEntrypoints(cwd)
    .map((filePath) => {
      const name = extensionNameFromEntrypoint(filePath);
      const manifest = EXTENSION_MANIFEST[name];
      const description = manifest?.description || commentDescription(safeRead(filePath)) || "No description provided.";
      return {
        name,
        title: manifest?.title || titleFromName(name),
        description,
        filePath,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function truncate(text: string, max: number): string {
  if (max <= 1) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

// Commands are the actionable part of this view. Skills are auto-loaded by the
// model on demand, so skill:* entries are surfaced in the Skills section
// instead of being repeated here.
function loadCommands(pi: ExtensionAPI): CommandInfo[] {
  let raw: unknown;
  try {
    raw = (pi as unknown as { getCommands?: () => unknown }).getCommands?.();
  } catch {
    raw = undefined;
  }
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry) => {
      const record = (entry ?? {}) as { name?: unknown; description?: unknown };
      return {
        name: typeof record.name === "string" ? record.name : "",
        description: typeof record.description === "string" ? record.description : "",
      };
    })
    .filter((command) => command.name.length > 0 && !command.name.startsWith("skill:"))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function sectionHeading(theme: Theme, title: string, count: number): string {
  return `${theme.fg("mdHeading", `  ${title} `)}${theme.fg("dim", `(${count})`)}`;
}

function formatCommandLine(theme: Theme, command: CommandInfo, nameWidth: number, width: number): string {
  const indent = "    ";
  const gap = "  ";
  const slashName = `/${command.name}`;
  const paddedName = slashName.length >= nameWidth ? slashName : slashName.padEnd(nameWidth);
  const maxDescription = Math.max(16, width - indent.length - paddedName.length - gap.length - 2);
  const description = truncate(command.description, maxDescription);
  return `${theme.fg("accent", indent + paddedName)}${theme.fg("dim", gap)}${theme.fg("muted", description)}`;
}

function renderCommands(theme: Theme, commands: CommandInfo[], width: number): string[] {
  if (commands.length === 0) return [];
  const shown = commands.slice(0, MAX_COMMANDS);
  const nameWidth = Math.min(
    NAME_COLUMN,
    shown.reduce((max, command) => Math.max(max, command.name.length + 1), 0),
  );
  const lines = [sectionHeading(theme, "Commands", commands.length)];
  for (const command of shown) {
    lines.push(formatCommandLine(theme, command, nameWidth, width));
  }
  if (commands.length > shown.length) {
    lines.push(theme.fg("dim", `    +${commands.length - shown.length} more`));
  }
  return lines;
}

// Greedy width-aware wrap for inline name chips (plain text in, colour applied
// after, so length math stays accurate).
function wrapInline(items: string[], separator: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    if (!current) {
      current = item;
    } else if (current.length + separator.length + item.length > maxWidth) {
      lines.push(current);
      current = item;
    } else {
      current += separator + item;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function renderNames(theme: Theme, title: string, items: ResourceInfo[], width: number): string[] {
  if (items.length === 0) return [];
  const indent = "    ";
  const names = items.map((item) => item.title || item.name);
  const wrapped = wrapInline(names, " · ", Math.max(20, width - indent.length - 2));
  return [
    sectionHeading(theme, title, items.length),
    ...wrapped.map((line) => theme.fg("muted", indent + line)),
  ];
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    const commands = loadCommands(pi);
    const skills = loadSkills(ctx.cwd);
    const extensions = loadExtensions(ctx.cwd);

    ctx.ui.setHeader((_tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        const lines: string[] = [
          "",
          `${theme.bold(theme.fg("accent", "Pi"))}`,
          "",
          ...renderCommands(theme, commands, width),
        ];
        if (skills.length > 0) lines.push("", ...renderNames(theme, "Skills", skills, width));
        if (extensions.length > 0) lines.push("", ...renderNames(theme, "Extensions", extensions, width));
        lines.push("");
        return lines;
      },
    }));
  });
}
