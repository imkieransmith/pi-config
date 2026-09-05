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
 * A shared weak map scopes grants to the session manager and session ID.
 * Each extension load installs its own lifecycle reset.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ALLOW_STATE_KEY = Symbol.for("pi-confirm-gate-sessions");
type SessionContext = Pick<ExtensionContext, "sessionManager">;
interface GateState { sessionId: string; allowedKeys: Set<string> }

// A manager identifies an SDK session instance; its ID changes on new/resume.
// Weak keys neither mix concurrent instances nor retain closed sessions.
function states(): WeakMap<object, GateState> {
  const globals = globalThis as unknown as { [key: symbol]: WeakMap<object, GateState> | undefined };
  return globals[ALLOW_STATE_KEY] ??= new WeakMap();
}
function gateState(ctx: SessionContext): GateState {
  const manager = ctx.sessionManager;
  const sessionId = manager.getSessionId();
  let state = states().get(manager);
  if (!state || state.sessionId !== sessionId) {
    state = { sessionId, allowedKeys: new Set() };
    states().set(manager, state);
  }
  return state;
}
function resetSessionAllowList(ctx: SessionContext): void {
  states().delete(ctx.sessionManager);
}
export function installSessionAllowReset(pi: ExtensionAPI): void {
  // Register on every extension load, not once for the entire process.
  pi.on("session_start", (_event, ctx) => resetSessionAllowList(ctx));
  pi.on("session_shutdown", (_event, ctx) => resetSessionAllowList(ctx));
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
  try {
    const signal = ctx.signal;
    if (signal?.aborted) return { allow: false, reason: "Confirmation aborted" };
    const state = gateState(ctx);
    if (state.allowedKeys.has(req.allowKey)) return { allow: true };
    if (!ctx.hasUI) return { allow: false, reason: `${noUiReason} (no UI to confirm)` };

    const choice = await ctx.ui.select(`${req.title}\n${req.detail}`, [ALLOW_ONCE, ALLOW_SESSION, BLOCK], { signal });

    if (signal?.aborted) return { allow: false, reason: "Confirmation aborted" };
    if (gateState(ctx) !== state) return { allow: false, reason: "Session changed during confirmation" };
    if (choice === ALLOW_ONCE) return { allow: true };
    if (choice === ALLOW_SESSION) {
      state.allowedKeys.add(req.allowKey);
      return { allow: true };
    }
    return { allow: false };
  } catch {
    return { allow: false, reason: "Confirmation unavailable or session closed" };
  }
}
