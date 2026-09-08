import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Keep Pi's working status above the input instead of inside its border. */
export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: false }),
    );
  });
}
