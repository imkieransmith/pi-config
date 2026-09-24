import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import type { AssistantMessage, AuthResult } from "@earendil-works/pi-ai";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { engineStats, resetEngineState, runAdvisor } from "../advisor/engine.ts";
import { createModelFixture } from "./model-fixture.ts";

const usage = { input: 10, output: 4, cacheRead: 20, cacheWrite: 3, cacheWrite1h: 1, reasoning: 2, totalTokens: 37,
  cost: { input: 0.25, output: 0.5, cacheRead: 0.25, cacheWrite: 0, total: 1 } };
function reply(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
  return {
    role: "assistant", api: "openai-completions", provider: "local-test", model: "test", timestamp: 0,
    content: [{ type: "text", text: stopReason === "stop" ? "Recovered advice" : "Failed partial response" }],
    stopReason, errorMessage, usage: { ...usage, cost: { ...usage.cost } },
  };
}
type Outcome = AssistantMessage | Error | (() => AssistantMessage | Promise<AssistantMessage>);
async function fixture(t: TestContext, outcomes: Outcome[]) {
  const dir = await mkdtemp("/tmp/pi-advisor-test-");
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before;
    await rm(dir, { recursive: true, force: true });
  });
  resetEngineState();
  const model = { id: "test", provider: "local-test", api: "openai-completions", reasoning: true, baseUrl: "https://default.example", contextWindow: 200_000 } as any;
  const calls: any[] = [], updates: any[] = [];
  let authCalls = 0;
  const auth = { resolve: async (): Promise<AuthResult | undefined> => ({
    auth: { apiKey: `synthetic-${++authCalls}`, baseUrl: "https://tenant.example", headers: { "x-attempt": String(authCalls) } }, env: { ATTEMPT: String(authCalls) },
  }) };
  const modelRegistry = await createModelFixture(model, (selected, payload, options) => {
    calls.push({ selected, payload, options });
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    if (!outcome) throw new Error("Unexpected extra advisor request");
    return typeof outcome === "function" ? outcome() : outcome;
  }, () => auth.resolve());
  const ctx = {
    cwd: dir, model, modelRegistry,
    sessionManager: { getBranch: () => [], getSessionId: () => "test", getSessionFile: () => undefined },
  } as unknown as ExtensionContext;
  const pi = { getAllTools: () => [], getActiveTools: () => [] } as unknown as ExtensionAPI;
  const params = { model, effort: "high" as const, brief: "Synthetic retry check", onUpdate: (update: unknown) => { updates.push(update); } };
  return { ctx, pi, params, calls, updates, dir, auth };
}

test("advisor resolves endpoint, headers and environment through Pi and preserves failure usage", async t => {
  const f = await fixture(t, [reply("stop"), reply("error", "Synthetic failure"), reply("aborted")]);
  for (const stopReason of ["stop", "error", "aborted"]) {
    const result = await runAdvisor(f.ctx, f.pi, f.params);
    assert.equal(f.calls.at(-1).selected.baseUrl, "https://tenant.example");
    assert.equal(f.calls.at(-1).options.reasoning, "high");
    assert.equal(f.calls.at(-1).options.env.ATTEMPT, String(f.calls.length));
    assert.equal(f.calls.at(-1).options.headers["x-attempt"], String(f.calls.length));
    assert.deepEqual(result.usage, usage);
    assert.equal(Boolean(result.details.errorMessage), stopReason !== "stop");
  }
  assert.equal(f.params.model.baseUrl, "https://default.example", "original model is not mutated");
  assert.deepEqual(await readdir(join(f.dir, "advisor")), ["debug.jsonl"]);
  const log = await readFile(join(f.dir, "advisor", "debug.jsonl"), "utf8");
  assert.ok(!log.includes(f.params.brief) && !log.includes("Recovered advice"));
});

