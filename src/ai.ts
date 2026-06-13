import { Notice, Platform, requestUrl } from "obsidian";
import { PersonalLifeSystemSettings, getExamAssistantPrompt, getExamProfileLabel, normalizeAiApiKeyInput, validateAiProviderConfig, type AiReasoningEffort } from "./settings";
import { stripCodeFences } from "./utils";

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: AiMessageContent;
}

export interface AiTextContentPart {
  type: "text";
  text: string;
}

export interface AiImageUrlContentPart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export type AiMessageContent = string | Array<AiTextContentPart | AiImageUrlContentPart>;

export interface AiRequest {
  messages: AiMessage[];
  temperature?: number;
  responseFormat?: "text" | "json";
  model?: string;
  reasoningEffort?: AiReasoningEffort;
}

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimated?: boolean;
}

export interface AiResponse {
  ok: boolean;
  text?: string;
  error?: string;
  usage?: AiUsage;
}

export interface AiStreamCallbacks {
  onStart?(): void;
  onToken?(token: string): void;
  onDone?(text: string): void;
  onError?(error: string): void;
  onAbort?(): void;
}

type AiMode = "openai" | "anthropic";
const AI_GENERATED_FOOTER = "AI生成";

export function appendAiGeneratedFooter(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (/(^|\n)AI生成\s*$/u.test(trimmed)) return trimmed;
  return `${trimmed}\n\n${AI_GENERATED_FOOTER}`;
}

function finalizeTextResponse(request: AiRequest, response: AiResponse): AiResponse {
  if (!response.ok || request.responseFormat === "json" || !response.text) {
    return response;
  }
  return { ...response, text: appendAiGeneratedFooter(response.text) };
}

function finalizeStreamText(request: AiRequest, text: string): string {
  if (request.responseFormat === "json") return text;
  return appendAiGeneratedFooter(text);
}

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function renderTemplate(text: string, settings: PersonalLifeSystemSettings, model = settings.aiModel): string {
  return text
    .replace(/\{\{model\}\}/g, model)
    .replace(/\{\{apiVersion\}\}/g, settings.aiApiVersion)
    .replace(/\{\{provider\}\}/g, settings.aiProvider);
}

function defaultAuthHeader(mode: AiMode): string {
  return mode === "anthropic" ? "x-api-key" : "Authorization";
}

function defaultAuthPrefix(headerName: string): string {
  return headerName.trim().toLowerCase() === "authorization" ? "Bearer " : "";
}

function parseHeaderJson(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("附加请求头必须是 JSON 对象。");
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key.trim() || value === undefined || value === null) {
      continue;
    }
    headers[key] = String(value);
  }
  return headers;
}

function buildUrl(baseUrl: string, path: string): string {
  const normalizedBase = normalizeUrl(baseUrl);
  const normalizedPath = path.trim();

  if (!normalizedPath) {
    return normalizedBase;
  }
  if (isAbsoluteUrl(normalizedPath)) {
    return normalizeUrl(normalizedPath);
  }
  if (normalizedPath.startsWith("?")) {
    return `${normalizedBase}${normalizedPath}`;
  }
  if (normalizedPath.startsWith("/")) {
    return `${normalizedBase}${normalizedPath}`;
  }
  return `${normalizedBase}/${normalizedPath}`;
}

function hasVersionPrefix(path: string): boolean {
  return /^v\d+\//i.test(path.trim());
}

function normalizeModelName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function canonicalModelName(value: string): string {
  const normalized = normalizeModelName(value);
  if (
    normalized === normalizeModelName("deepseek-chat") ||
    normalized === normalizeModelName("deepseek-reasoner")
  ) {
    return normalizeModelName("deepseek-v4-flash");
  }
  return normalized;
}

function modelsMatch(available: string, requested: string): boolean {
  return canonicalModelName(available) === canonicalModelName(requested);
}

