export interface WebContextRequestOptions {
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  body?: string;
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
  discoveredFrom?: string;
  endorsedByOfficial?: boolean;
}

export type WebSearchMode = "auto" | "always" | "off";

export interface WebSearchGroundingItem extends WebSearchItem {
  query: string;
  content: string;
  fetched: boolean;
  evidenceTier?: WebEvidenceTier;
  relevanceScore?: number;
}

export type WebEvidenceTier = "primary" | "secondary" | "snippet";

export interface WebSearchAssessment {
  sufficient: boolean;
  confidence: number;
  primaryCount: number;
  secondaryCount: number;
  relevantFetchedCount: number;
  warning: string;
}

export interface WebSearchRecoveryInput {
  phase: "initial" | "recovery";
  query: string;
  executedQueries: string[];
  results: Array<Pick<WebSearchGroundingItem, "title" | "url" | "snippet" | "fetched">>;
  maxQueries: number;
}

export interface WebSearchRecoveryPlan {
  queries: string[];
  urls?: string[];
}

export type WebSearchQueryPlanner = (
  input: WebSearchRecoveryInput
) => Promise<string[] | WebSearchRecoveryPlan>;

export type ConfiguredWebSearchProviderType = "built-in" | "tavily" | "brave" | "searxng";

export interface ConfiguredWebSearchProvider {
  type: ConfiguredWebSearchProviderType;
  endpoint?: string;
  apiKey?: string;
}

export interface WebSearchProviderItem extends WebSearchItem {
  /** Provider-extracted page body. Snippets must stay in `snippet`. */
  content?: string;
}

export interface WebSearchProviderOptions {
  maxResults: number;
  maxPageChars: number;
}

export type WebSearchProvider = (
  query: string,
  options: WebSearchProviderOptions
) => Promise<WebSearchProviderItem[]>;

export interface WebSearchGrounding {
  query: string;
  queries: string[];
  results: WebSearchGroundingItem[];
  searchedAt: string;
  warnings: string[];
}

