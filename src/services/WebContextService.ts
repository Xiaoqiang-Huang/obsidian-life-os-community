export interface WebContextRequestOptions {
  headers?: Record<string, string>;
  method?: "GET";
}

export interface WebContextResponse {
  text: string;
  status?: number;
}

export type WebContextRequest = (url: string, options?: WebContextRequestOptions) => Promise<WebContextResponse>;

export interface WebSearchItem {
  title: string;
  url: string;
  source: string;
  snippet: string;
}

export interface WebSearchOptions {
  maxResults?: number;
  fetchTopPages?: number;
  maxPageChars?: number;
}

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
};
const SEARCH_TIMEOUT_MS = 8_000;
const URL_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PAGE_CHARS = 6_000;
const WEB_SEARCH_INTENT_RE = /(联网|网页|网上|上网|搜索|搜一下|帮我搜|查一下|查网页|百度|必应|谷歌|google|bing|search web|web search|look up|online|internet)/i;
const WEB_SEARCH_CLEAN_RE = /(联网|网页|网上|上网|搜索|搜一下|帮我搜|查一下|查网页|百度|必应|谷歌|google|bing|search web|web search|look up|online|internet)/gi;
const URL_RE = /https?:\/\/[^\s\]\)"'<>]+/g;

export function extractWebUrls(message: string): string[] {
  const urls = message.match(URL_RE) ?? [];
  return Array.from(new Set(urls.map(stripTrailingUrlPunctuation).filter(Boolean)));
}

export function getWebSearchQuery(message: string): string | null {
  const withoutUrls = message.replace(URL_RE, " ").replace(/\s+/g, " ").trim();
  if (!WEB_SEARCH_INTENT_RE.test(withoutUrls)) return null;
  const query = withoutUrls
    .replace(WEB_SEARCH_CLEAN_RE, " ")
    .replace(/^(请|帮我|麻烦|能不能|可以)?\s*(一下|一下子)?/u, " ")
    .replace(/[：:？?。；;，,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return query.length >= 2 ? query.slice(0, 120) : null;
}

export async function fetchReadableUrl(
  url: string,
  request: WebContextRequest,
  maxChars = DEFAULT_MAX_PAGE_CHARS
): Promise<string> {
  const safeUrl = normalizePublicHttpUrl(url);
  try {
    const direct = await fetchReadableUrlDirect(safeUrl, request, maxChars);
    if (!/Status: fetched, but no readable text was found\.$/.test(direct)) return direct;
  } catch (directError) {
    try {
      return await fetchReadableUrlViaReader(safeUrl, request, maxChars, errorMessage(directError));
    } catch (readerError) {
      throw new Error(`Direct URL fetch failed: ${errorMessage(directError)}; reader fallback failed: ${errorMessage(readerError)}`);
    }
  }

  return fetchReadableUrlViaReader(safeUrl, request, maxChars, "direct fetch returned no readable text");
}

export async function searchWebAsMarkdown(
  query: string,
  request: WebContextRequest,
  options: WebSearchOptions = {}
): Promise<string> {
  const cleanQuery = query.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!cleanQuery) return "Web search skipped: empty query.";

  const maxResults = Math.max(1, Math.min(options.maxResults ?? 5, 8));
  const fetchTopPages = Math.max(0, Math.min(options.fetchTopPages ?? 2, 3));
  const maxPageChars = Math.max(800, Math.min(options.maxPageChars ?? DEFAULT_MAX_PAGE_CHARS, 12_000));
  const results = await searchWebResults(cleanQuery, request, maxResults);
  if (results.length === 0) {
    return `Web search query: ${cleanQuery}\nNo readable search results were returned.`;
  }

  const lines = [
    `Web search query: ${cleanQuery}`,
    "",
    "Search results:",
    ...results.map((item, index) => `${index + 1}. ${item.title}\n   ${item.url}\n   ${item.snippet || item.source}`)
  ];

  const pageSnapshots: string[] = [];
  for (const item of results.slice(0, fetchTopPages)) {
    try {
      const pageText = await fetchReadableUrl(item.url, request, maxPageChars);
      if (pageText.trim()) {
        pageSnapshots.push(`### ${item.title}\n${pageText}`);
      }
    } catch (error) {
      pageSnapshots.push(`### ${item.title}\nSource: ${item.url}\nUnable to read this result page: ${errorMessage(error)}`);
    }
  }

  if (pageSnapshots.length > 0) {
    lines.push("", "Result page snapshots:", pageSnapshots.join("\n\n"));
  }

  return lines.join("\n").trim();
}

async function searchWebResults(query: string, request: WebContextRequest, maxResults: number): Promise<WebSearchItem[]> {
  const sources = [
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&setlang=zh-CN`,
    `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=cn-zh`
  ];

  for (const url of sources) {
    try {
      const response = await withTimeout(
        request(url, { method: "GET", headers: DEFAULT_HEADERS }),
        SEARCH_TIMEOUT_MS,
        `Web search timed out: ${summarizeUrl(url)}`
      );
      const items = parseSearchResults(response.text, url).slice(0, maxResults);
      if (items.length > 0) return dedupeSearchItems(items).slice(0, maxResults);
    } catch {
      continue;
    }
  }

  return [];
}

async function fetchReadableUrlDirect(safeUrl: string, request: WebContextRequest, maxChars: number): Promise<string> {
  const response = await withTimeout(
    request(safeUrl, { method: "GET", headers: DEFAULT_HEADERS }),
    URL_TIMEOUT_MS,
    `URL fetch timed out: ${safeUrl}`
  );
  const title = extractTitle(response.text);
  const text = htmlToReadableText(response.text).slice(0, maxChars).trim();
  const source = `Source: ${safeUrl}`;
  if (!text) return `${source}\nStatus: fetched, but no readable text was found.`;
  return [source, title ? `Title: ${title}` : "", text].filter(Boolean).join("\n");
}

async function fetchReadableUrlViaReader(
  safeUrl: string,
  request: WebContextRequest,
  maxChars: number,
  directFailure: string
): Promise<string> {
  const readerUrl = `https://r.jina.ai/${safeUrl}`;
  const response = await withTimeout(
    request(readerUrl, { method: "GET", headers: { ...DEFAULT_HEADERS, "Accept": "text/plain,text/markdown,*/*;q=0.7" } }),
    URL_TIMEOUT_MS + 8_000,
    `URL reader fallback timed out: ${safeUrl}`
  );
  const text = htmlToReadableText(response.text).slice(0, maxChars).trim();
  if (!text) {
    throw new Error("reader fallback returned no readable text");
  }
  return [
    `Source: ${safeUrl}`,
    "Reader fallback: r.jina.ai",
    `Direct fetch note: ${directFailure}`,
    text
  ].join("\n");
}

function parseSearchResults(html: string, sourceUrl: string): WebSearchItem[] {
  if (sourceUrl.includes("duckduckgo.com")) return parseDuckDuckGoResults(html, sourceUrl);
  return parseBingResults(html, sourceUrl);
}

function parseBingResults(html: string, sourceUrl: string): WebSearchItem[] {
  const items: WebSearchItem[] = [];
  const blockRegex = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(html)) !== null) {
    const block = match[1];
    const link = block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = resolveSearchUrl(decodeEntities(link[1]), sourceUrl);
    const title = htmlToReadableText(link[2]);
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? htmlToReadableText(snippetMatch[1]).slice(0, 220) : "";
    if (isUsableSearchResult(url, title)) {
      items.push({ title, url, source: domainLabel(url), snippet });
    }
  }

  return items;
}

