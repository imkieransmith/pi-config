/**
 * Allows the model to ask the user questions, with the option for the user to type in an answer.
 *
 * Original - https://github.com/tomsej/pi-ext/tree/main/extensions/ask-user-question
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { countNote, getText, row } from "../shared/tool-rows.ts";
import { AskUserQuestionComponent } from "./component.ts";
import { InputSchema, type Question, type Result } from "./schema.ts";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") pi.setActiveTools(pi.getActiveTools().filter(name => name !== "ask_user_question"));
  });
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User",
    description: `Ask the user 1–4 clarifying questions before proceeding.
Use this tool when multiple valid approaches exist and you need the user's preference to continue.
Each question must have 2–4 options for the user to choose from.
Set multiSelect: true when more than one option can validly apply at the same time.
The header is a short tab label. Long labels are shortened in the display.
Always use this tool instead of asking questions in plain text — it provides a structured, interactive UI.`,

    parameters: InputSchema,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") {
        // Non-interactive session — deregister so the LLM won't try again
        pi.setActiveTools(
          pi.getActiveTools().filter((name) => name !== "ask_user_question"),
        );
        return {
          content: [
            {
              type: "text",
              text: "Error: ask_user_question requires an interactive session. The tool has been disabled for this session.",
            },
          ],
          details: {
            questions: params.questions,
            answers: {},
            cancelled: true,
          } satisfies Result,
        };
      }

      let onAbort: (() => void) | undefined;
      let result: Result | null | undefined;
      try {
        if (signal?.aborted) return { content: [{ type: "text", text: "Question aborted" }], details: { questions: params.questions, answers: {}, cancelled: true } };
        result = await ctx.ui.custom<Result | null>((tui, theme, _kb, done) => {
          onAbort = () => done(null);
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) done(null);
          return new AskUserQuestionComponent(params.questions, tui, theme, done);
        });
      } finally {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }

      if (!result || result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled" }],
          details: {
            questions: params.questions,
            answers: {},
            cancelled: true,
          } satisfies Result,
        };
      }

      const summaryLines = result.questions.map(
        (q) => `${q.header}: ${result.answers[q.question] ?? "(no answer)"}`,
      );

      return {
        content: [{ type: "text", text: summaryLines.join("\n") }],
        details: result satisfies Result,
      };
    },

    ...row<{ questions?: Question[] }>({
      name: "ask user",
      // One question shows in full; several show their short headers.
      call: ({ questions = [] }) => questions.length === 1
        ? questions[0].question
        : `${questions.length} questions: ${questions.map(q => q.header).join(", ")}`,
      note: result => {
        const details = result.details as Result | undefined;
        if (!details || details.cancelled) return "cancelled";
        return countNote(Object.keys(details.answers).length, "answer");
      },
      body: (result, theme) => {
        const details = result.details as Result | undefined;
        if (!details || details.cancelled) return theme.fg("warning", getText(result) || "Cancelled");
        return details.questions.map(q => [
          theme.fg("accent", `${q.header}: `) + q.question,
          theme.fg("success", "✓ ") + (details.answers[q.question] ?? theme.fg("dim", "(no answer)")),
        ].join("\n")).join("\n\n");
      },
    }),
  });
}
