import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { engineStats, resetEngineState, runAdvisor } from "../advisor/engine.ts";

const usage = { input: 10, output: 4, cacheRead: 20, cacheWrite: 0, totalTokens: 34, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
test("advisor uses its configured provider and reports usage even on failure without storing payloads", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-advisor-test-"));
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => { if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before; await rm(dir, { recursive: true, force: true }); });
  const model = { id: "test", provider: "local-test", api: "openai-completions", reasoning: true } as any;
  for (const stopReason of ["stop", "error", "aborted"] as const) {
    let invoked = false;
    const ctx = {
      cwd: dir, model,
      sessionManager: { getBranch: () => [], getSessionId: () => "test", getSessionFile: () => undefined },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic", headers: { "x-test": "yes" }, env: { TEST: "yes" } }),
        getProvider: () => ({ streamSimple: (selected: unknown, _payload: unknown, options: any) => {
          invoked = true; assert.equal(selected, model); assert.equal(options.reasoning, "high"); assert.equal(options.env.TEST, "yes");
          return { result: async () => ({ role: "assistant", content: [{ type: "text", text: stopReason === "stop" ? "test response" : "" }], stopReason, usage, errorMessage: stopReason === "error" ? "Synthetic failure" : undefined }) };
        } }),
      },
    } as unknown as ExtensionContext;
    const pi = { getAllTools: () => [], getActiveTools: () => [] } as unknown as ExtensionAPI;
    const result = await runAdvisor(ctx, pi, { model, effort: "high", brief: "Synthetic test brief" });
    assert.ok(invoked); assert.deepEqual(result.usage, usage);
    assert.equal(Boolean(result.details.errorMessage), stopReason !== "stop");
  }
  const files = await readdir(join(dir, "advisor"));
  assert.deepEqual(files, ["debug.jsonl"]);
});

function reply(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
  return {
    role: "assistant", api: "openai-completions", provider: "local-test", model: "test", timestamp: 0,
    content: [{ type: "text", text: stopReason === "stop" ? "Recovered advice" : "Failed partial response" }],
    stopReason, errorMessage,
    usage: { ...usage, cacheWrite: 3, cacheWrite1h: 1, reasoning: 2, totalTokens: 37,
      cost: { input: 0.25, output: 0.5, cacheRead: 0.25, cacheWrite: 0, total: 1 } },
  };
}

type Outcome = AssistantMessage | Error | (() => AssistantMessage | Promise<AssistantMessage>);
async function retryFixture(t: TestContext, outcomes: Outcome[]) {
  const dir = await mkdtemp(join(tmpdir(), "pi-advisor-retry-"));
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before;
    await rm(dir, { recursive: true, force: true });
  });
  resetEngineState();
  const model = { id: "test", provider: "local-test", api: "openai-completions", reasoning: true, contextWindow: 200_000 } as any;
  const calls: any[] = [], updates: any[] = [];
  let authCalls = 0;
  const ctx = {
    cwd: dir, model,
    sessionManager: { getBranch: () => [], getSessionId: () => "test", getSessionFile: () => undefined },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: `synthetic-${++authCalls}`, headers: { "x-attempt": String(authCalls) }, env: { ATTEMPT: String(authCalls) } }),
      getProvider: () => ({ streamSimple: (selected: unknown, payload: unknown, options: unknown) => {
        calls.push({ selected, payload, options });
        const outcome = outcomes.shift();
        if (outcome instanceof Error) throw outcome;
        if (!outcome) throw new Error("Unexpected extra advisor request");
        return { result: async () => typeof outcome === "function" ? outcome() : outcome };
      } }),
    },
  } as unknown as ExtensionContext;
  const pi = { getAllTools: () => [], getActiveTools: () => [] } as unknown as ExtensionAPI;
  const params = { model, effort: "high" as const, brief: "Synthetic retry check", onUpdate: (update: unknown) => { updates.push(update); } };
  return { ctx, pi, params, calls, updates, dir };
}

test("advisor retries returned WebSocket errors with fresh auth and summed reported usage", async t => {
  const failed = reply("error", 'WebSocket error: {"password":"synthetic-secret-value"}');
  const f = await retryFixture(t, [failed, reply("stop")]);
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
  assert.equal(f.calls[1].selected, f.params.model);
  assert.equal(f.calls[1].options.reasoning, "high");
  assert.equal(f.calls[1].options.headers["x-attempt"], "2");
  assert.equal(f.calls[1].options.env.ATTEMPT, "2");
  assert.equal(result.usage?.input, 20); assert.equal(result.usage?.output, 8);
  assert.equal(result.usage?.totalTokens, 74); assert.equal(result.usage?.cost.total, 2);
  assert.equal(result.usage?.cacheWrite1h, 2); assert.equal(result.usage?.reasoning, 4);
  assert.deepEqual(result.details.usage, result.usage);
  assert.equal(result.details.requestAttempts, 2);
  assert.deepEqual(result.content, [{ type: "text", text: "Recovered advice" }]);
  assert.equal(failed.usage.cost.total, 1); // Never mutate provider results.
  assert.equal(engineStats().attemptedCalls, 1); assert.equal(engineStats().successfulCalls, 1);
  const log = await readFile(join(f.dir, "advisor", "debug.jsonl"), "utf8");
  assert.ok(log.includes('"event":"retry"')); assert.ok(!log.includes("synthetic-secret-value"));
});

