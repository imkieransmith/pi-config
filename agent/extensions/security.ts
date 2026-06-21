/**
 * Block dangerous commands, protect sensitive paths.
 *
 * Original - https://github.com/michalvavra/agents/blob/main/agents/pi/extensions/security.ts
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

type Decision = {
  action: "allow" | "confirm" | "block";
  reason?: string;
  title?: string;
  detail?: string;
};

type PathIntent = "read" | "mutate" | "discover";

type Rule = {
  pattern: RegExp;
  reason: string;
};

const ALLOW: Decision = { action: "allow" };

const hardBashRules: Rule[] = [
  { pattern: /\b(sudo|doas|pkexec)\b/i, reason: "privilege escalation" },
  { pattern: /\bsu\s+-/i, reason: "switch user" },
  { pattern: /\b(chmod|chown)\b.*777\b/i, reason: "unsafe permissions" },
  { pattern: /\bchmod\b.*(?:u\+s|g\+s|\+s|[42][0-9]{3})\b/i, reason: "setuid/setgid permissions" },
  { pattern: /\bmkfs(?:\.[\w-]+)?\b/i, reason: "filesystem formatting" },
  { pattern: /\b(?:dd\b.*\bof=\/dev\/|wipefs|fdisk|parted|diskutil\s+erase|shred)\b/i, reason: "disk destruction" },
  { pattern: />\s*\/dev\/(?:sd|hd|nvme|disk)[\w/.-]*/i, reason: "raw device overwrite" },
  { pattern: /\bkill\s+-9\s+-1\b/i, reason: "kill all processes" },
  { pattern: /\b(?:killall|pkill)\b/i, reason: "broad process termination" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/i, reason: "fork bomb" },
  { pattern: /\b(?:eval|exec)\b.*['"`$]/i, reason: "obfuscated shell execution" },
  { pattern: /\b(?:sh|bash|zsh)\s+-c\b/i, reason: "nested shell execution" },
  { pattern: /\b(?:node\s+-e|python3?\s+-c|ruby\s+-e|perl\s+-e|php\s+-r)\b/i, reason: "inline code execution" },
  { pattern: /\bbase64\s+(?:--decode|-d)\b/i, reason: "base64 decoding" },
  { pattern: /\b(?:curl|wget)\b.*\|\s*(?:ba)?sh\b/i, reason: "remote script execution" },
  { pattern: /\bnc\b.*\s-e\s/i, reason: "netcat shell" },
  { pattern: /\b(?:scp|sftp)\b/i, reason: "remote file transfer" },
  { pattern: /\brsync\b.*(?:\s-e\s+ssh|--delete)\b/i, reason: "risky rsync" },
  { pattern: /\bcurl\b.*(?:-T|--upload-file)\b/i, reason: "file upload" },
  { pattern: /\b(?:ssh-add|ssh-keygen)\b/i, reason: "SSH key handling" },
  { pattern: /\bSSH_AUTH_SOCK\b/i, reason: "SSH agent access" },
  { pattern: /\b(?:crontab\s+-[el]|systemctl\s+(?:enable|disable|mask)|launchctl\s+(?:load|bootstrap)|at\s+now)\b/i, reason: "persistence mechanism" },
  { pattern: /(?:^|[^\w])(?:\/etc\/(?:passwd|shadow|sudoers|hosts|cron)|~\/\.(?:bashrc|zshrc|profile)|~\/\.config\/autostart)\b/i, reason: "system or profile persistence" },
  { pattern: /\b(?:nohup|disown)\b/i, reason: "detached background process" },
  { pattern: /\b(?:HISTFILE\s*=|HISTSIZE\s*=\s*0|unset\s+HISTFILE)\b/i, reason: "history suppression" },
];

const confirmBashRules: Rule[] = [
  { pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|upgrade|dlx|exec|create)\b/i, reason: "package manager mutation/execution" },
  { pattern: /\b(?:pip|pip3|uv|poetry|cargo|gem|go)\s+(?:install|add|get|update|run)\b/i, reason: "dependency or tool execution" },
  { pattern: /\b(?:docker|podman|kubectl|helm)\b/i, reason: "container or cluster command" },
  { pattern: /\b(?:curl|wget|fetch)\b/i, reason: "network fetch" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "hard git reset" },
  { pattern: /\bgit\s+clean\b/i, reason: "git clean" },
  { pattern: /\brm\s+-(?:[^\s]*r|-[^\s]*recursive)\b/i, reason: "recursive delete" },
  { pattern: /\bfind\b.*\s-delete\b/i, reason: "find delete" },
  { pattern: /\b(?:truncate|perl\s+-pi|sed\s+-i)\b/i, reason: "in-place file rewrite" },
  { pattern: /\bchmod\b.*(?:\+x|[0-7]*[1357][0-7]?)\b/i, reason: "executable permission change" },
  { pattern: /\b(?:make|just|task|rake)\b/i, reason: "project script execution" },
];

