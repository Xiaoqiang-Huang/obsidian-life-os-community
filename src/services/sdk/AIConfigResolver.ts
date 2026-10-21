import type { PersonalLifeSystemSettings } from "../../settings";

/** Pure configuration planning. No key reads, settings writes, process or network I/O.
 * A resolved route is NOT a capability/connection receipt. Bridges must pass P0
 * before this resolver replaces the existing execution configuration. */
export type UnifiedAISettings = Pick<PersonalLifeSystemSettings,
  "aiProvider" | "aiBaseUrl" | "aiModel" | "aiEndpointPath" | "aiAuthHeader" |
  "aiAuthPrefix" | "aiExtraHeadersJson" | "aiApiVersion" | "enableVisionFileAnalysis" |
  "visionAiModel" | "visionAiBaseUrl" | "visionAiProvider" | "aiModelSupportsVision">;

export interface UnifiedAIConfig {
  readonly task: "text" | "vision";
  readonly provider: string;
  readonly model: string;
  readonly protocol: "anthropic-messages" | "openai-chat";
  readonly route: "anthropic-direct" | "anthropic-bridge" | "openai-bridge";
  readonly upstreamURL: string;
  readonly sdkBaseURL?: string;
  readonly credentialSource: "active-ai-key" | "vision-ai-key";
  readonly requiresHeaderAdapter: boolean;
  /** Public routing identity only. Credential revisions must be bound separately
   * by the lifecycle manager before enqueueing. Never use this as key identity. */
  readonly publicIdentity: string;
}

function invalid(code: string): never { throw new Error(code); }
function baseURL(value: string): URL {
  if (!value || value.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(value)) invalid("AI_CONFIG_INVALID_URL");
  let url: URL;
  try { url = new URL(value); } catch { return invalid("AI_CONFIG_INVALID_URL"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && local))) invalid("AI_CONFIG_INVALID_URL");
  if (/%(?:2e|2f|5c|00|0a|0d)/i.test(url.pathname) || value.includes("\\")) invalid("AI_CONFIG_INVALID_URL");
  return url;
}

function endpointPath(value: string, model: string, provider: string, version: string): string {
  if (value.length > 1024 || /[\s\u0000-\u001f\u007f?#\\:]/.test(value) || value.startsWith("//")) invalid("AI_CONFIG_INVALID_ENDPOINT");
  const expanded = value.replace(/\{(model|provider|apiVersion)\}/g, (_all, key: string) =>
    encodeURIComponent(key === "model" ? model : key === "provider" ? provider : version));
  if (/[{}]/.test(expanded) || /%(?:2e|2f|5c|00|0a|0d)/i.test(expanded) || expanded.split("/").some(s => s === "." || s === "..")) invalid("AI_CONFIG_INVALID_ENDPOINT");
  return expanded.replace(/^\/+|\/+$/g, "");
}

export function resolveUnifiedAIConfig(settings: UnifiedAISettings, task: "text" | "vision" = "text"): UnifiedAIConfig {
  if (task !== "text" && task !== "vision") invalid("AI_CONFIG_INVALID_TASK");
  if (task === "vision" && !settings.enableVisionFileAnalysis) invalid("AI_CONFIG_VISION_DISABLED");
  // Match resolveVisionSettings: an explicitly vision-capable active model takes
  // precedence over the separate vision override. The flag is not a live probe.
  const activeVision = task === "vision" && settings.aiModelSupportsVision === true;
  const separateVision = task === "vision" && !activeVision && !!settings.visionAiBaseUrl?.trim();
  const provider = separateVision ? settings.visionAiProvider || "openai-compatible" : settings.aiProvider;
  const model = (task === "vision" && !activeVision ? settings.visionAiModel : settings.aiModel)?.trim();
  if (!model || model.length > 256 || /[\u0000-\u001f\u007f]/.test(model)) invalid("AI_CONFIG_MISSING_MODEL");
  if (!provider || provider.length > 64 || /[\u0000-\u0020\u007f]/.test(provider)) invalid("AI_CONFIG_INVALID_PROVIDER");
  const url = baseURL(separateVision ? settings.visionAiBaseUrl! : settings.aiBaseUrl);
  const base = url.href.replace(/\/+$/, "");
  const version = separateVision ? "" : settings.aiApiVersion || "";
  if (version.length > 128 || /[\u0000-\u001f\u007f]/.test(version)) invalid("AI_CONFIG_INVALID_VERSION");
  const explicit = separateVision ? "" : settings.aiEndpointPath || "";
  const endpoint = endpointPath(explicit, model, provider, version);
  const baseIsEndpoint = /\/(?:chat\/completions|messages)$/.test(base);
  // The official DeepSeek service natively supports the SDK's Anthropic wire
  // format. Select it up front, never as an error-triggered paid fallback.
  // Custom hosts, full endpoint Base URLs, nonstandard paths/models remain
  // exactly as configured. No settings, account, key or model are rewritten.
  const nativeDeepSeek = provider === "deepseek" && url.protocol === "https:" && url.hostname === "api.deepseek.com" && !url.port
    && ["", "/", "/v1", "/v1/"].includes(url.pathname)
    && ["deepseek-flash", "deepseek-v4-pro"].includes(model)
    && ["", "chat/completions", "v1/chat/completions"].includes(endpoint);
  const anthropic = nativeDeepSeek || provider === "anthropic-compatible" || /\/messages$/.test(base) || /(?:^|\/)v1\/messages$/.test(endpoint) || endpoint === "messages";
  const protocol = anthropic ? "anthropic-messages" : "openai-chat";
  const defaultEndpoint = anthropic ? (/\/v1$/.test(base) ? "messages" : "v1/messages") : "chat/completions";
  // Existing AiClient gives an explicitly configured full Base URL priority.
  const upstreamURL = nativeDeepSeek ? "https://api.deepseek.com/anthropic/v1/messages" : baseIsEndpoint ? base : base + "/" + (endpoint || defaultEndpoint);
  // Custom header values remain in ordinary settings, not in this serializable plan.
  const authHeader = separateVision ? "" : (settings.aiAuthHeader || "").trim();
  const authPrefix = separateVision ? "" : settings.aiAuthPrefix || "";
  const extra = separateVision ? "" : settings.aiExtraHeadersJson || "";
  const directAuth = (!authHeader && !authPrefix) || (authHeader.toLowerCase() === "x-api-key" && !authPrefix) ||
    (authHeader.toLowerCase() === "authorization" && authPrefix.trim().toLowerCase() === "bearer");
  const requiresHeaderAdapter = !directAuth || !!extra.trim() || !!version;
  const canonical = /\/v1\/messages$/.test(upstreamURL);
  const route = !anthropic ? "openai-bridge" : canonical && !requiresHeaderAdapter ? "anthropic-direct" : "anthropic-bridge";
  const credentialSource = separateVision ? "vision-ai-key" : "active-ai-key";
  const publicIdentity = JSON.stringify([task, provider, model, upstreamURL, route, credentialSource, version]);
  return Object.freeze({ task, provider, model, protocol, route, upstreamURL,
    ...(route === "anthropic-direct" ? { sdkBaseURL: upstreamURL.slice(0, -"/v1/messages".length) } : {}),
    credentialSource, requiresHeaderAdapter, publicIdentity });
}
