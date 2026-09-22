import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import contextSnapshots from "./index.ts";

const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("snapshot compaction uses the registered provider and appends durable summaries", async () => {
  const handlers = new Map<string, Function[]>();
  const pi = {
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
    registerTool() {},
  } as unknown as ExtensionAPI;
  contextSnapshots(pi);

  const calls: Array<{ model: any; options: any }> = [];
  const model = {
    id: "test-model",
    provider: "test-provider",
    api: "openai-completions",
    reasoning: true,
    contextWindow: 100_000,
    maxTokens: 8_192,
  } as any;
  const branch = [{
    type: "custom",
    id: "entry-1",
    parentId: null,
    timestamp: 1,
    customType: "context-snapshot-state",
    data: {
      version: 1,
      type: "restore",
      checkpointId: "capture-1",
      summaryId: "summary-1",
      label: "test capture",
      summary: "Durable detail to retain.",
      forced: false,
      wasDirty: false,
      createdAt: 1,
    },
  }];
  const provider = {
    streamSimple(selectedModel: unknown, _context: unknown, options: unknown) {
      calls.push({ model: selectedModel, options });
      return {
        result: async () => ({
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          content: [{ type: "text", text: "Generated base summary." }],
          stopReason: "stop",
          usage,
        }),
      };
    },
  };
  const ctx = {
    model,
    thinkingLevel: "high",
    sessionManager: {
      getSessionId: () => "context-test",
      getBranch: () => branch,
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "synthetic-key",
        baseUrl: "https://example.invalid/v1",
        headers: { keep: "yes", remove: null },
        env: { TEST_ENV: "yes" },
      }),
      getProvider: () => provider,
    },
  } as unknown as ExtensionContext;
  const event = {
    preparation: {
      firstKeptEntryId: "kept-entry",
      messagesToSummarize: [{ role: "user", content: "Work so far", timestamp: 1 }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 100,
      previousSummary: undefined,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 1_000 },
    },
    branchEntries: branch,
    customInstructions: undefined,
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  };

  const handler = handlers.get("session_before_compact")?.[0];
  assert.ok(handler);
  const result = await handler(event, ctx);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model.baseUrl, "https://example.invalid/v1");
  assert.deepEqual(calls[0].options.headers, { keep: "yes" });
  assert.deepEqual(calls[0].options.env, { TEST_ENV: "yes" });
  assert.equal(calls[0].options.reasoning, "high");
  assert.match(result.compaction.summary, /Generated base summary\./);
  assert.match(result.compaction.summary, /Durable detail to retain\./);
  assert.deepEqual(result.compaction.usage, usage);
});
