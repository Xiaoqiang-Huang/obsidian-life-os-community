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
  publishedAt?: string;
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
  /**
   * A planner may resolve an exact non-Latin entity label to its commonly
   * indexed Latin alias. The alias does not become evidence or authority: it
   * only permits a bounded search query after source, target and confidence
   * validation. Retrieved pages still need independent subject, intent and
   * multi-source evidence checks.
   */
  entityAliases?: WebSearchEntityAlias[];
}

export interface WebSearchEntityAlias {
  source: string;
  target: string;
  confidence: number;
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
  },
  {
    query: /(新闻|动态|消息|资讯|news)/i,
    evidence: /(新闻|动态|消息|资讯|报道|宣布|发布|回应|采访|声明|news|reported?|announc(?:e|ed|ement)|statement|interview|\b20\d{2}[-/.年]\d{1,2})/i
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
  if (/(新闻|动态|消息|资讯|news)/i.test(prompt)) {
    // A static biography or a navigation heading containing “latest news” is
    // not a current event. Require both an event assertion and an inspectable
    // date/freshness marker before allowing the page to ground a news answer.
    if (!hasConcreteNewsFact(body)) return false;
  }

  return hasStrongSearchSubjectMatch(prompt, body);
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
  const now = options.now ?? new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const subject = extractSearchSubjectTokens(base).slice(0, 4).join(" ");
  const intent = inferEnglishSearchIntent(base);

  // Query diversification is deliberately domain-neutral. It does not know
  // vendor names; it extracts the subject and rewrites only the user's intent.
  // This is the deterministic first stage used before an optional AI recovery
  // planner, following the same bounded plan -> retrieve -> assess shape as
  // mature research agents.
  if (maxQueries > 1 && subject && isNewsSearchQuery(base) && /[\u3400-\u9fff]/u.test(base)) {
    // Regional Chinese indexes return materially fresher results when “消息”
    // is normalized to “新闻” and the current month is explicit. Keep this
    // domain-neutral and derive the date from the request clock so tests and
    // replayed conversations remain deterministic.
    candidates.push(`${subject} 最新新闻 ${year}年${month}月`);
  }
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

export function isWebRecoveryQueryAnchored(
  originalQuery: string,
  candidateQuery: string,
  entityAliases: WebSearchEntityAlias[] = []
): boolean {
  const original = normalizeSearchQuery(originalQuery).toLowerCase();
  const candidate = normalizeSearchQuery(candidateQuery).toLowerCase();
  if (candidate.length < 3) return false;
  if (hasStrongSearchSubjectMatch(original, candidate)) return true;
  const aliases = normalizeWebSearchEntityAliases(original, entityAliases);
  return aliases.some((alias) => hasStrongSearchSubjectMatch(alias.target, candidate)
    && matchesEvidenceIntent(original, candidate));
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
  let activeEntityAliases: WebSearchEntityAlias[] = [];
  const evidenceQueryFor = (itemQuery = ""): string => uniqueStrings([
    cleanQuery,
    itemQuery,
    ...activeEntityAliases.map((item) => item.target)
  ]).join("\n");

  const normalizePlannerResult = (
    proposed: string[] | WebSearchRecoveryPlan | null | undefined,
    maxQueries: number
  ): { queries: string[]; urls: string[]; entityAliases: WebSearchEntityAlias[] } => {
    const proposedQueries = Array.isArray(proposed) ? proposed : proposed?.queries || [];
    const proposedUrls = Array.isArray(proposed) ? [] : proposed?.urls || [];
    const proposedAliases = Array.isArray(proposed) ? [] : proposed?.entityAliases || [];
    const normalizedAliases = normalizeWebSearchEntityAliases(cleanQuery, proposedAliases);
    const aliases = [...activeEntityAliases];
    for (const alias of normalizedAliases) {
      const key = `${alias.source.toLowerCase()}\u0000${alias.target.toLowerCase()}`;
      if (!aliases.some((item) => `${item.source.toLowerCase()}\u0000${item.target.toLowerCase()}` === key)) aliases.push(alias);
    }
    const normalizedQueries = uniqueStrings(proposedQueries.map(normalizeSearchQuery))
      .filter((item) => !executedQueries.includes(item))
      .filter((item) => isWebRecoveryQueryAnchored(cleanQuery, item, aliases))
      .slice(0, maxQueries);
    const aliasQueries = normalizedQueries.filter((item) => !isWebRecoveryQueryAnchored(cleanQuery, item));
    activeEntityAliases = aliases.slice(0, 3);
    if (aliasQueries.length > 0) {
      const usedAliases = activeEntityAliases
        .filter((alias) => aliasQueries.some((item) => hasStrongSearchSubjectMatch(alias.target, item)))
        .map((alias) => `${alias.source}→${alias.target}`);
      if (usedAliases.length > 0) warnings.push(`Validated entity alias search: ${usedAliases.join(", ")}`);
    }
    return {
      queries: normalizedQueries,
      urls: normalizeRecoveryUrlCandidates(proposedUrls, maxQueries),
      entityAliases: normalizedAliases
    };
  };

  const plannerUrlItems = (urls: string[], phase: "initial" | "recovery") => urls
    .map((url): WebSearchItem & { query: string } => ({
      title: `Planned source for ${cleanQuery}`,
      url,
      source: domainLabel(url),
      snippet: `Proposed by the bounded ${phase} web planner; content still requires relevance and authority verification.`,
      query: evidenceQueryFor()
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
    const discovered = await discoverRelevantOfficialLinks(evidenceQueryFor(), next, request, maxResults);
    next = dedupeGroundingItems([...discovered, ...next]);
    return next;
  };

  // Research agents work better when query planning and the first retrieval
  // round overlap instead of waiting for a failed search before planning.
  // The deterministic path remains available if the model is unavailable.
  const firstSearchTask = searchQueries(queries);
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
  // Await only the planner here; deterministic and configured-provider
  // retrieval have already started. This lets the alias query begin without
  // waiting for a weak regional index to exhaust its timeout first.
  const initialPlanResult = await initialPlannerTask;
  let initialPlan: { queries: string[]; urls: string[]; entityAliases: WebSearchEntityAlias[] } = {
    queries: [],
    urls: [],
    entityAliases: []
  };
  if (initialPlanResult.error) {
    warnings.push(`Initial web query planner failed: ${initialPlanResult.error}`);
  } else if (initialPlanResult.proposed) {
    // Normalize the alias plan before selecting provider body text and ranking
    // candidates so an English-only page can be inspected for a Chinese entity
    // without weakening the final evidence gate.
    initialPlan = normalizePlannerResult(initialPlanResult.proposed, maxPlannerQueries);
  }
  if (initialPlan.queries.length > 0) executedQueries.push(...initialPlan.queries);
  const plannedSearchTask = initialPlan.queries.length > 0
    ? searchQueries(initialPlan.queries)
    : Promise.resolve([] as Array<WebSearchItem & { query: string }>);
  const [firstSearchCandidates, providerResult, initialSearchCandidates] = await Promise.all([
    firstSearchTask,
    providerTask,
    plannedSearchTask
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
        const selected = selectRelevantReadableText(readable, evidenceQueryFor(), maxPageChars);
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
        query: evidenceQueryFor()
      });
    } catch {
      rejectedProviderItems += 1;
    }
  }
  if (providerResult.error) warnings.push(`Configured web provider failed: ${providerResult.error}`);
  if (rejectedProviderItems > 0) warnings.push(`Configured web provider returned ${rejectedProviderItems} unsafe or invalid URL(s); they were ignored.`);
  let candidates = dedupeGroundingItems([...providerCandidates, ...firstSearchCandidates, ...initialSearchCandidates]);
  if (initialPlan.queries.length > 0 || initialPlan.urls.length > 0) {
    candidates = dedupeGroundingItems([
      ...plannerUrlItems(initialPlan.urls, "initial"),
      ...candidates
    ]);
  }

  // If generic search only surfaced a matching vendor home page, derive one
  // bounded site query from that page. This is entity/domain discovery rather
  // than a vendor allow-list, so it works for new providers without code
  // changes and keeps the original subject anchored in the query.
  const siteRecoveryQueries = planOfficialSiteRecoveryQueries(evidenceQueryFor(), candidates, 1)
    .filter((item) => !executedQueries.includes(item));
  if (siteRecoveryQueries.length > 0) {
    executedQueries.push(...siteRecoveryQueries);
    candidates = dedupeGroundingItems([...candidates, ...await searchQueries(siteRecoveryQueries)]);
  }

  candidates = await enrichCandidates(candidates);
  // Query planning and retrieval are complementary. A planner can translate an
  // entity correctly while the regional index still returns only profiles or
  // topic archives. Run one bounded reader rescue whenever the candidates do
  // not yet contain usable evidence; do not disable it merely because an AI
  // planner exists.
  if (needsReaderSearch(evidenceQueryFor(), candidates)) {
    const readerQuery = [...executedQueries].reverse().find((item) => /[A-Za-z]/u.test(item)) || executedQueries[0] || cleanQuery;
    const readerUrl = isNewsSearchQuery(evidenceQueryFor())
      ? `https://r.jina.ai/http://www.bing.com/news/search?q=${encodeURIComponent(readerQuery)}&qft=sortbydate%3d%221%22`
      : `https://r.jina.ai/http://www.bing.com/search?q=${encodeURIComponent(readerQuery)}`;
    const readerItems = (await requestSearchItems(readerUrl, request, maxResults))
      .map((item) => ({ ...item, query: readerQuery }));
    candidates = dedupeGroundingItems([...readerItems, ...candidates]);
  }
  const maxFetchPerRound = Math.min(
    6,
    fetchTopPages + (options.initialQueryPlanner || options.recoveryQueryPlanner ? 1 : 0)
  );
  const materialize = async (): Promise<WebSearchGrounding> => {
    const ranked = rankSearchItems(candidates, evidenceQueryFor()).slice(0, maxResults);
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
          content: await fetchSearchResultEvidence(item, evidenceQueryFor(item.query), request, maxPageChars),
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
      const evidenceQuery = evidenceQueryFor(item.query);
      const evidenceTier = classifyWebEvidenceTier(evidenceQuery, item, fetched);
      return {
        ...item,
        content,
        fetched,
        evidenceTier,
        relevanceScore: webEvidenceRelevanceScore(evidenceQuery, `${item.title}\n${item.url}\n${item.snippet}\n${content}`, fetched)
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
  const stop = /^(?:ai|api|sdk|web|online|internet|latest|current|today|recent|official|price|pricing|cost|billing|version|release|news|search|look|up|documentation|docs?|site)$/iu;
  const latin = (query.match(/[A-Za-z][A-Za-z0-9._+/#-]{1,}/g) ?? [])
    .map((token) => token.trim())
    .filter((token) => !stop.test(token));
  return uniqueStrings([...latin, ...extractHanSearchSubjectPhrases(query)]);
}

function normalizeWebSearchEntityAliases(
  originalQuery: string,
  aliases: WebSearchEntityAlias[] | null | undefined
): WebSearchEntityAlias[] {
  const original = normalizeSearchQuery(originalQuery);
  const originalLower = original.toLowerCase();
  const originalSubjects = new Set(extractSearchSubjectTokens(original).map((item) => item.toLowerCase()));
  const normalized: WebSearchEntityAlias[] = [];
  for (const candidate of Array.isArray(aliases) ? aliases : []) {
    const source = normalizeSearchQuery(String(candidate?.source || "")).trim();
    const target = normalizeSearchQuery(String(candidate?.target || "")).trim();
    const confidence = Number(candidate?.confidence);
    const sourceLower = source.toLowerCase();
    if (!source || !target || !Number.isFinite(confidence) || confidence < 0.88 || confidence > 1) continue;
    // The source must be the complete subject label extracted from the user's
    // own query. A planner cannot authorize an alias for an entity the user
    // never mentioned.
    if (!originalLower.includes(sourceLower) || !originalSubjects.has(sourceLower)) continue;
    // Alias expansion exists for indices that work better with Latin entity
    // names. Query operators, URLs and sentence-like targets are rejected.
    if (!/[A-Za-z]/u.test(target)
      || target.length > 80
      || /(?:https?:\/\/|\b(?:site|file|url|inurl|intitle):|[\r\n<>"'`])/iu.test(target)) continue;
    const targetSubjects = extractSearchSubjectTokens(target);
    if (targetSubjects.length === 0 || targetSubjects.length > 8) continue;
    const key = `${sourceLower}\u0000${target.toLowerCase()}`;
    if (normalized.some((item) => `${item.source.toLowerCase()}\u0000${item.target.toLowerCase()}` === key)) continue;
    normalized.push({ source, target, confidence });
    if (normalized.length >= 3) break;
  }
  return normalized;
}

/**
 * Keep Chinese entities as complete phrases. Generating arbitrary Han n-grams
 * made “马斯克” collapse into “马” and admitted horse encyclopaedias as person
 * news. This deliberately strips only command/intent shells and never guesses
 * a dictionary segmentation inside the remaining entity phrase.
 */
function extractHanSearchSubjectPhrases(query: string): string[] {
  const source = sanitizeSearchPrompt(query)
    .replace(WEB_SEARCH_CLEAN_RE, " ")
    .replace(/[A-Za-z][A-Za-z0-9._+/#-]*/gu, " ")
    .replace(/\b20\d{2}\b/gu, " ")
    .replace(/[：:？?。；;，,、()（）\[\]【】]/gu, " ");
  const generic = /^(?:官网|官方网站|官方|最新|当前|现在|近期|最近|今日|今天|本周|本月|今年|刚刚|实时|现任|新闻|消息|动态|资讯|资料|信息|内容|规则|价格|费用|版本|发布|更新|文档|政策|法规|标准|论文|研究)$/u;
  const suffix = /(?:最新|当前|现在|近期|最近|今日|今天|本周|本月|今年|刚刚|实时|现任)?(?:的)?(?:官网|官方网站|官方消息|新闻|消息|动态|资讯|计价规则|定价规则|收费规则|价格|费用|成本|版本|发布信息|发布|更新|变更|文档|资料|信息|内容|规则|政策|法规|标准|论文)(?:是什么|有哪些|怎么样|如何)?$/u;
  const prefix = /^(?:请|帮我|麻烦|能不能|可以|是否可以|我想|我要|给我|替我|查|查查|查询|检索|搜索|搜|看看|看一下|了解一下|核实一下)+/u;
  return uniqueStrings((source.match(/[\u3400-\u9fff]{2,}/gu) ?? [])
    .map((run) => run
      .replace(prefix, "")
      .replace(/^(?:最新|当前|现在|近期|最近)(?:的)?(?:新闻|消息|动态|资讯)/u, "")
      .replace(suffix, "")
      .replace(/^(?:的)+|(?:是什么|有哪些|怎么样|如何|一下|吗|呢|的)+$/gu, "")
      .trim())
    .filter((item) => item.length >= 2 && !generic.test(item)));
}

function hasStrongSearchSubjectMatch(query: string, evidence: string): boolean {
  const subjects = extractSearchSubjectTokens(query);
  if (subjects.length === 0) return true;
  const haystack = String(evidence || "").toLowerCase();
  const latin = subjects.filter((item) => /[A-Za-z]/u.test(item)).map((item) => item.toLowerCase());
  const han = subjects.filter((item) => /[\u3400-\u9fff]/u.test(item)).map((item) => item.toLowerCase());
  const latinMatch = latin.length > 0 && latin.every((item) => containsSearchToken(haystack, item));
  const hanMatch = han.length > 0 && han.some((item) => haystack.includes(item));
  return latinMatch || hanMatch;
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
  const subjects = extractSearchSubjectTokens(query);
  if (subjects.length === 0 || hasStrongSearchSubjectMatch(query, evidence)) score += 0.16;
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
  const strongSubjectMatch = subjectTokens.length === 0 || hasStrongSearchSubjectMatch(query, haystack);
  if (strongSubjectMatch && subjectTokens.length > 0) score += 6;
  if (!strongSubjectMatch) score -= 8;
  if (item.snippet.trim().length >= 40) score += 1;
  if (isNewsSearchQuery(query)) score += newsFreshnessScore(item);
  return score;
}

function newsFreshnessScore(item: WebSearchItem): number {
  const text = `${item.publishedAt || ""} ${item.snippet || ""}`.toLowerCase();
  if (/\b(?:\d+\s*(?:minutes?|hours?)\s+ago|today|just now)\b/iu.test(text)) return 5;
  if (/(?:\d+\s*(?:分钟|小时)前|今天|刚刚)/u.test(text)) return 5;
  const days = text.match(/\b(\d+)\s*days?\s+ago\b/iu);
  if (days) return Number.parseInt(days[1], 10) <= 7 ? 4 : 2;
  const chineseDays = text.match(/(\d+)\s*天前/u);
  if (chineseDays) return Number.parseInt(chineseDays[1], 10) <= 7 ? 4 : 2;
  const weeks = text.match(/\b(\d+)\s*weeks?\s+ago\b/iu);
  if (weeks) return Number.parseInt(weeks[1], 10) <= 2 ? 3 : 1;
  const chineseWeeks = text.match(/(\d+)\s*周前/u);
  if (chineseWeeks) return Number.parseInt(chineseWeeks[1], 10) <= 2 ? 3 : 1;
  if (/\b\d+\s*months?\s+ago\b/iu.test(text) || /\d+\s*个月前/u.test(text)) return 0;
  const dated = text.match(/(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])/u);
  if (dated) {
    const timestamp = Date.parse(`${dated[1]}-${dated[2].padStart(2, "0")}-${dated[3].padStart(2, "0")}T00:00:00Z`);
    if (Number.isFinite(timestamp)) {
      const ageDays = Math.floor((Date.now() - timestamp) / 86_400_000);
      if (ageDays <= 1) return 6;
      if (ageDays <= 7) return 5;
      if (ageDays <= 30) return 3;
      if (ageDays <= 90) return 1;
      if (ageDays > 365) return -3;
    }
  }
  return 0;
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
  if (/[\u3400-\u9fff]/u.test(cleanToken)) return String(haystack || "").toLowerCase().includes(cleanToken);
  const escaped = cleanToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "iu").test(String(haystack || "").toLowerCase());
}

async function searchWebResults(query: string, request: WebContextRequest, maxResults: number): Promise<WebSearchItem[]> {
  const englishLocale = shouldUseEnglishSearchLocale(query);
  const directBing = englishLocale
    ? `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=en-US&setlang=en-US&cc=US`
    : `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&setlang=zh-CN`;
  const duckDuckGo = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=${englishLocale ? "us-en" : "cn-zh"}`;
  const braveSearch = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
  const qihooSearch = `https://www.so.com/s?q=${encodeURIComponent(query)}`;
  const bingNews = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&mkt=${englishLocale ? "en-US" : "zh-CN"}&setlang=${englishLocale ? "en-US" : "zh-CN"}`;
  const bingWebRss = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}&mkt=${englishLocale ? "en-US" : "zh-CN"}&setlang=${englishLocale ? "en-US" : "zh-CN"}`;
  // Do not short-circuit after the first non-empty engine. A search page can be
  // syntactically valid while all results are off-topic. Running providers in
  // parallel keeps latency bounded and makes ranking resilient to one engine's
  // transient ordering or regional index.
  const providerLimit = Math.max(maxResults, Math.min(maxResults * 2, 16));
  const [bingItems, duckItems, braveItems, qihooItems, newsItems, webRssItems] = await Promise.all([
    requestSearchItems(directBing, request, providerLimit),
    requestSearchItems(duckDuckGo, request, providerLimit),
    englishLocale
      ? requestSearchItems(braveSearch, request, providerLimit)
      : Promise.resolve([] as WebSearchItem[]),
    /[\u3400-\u9fff]/u.test(query)
      ? requestSearchItems(qihooSearch, request, providerLimit)
      : Promise.resolve([] as WebSearchItem[]),
    isNewsSearchQuery(query)
      ? requestSearchItems(bingNews, request, providerLimit)
      : Promise.resolve([] as WebSearchItem[]),
    isNewsSearchQuery(query)
      ? requestSearchItems(bingWebRss, request, providerLimit)
      : Promise.resolve([] as WebSearchItem[])
  ]);
  // Bing's generic RSS endpoint can be regionally redirected and occasionally
  // tokenizes Latin names into unrelated results. Keep it only as a candidate
  // source when the complete subject survives in the returned card.
  const subjectMatchedWebRss = webRssItems.filter((item) => hasStrongSearchSubjectMatch(
    query,
    `${item.title} ${item.url} ${item.snippet}`
  ));
  return rankSearchItems(
    dedupeSearchItems([...newsItems, ...qihooItems, ...subjectMatchedWebRss, ...braveItems, ...bingItems, ...duckItems]),
    query
  ).slice(0, Math.min(maxResults * 3, 24));
}

function isNewsSearchQuery(query: string): boolean {
  return /(?:新闻|动态|消息|资讯|news)/iu.test(query);
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
    const subjectTokens = extractSearchSubjectTokens(query)
      .filter((token) => /[A-Za-z]/u.test(token))
      .map((token) => token.toLowerCase());
    if (subjectTokens.length === 0) return false;
    const hostHit = subjectTokens.some((token) => labels.includes(token));
    const urlText = `${hostname} ${parsed.pathname}`.toLowerCase();
    return hostHit && subjectTokens.every((token) => containsSearchToken(urlText, token) || pathTokens.includes(token));
  } catch {
    return false;
  }
}

function hasSubjectHostAffinity(query: string, url: string): boolean {
  try {
    const family = siteFamilyDomain(url);
    if (!family) return false;
    const labels = family.toLowerCase().split(".");
    const subjectTokens = extractSearchSubjectTokens(query)
      .filter((token) => /[A-Za-z]/u.test(token))
      .map((token) => token.toLowerCase());
    if (subjectTokens.length === 0) return false;
    const hostHits = subjectTokens.filter((token) => labels.includes(token));
    if (subjectTokens.length === 1) return hostHits.length === 1;
    const urlText = new URL(url).href.toLowerCase();
    return hostHits.length >= 1 && subjectTokens.every((token) => containsSearchToken(urlText, token));
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
    const isBingRss = url.includes("bing.com/") && /[?&]format=rss(?:&|$)/iu.test(url);
    const headers = isBingRss
      ? {
        ...DEFAULT_HEADERS,
        // Bing returns its generic HTML homepage when a full browser UA asks
        // for the RSS URL. A minimal standards-compatible UA plus an explicit
        // XML Accept header consistently returns the documented feed.
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5",
        "Accept-Language": url.includes("mkt=en-US") ? "en-US,en;q=0.9" : "zh-CN,zh;q=0.9"
      }
      : url.includes("mkt=en-US")
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
  if (isNewsSearchQuery(query)) {
    const currentNews = relevant.filter((item) => hasStrongSearchSubjectMatch(
      query,
      `${item.title} ${item.url} ${item.snippet}`
    ) && hasConcreteNewsFact(`${item.publishedAt || ""}\n${item.title}\n${item.snippet}`));
    return currentNews.length < 2;
  }
  return AUTHORITATIVE_SEARCH_RE.test(query) && !relevant.some((item) => isLikelyAuthoritativeResult(query, item));
}

function matchesEvidenceIntent(query: string, evidence: string): boolean {
  return WEB_EVIDENCE_INTENT_GROUPS.every((group) => !group.query.test(query) || group.evidence.test(evidence));
}

function isLikelyAuthoritativeResult(query: string, item: WebSearchItem): boolean {
  try {
    const hostname = new URL(item.url).hostname.toLowerCase();
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

function hasConcreteNewsFact(body: string): boolean {
  const text = String(body || "").replace(/\s+/gu, " ").trim();
  if (!text) return false;
  const event = /(?:宣布|发布|回应|表示|确认|推出|任命|收购|完成|发生|获得|计划|起诉|批准|签署|警告|承认|投资|呼吁|接受采访|据.{0,12}报道|announc(?:e|ed|ement)|report(?:s|ed|ing)?|said|says|confirm(?:s|ed)?|launch(?:es|ed)?|releas(?:e|ed)|appoint(?:s|ed)?|acquir(?:e|ed)|complet(?:e|ed)|filed|approv(?:e|ed)|signed|interview|plans?|warn(?:s|ed)?|admit(?:s|ted)?|invest(?:s|ed)?|bought|buys?|calls?|urges?|joins?|leaves?|resigns?|cuts?|raises?|drops?|will\s+[a-z])/iu;
  const dated = /(?:\b20\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])\b|\b(?:mon|tue|wed|thu|fri|sat|sun),?\s+\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+20\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+20\d{2}\b|20\d{2}年(?:0?[1-9]|1[0-2])月(?:0?[1-9]|[12]\d|3[01])日|今天|今日|昨天|昨日|刚刚|\d+\s*(?:分钟|小时|天|周|个月)前|today|yesterday|just\s+now|a\s+few\s+seconds\s+ago|\d+\s*(?:minutes?|hours?|days?|weeks?|months?)\s+ago)/iu;
  return event.test(text) && dated.test(text);
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
  if (sourceUrl.includes("bing.com/") && /<(?:rss|channel)\b/iu.test(html)) {
    return parseBingNewsRss(html, sourceUrl);
  }
  if (sourceUrl.startsWith("https://r.jina.ai/http://www.bing.com/news/search")) {
    return parseReaderNewsResults(html, sourceUrl);
  }
  if (sourceUrl.startsWith("https://r.jina.ai/http://www.bing.com/search")) {
    return parseReaderSearchResults(html, sourceUrl);
  }
  if (sourceUrl.includes("www.so.com/s")) return parseQihooSearchResults(html, sourceUrl);
  if (sourceUrl.includes("search.brave.com/search")) return parseBraveSearchResults(html, sourceUrl);
  if (sourceUrl.includes("duckduckgo.com")) return parseDuckDuckGoResults(html, sourceUrl);
  return parseBingResults(html, sourceUrl);
}

function parseBraveSearchResults(html: string, sourceUrl: string): WebSearchItem[] {
  const items: WebSearchItem[] = [];
  const starts = Array.from(String(html || "").matchAll(
    /<div\b(?=[^>]*\bdata-type=["']web["'])(?=[^>]*\bclass=["'][^"']*\bsnippet\b[^"']*["'])[^>]*>/giu
  ));
  for (const [index, startMatch] of starts.entries()) {
    const start = startMatch.index ?? 0;
    const end = index + 1 < starts.length ? (starts[index + 1].index ?? html.length) : html.length;
    const block = html.slice(start, end);
    const anchors = Array.from(block.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu));
    const headline = anchors.find((match) => /\bclass=["'][^"']*\bl1\b[^"']*["']/iu.test(match[1]))
      || anchors.find((match) => /\bclass=["'][^"']*(?:result-header|result-title)[^"']*["']/iu.test(match[1]));
    if (!headline) continue;
    const href = headline[1].match(/\bhref=["']([^"']+)["']/iu)?.[1] || "";
    const url = resolveSearchUrl(decodeEntities(href), sourceUrl);
    const titleAttr = headline[2].match(/\btitle=["']([^"']+)["']/iu)?.[1]
      || block.match(/<div\b[^>]*\bclass=["'][^"']*\btitle\b[^"']*["'][^>]*\btitle=["']([^"']+)["']/iu)?.[1]
      || "";
    const title = htmlToReadableText(titleAttr || headline[2]).slice(0, 240);
    const contentMatch = block.match(/<div\b[^>]*\bclass=["'][^"']*\bcontent\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu)
      || block.match(/<div\b[^>]*\bclass=["'][^"']*\bgeneric-snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu);
    const snippet = contentMatch ? htmlToReadableText(contentMatch[1]).slice(0, 720) : "";
    const publishedAt = extractRelativePublishedAt(`${snippet} ${block}`);
    if (isUsableSearchResult(url, title)) {
      items.push({ title, url, source: domainLabel(url), snippet, publishedAt: publishedAt || undefined });
    }
  }
  return items;
}

function extractRelativePublishedAt(text: string): string {
  const normalized = htmlToReadableText(String(text || ""));
  const english = normalized.match(/\b(\d+)\s*(minutes?|hours?|days?|weeks?|months?)\s+ago\b/iu);
  if (english) {
    const amount = Math.max(0, Number.parseInt(english[1], 10) || 0);
    const rawUnit = english[2].toLowerCase();
    const singular = rawUnit.replace(/s$/u, "");
    return `${amount} ${amount === 1 ? singular : `${singular}s`} ago`;
  }
  const chinese = normalized.match(/(\d+)\s*(分钟|小时|天|周|个月)前/u);
  if (chinese) return `${chinese[1]}${chinese[2]}前`;
  // Chinese date characters are not JavaScript `\w` characters, therefore a
  // trailing `\b` after “日” fails when the next character is whitespace or
  // punctuation. Match the complete date directly instead.
  const absoluteChinese = normalized.match(/(20\d{2})年(0?[1-9]|1[0-2])月(0?[1-9]|[12]\d|3[01])日/u);
  if (!absoluteChinese) return "";
  return `${absoluteChinese[1]}-${absoluteChinese[2].padStart(2, "0")}-${absoluteChinese[3].padStart(2, "0")}`;
}

function parseQihooSearchResults(html: string, sourceUrl: string): WebSearchItem[] {
  const items: WebSearchItem[] = [];
  const starts = Array.from(String(html || "").matchAll(/<li\b[^>]*\bclass=["'][^"']*\bres-list\b[^"']*["'][^>]*>/giu));
  for (const [index, startMatch] of starts.entries()) {
    const start = startMatch.index ?? 0;
    const end = index + 1 < starts.length ? (starts[index + 1].index ?? html.length) : html.length;
    const block = html.slice(start, end);
    const heading = block.match(/<h3\b[^>]*\bclass=["'][^"']*\bres-title\b[^"']*["'][^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>/iu);
    if (!heading) continue;
    const attributes = heading[1];
    const directUrl = attributes.match(/\bdata-mdurl=["']([^"']+)["']/iu)?.[1]
      || attributes.match(/\bhref=["']([^"']+)["']/iu)?.[1]
      || "";
    const url = resolveSearchUrl(decodeEntities(directUrl), sourceUrl);
    const title = htmlToReadableText(heading[2]).slice(0, 240);
    const descriptionMatch = block.match(/<p\b[^>]*\bclass=["'][^"']*\bres-desc\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/iu)
      || block.match(/<span\b[^>]*\bclass=["'][^"']*\bres-list-summary\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/iu);
    const snippet = descriptionMatch ? htmlToReadableText(descriptionMatch[1]).slice(0, 720) : "";
    const publishedAt = extractRelativePublishedAt(`${snippet} ${block}`);
    if (isUsableSearchResult(url, title)) {
      items.push({ title, url, source: domainLabel(url), snippet, publishedAt: publishedAt || undefined });
    }
  }
  return items;
}

function parseBingNewsRss(xml: string, sourceUrl: string): WebSearchItem[] {
  const items: WebSearchItem[] = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/giu;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = xmlElementText(block, "title").slice(0, 240);
    const rawLink = xmlElementText(block, "link") || xmlElementText(block, "guid");
    const url = resolveSearchUrl(rawLink, sourceUrl);
    const description = htmlToReadableText(xmlElementText(block, "description")).slice(0, 420);
    const sourceName = xmlElementText(block, "source").slice(0, 120);
    const rawPublishedAt = xmlElementText(block, "pubDate").slice(0, 120);
    const parsedDate = Date.parse(rawPublishedAt);
    const publishedAt = Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : rawPublishedAt;
    const snippet = [
      publishedAt ? `Published: ${publishedAt}` : "",
      sourceName ? `Publisher: ${sourceName}` : "",
      description
    ].filter(Boolean).join(" | ").slice(0, 720);
    if (isUsableSearchResult(url, title)) {
      items.push({ title, url, source: domainLabel(url), snippet, publishedAt: publishedAt || undefined });
    }
  }
  return items;
}

function parseReaderNewsResults(markdown: string, sourceUrl: string): WebSearchItem[] {
  const items: WebSearchItem[] = [];
  const headingRegex = /(?:^|\n)##\s+\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s*/gu;
  const matches = Array.from(String(markdown || "").matchAll(headingRegex));
  for (const [index, match] of matches.entries()) {
    const title = markdownToPlainText(match[1]).slice(0, 240);
    const url = resolveSearchUrl(decodeEntities(match[2]), sourceUrl);
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? markdown.length) : markdown.length;
    const after = markdown.slice(start, end).split(/\n\s*\[!\[Image|\n\s*!\[Image/iu)[0];
    const description = markdownToPlainText(after).slice(0, 420);
    const before = markdown.slice(Math.max(0, (match.index ?? 0) - 180), match.index ?? 0);
    const relativeMatches = Array.from(before.matchAll(/(?:^|\n)\s*(\d+)\s*(m|h|d)(?:\s+on\s+MSN)?\s*(?=\n|$)/giu));
    const relative = relativeMatches[relativeMatches.length - 1];
    const publishedAt = relative ? relativeFreshnessText(relative[1], relative[2]) : "";
    const snippet = [publishedAt ? `Published: ${publishedAt}` : "", description].filter(Boolean).join(" | ");
    if (isUsableSearchResult(url, title)) {
      items.push({ title, url, source: domainLabel(url), snippet, publishedAt: publishedAt || undefined });
    }
  }
  return items;
}

function relativeFreshnessText(amount: string, unit: string): string {
  const value = Math.max(0, Number.parseInt(amount, 10) || 0);
  if (unit.toLowerCase() === "m") return `${value} minutes ago`;
  if (unit.toLowerCase() === "h") return `${value} hours ago`;
  return `${value} days ago`;
}

function xmlElementText(block: string, tagName: string): string {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = String(block || "").match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "iu"));
  if (!match) return "";
  return decodeEntities(match[1]
    .replace(/^\s*<!\[CDATA\[/u, "")
    .replace(/\]\]>\s*$/u, ""))
    .trim();
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
    if (/bing\.com|duckduckgo\.com|search\.brave\.com/i.test(parsed.hostname) && /\/search|\/html/i.test(parsed.pathname)) return false;
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
    .replace(/&nbsp;/gi, " ")
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
