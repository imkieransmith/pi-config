import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setImmediate } from "node:timers/promises";
import { resetCapabilitiesCache, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { advisorRow } from "../advisor/row.ts";
import { explainLater, startExplaining, stopExplaining } from "../shared/explain.ts";
import security from "../security/index.ts";
import { bashRow, countNote, getText, row } from "../shared/tool-rows.ts";
import { pill } from "../shared/tool-pill.ts";
import { diffNote } from "../tool-pills/diff-renderer.ts";
import askUserQuestion from "../ask-user-question/index.ts";
import context from "../context/index.ts";
const piRoot = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..", "..");
import evidence from "../evidence.ts";

const theme: any = { fg: (_: string, t: string) => t, bg: (_: string, t: string) => t, bold: (t: string) => t, inverse: (t: string) => t, getBgAnsi: () => "" };
const command = "cd /Users/kieran/.pi && npm test 2>&1 | grep -E 'pass|fail'; npm run typecheck 2>&1 | grep -c error; git status --short";

/** Renders one tool row the way Pi does: call first, then result, then draw. */
function draw(result: any, { expanded = false, isError = false, isPartial = false } = {}) {
  const ctx: any = { state: {}, expanded, isError, isPartial, args: { command } };
  const call = bashRow.renderCall({ command }, theme, ctx);
  const body = result ? bashRow.renderResult(result, { expanded }, theme, ctx) : undefined;
  return [...call.render(60), ...(body?.render(60) ?? [])].map(l => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
}

const output = { content: [{ type: "text", text: "pass 82\nfail 0\n M README.md\n" }] };

test("shared and advisor rows fit narrow windows, long notes and wide text", () => {
  const ansiTheme = { ...theme, fg: (_: string, s: string) => `\x1b[36m${s}\x1b[39m`, bg: (_: string, s: string) => `\x1b[44m${s}\x1b[49m`, getBgAnsi: () => "\x1b[44m" };
  const shared = row<{ brief: string }>({ name: "advisor", call: args => args.brief, note: () => "a very long note 界🙂".repeat(4) });
  for (const renderer of [shared, advisorRow]) for (const expanded of [false, true]) for (const isPartial of [false, true]) for (const isError of [false, true]) {
    const args = { brief: "界🙂 café ".repeat(10) + "\nsecond line" };
    for (const width of [1, 2, 3, 8, 12, 20, 40, 80]) {
      const ctx: any = { state: {}, expanded, isPartial, isError, args };
      const call = renderer.renderCall(args, ansiTheme, ctx);
      const body = renderer.renderResult({ content: [{ type: "text", text: "界🙂 output\nmore" }], details: {} }, { expanded }, ansiTheme, ctx);
      for (const line of [...call.render(width), ...body.render(width)]) {
        assert.ok(visibleWidth(line) <= width, `${width} columns: ${JSON.stringify(line)}`);
      }
    }
  }
});

test("collapsed rows are one line with a note on the right", () => {
  const lines = draw(output).slice(1, -1);
  assert.deepEqual([draw(output)[0], draw(output)[2]], ["", ""], "padding above and below");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 59); // 60 columns minus the right padding
  assert.match(lines[0], /^ +bash +cd \/Users\/kieran\/\.pi && npm test.*\.\.\. +3 lines ▸$/);
});

test("cut rows keep their tint after the ellipsis", () => {
  const tintTheme = { ...theme, bg: (_: string, t: string) => `<bg>${t}</bg>`, getBgAnsi: () => "<bg>" };
  const ctx: any = { state: {}, expanded: false, isError: false, isPartial: false, args: { command } };
  const [, line] = bashRow.renderCall({ command }, tintTheme, ctx).render(60);
  assert.ok(line.includes("\x1b[0m"));
  assert.ok(line.split("\x1b[0m").slice(1).every(part => part.startsWith("<bg>")));
});

test("expanded rows show the full command and output", () => {
  const lines = draw(output, { expanded: true }).slice(1, -1);
  assert.equal(draw(output, { expanded: true }).filter(l => l === "").length, 3, "one blank line after the title, plus outer padding");
  assert.match(lines[0], /3 lines ▾$/);
  assert.ok(lines.some(l => l.includes("git status --short")));
  assert.deepEqual(lines.slice(-3).map(l => l.trim()), ["pass 82", "fail 0", "M README.md"]);
});

test("expanded rows with a single-line call leave space before the output", () => {
  const read = row({ name: "read", call: () => "file.txt" });
  const ctx: any = { state: {}, expanded: true, isError: false, isPartial: false, args: {} };
  const call = read.renderCall({}, theme, ctx);
  const body = read.renderResult({ content: [{ type: "text", text: "file contents" }], details: undefined }, { expanded: true }, theme, ctx);
  const lines = [...call.render(80), ...body.render(80)].map(l => l.trim());
  assert.match(lines[1], /read +file\.txt/);
  assert.equal(lines[2], "");
  assert.equal(lines[3], "file contents");
});

test("failed rows stay collapsed and show the exit code", () => {
  const lines = draw({ content: [{ type: "text", text: "boom\n\nCommand exited with code 2" }] }, { isError: true }).slice(1, -1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /exit 2 ▸$/);
});

test("running rows have no note or toggle marker", () => {
  const lines = draw(undefined, { isPartial: true }).slice(1, -1);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /[▸▾]/);
});

