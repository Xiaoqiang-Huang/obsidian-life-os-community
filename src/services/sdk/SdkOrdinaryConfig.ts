import { sdkChatLimits } from "./SdkChatLimits";
import type { PersonalLifeSystemSettings } from "../../settings";
import { resolveUnifiedAIConfig, type UnifiedAIConfig } from "./AIConfigResolver";

export type OrdinarySdkSettings = Pick<PersonalLifeSystemSettings,
  "aiProvider" | "aiBaseUrl" | "aiModel" | "aiApiKey" | "aiEndpointPath" | "aiAuthHeader" | "aiAuthPrefix" |
  "aiExtraHeadersJson" | "aiApiVersion" | "aiReasoningEffort" | "enableVisionFileAnalysis" |
  "visionAiModel" | "visionAiBaseUrl" | "visionAiProvider" | "visionAiApiKey" | "aiModelSupportsVision"> & Partial<Pick<PersonalLifeSystemSettings, "aiChatOutputTokens" | "aiChatTimeoutSeconds" | "aiToolTimeoutSeconds" | "rootFolder">>;
function fail(code: string): never { throw new Error("SDK_ORDINARY_" + code); }
/** Same normalization contract as settings.normalizeAiApiKeyInput; no import of
 * the settings runtime, unrelated profiles, environment or credential stores. */
function key(value: string): string {
  if (typeof value !== "string") fail("INVALID_CREDENTIAL");
  let v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1).trim();
  v = v.replace(/^authorization\s*:\s*/i, "").trim().replace(/^bearer\s+/i, "").trim();
  if (v.length > 8192 || /[\u0000-\u0020\u007f]/.test(v)) fail("INVALID_CREDENTIAL"); return v;
}
const blocked = new Set(["host", "connection", "transfer-encoding", "content-length", "cookie", "origin", "referer", "__proto__", "constructor", "prototype"]);
function header(headers: Record<string, string>, name: string, value: string): void {
  const low = name.toLowerCase();
  if (!/^[a-z0-9-]+$/.test(low) || blocked.has(low) || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value) || (low === "content-type" && !/^application\/json(?:\s*;|$)/i.test(value))) fail("INVALID_HEADERS");
  headers[low] = value;
}

/** Secrets exist only in private memory. Public serialization omits headers/key
 * and private identity. Consumers receive copies for the explicit upstream only. */
export class OrdinarySdkSnapshot {
  readonly config: UnifiedAIConfig;
  readonly reasoningEffort: PersonalLifeSystemSettings["aiReasoningEffort"];
  readonly chatLimits: ReturnType<typeof sdkChatLimits>;
  #headers: Readonly<Record<string, string>>;
  #identity: string;
  constructor(config: UnifiedAIConfig, headers: Record<string, string>, effort: OrdinarySdkSnapshot["reasoningEffort"], credentialRevisionValue: string, chatLimits = sdkChatLimits({})) {
    this.config = config; this.reasoningEffort = effort; this.chatLimits = chatLimits;
    this.#headers = Object.freeze({ ...headers });
    this.#identity = JSON.stringify([config.publicIdentity, Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)), effort, credentialRevisionValue, chatLimits]);
    Object.freeze(this);
  }
  matches(other: OrdinarySdkSnapshot): boolean { return this.#identity === other.#identity; }
  /** Durable outbox binding, not a credential or SDK settings identity. */
  async bindingDigest(): Promise<string> {
    const bytes = new TextEncoder().encode("LifeOS.ordinary-sdk.v1:" + this.#identity);
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(n => n.toString(16).padStart(2, "0")).join("");
  }
  upstreamHeaders(): Readonly<Record<string, string>> { return Object.freeze({ ...this.#headers }); }
  directAuthentication(): { mode: "anthropic-api-key" | "gateway-bearer"; credential: string } {
    if (this.config.route !== "anthropic-direct") fail("DIRECT_AUTH_UNAVAILABLE");
    const api = this.#headers["x-api-key"], bearer = this.#headers.authorization;
    if (api && bearer) fail("AMBIGUOUS_AUTH");
    if (api) return { mode: "anthropic-api-key", credential: key(api) };
    if (bearer && /^Bearer\s+/i.test(bearer)) return { mode: "gateway-bearer", credential: key(bearer) };
    return fail("MISSING_CREDENTIAL");
  }
  toJSON(): unknown { return { config: this.config, reasoningEffort: this.reasoningEffort }; }
}

export function captureOrdinarySdkConfig(settings: OrdinarySdkSettings, task: "text" | "vision" = "text"): OrdinarySdkSnapshot {
  // Explicit field reads: spreading settings would enumerate dormant keys/SDK profiles.
  const config = resolveUnifiedAIConfig({ aiProvider: settings.aiProvider, aiBaseUrl: settings.aiBaseUrl.trim(), aiModel: settings.aiModel,
    aiEndpointPath: settings.aiEndpointPath, aiAuthHeader: settings.aiAuthHeader, aiAuthPrefix: settings.aiAuthPrefix,
    aiExtraHeadersJson: settings.aiExtraHeadersJson, aiApiVersion: settings.aiApiVersion,
    enableVisionFileAnalysis: settings.enableVisionFileAnalysis, visionAiModel: settings.visionAiModel,
    visionAiBaseUrl: settings.visionAiBaseUrl?.trim(), visionAiProvider: settings.visionAiProvider, aiModelSupportsVision: settings.aiModelSupportsVision }, task);
  const separate = config.credentialSource === "vision-ai-key";
  const credential = key(separate ? settings.visionAiApiKey || "" : settings.aiApiKey || "");
  if (!credential && config.provider !== "ollama") fail("MISSING_CREDENTIAL");
  const headers: Record<string, string> = Object.create(null);
  headers["content-type"] = "application/json";
  if (config.protocol === "openai-chat") headers.accept = "application/json";
  else headers["anthropic-version"] = separate ? "2023-06-01" : settings.aiApiVersion.trim() || "2023-06-01";
  const name = separate ? config.protocol === "anthropic-messages" ? "x-api-key" : "Authorization" : settings.aiAuthHeader.trim() || (config.protocol === "anthropic-messages" ? "x-api-key" : "Authorization");
  const prefix = separate ? name.toLowerCase() === "authorization" ? "Bearer " : "" : settings.aiAuthPrefix || (name.toLowerCase() === "authorization" ? "Bearer " : "");
  if (credential) header(headers, name, prefix + credential);
  if (!separate && settings.aiExtraHeadersJson.trim()) {
    if (settings.aiExtraHeadersJson.length > 32768) fail("INVALID_HEADERS");
    let extra: unknown; try { extra = JSON.parse(settings.aiExtraHeadersJson); } catch { return fail("INVALID_HEADERS"); }
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) fail("INVALID_HEADERS");
    if (Object.keys(extra).length > 64) fail("INVALID_HEADERS");
    const seen = new Set<string>();
    for (const [name, value] of Object.entries(extra as Record<string, unknown>)) {
      if (!name.trim() || value === null || value === undefined) continue;
      if (seen.has(name.toLowerCase()) || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")) fail("INVALID_HEADERS");
      seen.add(name.toLowerCase()); header(headers, name, String(value));
    }
  }
  const effort = settings.aiReasoningEffort || "default";
  if (!["default", "low", "medium", "high", "max"].includes(effort)) fail("INVALID_REASONING");
  return new OrdinarySdkSnapshot(config, headers, effort, credential, sdkChatLimits(settings));
}