function parseAbsoluteUrl(value: string): URL | null {
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

function stripEndpointSuffix(value: string): string {
  const url = parseAbsoluteUrl(value);
  if (!url) {
    return normalizeUrl(value);
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const tail = segments.slice(-2).join("/");
  if (tail === "chat/completions") {
    segments.splice(-2, 2);
  } else if (segments.length > 0) {
    const last = segments[segments.length - 1];
    if (last === "messages" || last === "models") {
      segments.pop();
    }
  }

  url.pathname = `/${segments.join("/")}`;
  url.search = "";
  url.hash = "";
  const normalizedPath = url.pathname === "/" ? "" : url.pathname;
  return `${url.origin}${normalizedPath}`;
}

function isChatEndpointUrl(value: string): boolean {
  const url = parseAbsoluteUrl(value);
  if (!url) {
    return false;
  }
  const path = url.pathname.replace(/\/+$/, "");
  return path.endsWith("/chat/completions") || path.endsWith("/messages");
}

function buildBaseRoots(settings: PersonalLifeSystemSettings): string[] {
  const raw = normalizeUrl(settings.aiBaseUrl);
  if (!raw) {
    return [];
  }

  const roots = [stripEndpointSuffix(raw)];
  if (!isChatEndpointUrl(raw) && !roots.includes(raw)) {
    roots.push(raw);
  }

  return Array.from(new Set(roots.filter(Boolean)));
}

function buildEndpointCandidates(settings: PersonalLifeSystemSettings, mode: AiMode, model = settings.aiModel): string[] {
  const rawBaseUrl = normalizeUrl(settings.aiBaseUrl);
  if (!rawBaseUrl) {
    return [];
  }

  const explicitPath = renderTemplate(settings.aiEndpointPath.trim(), settings, model).trim();
  const pathCandidates: string[] = [];

  if (explicitPath) {
    if (isAbsoluteUrl(explicitPath)) {
      return [normalizeUrl(explicitPath)];
    }
    pathCandidates.push(explicitPath);
    if (!hasVersionPrefix(explicitPath)) {
      pathCandidates.push(`v1/${explicitPath}`);
    }
  } else if (mode === "openai") {
    pathCandidates.push("chat/completions", "v1/chat/completions");
  } else {
    pathCandidates.push("messages", "v1/messages");
  }

  const urls = isChatEndpointUrl(rawBaseUrl) ? [rawBaseUrl] : [];
  for (const baseUrl of buildBaseRoots(settings)) {
    for (const path of pathCandidates) {
      urls.push(buildUrl(baseUrl, path));
    }
  }

  return Array.from(new Set(urls.filter(Boolean)));
}

export function buildModelEndpointCandidates(settings: PersonalLifeSystemSettings): string[] {
  const roots = buildBaseRoots(settings);
  if (roots.length === 0) {
    return [];
  }

  const urls: string[] = [];
  for (const baseUrl of roots) {
    const baseHasVersion = /\/v\d+$/i.test(parseAbsoluteUrl(baseUrl)?.pathname.replace(/\/+$/, "") ?? "");
    const providerPrefersRootModels = settings.aiProvider === "deepseek";
    const paths = baseHasVersion || providerPrefersRootModels
      ? ["models", "models?limit=100", "v1/models", "v1/models?limit=100"]
      : ["v1/models", "models", "v1/models?limit=100", "models?limit=100"];
    urls.push(...paths.map((path) => buildUrl(baseUrl, path)));
  }

  return Array.from(new Set(urls.filter(Boolean)));
}

function extractOpenAiText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const data = payload as Record<string, unknown>;
  const choice = Array.isArray(data.choices) ? (data.choices[0] as Record<string, unknown> | undefined) : undefined;
  const content = choice?.message && typeof choice.message === "object"
    ? (choice.message as Record<string, unknown>).content
    : choice?.text;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") {
          return block;
        }
        if (block && typeof block === "object") {
          return String((block as Record<string, unknown>).text ?? "");
        }
        return "";
      })
      .join("\n");
  }

  const outputText = data.output_text;
  if (typeof outputText === "string") {
    return outputText;
  }

  const output = data.output;
  if (Array.isArray(output)) {
    return output
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (!item || typeof item !== "object") {
          return "";
        }
        const obj = item as Record<string, unknown>;
        if (Array.isArray(obj.content)) {
          return obj.content
            .map((block) => {
              if (typeof block === "string") {
                return block;
              }
              if (block && typeof block === "object") {
                return String((block as Record<string, unknown>).text ?? "");
              }
              return "";
            })
            .join("\n");
        }
        return String(obj.text ?? "");
      })
      .join("\n");
  }

  return "";
}

