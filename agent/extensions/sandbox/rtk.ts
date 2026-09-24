/**
 * Best-effort RTK output compression without changing the checked command's arguments.
 * Based on https://github.com/sherif-fanous/pi-rtk
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const CACHE_LIMIT = 256;
const cache = new Map<string, string>();

export function clearRtkCache(): void {
  cache.clear();
}

/** Returns `rtk <command>` when RTK supports it, otherwise the command unchanged. */
export async function rtkRewrite(command: string, signal?: AbortSignal): Promise<string> {
  // Shell composition and substitutions require a shell parser. Leave them untouched.
  if (/[\n;&|`$()<>]/.test(command)) return command;
  const cached = cache.get(command);
  if (cached) return cached;
  let result = command;
  try {
    const { stdout } = await run("rtk", ["rewrite", command], { timeout: 1500, maxBuffer: 64_000, signal });
    // RTK may propose argument/subcommand changes. Accept only an exact prefix,
    // so the command that runs is the command that was shown.
    if (stdout.trimEnd() === `rtk ${command}`) result = `rtk ${command}`;
  } catch { /* Unavailable/unsupported RTK leaves Bash usable. */ }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(command, result);
  return result;
}
