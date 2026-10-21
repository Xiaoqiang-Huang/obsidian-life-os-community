/** Historical configuration codec and internal capability types only. The stored
 * agentExecution value is rollback data, NEVER an active engine/profile selector.
 * Production inference resolves ordinary AI settings in SdkExecutionService. */
export type AgentBackendKind = "native-api" | "claude-sdk";
export type AgentAuthMode = "anthropic-api-key" | "gateway-bearer";
export type AgentCapabilityStatus = "unknown" | "supported" | "unsupported";
export const AGENT_CAPABILITIES = ["text", "tools", "streaming", "structured", "vision", "subagents", "usage"] as const;
export type AgentCapability = typeof AGENT_CAPABILITIES[number];

export interface AgentCapabilitySnapshot {
  profileRevision: number;
  baseUrl: string;
  model: string;
  runtimeId: string;
  sdkVersion: string;
  cliVersion: string;
  testedAt: string;
}

export interface AgentProviderProfile {
  id: string;
  revision: number;
  label: string;
  protocol: "anthropic-messages";
  baseUrl: string;
  allowLocalHttp: boolean;
  authMode: AgentAuthMode;
  secretRef: string;
  mainModel: string;
  extractionModel: string;
  verificationModel: string;
  capabilities: Record<AgentCapability, AgentCapabilityStatus>;
  capabilitySnapshot: AgentCapabilitySnapshot | null;
}

export interface AgentEngineConfiguration {
  schemaVersion: 1;
  preferredBackend: AgentBackendKind;
  interactiveProfileId: string;
  extractionProfileId: string;
  verificationProfileId: string;
  visionProfileId: string;
  /** Empty means the existing native background API; not the SDK main profile. */
  backgroundProfileId: string;
  runtimeId: string;
  profiles: AgentProviderProfile[];
  limits: { maxQueries: number; maxTokens: number; maxDurationMs: number; concurrency: 1 | 2; maxCost: number | null };
  fallbackPolicy: "ask";
}

/** Machine-local only; never part of the synced AgentEngineConfiguration. */
export interface AgentRuntimeProfile {
  id: string;
  hostId: string;
  platform: string;
  arch: string;
  executablePath: string;
  nodePath: string;
  sdkVersion: string;
  cliVersion: string;
}

export interface AgentConfigIssue { code: string; field: string }
export interface AgentConfigRead { config: AgentEngineConfiguration; issues: AgentConfigIssue[]; writable: boolean }

export function createDefaultAgentEngineConfig(): AgentEngineConfiguration {
  return {
    schemaVersion: 1, preferredBackend: "native-api", interactiveProfileId: "", extractionProfileId: "",
    verificationProfileId: "", visionProfileId: "", backgroundProfileId: "", runtimeId: "", profiles: [],
    limits: { maxQueries: 20, maxTokens: 120000, maxDurationMs: 600000, concurrency: 1, maxCost: null },
    fallbackPolicy: "ask"
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function identifier(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value); }
function boundedText(value: unknown): value is string { return typeof value === "string" && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value); }
function unknownCapabilities(): Record<AgentCapability, AgentCapabilityStatus> {
  return Object.fromEntries(AGENT_CAPABILITIES.map(key => [key, "unknown"])) as Record<AgentCapability, AgentCapabilityStatus>;
}

export function validateAgentEndpoint(baseUrl: string, allowLocalHttp = false): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash) return false;
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
    return url.protocol === "https:" || (allowLocalHttp && loopback && url.protocol === "http:");
  } catch { return false; }
}