function parseDuckDuckGoResults(html: string, sourceUrl: string): WebSearchItem[] {
  const items: WebSearchItem[] = [];
  const blockRegex = /<div[^>]+class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*\bresult\b|<\/body>)/gi;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(html)) !== null) {
    const block = match[1];
    const link = block.match(/<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = resolveSearchUrl(decodeEntities(link[1]), sourceUrl);
    const title = htmlToReadableText(link[2]);
    const snippetMatch = block.match(/<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/<td[^>]+class="[^"]*\bresult-snippet\b[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const snippet = snippetMatch ? htmlToReadableText(snippetMatch[1]).slice(0, 220) : "";
    if (isUsableSearchResult(url, title)) {
      items.push({ title, url, source: domainLabel(url), snippet });
    }
  }

  return items;
}

function isUsableSearchResult(url: string, title: string): boolean {
  if (!title || title.length < 2) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (/bing\.com|duckduckgo\.com/i.test(parsed.hostname) && /\/search|\/html/i.test(parsed.pathname)) return false;
    normalizePublicHttpUrl(parsed.href);
    return true;
  } catch {
    return false;
  }
}

function dedupeSearchItems(items: WebSearchItem[]): WebSearchItem[] {
  const seen = new Set<string>();
  const out: WebSearchItem[] = [];
  for (const item of items) {
    const key = canonicalUrl(item.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function htmlToReadableText(html: string): string {
  return decodeEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h1|h2|h3|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? htmlToReadableText(match[1]).slice(0, 160) : "";
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripTrailingUrlPunctuation(url: string): string {
  return url.replace(/[。．，,、；;：:！？!?）)\]}>"'`]+$/u, "");
}

function resolveSearchUrl(rawUrl: string, sourceUrl: string): string {
  try {
    const url = new URL(rawUrl, sourceUrl);
    const redirect = url.searchParams.get("url") || url.searchParams.get("u") || url.searchParams.get("uddg");
    if (redirect) {
      const decoded = decodeURIComponent(redirect);
      return new URL(decoded).href;
    }
    return url.href;
  } catch {
    return rawUrl;
  }
}

function normalizePublicHttpUrl(rawUrl: string): string {
  const url = new URL(stripTrailingUrlPunctuation(rawUrl));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs can be fetched.");
  }
  const hostname = url.hostname.toLowerCase();
  if (isPrivateOrLocalHostname(hostname)) {
    throw new Error(`Refusing to fetch private or local URL: ${hostname}`);
  }
  url.hash = "";
  return url.href;
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!clean || clean === "localhost" || clean.endsWith(".localhost") || clean.endsWith(".local")) return true;
  if (clean === "::1" || clean.startsWith("fe80:") || clean.startsWith("fc") || clean.startsWith("fd")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(clean)) return isPrivateIpv4(clean);
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/^(utm_|spm|from|source|campaign|channel|FORM)$/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.href.replace(/\/$/, "");
  } catch {
    return url.trim();
  }
}

function domainLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "web";
  }
}

function summarizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.slice(0, 120);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(timeoutMessage)), ms);
    promise.then(resolve, reject).finally(() => globalThis.clearTimeout(timer));
  });
}
