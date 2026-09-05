import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runAdvisor } from "../advisor/engine.ts";

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
