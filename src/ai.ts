import { type AgentRequestBudget } from "./services/agent/AgentRequestBudget";
import { type AgentNativeTool, type AgentNativeCall } from "./services/agent/AgentNativeTools";

import { requestUrl } from "obsidian";
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
  requestBudget?: AgentRequestBudget;
  tools?: AgentNativeTool[];
  messages: AiMessage[];
  temperature?: number;
  responseFormat?: "text" | "json";
  model?: string;
  reasoningEffort?: AiReasoningEffort;
  skipModelCheck?: boolean;
}

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimated?: boolean;
}

export interface AiResponse {
  terminal?: boolean;
  toolCalls?: AgentNativeCall[];
  ok: boolean;
  text?: string;
  error?: string;
  usage?: AiUsage;
}

export interface AiStreamCallbacks {
  onStart?(): void;
  /** Provisional text for paint only. Never persist, execute, or treat as a completed answer. */
  onPreview?(text: string): void;
  onToken?(token: string): void;
  /** Supplier-emitted hidden reasoning. Never answer text, evidence, or saved chat. */
  onReasoning?(text: string): void;
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

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
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

function normalizeModelName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
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

function buildOpenAiBaseBody(
  settings: PersonalLifeSystemSettings,
  request: AiRequest
): Record<string, unknown> {
  return applyReasoningEffort(applyTemperature({
    model: getRequestModel(settings, request),
    messages: request.messages,
    ...(request.tools?.length ? { tools: request.tools.map(tool => ({ type: "function", function: tool })), tool_choice: "auto" } : {})
  }, settings, request), settings, request);
}

export function buildOpenAiBodies(
  settings: PersonalLifeSystemSettings,
  request: AiRequest
): Record<string, unknown>[] {
  const baseBody = buildOpenAiBaseBody(settings, request);

  if (request.responseFormat !== "json" || request.tools?.length) {
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
/** Metadata/type compatibility only. Inference must use WorkflowAiClient. */
export class AiClient {
private modelCache = new Map<string, { fetchedAt: number; models: string[] }>();
constructor(private getSettings: () => PersonalLifeSystemSettings) {}
isConfigured(): boolean {
    const settings = this.getSettings();
    return !validateAiProviderConfig(settings);
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
async complete(_request: AiRequest): Promise<AiResponse> { return { ok: false, terminal: true, error: "sdk-unified-entry-required" }; }
async completeStream(request: AiRequest, callbacks: AiStreamCallbacks, _signal?: AbortSignal): Promise<AiResponse> {
 const response = await this.complete(request); callbacks.onError?.(response.error || "sdk-unified-entry-required"); return response;
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