test("advisor accepts successful no-key auth and rejects unconfigured auth before dispatch", async t => {
  const f = await fixture(t, [reply("stop")]);
  f.auth.resolve = async () => ({ auth: { baseUrl: "https://keyless.example", headers: { "x-local": "yes" } } });
  const result = await runAdvisor(f.ctx, f.pi, f.params);
  assert.equal(result.details.errorMessage, undefined);
  assert.equal(f.calls[0].selected.baseUrl, "https://keyless.example");
  assert.equal(f.calls[0].options.apiKey, undefined);
  f.auth.resolve = async () => undefined;
  const failed = await runAdvisor(f.ctx, f.pi, f.params);
  assert.match(failed.details.errorMessage!, /not configured/);
  assert.equal(f.calls.length, 1);
});

test("advisor retries WebSocket errors with fresh auth and summed usage", async t => {
  const failed = reply("error", 'WebSocket error: {"token":"synthetic-secret-value"}');
  const f = await fixture(t, [failed, reply("stop")]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = runAdvisor(f.ctx, f.pi, f.params);
  await setImmediate();
  assert.equal(f.calls.length, 1);
  assert.ok(f.updates.at(-1).content[0].text.includes("retry 1/2 in 2s"));
  assert.ok(!JSON.stringify(f.updates).includes("synthetic-secret-value"));
  t.mock.timers.tick(1999); await setImmediate(); assert.equal(f.calls.length, 1);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].payload, f.calls[1].payload);
  assert.equal(f.calls[0].payload.messages[0].role, "system");
  assert.match(f.calls[0].payload.messages[0].content, /You advise a coding agent/);
  assert.equal(f.calls[1].options.headers["x-attempt"], "2");
  assert.equal(f.calls[1].options.env.ATTEMPT, "2");
  assert.equal(result.usage?.input, 20); assert.equal(result.usage?.output, 8);
  assert.equal(result.usage?.totalTokens, 74); assert.equal(result.usage?.cost.total, 2);
  assert.equal(result.usage?.cacheWrite1h, 2); assert.equal(result.usage?.reasoning, 4);
  assert.deepEqual(result.details.usage, result.usage);
  assert.equal(result.details.requestAttempts, 2);
  assert.deepEqual(result.content, [{ type: "text", text: "Recovered advice" }]);
  assert.equal(failed.usage.cost.total, 1);
  assert.equal(engineStats().attemptedCalls, 1); assert.equal(engineStats().successfulCalls, 1);
  const log = await readFile(join(f.dir, "advisor", "debug.jsonl"), "utf8");
  assert.ok(log.includes('"event":"retry"')); assert.ok(!log.includes("synthetic-secret-value"));
});

