import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { createGrepToolDefinition, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import plan from "../plan.ts";
import advisor from "../advisor/index.ts";
import customFooter from "../custom-footer/custom-footer.ts";
import questions from "../ask-user-question/index.ts";
import { AskUserQuestionComponent } from "../ask-user-question/component.ts";
import { QuestionSchema } from "../ask-user-question/schema.ts";
import { classifyBash } from "../security/index.ts";
import { classifyResolvedPath } from "../security/policy.ts";
import { protectDiscovery } from "../security/search.ts";
import { assess_bash_command } from "../confirm-destructive.ts";
import { installSessionAllowReset, requestSessionConfirm } from "../shared/confirm-gate.ts";
import { redact_text, redact_value } from "../redact.ts";
import { registerDiffTools } from "../tool-pills/diff-renderer.ts";
import { renderOverview } from "../resource-overview.ts";
import metrics, { formatMetricsRow } from "../response-metrics.ts";
import meep from "../meep.ts";
import { paintLine, patchRender } from "../colour-messages/index.ts";

export function harness() {
  const hooks = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sent: unknown[][] = [];
  let active = ["read", "ask_user_question"];
  const pi = {
    on: (name: string, fn: Function) => hooks.set(name, [...hooks.get(name) ?? [], fn]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    getCommands: () => [{ name: "skill:write-plan", source: "skill", description: "Plan work" }],
    getAllTools: () => [],
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
    sendUserMessage: (...args: unknown[]) => sent.push(args),
  } as unknown as ExtensionAPI;
  return { pi, hooks, tools, commands, sent };
}
const theme = {
  fg: (_role: string, text: string) => text, bg: (_role: string, text: string) => text,
  bold: (text: string) => text, inverse: (text: string) => text,
} as Theme;
const question = { question: "Choose an option", header: "A perfectly normal longer heading", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false };

function context(id = "one", manager?: object): ExtensionContext {
  return { mode: "tui", hasUI: true, cwd: process.cwd(),
    sessionManager: manager ?? { getSessionId: () => id },
    ui: { select: async () => "Allow similar for this session", notify() {} },
  } as unknown as ExtensionContext;
}

test("session grants reset on reload/new session and do not cross SDK instances", async () => {
  const ctx = context(); const other = context(); const request = { title: "Test", detail: "Synthetic", allowKey: "test" };
  assert.equal((await requestSessionConfirm(ctx, request, "denied")).allow, true);
  assert.equal((await requestSessionConfirm({ ...ctx, hasUI: false }, request, "denied")).allow, true);
  assert.equal((await requestSessionConfirm({ ...other, hasUI: false }, request, "denied")).allow, false);
  for (let load = 0; load < 2; load++) {
    const { pi, hooks } = harness(); installSessionAllowReset(pi);
    assert.equal(hooks.get("session_start")?.length, 1);
    await hooks.get("session_start")![0]({}, ctx);
    assert.equal((await requestSessionConfirm({ ...ctx, hasUI: false }, request, "denied")).allow, false);
    await requestSessionConfirm(ctx, request, "denied");
  }
  let id = "old"; const changing = context("", { getSessionId: () => id });
  await requestSessionConfirm(changing, request, "denied"); id = "new";
  assert.equal((await requestSessionConfirm({ ...changing, hasUI: false }, request, "denied")).allow, false);
});

test("approval from a stale prompt cannot grant access to a replacement session", async () => {
  let id = "one"; const ctx = context("", { getSessionId: () => id });
  ctx.ui.select = async () => { id = "two"; return "Allow similar for this session"; };
  assert.equal((await requestSessionConfirm(ctx, { title: "test", detail: "test", allowKey: "stale" }, "denied")).allow, false);
});

test("ordinary source paths are not credential guesses", async () => {
  for (const name of ["PersonalAccessToken.php", "design-tokens.css", "credentials-form.vue", "secrets.test.ts", "docs/api-keys.md"]) {
    assert.equal((await classifyResolvedPath(`/projects/app/${name}`, name, "/projects/elsewhere", "/home/example", "read")).action, "allow", name);
  }
  for (const name of [".env", "credentials.json", ".ssh/config"]) {
    assert.equal((await classifyResolvedPath(`/projects/app/${name}`, name, "/projects/app", "/home/example", "read")).action, "block", name);
  }
});

test("negative find patterns and ordinary filenames don't trigger secret reads", () => {
  for (const cmd of ['find agent/extensions -not -path "*/.git/*"', 'rg test -g "!**/.env"', 'readlink PersonalAccessToken.php', 'head design-tokens.css']) {
    assert.equal(classifyBash(cmd, "/projects/app").action, "allow", cmd);
  }
  assert.equal(classifyBash("head ~/.ssh/config", "/projects/app").action, "block");
  assert.equal(classifyBash("head credentials.json", "/projects/app").action, "block");
  assert.equal(classifyBash("rg token src", "/projects/app").action, "allow");
});

test("destructive commands are checked without executing them", async () => {
  for (const cmd of ["printf ok\nrm missing.txt", "git restore src/example.ts", "git -C /example reset --hard", "git --git-dir=/example reset --hard", "git checkout -- src/example.ts", "git checkout src/example.ts", "git -C /example -C subdir reset --hard", "cd /elsewhere; rm x", "rm *.txt"]) {
    assert.ok(await assess_bash_command(cmd, "/nonexistent"), cmd);
  }
  for (const cmd of ["git status --short", "git -C /example diff --stat", "printf hello"]) assert.equal(await assess_bash_command(cmd, "/nonexistent"), undefined, cmd);
});

test("/plan expands the skill and does not force-close a capture", async () => {
  const { pi, commands, sent } = harness(); plan(pi);
  await commands.get("plan").handler("scope a task", { waitForIdle: async () => {}, ui: { notify() {} } });
  assert.deepEqual(sent, [["/skill:write-plan scope a task", { expandPromptTemplates: true }]]);
});

test("questions accept long headers, disable outside TUI and tolerate missing custom UI results", async () => {
  assert.ok(!("maxLength" in QuestionSchema.properties.header));
  const { pi, tools, hooks } = harness(); questions(pi);
  await hooks.get("session_start")![0]({}, { mode: "rpc" });
  assert.ok(!pi.getActiveTools().includes("ask_user_question"));
  const params = { questions: [question] };
  for (const mode of ["rpc", "json", "print", "tui"]) {
    const result = await tools.get("ask_user_question").execute("id", params, undefined, undefined, { mode, ui: { custom: async () => undefined } });
    assert.equal(result.details.cancelled, true);
  }
});

test("question choice, free text and cancellation remain bounded on narrow screens", () => {
  const outcomes: unknown[] = [];
  const component = new AskUserQuestionComponent([question], { requestRender() {}, terminal: { rows: 24 } }, theme, result => outcomes.push(result));
  for (const width of [8, 20, 40, 100]) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
  component.handleInput("\r");
  assert.equal((outcomes[0] as any).answers[question.question], "Yes");
  component.handleInput("\r"); assert.equal(outcomes.length, 1);
  const cancel = new AskUserQuestionComponent([question, question], { requestRender() {}, terminal: { rows: 24 } }, theme, result => outcomes.push(result));
  cancel.handleInput("\x1b"); assert.equal(outcomes.at(-1), null);
});

test("truncated question headers keep the ellipsis inside the selected background", () => {
  const styledTheme = {
    ...theme,
    fg: (_role: string, text: string) => `\x1b[37m${text}\x1b[39m`,
    bg: (_role: string, text: string) => `\x1b[44m${text}\x1b[49m`,
  } as Theme;
  for (const header of [question.header, "界🙂 café ".repeat(10)]) {
    for (const count of [2, 4]) {
      const component = new AskUserQuestionComponent(
        Array.from({ length: count }, () => ({ ...question, header })),
        { requestRender() {}, terminal: { rows: 24 } }, styledTheme, () => {},
      );
      for (const width of [40, 80, 120]) {
        const lines = component.render(width);
        const selected = lines[1].match(/\x1b\[44m(.*?)\x1b\[49m/)?.[1];
        assert.ok(selected, "Expected a selected tab");
        assert.ok(selected.includes("..."), "Expected a shortened selected header");
        assert.ok(!selected.includes("\x1b[0m"), "A reset ends the tab background before its ellipsis");
        assert.ok(lines.every(line => visibleWidth(line) <= width));
      }
    }
  }
});

test("quoted JSON/YAML and nested tool details redact synthetic credentials", () => {
  const source = "const token = 0; const password: string;";
  assert.equal(redact_text(source).redacted, source);
  for (const text of ['{"api_key":"synthetic-api-value", "password":"a short phrase"}', "password: 'short'", "API_KEY=synthetic-api-value"]) {
    const result = redact_text(text).redacted;
    assert.ok(!result.includes("synthetic-api-value") && !result.includes("short"), result);
  }
  const details = redact_value({ password: "tiny", preview: '{"api_key":"synthetic-api-value"}', count: 4 }) as any;
  assert.ok(!JSON.stringify(details).includes("synthetic-api-value"));
  assert.notEqual(details.password, "tiny"); assert.equal(details.count, 4);
});

test("search filtering removes sensitive descendants and raw truncation details", async t => {
  // A local fixture is outside canonical /tmp's intentional full trust exemption.
  const dir = await mkdtemp(join(process.cwd(), "agent/extensions/tests/search-fixture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "normal.ts"), "ordinary"); await writeFile(join(dir, ".env"), "synthetic");
  await mkdir(join(dir, ".ssh"));
  await writeFile(join(dir, ".ssh", "x:1: fake\nnormal.ts"), "synthetic secret contents");
  const tool = protectDiscovery(createGrepToolDefinition(dir));
  for (const contextLines of [0, 1, 3]) {
    const result = await tool.execute("id", { path: dir, pattern: "ordinary|synthetic", context: contextLines }, undefined, undefined, context());
    assert.ok(JSON.stringify(result).includes("ordinary")); assert.ok(!JSON.stringify(result).includes("synthetic"));
    assert.equal(result.details, undefined);
  }
});

test("overview reflects actual commands/tools and stays within terminal width", () => {
  const { pi } = harness();
  for (const width of [1, 8, 40, 100]) for (const line of renderOverview(pi, theme, width)) assert.ok(visibleWidth(line) <= width);
});

test("footer keeps statuses inline without empty rows and disposes its subscription", async () => {
  const { pi, hooks } = harness();
  pi.getThinkingLevel = () => "high";
  customFooter(pi);
  let footer: any; let branchChanged: Function = () => {};
  let renders = 0; let disposed = false;
  const statuses = new Map<string, string>();
  const ctx = {
    ...context(),
    model: { id: "gpt-6-astra", provider: "openai-codex", contextWindow: 272000 },
    getContextUsage: () => ({ percent: 28, contextWindow: 272000 }),
    ui: { setFooter: (factory: Function) => {
      footer = factory({ requestRender: () => renders++ }, theme, {
        getGitBranch: () => "main", getExtensionStatuses: () => statuses,
        onBranchChange: (callback: Function) => { branchChanged = callback; return () => { disposed = true; }; },
      });
    } },
  };
  await hooks.get("session_start")![0]({}, ctx);
  assert.match(footer.render(120)[0], /28%\/272k.*◈ gpt-6-astra \(openai-codex\) • high/);
  for (const status of ["", " \n\t ", "\x1b[0m", "advisor unavailable", "warning\nmore detail"]) {
    statuses.set("test", status);
    for (const width of [1, 20, 40, 80, 120]) {
      const lines = footer.render(width);
      assert.equal(lines.length, 1);
      assert.ok(!/[\r\n]/.test(lines[0]));
      assert.ok(visibleWidth(lines[0]) <= width);
    }
    if (status === "advisor unavailable") assert.ok(footer.render(120)[0].includes(" │ advisor unavailable"));
  }
  branchChanged(); assert.equal(renders, 1);
  footer.dispose(); assert.equal(disposed, true);
});

test("advisor clears its normal footer status and only warns when unavailable", async () => {
  const { pi, hooks } = harness(); advisor(pi);
  let available = true;
  const statuses = new Map<string, string | undefined>();
  const ctx = {
    ...context(),
    modelRegistry: { find: (provider: string, id: string) => {
      assert.equal(provider, "openai-codex"); assert.equal(id, "gpt-6-astra");
      return available ? { provider, id, reasoning: true } : undefined;
    } },
    ui: { theme, setStatus: (key: string, value: string | undefined) => statuses.set(key, value) },
  };
  await hooks.get("session_start")![0]({}, ctx);
  assert.equal(statuses.get("advisor"), undefined);
  available = false;
  await hooks.get("before_agent_start")![0]({}, ctx);
  assert.equal(statuses.get("advisor"), "advisor unavailable");
  available = true;
  await hooks.get("before_agent_start")![0]({}, ctx);
  assert.equal(statuses.get("advisor"), undefined);
});

test("native write queue supplies the actual baseline for concurrent diff previews", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-write-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "sample.txt"); await writeFile(file, "old\n");
  const { pi, tools } = harness(); registerDiffTools(pi);
  const ctx = { ...context(), cwd: dir };
  const write = tools.get("write");
  const results = await Promise.all([write.execute("one", { path: file, content: "first\n" }, undefined, undefined, ctx), write.execute("two", { path: file, content: "second\n" }, undefined, undefined, ctx)]);
  assert.ok(results[0].details.preview.includes("-old"));
  assert.ok(results[1].details.preview.includes("-first"));
  assert.equal(await readFile(file, "utf8"), "second\n");
  const edit = tools.get("edit");
  const result = await edit.execute("edit", { path: file, edits: [{ oldText: "second", newText: "third" }] }, undefined, undefined, ctx);
  assert.ok(result.details.diff); assert.equal(await readFile(file, "utf8"), "third\n");
});


test("reload rejects an outstanding approval even when the session ID is unchanged", async () => {
  const { pi, hooks } = harness(); installSessionAllowReset(pi);
  const ctx = context();
  ctx.ui.select = async () => { await hooks.get("session_start")![0]({}, ctx); return "Allow similar for this session"; };
  assert.equal((await requestSessionConfirm(ctx, { title: "test", detail: "test", allowKey: "reload" }, "denied")).allow, false);
});

test("questions retain multi-select, free-text and abort behavior", async () => {
  const outcomes: any[] = [];
  const component = new AskUserQuestionComponent([{ ...question, multiSelect: true }], { requestRender() {}, terminal: { rows: 24 } }, theme, result => outcomes.push(result));
  for (const key of [" ", "\x1b[B", " ", "\r"]) component.handleInput(key);
  assert.equal(outcomes[0].answers[question.question], "Yes, No");
  const text = new AskUserQuestionComponent([question], { requestRender() {}, terminal: { rows: 24 } }, theme, result => outcomes.push(result));
  for (const key of ["\x1b[B", "\x1b[B", " ", "My own answer"]) text.handleInput(key);
  for (const width of [8, 40]) for (const line of text.render(width)) assert.ok(visibleWidth(line) <= width);
  text.handleInput("\r"); assert.equal(outcomes[1].answers[question.question], "My own answer");
  const { pi, tools } = harness(); questions(pi);
  const controller = new AbortController();
  const promise = tools.get("ask_user_question").execute("id", { questions: [question] }, controller.signal, undefined, { mode: "tui", ui: { custom: (factory: Function) => new Promise(resolve => { factory({ requestRender() {}, terminal: { rows: 24 } }, theme, {}, resolve); controller.abort(); }) } });
  assert.equal((await promise).details.cancelled, true);
});

test("row coloring preserves explicit diff backgrounds and restores its patch", () => {
  assert.ok(paintLine("\x1b[48;2;10;20;30mchange\x1b[49m", 20, "\x1b[48;2;40;50;60m").includes("\x1b[48;2;10;20;30m"));
  const original = () => ["example"];
  const prototype = { render: original };
  const undo = patchRender(prototype, "user", { user: "", work: "", assistant: "" });
  assert.notEqual(prototype.render, original); undo(); assert.equal(prototype.render, original);
});

test("response metrics include cache and tool-model usage and wait until settled", async () => {
  const { pi, hooks } = harness(); const entries: any[] = [];
  pi.registerEntryRenderer = () => {};
  pi.appendEntry = (...args) => { entries.push(args); };
  metrics(pi);
  await hooks.get("before_agent_start")![0]({});
  await hooks.get("message_end")![0]({ message: { role: "assistant", usage: { input: 5, cacheRead: 7, cacheWrite: 3, output: 2 } } });
  await hooks.get("tool_execution_end")![0]({ result: { usage: { input: 11, cacheRead: 13, cacheWrite: 0, output: 4 } } });
  assert.equal(entries.length, 0);
  await hooks.get("agent_settled")![0]({}, { mode: "tui" });
  assert.equal(entries[0][1].inputTokens, 39); assert.equal(entries[0][1].outputTokens, 6);
});

test("model token rate weights response time and excludes tools, user waits and nested usage", async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const { pi, hooks } = harness(); const entries: any[] = [];
  pi.registerEntryRenderer = () => {};
  pi.appendEntry = (_type, data) => { entries.push(data); };
  metrics(pi);
  const usage = { input: 5, cacheRead: 7, cacheWrite: 3, output: 100 };
  await hooks.get("before_agent_start")![0]({});
  await hooks.get("turn_start")![0]({});
  // Includes the whole response wait, not just time after the first chunk.
  now = 2_000;
  await hooks.get("message_end")![0]({ message: { role: "assistant", usage } });
  await hooks.get("tool_execution_start")![0]({});
  now = 30_000; // A tool and a user reply took time.
  await hooks.get("tool_execution_end")![0]({ result: { usage: { ...usage, output: 900 } } });
  now = 50_000;
  await hooks.get("turn_start")![0]({});
  now = 54_000;
  await hooks.get("message_end")![0]({ message: { role: "assistant", usage: { ...usage, output: 300 } } });
  now = 60_000;
  await hooks.get("agent_settled")![0]({}, { mode: "tui" });
  assert.equal(entries[0].elapsedMs, 60_000);
  assert.equal(entries[0].outputTokens, 1_300); // Totals still include nested calls.
  assert.equal(entries[0].inputTokens, 45);
  assert.equal(entries[0].modelTokensPerSecond, 400 / 6);
  assert.match(formatMetricsRow(entries[0]), / │ ~66\.7 tok\/s$/);

  // A new run must not retain the previous run's timing or tokens.
  await hooks.get("before_agent_start")![0]({});
  await hooks.get("turn_start")![0]({});
  now = 61_000;
  await hooks.get("message_end")![0]({ message: { role: "assistant", usage } });
  await hooks.get("agent_settled")![0]({}, { mode: "tui" });
  assert.equal(entries[1].modelTokensPerSecond, 100);
  assert.match(formatMetricsRow(entries[1]), / │ ~100 tok\/s$/);
});

test("model token rate stays absent without measured time or reported output", async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const { pi, hooks } = harness(); const entries: any[] = [];
  pi.registerEntryRenderer = () => {};
  pi.appendEntry = (_type, data) => { entries.push(data); };
  metrics(pi);
  for (const mode of ["no start", "zero time", "no output"]) {
    await hooks.get("before_agent_start")![0]({});
    if (mode !== "no start") await hooks.get("turn_start")![0]({});
    if (mode !== "zero time") now += 1_000;
    await hooks.get("message_end")![0]({ message: { role: "assistant", usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: mode === "no output" ? 0 : 10 } } });
    await hooks.get("agent_settled")![0]({}, { mode: "tui" });
    assert.equal(entries.at(-1).modelTokensPerSecond, undefined);
    assert.ok(!formatMetricsRow(entries.at(-1)).includes("tok/s"));
  }
});

test("rate rendering rejects invalid measurements and keeps a single bounded row", () => {
  const { pi } = harness(); let renderEntry: Function = () => {};
  pi.registerEntryRenderer = (_type, renderer) => { renderEntry = renderer; };
  metrics(pi);
  const data = { elapsedMs: 1000, toolCalls: 1, inputTokens: 100, outputTokens: 50 };
  for (const rate of [undefined, 50, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const component = renderEntry({ data: { ...data, modelTokensPerSecond: rate } }, {}, theme);
    for (const width of [1, 40, 120]) {
      const lines = component.render(width);
      assert.equal(lines.length, 1);
      assert.ok(visibleWidth(lines[0]) <= width);
    }
    const row = component.render(120)[0];
    if (rate === undefined) assert.ok(!row.includes("tok/s"));
    else if (rate === 50) assert.ok(row.endsWith(" │ ~50 tok/s"));
    else assert.equal(row, "Response metrics unavailable");
  }
});

test("sounds use prompt/settled events and remain quiet outside TUI", async () => {
  const { pi, hooks } = harness(); meep(pi);
  assert.ok(hooks.has("ui_prompt_start")); assert.ok(hooks.has("agent_settled"));
  assert.ok(!hooks.has("agent_end") && !hooks.has("tool_call"));
  for (const hook of hooks.values()) await hook[0]({}, { mode: "rpc" });
});


test("confirmation errors, stale runtime getters and aborts deny rather than throw", async () => {
  const req = { title: "test", detail: "test", allowKey: "abort" };
  const ctx = context();
  ctx.ui.select = async () => { throw new Error("Synthetic UI failure"); };
  assert.equal((await requestSessionConfirm(ctx, req, "denied")).allow, false);
  const controller = new AbortController();
  const aborting = { ...context(), signal: controller.signal };
  aborting.ui.select = async () => { controller.abort(); return "Allow once"; };
  assert.equal((await requestSessionConfirm(aborting, req, "denied")).allow, false);
  let active = true; const manager = ctx.sessionManager;
  const stale = { ...context(), get sessionManager() { if (!active) throw new Error("Stale runner"); return manager; } };
  stale.ui.select = async () => { active = false; return "Allow similar for this session"; };
  assert.equal((await requestSessionConfirm(stale, req, "denied")).allow, false);
});
