/**
 * Shared confirmation gate for the destructive/security extensions.
 *
 * Provides a single 3-way confirmation ("Allow once" / "Allow for this session"
 * / "Block") with a per-session allow-list shared across extensions, so a
 * command approved "for this session" in one gate is not re-prompted by the
 * other. Fail-closed in non-UI modes (print/JSON/subagent).
 *
 * Consumers:
 *   - security.ts            — security boundary (hard blocks + confirms)
 *   - confirm-destructive.ts — git-aware data-loss safety net
 * See those files for the command-ownership split that prevents double prompts.
 *
 * The allow-list lives on globalThis (Symbol-keyed) so it survives module
 * re-import across /new, /fork, /resume, and is genuinely shared between the
 * two extension modules rather than being a per-module closure.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ALLOW_STATE_KEY = Symbol.for("pi-confirm-gate-allowlist");
const RESET_INSTALLED_KEY = Symbol.for("pi-confirm-gate-reset-installed");

interface GateState {
  allowedKeys: Set<string>;
}

function gateState(): GateState {
  const g = globalThis as unknown as { [k: symbol]: GateState | undefined };
  if (!g[ALLOW_STATE_KEY]) g[ALLOW_STATE_KEY] = { allowedKeys: new Set<string>() };
  return g[ALLOW_STATE_KEY]!;
}

export function isSessionAllowed(allowKey: string): boolean {
  return gateState().allowedKeys.has(allowKey);
}

export function rememberSessionAllow(allowKey: string): void {
  gateState().allowedKeys.add(allowKey);
}

export function resetSessionAllowList(): void {
  gateState().allowedKeys.clear();
}

/**
 * Register a one-time session_start reset so "for this session" memory is
 * scoped to the actual session. Safe to call from every consuming extension —
 * a globalThis guard ensures the handler is registered only once.
 */
export function installSessionAllowReset(pi: ExtensionAPI): void {
  const g = globalThis as unknown as { [k: symbol]: boolean | undefined };
  if (g[RESET_INSTALLED_KEY]) return;
  g[RESET_INSTALLED_KEY] = true;
  pi.on("session_start", async () => resetSessionAllowList());
}

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow similar for this session";
const BLOCK = "Block";

export interface ConfirmRequest {
  /** Heading shown to the user. */
  title: string;
  /** Body / command preview shown under the heading. */
  detail: string;
  /** Stable key grouping "allow for session" decisions. */
  allowKey: string;
}

export interface ConfirmOutcome {
  allow: boolean;
  /** Set when blocked without a UI; suitable as a tool_call block reason. */
  reason?: string;
}

/**
 * Three-way confirmation with shared per-session memory. Returns `allow: true`
 * when the action may proceed. Fail-closed where there is no UI to confirm.
 */
export async function requestSessionConfirm(
  ctx: ExtensionContext,
  req: ConfirmRequest,
  noUiReason: string,
): Promise<ConfirmOutcome> {
  if (isSessionAllowed(req.allowKey)) return { allow: true };
  if (!ctx.hasUI) return { allow: false, reason: `${noUiReason} (no UI to confirm)` };

  const choice = await ctx.ui.select(`${req.title}\n${req.detail}`, [ALLOW_ONCE, ALLOW_SESSION, BLOCK]);

  if (choice === ALLOW_ONCE) return { allow: true };
  if (choice === ALLOW_SESSION) {
    rememberSessionAllow(req.allowKey);
    return { allow: true };
  }
  return { allow: false };
}
