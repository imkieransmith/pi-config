/**
 * Block dangerous commands, protect sensitive paths.
 *
 * Ownership boundary (see also confirm-destructive.ts):
 *   - This extension is an accident-prevention policy, not shell isolation: hard blocks for forbidden/
 *     dangerous actions (privilege escalation, disk/device destruction, remote
 *     script execution, secret exfiltration), secret-path protection, the
 *     Pi-internal tier system, read/discovery gating, and outside-project
 *     mutation. Plus security-flavoured confirms (package managers, network
 *     fetch, project scripts, executable-config mutation).
 *   - DATA-LOSS confirms (rm, git reset --hard, git clean, find -delete,
 *     truncate, etc.) are owned by confirm-destructive.ts, which is
 *     git-recoverability aware. They are deliberately NOT duplicated here to
 *     avoid double prompts. Confirmations share a per-session allow-list via
 *     ../shared/confirm-gate.
 *
 * Original - https://github.com/michalvavra/agents/blob/main/agents/pi/extensions/security.ts
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyResolvedPath as classifyResolvedPathPolicy,
  resolveSecurityPath,
  expandUserPath, isInside, includesSensitiveSegment, classifyPiPath,
  isPiPrivateRuntimePath, isPiPrivateConfigPath, isPiGeneratedModelStatePath,
  isActivePiWorkspacePath, isPiSettingsPath, isPiModelsPath,
  type PathIntent,
  type SecurityDecision,
} from "./policy.js";
import { installSessionAllowReset, requestSessionConfirm } from "../shared/confirm-gate.js";

type Decision = SecurityDecision;

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
  { pattern: /(?:^|[;&|]\s*)(?:env(?:\s+-[A-Za-z]+)?|printenv|set|export\s+-p)\s*(?:$|[;&|])/im, reason: "whole environment disclosure" },
  { pattern: /\bprintenv\s+(?:[A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)\b/i, reason: "secret environment variable disclosure" },
  { pattern: /\b(?:echo|printf)\b[^\n;&|]*\$(?:\{)?(?:[A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)(?:\})?/i, reason: "secret environment variable disclosure" },
];

// Data-loss confirms (rm, git reset --hard, git clean, find -delete, truncate)
// are intentionally absent: confirm-destructive.ts owns them with git-
// recoverability awareness. Duplicating them here caused double prompts. Keep
// only security-flavoured confirms that confirm-destructive does not cover.
// (sed -i / perl -pi stay here: in-place source rewrites are a security concern,
// not a git-recoverable data-loss case that confirm-destructive handles.)
const confirmBashRules: Rule[] = [
  { pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|upgrade|dlx|exec|create)\b/i, reason: "package manager mutation/execution" },
  { pattern: /\b(?:pip|pip3|uv|poetry|cargo|gem|go)\s+(?:install|add|get|update|run)\b/i, reason: "dependency or tool execution" },
  { pattern: /\b(?:docker|podman|kubectl|helm)\b/i, reason: "container or cluster command" },
  { pattern: /\b(?:curl|wget|fetch)\b/i, reason: "network fetch" },
  { pattern: /\b(?:perl\s+-pi|sed\s+-i)\b/i, reason: "in-place file rewrite" },
  { pattern: /\bchmod\b.*(?:\+x|[0-7]*[1357][0-7]?)\b/i, reason: "executable permission change" },
  { pattern: /\b(?:make|just|task|rake)\b/i, reason: "project script execution" },
];

const shellSecretPathRules: Rule[] = [
  { pattern: /(?:^|[\/\s"'`=:@])\.env(?!\.example(?:$|[\/\s"'`<>|&;]))[^\s"'`]*/i, reason: "environment file" },
  { pattern: /(?:^|[\/\s"'`=:@])\.dev\.vars[^\s"'`]*/i, reason: "dev vars file" },
  { pattern: /(?:^|[\/\s"'`=:@])\.ssh(?:\/|$|\s)/i, reason: "SSH directory" },
  { pattern: /(?:^|[\/\s"'`=:@])\.gnupg(?:\/|$|\s)/i, reason: "GnuPG directory" },
  { pattern: /(?:^|[\/\s"'`=:@])\.(?:aws|kube|docker)(?:\/|$|\s)/i, reason: "cloud or container credentials" },
  { pattern: /(?:^|[\/\s"'`=:@])\.config\/(?:gh|gcloud)(?:\/|$|\s)/i, reason: "CLI credentials" },
  { pattern: /(?:^|[\/\s"'`=:@])\.(?:npmrc|netrc|git-credentials|pypirc|pgpass|my\.cnf|boto|s3cfg)(?:$|[\/\s"'`<>|&;])/i, reason: "credential file" },
  { pattern: /(?:^|[\/\s"'`=:@])\.git(?:\/|$|\s)/i, reason: "git internals" },
  { pattern: /\b(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)\b/i, reason: "SSH private key" },
  { pattern: /[^\s"'`]+\.(?:pem|key)(?:$|[\s"'`<>|&;])/i, reason: "private key file" },

];

const sensitiveReadCommands = /\b(?:cat|sed|awk|grep|rg|find|fd|ls|tree|head|tail|less|more|nl|strings|xxd|od|cp|mv|install|tee|sponge|tar|zip|gzip|base64|openssl|curl|rsync|scp|python3?|node|ruby|perl|php)\b/i;
const shellWriteOperators = /(?:^|[^<>])>>?\s*|(?:\|\s*)?(?:tee|sponge|cp|mv|install)\b/i;
const shellWordPattern = /"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+/g;

/** Notify only when Pi is running with an interactive UI. */
function notify(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "warning");
}

async function resolveToolPath(rawPath: string, ctx: ExtensionContext): Promise<string> {
  return resolveSecurityPath(rawPath, ctx.cwd);
}

/** TODO.md files are AI scratchpads; path policy still applies before any Bash rewrite exemption. */
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

function shellPiReferences(command: string, cwd: string): string[] {
  const words = (command.match(shellWordPattern) ?? []).map(cleanShellWord);
  const refs = words.filter((word) =>
    /(?:^|[\/])\.pi(?:[\/]|$)|^~\/\.pi(?:[\/]|$)/.test(word.replace(/\\/g, "/")),
  );

  const home = os.homedir();
  const piRoot = path.join(home, ".pi");
  if (isInside(piRoot, path.resolve(cwd))) {
    for (const word of words) {
      if (word.startsWith("-") || (!word.includes("/") && !/\.[A-Za-z0-9]/.test(word))) continue;
      const candidate = path.resolve(cwd, expandUserPath(word));
      if (isInside(piRoot, candidate)) refs.push(word);
    }
  }

  return [...new Set(refs)];
}

function shellRefToApproxPath(word: string, cwd: string): string {
  const cleaned = expandUserPath(word).replace(/\\/g, path.sep);
  if (path.isAbsolute(cleaned)) return path.resolve(cleaned);

  const normalized = cleaned.replace(/\\/g, "/");
  const piIndex = normalized.split("/").indexOf(".pi");
  if (piIndex >= 0) {
    const parts = normalized.split("/").slice(piIndex + 1);
    return path.join(os.homedir(), ".pi", ...parts);
  }

  return path.resolve(cwd, cleaned);
}

function shellWritesToPiReference(command: string): boolean {
  const piPath = String.raw`(?:"[^"]*\.pi(?:\/[^">|&;]*)?"|'[^']*\.pi(?:\/[^'>|&;]*)?'|[^\s"'\`<>|&;]*\.pi(?:\/[^\s"'\`<>|&;]*)?)`;
  return new RegExp(String.raw`(?:>>?\s*${piPath}|\b(?:tee|sponge|cp|mv|install)\b[^\n;|&]*${piPath})`, "i").test(command);
}

function classifyBashPiReferences(command: string, cwd: string): Decision {
  const refs = shellPiReferences(command, cwd);
  if (refs.length === 0) return ALLOW;

  const home = os.homedir();
  const writesToPi = shellWritesToPiReference(command);
  for (const ref of refs) {
    const approxPath = shellRefToApproxPath(ref, cwd);
    const sensitive = includesSensitiveSegment(approxPath);
    if (sensitive) return block(`bash touches protected path: ${sensitive}`, command);

    if (isPiPrivateRuntimePath(approxPath, home)) {
      return block("bash touches protected path: Pi private runtime state", command);
    }
    if (isPiGeneratedModelStatePath(approxPath, home)) {
      return block("bash touches protected path: Pi generated model state", command);
    }
    if (isPiPrivateConfigPath(approxPath, home)) {
      if (isActivePiWorkspacePath(approxPath, cwd, home) && isPiSettingsPath(approxPath, home)) {
        continue;
      }
      if (isActivePiWorkspacePath(approxPath, cwd, home) && isPiModelsPath(approxPath, home)) {
        return {
          action: "confirm",
          reason: "accessing Pi model configuration",
          title: "Security check: access Pi model configuration?",
          detail: command,
          allowKey: "security:pi-model-config",
        };
      }
      return block("bash touches protected path: Pi provider/model configuration", command);
    }

    const tier = classifyPiPath(approxPath, home);
    if (tier === "outside") continue;
    if (isActivePiWorkspacePath(approxPath, cwd, home) && !writesToPi) continue;
    if (isActivePiWorkspacePath(approxPath, cwd, home) && tier === "authoring") continue;
    if (tier === "private") return block("bash touches protected path: Pi private runtime state", command);
    if (tier === "config") return block("bash touches protected path: Pi provider/model configuration", command);
    if (tier === "authoring" && writesToPi) return confirm("modify Pi authoring surface", command);
  }

  return ALLOW;
}

function stripLiteralHeredocBodies(command: string): string {
  const lines = command.split(/\r?\n/);
  const output: string[] = [];
  const pendingDelimiters: Array<{ word: string; allowLeadingTabs: boolean }> = [];

  // Only quoted or backslash-escaped delimiters are literal. Unquoted heredoc
  // bodies remain visible to policy because shell expansions execute there.
  const heredocPattern = /<<-?\s*(?:"([^"]+)"|'([^']+)'|\\([^\s;&|()<>]+))/g;

  for (const line of lines) {
    const pending = pendingDelimiters[0];
    if (pending) {
      const comparable = pending.allowLeadingTabs ? line.replace(/^\t+/, "") : line;
      if (comparable === pending.word) {
        output.push(line);
        pendingDelimiters.shift();
      } else if (output[output.length - 1] !== "[literal heredoc body omitted]") {
        output.push("[literal heredoc body omitted]");
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

/** Search globs can target secrets even when the search root looks harmless. */
function sensitiveFilePattern(value: string): string | undefined {
  const normalized = value.replace(/\\/g, "/");

  if (/(^|\/)\.env(?!\.example(?:$|\/))[^/]*/i.test(normalized)) return "environment file";
  if (/(^|\/)\.dev\.vars[^/]*/i.test(normalized)) return "dev vars file";
  if (/(^|\/)\.(?:ssh|gnupg|aws|kube|docker|git)(?:$|\/)/i.test(normalized)) return "sensitive directory";
  if (/(^|\/)\.config\/(?:gh|gcloud)(?:$|\/)/i.test(normalized)) return "CLI credentials";
  if (/(^|\/)\.(?:npmrc|netrc|git-credentials|pypirc|pgpass|my\.cnf|boto|s3cfg)(?:$|\/)/i.test(normalized)) return "credential file";
  if (/(^|\/)\.pi\/agent\/(?:sessions|history|cache|logs|state|tmp|evidence|advisor)(?:$|\/)/i.test(normalized)) return "Pi private runtime state";
  if (/\.(?:pem|key)(?:$|[^\w])/i.test(normalized)) return "private key file";
  if (/\b(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)\b/i.test(normalized)) return "SSH private key";
  if (/(?:^|\/)(?:secrets?|credentials?|api[_-]?keys?)(?:\.(?:json|ya?ml|toml|ini|txt))?$/i.test(normalized)) return "secret material";

  return undefined;
}

async function classifyPath(
  absPath: string,
  rawPath: string,
  ctx: ExtensionContext,
  intent: PathIntent,
): Promise<Decision> {
  const cwd = await resolveToolPath(".", ctx);
  return classifyResolvedPathPolicy(absPath, rawPath, cwd, os.homedir(), intent);
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
    allowKey: `security:${reason}`,
  };
}

/** Bash is not parseable with regex, so this is conservative damage reduction. */
// Exported for the de-dupe test harness; pi only invokes the default export.
export function classifyBash(command: string, cwd = process.cwd()): Decision {
  const commandForRules = stripLiteralHeredocBodies(command).replace(
    /(?:-not|!)\s+-(?:path|name)\s+(?:"[^"$`]*"|'[^']*'|[^\s;&|$`]+)/g, ""
  ).replace(/(?:--glob|-g)\s+(?:"![^"$`]*"|'![^']*'|![^\s;&|$`]+)/g, "");

  for (const rule of hardBashRules) {
    if (rule.pattern.test(commandForRules)) return block(rule.reason, commandForRules);
  }

  const piDecision = classifyBashPiReferences(commandForRules, cwd);
  if (piDecision.action !== "allow") return piDecision;

  if (sensitiveReadCommands.test(commandForRules) || shellWriteOperators.test(commandForRules)) {
    for (const ref of shellFileReferences(commandForRules)) {
      const sensitive = includesSensitiveSegment(ref);
      if (sensitive) return block(`bash touches protected path: ${sensitive}`, commandForRules);
    }
  }

  for (const rule of shellSecretPathRules) {
    if (rule.pattern.test(commandForRules) && (sensitiveReadCommands.test(commandForRules) || shellWriteOperators.test(commandForRules))) {
      return block(`bash touches protected path: ${rule.reason}`, commandForRules);
    }
  }

  for (const rule of confirmBashRules) {
    if (rule.pattern.test(commandForRules)) {
      if (rule.reason === "in-place file rewrite" && shellRewriteTargetsOnlyTodo(commandForRules)) continue;
      return confirm(rule.reason, commandForRules);
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
  const outcome = await requestSessionConfirm(
    ctx,
    {
      title: decision.title ?? "Security check",
      detail: decision.detail ?? reason,
      allowKey: decision.allowKey ?? `security:${reason}`,
    },
    reason,
  );

  if (outcome.allow) return undefined;
  notify(ctx, `Security blocked: ${reason}`);
  return { block: true, reason: outcome.reason ?? `${reason} blocked by user` };
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
    "status: active (accident prevention, not a shell/filesystem sandbox)",
    "protects:",
    "- blocks high-risk bash patterns such as privilege escalation, destructive disk commands, remote script execution, environment disclosure, and secret exfiltration patterns",
    "- confirms package manager, container, network fetch, in-place rewrite, and project script commands when an interactive UI is available (with an 'allow for this session' option)",
    "- defers file/git data-loss prompts (rm, git reset --hard, git clean, find -delete, truncate) to the confirm-destructive extension to avoid double prompts",
    "- blocks reads/discovery/mutations of common secret paths such as .env, .ssh, .gnupg, cloud/CLI credential directories, credential dotfiles, private keys, and known credential filenames",
    "- allows ordinary reads and discovery anywhere without prompts; protected descendants are removed from built-in search results",
    "- allows built-in reads, discovery, and mutations anywhere under canonical /tmp without confirmation; symlink escapes are still classified by their real destination",
    "- treats an active ~/.pi workspace like a normal project for reads/discovery and allows changes to personal extensions, skills, and settings",
    "- asks once per session before accessing ~/.pi/agent/models.json, while blocking auth, generated model state, sessions, logs, caches, state, and debug payloads",
    "- asks before modifying Pi authoring surfaces when ~/.pi is not the active workspace",
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
  installSessionAllowReset(pi);

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
    try {
      if (event.toolName === "bash") {
        // Bash is the broadest escape hatch, so it gets screened before everything else.
        const command = toolString(event.input, "command") ?? "";
        return handleDecision(classifyBash(command, ctx.cwd), ctx);
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
    } catch {
      return { block: true, reason: "Security could not verify this tool call; no action was allowed" };
    }
  });
}