test("images only show in an open row", () => {
  setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
  // A 1x1 PNG.
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const result: any = { content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data, mimeType: "image/png" }] };
  const read = row({ name: "read", call: () => "shot.png" });
  const drawRead = (expanded: boolean) => {
    const ctx: any = { state: {}, expanded, isError: false, isPartial: false, args: {} };
    const call = read.renderCall({}, theme, ctx);
    const body = read.renderResult(result, { expanded }, theme, ctx);
    return [...call.render(60), ...body.render(60)].join("\n");
  };
  try {
    assert.doesNotMatch(drawRead(false), /1337;File=/);
    assert.match(drawRead(false), /image ▸/);
    assert.match(drawRead(true), /1337;File=/);
    assert.match(drawRead(true), /\n \x1b\[\d+A\x1b\]1337;File=/, "indented to line up with the row text");
  } finally {
    resetCapabilitiesCache();
  }
});

test("diff notes count added and removed lines", () => {
  assert.equal(diffNote("--- a\n+++ a\n@@ -1 +1,2 @@\n-old\n+new\n+more\n same"), "+2 \u22121");
  assert.equal(diffNote(" 1 same\n-2 old\n+2 new"), "+1 \u22121");
  assert.equal(diffNote(""), "no change");
});

/** Registers extensions against a stub Pi and keeps their tool definitions. */
function ownTools(): Record<string, any> {
  const tools: Record<string, any> = {};
  const pi: any = new Proxy({}, { get: (_, key) => key === "registerTool" ? (t: any) => { tools[t.name] = t; } : () => undefined });
  for (const register of [askUserQuestion, context, evidence]) register(pi);
  return tools;
}

function drawTool(tool: any, args: any, result: any, expanded = false) {
  const ctx: any = { state: {}, expanded, isError: false, isPartial: false, args };
  const call = tool.renderCall(args, theme, ctx);
  const body = tool.renderResult(result, { expanded }, theme, ctx);
  return [...call.render(80), ...body.render(80)].map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).filter(Boolean);
}

