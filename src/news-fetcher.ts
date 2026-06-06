import { requestUrl } from "obsidian";

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  published: string;
  summary: string;
}

export interface TopicNewsResult {
  topic: string;
  items: NewsItem[];
  source: string;
  fromWeb: boolean;
}

export interface FetchTopicNewsOptions {
  recentUrls?: Set<string>;
  recentTitles?: Set<string>;
  todayKey?: string;
  seedItems?: NewsItem[];
}

const BING_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
let bingUnavailableUntil = 0;
let lastBingSkipLogAt = 0;

// ── HTTP fetch ──

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      console.log(`[news-fetcher] timeout after ${ms}ms: ${label}`);
      if (label.startsWith("Bing ")) {
        markBingUnavailable(`timeout after ${ms}ms: ${label}`);
      }
      resolve(null);
    }, ms);

    promise
      .then((value) => resolve(value))
      .catch((error) => {
        const message = errorMessage(error);
        if (label.startsWith("Bing ") && isBingHardFailure(message)) {
          markBingUnavailable(message);
        }
        console.log(`[news-fetcher] request failed: ${label}: ${message}`);
        resolve(null);
      })
      .finally(() => window.clearTimeout(timer));
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summarizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.slice(0, 120);
  }
}

function isBingUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith("bing.com");
  } catch {
    return false;
  }
}

function isBingHardFailure(message: string): boolean {
  return /ERR_TOO_MANY_REDIRECTS|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_TIMED_OUT|redirect/i.test(message);
}

function markBingUnavailable(message: string): void {
  bingUnavailableUntil = Date.now() + BING_FAILURE_COOLDOWN_MS;
  console.log(`[news-fetcher] Bing disabled for 5 minutes: ${message}`);
}

function shouldSkipBing(): boolean {
  if (Date.now() >= bingUnavailableUntil) return false;

  const now = Date.now();
  if (now - lastBingSkipLogAt > 60000) {
    lastBingSkipLogAt = now;
    console.log("[news-fetcher] Skipping Bing search while it is temporarily unavailable");
  }
  return true;
}

async function httpGet(url: string, acceptType = "text/html"): Promise<string | null> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": acceptType,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
  };

  // Obsidian requestUrl bypasses browser CORS. If it fails, browser fetch is
  // usually noisier rather than more successful for public RSS/search pages.
  try {
    const response = await requestUrl({ url, method: "GET", headers });
    console.log(`[news-fetcher] requestUrl OK: ${response.text.length} bytes from ${summarizeUrl(url)}`);
    return response.text;
  } catch (err) {
    const message = errorMessage(err);
    if (isBingUrl(url) && isBingHardFailure(message)) {
      markBingUnavailable(message);
    }
    console.log(`[news-fetcher] requestUrl error for ${summarizeUrl(url)}: ${message}`);
    return null;
  }
}

// ── URL resolution ──
// Bing search redirect URLs need to be resolved to the actual article URL.

function resolveActualUrl(rawUrl: string, feedPageUrl?: string): string {
  try {
    const u = new URL(rawUrl);

    // Bing News redirect: apiclick.aspx?url=REAL_URL
    if (u.hostname.includes("bing.com") && u.pathname.includes("news")) {
      const candidate = u.searchParams.get("url")
        || u.searchParams.get("r")
        || u.searchParams.get("u");
      if (candidate) {
        const decoded = decodeURIComponent(candidate);
        // Make sure the decoded URL is valid and not another Bing redirect
        const resolved = new URL(decoded);
        if (!resolved.hostname.includes("bing.com")) {
          return resolved.href;
        }
      }
    }

    // Bing Web Search redirect: bing.com/ck/a?...&u=REAL_URL
    if (u.hostname.includes("bing.com") && u.pathname.includes("/ck/")) {
      const candidate = u.searchParams.get("u");
      if (candidate) {
        const decoded = decodeURIComponent(candidate);
        const resolved = new URL(decoded);
        if (!resolved.hostname.includes("bing.com")) {
          return resolved.href;
        }
      }
    }

    // Skip any remaining Bing landing pages
    if (u.hostname.includes("bing.com") && (u.pathname.includes("/search") || u.pathname.includes("/news"))) {
      return "";
    }

    // Resolve relative URLs against the feed page
    if (rawUrl.startsWith("/") && feedPageUrl) {
      const base = new URL(feedPageUrl).origin;
      return base + rawUrl;
    }

    // Decode HTML entities in URL
    if (rawUrl.includes("&amp;")) {
      return rawUrl.replace(/&amp;/g, "&");
    }
  } catch {
    // Invalid URL — return as-is, it'll be filtered out by scoring
  }
  return rawUrl;
}

function extractDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    // Short common domains → keep short
    const short: Record<string, string> = {
      "people.com.cn": "人民网",
      "xinhuanet.com": "新华网",
      "news.cn": "新华网",
      "cctv.com": "央视网",
      "chinanews.com.cn": "中国新闻网",
      "gov.cn": "政府网",
      "thepaper.cn": "澎湃新闻",
      "caixin.com": "财新网",
      "cls.cn": "财联社",
      "sohu.com": "搜狐",
      "qq.com": "腾讯",
      "163.com": "网易",
      "sina.com.cn": "新浪",
      "zhihu.com": "知乎",
      "36kr.com": "36氪",
      "huxiu.com": "虎嗅",
      "baidu.com": "百度",
      "guancha.cn": "观察者网",
    };
    for (const [domain, label] of Object.entries(short)) {
      if (hostname.endsWith(domain)) return label;
    }
    // Try to extract readable name (e.g. "bjnews" from "bjnews.com.cn")
    const parts = hostname.split(".");
    return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  } catch {
    return "未知来源";
  }
}

function getUrlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

// ── RSS XML parsing (no external deps) ──

function parseRssItems(xml: string, sourceName: string, limit = 5, feedUrl?: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemBlocks = xml.split(/<item[^>]*>/i).slice(1);

  for (const block of itemBlocks) {
    if (items.length >= limit) break;
    const endIdx = block.indexOf("</item>");
    const content = endIdx >= 0 ? block.slice(0, endIdx) : block;

    const title = extractTag(content, "title");
    let link = extractTag(content, "link");
    const pubDate = extractTag(content, "pubDate") || extractTag(content, "date");
    const description = stripHtml(extractTag(content, "description")).slice(0, 150);

    if (title && link) {
      // Resolve the link: clean Bing redirects, resolve relative URLs
      link = resolveActualUrl(link, feedUrl);
      if (!link) continue;

      items.push({
        title: decodeEntities(title),
        url: link,
        source: sourceName,
        published: pubDate,
        summary: decodeEntities(description)
      });
    }
  }
  return items;
}

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : "";
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ").trim();
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

// ── Time description ──

function timeDescription(pubDate: string): string {
  if (!pubDate) return "";
  try {
    const pub = new Date(pubDate);
    const now = new Date();
    const hours = (now.getTime() - pub.getTime()) / 3600000;
    if (hours < 0) return "";
    if (hours < 1) return "刚刚";
    if (hours < 24) return `${Math.floor(hours)}小时前`;
    if (hours < 48) return "昨天";
    if (hours < 72) return "前天";
    return `${Math.floor(hours / 24)}天前`;
  } catch {
    return "";
  }
}

// ── Bing News RSS ──

async function fetchBingNewsRss(topic: string, maxItems = 5): Promise<NewsItem[]> {
  if (shouldSkipBing()) return [];

  const query = encodeURIComponent(topic);
  const feedUrl = `https://www.bing.com/news/search?q=${query}&format=rss&mkt=zh-CN&setlang=zh-CN&sortby=Date`;

  const xml = await withTimeout(
    httpGet(feedUrl, "application/rss+xml,application/xml,text/xml;q=0.9"),
    5000,
    `Bing RSS: ${topic}`
  );
  if (!xml) return [];

  // Validate it looks like RSS
  if (!xml.includes("<rss") && !xml.includes("<rdf") && !xml.includes("<feed")) {
    console.log(`[news-fetcher] Response doesn't look like RSS (${xml.length} bytes), first 200 chars:`, xml.slice(0, 200));
    return [];
  }

  let items = parseRssItems(xml, "Bing新闻", maxItems, feedUrl);

  // Second-pass: clean any remaining Bing redirect URLs and set proper source
  items = items.filter(item => {
    const resolved = resolveActualUrl(item.url);
    if (resolved && !resolved.includes("bing.com")) {
      item.url = resolved;
      return true;
    }
    return false;
  });
  for (const item of items) {
    item.source = extractDomain(item.url);
  }

  console.log(`[news-fetcher] Bing RSS parsed ${items.length} items for "${topic}"`);
  return items;
}

