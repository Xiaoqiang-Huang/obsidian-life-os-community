import type { WebContextRequest, WebContextResponse, WebSearchItem } from "./WebContextService";

type Provider = "exa" | "parallel";
type RecordValue = Record<string, unknown>;
interface SearchState {
  cooldownUntil: number;
  standbyUntil: number;
  cache: Map<string, { until: number; items: WebSearchItem[] }>;
  queue: Promise<unknown>;
}
const sharedState: SearchState = { cooldownUntil: 0, standbyUntil: 0, cache: new Map(), queue: Promise.resolve() };
const ENDPOINTS: Record<Provider, string> = {
  exa: "https://mcp.exa.ai/mcp",
  parallel: "https://search.parallel.ai/mcp"
};
const PROTOCOLS = ["2025-03-26", "2025-06-18", "2024-11-05"];
const RATE_LIMIT_MESSAGE = "默认联网搜索暂时达到服务限额，请稍后重试；本轮未切换服务绕过限流。";

export class AnonymousSearchError extends Error {
  constructor(message: string, readonly kind: "unavailable" | "limited" = "unavailable") { super(message); }
}

/** Fixed, search-only anonymous MCP client. Never accepts a model-supplied endpoint or tool. */
export class AnonymousSearchMcpService {
  private nextId = 1;
  private connections = new Map<Provider, { session: string; protocol: string }>();
  private state: SearchState;
  private clock: () => number;
  private timeoutMs: number;
  private acceptUrl: (url: string) => boolean;

  constructor(private request: WebContextRequest, options: {
    isolated?: boolean; now?: () => number; timeoutMs?: number; acceptUrl?: (url: string) => boolean;
  } = {}) {
    this.state = options.isolated ? { cooldownUntil: 0, standbyUntil: 0, cache: new Map(), queue: Promise.resolve() } : sharedState;
    this.clock = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 18_000;
    this.acceptUrl = options.acceptUrl ?? (() => true);
  }

  search(query: string, maxResults: number): Promise<WebSearchItem[]> {
    const text = String(query || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (text.length < 2) return Promise.resolve([]);
    const limit = Math.max(1, Math.min(Math.floor(maxResults) || 5, 8));
    // Serialize a turn's deterministic and AI-planned queries. No parallel provider fan-out.
    const task = this.state.queue.then(() => this.searchSerial(text, limit));
    this.state.queue = task.catch(() => undefined);
    return task;
  }

  private async searchSerial(query: string, limit: number): Promise<WebSearchItem[]> {
    const key = `${limit}:${query}`;
    const cached = this.state.cache.get(key);
    if (cached && cached.until > this.clock()) {
      const items = cached.items.filter(item => this.acceptUrl(item.url));
      if (items.length) return items.map(item => ({ ...item }));
    }
    if (this.state.cooldownUntil > this.clock()) throw new AnonymousSearchError(RATE_LIMIT_MESSAGE, "limited");
    const providers: Provider[] = this.state.standbyUntil > this.clock() ? ["parallel"] : ["exa", "parallel"];
    for (const provider of providers) {
      try {
        const items = (await this.searchProvider(provider, query, limit)).filter(item => this.acceptUrl(item.url));
        if (!items.length) { if (provider === "exa") this.state.standbyUntil = this.clock() + 30_000; continue; }
        for (const [entry, value] of this.state.cache) if (value.until <= this.clock()) this.state.cache.delete(entry);
        if (this.state.cache.size >= 64) this.state.cache.delete(this.state.cache.keys().next().value!);
        this.state.cache.set(key, { until: this.clock() + 300_000, items });
        return items.map(item => ({ ...item }));
      } catch (error) {
        this.connections.delete(provider);
        if (error instanceof AnonymousSearchError && error.kind === "limited") throw error;
        if (provider === "exa") this.state.standbyUntil = this.clock() + 30_000;
      }
    }
    throw new AnonymousSearchError("默认联网搜索暂时不可用或没有可核验结果，可稍后重试或直接提供网页链接。");
  }

  private async searchProvider(provider: Provider, query: string, limit: number): Promise<WebSearchItem[]> {
    const deadline = Date.now() + this.timeoutMs;
    if (!this.connections.has(provider)) {
      const init = await this.rpc(provider, "initialize", {
        protocolVersion: PROTOCOLS[0], capabilities: {}, clientInfo: { name: "Life OS Assistant", version: "1" }
      }, deadline);
      const protocol = String(init.result.protocolVersion || "");
      if (!PROTOCOLS.includes(protocol)) throw new AnonymousSearchError("搜索服务协议版本不兼容。");
      this.connections.set(provider, { protocol, session: header(init.response, "mcp-session-id").slice(0, 256) });
      await this.rpc(provider, "notifications/initialized", undefined, deadline, true);
    }
    const response = await this.rpc(provider, "tools/call", {
      name: provider === "exa" ? "web_search_exa" : "web_search",
      arguments: provider === "exa"
        ? { query, numResults: limit, objective: query }
        : { objective: query, search_queries: [query] }
    }, deadline);
    const result = response.result;
    if (result.isError) {
      if (isLimitError(JSON.stringify(result))) this.limit(response.response);
      throw new AnonymousSearchError("搜索服务未能返回有效结果。");
    }
    return parseSearchItems(result, provider, limit);
  }

  private async rpc(provider: Provider, method: string, params: unknown, deadline: number, notification = false): Promise<{
    result: RecordValue; response: WebContextResponse;
  }> {
    const id = this.nextId++;
    const connection = this.connections.get(provider);
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (connection) {
      headers["MCP-Protocol-Version"] = connection.protocol;
      if (connection.session) headers["Mcp-Session-Id"] = connection.session;
    }
    const body = JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, ...(params === undefined ? {} : { params }) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = await Promise.race([
      this.request(ENDPOINTS[provider], { method: "POST", headers, body }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AnonymousSearchError("搜索服务连接超时。")), Math.max(1, deadline - Date.now())); })
    ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
    if (response.status === 429) this.limit(response);
    if (response.status && (response.status < 200 || response.status >= 300)) throw new AnonymousSearchError("搜索服务连接不可用。");
    if (notification) return { result: {}, response };
    if (response.text.length > 2_000_000) throw new AnonymousSearchError("搜索服务响应过大。");
    const envelope = parseRpcResponse(response.text, id);
    if (envelope.error) {
      if (isLimitError(JSON.stringify(envelope.error))) this.limit(response);
      throw new AnonymousSearchError("搜索服务协议错误。");
    }
    const result = record(envelope.result);
    if (!result) throw new AnonymousSearchError("搜索服务响应格式无效。");
    return { result, response };
  }