function extractAnthropicText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const data = payload as Record<string, unknown>;
  const content = data.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") {
          return block;
        }
        if (block && typeof block === "object") {
          return String((block as Record<string, unknown>).text ?? "");
        }
        return "";
      })
      .join("\n");
  }

  const completion = data.completion;
  if (typeof completion === "string") {
    return completion;
  }

  const outputText = data.output_text;
  if (typeof outputText === "string") {
    return outputText;
  }

  return "";
}

function toPositiveTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round(value);
}

function extractAiUsage(payload: unknown): AiUsage | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const data = payload as Record<string, unknown>;
  const usage = (data.usage && typeof data.usage === "object" ? data.usage : data) as Record<string, unknown>;
  const inputTokens =
    toPositiveTokenCount(usage.prompt_tokens) ??
    toPositiveTokenCount(usage.input_tokens) ??
    toPositiveTokenCount(usage.promptTokens) ??
    toPositiveTokenCount(usage.inputTokens);
  const outputTokens =
    toPositiveTokenCount(usage.completion_tokens) ??
    toPositiveTokenCount(usage.output_tokens) ??
    toPositiveTokenCount(usage.completionTokens) ??
    toPositiveTokenCount(usage.outputTokens);
  const totalTokens =
    toPositiveTokenCount(usage.total_tokens) ??
    toPositiveTokenCount(usage.totalTokens) ??
    (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return { inputTokens, outputTokens, totalTokens };
}

function extractApiErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const data = payload as Record<string, unknown>;
  const error = data.error;
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return "";
}

function extractModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const data = payload as Record<string, unknown>;
  const candidates: unknown[] = [];

  if (Array.isArray(data.data)) {
    candidates.push(...data.data);
  }
  if (Array.isArray(data.models)) {
    candidates.push(...data.models);
  }
  if (Array.isArray(data.items)) {
    candidates.push(...data.items);
  }

  const ids: string[] = [];
  for (const item of candidates) {
    if (typeof item === "string") {
      ids.push(item);
      continue;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const id = obj.id ?? obj.name ?? obj.model;
    if (typeof id === "string" && id.trim()) {
      ids.push(id.trim());
    }
  }

  return Array.from(new Set(ids));
}

function extractRequestErrorMessage(error: unknown): string {
  if (!error) {
    return "AI 请求失败。";
  }
  if (error instanceof Error) {
    return error.message || "AI 请求失败。";
  }
  if (typeof error === "object") {
    const maybeStatus = error as Record<string, unknown>;
    const message = maybeStatus.message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
    const status = maybeStatus.status ?? maybeStatus.statusCode;
    if (typeof status === "number") {
      return `AI 请求失败：HTTP ${status}`;
    }
  }
  return String(error);
}

function buildRequestHeaders(
  settings: PersonalLifeSystemSettings,
  mode: AiMode
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (mode === "openai") {
    headers.Accept = "application/json";
  } else {
    headers["anthropic-version"] = settings.aiApiVersion.trim() || "2023-06-01";
  }

  const apiKey = normalizeAiApiKeyInput(settings.aiApiKey);
  if (apiKey) {
    const authHeader = settings.aiAuthHeader.trim() || defaultAuthHeader(mode);
    const authPrefix =
      settings.aiAuthPrefix.length > 0
        ? settings.aiAuthPrefix
        : defaultAuthPrefix(authHeader);
    headers[authHeader] = `${authPrefix}${apiKey}`;
  }

  const extraHeaders = settings.aiExtraHeadersJson.trim()
    ? parseHeaderJson(settings.aiExtraHeadersJson)
    : {};
  Object.assign(headers, extraHeaders);

  return headers;
}

function getRequestModel(settings: PersonalLifeSystemSettings, request: AiRequest): string {
  return request.model?.trim() || settings.aiModel;
}