export interface WebSearchOptions {
  maxResults?: number;
  fetchTopPages?: number;
  maxPageChars?: number;
  maxQueries?: number;
  /**
   * Optional plan-before-retrieve stage. It runs in parallel with the
   * deterministic search round and may propose anchored queries or exact
   * public pages. Every proposal still passes SSRF, relevance and authority
   * checks before it can become evidence.
   */
  initialQueryPlanner?: WebSearchQueryPlanner;
  recoveryQueryPlanner?: WebSearchQueryPlanner;
  /** Optional one-call search backend such as Tavily, Brave or SearXNG. */
  searchProvider?: WebSearchProvider;
  maxRecoveryQueries?: number;
  now?: Date;
}

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
};
const SEARCH_TIMEOUT_MS = 8_000;
const READER_SEARCH_TIMEOUT_MS = 18_000;
const URL_TIMEOUT_MS = 10_000;
const DOCUMENT_MARKDOWN_TIMEOUT_MS = 6_000;
const DEFAULT_MAX_PAGE_CHARS = 6_000;
const WEB_SEARCH_INTENT_RE = /(联网|网页|网上|上网|搜索|搜一下|帮我搜|查一下|查网页|百度|必应|谷歌|google|bing|search web|web search|look up|online|internet)/i;
const WEB_SEARCH_CLEAN_RE = /(联网|网页|网上|上网|搜索|搜一下|帮我搜|查一下|查网页|百度|必应|谷歌|google|bing|search web|web search|look up|online|internet)/gi;
const WEB_SEARCH_RECENCY_RE = /(最新|当前|现在|近期|最近|截至|今日|本周|本月|今年|刚刚|实时|现任|版本|价格|汇率|天气|赛程|比分|政策|法规|标准|发布|更新|新闻|latest|current|today|recent|real[ -]?time|release|version|price|weather|news)/i;
const WEB_SEARCH_EXTERNAL_TOPIC_RE = /([A-Za-z][A-Za-z0-9._+/#-]{1,}|官网|官方|文档|产品|公司|组织|人物|政策|法规|法律|标准|版本|价格|汇率|天气|赛程|比分|新闻|论文|研究|市场|行业|API|SDK|GitHub|Obsidian|Node(?:\.js)?|Python|React)/i;
const AUTHORITATIVE_SEARCH_RE = /(官网|官方网站|官方|最新|当前|实时|计价|定价|价格|收费|费用|政策|法规|法律|标准|official|latest|current|pricing|price|cost|billing|policy|regulation|standard)/i;
const WEB_EVIDENCE_INTENT_GROUPS: Array<{ query: RegExp; evidence: RegExp }> = [
  {
    query: /(计价|定价|价格|收费|费用|成本|price|pricing|cost|billing)/i,
    evidence: /(计价|定价|价格|收费|费用|成本|扣费|token.{0,24}(?:元|美元|¥|\$)|price|pricing|cost|billing|per\s+(?:1m|million)|input\s+tokens?|output\s+tokens?)/i
  },
  {
    query: /(版本|发布|更新|release|version|changelog)/i,
    evidence: /(版本|发布|更新|发布日期|release|version|changelog)/i
  },
  {
    query: /(天气|气温|降雨|预报|weather|temperature|forecast)/i,
    evidence: /(天气|气温|温度|降雨|预报|weather|temperature|forecast)/i
  },
  {
    query: /(汇率|exchange\s*rate|currency)/i,
    evidence: /(汇率|兑换|exchange\s*rate|currency)/i
  },
  {
    query: /(政策|法规|法律|标准|policy|regulation|law|standard)/i,
    evidence: /(政策|法规|法律|标准|实施|生效|policy|regulation|law|standard|effective)/i
  }
];
const INTERNAL_RETRIEVAL_LINE_RE = /^(检索意图|当前项目|目标文档|本轮导入文件|项目范围|ContextMode|ContextEngine)\s*[：:].*$/gimu;
const URL_RE = /https?:\/\/[^\s\]\)"'<>]+/g;

export function extractWebUrls(message: string): string[] {
  const urls = message.match(URL_RE) ?? [];
  return Array.from(new Set(urls.map(stripTrailingUrlPunctuation).filter(Boolean)));
}

export function normalizeWebSearchMode(value: unknown): WebSearchMode {
  return value === "always" || value === "off" ? value : "auto";
}

export function shouldSearchWeb(message: string, mode: WebSearchMode = "auto"): boolean {
  const normalizedMode = normalizeWebSearchMode(mode);
  if (normalizedMode === "off") return false;
  const prompt = sanitizeSearchPrompt(message);
  if (prompt.length < 2) return false;
  if (normalizedMode === "always") return true;
  if (WEB_SEARCH_INTENT_RE.test(prompt)) return true;
  return WEB_SEARCH_RECENCY_RE.test(prompt) && WEB_SEARCH_EXTERNAL_TOPIC_RE.test(prompt);
}

/**
 * Rejects readable-but-off-topic pages before they become answer evidence.
 * Search engines often return a vendor home page for a pricing/version query;
 * readability alone does not make that page evidence for the requested fact.
 */
export function isWebEvidenceRelevant(query: string, evidence: string): boolean {
  const prompt = sanitizeSearchPrompt(query).toLowerCase();
  const body = String(evidence || "").toLowerCase();
  if (!body.trim()) return false;
  if (!matchesEvidenceIntent(prompt, body)) return false;
  if (/(计价|定价|价格|收费|费用|成本|price|pricing|cost|billing)/i.test(prompt)) {
    // A heading such as "Pricing guide" is navigation, not a pricing fact.
    // Require a concrete rate, currency amount, or an explicit free-tier rule
    // before allowing the page to ground a price answer.
    if (!hasConcretePricingFact(body)) return false;
  }
  if (/(版本|发布|更新|release|version|changelog)/i.test(prompt)) {
    // A navigation page saying “see the latest version” cannot establish
    // which release is current. Require an actual release identifier next to
    // release-state wording so prices, dates and generic “version” copy do not
    // accidentally pass the evidence gate.
    if (!hasConcreteVersionFact(body)) return false;
  }

  const subjectTokens = (prompt.match(/[a-z][a-z0-9._+/#-]{1,}/gi) ?? [])
    .map((token) => token.toLowerCase())
    .filter((token) => !/^(?:api|sdk|web|online|internet|latest|current|official|price|pricing|cost|billing|version|release|search|look|up)$/i.test(token));
  return subjectTokens.length === 0 || subjectTokens.some((token) => containsSearchToken(body, token));
}

/**
 * Evaluate the whole evidence set instead of treating one readable page as a
 * binary success. One relevant primary source is enough; otherwise two
 * independent fetched sources are required and the caller is told that the
 * result is not official. Search snippets alone never pass this gate.
 */
export function assessWebSearchGrounding(
  grounding: WebSearchGrounding,
  query = grounding.query
): WebSearchAssessment {
  const relevant = grounding.results.filter((item) => {
    if (!item.fetched || !item.content.trim()) return false;
    const score = item.relevanceScore ?? webEvidenceRelevanceScore(
      query,
      `${item.title}\n${item.url}\n${item.snippet}\n${item.content}`,
      true
    );
    return score >= 0.55;
  });
  const primary = relevant.filter((item) => (item.evidenceTier
    ?? classifyWebEvidenceTier(query, item, item.fetched)) === "primary");
  const secondaryDomains = new Set(relevant
    .filter((item) => (item.evidenceTier ?? classifyWebEvidenceTier(query, item, item.fetched)) === "secondary")
    .map((item) => domainLabel(item.url)));
  const primaryCount = primary.length;
  const secondaryCount = secondaryDomains.size;
  const sufficient = primaryCount >= 1 || secondaryCount >= 2;
  const confidence = sufficient
    ? Math.min(0.98, primaryCount > 0 ? 0.9 + Math.min(primaryCount - 1, 2) * 0.03 : 0.7 + Math.min(secondaryCount - 2, 2) * 0.07)
    : Math.min(0.49, relevant.length * 0.2);
  return {
    sufficient,
    confidence,
    primaryCount,
    secondaryCount,
    relevantFetchedCount: relevant.length,
    warning: sufficient && primaryCount === 0
      ? "未取得可核对的官方正文；当前证据来自至少两个独立网页，回答必须明确标注来源级别，不得表述为官方结论。"
      : ""
  };
}

export function getWebSearchQuery(
  message: string,
  options: { mode?: WebSearchMode; force?: boolean } = {}
): string | null {
  const mode = options.force ? "always" : normalizeWebSearchMode(options.mode);
  const withoutUrls = sanitizeSearchPrompt(message);
  if (!shouldSearchWeb(withoutUrls, mode)) return null;
  const query = withoutUrls
    .replace(WEB_SEARCH_CLEAN_RE, " ")
    .replace(/^(请|帮我|麻烦|能不能|可以)?\s*(一下|一下子)?/u, " ")
    .replace(/[：:？?。；;，,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return query.length >= 2 ? query.slice(0, 120) : null;
}

export function planWebSearchQueries(
  message: string,
  options: { mode?: WebSearchMode; maxQueries?: number; now?: Date } = {}
): string[] {
  const mode = normalizeWebSearchMode(options.mode ?? "always");
  const base = getWebSearchQuery(message, { mode });
  if (!base) return [];
  const maxQueries = Math.max(1, Math.min(options.maxQueries ?? 3, 5));
  const candidates = [base];
  const year = (options.now ?? new Date()).getUTCFullYear();
  const subject = extractSearchSubjectTokens(base).slice(0, 4).join(" ");
  const intent = inferEnglishSearchIntent(base);

  // Query diversification is deliberately domain-neutral. It does not know
  // vendor names; it extracts the subject and rewrites only the user's intent.
  // This is the deterministic first stage used before an optional AI recovery
  // planner, following the same bounded plan -> retrieve -> assess shape as
  // mature research agents.
  if (maxQueries > 1 && subject && intent) candidates.push(`${subject} ${intent}`);
  if (maxQueries > 2 && subject && intent && AUTHORITATIVE_SEARCH_RE.test(base)) {
    candidates.push(`${subject} official ${intent}`);
  } else if (maxQueries > 2 && AUTHORITATIVE_SEARCH_RE.test(base)) {
    candidates.push(`${base} 官方 官网`);
  }
  if (maxQueries > 3 && WEB_SEARCH_RECENCY_RE.test(base) && !/\b20\d{2}\b/.test(base)) {
    candidates.push(`${subject || base} ${intent || "latest"} ${year}`);
  }
  if (maxQueries > 1 && candidates.length === 1 && /(?:API|SDK|文档|documentation|docs)/i.test(base)) {
    candidates.push(`${base} 官方文档`);
  }
  if (maxQueries > 1 && candidates.length === 1 && /(?:对比|比较|区别|差异|\bvs\.?\b| versus )/i.test(base)) {
    candidates.push(`${base} 一手来源`);
  }

  return uniqueStrings(candidates.map(normalizeSearchQuery)).slice(0, maxQueries);
}

/**
 * Build one optional, vendor-neutral search adapter from local settings.
 * The adapter is called at most once per user query by `searchWebGrounding`.
 * Provider bodies are never trusted directly: URLs, relevance, authority and
 * multi-source evidence are still checked by the normal grounding pipeline.
 */
export function createConfiguredWebSearchProvider(
  config: ConfiguredWebSearchProvider,
  request: WebContextRequest
): WebSearchProvider | undefined {
  const type = normalizeConfiguredWebSearchProviderType(config.type);
  if (type === "built-in") return undefined;
  const apiKey = String(config.apiKey || "").trim();
  if ((type === "tavily" || type === "brave") && !apiKey) return undefined;
  const endpoint = normalizeConfiguredSearchEndpoint(type, config.endpoint);
  if (!endpoint) return undefined;

  return async (query, options) => {
    const maxResults = Math.max(1, Math.min(options.maxResults, 10));
    if (type === "tavily") {
      const response = await withTimeout(request(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: "basic",
          topic: "general",
          max_results: maxResults,
          include_answer: false,
          include_images: false,
          include_raw_content: "markdown"
        })
      }), 15_000, "Configured Tavily search timed out.");
      assertConfiguredProviderResponse(response, "Tavily");
      const payload = parseJsonRecord(response.text);
      return asRecordArray(payload.results).map((item) => ({
        title: String(item.title || item.url || "Tavily result"),
        url: String(item.url || ""),
        source: "tavily",
        snippet: String(item.content || ""),
        content: String(item.raw_content || "")
      }));
    }

    if (type === "brave") {
      const url = new URL(endpoint);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(maxResults));
      url.searchParams.set("text_decorations", "false");
      url.searchParams.set("search_lang", shouldUseEnglishSearchLocale(query) ? "en" : "zh-hans");
      const response = await withTimeout(request(url.href, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "X-Subscription-Token": apiKey
        }
      }), 15_000, "Configured Brave search timed out.");
      assertConfiguredProviderResponse(response, "Brave");
      const payload = parseJsonRecord(response.text);
      const web = asRecord(payload.web);
      return asRecordArray(web.results).map((item) => ({
        title: String(item.title || item.url || "Brave result"),
        url: String(item.url || ""),
        source: "brave",
        snippet: [String(item.description || ""), ...asStringArray(item.extra_snippets)].filter(Boolean).join(" ")
      }));
    }

    const url = new URL(endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("language", shouldUseEnglishSearchLocale(query) ? "en" : "zh-CN");
    const response = await withTimeout(request(url.href, {
      method: "GET",
      headers: { "Accept": "application/json" }
    }), 15_000, "Configured SearXNG search timed out.");
    assertConfiguredProviderResponse(response, "SearXNG");
    const payload = parseJsonRecord(response.text);
    return asRecordArray(payload.results).slice(0, maxResults).map((item) => ({
      title: String(item.title || item.url || "SearXNG result"),
      url: String(item.url || ""),
      source: "searxng",
      snippet: String(item.content || "")
    }));
  };
}

export function isWebRecoveryQueryAnchored(originalQuery: string, candidateQuery: string): boolean {
  const original = normalizeSearchQuery(originalQuery).toLowerCase();
  const candidate = normalizeSearchQuery(candidateQuery).toLowerCase();
  if (candidate.length < 3) return false;
  const subjects = extractSearchSubjectTokens(original).map((item) => item.toLowerCase());
  if (subjects.length > 0) return subjects.some((item) => candidate.includes(item));
  const hanTerms = (original.match(/[\u3400-\u9fff]{2,8}/gu) ?? [])
    .filter((item) => !/(?:联网|网页|网上|上网|搜索|搜一下|帮我搜|查一下|官网|官方|最新|当前|现在)/u.test(item));
  return hanTerms.length === 0 || hanTerms.some((item) => candidate.includes(item));
}

export async function fetchReadableUrl(
  url: string,
  request: WebContextRequest,
  maxChars = DEFAULT_MAX_PAGE_CHARS,
  focusQuery = ""
): Promise<string> {
  const safeUrl = normalizePublicHttpUrl(url);
  try {
    const direct = await fetchReadableUrlDirect(safeUrl, request, maxChars, focusQuery);
    if (!/Status: fetched, but no readable text was found\.$/.test(direct)) {
      // A readable but irrelevant page should be rejected by the evidence
      // grader, not retried through an 18-second reader. The bounded recovery
      // stage can instead choose another result or a better anchored query.
      return direct;
    }
  } catch (directError) {
    try {
      return await fetchReadableUrlViaReader(safeUrl, request, maxChars, errorMessage(directError), focusQuery);
    } catch (readerError) {
      throw new Error(`Direct URL fetch failed: ${errorMessage(directError)}; reader fallback failed: ${errorMessage(readerError)}`);
    }
  }

  return fetchReadableUrlViaReader(safeUrl, request, maxChars, "direct fetch returned no readable text", focusQuery);
}

export async function searchWebAsMarkdown(
  query: string,
  request: WebContextRequest,
  options: WebSearchOptions = {}
): Promise<string> {
  return formatWebSearchGroundingMarkdown(await searchWebGrounding(query, request, options));
}

export async function searchWebGrounding(
  query: string,
  request: WebContextRequest,
  options: WebSearchOptions = {}
): Promise<WebSearchGrounding> {
  const cleanQuery = normalizeSearchQuery(query);
  const now = options.now ?? new Date();
  const empty: WebSearchGrounding = {
    query: cleanQuery,
    queries: [],
    results: [],
    searchedAt: now.toISOString(),
    warnings: cleanQuery ? [] : ["Web search skipped: empty query."]
  };
  if (!cleanQuery) return empty;

  const maxResults = Math.max(1, Math.min(options.maxResults ?? 8, 12));
  const fetchTopPages = Math.max(0, Math.min(options.fetchTopPages ?? 4, 6));
  const maxPageChars = Math.max(800, Math.min(options.maxPageChars ?? DEFAULT_MAX_PAGE_CHARS, 12_000));
  const queries = planWebSearchQueries(cleanQuery, {
    mode: "always",
    maxQueries: options.maxQueries ?? 3,
    now
  });
  const warnings: string[] = [];
  const executedQueries = [...queries];
  const fetchedByUrl = new Map<string, { content: string; warning: string }>();
  const maxPlannerQueries = Math.max(1, Math.min(options.maxRecoveryQueries ?? 2, 3));

  const normalizePlannerResult = (
    proposed: string[] | WebSearchRecoveryPlan | null | undefined,
    maxQueries: number
  ): { queries: string[]; urls: string[] } => {
    const proposedQueries = Array.isArray(proposed) ? proposed : proposed?.queries || [];
    const proposedUrls = Array.isArray(proposed) ? [] : proposed?.urls || [];
    return {
      queries: uniqueStrings(proposedQueries.map(normalizeSearchQuery))
        .filter((item) => !executedQueries.includes(item))
        .filter((item) => isWebRecoveryQueryAnchored(cleanQuery, item))
        .slice(0, maxQueries),
      urls: normalizeRecoveryUrlCandidates(proposedUrls, maxQueries)
    };
  };

  const plannerUrlItems = (urls: string[], phase: "initial" | "recovery") => urls
    .map((url): WebSearchItem & { query: string } => ({
      title: `Planned source for ${cleanQuery}`,
      url,
      source: domainLabel(url),
      snippet: `Proposed by the bounded ${phase} web planner; content still requires relevance and authority verification.`,
      query: cleanQuery
    }));

  const searchQueries = async (plannedQueries: string[]) => {
    const batches = await Promise.all(plannedQueries.map(async (plannedQuery) => {
      const items = await searchWebResults(plannedQuery, request, maxResults);
      if (items.length === 0) warnings.push(`No readable search results were returned for: ${plannedQuery}`);
      return items.map((item) => ({ ...item, query: plannedQuery }));
    }));
    return dedupeGroundingItems(batches.flat());
  };

  const enrichCandidates = async (input: Array<WebSearchItem & { query: string }>) => {
    let next = dedupeGroundingItems(input);
    const discovered = await discoverRelevantOfficialLinks(cleanQuery, next, request, maxResults);
    next = dedupeGroundingItems([...discovered, ...next]);
    return next;
  };

  // Research agents work better when query planning and the first retrieval
  // round overlap instead of waiting for a failed search before planning.
  // The deterministic path remains available if the model is unavailable.
  const initialPlannerTask = options.initialQueryPlanner
    ? options.initialQueryPlanner({
      phase: "initial",
      query: cleanQuery,
      executedQueries: [...executedQueries],
      results: [],
      maxQueries: maxPlannerQueries
    }).then((proposed) => ({ proposed, error: "" }))
      .catch((error) => ({ proposed: null, error: errorMessage(error) }))
    : Promise.resolve({ proposed: null, error: "" });
  const providerTask = options.searchProvider
    ? options.searchProvider(cleanQuery, { maxResults, maxPageChars })
      .then((items) => ({ items, error: "" }))
      .catch((error) => ({ items: [] as WebSearchProviderItem[], error: errorMessage(error) }))
    : Promise.resolve({ items: [] as WebSearchProviderItem[], error: "" });
  const [firstSearchCandidates, initialPlanResult, providerResult] = await Promise.all([
    searchQueries(queries),
    initialPlannerTask,
    providerTask
  ]);
  const providerCandidates: Array<WebSearchItem & { query: string }> = [];
  let rejectedProviderItems = 0;
  for (const item of providerResult.items) {
    try {
      const url = normalizePublicHttpUrl(String(item.url || ""));
      const title = cleanProviderField(item.title, 240) || url;
      const snippet = cleanProviderField(item.snippet, 1_200);
      const rawContent = String(item.content || "").trim();
      if (rawContent) {
        const readable = documentationMarkdownToReadableText(rawContent);
        const selected = selectRelevantReadableText(readable, cleanQuery, maxPageChars);
        if (selected) {
          fetchedByUrl.set(url, {
            content: [`Source: ${url}`, `Title: ${title}`, selected].join("\n"),
            warning: ""
          });
        }
      }
      providerCandidates.push({
        title,
        url,
        source: domainLabel(url),
        snippet,
        discoveredFrom: cleanProviderField(item.source, 80) || "configured-provider",
        query: cleanQuery
      });
    } catch {
      rejectedProviderItems += 1;
    }
  }
  if (providerResult.error) warnings.push(`Configured web provider failed: ${providerResult.error}`);
  if (rejectedProviderItems > 0) warnings.push(`Configured web provider returned ${rejectedProviderItems} unsafe or invalid URL(s); they were ignored.`);
  let candidates = dedupeGroundingItems([...providerCandidates, ...firstSearchCandidates]);
  if (initialPlanResult.error) {
    warnings.push(`Initial web query planner failed: ${initialPlanResult.error}`);
  } else if (initialPlanResult.proposed) {
    const initialPlan = normalizePlannerResult(initialPlanResult.proposed, maxPlannerQueries);
    if (initialPlan.queries.length > 0 || initialPlan.urls.length > 0) {
      executedQueries.push(...initialPlan.queries);
      candidates = dedupeGroundingItems([
        ...plannerUrlItems(initialPlan.urls, "initial"),
        ...candidates,
        ...(initialPlan.queries.length > 0 ? await searchQueries(initialPlan.queries) : [])
      ]);
    }
  }

  // If generic search only surfaced a matching vendor home page, derive one
  // bounded site query from that page. This is entity/domain discovery rather
  // than a vendor allow-list, so it works for new providers without code
  // changes and keeps the original subject anchored in the query.
  const siteRecoveryQueries = planOfficialSiteRecoveryQueries(cleanQuery, candidates, 1)
    .filter((item) => !executedQueries.includes(item));
  if (siteRecoveryQueries.length > 0) {
    executedQueries.push(...siteRecoveryQueries);
    candidates = dedupeGroundingItems([...candidates, ...await searchQueries(siteRecoveryQueries)]);
  }

  candidates = await enrichCandidates(candidates);
  // The reader-backed search is a last resort for installations without an AI
  // recovery planner. In the Weixin Agent, the bounded planner is faster and
  // more precise than waiting on a second search-page proxy.
  if (!options.initialQueryPlanner && !options.recoveryQueryPlanner && needsReaderSearch(cleanQuery, candidates)) {
    const readerQuery = [...executedQueries].reverse().find((item) => /[A-Za-z]/u.test(item)) || executedQueries[0] || cleanQuery;
    const readerUrl = `https://r.jina.ai/http://www.bing.com/search?q=${encodeURIComponent(readerQuery)}`;
    const readerItems = (await requestSearchItems(readerUrl, request, maxResults))
      .map((item) => ({ ...item, query: readerQuery }));
    candidates = dedupeGroundingItems([...readerItems, ...candidates]);
  }
  const maxFetchPerRound = Math.min(
    6,
    fetchTopPages + (options.initialQueryPlanner || options.recoveryQueryPlanner ? 1 : 0)
  );
  const materialize = async (): Promise<WebSearchGrounding> => {
    const ranked = rankSearchItems(candidates, cleanQuery).slice(0, maxResults);
    const unfetched = ranked
      .filter((item) => !fetchedByUrl.has(item.url))
      // Recovery results arrive after the first materialization pass. Limiting
      // by the lifetime cache size meant a noisy first page could consume the
      // entire budget and the newly planned official result was never read.
      // Keep each bounded retrieve -> assess round independently budgeted.
      .slice(0, maxFetchPerRound);
    const fetchedPages = await Promise.all(unfetched.map(async (item) => {
      try {
        return {
          url: item.url,
          content: await fetchSearchResultEvidence(item, cleanQuery, request, maxPageChars),
          warning: ""
        };
      } catch (error) {
        return {
          url: item.url,
          content: "",
          warning: `Unable to read ${item.url}: ${errorMessage(error)}`
        };
      }
    }));
    for (const page of fetchedPages) {
      fetchedByUrl.set(page.url, { content: page.content, warning: page.warning });
      if (page.warning) warnings.push(page.warning);
    }
    const results = ranked.map((item): WebSearchGroundingItem => {
      const page = fetchedByUrl.get(item.url);
      const content = page?.content ?? "";
      const fetched = Boolean(content.trim());
      const evidenceTier = classifyWebEvidenceTier(cleanQuery, item, fetched);
      return {
        ...item,
        content,
        fetched,
        evidenceTier,
        relevanceScore: webEvidenceRelevanceScore(cleanQuery, `${item.title}\n${item.url}\n${item.snippet}\n${content}`, fetched)
      };
    });
    return {
      query: cleanQuery,
      queries: [...executedQueries],
      searchedAt: now.toISOString(),
      warnings: uniqueStrings(warnings),
      results
    };
  };

  let grounding = await materialize();
  if (options.recoveryQueryPlanner && !assessWebSearchGrounding(grounding, cleanQuery).sufficient) {
    try {
      const maxRecoveryQueries = Math.max(1, Math.min(options.maxRecoveryQueries ?? 2, 3));
      const proposed = await options.recoveryQueryPlanner({
        phase: "recovery",
        query: cleanQuery,
        executedQueries: [...executedQueries],
        results: grounding.results.slice(0, 8).map(({ title, url, snippet, fetched }) => ({ title, url, snippet, fetched })),
        maxQueries: maxRecoveryQueries
      });
      const recoveryPlan = normalizePlannerResult(proposed, maxRecoveryQueries);
      const recoveryQueries = recoveryPlan.queries;
      const recoveryUrlItems = plannerUrlItems(recoveryPlan.urls, "recovery");
      if (recoveryQueries.length > 0 || recoveryUrlItems.length > 0) {
        executedQueries.push(...recoveryQueries);
        candidates = await enrichCandidates([
          ...recoveryUrlItems,
          ...candidates,
          ...(recoveryQueries.length > 0 ? await searchQueries(recoveryQueries) : [])
        ]);
        grounding = await materialize();
      }
    } catch (error) {
      warnings.push(`Web query recovery planner failed: ${errorMessage(error)}`);
      grounding = { ...grounding, warnings: uniqueStrings(warnings) };
    }
  }

  const assessment = assessWebSearchGrounding(grounding, cleanQuery);
  if (assessment.warning) grounding.warnings = uniqueStrings([...grounding.warnings, assessment.warning]);
  return grounding;
}

export function formatWebSearchGroundingMarkdown(grounding: WebSearchGrounding): string {
  if (!grounding.query) return grounding.warnings[0] ?? "Web search skipped: empty query.";
  if (grounding.results.length === 0) {
    return [`Web search query: ${grounding.query}`, ...grounding.warnings].join("\n");
  }
  const lines = [
    `Web search query: ${grounding.query}`,
    grounding.queries.length > 1 ? `Executed queries: ${grounding.queries.join(" | ")}` : "",
    `Searched at: ${grounding.searchedAt}`,
    "",
    "Search results:"
  ].filter(Boolean);
  for (const [index, item] of grounding.results.entries()) {
    lines.push(`${index + 1}. ${item.title}\n   ${item.url}\n   ${item.snippet || item.source}`);
    if (item.content) lines.push(`\n### ${item.title}\n${item.content}`);
  }
  if (grounding.warnings.length > 0) lines.push("", `Warnings: ${grounding.warnings.join(" | ")}`);
  return lines.join("\n").trim();
}

function sanitizeSearchPrompt(message: string): string {
  return String(message || "")
    .replace(INTERNAL_RETRIEVAL_LINE_RE, " ")
    .replace(URL_RE, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearchQuery(query: string): string {
  return String(query || "")
    .replace(INTERNAL_RETRIEVAL_LINE_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function normalizeConfiguredWebSearchProviderType(value: unknown): ConfiguredWebSearchProviderType {
  return value === "tavily" || value === "brave" || value === "searxng" ? value : "built-in";
}

function normalizeConfiguredSearchEndpoint(
  type: Exclude<ConfiguredWebSearchProviderType, "built-in">,
  value: unknown
): string {
  if (type === "tavily") return "https://api.tavily.com/search";
  if (type === "brave") return "https://api.search.brave.com/res/v1/web/search";
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.username = "";
    url.password = "";
    url.hash = "";
    if (!/\/search\/?$/u.test(url.pathname)) {
      url.pathname = `${url.pathname.replace(/\/$/u, "")}/search`;
    }
    return url.href;
  } catch {
    return "";
  }
}

function assertConfiguredProviderResponse(response: WebContextResponse, label: string): void {
  const status = response.status ?? 200;
  if (status >= 400) throw new Error(`${label} search returned HTTP ${status}.`);
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(String(value || "")));
  } catch {
    throw new Error("Configured web provider returned invalid JSON.");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord).filter((item) => Object.keys(item).length > 0) : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function cleanProviderField(value: unknown, maxChars: number): string {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxChars);
}

function extractSearchSubjectTokens(query: string): string[] {
  const stop = /^(?:api|sdk|web|online|internet|latest|current|today|recent|official|price|pricing|cost|billing|version|release|news|search|look|up|documentation|docs?)$/iu;
  return uniqueStrings((query.match(/[A-Za-z][A-Za-z0-9._+/#-]{1,}/g) ?? [])
    .map((token) => token.trim())
    .filter((token) => !stop.test(token)));
}

function inferEnglishSearchIntent(query: string): string {
  if (/(?:计价|定价|价格|收费|费用|成本|price|pricing|cost|billing)/iu.test(query)) return "API pricing";
  if (/(?:版本|发布|更新|变更|release|version|changelog)/iu.test(query)) return "latest release changelog";
  if (/(?:文档|接口|调用|参数|documentation|docs?|reference)/iu.test(query)) return "official documentation";
  if (/(?:政策|法规|法律|标准|policy|regulation|law|standard)/iu.test(query)) return "official policy";
  if (/(?:新闻|动态|消息|news)/iu.test(query)) return "latest news";
  if (/(?:论文|研究|paper|research)/iu.test(query)) return "research paper";
  if (WEB_SEARCH_RECENCY_RE.test(query)) return "latest";
  return "";
}

function webEvidenceRelevanceScore(query: string, evidence: string, fetched: boolean): number {
  if (!fetched || !String(evidence || "").trim()) return 0;
  let score = isWebEvidenceRelevant(query, evidence) ? 0.58 : 0;
  const lower = evidence.toLowerCase();
  const subjects = extractSearchSubjectTokens(query).map((item) => item.toLowerCase());
  if (subjects.length === 0 || subjects.some((item) => containsSearchToken(lower, item))) score += 0.16;
  if (matchesEvidenceIntent(query, evidence)) score += 0.12;
  if (/(?:[$¥￥]\s*\d|\d+(?:\.\d+)?\s*(?:元|美元|usd|cny)|\b20\d{2}\b|\d+(?:\.\d+)?\s*%)/iu.test(evidence)) score += 0.08;
  if (evidence.length >= 240) score += 0.06;
  return Math.min(1, score);
}

function classifyWebEvidenceTier(query: string, item: WebSearchItem, fetched: boolean): WebEvidenceTier {
  if (!fetched) return "snippet";
  // A URL that merely contains the subject can be useful for discovering a
  // vendor domain, but it is not proof that the page is an official source.
  // Keep discovery candidates and evidence authority as separate concepts so
  // third-party articles such as /examplemodel-pricing never become primary.
  return isLikelyAuthoritativeResult(query, item) || item.endorsedByOfficial === true
    ? "primary"
    : "secondary";
}

function dedupeGroundingItems<T extends WebSearchItem & { query: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = canonicalUrl(item.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function rankSearchItems<T extends WebSearchItem>(items: T[], query = ""): T[] {
  return items
    .map((item, index) => ({ item, index, score: sourceQualityScore(item, query) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}

function sourceQualityScore(item: WebSearchItem, query = ""): number {
  let score = 0;
  try {
    const hostname = new URL(item.url).hostname.toLowerCase();
    if (/\.(gov|edu)(\.[a-z]{2})?$/.test(hostname) || /\.gov\.cn$/.test(hostname)) score += 5;
    if (/^(?:api-)?docs?\.|^(?:api|developer|developers|support|help)\./.test(hostname)) score += 4;
    if (/github\.com$/.test(hostname)) score += 2;
  } catch {
    return score;
  }
  if (isLikelyAuthoritativeResult(query, item)) score += 7;
  else if (item.endorsedByOfficial) score += 6;
  else if (/(官方|official|documentation|developer docs|reference)/i.test(`${item.title} ${item.snippet}`)) score += 1;
  if (matchesEvidenceIntent(query, `${item.title} ${item.url} ${item.snippet}`)) score += 3;
  const subjectTokens = extractSearchSubjectTokens(query).map((token) => token.toLowerCase());
  const haystack = `${item.title} ${item.url} ${item.snippet}`.toLowerCase();
  const subjectHits = subjectTokens.filter((token) => containsSearchToken(haystack, token)).length;
  score += Math.min(subjectHits * 3, 6);
  if (subjectTokens.length > 0 && subjectHits === 0) score -= 4;
  if (item.snippet.trim().length >= 40) score += 1;
  return score;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeRecoveryUrlCandidates(values: string[], maxUrls: number): string[] {
  const normalized: string[] = [];
  for (const value of values || []) {
    try {
      const url = normalizePublicHttpUrl(String(value || "").trim());
      if (!normalized.includes(url)) normalized.push(url);
    } catch {
      // Ignore malformed, non-HTTP, loopback and private-network proposals.
      // A model-suggested URL is only a retrieval candidate, never an
      // instruction to weaken the existing SSRF boundary.
    }
    if (normalized.length >= Math.max(0, Math.min(maxUrls, 3))) break;
  }
  return normalized;
}

function containsSearchToken(haystack: string, token: string): boolean {
  const cleanToken = String(token || "").trim().toLowerCase();
  if (!cleanToken) return false;
  const escaped = cleanToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "iu").test(String(haystack || "").toLowerCase());
}

async function searchWebResults(query: string, request: WebContextRequest, maxResults: number): Promise<WebSearchItem[]> {
  const englishLocale = shouldUseEnglishSearchLocale(query);
  const directBing = englishLocale
    ? `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=en-US&setlang=en-US&cc=US`
    : `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&setlang=zh-CN`;
  const duckDuckGo = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=${englishLocale ? "us-en" : "cn-zh"}`;
  // Do not short-circuit after the first non-empty engine. A search page can be
  // syntactically valid while all results are off-topic. Running providers in
  // parallel keeps latency bounded and makes ranking resilient to one engine's
  // transient ordering or regional index.
  const providerLimit = Math.max(maxResults, Math.min(maxResults * 2, 16));
  const [bingItems, duckItems] = await Promise.all([
    requestSearchItems(directBing, request, providerLimit),
    requestSearchItems(duckDuckGo, request, providerLimit)
  ]);
  return rankSearchItems(dedupeSearchItems([...bingItems, ...duckItems]), query).slice(0, Math.min(maxResults * 3, 24));
}

async function discoverRelevantOfficialLinks<T extends WebSearchItem & { query: string }>(
  query: string,
  items: T[],
  request: WebContextRequest,
  maxResults: number
): Promise<T[]> {
  if (!AUTHORITATIVE_SEARCH_RE.test(query)) return [];
  if (items.some((item) => matchesEvidenceIntent(query, `${item.title} ${item.url} ${item.snippet}`)
    && isLikelyAuthoritativeResult(query, item))) return [];

  const seeds = items.filter((item) => isOfficialSeedForQuery(query, item)).slice(0, 2);
  const crawl = async (seed: T, inheritedEndorsement = false): Promise<T[]> => {
    try {
      const response = await withTimeout(
        request(seed.url, { method: "GET", headers: DEFAULT_HEADERS }),
        URL_TIMEOUT_MS,
        `Official link discovery timed out: ${summarizeUrl(seed.url)}`
      );
      const endorsed = inheritedEndorsement || isLikelyAuthoritativeResult(query, seed) || seed.endorsedByOfficial === true;
      return extractRelevantPageLinks(query, response.text, seed.url, endorsed)
        .map((link) => ({
          ...link,
          query: seed.query,
          source: domainLabel(link.url),
          snippet: `Discovered from ${seed.url}`,
          discoveredFrom: seed.url,
          endorsedByOfficial: endorsed
        } as T));
    } catch {
      return [] as T[];
    }
  };
  const firstHop = dedupeGroundingItems((await Promise.all(seeds.map((seed) => crawl(seed)))).flat());
  const navigationSeeds = firstHop
    .filter((item) => !matchesEvidenceIntent(query, `${item.title} ${item.url}`))
    .filter((item) => isDocumentationNavigation(item.title, item.url))
    .slice(0, 2);
  const secondHop = navigationSeeds.length > 0
    ? dedupeGroundingItems((await Promise.all(navigationSeeds.map((seed) => crawl(seed, seed.endorsedByOfficial)))).flat())
    : [];
  return dedupeGroundingItems([...secondHop, ...firstHop]).slice(0, maxResults);
}

function extractRelevantPageLinks(
  query: string,
  html: string,
  sourceUrl: string,
  allowEndorsedCrossSite = false
): WebSearchItem[] {
  const links: WebSearchItem[] = [];
  const anchorRegex = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html)) !== null) {
    try {
      const target = normalizePublicHttpUrl(new URL(decodeEntities(match[1] || match[2] || ""), sourceUrl).href);
      if (canonicalUrl(target) === canonicalUrl(sourceUrl)) continue;
      const title = htmlToReadableText(match[3]).slice(0, 200) || domainLabel(target);
      const sameFamily = sameSiteFamily(target, sourceUrl);
      const relevant = matchesEvidenceIntent(query, `${title} ${target}`);
      const navigation = isDocumentationNavigation(title, target);
      if (!relevant && !navigation) continue;
      if (!sameFamily && (!allowEndorsedCrossSite || !isEndorsableCrossSiteLink(query, title, target))) continue;
      links.push({ title, url: target, source: domainLabel(target), snippet: "" });
    } catch {
      continue;
    }
  }
  return dedupeSearchItems(links);
}

function isDocumentationNavigation(title: string, url: string): boolean {
  return /(?:api|developer|developers|docs?|documentation|reference|platform|pricing|billing|计价|定价|价格|文档|开发者)/iu
    .test(`${title} ${url}`);
}

function isEndorsableCrossSiteLink(query: string, title: string, url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (/(?:facebook|twitter|x\.com|linkedin|youtube|tiktok|instagram|weibo|zhihu)\./iu.test(parsed.hostname)) return false;
    if (hasSubjectUrlAffinity(query, url)) return true;
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./u, "");
    const titleAndPath = `${title} ${parsed.pathname}`;
    // An official product home may intentionally hand documentation to a
    // sibling brand/domain (for example an API platform). Only follow a
    // conservative documentation/developer destination. A generic external
    // page whose path merely says "pricing" is not enough to inherit trust.
    return /^(?:api|docs?|developer|developers|platform|support|help)\./iu.test(hostname)
      || (/(?:api|developer|developers|docs?|documentation|reference|platform)/iu.test(titleAndPath)
        && /(?:api|developer|developers|docs?|documentation|reference|platform)/iu.test(parsed.pathname));
  } catch {
    return false;
  }
}

function isOfficialSeedForQuery(query: string, item: WebSearchItem): boolean {
  if (isLikelyAuthoritativeResult(query, item)) return true;
  // Domain discovery may trust an exact product/vendor label in the
  // registrable host, but never a subject word that appears only in a path.
  // Otherwise an article such as example.com/openai-official would become the
  // seed for a bogus site-restricted recovery query.
  return hasSubjectHostAffinity(query, item.url);
}

function hasSubjectUrlAffinity(query: string, url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./u, "");
    const labels = hostname.split(".");
    const pathTokens = parsed.pathname.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
    const subjectTokens = extractSearchSubjectTokens(query).map((token) => token.toLowerCase());
    return subjectTokens.some((token) => labels.includes(token) || pathTokens.includes(token));
  } catch {
    return false;
  }
}

function hasSubjectHostAffinity(query: string, url: string): boolean {
  try {
    const family = siteFamilyDomain(url);
    if (!family) return false;
    const labels = family.toLowerCase().split(".");
    const subjectTokens = extractSearchSubjectTokens(query).map((token) => token.toLowerCase());
    return subjectTokens.some((token) => labels.includes(token));
  } catch {
    return false;
  }
}

function planOfficialSiteRecoveryQueries(
  query: string,
  items: WebSearchItem[],
  maxQueries = 1
): string[] {
  if (!AUTHORITATIVE_SEARCH_RE.test(query) || maxQueries <= 0) return [];
  if (items.some((item) => matchesEvidenceIntent(query, `${item.title} ${item.url} ${item.snippet}`)
    && isLikelyAuthoritativeResult(query, item))) return [];
  const subject = extractSearchSubjectTokens(query).slice(0, 4).join(" ");
  if (!subject) return [];
  const intent = inferEnglishSearchIntent(query) || "official documentation";
  const domains = uniqueStrings(rankSearchItems(items, query)
    .filter((item) => isOfficialSeedForQuery(query, item))
    .map((item) => siteFamilyDomain(item.url))
    .filter(Boolean));
  return domains
    .map((domain) => `site:${domain} ${subject} ${intent}`)
    .filter((candidate) => isWebRecoveryQueryAnchored(query, candidate))
    .slice(0, Math.max(0, Math.min(maxQueries, 2)));
}

function siteFamilyDomain(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
    const parts = host.split(".").filter(Boolean);
    if (parts.length <= 2) return host;
    const suffixLength = /\.(?:com|net|org|gov|edu|ac)\.cn$/iu.test(host) ? 3 : 2;
    return parts.slice(-suffixLength).join(".");
  } catch {
    return "";
  }
}

function sameSiteFamily(left: string, right: string): boolean {
  try {
    const leftHost = new URL(left).hostname.toLowerCase();
    const rightHost = new URL(right).hostname.toLowerCase();
    return siteFamilyDomain(`https://${leftHost}`) === siteFamilyDomain(`https://${rightHost}`);
  } catch {
    return false;
  }
}

function shouldUseEnglishSearchLocale(query: string): boolean {
  const latinCount = (query.match(/[A-Za-z]/g) ?? []).length;
  const hanCount = (query.match(/[\u3400-\u9fff]/g) ?? []).length;
  return latinCount >= Math.max(4, hanCount)
    || /\b(?:pricing|price|cost|billing|documentation|docs?|release|version)\b/i.test(query);
}

async function requestSearchItems(
  url: string,
  request: WebContextRequest,
  maxResults: number
): Promise<WebSearchItem[]> {
  try {
    const headers = url.includes("mkt=en-US")
      ? { ...DEFAULT_HEADERS, "Accept-Language": "en-US,en;q=0.9" }
      : DEFAULT_HEADERS;
    const response = await withTimeout(
      request(url, { method: "GET", headers }),
      url.startsWith("https://r.jina.ai/http://www.bing.com/search")
        ? READER_SEARCH_TIMEOUT_MS
        : SEARCH_TIMEOUT_MS,
      `Web search timed out: ${summarizeUrl(url)}`
    );
    return dedupeSearchItems(parseSearchResults(response.text, url)).slice(0, maxResults);
  } catch {
    return [];
  }
}

function needsReaderSearch(query: string, items: WebSearchItem[]): boolean {
  if (items.length === 0) return true;
  const relevant = items.filter((item) => matchesEvidenceIntent(query, `${item.title} ${item.url} ${item.snippet}`));
  if (relevant.length === 0) return true;
  return AUTHORITATIVE_SEARCH_RE.test(query) && !relevant.some((item) => isLikelyAuthoritativeResult(query, item));
}

function matchesEvidenceIntent(query: string, evidence: string): boolean {
  return WEB_EVIDENCE_INTENT_GROUPS.every((group) => !group.query.test(query) || group.evidence.test(evidence));
}

function isLikelyAuthoritativeResult(query: string, item: WebSearchItem): boolean {
  try {
    const hostname = new URL(item.url).hostname.toLowerCase();
    if (/\.(?:gov|edu)(?:\.[a-z]{2})?$/i.test(hostname) || /\.gov\.cn$/i.test(hostname)) return true;
    const hostAffinity = hasSubjectHostAffinity(query, item.url);
    if (!hostAffinity) return false;
    // An exact subject label in the registrable domain is a much stronger
    // ownership signal than a keyword in a URL path. Accept its root and
    // documentation subdomains; lookalikes and third-party "official portal"
    // articles remain secondary evidence.
    if (hostname.replace(/^www\./iu, "") === siteFamilyDomain(item.url)) return true;
    if (/^(?:api-)?docs?\.|^(?:api|developer|developers|support|help|platform)\./i.test(hostname)) return true;
  } catch {
    return false;
  }
  return false;
}

async function fetchSearchResultEvidence(
  item: WebSearchItem,
  query: string,
  request: WebContextRequest,
  maxChars: number
): Promise<string> {
  return fetchReadableUrl(item.url, request, maxChars, query);
}

function hasConcretePricingFact(body: string): boolean {
  const amount = /(?:[$¥￥]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:元|美元|usd|cny))/iu;
  const billingUnit = /(?:tokens?|令牌|input|output|输入|输出|request|requests|请求|每\s*(?:1m|million|百万)|per\s*(?:1m|million|million\s+tokens?))/iu;
  const freeQuota = /(?:(?:free|免费).{0,24}\d+(?:\.\d+)?\s*(?:tokens?|令牌|requests?|请求|次)|\d+(?:\.\d+)?\s*(?:tokens?|令牌|requests?|请求|次).{0,24}(?:free|免费))/iu;
  return String(body || "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .some((line) => (amount.test(line) && billingUnit.test(line)) || freeQuota.test(line));
}

function hasConcreteVersionFact(body: string): boolean {
  const releaseContext = /(?:latest|current|stable|public\s+release|general\s+availability|released?|release\s+notes?|changelog|最新版|最新版本|当前版本|稳定版|正式版|正式发布|公开发布|更新至)/iu;
  const versionContext = /(?:version|release|changelog|版本|发布|更新)/iu;
  const identifier = /\bv?\d{1,4}(?:\.\d{1,4}){1,3}(?:[-+][a-z0-9][a-z0-9.-]*)?\b/giu;
  return String(body || "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .some((line) => {
      if (!versionContext.test(line) || !releaseContext.test(line)) return false;
      const matches = Array.from(line.matchAll(identifier));
      return matches.some((match) => {
        const value = match[0];
        const index = match.index ?? 0;
        const before = line.slice(Math.max(0, index - 12), index);
        // Currency amounts such as “$1.30” and calendar dates such as
        // “2026.08.24” are not software release identifiers.
        if (/[$¥￥]\s*$/u.test(before)) return false;
        if (/^20\d{2}\.\d{1,2}\.\d{1,2}$/u.test(value.replace(/^v/iu, ""))) return false;
        return true;
      });
    });
}

async function fetchReadableUrlDirect(
  safeUrl: string,
  request: WebContextRequest,
  maxChars: number,
  focusQuery = ""
): Promise<string> {
  const response = await withTimeout(
    request(safeUrl, { method: "GET", headers: DEFAULT_HEADERS }),
    URL_TIMEOUT_MS,
    `URL fetch timed out: ${safeUrl}`
  );
  const status = response.status ?? 200;
  if (status >= 400) {
    throw new Error(`HTTP ${status} while reading ${summarizeUrl(safeUrl)}`);
  }
  if (isWebAccessChallenge(response.text)) {
    throw new Error(`Browser access challenge while reading ${summarizeUrl(safeUrl)}`);
  }
  const title = extractTitle(response.text);
  const readable = htmlToReadableText(response.text);
  const text = selectRelevantReadableText(readable, focusQuery, maxChars);
  const source = `Source: ${safeUrl}`;
  const direct = !text
    ? `${source}\nStatus: fetched, but no readable text was found.`
    : [source, title ? `Title: ${title}` : "", text].filter(Boolean).join("\n");
  if (focusQuery && !isWebEvidenceRelevant(focusQuery, direct)) {
    const markdown = await fetchAdvertisedDocumentationMarkdown(
      safeUrl,
      response.text,
      request,
      maxChars,
      focusQuery
    );
    if (markdown && isWebEvidenceRelevant(focusQuery, markdown)) return markdown;
  }
  return direct;
}

function isWebAccessChallenge(html: string): boolean {
  const source = String(html || "");
  return /<title[^>]*>\s*(?:just a moment|attention required|access denied|security check)/iu.test(source)
    || /(?:cf-chl-|challenge-platform|enable javascript and cookies to continue|checking your browser before accessing)/iu.test(source);
}

async function fetchAdvertisedDocumentationMarkdown(
  safeUrl: string,
  html: string,
  request: WebContextRequest,
  maxChars: number,
  focusQuery: string
): Promise<string> {
  if (!/(?:documentation\s+index|文档索引)[\s\S]{0,600}llms\.txt/iu.test(String(html || ""))) return "";
  let markdownUrl = "";
  try {
    const parsed = new URL(safeUrl);
    if (/\.(?:md|mdx|txt|json)$/iu.test(parsed.pathname)) return "";
    parsed.pathname = `${parsed.pathname.replace(/\/$/u, "") || "/index"}.md`;
    parsed.search = "";
    parsed.hash = "";
    markdownUrl = normalizePublicHttpUrl(parsed.href);
  } catch {
    return "";
  }
  try {
    const response = await withTimeout(
      request(markdownUrl, {
        method: "GET",
        headers: { ...DEFAULT_HEADERS, "Accept": "text/markdown,text/plain,*/*;q=0.5" }
      }),
      DOCUMENT_MARKDOWN_TIMEOUT_MS,
      `Documentation Markdown fetch timed out: ${markdownUrl}`
    );
    if ((response.status ?? 200) >= 400) return "";
    const readable = documentationMarkdownToReadableText(response.text);
    const selected = selectRelevantReadableText(readable, focusQuery, maxChars);
    if (!selected) return "";
    return [
      `Source: ${safeUrl}`,
      `Markdown source: ${markdownUrl}`,
      selected
    ].join("\n");
  } catch {
    return "";
  }
}

function documentationMarkdownToReadableText(markdown: string): string {
  return decodeEntities(String(markdown || ""))
    .replace(/<>\s*\{\s*["']([$¥￥])["']\s*\}\s*(\d+(?:\.\d+)?)\s*<\/>/giu, "$1$2")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1 ($2)")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchReadableUrlViaReader(
  safeUrl: string,
  request: WebContextRequest,
  maxChars: number,
  directFailure: string,
  focusQuery = ""
): Promise<string> {
  const readerUrl = `https://r.jina.ai/${safeUrl}`;
  const response = await withTimeout(
    request(readerUrl, { method: "GET", headers: { ...DEFAULT_HEADERS, "Accept": "text/plain,text/markdown,*/*;q=0.7" } }),
    URL_TIMEOUT_MS + 8_000,
    `URL reader fallback timed out: ${safeUrl}`
  );
  const text = selectRelevantReadableText(htmlToReadableText(response.text), focusQuery, maxChars);
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

function selectRelevantReadableText(text: string, query: string, maxChars: number): string {
  const cleanText = String(text || "").trim();
  if (!cleanText) return "";
  if (!query || cleanText.length <= maxChars) return cleanText.slice(0, maxChars).trim();
  const lines = cleanText.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 2) {
    const terms = [
      ...extractSearchSubjectTokens(query),
      ...(inferEnglishSearchIntent(query).split(/\s+/u)),
      ...((query.match(/[\u3400-\u9fff]{2,8}/gu) ?? []).slice(0, 8))
    ].map((term) => term.toLowerCase()).filter(Boolean);
    const lower = cleanText.toLowerCase();
    const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
    const center = positions.length > 0 ? Math.min(...positions) : 0;
    const start = Math.max(0, center - Math.floor(maxChars * 0.2));
    return cleanText.slice(start, start + maxChars).trim();
  }

  const subjectTerms = extractSearchSubjectTokens(query).map((item) => item.toLowerCase());
  const intentTerms = inferEnglishSearchIntent(query).split(/\s+/u).map((item) => item.toLowerCase()).filter(Boolean);
  const queryHan = (query.match(/[\u3400-\u9fff]{2,8}/gu) ?? []).map((item) => item.toLowerCase());
  const scored = lines.map((line, index) => {
    const lower = line.toLowerCase();
    let score = 0;
    score += subjectTerms.filter((term) => lower.includes(term)).length * 5;
    score += intentTerms.filter((term) => lower.includes(term)).length * 3;
    score += queryHan.filter((term) => lower.includes(term)).length * 2;
    if (matchesEvidenceIntent(query, line)) score += 3;
    if (/(?:[$¥￥]\s*\d|\d+(?:\.\d+)?\s*(?:元|美元|usd|cny)|\b20\d{2}\b|\d+(?:\.\d+)?\s*%)/iu.test(line)) score += 2;
    return { index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = new Set<number>();
  for (const item of scored.slice(0, 10)) {
    if (item.score <= 0 && selected.size > 0) break;
    for (let offset = -1; offset <= 2; offset += 1) {
      const index = item.index + offset;
      if (index >= 0 && index < lines.length) selected.add(index);
    }
  }
  if (selected.size === 0) return cleanText.slice(0, maxChars).trim();
  return Array.from(selected).sort((a, b) => a - b).map((index) => lines[index]).join("\n").slice(0, maxChars).trim();
}

function parseSearchResults(html: string, sourceUrl: string): WebSearchItem[] {
  if (sourceUrl.startsWith("https://r.jina.ai/http://www.bing.com/search")) {
    return parseReaderSearchResults(html, sourceUrl);
  }
  if (sourceUrl.includes("duckduckgo.com")) return parseDuckDuckGoResults(html, sourceUrl);
  return parseBingResults(html, sourceUrl);
}

function parseReaderSearchResults(markdown: string, sourceUrl: string): WebSearchItem[] {
  const items: WebSearchItem[] = [];
  const resultRegex = /(?:^|\n)\s*\d+\.\s+(?:#{1,4}\s*)?\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s*([\s\S]*?)(?=\n\s*\d+\.\s+(?:#{1,4}\s*)?\[|$)/g;
  let match: RegExpExecArray | null;
  while ((match = resultRegex.exec(markdown)) !== null) {
    const title = markdownToPlainText(match[1]).slice(0, 200);
    const url = resolveSearchUrl(decodeEntities(match[2]), sourceUrl);
    const snippet = markdownToPlainText(match[3]).slice(0, 260);
    if (isUsableSearchResult(url, title)) {
      items.push({ title, url, source: domainLabel(url), snippet });
    }
  }
  return items;
}

function parseBingResults(html: string, sourceUrl: string): WebSearchItem[] {
  const items: WebSearchItem[] = [];
  const blockRegex = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(html)) !== null) {
    const block = match[1];
    // Bing places attribution and tracking anchors before the actual result
    // title. Prefer the h2 headline; taking the first anchor silently turns a
    // useful result into a domain label and loses the intended destination.
    const link = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
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
      const bingTarget = decodeBingRedirectTarget(decoded);
      return new URL(bingTarget || decoded).href;
    }
    return url.href;
  } catch {
    return rawUrl;
  }
}

function decodeBingRedirectTarget(value: string): string {
  if (!/^a1[A-Za-z0-9+/_=-]+$/u.test(value)) return "";
  try {
    const payload = value.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const decoded = atob(padded);
    return /^https?:\/\//iu.test(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

function markdownToPlainText(value: string): string {
  return decodeEntities(String(value || ""))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~#>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
