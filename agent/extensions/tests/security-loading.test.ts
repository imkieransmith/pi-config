import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import security from "../security/index.ts";
import pills from "../tool-pills/index.ts";

for (const [name, extensions] of [
  ["security alone", [security]],
  ["security before tool pills", [security, pills]],
  ["security after tool pills", [pills, security]],
] as const) {
  test(`${name} owns and protects discovery before and after reload`, async t => {
    // Outside /tmp's intentional trust exemption. Only synthetic data is used.
    const dir = await mkdtemp(join(process.cwd(), "agent/extensions/tests/security-loading-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "ordinary.txt"), "fixture public\n");
    await writeFile(join(dir, ".env"), "fixture private\n");
    await mkdir(join(dir, ".ssh"));
    await writeFile(join(dir, ".ssh", "hidden.txt"), "fixture private\n");
    await symlink(".env", join(dir, "alias.txt"));
    const ctx: any = { cwd: dir, hasUI: false, mode: "rpc", sessionManager: { getSessionId: () => name, getBranch: () => [] } };
    for (let load = 0; load < 2; load++) {
      const tools = new Map<string, any>(), hooks = new Map<string, Function[]>();
      const pi = {
        on: (event: string, hook: Function) => hooks.set(event, [...hooks.get(event) ?? [], hook]),
        registerTool: (tool: any) => { assert.ok(!tools.has(tool.name), `duplicate ${tool.name}`); tools.set(tool.name, tool); },
      } as unknown as ExtensionAPI;
      for (const extension of extensions) extension(pi);
      for (const hook of hooks.get("session_start") ?? []) await hook({}, ctx);
      for (const toolName of ["grep", "find", "ls"]) {
        const input = { path: dir, ...(toolName === "grep" ? { pattern: "fixture" } : toolName === "find" ? { pattern: "**/*" } : {}) };
        for (const hook of hooks.get("tool_call") ?? []) {
          assert.equal(await hook({ toolName, input }, ctx), undefined);
          assert.equal((await hook({ toolName, input: { ...input, path: join(dir, "alias.txt") } }, ctx))?.block, true);
        }
        const updates: unknown[] = [];
        const result = await tools.get(toolName).execute("test", input, undefined, (update: unknown) => updates.push(update), ctx);
        const text = JSON.stringify(result);
        assert.match(text, /ordinary.txt/);
        assert.doesNotMatch(text, /private|\.env|\.ssh|alias.txt/);
        assert.equal(result.details, undefined);
        assert.deepEqual(updates, [], "raw streaming output must not escape filtering");
      }
      for (const hook of hooks.get("session_shutdown") ?? []) await hook({}, ctx);
    }
  });
}
