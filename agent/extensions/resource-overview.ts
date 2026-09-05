/** Show actual available commands, skills and active tools, not a second disk inventory. */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export function renderOverview(pi: ExtensionAPI, theme: Theme, width: number): string[] {
  if (width < 1) return [];
  const commands = pi.getCommands().filter(command => command.source !== "skill").sort((a, b) => a.name.localeCompare(b.name));
  const skills = pi.getCommands().filter(command => command.source === "skill").map(command => command.name.replace(/^skill:/, ""));
  const lines = ["", theme.bold(theme.fg("accent", "Pi")), "", theme.fg("mdHeading", "Commands")];
  for (const command of commands.slice(0, 18)) {
    const name = truncateToWidth(`/${command.name}`, Math.min(22, width));
    lines.push(theme.fg("accent", name) + theme.fg("muted", `  ${command.description ?? ""}`));
  }
  if (commands.length > 18) lines.push(theme.fg("dim", `+${commands.length - 18} more commands`));
  for (const [label, names] of [["Skills", skills], ["Active tools", pi.getActiveTools()]] as const) {
    if (!names.length) continue;
    lines.push("", theme.fg("mdHeading", `${label} (${names.length})`));
    lines.push(...wrapTextWithAnsi(theme.fg("muted", names.join(" · ")), width));
  }
  lines.push("");
  return lines.map(line => truncateToWidth(line, width));
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader((_tui, theme) => ({
      invalidate() {},
      render: width => renderOverview(pi, theme, width),
    }));
  });
}