/** Invalid/future data is diagnosed, never silently replaced on disk. */
export function readAgentEngineConfig(value: unknown): AgentConfigRead {
  const config = createDefaultAgentEngineConfig();
  const issues: AgentConfigIssue[] = [];
  const issue = (code: string, field: string) => issues.push({ code, field });
  if (value === undefined) return { config, issues, writable: true };
  const raw = record(value);
  if (!raw) return { config, issues: [{ code: "invalid-config", field: "agentExecution" }], writable: false };
  if (raw.schemaVersion !== 1) return { config, issues: [{ code: "unsupported-schema", field: "schemaVersion" }], writable: false };
  const topKeys = Object.keys(config);
  for (const key of Object.keys(raw)) if (!topKeys.includes(key)) issue("unknown-field", key);
  if (raw.preferredBackend === "native-api" || raw.preferredBackend === "claude-sdk") config.preferredBackend = raw.preferredBackend;
  else issue("invalid-backend", "preferredBackend");
  if (raw.fallbackPolicy !== "ask") issue("invalid-fallback", "fallbackPolicy");
  for (const key of ["interactiveProfileId", "extractionProfileId", "verificationProfileId", "visionProfileId", "backgroundProfileId", "runtimeId"] as const) {
    if (raw[key] === "" || identifier(raw[key])) config[key] = raw[key] as string;
    else issue("invalid-reference", key);
  }
  if (!Array.isArray(raw.profiles) || raw.profiles.length > 100) issue("invalid-profiles", "profiles");
  else {
    const seen = new Set<string>();
    raw.profiles.forEach((value, index) => {
      const row = record(value), field = `profiles.${index}`;
      if (!row || !identifier(row.id) || seen.has(row.id)) { issue("invalid-or-duplicate-profile", field); return; }
      seen.add(row.id);
      const expected = ["id", "revision", "label", "protocol", "baseUrl", "allowLocalHttp", "authMode", "secretRef", "mainModel", "extractionModel", "verificationModel", "capabilities", "capabilitySnapshot"];
      for (const key of Object.keys(row)) if (!expected.includes(key)) issue("unknown-profile-field", `${field}.${key}`);
      if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 1) issue("invalid-revision", `${field}.revision`);
      if (row.protocol !== "anthropic-messages") issue("invalid-protocol", `${field}.protocol`);
      if (typeof row.allowLocalHttp !== "boolean") issue("invalid-http-policy", `${field}.allowLocalHttp`);
      if (row.authMode !== "anthropic-api-key" && row.authMode !== "gateway-bearer") issue("invalid-auth", `${field}.authMode`);
      for (const key of ["label", "baseUrl", "secretRef", "mainModel", "extractionModel", "verificationModel"] as const) {
        if (!boundedText(row[key])) issue("invalid-text", `${field}.${key}`);
      }
      if (typeof row.baseUrl !== "string" || !validateAgentEndpoint(row.baseUrl, row.allowLocalHttp === true)) issue("invalid-endpoint", `${field}.baseUrl`);
      if (typeof row.secretRef === "string" && row.secretRef !== "" && !/^secret:[a-zA-Z0-9_.:-]{1,128}$/.test(row.secretRef)) issue("invalid-secret-reference", `${field}.secretRef`);
      const caps = record(row.capabilities), capabilities = unknownCapabilities();
      for (const key of AGENT_CAPABILITIES) {
        const status = caps?.[key];
        if (status === "unknown" || status === "supported" || status === "unsupported") capabilities[key] = status;
        else issue("invalid-capability", `${field}.capabilities.${key}`);
      }
      if (caps) for (const key of Object.keys(caps)) if (!(AGENT_CAPABILITIES as readonly string[]).includes(key)) issue("unknown-capability", `${field}.capabilities`);
      const snapshot = record(row.capabilitySnapshot);
      let capabilitySnapshot: AgentCapabilitySnapshot | null = null;
      if (row.capabilitySnapshot !== null) {
        if (!snapshot || snapshot.profileRevision !== row.revision || snapshot.baseUrl !== row.baseUrl || snapshot.model !== row.mainModel
          || !identifier(snapshot.runtimeId) || !boundedText(snapshot.sdkVersion) || !snapshot.sdkVersion
          || !boundedText(snapshot.cliVersion) || !snapshot.cliVersion || !boundedText(snapshot.testedAt)
          || !Number.isFinite(Date.parse(String(snapshot.testedAt)))) issue("invalid-capability-snapshot", `${field}.capabilitySnapshot`);
        else {
          const keys = ["profileRevision", "baseUrl", "model", "runtimeId", "sdkVersion", "cliVersion", "testedAt"];
          for (const key of Object.keys(snapshot)) if (!keys.includes(key)) issue("unknown-snapshot-field", `${field}.capabilitySnapshot`);
          capabilitySnapshot = { profileRevision: Number(snapshot.profileRevision), baseUrl: String(snapshot.baseUrl), model: String(snapshot.model),
            runtimeId: String(snapshot.runtimeId), sdkVersion: String(snapshot.sdkVersion), cliVersion: String(snapshot.cliVersion), testedAt: String(snapshot.testedAt) };
        }
      }
      if (Object.values(capabilities).some(status => status !== "unknown") && !capabilitySnapshot) issue("unbound-capability-results", `${field}.capabilitySnapshot`);
      config.profiles.push({ id: row.id, revision: Number(row.revision), label: String(row.label ?? ""), protocol: "anthropic-messages",
        baseUrl: String(row.baseUrl ?? ""), allowLocalHttp: row.allowLocalHttp === true,
        authMode: row.authMode === "gateway-bearer" ? "gateway-bearer" : "anthropic-api-key", secretRef: String(row.secretRef ?? ""),
        mainModel: String(row.mainModel ?? ""), extractionModel: String(row.extractionModel ?? ""), verificationModel: String(row.verificationModel ?? ""), capabilities, capabilitySnapshot });
    });
  }
  for (const key of ["interactiveProfileId", "extractionProfileId", "verificationProfileId", "visionProfileId", "backgroundProfileId"] as const) {
    if (config[key] && !config.profiles.some(profile => profile.id === config[key])) issue("missing-profile", key);
  }
  const limits = record(raw.limits);
  if (!limits) issue("invalid-limits", "limits");
  else {
    for (const key of ["maxQueries", "maxTokens", "maxDurationMs"] as const) {
      if (Number.isSafeInteger(limits[key]) && Number(limits[key]) > 0) config.limits[key] = Number(limits[key]);
      else issue("invalid-limit", `limits.${key}`);
    }
    if (limits.concurrency === 1 || limits.concurrency === 2) config.limits.concurrency = limits.concurrency;
    else issue("invalid-concurrency", "limits.concurrency");
    if (limits.maxCost === null || (typeof limits.maxCost === "number" && Number.isFinite(limits.maxCost) && limits.maxCost > 0)) config.limits.maxCost = limits.maxCost;
    else issue("invalid-cost", "limits.maxCost");
    for (const key of Object.keys(limits)) if (!Object.keys(config.limits).includes(key)) issue("unknown-limit", `limits.${key}`);
  }
  return { config, issues, writable: issues.length === 0 };
}

