import assert from "node:assert/strict";
import test from "node:test";
import { sandboxConfig, SANDBOX_NOTE } from "../sandbox/operations.ts";

const cwd = "/tmp/layout-project";

test("browser downloads allow exact hosts without broad vendor wildcards", () => {
  const { network } = sandboxConfig(cwd);
  assert.deepEqual(network.allowedDomains, [
    "github.com", "*.github.com", "*.githubusercontent.com",
    "packagist.org", "*.packagist.org",
    "registry.npmjs.org", "registry.yarnpkg.com",
    "cdn.playwright.dev", "playwright.download.prss.microsoft.com", "storage.googleapis.com",
    "layout-project.test", "127.0.0.1:80", "127.0.0.1:443",
  ]);
});

for (const [platform, xdg, cache] of [
  ["darwin", undefined, "~/Library/Caches/ms-playwright"],
  ["darwin", "/tmp/custom-cache", "~/Library/Caches/ms-playwright"],
  ["linux", undefined, "~/.cache/ms-playwright"],
  ["linux", "/tmp/custom-cache", "/tmp/custom-cache/ms-playwright"],
] as const) {
  test(`browser cache permissions: ${platform}, XDG_CACHE_HOME=${xdg}`, () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    const originalXdg = process.env.XDG_CACHE_HOME;
    try {
      Object.defineProperty(process, "platform", { ...descriptor, value: platform });
      if (xdg === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = xdg;
      const { filesystem, network } = sandboxConfig(cwd);
      assert.deepEqual(network.allowMachRegister, platform === "darwin"
        ? ["org.chromium.Chromium.MachPortRendezvousServer.*"] : undefined);
      assert.deepEqual(network.allowMachLookup, platform === "darwin"
        ? ["org.chromium.Chromium.MachPortRendezvousServer.*"] : undefined);
      assert.ok(filesystem.allowRead?.includes(cache));
      assert.ok(filesystem.allowWrite.includes(cache));
      assert.ok(!filesystem.allowRead?.includes("~/Library/Caches"));
      assert.ok(!filesystem.allowWrite.includes("~/.cache"));
      assert.ok(filesystem.denyRead.includes("~"));
      for (const privatePath of ["~/.pi/.env", "~/.pi/agent/auth.json", "~/.pi/agent/sessions"]) {
        assert.ok(filesystem.denyRead.includes(privatePath));
        assert.ok(filesystem.denyWrite.includes(privatePath));
      }
      assert.ok(filesystem.denyWrite.includes(`${cwd}/.git`));
      assert.ok(filesystem.denyWrite.includes(`${cwd}/.env`));
    } finally {
      Object.defineProperty(process, "platform", descriptor);
      if (originalXdg === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = originalXdg;
    }
  });
}

test("bash guidance tells agents to reuse the shared install", () => {
  assert.match(SANDBOX_NOTE, /shared `playwright` command/);
  assert.match(SANDBOX_NOTE, /PLAYWRIGHT_CLI=.*command -v playwright/);
  assert.match(SANDBOX_NOTE, /realpathSync\(process.env.PLAYWRIGHT_CLI\)/);
  assert.match(SANDBOX_NOTE, /If the shared install is missing, tell the user/);
});
