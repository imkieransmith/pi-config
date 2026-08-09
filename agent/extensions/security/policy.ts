import { lstat, readlink, realpath } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type SecurityDecision = {
  action: "allow" | "confirm" | "block";
  reason?: string;
  title?: string;
  detail?: string;
  /** Groups "allow for this session" decisions; only used for confirms. */
  allowKey?: string;
};

export type PathIntent = "read" | "mutate" | "discover";
export type PiPathTier = "public" | "authoring" | "private" | "config" | "outside";

const ALLOW: SecurityDecision = { action: "allow" };

function block(reason: string, detail?: string): SecurityDecision {
  return { action: "block", reason, detail };
}

/** Treat common user-facing path syntax as real filesystem paths. */
export function expandUserPath(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

/** Canonicalize existing paths and the nearest existing parent of new paths. */
async function canonicalizePath(resolved: string, symlinkDepth = 0): Promise<string> {
  if (symlinkDepth > 40) throw new Error(`too many symbolic links while resolving ${resolved}`);

  try {
    return await realpath(resolved);
  } catch {
    let isSymbolicLink = false;
    try {
      isSymbolicLink = (await lstat(resolved)).isSymbolicLink();
    } catch {
      // The target does not exist; canonicalize its nearest existing parent.
    }

    if (isSymbolicLink) {
      const target = await readlink(resolved);
      const targetPath = path.isAbsolute(target) ? target : path.resolve(path.dirname(resolved), target);
      return canonicalizePath(targetPath, symlinkDepth + 1);
    }

    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    const canonicalParent = await canonicalizePath(parent, symlinkDepth);
    return path.join(canonicalParent, path.basename(resolved));
  }
}

export async function resolveSecurityPath(rawPath: string, cwd: string): Promise<string> {
  const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  const expanded = expandUserPath(withoutAt.trim() || ".");
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
  return canonicalizePath(resolved);
}

/** Root-aware containment check; prefix checks are unsafe for sibling paths. */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathSegments(filePath: string): string[] {
  return filePath.split(path.sep).filter(Boolean);
}

function isEnvFile(name: string): boolean {
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
}

/** Names alone often reveal secret intent even before a file exists. */
export function includesSensitiveSegment(absPath: string): string | undefined {
  const segments = pathSegments(absPath);
  const base = path.basename(absPath);

  if (isEnvFile(base)) return "environment file";
  if (base === ".dev.vars" || base.startsWith(".dev.vars.")) return "dev vars file";
  if (/^\.(?:npmrc|netrc|git-credentials)$/i.test(base)) return "credential file";
  if (/\.(?:pem|key)$/i.test(base)) return "private key file";
  if (/^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i.test(base)) return "SSH private key";

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (segment === ".ssh") return "SSH directory";
    if (segment === ".gnupg") return "GnuPG directory";
    if (segment === ".aws") return "AWS credentials";
    if (segment === ".kube") return "Kubernetes credentials";
    if (segment === ".docker") return "Docker credentials";
    if (segment === ".config" && /^(?:gh|gcloud)$/i.test(segments[index + 1] ?? "")) return "CLI credentials";
    if (segment === ".git") return "git directory";
    if (/(?:secret|credentials?|tokens?|api[-_]?keys?)/i.test(segment)) return "secret material";
  }

  return undefined;
}

function includesSensitiveProjectExtension(absPath: string, cwd: string): boolean {
  return isInside(path.join(cwd, ".pi", "extensions"), absPath);
}

const PI_CLIPBOARD_IMAGE_NAME = /^pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp)$/i;

async function isPiClipboardImage(absPath: string): Promise<boolean> {
  if (!PI_CLIPBOARD_IMAGE_NAME.test(path.basename(absPath))) return false;
  const tempRoot = await canonicalizePath(os.tmpdir());
  return isInside(tempRoot, absPath);
}

function isPiPlanningNote(absPath: string, home: string): boolean {
  return absPath === path.join(home, ".pi", "PLAN.md") || absPath === path.join(home, ".pi", "TODO.md");
}

const PI_ROOT_PUBLIC_FILES = new Set([
  ".gitignore",
  "license",
  "license.md",
  "license.txt",
  "package.json",
  "package-lock.json",
  "append_system.md",
  "tsconfig.json",
]);

function isPiRootPublicFile(absPath: string, home: string): boolean {
  const piRoot = path.join(home, ".pi");
  if (path.dirname(absPath) !== piRoot) return false;
  const base = path.basename(absPath);
  if (/^(?:README(?:\.[\w-]+)?|TODO|PLAN)\.md$/i.test(base)) return true;
  return PI_ROOT_PUBLIC_FILES.has(base.toLowerCase());
}