// ── Bing Web Search (HTML fallback) ──

async function fetchBingWebSearch(topic: string, maxItems = 5, page = 0): Promise<NewsItem[]> {
  if (shouldSkipBing()) return [];

  const query = encodeURIComponent(`${topic} 最新`);
  const first = Math.max(1, page * 10 + 1);
  const url = `https://www.bing.com/search?q=${query}&mkt=zh-CN&setlang=zh-CN&filters=ex1:%22ez1%22&first=${first}&FORM=QBRE`;

  const html = await withTimeout(
    httpGet(url),
    5000,
    `Bing HTML: ${topic}`
  );
  if (!html) return [];

  const items: NewsItem[] = [];
  // Bing search result blocks
  const blockRegex = /<li[^>]*class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  let match;

  while ((match = blockRegex.exec(html)) !== null && items.length < maxItems) {
    const block = match[1];
    const linkMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    let itemUrl = linkMatch[1];
    const title = stripHtml(linkMatch[2]);
    if (!title || title.length < 6 || itemUrl.includes("bing.com/search")) continue;

    // Resolve Bing redirect URL to actual article URL
    const resolved = resolveActualUrl(itemUrl);
    if (!resolved) continue;
    itemUrl = resolved;

    const summaryMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const summary = summaryMatch ? stripHtml(summaryMatch[1]).slice(0, 150) : "";

    items.push({ title, url: itemUrl, source: extractDomain(itemUrl), published: "", summary });
  }

  console.log(`[news-fetcher] Bing HTML parsed ${items.length} items for "${topic}"`);
  return items;
}

// ── AI Hot API ──

export async function fetchAiHotItems(maxItems = 8): Promise<NewsItem[]> {
  const url = "https://aihot.virxact.com/api/public/items?mode=selected";
  const json = await withTimeout(
    httpGet(url, "application/json"),
    5000,
    "AI Hot API"
  );
  if (!json) return [];

  try {
    const data = JSON.parse(json);
    const rawItems = (data.items ?? data.data ?? []) as Record<string, unknown>[];

    const items: NewsItem[] = [];
    for (const item of rawItems) {
      const title = String(item.title ?? item.name ?? "");
      const link = String(item.url ?? item.link ?? item.source_url ?? "");
      const source = String(item.source ?? item.site ?? "AI热点");
      const published = String(item.published_at ?? item.date ?? item.created_at ?? "");
      if (title && link) {
        items.push({ title, url: link, source, published, summary: "" });
      }
      if (items.length >= maxItems) break;
    }
    console.log(`[news-fetcher] AI Hot API: ${items.length} items`);
    return items;
  } catch (err) {
    console.log("[news-fetcher] AI Hot JSON parse error:", err);
    return [];
  }
}

// ── Official Chinese media ──

const OFFICIAL_SOURCES = [
  { name: "人民网", url: "https://www.people.com.cn/rss/politics.xml" },
  { name: "新华网", url: "https://www.xinhuanet.com/rss/politics.xml" },
  { name: "新华网", url: "https://www.news.cn/rss/politics.xml" },
  { name: "中国政府网", url: "https://www.gov.cn/rss/government.xml" },
];

async function fetchOfficialNews(maxItems = 6): Promise<NewsItem[]> {
  const fetchSource = async (source: { name: string; url: string }): Promise<NewsItem[]> => {
    const xml = await withTimeout(
      httpGet(source.url, "application/rss+xml,application/xml"),
      4000,
      source.name
    );
    if (!xml || (!xml.includes("<rss") && !xml.includes("<rdf"))) {
      return [];
    }

    const items = parseRssItems(xml, source.name, 4, source.url);
    for (const item of items) {
      const resolved = resolveActualUrl(item.url, source.url);
      if (resolved) item.url = resolved;
      item.source = source.name;
    }
    return items;
  };

  const results = await Promise.allSettled(OFFICIAL_SOURCES.map(fetchSource));
  const allItems = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );
  return allItems.slice(0, maxItems);
}