test("our own tools render as compact rows that expand to the full detail", () => {
  const tools = ownTools();
  assert.deepEqual(Object.keys(tools).sort(), ["ask_user_question", "context_snapshot", "evidence_add", "evidence_get", "evidence_list", "evidence_verify"].sort());
  const text = (t: string, details: any = {}) => ({ content: [{ type: "text", text: t }], details });

  const question = { question: "Which tools do you want to see?", header: "Demo", options: [], multiSelect: false };
  const answered = text("Demo: Old", { questions: [question], answers: { [question.question]: "Old" }, cancelled: false });
  assert.match(drawTool(tools.ask_user_question, { questions: [question] }, answered)[0], /ask user +Which tools do you want to see\? +1 answer ▸$/);
  assert.deepEqual(drawTool(tools.ask_user_question, { questions: [question] }, answered, true).slice(1).map(l => l.trim()), ["Demo: Which tools do you want to see?", "✓ Old"]);


  const add = { note: "Jina search needs a key", source: "https://jina.ai", snippet: "blocked without key" };
  assert.match(drawTool(tools.evidence_add, add, text("stored e123abc: x", { id: "e123abc", duplicate: false }))[0], /evidence +add Jina search needs a key +e123abc ▸$/);
  assert.deepEqual(drawTool(tools.evidence_add, add, text("", { id: "e123abc" }), true).slice(1).map(l => l.trim()), ["https://jina.ai", "blocked without key"]);
  assert.match(drawTool(tools.evidence_list, { limit: 2 }, text("", { count: 2, total: 5 }))[0], /evidence +list +2 of 5 entries ▸$/);

  const finish = text("finished capture c1; saved durable summary s9f8e7d6\n\nGoal: tidy rows");
  assert.match(drawTool(tools.context_snapshot, { action: "finish", summary: "Goal: tidy rows\nMore" }, finish)[0], /snapshot +finish Goal: tidy rows … +s9f8e7d6 ▸$/);
  assert.match(drawTool(tools.context_snapshot, { action: "start", label: "Rows" }, text("started capture cf6c774: Rows"))[0], /snapshot +start Rows +cf6c774 ▸$/);
});

test("the advisor's own row copy draws the same lines as the shared row", () => {
  const ansiTheme: any = { ...theme, fg: (r: string, t: string) => `<${r}>${t}</${r}>`, bold: (t: string) => `<b>${t}</b>`, inverse: (t: string) => `<i>${t}</i>` };
  const shared = row<{ brief?: string }>({
    name: "advisor",
    call: ({ brief }) => brief ?? "",
    note: r => (r.details?.errorMessage ? "failed" : getText(r).trim() ? countNote(getText(r).trimEnd().split("\n").length, "line") : "no output"),
  });
  const args = { brief: "Check the plan\nsecond line of the brief that is quite long indeed" };
  const results = [
    { content: [{ type: "text", text: "## Next step\nGo." }], details: {} },
    { content: [{ type: "text", text: "advisor failed: boom" }], details: { errorMessage: "boom" } },
    { content: [{ type: "text", text: "" }], details: {} },
  ];
  for (const result of results) for (const expanded of [false, true]) for (const isPartial of [false, true]) for (const isError of [false, true]) {
    const drawWith = (r: any) => {
      const ctx: any = { state: {}, expanded, isError, isPartial, args };
      const call = r.renderCall(args, ansiTheme, ctx);
      const body = r.renderResult(result, { expanded }, ansiTheme, ctx);
      return [...call.render(50), ...body.render(50)];
    };
    assert.deepEqual(drawWith(advisorRow), drawWith(shared), JSON.stringify({ expanded, isPartial, isError, result: result.content[0].text }));
  }
  assert.ok(pill("advisor", ansiTheme).includes("\x1b[38;2;47;95;159m advisor "), "same pill colour");
});