function isPiPublicDirectory(absPath: string, home: string): boolean {
  const dirs = [
    path.join(home, ".pi"),
    path.join(home, ".pi", "agent"),
    path.join(home, ".pi", "agent", "skills"),
    path.join(home, ".pi", "agent", "extensions"),
  ];
  return dirs.some((dir) => absPath === dir);
}

function isBroadPiDiscoveryPath(absPath: string, home: string): boolean {
  return absPath === path.join(home, ".pi") || absPath === path.join(home, ".pi", "agent");
}

export function isPiAuthoringPath(absPath: string, home: string): boolean {
  return (
    isInside(path.join(home, ".pi", "agent", "skills"), absPath) ||
    isInside(path.join(home, ".pi", "agent", "extensions"), absPath)
  );
}

export function isPiPrivateRuntimePath(absPath: string, home: string): boolean {
  return [
    path.join(home, ".pi", "agent", "sessions"),
    path.join(home, ".pi", "agent", "history"),
    path.join(home, ".pi", "agent", "cache"),
    path.join(home, ".pi", "agent", "logs"),
    path.join(home, ".pi", "agent", "state"),
    path.join(home, ".pi", "agent", "tmp"),
    path.join(home, ".pi", "agent", "evidence"),
    path.join(home, ".pi", "agent", "advisor"),
  ].some((dir) => isInside(dir, absPath));
}

export function isPiPrivateConfigPath(absPath: string, home: string): boolean {
  if (!isInside(path.join(home, ".pi"), absPath)) return false;
  if (isPiAuthoringPath(absPath, home) || isPiRootPublicFile(absPath, home)) return false;
  return /^(?:config|settings|models?|providers?|auth|credentials?)(?:\.|$)/i.test(path.basename(absPath));
}

export function isPiGeneratedModelStatePath(absPath: string, home: string): boolean {
  return absPath === path.join(home, ".pi", "agent", "models-store.json");
}

export function isActivePiWorkspacePath(absPath: string, cwd: string, home: string): boolean {
  const piRoot = path.join(home, ".pi");
  return isInside(piRoot, cwd) && isInside(piRoot, absPath);
}

export function isPiSettingsPath(absPath: string, home: string): boolean {
  return absPath === path.join(home, ".pi", "agent", "settings.json");
}

export function isPiModelsPath(absPath: string, home: string): boolean {
  return absPath === path.join(home, ".pi", "agent", "models.json");
}

function isInstalledPiPublicPath(absPath: string): boolean {
  const segments = pathSegments(absPath);
  for (let index = 0; index <= segments.length - 3; index++) {
    if (
      segments[index] !== "node_modules" ||
      segments[index + 1] !== "@earendil-works" ||
      segments[index + 2] !== "pi-coding-agent"
    ) continue;

    const relative = segments.slice(index + 3);
    if (relative.length === 1 && relative[0].toLowerCase() === "readme.md") return true;
    if (relative[0] === "docs" || relative[0] === "examples") return true;
  }
  return false;
}

export function classifyPiPath(absPath: string, home: string): PiPathTier {
  const piRoot = path.join(home, ".pi");
  if (!isInside(piRoot, absPath)) return "outside";
  if (isPiPrivateRuntimePath(absPath, home)) return "private";
  if (isPiGeneratedModelStatePath(absPath, home) || isPiPrivateConfigPath(absPath, home)) return "config";
  if (isPiAuthoringPath(absPath, home)) return "authoring";
  if (isPiRootPublicFile(absPath, home) || isPiPublicDirectory(absPath, home)) return "public";
  return "private";
}

export function shouldBlockBroadPiDiscovery(
  toolName: "grep" | "find",
  absPath: string,
  cwd: string,
  home: string,
): boolean {
  if (!isBroadPiDiscoveryPath(absPath, home)) return false;
  // find reveals only names and still respects the built-in ignore rules. A
  // recursive grep reads file contents, so keep it away from auth/runtime
  // descendants even while ~/.pi is the active workspace.
  return toolName === "grep" || !isActivePiWorkspacePath(absPath, cwd, home);
}

