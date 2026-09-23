import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import web, { jinaKey } from "../web.ts";

type Call = { url: string; method: string; headers: Record<string, string> };

function setup(t: test.TestContext, respond: (call: Call) => Response) {
  const tools = new Map<string, any>();
  web({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
  const calls: Call[] = [];
  const realFetch = globalThis.fetch;
  const realKey = process.env.JINA_API_KEY;
  process.env.JINA_API_KEY = "test-key";
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const call = { url, method: init.method ?? "GET", headers: init.headers as Record<string, string> };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.JINA_API_KEY; else process.env.JINA_API_KEY = realKey;
  });
  const run = (name: string, args: object) => tools.get(name).execute("id", args, undefined, undefined, {});
  return { calls, run };
}

test("the Jina key comes from the environment first, then the .env file", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, ".env");
  await writeFile(file, "OTHER=1\nJINA_API_KEY=\"from-file\"\n");
  const real = process.env.JINA_API_KEY;
  t.after(() => { if (real === undefined) delete process.env.JINA_API_KEY; else process.env.JINA_API_KEY = real; });
  delete process.env.JINA_API_KEY;
  assert.equal(await jinaKey(file), "from-file");
  assert.equal(await jinaKey(join(dir, "missing")), undefined);
  process.env.JINA_API_KEY = "from-env";
  assert.equal(await jinaKey(file), "from-env");
});

test("web_search lists numbered results and sends the key", async t => {
  const { calls, run } = setup(t, () => Response.json({ data: [
    { title: " Queues ", url: "https://laravel.com/docs/queues", description: "Batching jobs." },
    { title: "No description", url: "https://example.com" },
  ] }));
  const result = await run("web_search", { query: "laravel queue batching" });
  assert.equal(result.content[0].text, "1. Queues\n   https://laravel.com/docs/queues\n   Batching jobs.\n\n2. No description\n   https://example.com");
  assert.equal(calls[0].url, "https://s.jina.ai/?q=laravel%20queue%20batching");
  assert.equal(calls[0].headers.Authorization, "Bearer test-key");
});

test("web_search failures name the HTTP status and the key file", async t => {
  const { run } = setup(t, () => new Response("AuthenticationRequiredError", { status: 401 }));
  await assert.rejects(run("web_search", { query: "x" }), /HTTP 401\. AuthenticationRequiredError.*\.pi\/\.env/);
});

test("web_fetch reads pages without the key until rate limited", async t => {
  let readerCalls = 0;
  const { calls, run } = setup(t, ({ url, method }) => {
    if (method === "HEAD") return new Response(null, { headers: { "content-type": "text/html; charset=utf-8" } });
    return ++readerCalls === 1 ? new Response("slow down", { status: 429 }) : new Response("Title: Example\n\nHello\n");
  });
  const result = await run("web_fetch", { url: "https://example.com" });
  assert.equal(result.content[0].text, "Title: Example\n\nHello");
  const reads = calls.filter(c => c.url.startsWith("https://r.jina.ai/"));
  assert.equal(reads[0].headers.Authorization, undefined);
  assert.equal(reads[1].headers.Authorization, "Bearer test-key");
});

test("web_fetch returns images for the model to view", async t => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const { calls, run } = setup(t, () => new Response(png, { headers: { "content-type": "image/png" } }));
  const result = await run("web_fetch", { url: "https://example.com/logo.png" });
  assert.deepEqual(result.content[1], { type: "image", data: png.toString("base64"), mimeType: "image/png" });
  assert.ok(calls.every(c => !c.url.includes("jina")));
});

test("web_fetch keeps the start of long pages and saves the rest", async t => {
  const page = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
  const { run } = setup(t, ({ method }) => method === "HEAD" ? new Response(null, { status: 405 }) : new Response(page));
  const result = await run("web_fetch", { url: "https://example.com/long" });
  const { fullPath } = result.details;
  t.after(() => rm(join(fullPath, ".."), { recursive: true, force: true }));
  assert.ok(result.content[0].text.startsWith("line 0\n"));
  assert.ok(result.content[0].text.length < 21_000);
  assert.match(result.content[0].text, /Full page: \/tmp\/pi-web-.*page\.md\. Use the read tool/);
  assert.ok((await readFile(fullPath, "utf8")).endsWith("line 2999"));
});
