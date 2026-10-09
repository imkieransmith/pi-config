/**
 * The sandbox rules, and bash operations that run commands under them
 * (sandbox-exec on macOS, bubblewrap on Linux) via @anthropic-ai/sandbox-runtime.
 *
 * - Reads: home is hidden except the project and the tool folders below.
 * - Writes: the project, /tmp and package caches only. The project's `.git`
 *   and `.env` stay read-only, so the agent can read history but not commit,
 *   stash, reset or push, and artisan can load `.env` but nothing can change it.
 * - Pi's own secrets and sessions stay hidden even when the project is ~/.pi.
 * - Network: listed domains, the project's Herd `<folder>.test` site, and any
 *   localhost port (needed for databases and dev servers).
 * - Environment variables that look like secrets are dropped.
 *
 * Fails closed: if the sandbox can't start, the command doesn't run.
 */
import path from "node:path";
import { SandboxManager, NetworkConfigSchema, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { type BashOperations, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { checkSandboxPatch } from "./runtime-patch.ts";

const SECRET_ENV = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH/i;

const PI_PRIVATE = [
  "~/.pi/.env", "~/.pi/agent/auth.json", "~/.pi/agent/models.json", "~/.pi/agent/models-store.json",
  "~/.pi/agent/sessions", "~/.pi/agent/advisor",
];

export const SANDBOX_NOTE =
  "Commands run in a sandbox. 'Operation not permitted' or a proxy 403 means the sandbox blocked it; tell the user instead of working around it. " +
  "For browser checks, first check for the shared `playwright` command. Reuse it and its cached Chromium instead of installing per task. " +
  "For CommonJS scripts, run `PLAYWRIGHT_CLI=\"$(command -v playwright)\" node script.cjs` and load Playwright with `require(require('node:path').dirname(require('node:fs').realpathSync(process.env.PLAYWRIGHT_CLI)))`. " +
  "Do not assume npm root -g points to the shared install. If the shared install is missing, tell the user.";

export function sandboxConfig(cwd: string): SandboxRuntimeConfig {
  const browserCache = process.platform === "darwin"
    ? "~/Library/Caches/ms-playwright"
    : path.join(process.env.XDG_CACHE_HOME || "~/.cache", "ms-playwright");
  return {
    network: {
      allowedDomains: [
        "github.com", "*.github.com", "*.githubusercontent.com",
        "packagist.org", "*.packagist.org",
        "registry.npmjs.org", "registry.yarnpkg.com",
        "cdn.playwright.dev", "playwright.download.prss.microsoft.com",
        // Chromium downloads redirect here. Rules allow hosts, not individual storage buckets.
        "storage.googleapis.com",
        `${path.basename(cwd).toLowerCase()}.test`, "127.0.0.1:80", "127.0.0.1:443",
      ],
      deniedDomains: [],
      // macOS has no per-port rule: this opens every localhost port, not only databases and dev servers.
      allowLocalBinding: true,
      // Namespace-wide, not PID-specific. Both operations use the same narrow prefix.
      ...(process.platform === "darwin" ? {
        allowMachRegister: ["org.chromium.Chromium.MachPortRendezvousServer.*"],
        allowMachLookup: ["org.chromium.Chromium.MachPortRendezvousServer.*"],
      } : {}),
    },
    filesystem: {
      denyRead: ["~", "~/.composer/auth.json", ...PI_PRIVATE],
      allowRead: [
        cwd,
        "~/.nvm", "~/.local/bin", "~/.local/lib", "~/.pi/agent/bin",
        "~/Library/Application Support/Herd/bin", "~/Library/Application Support/Herd/config/php",
        "~/Library/Application Support/Herd/config/herd.json",
        "~/.gitconfig", "~/.config/git",
        "~/.composer", "~/Library/Caches/composer", "~/.npm", browserCache,
      ],
      // srt drops a bare "/tmp" on macOS because it resolves to /private/tmp; name the real path.
      allowWrite: [cwd, process.platform === "darwin" ? "/private/tmp" : "/tmp", "~/Library/Caches/composer", "~/.npm", browserCache],
      denyWrite: [path.join(cwd, ".git"), path.join(cwd, ".env"), ...PI_PRIVATE],
    },
  };
}

let ready: Promise<void> | undefined;

export function sandboxedBashOperations(cwd: string): BashOperations {
  const local = createLocalBashOperations();
  return {
    async exec(command, dir, options) {
      // srt outlives /reload and ignores a second initialize, so clear it first
      // or edited rules only apply after a full restart.
      ready ??= Promise.resolve().then(async () => {
        checkSandboxPatch();
        if (!("allowMachRegister" in NetworkConfigSchema.shape)) {
          throw new Error("The loaded sandbox runtime is unpatched. Restart Pi, not just /reload.");
        }
        await SandboxManager.reset();
        await SandboxManager.initialize(sandboxConfig(cwd));
      });
      try {
        await ready;
      } catch (error) {
        ready = undefined;
        throw new Error(`Sandbox unavailable, command not run: ${error instanceof Error ? error.message : error}`);
      }
      const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter(([name]) => !SECRET_ENV.test(name)));
      try {
        return await local.exec(await SandboxManager.wrapWithSandbox(command), dir, { ...options, env });
      } finally {
        SandboxManager.cleanupAfterCommand();
      }
    },
  };
}
