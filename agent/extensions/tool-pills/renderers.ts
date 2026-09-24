/**
 * One-line tool rows: pill, call text and a short note on the right.
 *
 * Output stays hidden until the row is expanded. In fullscreen mode Pi toggles
 * a single row on left click; Ctrl+O toggles every row.
 */
import type { AgentToolResult, ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { convertToPng, highlightCode } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, getCapabilities, Image, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { redact_value } from "../redact.ts";
import { pill } from "./pill.ts";

type Result = AgentToolResult<any>;
/** Pi passes this to renderers; the package doesn't export its type. `state` is shared by one row's call and result. */
type Png = { data: string; mimeType: string };
export type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2] & {
  state: {
    note?: string; hasBody?: boolean; png?: Record<number, Png | "pending" | "failed">;
    /** bash only: the plain-English sentence, and whether one has been asked for (explain.ts). */
    plain?: string; asked?: boolean;
  };
};

export type RowSpec<Args = any> = {
  name: string;
  /** Text after the pill. May span lines; collapsed rows show the first line only. */
  call: (args: Args, theme: Theme, ctx: RenderContext) => string;
  /** Short note for the right edge of a successful row. Defaults to the output's line count. */
  note?: (result: Result, args: Args) => string;
  /** Expanded output. Defaults to the text output. */
  body?: (result: Result, theme: Theme, args: Args) => string;
};

/** First text block of a tool result. */
export function getText(result: Result): string {
  const c = result.content.find(c => c.type === "text");
  return c?.type === "text" ? c.text : "";
}

export function countNote(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function defaultNote(result: Result): string {
  if (result.content.some(c => c.type === "image")) return "image";
  const text = getText(result).trimEnd();
  return text ? countNote(text.split("\n").length, "line") : "no output";
}

function errorNote(result: Result): string {
  const text = getText(result);
  const exit = text.match(/exited with code (\d+)/);
  if (exit) return `exit ${exit[1]}`;
  return /timed out/.test(text) ? "timed out" : "error";
}

/** A component that draws whatever lines the callback returns for the given width. */
function lines(make: (width: number) => string[]): Component {
  return { render: make, invalidate() {} };
}

function tinted(ctx: RenderContext, theme: Theme, ...children: Component[]): Box {
  const role = ctx.isPartial ? "toolPendingBg" : ctx.isError ? "toolErrorBg" : "toolSuccessBg";
  // truncateToWidth ends cut text with a full reset, which would drop the tint for the rest of the line.
  const box = new Box(1, 0, text => theme.bg(role, text.replaceAll("\x1b[0m", `\x1b[0m${theme.getBgAnsi(role)}`)));
  for (const child of children) box.addChild(child);
  return box;
}

/**
 * The result's images, drawn only in an open row. Pi's own image drawing is off
 * (terminal.showImages: false in settings.json), or it would show them below every row.
 */
function images(result: Result, theme: Theme, ctx: RenderContext): Component[] {
  const caps = getCapabilities();
  if (!caps.images) return [];
  return result.content.flatMap((block, i) => {
    if (block.type !== "image") return [];
    let image: Png = block;
    // The kitty protocol (Ghostty, kitty) only takes PNG: convert once, then redraw.
    if (caps.images === "kitty" && block.mimeType !== "image/png") {
      const png = (ctx.state.png ??= {});
      if (!png[i]) {
        png[i] = "pending";
        void convertToPng(block.data, block.mimeType).then(out => {
          png[i] = out ?? "failed";
          ctx.invalidate();
        });
      }
      const done = png[i];
      if (typeof done === "string") return [];
      image = done;
    }
    const picture = new Image(image.data, image.mimeType, { fallbackColor: s => theme.fg("toolOutput", s) }, { maxWidthCells: 60 });
    // Indent one column to line up with the row's text.
    return [new Spacer(1), lines(width => picture.render(width - 1).map(line => ` ${line}`))];
  });
}

function headerLines(head: string, note: string, width: number, expanded: boolean, theme: Theme): string[] {
  const noteWidth = visibleWidth(note);
  const room = Math.max(10, width - (noteWidth ? noteWidth + 2 : 0));
  const [first, ...rest] = head.split("\n");
  const lines = expanded
    ? [...wrapTextWithAnsi(first, room), "", ...rest.flatMap(line => wrapTextWithAnsi(line, room))]
    : [truncateToWidth(rest.length ? `${first}${theme.fg("dim", " …")}` : first, room)];
  lines[0] += " ".repeat(Math.max(1, width - visibleWidth(lines[0]) - noteWidth)) + note;
  return lines;
}

/** renderShell/renderCall/renderResult for a compact row. Spread into a tool definition. */
export function row<Args>(spec: RowSpec<Args>) {
  return {
    renderShell: "self" as const,
    renderCall(args: Args, theme: Theme, ctx: RenderContext): Component {
      ctx.state.hasBody = false; // renderResult runs next and sets this if it draws output.
      return tinted(ctx, theme, lines(width => {
        // renderResult fills the note later in the same update, before this draws.
        const done = !ctx.isPartial;
        const text = [ctx.state.note, done ? (ctx.expanded ? "▾" : "▸") : ""].filter(Boolean).join(" ");
        const note = theme.fg(ctx.isError ? "error" : "dim", text);
        const header = headerLines(`${pill(spec.name, theme)} ${spec.call(args, theme, ctx)}`, note, width, ctx.expanded, theme);
        // One line of padding above and below the whole row; the body adds the bottom one when shown.
        return ["", ...header, ...(ctx.state.hasBody ? [] : [""])];
      }));
    },
    renderResult(result: Result, { expanded }: { expanded: boolean }, theme: Theme, ctx: RenderContext): Component {
      ctx.state.note = ctx.isPartial ? undefined : ctx.isError ? errorNote(result) : (spec.note ?? defaultNote)(result, ctx.args as Args);
      if (!expanded) return new Text("", 0, 0);
      const body = ctx.isError
        ? theme.fg("error", getText(result).trim())
        : spec.body ? spec.body(result, theme, ctx.args as Args) : theme.fg("toolOutput", getText(result).trimEnd());
      ctx.state.hasBody = true;
      const pictures = images(result, theme, ctx);
      if (!pictures.length) return tinted(ctx, theme, new Text(body, 0, 0), new Spacer(1));
      const out = new Container();
      for (const child of [tinted(ctx, theme, new Text(body, 0, 0)), ...pictures, new Spacer(1)]) out.addChild(child);
      return out;
    },
  };
}

/** Registers a built-in read-only tool (ls, read, find, grep) as a compact, redacted row. */
export function wrapBasicTool<Args>(pi: ExtensionAPI, orig: any, spec: RowSpec<Args>): void {
  pi.registerTool({
    ...orig,
    parameters: { ...orig.parameters },
    async execute(id: string, args: Args, signal: AbortSignal | undefined, _update: unknown, ctx: unknown) {
      const result = await orig.execute(id, args, signal, undefined, ctx);
      return { ...result, content: redact_value(result.content), details: redact_value(result.details) };
    },
    ...row(spec),
  });
}

/** The raw command, or once explain.ts has one, a plain-English sentence with the command below it when open. */
export const bashRow = row<{ command?: string }>({
  name: "bash",
  call: (args, _theme, ctx) => {
    const command = highlightCode(args.command ?? "", "bash").join("\n");
    const plain = ctx.state.plain;
    if (!plain) return command;
    return ctx.expanded ? `${plain}\n${command}` : plain;
  },
});