function extractTextFromMessageContent(content: AiMessageContent | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => part.type === "text" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function dataUrlToAnthropicSource(url: string): { type: "base64"; media_type: string; data: string } | null {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) return null;
  return {
    type: "base64",
    media_type: match[1],
    data: match[2]
  };
}

function toAnthropicContent(content: AiMessageContent): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    const source = dataUrlToAnthropicSource(part.image_url.url);
    if (source) {
      parts.push({ type: "image", source });
    }
  }
  return parts.length > 0 ? parts : "";
}

function shouldOmitTemperature(settings: PersonalLifeSystemSettings, modelOverride?: string): boolean {
  const provider = settings.aiProvider;
  const model = (modelOverride || settings.aiModel).trim().toLowerCase();
  const normalized = normalizeModelName(model);

  if (provider === "kimi" && (model.startsWith("kimi-k2") || model.includes("kimi-thinking"))) {
    return true;
  }
  if (normalized.includes("reasoner") || normalized.includes("reasoning") || normalized.includes("thinking")) {
    return true;
  }
  return /^o\d(?:-|$)/i.test(model);
}

function applyTemperature(
  body: Record<string, unknown>,
  settings: PersonalLifeSystemSettings,
  request: AiRequest
): Record<string, unknown> {
  if (shouldOmitTemperature(settings, getRequestModel(settings, request))) {
    return body;
  }
  return { ...body, temperature: request.temperature ?? 0.4 };
}

function bodyHasTemperature(body: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(body, "temperature");
}

function withoutTemperature(body: Record<string, unknown>): Record<string, unknown> {
  const { temperature: _temperature, ...rest } = body;
  return rest;
}

function normalizeReasoningEffort(value: unknown): AiReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "max" ? value : "default";
}

function applyReasoningEffort(
  body: Record<string, unknown>,
  settings: PersonalLifeSystemSettings,
  request: AiRequest
): Record<string, unknown> {
  const effort = normalizeReasoningEffort(request.reasoningEffort ?? settings.aiReasoningEffort);
  if (effort === "default") return body;
  return { ...body, reasoning: { effort } };
}

function bodyHasReasoningEffort(body: Record<string, unknown>): boolean {
  const reasoning = body.reasoning;
  return Boolean(reasoning && typeof reasoning === "object" && Object.prototype.hasOwnProperty.call(reasoning, "effort"));
}

function withoutReasoningEffort(body: Record<string, unknown>): Record<string, unknown> {
  const { reasoning: _reasoning, ...rest } = body;
  return rest;
}

export function isUnsupportedTemperatureError(error: string): boolean {
  const text = error.toLowerCase();
  if (!/(temperature|top_p|sampling|采样|温度)/i.test(text)) {
    return false;
  }
  return /(not supported|unsupported|does not support|invalid|only.*default|must be|不支持|无效|固定|默认)/i.test(text);
}

export function isUnsupportedReasoningEffortError(error: string): boolean {
  const text = String(error || "").toLowerCase();
  if (!/(reasoning|effort|thinking|reasoning\.effort|reasoning_effort|推理)/i.test(text)) {
    return false;
  }
  return /(not supported|unsupported|does not support|unknown|unrecognized|invalid|extra inputs|unexpected|不支持|无效|未知|未识别)/i.test(text);
}

function shouldRetryWithoutTemperature(body: Record<string, unknown>, error: string): boolean {
  return bodyHasTemperature(body) && isUnsupportedTemperatureError(error);
}

function shouldRetryWithoutReasoningEffort(body: Record<string, unknown>, error: string): boolean {
  return bodyHasReasoningEffort(body) && isUnsupportedReasoningEffortError(error);
}