function buildTopicQueries(topic: string): string[] {
  const cleanTopic = topic.replace(/^custom:/, "").trim();
  const queries: string[] = [];
  const add = (query: string) => {
    const normalized = query.replace(/\s+/g, " ").trim();
    if (normalized && !queries.includes(normalized)) {
      queries.push(normalized);
    }
  };

  add(cleanTopic);
  add(`${cleanTopic} 今日 热点`);
  add(`${cleanTopic} 最新 热门`);

  if (cleanTopic.includes("时政") || cleanTopic.includes("政策") || cleanTopic.includes("官方")) {
    add("国务院 最新政策 热点");
    add("新华社 时政 最新");
    add("民生 政策 今日 热点");
    add("基层治理 最新 案例");
  }

  if (cleanTopic.includes("考公") || cleanTopic.includes("申论") || cleanTopic.includes("面试")) {
    add("申论 素材 最新 热点");
    add("公务员 面试 热点");
    add("社会治理 案例 最新");
    add("公共服务 政策 最新");
  }

  if (cleanTopic.includes("AI") || cleanTopic.includes("大模型") || cleanTopic.includes("工具")) {
    add("AI 今日 热点");
    add("AI 工具 最新 热门");
    add("大模型 发布 最新");
    add("OpenAI Anthropic Google AI 最新");
  }

  return queries.slice(0, 6);
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 48);
}

function textSimilarity(a: string, b: string): number {
  const left = new Set(Array.from(normalizeTitle(a)));
  const right = new Set(Array.from(normalizeTitle(b)));
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const ch of left) {
    if (right.has(ch)) overlap += 1;
  }
  return overlap / Math.max(left.size, right.size);
}

function seededOffset(seed: string, modulo: number): number {
  if (modulo <= 1) return 0;
  let hash = 2166136261;
  for (const ch of seed) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % modulo;
}

function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const key of Array.from(u.searchParams.keys())) {
      if (/^(utm_|spm|from|source|campaign|channel)/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    return u.href.replace(/\/$/, "");
  } catch {
    return url.trim();
  }
}

