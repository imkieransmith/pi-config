import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { NetworkConfigSchema, SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { sandboxedBashOperations } from "../sandbox/operations.ts";
import { wrapCommandWithSandboxMacOS } from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import { applySandboxPatch, checkSandboxPatch, sandboxPatch, sandboxRuntimeDir } from "../sandbox/runtime-patch.ts";

const hash = (source: string) => createHash("sha256").update(source).digest("hex");

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-sandbox-patch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@anthropic-ai/sandbox-runtime", version: sandboxPatch.version }));
  // Recover pristine fixture files and check against the reviewed release hashes.
  for (const file of sandboxPatch.files) {
    let text = await readFile(join(sandboxRuntimeDir, file.path), "utf8");
    if (hash(text) !== file.sha256) {
      for (const edit of [...file.edits].reverse()) text = text.split(edit.newText).join(edit.oldText);
    }
    assert.equal(hash(text), file.sha256);
    await mkdir(dirname(join(dir, file.path)), { recursive: true });
    await writeFile(join(dir, file.path), text);
  }
  return dir;
}

async function contents(dir: string) {
  return Promise.all(sandboxPatch.files.map(file => readFile(join(dir, file.path), "utf8")));
}

test("runtime patch applies to a pristine release and is repeatable", async t => {
  const dir = await fixture(t);
  assert.throws(() => checkSandboxPatch(dir), /patch is missing/);
  assert.equal(applySandboxPatch(dir), 5);
  checkSandboxPatch(dir);
  const patched = await contents(dir);
  assert.equal(applySandboxPatch(dir), 0);
  assert.deepEqual(await contents(dir), patched);
  assert.match(patched[2], /allowMachRegister: config\?\.network\?\.allowMachRegister/);
});

test("unsupported runtime versions fail before any file changes", async t => {
  const dir = await fixture(t);
  const before = await contents(dir);
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@anthropic-ai/sandbox-runtime", version: "0.0.79" }));
  assert.throws(() => applySandboxPatch(dir), /requires.*0\.0\.77/);
  assert.deepEqual(await contents(dir), before);
});

test("unexpected late-file contents stop the patch before any writes", async t => {
  const dir = await fixture(t);
  const last = sandboxPatch.files.at(-1)!;
  await writeFile(join(dir, last.path), "unexpected source\n");
  const before = await contents(dir);
  assert.throws(() => applySandboxPatch(dir), /refuses unexpected contents/);
  assert.deepEqual(await contents(dir), before);
});

test("an interrupted installation stays blocked until every file is patched", async t => {
  const dir = await fixture(t);
  const first = sandboxPatch.files[0];
  const pristine = await readFile(join(dir, first.path), "utf8");
  applySandboxPatch(dir);
  await writeFile(join(dir, first.path), pristine);
  assert.throws(() => checkSandboxPatch(dir), /patch is missing/);
  assert.equal(applySandboxPatch(dir), 1);
  checkSandboxPatch(dir);
});

test("sandbox startup failure never executes an unwrapped command", async t => {
  const dir = await fixture(t);
  const marker = join(dir, "should-not-exist");
  t.mock.method(SandboxManager, "reset", async () => {});
  t.mock.method(SandboxManager, "initialize", async () => { throw new Error("test startup failure"); });
  const wrap = t.mock.method(SandboxManager, "wrapWithSandbox");
  const ops = sandboxedBashOperations(dir);
  await assert.rejects(ops.exec(`touch '${marker}'`, dir, { onData() {}, env: process.env }), /Sandbox unavailable, command not run: test startup failure/);
  assert.equal(wrap.mock.callCount(), 0);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("runtime check rejects altered patched files", async t => {
  const dir = await fixture(t);
  applySandboxPatch(dir);
  const file = join(dir, sandboxPatch.files[0].path);
  await writeFile(file, `${await readFile(file, "utf8")}\n// changed\n`);
  assert.throws(() => checkSandboxPatch(dir), /refuses unexpected contents/);
});

const baseNetwork = { allowedDomains: [], deniedDomains: [] };
const prefix = "org.chromium.Chromium.MachPortRendezvousServer.";
const profile = (names?: string[]) => wrapCommandWithSandboxMacOS({
  command: "true", needsNetworkRestriction: true, allowLocalBinding: true,
  readConfig: { denyOnly: ["/tmp/private-fixture"], allowWithinDeny: [] },
  writeConfig: { allowOnly: ["/tmp/output-fixture"], denyWithinAllow: ["/tmp/output-fixture/.git"] },
  allowMachRegister: names,
});

test("registration validation allows names and prefixes but rejects blanket/injected rules", () => {
  assert.equal(NetworkConfigSchema.parse(baseNetwork).allowMachRegister, undefined);
  for (const name of [`${prefix}123`, `${prefix}*`]) {
    assert.deepEqual(NetworkConfigSchema.parse({ ...baseNetwork, allowMachRegister: [name] }).allowMachRegister, [name]);
  }
  for (const name of ["", "*", "org.*.Chromium", "org.chromium.**", 'org.chromium.\") (allow default)', "org.chromium.\n*"]) {
    assert.equal(NetworkConfigSchema.safeParse({ ...baseNetwork, allowMachRegister: [name] }).success, false, name);
  }
});

test("profile grants only the requested registration and preserves other restrictions", () => {
  assert.doesNotMatch(profile(), /\(allow mach-register/);
  assert.doesNotMatch(profile([]), /\(allow mach-register/);
  const result = profile([`${prefix}*`]);
  assert.ok(result.includes(`(allow mach-register (global-name-prefix "${prefix}"))`));
  assert.equal((result.match(/\(allow mach-register/g) ?? []).length, 1);
  assert.ok(!result.includes(`(allow mach-lookup (global-name-prefix "${prefix}"))`));
  assert.match(result, /\(deny default/);
  assert.match(result, /private-fixture/);
  assert.match(result, /output-fixture\/\.git/);
  assert.doesNotMatch(result, /\(allow network\*\)/);
  assert.equal(result, profile().replace(
    "\n; POSIX IPC - shared memory",
    `; User-specified Mach service registration (Pi patch)\n(allow mach-register (global-name-prefix "${prefix}"))\n\n; POSIX IPC - shared memory`,
  ));
});

test("exact registration names stay exact and profile strings are escaped", () => {
  assert.ok(profile([`${prefix}123`]).includes(`(allow mach-register (global-name "${prefix}123"))`));
  const quoted = 'test.\"quoted\\name';
  // The public schema rejects this; low-level generation must still escape it.
  assert.ok(profile([quoted]).includes(`(allow mach-register (global-name ${JSON.stringify(quoted)}))`));
});
