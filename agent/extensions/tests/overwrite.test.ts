import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import confirmDestructive, { assess_tool_call } from "../confirm-destructive.ts";
import { resolveSecurityPath } from "../security/policy.ts";
import { registerDiffTools } from "../tool-pills/diff-renderer.ts";
import { createGitFixture } from "./git-fixture.ts";

const event = (path: string): ToolCallEvent => ({
  type: "tool_call", toolName: "write", toolCallId: "write-test", input: { path, content: "replacement\n" },
});

test("overwrites assess the canonical target in its own repository", async t => {
  const root = await mkdtemp("/tmp/pi-overwrite-test-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await createGitFixture(repo);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const git = (...args: string[]) => promisify(execFile)("git", ["-C", repo, ...args], { env });
  assert.match((await git("log", "-1", "--format=%s")).stdout, /Synthetic fixture/);
  assert.equal((await git("status", "--porcelain")).stdout, "", "fixture HEAD, index and files agree");
  const peer = join(root, "peer");
  await createGitFixture(peer);
  await symlink(join(repo, "tracked.txt"), join(peer, "other-repo.txt"));
  await writeFile(join(repo, "untracked.txt"), "untracked work\n");
  await writeFile(join(repo, "piece[1].txt"), "literal filename\n");
  await symlink("untracked.txt", join(repo, "TODO.md"));
  await symlink(repo, join(root, "parent-link"));
  const assess = (path: string, cwd = root) => assess_tool_call(event(path), cwd);

  assert.equal(await assess(join(repo, "tracked.txt")), undefined, "clean target outside cwd has its own repo");
  assert.equal(await assess(join(root, "parent-link", "tracked.txt")), undefined);
  assert.equal(await assess("other-repo.txt", peer), undefined);
  for (const name of ["untracked.txt", "tracked-link.txt", "TODO.md", "piece[1].txt"]) {
    assert.equal((await assess(join(repo, name)))?.allow_key, "write:risky-overwrite", name);
  }
  await writeFile(join(repo, "tracked.txt"), "uncommitted work\n");
  for (const name of ["tracked.txt", "dirty-link.txt"]) {
    assert.equal((await assess(join(repo, name)))?.reason, "Overwrites a file with uncommitted changes");
  }
  assert.equal((await assess("parent-link/tracked.txt"))?.allow_key, "write:risky-overwrite");
  assert.equal((await assess("other-repo.txt", peer))?.reason, "Overwrites a file with uncommitted changes");
  assert.equal(await assess(join(root, "parent-link", "new.txt")), undefined);
  await mkdir(join(root, "notes"));
  await writeFile(join(root, "notes", "TODO.md"), "plan");
  await symlink(join(root, "notes", "TODO.md"), join(root, "plan-alias.md"));
  assert.equal(await assess(join(root, "plan-alias.md")), undefined, "real TODO remains exempt");
  const target = await resolveSecurityPath(join(repo, "untracked.txt"), root);
  assert.equal(await assess_tool_call(event(join(repo, "TODO.md")), root, new Set([target])), undefined);
  assert.equal((await assess_tool_call({
    type: "tool_call", toolName: "edit", toolCallId: "edit-test",
    input: { path: join(repo, "TODO.md"), edits: [{ oldText: "x".repeat(300), newText: "" }] },
  }, root))?.allow_key, "edit:large-removal-risky");
});

test("retargeted links and failed Git/path checks do not grant overwrite exemptions", async t => {
  const dir = await mkdtemp("/tmp/pi-overwrite-failures-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await createGitFixture(dir);
  const created = join(dir, "created.txt"), other = join(dir, "other.txt"), link = join(dir, "alias.txt");
  await writeFile(created, "created this session"); await writeFile(other, "unrelated work");
  await symlink(created, link);
  const exemptions = new Set([await resolveSecurityPath(link, dir)]);
  await unlink(link); await symlink(other, link);
  assert.equal((await assess_tool_call(event(link), dir, exemptions))?.allow_key, "write:risky-overwrite");
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = "";
    assert.equal((await assess_tool_call(event(join(dir, "tracked.txt")), dir))?.allow_key, "write:risky-overwrite");
  } finally {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
  }
  await symlink("loop", join(dir, "loop"));
  await assert.rejects(assess_tool_call(event(join(dir, "loop")), dir), /too many symbolic links/);
});

test("denying a linked overwrite preserves the target; explicit approval permits it", async t => {
  const dir = await mkdtemp("/tmp/pi-overwrite-gate-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, "work.txt"), link = join(dir, "TODO.md");
  await writeFile(target, "original\n");
  await symlink("work.txt", link);
  const hooks = new Map<string, Function[]>(), tools = new Map<string, any>();
  const pi = {
    on: (name: string, fn: Function) => hooks.set(name, [...hooks.get(name) ?? [], fn]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
  } as unknown as ExtensionAPI;
  await confirmDestructive(pi);
  registerDiffTools(pi);
  let choice = "Block", prompts = 0;
  const ctx = {
    cwd: dir, hasUI: true, sessionManager: { getSessionId: () => "overwrite-test" },
    ui: { select: async () => { prompts++; return choice; } },
  } as unknown as ExtensionContext;
  const write = async () => {
    for (const hook of hooks.get("tool_call")!) if ((await hook(event(link), ctx))?.block) return false;
    await tools.get("write").execute("write-test", event(link).input, undefined, undefined, ctx);
    return true;
  };
  assert.equal(await write(), false);
  assert.equal(await readFile(target, "utf8"), "original\n");
  choice = "Allow once";
  assert.equal(await write(), true);
  assert.equal(await readFile(target, "utf8"), "replacement\n");
  assert.equal(prompts, 2);
});