function domainKey(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function publishedTime(pubDate: string): number | null {
  if (!pubDate) return null;
  const time = new Date(pubDate).getTime();
  return Number.isFinite(time) ? time : null;
}

function ageHours(pubDate: string): number | null {
  const time = publishedTime(pubDate);
  if (time === null) return null;
  const hours = (Date.now() - time) / 3600000;
  return hours >= 0 ? hours : null;
}

function sortByFreshness(items: NewsItem[]): NewsItem[] {
  return [...items].sort((a, b) => {
    const left = publishedTime(a.published) ?? 0;
    const right = publishedTime(b.published) ?? 0;
    return right - left;
  });
}

function isSameNewsItem(a: NewsItem, b: NewsItem): boolean {
  return canonicalUrl(a.url) === canonicalUrl(b.url) ||
    normalizeTitle(a.title) === normalizeTitle(b.title) ||
    textSimilarity(a.title, b.title) > 0.82;
}

function mergeNewsItems(baseItems: NewsItem[], incomingItems: NewsItem[]): void {
  for (const item of incomingItems) {
    if (!baseItems.some(existing => isSameNewsItem(existing, item))) {
      baseItems.push(item);
    }
  }
}

// ── Main topic news fetcher ──

export async function fetchTopicNews(
  topic: string,
  maxItems = 5,
  options: FetchTopicNewsOptions = {}
): Promise<TopicNewsResult> {
  const cleanTopic = topic.replace(/^custom:/, "").trim();
  console.log(`[news-fetcher] Fetching news for: "${cleanTopic}"`);

  // Collect from all sources
  const allItems: NewsItem[] = [];
  const queries = buildTopicQueries(cleanTopic);
  const seedItems = options.seedItems ?? [];
  mergeNewsItems(allItems, seedItems);

  // Strategy 1/2: Bing RSS + HTML over multiple narrower queries.
  const officialPromise = fetchOfficialNews(4);
  let bingRssCount = 0;
  let bingWebCount = 0;
  for (const [queryIndex, query] of queries.entries()) {
    if (shouldSkipBing()) break;

    const bingRssItems = await fetchBingNewsRss(query, 3);
    bingRssCount += bingRssItems.length;
    mergeNewsItems(allItems, bingRssItems);

    if (shouldSkipBing()) break;
    const webItems = await fetchBingWebSearch(query, 4, queryIndex);
    bingWebCount += webItems.length;
    mergeNewsItems(allItems, webItems);
  }

  // Strategy 3: Official RSS sources (always try, dedup by URL)
  const officialItems = await officialPromise;
  mergeNewsItems(allItems, officialItems);
  const freshnessSorted = sortByFreshness(allItems);

  // Score and select best items
  const scored = freshnessSorted.map((item, freshnessIndex) => ({
    item,
    score: scoreNewsItem(item, cleanTopic, options.recentUrls, options.recentTitles) +
      Math.max(0, 12 - freshnessIndex)
  }));
  scored.sort((a, b) => b.score - a.score);

  const selected: NewsItem[] = [];
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const domainCounts = new Map<string, number>();
  const seed = `${cleanTopic}|${options.todayKey ?? new Date().toISOString().slice(0, 10)}`;
  const topPoolSize = Math.min(scored.length, Math.max(maxItems * 3, 8));
  const topPool = scored.slice(0, topPoolSize);
  const rotated = rotateScored(topPool, seededOffset(seed, Math.max(1, Math.min(4, topPool.length))));
  const overflow = scored.slice(topPoolSize);
  const candidates = rotated.concat(overflow);
  selectNewsItems(candidates, selected, {
    maxItems,
    seenUrls,
    seenTitles,
    domainCounts,
    recentUrls: options.recentUrls,
    recentTitles: options.recentTitles,
    avoidRecentUrls: true,
    avoidRecentTitles: true
  });

  if (selected.length < maxItems) {
    selectNewsItems(candidates, selected, {
      maxItems,
      seenUrls,
      seenTitles,
      domainCounts,
      recentUrls: options.recentUrls,
      recentTitles: options.recentTitles,
      avoidRecentUrls: false,
      avoidRecentTitles: false
    });
  }

  console.log(`[news-fetcher] Final result: ${selected.length} items for "${cleanTopic}"` +
    ` (queries=${queries.length}, seed=${seedItems.length}, bingRss=${bingRssCount}, bingWeb=${bingWebCount}, official=${officialItems.length})`);

  return {
    topic: cleanTopic,
    items: selected,
    source: selected.length > 0 ? "网络资讯" : "AI生成",
    fromWeb: selected.length > 0
  };
}

function indexForQuery(queries: string[], query: string): number {
  return Math.max(0, queries.indexOf(query));
}

function rotateScored<T>(items: T[], offset: number): T[] {
  if (offset <= 0 || items.length <= 1) return items;
  const head = items.slice(0, offset);
  const tail = items.slice(offset);
  return tail.concat(head);
}

interface SelectNewsState {
  maxItems: number;
  seenUrls: Set<string>;
  seenTitles: Set<string>;
  domainCounts: Map<string, number>;
  recentUrls?: Set<string>;
  recentTitles?: Set<string>;
  avoidRecentUrls: boolean;
  avoidRecentTitles: boolean;
}

function selectNewsItems(
  candidates: Array<{ item: NewsItem; score: number }>,
  selected: NewsItem[],
  state: SelectNewsState
): void {
  for (const { item } of candidates) {
    if (selected.some(existing => isSameNewsItem(existing, item))) continue;

    const urlKey = canonicalUrl(item.url);
    const titleKey = normalizeTitle(item.title);
    const domain = domainKey(item.url);
    const domainCount = state.domainCounts.get(domain) ?? 0;
    if (state.seenUrls.has(urlKey) || state.seenTitles.has(titleKey)) continue;
    if (state.avoidRecentUrls && (state.recentUrls?.has(item.url) || state.recentUrls?.has(urlKey))) continue;
    if (state.avoidRecentTitles && isRecentlySeenTitle(item.title, state.recentTitles)) continue;
    if (domain && domainCount >= 2) continue;

    state.seenUrls.add(urlKey);
    if (titleKey) state.seenTitles.add(titleKey);
    if (domain) state.domainCounts.set(domain, domainCount + 1);
    selected.push(item);
    if (selected.length >= state.maxItems) break;
  }
}

function isRecentlySeenTitle(title: string, recentTitles?: Set<string>): boolean {
  if (!recentTitles || recentTitles.size === 0) return false;
  const normalized = normalizeTitle(title);
  if (recentTitles.has(normalized)) return true;
  for (const recent of recentTitles) {
    if (textSimilarity(normalized, recent) > 0.72) return true;
  }
  return false;
}

// ── Format items to markdown ──

export function formatNewsItemsToMarkdown(topic: string, result: TopicNewsResult): string {
  const now = new Date();
  const timeStr = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  let md = `> ⏰ 更新时间：${timeStr}\n> 🔎 来源：${result.source}`;

  if (result.items.length === 0) {
    md += `\n\n暂未找到「${topic}」的最新网络资讯，以下为 AI 生成内容。`;
    return md;
  }

  md += "\n";

  for (let i = 0; i < result.items.length; i++) {
    const item = result.items[i];
    const timeDesc = timeDescription(item.published);
    const timeInfo = timeDesc ? `｜${timeDesc}` : "";
    md += `\n${i + 1}. [${item.title}](${item.url})`;
    md += `\n   来源：[${item.source}](${getUrlOrigin(item.url)})${timeInfo}`;
    if (item.summary) {
      md += `\n   > ${item.summary}`;
    }
  }

  return md;
}

// ── Helpers ──

function scoreNewsItem(
  item: NewsItem,
  topic: string,
  recentUrls?: Set<string>,
  recentTitles?: Set<string>
): number {
  let score = 0;
  const text = `${item.title} ${item.summary}`;

  if (text.includes(topic)) score += 30;
  for (const char of topic) {
    if (text.includes(char)) score += 2;
  }

  const preferredDomains = ["people.com.cn", "news.cn", "xinhuanet.com", "cctv.com",
    "chinanews.com.cn", "gov.cn", "thepaper.cn", "caixin.com", "cls.cn",
    "36kr.com", "huxiu.com", "ithome.com", "jiqizhixin.com", "qbitai.com"];
  const blockedDomains = ["wikipedia.org", "zhihu.com", "youtube.com", "bilibili.com"];
  const hotWords = ["最新", "今日", "刚刚", "重磅", "发布", "上线", "宣布", "热点", "热议",
    "突破", "融资", "收购", "监管", "政策", "增长", "榜单", "爆发"];

  try {
    const domain = new URL(item.url).hostname.toLowerCase();
    if (preferredDomains.some(d => domain.endsWith(d))) score += 25;
    if (blockedDomains.some(d => domain.endsWith(d))) score -= 80;
  } catch { /* invalid URL */ }

  for (const word of hotWords) {
    if (text.includes(word)) score += 4;
  }

  if (recentUrls?.has(item.url) || recentUrls?.has(canonicalUrl(item.url))) {
    score -= 60;
  }

  if (isRecentlySeenTitle(item.title, recentTitles)) {
    score -= 50;
  }

  const ageDesc = timeDescription(item.published);
  const hours = ageHours(item.published);
  if (hours !== null) {
    if (hours <= 6) score += 50;
    else if (hours <= 24) score += 38;
    else if (hours <= 48) score += 20;
    else if (hours <= 72) score += 8;
    else score -= Math.min(35, Math.floor(hours / 24) * 3);
  } else if (ageDesc === "刚刚" || ageDesc.includes("小时")) score += 35;
  else if (ageDesc === "昨天") score += 18;
  else if (ageDesc === "前天") score += 8;
  else score += 4;

  if (item.summary.length > 30) score += 5;
  if (item.title.length > 10 && item.title.length < 80) score += 5;

  return score;
}
