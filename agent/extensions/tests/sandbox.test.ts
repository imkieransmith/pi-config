import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFixture } from "./git-fixture.ts";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { sandboxedBashOperations } from "../sandbox/operations.ts";

test("sandboxed bash reads git history and .env but cannot change either, or reach home", { skip: !SandboxManager.isSupportedPlatform() }, async t => {
  const repo = await mkdtemp(join(tmpdir(), "pi-sandbox-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const home = await mkdtemp(join(homedir(), ".pi-sandbox-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => SandboxManager.reset());
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  await createGitFixture(repo);
  await writeFile(join(repo, "tracked.txt"), "uncommitted work\n");
  await writeFile(join(repo, ".env"), "APP_KEY=local\n");
  await writeFile(join(home, "private.txt"), "home\n");

  const ops = sandboxedBashOperations(repo);
  const run = async (command: string) => {
    let output = "";
    const { exitCode } = await ops.exec(command, repo, { onData: data => { output += data; }, env: { ...env, FAKE_API_KEY: "sk-test" } });
    return { exitCode, output };
  };

  assert.equal((await run("git log --oneline")).exitCode, 0);
  for (const command of ["git add .", "git stash", "git reset --hard -q", "git checkout -- ."]) {
    assert.notEqual((await run(command)).exitCode, 0, command);
  }
  assert.equal(await readFile(join(repo, "tracked.txt"), "utf8"), "uncommitted work\n");

  assert.match((await run("cat .env")).output, /APP_KEY=local/);
  assert.notEqual((await run("echo X=1 >> .env")).exitCode, 0);
  assert.equal((await run("echo ok > new.txt")).exitCode, 0);
  assert.equal((await run(`touch /tmp/pi-sandbox-probe-${process.pid} && rm /tmp/pi-sandbox-probe-${process.pid}`)).exitCode, 0);

  assert.notEqual((await run(`cat "${join(home, "private.txt")}"`)).exitCode, 0);
  assert.match((await run('echo "key=${FAKE_API_KEY:-unset}"')).output, /key=unset/);
});
