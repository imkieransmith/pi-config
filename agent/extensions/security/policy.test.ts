import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyResolvedPath,
  resolveSecurityPath,
  shouldBlockBroadPiDiscovery,
  type PathIntent,
} from "./policy.ts";

const home = path.join(path.parse(process.cwd()).root, "home", "kieran");
const piRoot = path.join(home, ".pi");
const activeCwd = piRoot;

async function decide(target: string, intent: PathIntent, cwd = activeCwd) {
  return classifyResolvedPath(target, target, cwd, home, intent);
}

test("allows normal reads and discovery in the active Pi workspace", async () => {
  const cases: Array<[string, PathIntent]> = [
    [path.join(piRoot, "agent", "settings.json"), "read"],
    [path.join(piRoot, "agent", "settings.json"), "mutate"],
    [path.join(piRoot, "agent", "prompts", "review.md"), "read"],
    [piRoot, "discover"],
    [path.join(piRoot, "agent"), "discover"],
  ];

  for (const [target, intent] of cases) {
    assert.equal((await decide(target, intent)).action, "allow", `${intent} ${target}`);
  }
});

test("allows active-workspace extension and skill mutations", async () => {
  for (const target of [
    path.join(piRoot, "agent", "extensions", "security", "index.ts"),
    path.join(piRoot, "agent", "skills", "new-skill", "SKILL.md"),
  ]) {
    assert.equal((await decide(target, "mutate")).action, "allow", target);
  }
});

test("confirms model configuration once per session", async () => {
  for (const intent of ["read", "mutate"] as const) {
    const decision = await decide(path.join(piRoot, "agent", "models.json"), intent);
    assert.equal(decision.action, "confirm");
    assert.equal(decision.allowKey, "security:pi-model-config");
  }
});

test("keeps secrets, runtime state, and generated model state blocked", async () => {
  const cases = [
    path.join(piRoot, "agent", "auth.json"),
    path.join(piRoot, "agent", "models-store.json"),
    path.join(piRoot, "agent", "sessions", "session.jsonl"),
    path.join(piRoot, "agent", "advisor", "payload.json"),
    path.join(home, ".ssh", "id_ed25519"),
    path.join(piRoot, ".env"),
  ];

  for (const target of cases) {
    assert.equal((await decide(target, "read")).action, "block", target);
  }
});

test("does not relax Pi authoring or config paths from another workspace", async () => {
  const otherCwd = path.join(home, "projects", "app");
  const authoring = await decide(path.join(piRoot, "agent", "extensions", "security", "index.ts"), "mutate", otherCwd);
  assert.equal(authoring.action, "confirm");
  assert.equal(authoring.allowKey, "security:authoring-surface");

  const settings = await decide(path.join(piRoot, "agent", "settings.json"), "read", otherCwd);
  assert.equal(settings.action, "block");
});

test("uses root-aware workspace matching rather than prefix matching", async () => {
  const collisionCwd = `${piRoot}-evil`;
  const settings = await decide(path.join(piRoot, "agent", "settings.json"), "read", collisionCwd);
  assert.equal(settings.action, "block");
  assert.equal(shouldBlockBroadPiDiscovery("find", piRoot, collisionCwd, home), true);
  assert.equal(shouldBlockBroadPiDiscovery("find", piRoot, activeCwd, home), false);
  assert.equal(shouldBlockBroadPiDiscovery("grep", piRoot, activeCwd, home), true);
});

test("allows installed Pi documentation and examples read-only", async () => {
  const packageRoot = path.join(
    home,
    ".nvm",
    "versions",
    "node",
    "v24.1.0",
    "lib",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const cases = [
    path.join(packageRoot, "README.md"),
    path.join(packageRoot, "docs", "prompt-templates.md"),
    path.join(packageRoot, "examples", "extensions", "permission-gate.ts"),
  ];

  for (const target of cases) {
    assert.equal((await decide(target, "read")).action, "allow", target);
    assert.equal((await decide(target, "discover")).action, "allow", target);
    assert.equal((await decide(target, "mutate")).action, "block", target);
  }
});

test("does not trust similarly named installed packages", async () => {
  const collision = path.join(
    home,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent-evil",
    "docs",
    "security.md",
  );
  assert.equal((await decide(collision, "read")).action, "confirm");
});

test("outside-workspace reads confirm and writes block", async () => {
  const outside = path.join(home, "other", "notes.txt");
  assert.equal((await decide(outside, "read")).action, "confirm");
  assert.equal((await decide(outside, "discover")).action, "confirm");
  assert.equal((await decide(outside, "mutate")).action, "block");
});

test("canonical resolution exposes traversal and symlink escapes", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "pi-security-test-"));
  t.after(async () => rm(temp, { recursive: true, force: true }));

  const lexicalWorkspace = path.join(temp, "workspace");
  const lexicalOutside = path.join(temp, "outside");
  await mkdir(lexicalWorkspace);
  await mkdir(lexicalOutside);
  await writeFile(path.join(lexicalOutside, "existing.txt"), "outside");
  await symlink(lexicalOutside, path.join(lexicalWorkspace, "escape"));

  // macOS canonicalizes /var to /private/var. Resolve each existing root once
  // with the platform API so expected values stay independent of policy code.
  const { realpath } = await import("node:fs/promises");
  const workspace = await realpath(lexicalWorkspace);
  const outside = await realpath(lexicalOutside);

  assert.equal(
    await resolveSecurityPath("../outside/existing.txt", workspace),
    path.join(outside, "existing.txt"),
  );
  assert.equal(
    await resolveSecurityPath("escape/existing.txt", workspace),
    path.join(outside, "existing.txt"),
  );
  assert.equal(
    await resolveSecurityPath("escape/new.txt", workspace),
    path.join(outside, "new.txt"),
  );

  const escaped = await classifyResolvedPath(
    path.join(outside, "new.txt"),
    "escape/new.txt",
    workspace,
    path.join(temp, "home"),
    "mutate",
  );
  assert.equal(escaped.action, "block");
  assert.equal(escaped.reason, "file mutation outside project");
});
