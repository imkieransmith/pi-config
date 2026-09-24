import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { AuthResult } from "@earendil-works/pi-ai";
import { createModelFixture } from "./model-fixture.ts";
import { explainLater, startExplaining, stopExplaining } from "../shared/explain.ts";

test("bash and grep explanations use resolved auth, including no-key providers", async t => {
  const dir = await mkdtemp("/tmp/pi-explain-auth-");
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    stopExplaining();
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before;
    await rm(dir, { recursive: true, force: true });
  });
  const model: any = { id: "test", provider: "explain-test", api: "openai-completions", baseUrl: "https://default.example", contextWindow: 10000 };
  await writeFile(join(dir, "settings.json"), JSON.stringify({ explain: { model: "explain-test/test" } }));
  let auth: AuthResult | undefined;
  const calls: any[] = [], warnings: string[] = [], entries: unknown[] = [];
  const registry = await createModelFixture(model, (selected, _payload, options) => {
    calls.push({ selected, options });
    return {
      role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0,
      content: [{ type: "text", text: "Finds the requested files." }], stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
  }, async () => auth);
  const session: any = { modelRegistry: registry, sessionManager: { getBranch: () => [] }, ui: { notify: (message: string) => warnings.push(message) } };
  const pi: any = { appendEntry: (_: string, data: unknown) => entries.push(data) };
  for (const kind of ["bash", "grep"] as const) for (const keyed of [false, true]) {
    auth = { auth: { ...(keyed ? { apiKey: "synthetic" } : {}), baseUrl: "https://tenant.example", headers: { "x-test": "yes" } }, env: { TEST: "yes" } };
    startExplaining(session, pi);
    const ctx: any = { toolCallId: `${kind}-${keyed}`, state: {}, cwd: dir, argsComplete: true, invalidate() {} };
    explainLater(kind, "synthetic input", ctx);
    for (let i = 0; !ctx.state.plain && !warnings.length && i < 100; i++) await setImmediate();
    assert.equal(ctx.state.plain, "Finds the requested files.");
    assert.equal(calls.at(-1).selected.baseUrl, "https://tenant.example");
    assert.equal(calls.at(-1).options.apiKey, keyed ? "synthetic" : undefined);
    assert.equal(calls.at(-1).options.headers["x-test"], "yes");
    assert.equal(calls.at(-1).options.env.TEST, "yes");
    assert.equal(calls.at(-1).options.maxTokens, 200);
    assert.deepEqual(calls.at(-1).options.samplingParams, { reasoning: { enabled: false } });
    assert.ok(calls.at(-1).options.signal instanceof AbortSignal);
  }
  auth = undefined;
  startExplaining(session, pi);
  const ctx: any = { toolCallId: "rejected", state: {}, cwd: dir, argsComplete: true, invalidate() {} };
  explainLater("bash", "synthetic input", ctx);
  for (let i = 0; !warnings.length && i < 100; i++) await setImmediate();
  assert.match(warnings[0], /not configured/);
  assert.equal(calls.length, 4);
  assert.equal(entries.length, 4);
  assert.equal(ctx.state.plain, undefined);
});
