import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { requestSessionConfirm } from "../shared/confirm-gate.ts";
import { appendFileSync } from "node:fs";

// Explicitly loaded only by the offline integration test, never a normal extension entrypoint.
export default function (pi: ExtensionAPI) {
  pi.registerProvider("harness-test", {
    api: "openai-completions", apiKey: "synthetic-test-auth", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "test", name: "Offline test", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const prompt = last?.role === "user" && typeof last.content === "string" ? last.content : last?.role === "user" && Array.isArray(last.content) ? last.content.filter(p => p.type === "text").map(p => p.type === "text" ? p.text : "").join("\n") : "";
      if (process.env.PI_HARNESS_REQUESTS) appendFileSync(process.env.PI_HARNESS_REQUESTS, JSON.stringify({ prompt, lastTool: last?.role === "toolResult" ? { name: last.toolName, content: last.content } : undefined }) + "\n");
      const tail = Array.from({ length: 20 }, (_, index) => `line ${index}: Unicode 界 🙂`).join("\n");
      const calls: Record<string, { name: string; arguments: Record<string, unknown> }> = {
        "question fixture": { name: "ask_user_question", arguments: { questions: [{ header: "A normal heading longer than twelve characters", question: "Select the synthetic test answer", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false }] } },
        "write fixture": { name: "write", arguments: { path: process.env.PI_HARNESS_WRITE!, content: `first\n${tail}\n` } },
        "rewrite fixture": { name: "write", arguments: { path: process.env.PI_HARNESS_WRITE!, content: `second\n${tail}\n` } },
        "edit fixture": { name: "edit", arguments: { path: process.env.PI_HARNESS_WRITE!, edits: [{ oldText: "second", newText: "third" }] } },
        "tracked edit fixture": { name: "edit", arguments: { path: process.env.PI_HARNESS_TRACKED_EDIT!, edits: [{ oldText: "heading", newText: "updated heading" }] } },
        "tracked removal fixture": { name: "edit", arguments: { path: process.env.PI_HARNESS_TRACKED_EDIT!, edits: [{ oldText: "removable content\n".repeat(50), newText: "" }] } },
        "bash fixture": { name: "bash", arguments: { command: "git status --short" } },
        "bash failure fixture": { name: "bash", arguments: { command: "npm test" } },
        "read fixture": { name: "read", arguments: { path: process.env.PI_HARNESS_FILE! } },
        "search fixture": { name: "grep", arguments: { path: process.env.PI_HARNESS_SEARCH!, pattern: "fixture" } },
      };
      const call = calls[prompt];
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: call ? [{ type: "toolCall", id: "test-call", ...call }] : [{ type: "text", text: "Offline test done" }],
        stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); stream.end(); });
      return stream;
    },
  });
  const request = { title: "Synthetic test", detail: "No real permission requested", allowKey: "integration:grant" };
  pi.registerCommand("harness-theme", { description: "Test only", handler: async (args, ctx) => { ctx.ui.setTheme(args.trim()); } });
  pi.registerCommand("harness-grant", { description: "Test only", handler: async (_args, ctx) => {
    await requestSessionConfirm({ ...ctx, ui: { ...ctx.ui, select: async () => "Allow similar for this session" } }, request, "test");
  } });
  pi.registerCommand("harness-status", { description: "Test only", handler: async (_args, ctx) => {
    const grant = await requestSessionConfirm({ ...ctx, hasUI: false }, request, "test");
    ctx.ui.notify(JSON.stringify({ testStatus: true, allowed: grant.allow, tools: pi.getActiveTools(), sessionFile: ctx.sessionManager.getSessionFile() }), "info");
  } });
  pi.registerCommand("harness-fork", { description: "Test only", handler: async (_args, ctx) => {
    const entry = ctx.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user");
    if (!entry) throw new Error("No fixture message to fork");
    const result = await ctx.fork(entry.id);
    if (result.cancelled) throw new Error("Fixture fork cancelled");
  } });
  pi.registerCommand("harness-switch", { description: "Test only", handler: async (args, ctx) => {
    const result = await ctx.switchSession(args.trim());
    if (result.cancelled) throw new Error("Fixture switch cancelled");
  } });
  pi.registerCommand("harness-reload", { description: "Test only", handler: async (_args, ctx) => { await ctx.reload(); } });
}
