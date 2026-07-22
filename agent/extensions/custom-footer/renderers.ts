import { visibleWidth } from "@earendil-works/pi-tui";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_ROLES: Record<ThinkingLevel, string> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

type ThemeFg = { fg: (role: any, text: string) => string };

// ── Tokens ─────────────────────────────────────────────────────────────

export function fmtTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

// ── Path ───────────────────────────────────────────────────────────────

export function renderPath(
	pathRaw: string,
	budget: number,
	theme: ThemeFg,
): string {
	if (budget < 10) return "";
	if (visibleWidth(pathRaw) <= budget) return theme.fg("warning", pathRaw);
	return theme.fg("warning", "…" + pathRaw.slice(-(budget - 1)));
}

export function buildPathString(cwd: string, branch: string | null): string {
	let pwd = cwd;
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
	return pwd + (branch ? ` (${branch})` : "");
}

// ── Context Usage ──────────────────────────────────────────────────────

export function formatContextUsage(
	pct: number | null,
	win: number,
	estimated = false,
): string {
	const percent = pct === null ? "?%" : `${estimated ? "~" : ""}${pct.toFixed(0)}%`;
	return `${percent}/${fmtTokens(win)}`;
}

export function renderContextUsage(
	pct: number | null,
	win: number,
	theme: { fg: (role: any, text: string) => string },
	estimated = false,
): string {
	const raw = formatContextUsage(pct, win, estimated);
	if (pct !== null && pct > 90) return theme.fg("error", raw);
	if (pct !== null && pct > 70) return theme.fg("warning", raw);
	return theme.fg("success", raw);
}

// ── Model + Thinking ───────────────────────────────────────────────────

export function renderModelInfo(
	modelName: string,
	provider: string,
	thinking: string,
	theme: ThemeFg,
): { text: string; rawWidth: number } {
	const thinkSuffix = ` • ${thinking}`;
	const rawWidth = visibleWidth(`◈ ${modelName} (${provider})${thinkSuffix}`);

	const role = THINKING_ROLES[thinking as ThinkingLevel] ?? THINKING_ROLES.off;
	const text = theme.fg("accent", `◈ ${modelName}`)
		+ theme.fg("muted", ` (${provider})`)
		+ theme.fg("dim", " • ")
		+ theme.fg(role, thinking);

	return { text, rawWidth };
}

// ── Usage Bars (Line 2) ───────────────────────────────────────────────

export function clampPct(v: number): number {
	return Math.max(0, Math.min(100, Math.round(v)));
}

type ThemeRole = "success" | "warning" | "error";
function colorForPct(v: number): ThemeRole {
	return v >= 90 ? "error" : v >= 70 ? "warning" : "success";
}

const BAR_WIDTH = 8;

export function renderBar(
	pct: number,
	theme: { fg: (role: any, text: string) => string },
): string {
	const v = clampPct(pct);
	const filled = Math.round((v / 100) * BAR_WIDTH);
	return theme.fg(colorForPct(v), "█".repeat(filled))
		+ theme.fg("dim", "░".repeat(BAR_WIDTH - filled));
}

export function renderPct(
	pct: number,
	theme: { fg: (role: any, text: string) => string },
): string {
	const v = clampPct(pct);
	return theme.fg(colorForPct(v), `${v}%`.padStart(4));
}