function getBodyAttempts(body: Record<string, unknown>, error?: string): Record<string, unknown>[] {
  if (!error) return [];
  const attempts: Record<string, unknown>[] = [];
  const retryTemperature = shouldRetryWithoutTemperature(body, error);
  const retryReasoning = shouldRetryWithoutReasoningEffort(body, error);
  if (retryTemperature) attempts.push(withoutTemperature(body));
  if (retryReasoning) attempts.push(withoutReasoningEffort(body));
  if (retryTemperature && retryReasoning) attempts.push(withoutReasoningEffort(withoutTemperature(body)));
  const seen = new Set<string>();
  return attempts.filter((attempt) => {
    const key = JSON.stringify(attempt);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildOpenAiBaseBody(
  settings: PersonalLifeSystemSettings,
  request: AiRequest
): Record<string, unknown> {
  return applyReasoningEffort(applyTemperature({
    model: getRequestModel(settings, request),
    messages: request.messages
  }, settings, request), settings, request);
}

function buildAnthropicBaseBody(
  settings: PersonalLifeSystemSettings,
  request: AiRequest
): Record<string, unknown> {
  return applyTemperature({
    model: getRequestModel(settings, request),
    max_tokens: 1800,
    system: extractTextFromMessageContent(request.messages.find((message) => message.role === "system")?.content),
    messages: request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: toAnthropicContent(message.content)
      }))
  }, settings, request);
}

function buildAnthropicBody(
  settings: PersonalLifeSystemSettings,
  request: AiRequest
): Record<string, unknown> {
  return buildAnthropicBaseBody(settings, request);
}

export function buildOpenAiBodies(
  settings: PersonalLifeSystemSettings,
  request: AiRequest
): Record<string, unknown>[] {
  const baseBody = buildOpenAiBaseBody(settings, request);

  if (request.responseFormat !== "json") {
    return [baseBody];
  }

  return [
    {
      ...baseBody,
      response_format: { type: "json_object" }
    },
    baseBody
  ];
}

async function tryCandidates(
  settings: PersonalLifeSystemSettings,
  mode: AiMode,
  request: AiRequest,
  urls: string[],
  extractText: (payload: unknown) => string,
  bodies: Record<string, unknown>[]
): Promise<AiResponse> {
  let lastError = "";

  for (const url of urls) {
    for (const body of bodies) {
      const attempts = [body];
      for (let index = 0; index < attempts.length; index++) {
        const attemptBody = attempts[index];
      try {
        const response = await requestUrl({
          url,
          method: "POST",
          headers: buildRequestHeaders(settings, mode),
          body: JSON.stringify(attemptBody)
        });

        const apiError = extractApiErrorMessage(response.json);
        if (apiError) {
          lastError = apiError;
          attempts.push(...getBodyAttempts(attemptBody, apiError));
          continue;
        }

        const text = extractText(response.json).trim();
        if (!text) {
          lastError = "模型响应为空。";
          continue;
        }

        return { ok: true, text: stripCodeFences(text), usage: extractAiUsage(response.json) };
      } catch (error) {
        lastError = extractRequestErrorMessage(error);
        attempts.push(...getBodyAttempts(attemptBody, lastError));
      }
      }
    }
  }

  return {
    ok: false,
    error: lastError || "AI 请求失败。"
  };
}

export class AiClient {
  private modelCache = new Map<string, { fetchedAt: number; models: string[] }>();

  constructor(private getSettings: () => PersonalLifeSystemSettings) {}

