/**
 * Protect sensitive paths from Pi's own file tools (read, write, edit, grep,
 * find, ls). These run inside Pi, not through bash, so the sandbox in
 * ../sandbox/ does not cover them.
 *
 * Bash is not checked here: the sandbox enforces its limits at the OS level.
 * Data-loss confirms for write/edit live in ../confirm-destructive.ts.
 * Confirmations share a per-session allow-list via ../shared/confirm-gate.
 *
 * Original - https://github.com/michalvavra/agents/blob/main/agents/pi/extensions/security.ts
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import {
  classifyResolvedPath as classifyResolvedPathPolicy,
  resolveSecurityPath,
  type PathIntent,
  type SecurityDecision,
} from "./policy.js";
import { installSessionAllowReset, requestSessionConfirm } from "../shared/confirm-gate.js";

type Decision = SecurityDecision;

/** Notify only when Pi is running with an interactive UI. */
function notify(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "warning");
}

async function resolveToolPath(rawPath: string, ctx: ExtensionContext): Promise<string> {
  return resolveSecurityPath(rawPath, ctx.cwd);
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

export default function (pi: ExtensionAPI) {
  installSessionAllowReset(pi);

  pi.on("tool_call", async (event, ctx) => {
    try {
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