export function createAgentProviderProfile(id: string, label: string, baseUrl: string, authMode: AgentAuthMode): AgentProviderProfile {
  if (!identifier(id) || !boundedText(label) || !validateAgentEndpoint(baseUrl)) throw new Error("invalid-profile-template");
  return { id, revision: 1, label, protocol: "anthropic-messages", baseUrl, allowLocalHttp: false, authMode,
    secretRef: "", mainModel: "", extractionModel: "", verificationModel: "", capabilities: unknownCapabilities(), capabilitySnapshot: null };
}

export function updateAgentProviderProfile(profile: AgentProviderProfile, patch: Partial<Pick<AgentProviderProfile,
  "label" | "baseUrl" | "allowLocalHttp" | "authMode" | "secretRef" | "mainModel" | "extractionModel" | "verificationModel">>): AgentProviderProfile {
  const next: AgentProviderProfile = { ...profile, ...patch, capabilities: { ...profile.capabilities } };
  const endpointChanged = next.baseUrl !== profile.baseUrl || next.authMode !== profile.authMode || next.allowLocalHttp !== profile.allowLocalHttp;
  if (endpointChanged) next.secretRef = ""; // Even a supplied old reference must not travel to a new target.
  if (JSON.stringify(next) === JSON.stringify(profile)) return next;
  next.revision = profile.revision + 1;
  next.capabilities = unknownCapabilities();
  next.capabilitySnapshot = null;
  const check = createDefaultAgentEngineConfig(); check.profiles = [next];
  if (!readAgentEngineConfig(check).writable) throw new Error("invalid-profile-update");
  return next;
}

/** Never reads secret stores or resolves environment variables. */
export function getAgentProfileReadiness(config: AgentEngineConfiguration, profileId: string): string[] {
  const profile = config.profiles.find(item => item.id === profileId);
  if (!profile) return ["profile-required"];
  const reasons: string[] = [];
  if (!profile.mainModel) reasons.push("model-required");
  if (!profile.secretRef) reasons.push("credential-required");
  if (!config.runtimeId) reasons.push("runtime-required");
  if (!profile.capabilitySnapshot || profile.capabilitySnapshot.runtimeId !== config.runtimeId
    || profile.capabilities.text !== "supported" || profile.capabilities.tools !== "supported") reasons.push("capability-test-required");
  return reasons;
}

export function resolveAgentRoleProfiles(config: AgentEngineConfiguration): Record<string, string> {
  return {
    interactive: config.interactiveProfileId,
    extraction: config.extractionProfileId || config.interactiveProfileId,
    verification: config.verificationProfileId || config.interactiveProfileId,
    vision: config.visionProfileId || "existing-vision-api",
    background: config.backgroundProfileId || "existing-background-api"
  };
}

const configSaveQueues = new WeakMap<object, Promise<void>>();

/** Serialize SDK saves without replacing legacy fields, even when two settings views are open. */
export function saveAgentEngineConfig(
  settings: { agentExecution?: unknown }, value: unknown, persist: () => Promise<void>, canActivate?: (config: AgentEngineConfiguration) => boolean
): Promise<void> {
  const check = readAgentEngineConfig(value);
  if (!check.writable || (check.config.preferredBackend !== "native-api" && !canActivate?.(check.config))) return Promise.reject(new Error("agent-config-not-ready"));
  const snapshot = JSON.parse(JSON.stringify(check.config)) as AgentEngineConfiguration;
  const previousQueue = configSaveQueues.get(settings) ?? Promise.resolve();
  const next = previousQueue.catch(() => undefined).then(async () => {
    // Unknown/damaged settings must not be replaced by a helper's default config.
    if (!readAgentEngineConfig(settings.agentExecution).writable) throw new Error("agent-config-preservation-required");
    const previous = settings.agentExecution;
    settings.agentExecution = snapshot;
    try { await persist(); }
    catch (error) { if (settings.agentExecution === snapshot) settings.agentExecution = previous; throw error; }
  });
  configSaveQueues.set(settings, next);
  return next;
}