test("grep rows get saved plain-English headlines and show the search when open", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-grep-explain-test-"));
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    stopExplaining();
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(dir, "settings.json"), JSON.stringify({ explain: { model: "openrouter/cheap/model" } }));
  const entries: any[] = [];
  const tools: Record<string, any> = {};
  const pi: any = {
    on() {},
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    registerTool: (tool: any) => { tools[tool.name] = tool; },
  };
  security(pi);
  const prompts: any[] = [];
  const session: any = {
    sessionManager: { getBranch: () => entries },
    ui: { notify() {} },
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
      streamSimple: (_model: unknown, payload: any) => {
        prompts.push(payload);
        return { result: async () => ({ content: [{ type: "text", text: "Finds references to entry saving and session starts." }], stopReason: "stop" }) };
      },
    },
  };
  startExplaining(session, pi);
  const args = { pattern: "appendEntry|session_start", path: "agent/extensions", glob: "*.ts", ignoreCase: true };
  let redrawn = false;
  const live: any = { toolCallId: "grep-1", args, state: {}, cwd: "/code/app", argsComplete: true, isPartial: false, expanded: false, isError: false, invalidate: () => { redrawn = true; } };
  const strip = (lines: string[]) => lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
  tools.grep.renderCall(args, theme, live).render(160);
  await setImmediate();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].messages[0].content, /file search/);
  assert.equal(prompts[0].messages[1].content, `Working folder: /code/app\nSearch: ${JSON.stringify(args)}`);
  assert.ok(redrawn);
  assert.deepEqual(entries, [{ type: "custom", customType: "grep-explanation", data: { toolCallId: "grep-1", sentence: "Finds references to entry saving and session starts." } }]);
  assert.match(strip(tools.grep.renderCall(args, theme, live).render(160))[1], /grep +Finds references to entry saving and session starts\./);
  live.expanded = true;
  const open = strip(tools.grep.renderCall(args, theme, live).render(160));
  assert.equal(open[2], "");
  assert.ok(open.some(line => line.includes('"appendEntry|session_start" in agent/extensions *.ts')));

  startExplaining(session, pi);
  const restored: any = { ...live, state: {}, argsComplete: false, executionStarted: false };
  assert.match(strip(tools.grep.renderCall(args, theme, restored).render(160))[1], /Finds references to entry saving and session starts\./);
  assert.equal(prompts.length, 1, "restored rows do not contact Luna");
});

test("separately loaded extensions both start their own explanation state", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-isolated-explain-test-"));
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(dir, "settings.json"), JSON.stringify({ explain: { model: "openrouter/cheap/model" } }));
  const { createJiti } = await import(pathToFileURL(join(piRoot, "node_modules/jiti/lib/jiti.mjs")).href);
  const alias = {
    "@earendil-works/pi-coding-agent": join(piRoot, "dist/bundle/index.js"),
    "@earendil-works/pi-ai": join(piRoot, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
    "@earendil-works/pi-tui": join(piRoot, "node_modules/@earendil-works/pi-tui/dist/index.js"),
  };
  const load = async (file: string) => createJiti(join(piRoot, "dist/core/extensions/loader.js"), { moduleCache: false, alias })
    .import(join(process.cwd(), `agent/extensions/${file}/index.ts`), { default: true });
  const hooks: Record<string, Record<string, Function>> = {};
  const tools: Record<string, any> = {};
  for (const name of ["sandbox", "security"]) {
    hooks[name] = {};
    const register = await load(name);
    register({
      on: (event: string, handler: Function) => { hooks[name][event] = handler; },
      registerTool: (tool: any) => { tools[tool.name] = tool; },
      appendEntry: (type: string, data: any) => entries.push({ type: "custom", customType: type, data }),
    });
  }
  const prompts: string[] = [];
  const entries: any[] = [];
  const session: any = {
    sessionManager: { getBranch: () => entries }, ui: { notify() {} },
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
      streamSimple: (_model: unknown, payload: any) => {
        prompts.push(payload.messages[1].content);
        return { result: async () => ({ content: [{ type: "text", text: "Finds saved entries." }], stopReason: "stop" }) };
      },
    },
  };
  hooks.sandbox.session_start({}, session);
  hooks.security.session_start({}, session);
  const args = { pattern: "appendEntry", path: "agent/extensions" };
  const ctx: any = { toolCallId: "isolated-grep", args, state: {}, cwd: "/code/app", argsComplete: true, isPartial: false, expanded: false, isError: false, invalidate() {} };
  tools.grep.renderCall(args, theme, ctx).render(120);
  await setImmediate();
  assert.equal(prompts.length, 1);
  assert.equal(ctx.state.plain, "Finds saved entries.");
  assert.deepEqual(entries, [{ type: "custom", customType: "grep-explanation", data: { toolCallId: "isolated-grep", sentence: "Finds saved entries." } }]);
  hooks.security.session_start({}, session);
  const restored: any = { ...ctx, state: {}, argsComplete: false };
  tools.grep.renderCall(args, theme, restored).render(120);
  assert.equal(restored.state.plain, "Finds saved entries.");
  assert.equal(prompts.length, 1);
  hooks.sandbox.session_shutdown();
  hooks.security.session_shutdown();
});