const shellSecretPathRules: Rule[] = [
  { pattern: /(?:^|[\/\s"'`=:@])\.env(?!\.example(?:$|[\/\s"'`<>|&;]))[^\s"'`]*/i, reason: "environment file" },
  { pattern: /(?:^|[\/\s"'`=:@])\.dev\.vars[^\s"'`]*/i, reason: "dev vars file" },
  { pattern: /(?:^|[\/\s"'`=:@])\.ssh(?:\/|$|\s)/i, reason: "SSH directory" },
  { pattern: /(?:^|[\/\s"'`=:@])\.gnupg(?:\/|$|\s)/i, reason: "GnuPG directory" },
  { pattern: /(?:^|[\/\s"'`=:@])\.git(?:\/|$|\s)/i, reason: "git internals" },
  { pattern: /\b(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)\b/i, reason: "SSH private key" },
  { pattern: /[^\s"'`]+\.(?:pem|key)(?:$|[\s"'`<>|&;])/i, reason: "private key file" },
  { pattern: /\b(?:secret|secrets|credentials?|tokens?|api[_-]?keys?)\b/i, reason: "secret material" },
];

const sensitiveReadCommands = /\b(?:cat|sed|awk|grep|rg|head|tail|less|more|nl|strings|xxd|od|cp|mv|install|tee|sponge|tar|zip|gzip|base64|openssl|curl|rsync|scp|python3?|node|ruby|perl|php)\b/i;
const shellWriteOperators = /(?:^|[^<>])>>?\s*|(?:\|\s*)?(?:tee|sponge|cp|mv|install)\b/i;
const shellWordPattern = /"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+/g;

/** Notify only when Pi is running with an interactive UI. */
function notify(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "warning");
}

/** Confirmation gates must fail closed in print, JSON, and other non-UI modes. */
async function confirmOrBlock(
  ctx: ExtensionContext,
  title: string,
  detail: string,
  noUiReason: string,
): Promise<Decision | undefined> {
  if (!ctx.hasUI) {
    return { action: "block", reason: `${noUiReason} (no UI to confirm)` };
  }

  const ok = await ctx.ui.confirm(title, detail);
  return ok ? undefined : { action: "block", reason: `${noUiReason} blocked by user` };
}

/** Treat common user-facing path syntax as real filesystem paths. */
function expandUserPath(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

/** Canonical paths make traversal and symlink tricks much harder to hide. */
async function resolveToolPath(rawPath: string, ctx: ExtensionContext): Promise<string> {
  const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  const expanded = expandUserPath(withoutAt.trim() || ".");
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(ctx.cwd, expanded);

  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

/** Root-aware containment check; prefix checks are unsafe for sibling paths. */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Path segments avoid matching accidental substrings across directory boundaries. */
function pathSegments(filePath: string): string[] {
  return filePath.split(path.sep).filter(Boolean);
}

/** Environment variants are sensitive, but examples are meant to be shared. */
function isEnvFile(name: string): boolean {
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
}

/** Names alone often reveal secret intent even before a file exists. */
function includesSensitiveSegment(absPath: string): string | undefined {
  const segments = pathSegments(absPath);
  const base = path.basename(absPath);

  if (isEnvFile(base)) return "environment file";
  if (base === ".dev.vars" || base.startsWith(".dev.vars.")) return "dev vars file";
  if (/\.(?:pem|key)$/i.test(base)) return "private key file";
  if (/^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i.test(base)) return "SSH private key";

  for (const segment of segments) {
    if (segment === ".ssh") return "SSH directory";
    if (segment === ".gnupg") return "GnuPG directory";
    if (segment === ".git") return "git directory";
    if (/(?:secret|credentials?|tokens?|api[-_]?keys?)/i.test(segment)) {
      return "secret material";
    }
  }

  return undefined;
}

/** Pi extensions are executable trust hooks, so project-local ones are protected. */
function includesSensitiveProjectExtension(absPath: string, cwd: string): boolean {
  return isInside(path.join(cwd, ".pi", "extensions"), absPath);
}

type PiPathTier = "public" | "authoring" | "private" | "config" | "outside";

/** Root-level planning notes are intentionally writable across projects. */
function isPiPlanningNote(absPath: string, home: string): boolean {
  return absPath === path.join(home, ".pi", "PLAN.md") || absPath === path.join(home, ".pi", "TODO.md");
}

// Maintainable metadata at the .pi repo root. These are tracked in git and are
// part of working on this personal Pi config, so reads/discovery are safe.
// Genuinely sensitive runtime config (settings/auth/models/providers .json) is
// deliberately NOT listed here — it stays in the private/config tiers below.
const PI_ROOT_PUBLIC_FILES = new Set([
  ".gitignore",
  "license",
  "license.md",
  "license.txt",
  "package.json",
  "package-lock.json",
  "append_system.md",
  "tsconfig.json",
]);

/** Root-level docs/metadata describe this personal Pi repo and are safe to maintain. */
function isPiRootPublicFile(absPath: string, home: string): boolean {
  const piRoot = path.join(home, ".pi");
  if (path.dirname(absPath) !== piRoot) return false;
  const base = path.basename(absPath);
  if (/^(?:README(?:\.[\w-]+)?|TODO|PLAN)\.md$/i.test(base)) return true;
  return PI_ROOT_PUBLIC_FILES.has(base.toLowerCase());
}

/** A small amount of directory discovery is needed to work on the personal Pi repo. */
function isPiPublicDirectory(absPath: string, home: string): boolean {
  const dirs = [
    path.join(home, ".pi"),
    path.join(home, ".pi", "agent"),
    path.join(home, ".pi", "agent", "skills"),
    path.join(home, ".pi", "agent", "extensions"),
  ];
  return dirs.some((dir) => absPath === dir);
}

function isBroadPiDiscoveryPath(absPath: string, home: string): boolean {
  return absPath === path.join(home, ".pi") || absPath === path.join(home, ".pi", "agent");
}

/** Skills and extensions are authoring surfaces. Mutations are allowed only after confirmation. */
function isPiAuthoringPath(absPath: string, home: string): boolean {
  return (
    isInside(path.join(home, ".pi", "agent", "skills"), absPath) ||
    isInside(path.join(home, ".pi", "agent", "extensions"), absPath)
  );
}

/** Runtime/private Pi state can contain transcripts, payloads, logs, cache, or saved snippets. */
function isPiPrivateRuntimePath(absPath: string, home: string): boolean {
  return [
    path.join(home, ".pi", "agent", "sessions"),
    path.join(home, ".pi", "agent", "history"),
    path.join(home, ".pi", "agent", "cache"),
    path.join(home, ".pi", "agent", "logs"),
    path.join(home, ".pi", "agent", "state"),
    path.join(home, ".pi", "agent", "tmp"),
    path.join(home, ".pi", "agent", "evidence"),
    path.join(home, ".pi", "agent", "senior-dev"),
  ].some((dir) => isInside(dir, absPath));
}

/** Config-looking files outside authoring dirs may include provider/model/auth settings. */
function isPiPrivateConfigPath(absPath: string, home: string): boolean {
  if (!isInside(path.join(home, ".pi"), absPath)) return false;
  if (isPiAuthoringPath(absPath, home) || isPiRootPublicFile(absPath, home)) return false;

  const base = path.basename(absPath).toLowerCase();
  return /^(?:config|settings|models?|providers?|auth|credentials?)(?:\.|$)/i.test(base);
}

function classifyPiPath(absPath: string, home: string): PiPathTier {
  const piRoot = path.join(home, ".pi");
  if (!isInside(piRoot, absPath)) return "outside";
  if (isPiPrivateRuntimePath(absPath, home)) return "private";
  if (isPiPrivateConfigPath(absPath, home)) return "config";
  if (isPiAuthoringPath(absPath, home)) return "authoring";
  if (isPiRootPublicFile(absPath, home) || isPiPublicDirectory(absPath, home)) return "public";
  return "private";
}

/** TODO.md files are AI scratchpads and should never be gated. */
function isTodoPlanningNote(absPath: string): boolean {
  return path.basename(absPath).toLowerCase() === "todo.md";
}

function cleanShellWord(word: string): string {
  let cleaned = word.trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1);
  }
  return cleaned
    .replace(/^[<>]+/, "")
    .replace(/[),;]+$/, "")
    .trim();
}

function shellFileReferences(command: string): string[] {
  const words = command.match(shellWordPattern) ?? [];
  return words
    .map(cleanShellWord)
    .filter((word) => /(?:^|\/)[^\/]*\.[A-Za-z0-9][A-Za-z0-9_-]*$/.test(word));
}

function shellPiReferences(command: string): string[] {
  const words = command.match(shellWordPattern) ?? [];
  return words
    .map(cleanShellWord)
    .filter((word) => /(?:^|[\/])\.pi(?:[\/]|$)|^~\/\.pi(?:[\/]|$)/.test(word.replace(/\\/g, "/")));
}

function shellRefToApproxPath(word: string): string {
  const cleaned = expandUserPath(word).replace(/\\/g, path.sep);
  if (path.isAbsolute(cleaned)) return path.resolve(cleaned);

  const normalized = cleaned.replace(/\\/g, "/");
  const piIndex = normalized.split("/").indexOf(".pi");
  if (piIndex >= 0) {
    const parts = normalized.split("/").slice(piIndex + 1);
    return path.join(os.homedir(), ".pi", ...parts);
  }

  return path.resolve(cleaned);
}

function shellWritesToPiReference(command: string): boolean {
  const piPath = String.raw`(?:"[^"]*\.pi(?:\/[^">|&;]*)?"|'[^']*\.pi(?:\/[^'>|&;]*)?'|[^\s"'\`<>|&;]*\.pi(?:\/[^\s"'\`<>|&;]*)?)`;
  return new RegExp(String.raw`(?:>>?\s*${piPath}|\b(?:tee|sponge|cp|mv|install)\b[^\n;|&]*${piPath})`, "i").test(command);
}

function classifyBashPiReferences(command: string): Decision {
  const refs = shellPiReferences(command);
  if (refs.length === 0) return ALLOW;

  const home = os.homedir();
  const writesToPi = shellWritesToPiReference(command);
  for (const ref of refs) {
    const approxPath = shellRefToApproxPath(ref);
    const sensitive = includesSensitiveSegment(approxPath);
    if (sensitive) return block(`bash touches protected path: ${sensitive}`, command);

    const tier = classifyPiPath(approxPath, home);
    if (tier === "outside") continue;
    if (tier === "private") return block("bash touches protected path: Pi private runtime state", command);
    if (tier === "config") return block("bash touches protected path: Pi provider/model configuration", command);
    if (tier === "authoring" && writesToPi) return confirm("modify Pi authoring surface", command);
  }

  return ALLOW;
}

function stripHeredocBodies(command: string): string {
  const lines = command.split(/\r?\n/);
  const output: string[] = [];
  const pendingDelimiters: Array<{ word: string; allowLeadingTabs: boolean }> = [];

  const heredocPattern = /<<-?\s*(?:"([^"]+)"|'([^']+)'|\\?([^\s;&|()<>]+))/g;

  for (const line of lines) {
    const pending = pendingDelimiters[0];
    if (pending) {
      const comparable = pending.allowLeadingTabs ? line.replace(/^\t+/, "") : line;
      if (comparable === pending.word) {
        output.push(line);
        pendingDelimiters.shift();
      } else if (output[output.length - 1] !== "[heredoc body omitted]") {
        output.push("[heredoc body omitted]");
      }
      continue;
    }

    output.push(line);

    for (const match of line.matchAll(heredocPattern)) {
      const token = match[0];
      const word = match[1] ?? match[2] ?? match[3];
      if (!word) continue;
      pendingDelimiters.push({ word, allowLeadingTabs: token.startsWith("<<-") });
    }
  }

  return output.join("\n");
}

function shellRewriteTargetsOnlyTodo(command: string): boolean {
  const refs = shellFileReferences(command);
  return refs.some(isTodoPlanningNote) && refs.every(isTodoPlanningNote);
}

function shellHeredocWritesOnlyTodo(command: string): boolean {
  return /<<-?\s*/.test(command) && shellWriteOperators.test(command) && shellRewriteTargetsOnlyTodo(command);
}

/** These files can turn later ordinary commands into arbitrary code execution. */
function securitySensitiveMutation(absPath: string): string | undefined {
  const base = path.basename(absPath);
  const lower = absPath.toLowerCase();

  if (base === "package.json") return "package.json";
  if (/^(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|npm-shrinkwrap\.json)$/i.test(base)) return "lockfile";
  if (/^\.(?:npmrc|yarnrc|pnpmrc)$|^\.pnpmfile\.cjs$/i.test(base)) return "package manager config";
  if (/\.(?:sh|bash|zsh|fish|ps1|bat|cmd)$/i.test(base)) return "shell script";
  if (/Dockerfile(?:\..*)?$/i.test(base) || /(?:^|\/)(?:docker-compose|compose)\.[^.]+$/i.test(absPath)) return "Docker config";
  if (/\/\.(?:github|gitlab|circleci|buildkite|gitea|forgejo)\//i.test(lower)) return "CI config";
  if (/\/\.husky\//i.test(lower) || /\/hooks\//i.test(lower)) return "hook file";
  if (/^(?:vite|vitest|webpack|rollup|tsup|esbuild|babel|eslint|prettier|jest|playwright|turbo|nx)\.config\./i.test(base)) {
    return "executable project config";
  }
  if (/^(?:Makefile|Justfile|Taskfile\.ya?ml)$/i.test(base)) return "project task file";

  return undefined;
}

/** Search globs can target secrets even when the search root looks harmless. */
function sensitiveFilePattern(value: string): string | undefined {
  const normalized = value.replace(/\\/g, "/");

  if (/(^|\/)\.env(?!\.example(?:$|\/))[^/]*/i.test(normalized)) return "environment file";
  if (/(^|\/)\.dev\.vars[^/]*/i.test(normalized)) return "dev vars file";
  if (/(^|\/)\.(?:ssh|gnupg|git)(?:$|\/)/i.test(normalized)) return "sensitive directory";
  if (/(^|\/)\.pi\/agent\/(?:sessions|history|cache|logs|state|tmp|evidence|senior-dev)(?:$|\/)/i.test(normalized)) return "Pi private runtime state";
  if (/\.(?:pem|key)(?:$|[^\w])/i.test(normalized)) return "private key file";
  if (/\b(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)\b/i.test(normalized)) return "SSH private key";
  if (/(?:secret|credentials?|tokens?|api[_-]?keys?)/i.test(normalized)) return "secret material";

  return undefined;
}

/** Central path policy for built-in read, discovery, and mutation tools. */
async function classifyPath(
  absPath: string,
  rawPath: string,
  ctx: ExtensionContext,
  intent: PathIntent,
): Promise<Decision> {
  const cwd = await resolveToolPath(".", ctx);
  const home = os.homedir();

  if (isTodoPlanningNote(absPath)) {
    return ALLOW;
  }

  if (isInside(path.join(home, ".ssh"), absPath)) {
    return block(`${intent} of SSH secrets`, rawPath);
  }
  if (isInside(path.join(home, ".gnupg"), absPath)) {
    return block(`${intent} of GnuPG secrets`, rawPath);
  }

  const sensitive = includesSensitiveSegment(absPath);
  if (sensitive) {
    return block(`${intent} of ${sensitive}`, rawPath);
  }

  if ((intent === "read" || intent === "mutate") && isPiPlanningNote(absPath, home)) {
    return ALLOW;
  }

  const piTier = classifyPiPath(absPath, home);
  if (piTier === "public") {
    // Reads and discovery of the maintainable repo surface are always fine.
    // Mutations fall through to the standard project-scope / sensitive-config
    // confirmation checks below (e.g. editing package.json still confirms).
    if (intent !== "mutate") return ALLOW;
  }
  if (piTier === "authoring") {
    if (intent !== "mutate") return ALLOW;
    return {
      action: "confirm",
      reason: "modifying Pi authoring surface",
      title: "Security check: modify Pi authoring surface?",
      detail: rawPath,
    };
  }
  if (piTier === "private") {
    return block(`${intent} of Pi private runtime state`, rawPath);
  }
  if (piTier === "config") {
    return block(`${intent} of Pi provider/model configuration`, rawPath);
  }
  if (includesSensitiveProjectExtension(absPath, cwd)) {
    if (intent !== "mutate") return ALLOW;
    return block(`${intent} of Pi project extension`, rawPath);
  }

  if (intent === "mutate" && !isInside(cwd, absPath)) {
    return block("file mutation outside project", rawPath);
  }

  if (intent === "mutate" && pathSegments(absPath).includes("node_modules")) {
    return block("file mutation inside node_modules", rawPath);
  }

  if (intent === "mutate") {
    const soft = securitySensitiveMutation(absPath);
    if (soft) {
      return {
        action: "confirm",
        reason: `modifying ${soft}`,
        title: `Security check: modify ${soft}?`,
        detail: rawPath,
      };
    }
  }

  return ALLOW;
}

/** Construct a hard denial. */
function block(reason: string, detail?: string): Decision {
  return { action: "block", reason, detail };
}

/** Construct a user confirmation requirement. */
function confirm(reason: string, detail: string): Decision {
  return {
    action: "confirm",
    reason,
    title: `Security check: ${reason}?`,
    detail,
  };
}

/** Bash is not parseable with regex, so this is conservative damage reduction. */
function classifyBash(command: string): Decision {
  const commandWithoutHeredocBodies = stripHeredocBodies(command);
  const todoOnlyHeredocWrite = shellHeredocWritesOnlyTodo(commandWithoutHeredocBodies);
  const commandForHardRules = todoOnlyHeredocWrite ? commandWithoutHeredocBodies : command;

  for (const rule of hardBashRules) {
    if (rule.pattern.test(commandForHardRules)) return block(rule.reason, commandForHardRules);
  }

  if (todoOnlyHeredocWrite) return ALLOW;

  const piDecision = classifyBashPiReferences(command);
  if (piDecision.action !== "allow") return piDecision;

  for (const rule of shellSecretPathRules) {
    if (rule.pattern.test(command) && (sensitiveReadCommands.test(command) || shellWriteOperators.test(command))) {
      return block(`bash touches protected path: ${rule.reason}`, command);
    }
  }

  for (const rule of confirmBashRules) {
    if (rule.pattern.test(command)) {
      if (rule.reason === "in-place file rewrite" && shellRewriteTargetsOnlyTodo(command)) continue;
      return confirm(rule.reason, command);
    }
  }

  return ALLOW;
}

/** Convert policy decisions into Pi's tool_call blocking contract. */
async function handleDecision(decision: Decision, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined> {
  if (decision.action === "allow") return undefined;

  if (decision.action === "block") {
    const reason = decision.reason ?? "security policy";
    notify(ctx, `Security blocked: ${reason}`);
    return { block: true, reason };
  }

  const reason = decision.reason ?? "security confirmation required";
  const denied = await confirmOrBlock(
    ctx,
    decision.title ?? "Security check",
    decision.detail ?? reason,
    reason,
  );

  return denied ? handleDecision(denied, ctx) : undefined;
}

/** Built-in file tools consistently carry their target path in path. */
function toolPath(input: unknown, fallback?: string): string | undefined {
  if (!input || typeof input !== "object") return fallback;
  const value = (input as { path?: unknown }).path;
  return typeof value === "string" ? value : fallback;
}

/** Defensive field extraction keeps malformed tool input fail-safe. */
function toolString(input: unknown, field: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

const MESSAGE_CUSTOM_TYPE = "security-status";

function formatSecurityStatus(): string {
  return [
    "Security extension",
    "status: active",
    "protects:",
    "- blocks high-risk bash patterns such as privilege escalation, destructive disk commands, remote script execution, and secret exfiltration patterns",
    "- confirms package manager, container, network fetch, recursive delete, and project script commands when an interactive UI is available",
    "- blocks reads/discovery/mutations of common secret paths such as .env, .ssh, .gnupg, private keys, and secret-like filenames",
    "- allows normal Pi repo docs and authoring reads, while blocking private Pi runtime state such as sessions, logs, caches, state, and debug payloads",
    "- asks for confirmation before modifying Pi authoring surfaces such as personal extensions and skills",
    "- blocks file mutation outside the current project and inside node_modules",
    "- asks for confirmation before modifying executable project configuration such as package.json, lockfiles, shell scripts, CI config, and task files",
  ].join("\n");
}

function showCommandMessage(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({
    customType: MESSAGE_CUSTOM_TYPE,
    content,
    display: true,
    details: {},
  }, { triggerTurn: false });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("security", {
    description: "Show security gate status and protected actions.",
    getArgumentCompletions: (prefix: string) => {
      return "status".startsWith((prefix ?? "").trim().toLowerCase())
        ? [{ value: "status", label: "status", description: "Show active security protections." }]
        : null;
    },
    handler: async (args: string, _ctx: ExtensionCommandContext) => {
      const action = (args ?? "").trim().toLowerCase();
      if (!action || action === "status" || action === "help") {
        showCommandMessage(pi, formatSecurityStatus());
        return;
      }

      showCommandMessage(pi, `Unknown /security action '${action}'. Try /security status.`);
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      // Bash is the broadest escape hatch, so it gets screened before everything else.
      const command = toolString(event.input, "command") ?? "";
      return handleDecision(classifyBash(command), ctx);
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      // Mutations are limited to safe project files unless the user explicitly confirms risk.
      const rawPath = toolPath(event.input);
      if (!rawPath) return handleDecision(block("missing file path"), ctx);

      const absPath = await resolveToolPath(rawPath, ctx);
      return handleDecision(await classifyPath(absPath, rawPath, ctx, "mutate"), ctx);
    }

    if (event.toolName === "read") {
      // Secret reads are as dangerous as secret writes because outputs enter model context.
      const rawPath = toolPath(event.input);
      if (!rawPath) return handleDecision(block("missing file path"), ctx);

      const absPath = await resolveToolPath(rawPath, ctx);
      return handleDecision(await classifyPath(absPath, rawPath, ctx, "read"), ctx);
    }

    if (event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") {
      // Discovery tools can leak filenames or contents from places the model should not inspect.
      const rawPath = toolPath(event.input, ".");
      const absPath = await resolveToolPath(rawPath ?? ".", ctx);
      const pathDecision = await classifyPath(absPath, rawPath ?? ".", ctx, "discover");
      if (pathDecision.action !== "allow") return handleDecision(pathDecision, ctx);

      if ((event.toolName === "grep" || event.toolName === "find") && isBroadPiDiscoveryPath(absPath, os.homedir())) {
        return handleDecision(block(`broad ${event.toolName} of Pi repo; target ~/.pi/agent/extensions, ~/.pi/agent/skills, or a specific public file instead`, rawPath ?? "."), ctx);
      }

      const searchTarget = event.toolName === "grep"
        ? toolString(event.input, "glob")
        : event.toolName === "find"
          ? toolString(event.input, "pattern")
          : undefined;
      const sensitive = searchTarget ? sensitiveFilePattern(searchTarget) : undefined;
      if (sensitive) {
        return handleDecision(block(`discover of ${sensitive}`, searchTarget), ctx);
      }

      return undefined;
    }

    return undefined;
  });
}