test("advisor retries thrown transport errors and rejected responses", async t => {
  const f = await fixture(t, [new Error("WebSocket error"), () => Promise.reject(new Error("fetch failed")), reply("stop")]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = runAdvisor(f.ctx, f.pi, f.params);
  await setImmediate(); t.mock.timers.tick(2000); await setImmediate();
  assert.equal(f.calls.length, 2);
  assert.ok(f.updates.at(-1).content[0].text.includes("retry 2/2 in 4s"));
  t.mock.timers.tick(4000);
  const result = await pending;
  assert.equal(result.details.requestAttempts, 3);
  assert.deepEqual(result.usage, usage);
  assert.equal(result.details.errorMessage, undefined);
});

test("advisor stops after two retries and retains failed-attempt usage", async t => {
  const f = await fixture(t, Array.from({ length: 3 }, () => reply("error", "WebSocket error")));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = runAdvisor(f.ctx, f.pi, f.params);
  await setImmediate(); t.mock.timers.tick(2000); await setImmediate(); t.mock.timers.tick(4000);
  const result = await pending;
  assert.equal(f.calls.length, 3); assert.equal(result.details.requestAttempts, 3);
  assert.equal(result.usage?.input, 30); assert.equal(result.usage?.cost.total, 3);
  assert.equal(result.details.errorMessage, "WebSocket error");
  assert.equal(engineStats().successfulCalls, 0);
});

test("advisor does not retry auth, quota, model, context or empty responses", async t => {
  const failures = ["401 Unauthorized", "429 insufficient_quota", "Model not found", "Invalid parameter", "maximum context length is 272000 tokens; requested 500000 tokens"];
  const empty = reply("stop"); empty.content = [];
  const f = await fixture(t, [...failures.map(error => reply("error", error)), empty]);
  for (const error of failures) {
    const result = await runAdvisor(f.ctx, f.pi, f.params);
    assert.equal(result.details.requestAttempts, 1, error);
    assert.equal(result.details.errorMessage, error);
    assert.equal(result.usage?.cost.total, 1);
  }
  const noText = await runAdvisor(f.ctx, f.pi, f.params);
  assert.equal(noText.details.errorMessage, "advisor returned no text");
  assert.equal(noText.details.requestAttempts, 1);
  f.auth.resolve = async () => { throw new Error("Missing request auth"); };
  const missingAuth = await runAdvisor(f.ctx, f.pi, f.params);
  assert.match(missingAuth.details.errorMessage!, /Missing request auth/);
  assert.equal(missingAuth.details.requestAttempts, 1, "attempt includes request preparation");
  assert.equal(f.calls.length, failures.length + 1);
});

test("advisor preserves usage if auth fails during a retry", async t => {
  const f = await fixture(t, [reply("error", "WebSocket error")]);
  const initialAuth = f.auth.resolve;
  f.auth.resolve = async () => { if (f.calls.length) throw new Error("Fresh auth rejected"); return initialAuth(); };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = runAdvisor(f.ctx, f.pi, f.params);
  await setImmediate(); t.mock.timers.tick(2000);
  const result = await pending;
  assert.equal(f.calls.length, 1);
  assert.match(result.details.errorMessage!, /Fresh auth rejected/);
  assert.equal(result.usage?.cost.total, 1);
});

test("aborting advisor backoff prevents another request without double-counting usage", async t => {
  const f = await fixture(t, [reply("error", "WebSocket error")]);
  const controller = new AbortController();
  const pending = runAdvisor(f.ctx, f.pi, { ...f.params, signal: controller.signal });
  await setImmediate(); assert.ok(f.updates.at(-1).content[0].text.includes("retry"));
  controller.abort();
  const result = await pending;
  assert.equal(f.calls.length, 1); assert.equal(result.details.stopReason, "aborted");
  assert.equal(result.usage?.cost.total, 1);
});

test("advisor respects aborts before and during requests, including provider aborts", async t => {
  const controller = new AbortController();
  const f = await fixture(t, [reply("aborted"), () => { controller.abort(); return reply("stop"); }]);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  const before = await runAdvisor(f.ctx, f.pi, { ...f.params, signal: alreadyAborted.signal });
  assert.equal(f.calls.length, 0); assert.ok(before.details.errorMessage);
  const providerAbort = await runAdvisor(f.ctx, f.pi, f.params);
  assert.equal(providerAbort.details.stopReason, "aborted");
  const during = await runAdvisor(f.ctx, f.pi, { ...f.params, signal: controller.signal });
  assert.equal(during.details.stopReason, "aborted");
  assert.equal(during.usage?.cost.total, 1);
  assert.equal(f.calls.length, 2);
});

test("advisor honours an AbortError thrown at the registry boundary", async t => {
  const f = await fixture(t, []);
  f.ctx.modelRegistry.streamSimple = () => { throw Object.assign(new Error("WebSocket error"), { name: "AbortError" }); };
  const result = await runAdvisor(f.ctx, f.pi, f.params);
  assert.equal(result.details.stopReason, "aborted");
  assert.equal(result.details.requestAttempts, 1);
  assert.equal(f.calls.length, 0);
});

test("advisor retries a provider AbortError when Pi reports it as a connection failure", async t => {
  // Pi's lazy stream drops the thrown error's name. With no aborted signal or
  // aborted response, retry the reported connection failure as agreed in the plan.
  const f = await fixture(t, [Object.assign(new Error("WebSocket error"), { name: "AbortError" }), reply("stop")]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = runAdvisor(f.ctx, f.pi, f.params);
  await setImmediate();
  assert.equal(f.calls.length, 1);
  assert.ok(f.updates.at(-1).content[0].text.includes("retry"));
  t.mock.timers.tick(2000);
  const result = await pending;
  assert.equal(f.calls.length, 2);
  assert.equal(result.details.requestAttempts, 2);
  assert.equal(result.details.errorMessage, undefined);
  assert.equal(result.usage?.cost.total, 1);
});