test("bash rows swap in a plain-English headline and keep the command when open", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-explain-test-"));
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => { if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before; await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(dir, "settings.json"), JSON.stringify({ explain: { model: "openrouter/cheap/model" } }));
  const sent: string[] = [];
  const entries: any[] = [];
  const pi: any = { appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }) };
  const branch = () => entries;
  const session: any = {
    sessionManager: { getBranch: branch },
    ui: { notify() {} },
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
      streamSimple: (_model: unknown, payload: any, options: any) => {
        assert.deepEqual(options.samplingParams, { reasoning: { enabled: false } }, "thinking off");
        sent.push(payload.messages.at(-1).content);
        return { result: async () => ({ content: [{ type: "text", text: "Runs the tests\nand lists changed files." }], stopReason: "stop" }) };
      },
    },
  };
  startExplaining(session, pi);
  t.after(stopExplaining);
  const unique = `${command} # ${Date.now()}`;

  // A row rebuilt from a saved session never has its arguments marked complete.
  const restored: any = { toolCallId: "old-call", state: {}, args: { command: unique }, isPartial: true, invalidate() {} };
  explainLater("bash", unique, restored);
  assert.equal(restored.state.asked, undefined);

  let redrawn = false;
  const live: any = { toolCallId: "call-1", state: {}, args: { command: unique }, cwd: "/code/app", argsComplete: true, isPartial: true, expanded: false, isError: false, invalidate: () => { redrawn = true; } };
  explainLater("bash", unique, live);
  explainLater("bash", unique, live);
  await setImmediate();
  assert.deepEqual(sent, [`Working folder: /code/app\nCommand: ${unique}`], "asks once per row, with the folder");
  assert.ok(redrawn);
  assert.deepEqual(entries, [{ type: "custom", customType: "bash-explanation", data: { toolCallId: "call-1", sentence: "Runs the tests and lists changed files." } }]);
  const strip = (lines: string[]) => lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
  assert.match(strip(bashRow.renderCall({ command: unique }, theme, live).render(80))[1], /^ +bash +Runs the tests and lists changed files\.$/);
  live.expanded = true;
  const open = strip(bashRow.renderCall({ command: unique }, theme, live).render(200));
  assert.match(open[1], /Runs the tests and lists changed files\./);
  assert.equal(open[2], "", "space between the title and the full command");
  assert.ok(open.some(l => l.includes("git status --short")), "raw command below the sentence");

  // Rebuild from saved entries as /reload or /resume does, without asking Luna.
  startExplaining(session, pi);
  const reopened: any = { ...restored, toolCallId: "call-1", state: {} };
  explainLater("bash", unique, reopened);
  assert.equal(reopened.state.plain, "Runs the tests and lists changed files.");
  assert.equal(sent.length, 1);
  assert.equal(entries.length, 1);

  // Repeated commands reuse the sentence but get their own saved tool-call ID.
  const repeated: any = { ...live, toolCallId: "call-2", state: {} };
  explainLater("bash", unique, repeated);
  await setImmediate();
  assert.equal(sent.length, 2, "cache resets on session start");
  assert.equal(entries.length, 2);
  const again: any = { ...live, toolCallId: "call-3", state: {} };
  explainLater("bash", unique, again);
  assert.equal(sent.length, 2);
  assert.equal(entries.length, 3);

  // Navigating to another branch drops explanations that aren't on its path.
  session.sessionManager.getBranch = () => [];
  startExplaining(session, pi);
  const otherBranch: any = { ...restored, toolCallId: "call-1", state: {} };
  explainLater("bash", unique, otherBranch);
  assert.equal(otherBranch.state.plain, undefined);

  // A reply from the old branch cannot save into the new branch.
  let resolveReply!: (reply: any) => void;
  session.modelRegistry.streamSimple = () => ({ result: () => new Promise(resolve => { resolveReply = resolve; }) });
  const pending: any = { ...live, toolCallId: "call-4", state: {} };
  explainLater("bash", unique, pending);
  await setImmediate();
  startExplaining(session, pi);
  resolveReply({ content: [{ type: "text", text: "Stale sentence." }], stopReason: "stop" });
  await setImmediate();
  assert.equal(entries.length, 3);
  assert.equal(pending.state.plain, undefined);
});
