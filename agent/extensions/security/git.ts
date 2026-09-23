/**
 * Kieran owns version control. Agents may read git/GitHub state freely; anything
 * that could change a repository, its history or a remote asks first.
 *
 * Text screening, not enforcement: it catches normal agent commands, not a
 * script that runs git itself.
 */
import type { SecurityDecision } from "./policy.ts";

const READ_ONLY = new Set([
  "status", "diff", "log", "show", "blame", "grep", "ls-files", "ls-tree", "ls-remote",
  "rev-parse", "rev-list", "cat-file", "describe", "shortlog", "merge-base", "name-rev",
  "for-each-ref", "show-ref", "show-branch", "range-diff", "whatchanged", "check-ignore",
  "count-objects", "var", "help", "version",
]);

/** Subcommands that change state, used when git appears mid-command (xargs, find -exec). */
const MUTATING = new Set([
  "add", "am", "apply", "bisect", "branch", "checkout", "cherry-pick", "clean", "clone", "commit",
  "config", "fetch", "filter-branch", "gc", "init", "merge", "mv", "notes", "prune", "pull", "push",
  "rebase", "reflog", "remote", "replace", "reset", "restore", "revert", "rm", "stash", "submodule",
  "switch", "tag", "update-index", "update-ref", "worktree",
]);

/** Commands that only pass through to the real command. */
const WRAPPERS = new Set(["env", "command", "time", "nice", "rtk", "xargs"]);

function words(segment: string): string[] {
  return (segment.match(/"(?:\\.|[^"])*"|'[^']*'|\S+/g) ?? []).map(word => word.replace(/^["']|["']$/g, ""));
}

function positionals(args: string[]): string[] {
  return args.filter(arg => !arg.startsWith("-"));
}

function has(args: string[], ...flags: string[]): boolean {
  return args.some(arg => flags.some(flag => arg === flag || arg.startsWith(`${flag}=`)));
}

/** Read-only only when listing: no positional names unless a list filter takes them. */
function isListing(args: string[], listFlags: string[], writeFlags: string[]): boolean {
  if (has(args, ...writeFlags)) return false;
  return positionals(args).length === 0 || has(args, ...listFlags);
}

function isReadOnlyGit(subcommand: string, args: string[]): boolean {
  if (READ_ONLY.has(subcommand)) return true;
  const [first] = positionals(args);
  switch (subcommand) {
    case "branch":
      return isListing(args, ["--list", "-l", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"],
        ["-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "-f", "--force", "-u", "--set-upstream-to", "--unset-upstream", "--edit-description", "-t", "--track"]);
    case "tag":
      return isListing(args, ["--list", "-l", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"],
        ["-d", "--delete", "-a", "--annotate", "-s", "--sign", "-u", "-f", "--force", "-m", "-F"]);
    case "remote":
      return first === undefined || first === "show" || first === "get-url";
    case "stash":
    case "notes":
      return first === "list" || first === "show";
    case "worktree":
      return first === "list";
    case "reflog":
      return first === undefined || first === "show";
    case "submodule":
      return first === undefined || first === "status" || first === "summary";
    case "config":
      if (first === "get" || first === "list") return true;
      if (has(args, "--get", "--get-all", "--get-regexp", "--list", "-l")) return true;
      return positionals(args).length === 1 && !has(args, "--unset", "--unset-all", "--add", "--replace-all", "--edit", "-e", "--rename-section", "--remove-section") && first !== "set" && first !== "unset" && first !== "edit";
    default:
      return false;
  }
}

/** Returns the subcommand to confirm, or undefined when the git call only reads. */
function classifyGitArgs(args: string[]): string | undefined {
  let index = 0;
  while (args[index]?.startsWith("-")) {
    const option = args[index++];
    // -c can install aliases, pagers or hooks, so a read is no longer a read.
    if (option === "-c" || option.startsWith("--exec-path") || option.startsWith("--config-env")) return "with config override";
    if (option === "-C" || option === "--git-dir" || option === "--work-tree" || option === "--namespace") index++;
    if (option === "--version" || option === "--help") return undefined;
  }
  const subcommand = args[index];
  if (subcommand === undefined) return undefined;
  return isReadOnlyGit(subcommand, args.slice(index + 1)) ? undefined : subcommand;
}

const GH_READ_ACTIONS = new Set(["view", "list", "status", "diff", "checks", "watch"]);

function classifyGhArgs(args: string[]): string | undefined {
  const [group, action] = positionals(args);
  if (!group || group === "help" || has(args, "--version", "--help")) return undefined;
  if (group === "search" || group === "browse") return undefined;
  if (group === "api") {
    const method = args.find((arg, i) => args[i - 1] === "-X" || args[i - 1] === "--method")
      ?? args.find(arg => arg.startsWith("--method="))?.slice(9);
    const sendsBody = has(args, "-f", "-F", "--field", "--raw-field", "--input");
    return (method && method.toUpperCase() !== "GET") || sendsBody ? "api" : undefined;
  }
  if (group === "auth" && action === "status") return undefined;
  return action && GH_READ_ACTIONS.has(action) ? undefined : [group, action].filter(Boolean).join(" ");
}

/** Find commands that change git or GitHub state anywhere in a shell command. */
export function gitWrites(command: string): string[] {
  const found = new Set<string>();
  // Splitting inside quotes can only add prompts, never hide a command.
  for (const segment of command.split(/&&|\|\||[;&|\n()`]/)) {
    const tokens = words(segment);
    let start = 0;
    while (start < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]) || WRAPPERS.has(tokens[start]) || (start > 0 && tokens[start].startsWith("-") && WRAPPERS.has(tokens[start - 1])))) start++;
    const [program, ...args] = tokens.slice(start);
    const name = program?.split("/").pop();
    if (name === "git") {
      const sub = classifyGitArgs(args);
      if (sub) found.add(`git ${sub}`);
    } else if (name === "gh") {
      const sub = classifyGhArgs(args);
      if (sub) found.add(`gh ${sub}`);
    } else if ((name === "npm" || name === "pnpm" || name === "yarn") && positionals(args)[0] === "version") {
      found.add(`${name} version`);
    } else {
      // git started by another command, e.g. `find -exec git add {}`.
      tokens.forEach((token, i) => {
        if (i > start && token === "git" && MUTATING.has(tokens[i + 1] ?? "")) found.add(`git ${tokens[i + 1]}`);
      });
    }
  }
  return [...found];
}

export function classifyGit(command: string): SecurityDecision | undefined {
  const writes = gitWrites(command);
  if (writes.length === 0) return undefined;
  const list = writes.join(", ");
  return {
    action: "confirm",
    reason: `git/GitHub changes need Kieran's approval: ${list}`,
    title: `Git check: run ${list}?`,
    detail: command,
    // Per command kind, so approving `git add` never approves `git push`.
    allowKey: `git:${[...writes].sort().join("+")}`,
  };
}