function securitySensitiveMutation(absPath: string): string | undefined {
  const base = path.basename(absPath);
  const lower = absPath.toLowerCase();

  if (base === "package.json") return "package.json";
  if (/^(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|npm-shrinkwrap\.json)$/i.test(base)) return "lockfile";
  if (/^\.(?:npmrc|yarnrc|pnpmrc)$|^\.pnpmfile\.cjs$/i.test(base)) return "package manager config";
  if (/\.(?:sh|bash|zsh|fish|ps1|bat|cmd)$/i.test(base)) return "shell script";
  if (/Dockerfile(?:\..*)?$/i.test(base) || /(?:^|\/)(?:docker-compose|compose)\.[^.]+$/i.test(absPath)) return "Docker config";
  if (/\/\.(?:github|gitlab|circleci|buildkite|gitea|forgejo)\//i.test(lower)) return "CI config";
  if (/\/\.husky\//i.test(lower) || /\/hooks\//i.test(lower)) return "hook file";
  if (/^(?:vite|vitest|webpack|rollup|tsup|esbuild|babel|eslint|prettier|jest|playwright|turbo|nx)\.config\./i.test(base)) return "executable project config";
  if (/^(?:Makefile|Justfile|Taskfile\.ya?ml)$/i.test(base)) return "project task file";
  return undefined;
}

/** Central resolved-path policy, exported so path precedence can be tested directly. */
export async function classifyResolvedPath(
  absPath: string,
  rawPath: string,
  cwd: string,
  home: string,
  intent: PathIntent,
): Promise<SecurityDecision> {
  if (isInside(path.join(home, ".ssh"), absPath)) return block(`${intent} of SSH secrets`, rawPath);
  if (isInside(path.join(home, ".gnupg"), absPath)) return block(`${intent} of GnuPG secrets`, rawPath);

  const sensitive = includesSensitiveSegment(absPath);
  if (sensitive) return block(`${intent} of ${sensitive}`, rawPath);

  if ((intent === "read" || intent === "mutate") && isPiPlanningNote(absPath, home)) return ALLOW;

  if (isPiPrivateRuntimePath(absPath, home)) return block(`${intent} of Pi private runtime state`, rawPath);
  if (isPiGeneratedModelStatePath(absPath, home)) return block(`${intent} of Pi generated model state`, rawPath);
  if (isPiPrivateConfigPath(absPath, home)) {
    if (isActivePiWorkspacePath(absPath, cwd, home) && isPiSettingsPath(absPath, home)) return ALLOW;
    if (isActivePiWorkspacePath(absPath, cwd, home) && isPiModelsPath(absPath, home)) {
      return {
        action: "confirm",
        reason: "accessing Pi model configuration",
        title: "Security check: access Pi model configuration?",
        detail: rawPath,
        allowKey: "security:pi-model-config",
      };
    }
    return block(`${intent} of Pi provider/model configuration`, rawPath);
  }

  if (isActivePiWorkspacePath(absPath, cwd, home)) {
    if (intent !== "mutate") return ALLOW;
    if (isPiAuthoringPath(absPath, home)) return ALLOW;
  }

  const piTier = classifyPiPath(absPath, home);
  if (piTier === "public" && intent !== "mutate") return ALLOW;
  if (piTier === "authoring") {
    if (intent !== "mutate") return ALLOW;
    return {
      action: "confirm",
      reason: "modifying Pi authoring surface",
      title: "Security check: modify Pi authoring surface?",
      detail: rawPath,
      allowKey: "security:authoring-surface",
    };
  }
  if (piTier === "private") return block(`${intent} of Pi private runtime state`, rawPath);
  if (piTier === "config") return block(`${intent} of Pi provider/model configuration`, rawPath);

  if (includesSensitiveProjectExtension(absPath, cwd)) {
    if (intent !== "mutate") return ALLOW;
    return block(`${intent} of Pi project extension`, rawPath);
  }

  if (intent !== "mutate" && isInstalledPiPublicPath(absPath)) return ALLOW;
  if (intent === "read" && await isPiClipboardImage(absPath)) return ALLOW;

  if ((intent === "read" || intent === "discover") && !isInside(cwd, absPath)) {
    const action = intent === "read" ? "read outside project" : "discover outside project";
    return {
      action: "confirm",
      reason: action,
      title: `Security check: ${action}?`,
      detail: rawPath,
      allowKey: `security:${action}`,
    };
  }

  if (intent === "mutate" && !isInside(cwd, absPath)) return block("file mutation outside project", rawPath);
  if (intent === "mutate" && pathSegments(absPath).includes("node_modules")) return block("file mutation inside node_modules", rawPath);

  if (intent === "mutate") {
    const soft = securitySensitiveMutation(absPath);
    if (soft) {
      return {
        action: "confirm",
        reason: `modifying ${soft}`,
        title: `Security check: modify ${soft}?`,
        detail: rawPath,
        allowKey: `security:mutate:${soft}`,
      };
    }
  }

  return ALLOW;
}
