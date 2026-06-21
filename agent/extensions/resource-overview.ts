/**
 * Pi welcome resource overview. Shows a richer startup header for loaded skills and extensions.
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

// https://patorjk.com/software/taag
// DOS Rebel.
// Also consider Coder Mini, Small Block, ANSI Compact.
const HEADER_TITLE =
  process.env.PI_RESOURCE_OVERVIEW_TITLE ||
  String.raw`
 █████   █████  ███         █████   ████  ███
░░███   ░░███  ░░░         ░░███   ███░  ░░░
 ░███    ░███  ████         ░███  ███    ████   ██████  ████████   ██████   ████████
 ░███████████ ░░███         ░███████    ░░███  ███░░███░░███░░███ ░░░░░███ ░░███░░███
 ░███░░░░░███  ░███         ░███░░███    ░███ ░███████  ░███ ░░░   ███████  ░███ ░███
 ░███    ░███  ░███         ░███ ░░███   ░███ ░███░░░   ░███      ███░░███  ░███ ░███
 █████   █████ █████  ██    █████ ░░████ █████░░██████  █████    ░░████████ ████ █████ ██
░░░░░   ░░░░░ ░░░░░  ██    ░░░░░   ░░░░ ░░░░░  ░░░░░░  ░░░░░      ░░░░░░░░ ░░░░ ░░░░░ ░░
                    ░░`;

const HEADER_SUBTITLES = [
  "Skills and extensions available in this session.",
];

const HEADER_SUBTITLE =
  process.env.PI_RESOURCE_OVERVIEW_SUBTITLE ||
  HEADER_SUBTITLES[Math.floor(Math.random() * HEADER_SUBTITLES.length)];

const EXTENSION_MANIFEST: Record<string, { title: string; description: string }> = {
  "advisor": {
    title: "Advisor",
    description: "Let the model ask a stronger model for a second opinion before it acts.",
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
    description: "Durable investigation checkpoints and restore summaries.",
  },
  "custom-footer": {
    title: "Custom Footer",
    description: "Compact powerline-style footer with path, context, and model info.",
  },
  "evidence.ts": {
    title: "Evidence Store",
    description: "Durable citable evidence snippets with list/get/add tools.",
  },
  "meep.ts": {
    title: "Meep",
    description: "Says meep when the model is done working.",
  },
  "plan.ts": {
    title: "Plan Command",
    description: "Deterministic /plan handoff that manages ContextSnapshot checkpoints.",
  },
  "redact.ts": {
    title: "Redact Sensitive Data",
    description: "Redact secrets from tool output.",
  },
  "resource-overview.ts": {
    title: "Resource Overview",
    description: "Richer startup overview for loaded skills and extensions.",
  },
  "rtk.ts": {
    title: "RTK Rewrite",
    description: "Best-effort shell command optimization via rtk rewrite.",
  },
  "security.ts": {
    title: "Security Guard",
    description: "Confirms or blocks risky commands and sensitive file access.",
  },
  "senior-dev": {
    title: "Senior Dev",
    description: "Routine senior-model steering for selected coding models.",
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

function formatLine(theme: Theme, name: string, description: string, width: number): string {
  const prefix = `  • ${name}`;
  const separator = " — ";
  const maxDescription = Math.max(24, width - prefix.length - separator.length - 4);
  return `${theme.fg("accent", prefix)}${theme.fg("dim", separator)}${theme.fg("muted", truncate(description, maxDescription))}`;
}

function renderSection(theme: Theme, title: string, items: ResourceInfo[], width: number): string[] {
  const count = theme.fg("dim", `(${items.length})`);
  const lines = [theme.fg("mdHeading", `${title} ${count}`)];
  for (const item of items) {
    lines.push(formatLine(theme, item.title || item.name, item.description, width));
  }
  return lines;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    const skills = loadSkills(ctx.cwd);
    const extensions = loadExtensions(ctx.cwd);

    ctx.ui.setHeader((_tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        return [
          ...HEADER_TITLE.split("\n").map((line) => theme.fg("accent", theme.bold(line))),
          "",
          // theme.fg("dim", HEADER_SUBTITLE),
          // "",
          ...renderSection(theme, "Skills", skills, width),
          "",
          ...renderSection(theme, "Extensions", extensions, width),
          "",
        ];
      },
    }));
  });
}