  private limit(response: WebContextResponse): never {
    const retry = header(response, "retry-after");
    const seconds = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : NaN;
    const until = Number.isFinite(seconds) ? this.clock() + seconds * 1000 : Date.parse(retry);
    this.state.cooldownUntil = Math.max(this.state.cooldownUntil, this.clock() + 60_000, Number.isFinite(until) ? until : 0);
    throw new AnonymousSearchError(RATE_LIMIT_MESSAGE, "limited");
  }
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}
function header(response: WebContextResponse, name: string): string {
  return String(Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === name)?.[1] || "");
}
function isLimitError(text: string): boolean { return /rate.?limit|too many requests|quota|resource.exhausted|\b429\b|限流|限额/i.test(text); }

function parseRpcResponse(text: string, id: number): RecordValue {
  const messages: unknown[] = [];
  if (text.trimStart().startsWith("{")) messages.push(JSON.parse(text));
  else {
    for (const event of text.replace(/\r\n/g, "\n").split(/\n\n+/)) {
      const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (data && data !== "[DONE]") { try { messages.push(JSON.parse(data)); } catch { /* unrelated SSE event */ } }
    }
  }
  const message = messages.map(record).find(item => item?.jsonrpc === "2.0" && item.id === id);
  if (!message) throw new AnonymousSearchError("搜索服务没有返回匹配的响应。");
  return message;
}

function parseSearchItems(result: RecordValue, provider: Provider, limit: number): WebSearchItem[] {
  const texts = Array.isArray(result.content) ? result.content.map(record).filter(item => item?.type === "text").map(item => String(item?.text || "")) : [];
  let structured = record(result.structuredContent);
  if (!structured) for (const text of texts) { try { structured = record(JSON.parse(text)); if (structured) break; } catch { /* Exa text format */ } }
  const candidates: Array<{ title: string; url: string; snippet: string; publishedAt?: string }> = [];
  if (Array.isArray(structured?.results)) {
    for (const value of structured.results.slice(0, 32)) {
      const item = record(value);
      if (!item) continue;
      candidates.push({ title: String(item.title || item.url || ""), url: String(item.url || ""), publishedAt: String(item.publish_date || item.publishedDate || ""),
        snippet: Array.isArray(item.excerpts) ? item.excerpts.filter(x => typeof x === "string").join("\n") : String(item.text || item.content || item.snippet || "") });
    }
  } else if (provider === "exa") {
    for (const block of texts.join("\n").replace(/\r\n/g, "\n").split(/(?=^Title:)/m).slice(0, 32)) {
      const url = block.match(/^URL:\s*(\S+)/m)?.[1];
      if (url) candidates.push({ title: block.match(/^Title:\s*(.+)$/m)?.[1] || url, url, publishedAt: block.match(/^Published:\s*(.+)$/m)?.[1],
        snippet: block.replace(/^[\s\S]*?^(?:Highlights|Text|Content):\s*/m, "").replace(/\n---\s*$/, "").trim() });
    }
  }
  const seen = new Set<string>(), items: WebSearchItem[] = [];
  for (const item of candidates) {
    try {
      const url = new URL(item.url); url.hash = "";
      // Retrieval applies the existing public-URL guard again before opening a page.
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
      seen.add(url.href);
      items.push({ title: item.title.slice(0, 240), url: url.href, source: provider, snippet: item.snippet.slice(0, 1200),
        ...(item.publishedAt && Number.isFinite(Date.parse(item.publishedAt)) ? { publishedAt: item.publishedAt.slice(0, 40) } : {}) });
      if (items.length >= limit) break;
    } catch { /* never return invalid links as evidence */ }
  }
  return items;
}
