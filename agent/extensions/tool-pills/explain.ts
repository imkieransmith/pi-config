/**
 * Plain-English headlines for bash rows.
 *
 * Once the agent has finished writing a bash command, a small model turns it
 * into one short sentence, and the row swaps its headline when the reply comes
 * back. The open row shows the sentence, the raw command, then the output.
 * Set the model in settings.json as "provider/model-id":
 *
 *   "explain": { "model": "openrouter/deepseek/deepseek-v4-flash-0731" }
 *
 * No model set, or any failure, leaves the raw command in place.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { redact_text } from "../redact.ts";
import type { RenderContext } from "./renderers.ts";

const PROMPT = `Describe what a shell command does, for a web developer who rarely uses the terminal.
You get the working folder, then the command.
- One sentence, under 15 words, starting with a verb.
- Say the goal, not each step. Skip moving into the working folder, and details like "first five" or hiding errors.
- Use short names, not full paths.
- No code, markdown or preamble.

Examples:
cd /Users/john/.pi && git status --short
→ Lists files changed since the last commit.
npm test 2>&1 | grep -E 'pass|fail'
→ Runs the tests and shows the pass and fail counts.
find src -name '*.ts' | xargs wc -l | sort -n | tail -5
→ Finds the longest TypeScript files in src.
grep -rn TODO src; du -sh storage
→ Looks for TODO notes in src, then checks how big storage is.
rm -rf node_modules && npm install
→ Deletes and reinstalls the project's packages.`;
const TIMEOUT_MS = 15_000;
/**
 * Extra request fields. Thinking would only slow a one-sentence answer, so turn
 * it off the way OpenRouter expects. Models that insist on thinking reject this.
 */
const REQUEST = { reasoning: { enabled: false } };

const ENTRY_TYPE = "bash-explanation";
type Explanation = { toolCallId: string; sentence: string };

let session: ExtensionContext | undefined;
let writer: ExtensionAPI | undefined;
let generation = 0;
/** Finished sentences by command, so a repeated command costs nothing during this session. */
const sentences = new Map<string, string>();
const byCall = new Map<string, string>();
let warned = false;

export function startExplaining(ctx: ExtensionContext, pi: ExtensionAPI): void {
  generation++;
  session = ctx;
  writer = pi;
  warned = false;
  sentences.clear();
  byCall.clear();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const data = entry.data as Partial<Explanation> | undefined;
    if (typeof data?.toolCallId === "string" && typeof data.sentence === "string" && data.sentence) {
      byCall.set(data.toolCallId, data.sentence);
    }
  }
}

export function stopExplaining(): void {
  generation++;
  session = undefined;
  writer = undefined;
  sentences.clear();
  byCall.clear();
}

function save(toolCallId: string, sentence: string): void {
  if (byCall.has(toolCallId)) return;
  writer?.appendEntry(ENTRY_TYPE, { toolCallId, sentence } satisfies Explanation);
  byCall.set(toolCallId, sentence);
}

/** Read on every use, so edits apply to the next command. */
function modelKey(): string | undefined {
  try {
    return JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")).explain?.model;
  } catch {
    return undefined;
  }
}

async function ask(ctx: ExtensionContext, key: string, message: string): Promise<string> {
  const slash = key.indexOf("/");
  const model = slash > 0 ? ctx.modelRegistry.find(key.slice(0, slash), key.slice(slash + 1)) as Model<Api> | undefined : undefined;
  if (!model) throw new Error(`model ${key} not found`);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `no API key for ${model.provider}` : auth.error);
  const provider = ctx.modelRegistry.getProvider(model.provider);
  if (!provider) throw new Error(`provider ${model.provider} is unavailable`);
  const reply = await provider.streamSimple(
    model,
    normalizeContext({ systemPrompt: PROMPT, messages: [{ role: "user", content: redact_text(message).redacted, timestamp: Date.now() }], tools: [] }),
    { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: AbortSignal.timeout(TIMEOUT_MS), samplingParams: REQUEST, maxTokens: 200 },
  ).result();
  if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage || reply.stopReason);
  return reply.content.flatMap(c => c.type === "text" ? [c.text] : []).join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Call from the bash row's renderCall. Saved rows load by tool-call ID;
 * only live rows ask the model. Reopening a session sends nothing.
 */
export function explainLater(command: string | undefined, ctx: RenderContext): void {
  if (!command) return;
  const stored = byCall.get(ctx.toolCallId);
  if (stored) {
    ctx.state.plain = stored;
    return;
  }
  if (ctx.state.asked || !(ctx.argsComplete || ctx.executionStarted)) return;
  // The folder lets the model skip a `cd` into it. It's part of the cache key, since it changes the answer.
  const message = `Working folder: ${ctx.cwd}\nCommand: ${command}`;
  const known = sentences.get(message);
  if (known) {
    save(ctx.toolCallId, known);
    ctx.state.plain = known;
    return;
  }
  const key = modelKey();
  if (!session || !key) return;
  ctx.state.asked = true;
  const current = session;
  const started = generation;
  ask(current, key, message).then(sentence => {
    if (!sentence || started !== generation) return;
    save(ctx.toolCallId, sentence);
    sentences.set(message, sentence);
    ctx.state.plain = sentence;
    ctx.invalidate();
  }, error => {
    if (started !== generation || warned) return;
    warned = true;
    current.ui.notify(`Couldn't explain bash commands: ${error instanceof Error ? error.message : error}`, "warning");
  });
}
