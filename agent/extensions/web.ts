/**
 * Web tools: web_search and web_fetch.
 *
 * Jina provides both (s.jina.ai for search, r.jina.ai for page-to-markdown).
 * To swap provider, change jinaSearch() and jinaRead() only.
 *
 * Search needs JINA_API_KEY, read from the environment or ~/.pi/.env. Fetch
 * works without a key; it sends one only after hitting the keyless rate limit,
 * because keyed reads spend tokens.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { redact_text } from "./redact.ts";
import { countNote, getText, row } from "./tool-pills/renderers.ts";

export const ENV_FILE = join(homedir(), ".pi", ".env");
const TIMEOUT_MS = 60_000;
const MAX_PAGE_BYTES = 20_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type SearchResult = { title: string; url: string; description: string };

export async function jinaKey(envFile = ENV_FILE): Promise<string | undefined> {
  if (process.env.JINA_API_KEY) return process.env.JINA_API_KEY;
  const text = await readFile(envFile, "utf8").catch(() => "");
  const line = text.split("\n").find(l => l.split("=")[0].trim() === "JINA_API_KEY");
  return line?.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") || undefined;
}

async function get(url: string, signal: AbortSignal | undefined, headers: Record<string, string> = {}, method = "GET") {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return fetch(url, {
    method,
    headers: { "User-Agent": "pi-web/1.0", ...headers },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}

async function failure(response: Response, what: string): Promise<Error> {
  const body = (await response.text().catch(() => "")).slice(0, 300).trim();
  const hint = response.status === 401 ? ` Tell the user the Jina key in ${ENV_FILE} is missing or expired.` : "";
  return new Error(`${what} failed: HTTP ${response.status}. ${body}${hint}`);
}

async function jinaSearch(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const key = await jinaKey();
  if (!key) throw new Error(`web_search needs JINA_API_KEY in the environment or ${ENV_FILE}. Tell the user.`);
  const response = await get(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, signal, {
    Accept: "application/json",
    Authorization: `Bearer ${key}`,
    "X-Respond-With": "no-content",
  });
  if (!response.ok) throw await failure(response, "Search");
  const { data } = await response.json() as { data?: Partial<SearchResult>[] };
  return (data ?? []).map(r => ({ title: r.title?.trim() ?? "", url: r.url ?? "", description: r.description?.trim() ?? "" }));
}

async function jinaRead(url: string, signal?: AbortSignal): Promise<string> {
  let response = await get(`https://r.jina.ai/${url}`, signal);
  const key = response.status === 429 ? await jinaKey() : undefined;
  if (key) response = await get(`https://r.jina.ai/${url}`, signal, { Authorization: `Bearer ${key}` });
  if (!response.ok) throw await failure(response, "Fetch");
  return (await response.text()).trim();
}

export function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results. Try a different query.";
  return results
    .map((r, i) => [`${i + 1}. ${r.title}`, `   ${r.url}`, r.description && `   ${r.description}`].filter(Boolean).join("\n"))
    .join("\n\n");
}

/** Returns image content for image URLs, undefined for anything else. */
async function fetchImage(url: string, signal?: AbortSignal): Promise<ImageContent | undefined> {
  // Some servers refuse HEAD; those fall through to the reader.
  const head = await get(url, signal, {}, "HEAD").catch(() => undefined);
  const type = head?.ok ? head.headers.get("content-type")?.split(";")[0].trim().toLowerCase() : undefined;
  if (!type || !IMAGE_TYPES.has(type)) return undefined;
  const response = await get(url, signal);
  if (!response.ok) throw await failure(response, "Image fetch");
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > MAX_IMAGE_BYTES) throw new Error(`Image is ${formatSize(data.length)}; the limit is ${formatSize(MAX_IMAGE_BYTES)}.`);
  return { type: "image", data: data.toString("base64"), mimeType: type };
}

/** Keeps the start of long pages and saves the full text where the read tool can page through it. */
export async function limitPage(page: string, url: string): Promise<{ text: string; fullPath?: string }> {
  const cut = truncateHead(page, { maxBytes: MAX_PAGE_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!cut.truncated) return { text: page };
  const fullPath = join(await mkdtemp("/tmp/pi-web-"), "page.md");
  await writeFile(fullPath, `Source: ${url}\n\n${page}`, "utf8");
  const note = `[Showing ${cut.outputLines} of ${cut.totalLines} lines (${formatSize(cut.outputBytes)} of ${formatSize(cut.totalBytes)}). Full page: ${fullPath}. Use the read tool with offset to see more.]`;
  return { text: `${cut.content}\n\n${note}`, fullPath };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description: "Search the web. Returns numbered results with title, URL and a short description. Use web_fetch to read a result in full before relying on it.",
    promptSnippet: "Search the web for documentation, current facts, versions or anything online.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Search query, as you would type it into a search engine" }),
    }),
    async execute(_id, { query }, signal) {
      const results = await jinaSearch(query, signal);
      return { content: [{ type: "text", text: redact_text(formatResults(results)).redacted }], details: { count: results.length } };
    },
    ...row<{ query: string }>({
      name: "web_search",
      call: (args, theme) => theme.fg("accent", args.query ?? ""),
      note: result => countNote(result.details?.count ?? 0, "result"),
    }),
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web fetch",
    description: `Read a web page as markdown, or view an image URL. Long pages show the first ${formatSize(MAX_PAGE_BYTES)} and save the full text to a file you can read with the read tool.`,
    promptSnippet: "Read a web page (as markdown) or an image from a URL.",
    parameters: Type.Object({
      url: Type.String({ pattern: "^https?://", description: "Full http(s) URL" }),
    }),
    async execute(_id, { url }, signal) {
      const image = await fetchImage(url, signal);
      if (image) return { content: [{ type: "text", text: `Image from ${url}` }, image], details: { fullPath: undefined as string | undefined } };
      const { text, fullPath } = await limitPage(await jinaRead(url, signal), url);
      return { content: [{ type: "text", text: redact_text(text).redacted }], details: { fullPath } };
    },
    ...row<{ url: string }>({
      name: "web_fetch",
      call: (args, theme) => theme.fg("accent", args.url ?? ""),
      note: result => result.content.some(c => c.type === "image") ? "image"
        : `${countNote(getText(result).split("\n").length, "line")}${result.details?.fullPath ? ", truncated" : ""}`,
    }),
  });
}