test("advisor normalizes thrown transport errors and rejected streams for native retries", async t => {
  const f = await retryFixture(t, [new Error("WebSocket error"), () => Promise.reject(new Error("fetch failed")), reply("stop")]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = runAdvisor(f.ctx, f.pi, f.params);
  await setImmediate(); t.mock.timers.tick(2000); await setImmediate();
  assert.equal(f.calls.length, 2);
  assert.ok(f.updates.at(-1).content[0].text.includes("retry 2/2 in 4s"));
  t.mock.timers.tick(4000);
  const result = await pending;
  assert.equal(result.details.requestAttempts, 3);
  assert.deepEqual(result.usage, reply("stop").usage); // Thrown errors have no reported usage.
  assert.equal(result.details.errorMessage, undefined);
});

test("advisor stops after two retries and retains all failed-attempt usage", async t => {
  const f = await retryFixture(t, Array.from({ length: 3 }, () => reply("error", "WebSocket error")));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = runAdvisor(f.ctx, f.pi, f.params);
  await setImmediate(); t.mock.timers.tick(2000); await setImmediate(); t.mock.timers.tick(4000);
  const result = await pending;
  assert.equal(f.calls.length, 3); assert.equal(result.details.requestAttempts, 3);
  assert.equal(result.usage?.input, 30); assert.equal(result.usage?.cost.total, 3);
  assert.equal(result.details.errorMessage, "WebSocket error");
  assert.equal(engineStats().successfulCalls, 0);
});

test("advisor does not retry auth, quota, model, context or other deterministic failures", async t => {
  const failures = [
    "401 Unauthorized", "429 insufficient_quota", "Model not found", "Invalid parameter",
    "maximum context length is 272000 tokens; requested 500000 tokens",
  ];
  const empty = reply("stop"); empty.content = [];
  const f = await retryFixture(t, [...failures.map(error => reply("error", error)), empty]);
  for (const error of failures) {
    const result = await runAdvisor(f.ctx, f.pi, f.params);
    assert.equal(result.details.requestAttempts, 1, error);
    assert.equal(result.details.errorMessage, error);
    assert.equal(result.usage?.cost.total, 1);
  }
  const noText = await runAdvisor(f.ctx, f.pi, f.params);
  assert.equal(noText.details.requestAttempts, 1);
  assert.equal(noText.details.errorMessage, "advisor returned no text");
  assert.equal(f.calls.length, failures.length + 1);
  f.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: "Missing request auth" });
  const missingAuth = await runAdvisor(f.ctx, f.pi, f.params);
  assert.equal(missingAuth.details.requestAttempts, 0);
  assert.equal(f.calls.length, failures.length + 1);
});

test("advisor preserves reported usage if retry setup fails", async t => {
  const f = await retryFixture(t, [reply("error", "WebSocket error")]);
  const initialAuth = f.ctx.modelRegistry.getApiKeyAndHeaders.bind(f.ctx.modelRegistry);
  f.ctx.modelRegistry.getApiKeyAndHeaders = model => f.calls.length ? Promise.resolve({ ok: false, error: "Fresh auth rejected" }) : initialAuth(model);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = runAdvisor(f.ctx, f.pi, f.params);
  await setImmediate(); t.mock.timers.tick(2000);
  const result = await pending;
  assert.equal(f.calls.length, 1);
  assert.equal(result.details.errorMessage, "Fresh auth rejected");
  assert.equal(result.usage?.cost.total, 1);
});

test("aborting advisor backoff prevents another request and counts failed usage only once", async t => {
  const f = await retryFixture(t, [reply("error", "WebSocket error")]);
  const controller = new AbortController();
  const pending = runAdvisor(f.ctx, f.pi, { ...f.params, signal: controller.signal });
  await setImmediate();
  assert.ok(f.updates.at(-1).content[0].text.includes("retry"));
  controller.abort();
  const result = await pending;
  assert.equal(f.calls.length, 1); assert.equal(result.details.stopReason, "aborted");
  assert.equal(result.usage?.cost.total, 1);
  assert.equal(result.details.errorMessage, "advisor call was aborted");
});

test("advisor respects aborts before and during requests, including provider aborts", async t => {
  const controller = new AbortController();
  const f = await retryFixture(t, [reply("aborted", "WebSocket error"), () => { controller.abort(); return reply("stop"); }, Object.assign(new Error("WebSocket error"), { name: "AbortError" })]);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  const before = await runAdvisor(f.ctx, f.pi, { ...f.params, signal: alreadyAborted.signal });
  assert.equal(f.calls.length, 0); assert.ok(before.details.errorMessage);
  const providerAbort = await runAdvisor(f.ctx, f.pi, f.params);
  assert.equal(f.calls.length, 1); assert.equal(providerAbort.details.stopReason, "aborted");
  const during = await runAdvisor(f.ctx, f.pi, { ...f.params, signal: controller.signal });
  assert.equal(f.calls.length, 2); assert.equal(during.details.stopReason, "aborted");
  assert.equal(during.usage?.cost.total, 1);
  const thrownAbort = await runAdvisor(f.ctx, f.pi, f.params);
  assert.equal(f.calls.length, 3); assert.equal(thrownAbort.details.stopReason, "aborted");
});