  isConfigured(): boolean {
    const settings = this.getSettings();
    return !validateAiProviderConfig(settings);
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    const settings = this.getSettings();
    if (!this.isConfigured()) {
      return {
        ok: false,
        error: "AI 尚未配置。请在个人人生系统设置中填写 API 信息。"
      };
    }

    try {
      if (settings.checkModelBeforeRequest) {
        const modelWarning = await this.getModelWarning(settings);
        if (modelWarning) {
          new Notice(modelWarning);
        }
      }
      if (settings.aiProvider === "auto") {
        const openai = await this.completeOpenAiCompatible(settings, request);
        if (openai.ok) {
          return finalizeTextResponse(request, openai);
        }
        const anthropic = await this.completeAnthropic(settings, request);
        if (anthropic.ok) {
          return finalizeTextResponse(request, anthropic);
        }
        return {
          ok: false,
          error: openai.error || anthropic.error || "AI 请求失败。"
        };
      }

      if (settings.aiProvider === "anthropic-compatible") {
        return finalizeTextResponse(request, await this.completeAnthropic(settings, request));
      }

      return finalizeTextResponse(request, await this.completeOpenAiCompatible(settings, request));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`AI 请求失败：${message}`);
      return { ok: false, error: message };
    }
  }

  async completeStream(
    request: AiRequest,
    callbacks: AiStreamCallbacks,
    signal?: AbortSignal
  ): Promise<AiResponse> {
    const settings = this.getSettings();
    if (!this.isConfigured()) {
      const err = "AI 尚未配置。请在个人人生系统设置中填写 API 信息。";
      callbacks.onError?.(err);
      return { ok: false, error: err };
    }

    if (this.shouldUseNonStreamingFallback()) {
      return this.completeStreamWithoutBrowserFetch(request, callbacks, signal);
    }

    try {
      if (settings.checkModelBeforeRequest) {
        const modelWarning = await this.getModelWarning(settings);
        if (modelWarning) {
          new Notice(modelWarning);
        }
      }

      callbacks.onStart?.();

      if (settings.aiProvider === "auto") {
        const openai = await this.streamWithMode(settings, request, callbacks, "openai", signal);
        if (openai.ok) return openai;
        const anthropic = await this.streamWithMode(settings, request, callbacks, "anthropic", signal);
        if (anthropic.ok) return anthropic;
        const err = openai.error || anthropic.error || "AI 请求失败。";
        callbacks.onError?.(err);
        return { ok: false, error: err };
      }

      const mode: AiMode = settings.aiProvider === "anthropic-compatible" ? "anthropic" : "openai";
      return await this.streamWithMode(settings, request, callbacks, mode, signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        callbacks.onAbort?.();
        return { ok: false, error: "已取消" };
      }
      const message = extractRequestErrorMessage(error);
      callbacks.onError?.(message);
      return { ok: false, error: message };
    }
  }

  private shouldUseNonStreamingFallback(): boolean {
    return Platform.isMobileApp || typeof fetch !== "function" || typeof ReadableStream === "undefined";
  }

  private async completeStreamWithoutBrowserFetch(
    request: AiRequest,
    callbacks: AiStreamCallbacks,
    signal?: AbortSignal
  ): Promise<AiResponse> {
    if (signal?.aborted) {
      callbacks.onAbort?.();
      return { ok: false, error: "已取消" };
    }

    callbacks.onStart?.();
    let abortCleanup: (() => void) | undefined;
    let abortEmitted = false;
    const emitAbort = (): AiResponse => {
      if (!abortEmitted) {
        abortEmitted = true;
        callbacks.onAbort?.();
      }
      return { ok: false, error: "已取消" };
    };
    const abortPromise = signal
      ? new Promise<AiResponse>((resolve) => {
          const onAbort = () => resolve(emitAbort());
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          abortCleanup = () => signal.removeEventListener("abort", onAbort);
        })
      : null;

    try {
      const requestPromise = this.complete(request);
      const result = abortPromise
        ? await Promise.race([requestPromise, abortPromise])
        : await requestPromise;
      if (abortCleanup) abortCleanup();
      if (signal?.aborted) {
        return emitAbort();
      }
      if (result.ok && typeof result.text === "string") {
        callbacks.onDone?.(result.text);
      } else {
        callbacks.onError?.(result.error ?? "AI 请求失败。");
      }
      return result;
    } catch (error) {
      if (abortCleanup) abortCleanup();
      if (signal?.aborted) {
        return emitAbort();
      }
      const message = extractRequestErrorMessage(error);
      callbacks.onError?.(message);
      return { ok: false, error: message };
    }
  }

  private async streamWithMode(
    settings: PersonalLifeSystemSettings,
    request: AiRequest,
    callbacks: AiStreamCallbacks,
    mode: AiMode,
    signal?: AbortSignal
  ): Promise<AiResponse> {
    const urls = buildEndpointCandidates(settings, mode, getRequestModel(settings, request));
    if (urls.length === 0) {
      return { ok: false, error: "AI Base URL 未配置。" };
    }

    const headers = { ...buildRequestHeaders(settings, mode) };
    if (mode === "anthropic") {
      headers.Accept = "text/event-stream";
    }

    const bodies = mode === "anthropic"
      ? [buildAnthropicBody(settings, request)]
      : buildOpenAiBodies(settings, request).map((body) => ({ ...body, stream: true }));

    let lastError = "";
    for (const url of urls) {
      for (const body of bodies) {
        const attempts = [body];
        for (let index = 0; index < attempts.length; index++) {
          const attemptBody = attempts[index];
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(attemptBody),
          signal
        });

        if (!response.ok) {
          const errText = await response.text();
          let errMsg = `HTTP ${response.status}`;
          try {
            const errJson = JSON.parse(errText);
            const apiErr = extractApiErrorMessage(errJson);
            if (apiErr) errMsg = apiErr;
          } catch { /* ignore parse error */ }
          lastError = errMsg;
          attempts.push(...getBodyAttempts(attemptBody, errMsg));
          continue;
        }

        if (!response.body) {
          const text = await response.text();
          try {
            const json = JSON.parse(text);
            const extracted = mode === "anthropic" ? extractAnthropicText(json) : extractOpenAiText(json);
            callbacks.onDone?.(extracted);
            return { ok: true, text: extracted, usage: extractAiUsage(json) };
          } catch {
            return { ok: false, error: "无法解析响应。" };
          }
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";
        let buffer = "";
        let usage: AiUsage | undefined;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (mode === "anthropic") {
              if (line.startsWith("data: ")) {
                const data = line.slice(6);
                try {
                  const chunk = JSON.parse(data);
                  usage = extractAiUsage(chunk) ?? usage;
                  if (chunk.type === "content_block_delta") {
                    const text = chunk.delta?.text ?? "";
                    if (text) {
                      fullText += text;
                      callbacks.onToken?.(text);
                    }
                  }
                } catch { /* skip malformed chunks */ }
              }
            } else {
              if (line.startsWith("data: ")) {
                const data = line.slice(6);
                if (data === "[DONE]") continue;
                try {
                  const chunk = JSON.parse(data);
                  usage = extractAiUsage(chunk) ?? usage;
                  const delta = chunk.choices?.[0]?.delta?.content;
                  if (typeof delta === "string" && delta) {
                    fullText += delta;
                    callbacks.onToken?.(delta);
                  }
                } catch { /* skip malformed chunks */ }
              }
            }
          }
        }

        // Flush remaining buffer
        if (buffer.trim()) {
          for (const line of buffer.split("\n")) {
            const dataLine = line.startsWith("data: ") ? line.slice(6) : null;
            if (!dataLine || dataLine === "[DONE]") continue;
            try {
              const chunk = JSON.parse(dataLine);
              usage = extractAiUsage(chunk) ?? usage;
              const text = mode === "anthropic"
                ? (chunk.delta?.text ?? "")
                : (chunk.choices?.[0]?.delta?.content ?? "");
              if (text) {
                fullText += text;
                callbacks.onToken?.(text);
              }
            } catch { /* skip */ }
          }
        }

        const finalText = stripCodeFences(fullText.trim());
        if (finalText) {
          const displayText = finalizeStreamText(request, finalText);
          callbacks.onDone?.(displayText);
          return { ok: true, text: displayText, usage };
        }
        callbacks.onDone?.("");
        return { ok: true, text: "", usage };
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        lastError = extractRequestErrorMessage(error);
        attempts.push(...getBodyAttempts(attemptBody, lastError));
        continue;
      }
        }
      }
    }

    return { ok: false, error: lastError || "AI 请求失败。" };
  }

  async listModels(): Promise<string[]> {
    const settings = this.getSettings();
    const cacheKey = this.getModelCacheKey(settings);
    const cached = this.modelCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) {
      return cached.models;
    }

    const headers = buildRequestHeaders(settings, "openai");
    for (const url of buildModelEndpointCandidates(settings)) {
      try {
        const response = await requestUrl({
          url,
          method: "GET",
          headers
        });
        const models = extractModelIds(response.json);
        if (models.length > 0) {
          this.modelCache.set(cacheKey, { fetchedAt: Date.now(), models });
          return models;
        }
      } catch {
        // Try the next candidate.
      }
    }

    return [];
  }

  private getModelCacheKey(settings: PersonalLifeSystemSettings): string {
    return [
      settings.aiProvider,
      settings.aiBaseUrl.trim(),
      settings.aiApiKey.trim(),
      settings.aiAuthHeader.trim(),
      settings.aiAuthPrefix,
      settings.aiExtraHeadersJson.trim()
    ].join("|");
  }

  private async getModelWarning(settings: PersonalLifeSystemSettings): Promise<string | null> {
    if (settings.aiProvider === "ollama") {
      return null;
    }

    const models = await this.listModels();
    if (models.length === 0) {
      return null;
    }

    if (models.some((model) => modelsMatch(model, settings.aiModel))) {
      return null;
    }

    const grouped = models.slice(0, 12).join("、");
    return `当前模型“${settings.aiModel}”不在服务可用模型列表中。可用模型示例：${grouped}`;
  }

  private async completeOpenAiCompatible(
    settings: PersonalLifeSystemSettings,
    request: AiRequest
  ): Promise<AiResponse> {
    const urls = buildEndpointCandidates(settings, "openai", getRequestModel(settings, request));
    if (urls.length === 0) {
      return { ok: false, error: "AI Base URL 未配置。" };
    }
    return tryCandidates(
      settings,
      "openai",
      request,
      urls,
      extractOpenAiText,
      buildOpenAiBodies(settings, request)
    );
  }

  private async completeAnthropic(
    settings: PersonalLifeSystemSettings,
    request: AiRequest
  ): Promise<AiResponse> {
    const urls = buildEndpointCandidates(settings, "anthropic", getRequestModel(settings, request));
    if (urls.length === 0) {
      return { ok: false, error: "AI Base URL 未配置。" };
    }
    return tryCandidates(
      settings,
      "anthropic",
      request,
      urls,
      extractAnthropicText,
      [buildAnthropicBody(settings, request)]
    );
  }
}

