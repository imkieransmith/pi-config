import { estimateTokens, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	buildPathString,
	formatContextUsage,
	renderContextUsage,
	renderModelInfo,
	renderPath,
} from "./renderers.js";

interface ContextUsageDisplay {
	percent: number | null;
	contextWindow: number;
	estimated: boolean;
}

function getContextUsageDisplay(ctx: ExtensionContext): ContextUsageDisplay {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;

	if (usage?.percent !== null && usage?.percent !== undefined) {
		return { percent: usage.percent, contextWindow, estimated: false };
	}

	if (contextWindow <= 0) {
		return { percent: null, contextWindow, estimated: false };
	}

	const estimatedTokens = ctx.sessionManager
		.buildSessionContext()
		.messages
		.reduce((total, message) => total + estimateTokens(message), 0);

	return {
		percent: (estimatedTokens / contextWindow) * 100,
		contextWindow,
		estimated: true,
	};
}

export default function (pi: ExtensionAPI) {
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

	// ── Line 1: Path │ Context │ Model ─────────────────────────────────

	function renderLine1(
		width: number,
		theme: { fg: (role: any, text: string) => string; bold: (text: string) => string; inverse: (text: string) => string },
		ctx: ExtensionContext,
		gitBranch: string | null,
	): string {
		const sep = theme.fg("dim", " │ ");
		const sepW = 3;

		// Path + branch
		const pathRaw = buildPathString(ctx.cwd, gitBranch);

		// Context usage. Pi reports null immediately after compaction, so show
		// its rebuilt-message estimate until provider usage is available again.
		const usage = getContextUsageDisplay(ctx);
		const ctxRaw = formatContextUsage(usage.percent, usage.contextWindow, usage.estimated);
		const ctxColored = renderContextUsage(
			usage.percent,
			usage.contextWindow,
			theme,
			usage.estimated,
		);

		// Model + thinking
		const provider = ctx.model?.provider || "unknown";
		const modelName = ctx.model?.id || "no-model";
		const thinking = pi.getThinkingLevel();
		const modelInfo = renderModelInfo(modelName, provider, thinking, theme);

		// Layout: compute path budget from remaining space
		const rightBlockWidth = visibleWidth(ctxRaw) + sepW + modelInfo.rawWidth;
		const pathBudget = width - rightBlockWidth - sepW;
		const pathDisplay = renderPath(pathRaw, pathBudget, theme);

		// Assemble
		const segments: string[] = [];
		if (pathDisplay) segments.push(pathDisplay);
		segments.push(ctxColored);
		segments.push(modelInfo.text);

		return truncateToWidth(segments.join(sep), width);
	}
}
