import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	buildPathString,
	fmtTokens,
	modePillWidth,
	renderContextUsage,
	renderModelInfo,
	renderModePill,
	renderPath,
	type PermissionMode,
} from "./renderers.js";

export default function (pi: ExtensionAPI) {
	let currentMode: PermissionMode = "safe";

	// Optional inter-extension event. If no permission/mode extension is loaded,
	// this simply remains at the safe default.
	pi.events.on("mode:change", (data: unknown) => {
		if (data === "safe" || data === "read-only" || data === "yolo") {
			currentMode = data;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					return [renderLine1(width, theme, ctx, footerData.getGitBranch())];
				},
			};
		});
	});

	// ── Line 1: Mode │ Path │ Context │ Model ──────────────────────────

	function renderLine1(
		width: number,
		theme: { fg: (role: any, text: string) => string; bold: (text: string) => string; inverse: (text: string) => string },
		ctx: { cwd: string; getContextUsage(): { percent: number | null; contextWindow: number } | null | undefined; model: { provider?: string; id?: string; contextWindow?: number } | null | undefined },
		gitBranch: string | null,
	): string {
		const sep = theme.fg("dim", " │ ");
		const sepW = 3;

		// Mode pill
		const pill = renderModePill(currentMode, theme);
		const pillW = modePillWidth(currentMode);

		// Path + branch
		const pathRaw = buildPathString(ctx.cwd, gitBranch);

		// Context usage
		const usage = ctx.getContextUsage();
		const pct = usage?.percent ?? 0;
		const win = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const ctxRaw = `${pct.toFixed(0)}%/${fmtTokens(win)}`;
		const ctxColored = renderContextUsage(pct, win, theme);

		// Model + thinking
		const provider = ctx.model?.provider || "unknown";
		const modelName = ctx.model?.id || "no-model";
		const thinking = pi.getThinkingLevel();
		const modelInfo = renderModelInfo(modelName, provider, thinking, theme);

		// Layout: compute path budget from remaining space
		const rightBlockWidth = visibleWidth(ctxRaw) + sepW + modelInfo.rawWidth;
		const pathBudget = width - pillW - sepW - rightBlockWidth - sepW;
		const pathDisplay = renderPath(pathRaw, pathBudget, theme);

		// Assemble
		const segments: string[] = [pill];
		if (pathDisplay) segments.push(pathDisplay);
		segments.push(ctxColored);
		segments.push(modelInfo.text);

		return truncateToWidth(segments.join(sep), width);
	}
}