export function buildSystemPrompt(settings: PersonalLifeSystemSettings): string {
  const userName = settings.userName || "用户";
  const examProfileLabel = getExamProfileLabel(settings);
  const stylePrompts: Record<string, string> = {
    "warm-companion":
      "回复风格：温暖、陪伴感强，但不空泛。先接住用户的真实处境，再给出少量可执行建议。",
    "concise-executor":
      "回复风格：高效执行型。少解释，优先给结论、步骤、下一步行动。",
    "strict-coach":
      "回复风格：严格教练型。直接指出问题、风险和改进动作，避免无根据安慰。",
    "exam-tutor":
      `回复风格：${examProfileLabel}老师型。${getExamAssistantPrompt(settings)}`,
    "four-sages":
      "回复风格：四圣谏言型。综合曾国藩的笃实修身、芒格的逆向思考、巴菲特的长期主义、Karpathy 的工程现实主义，输出务实判断。",
    custom: settings.assistantCustomPrompt.trim()
      ? `回复风格：遵循用户自定义要求。\n${settings.assistantCustomPrompt.trim()}`
      : "回复风格：自然、清楚、可执行。"
  };
  const verbosityPrompts: Record<string, string> = {
    brief: "回复长度：简短。默认 3-6 条要点，除非用户要求展开。",
    normal: "回复长度：标准。给足关键上下文，但避免长篇铺陈。",
    detailed: "回复长度：详细。适合复盘、规划和复杂分析，但仍保持结构清晰。"
  };
  return [
    `你是${userName}的个人系统助手，名字叫${settings.assistantName}。`,
    "你帮助用户管理日记、待办、长期记忆、复盘、备考练习和项目推进。",
    stylePrompts[settings.assistantStyle] ?? stylePrompts["warm-companion"],
    verbosityPrompts[settings.assistantVerbosity] ?? verbosityPrompts.normal,
    "输出要直接、清楚、可执行，尽量使用 Markdown。",
    "区分事实、推测和建议。除非用户明确要求，不要编造事实。"
  ].join("\n");
}
