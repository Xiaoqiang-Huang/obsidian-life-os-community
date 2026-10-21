import type { AgentProviderProfile, AgentRuntimeProfile } from "../../AgentEngineConfig";
import { validateAgentEndpoint } from "../../AgentEngineConfig";
import type * as SdkCore from "@anthropic-ai/claude-agent-sdk/core";

export const PINNED_AGENT_SDK_VERSION = "0.3.293";
type SdkModule = Pick<typeof SdkCore, "query" | "tool" | "createSdkMcpServer">;
let sdkPromise: Promise<SdkModule> | undefined;

/** No top-level Node imports or CLI startup. Mobile fails before evaluating the SDK. */
export function loadClaudeSdk(desktop: boolean): Promise<SdkModule> {
  if (!desktop) return Promise.reject(new Error("sdk-desktop-only"));
  if (!sdkPromise) {
    sdkPromise = import("@anthropic-ai/claude-agent-sdk/core").then(module => {
      if (typeof module.query !== "function" || typeof module.tool !== "function" || typeof module.createSdkMcpServer !== "function") throw new Error("sdk-invalid-exports");
      return { query: module.query, tool: module.tool, createSdkMcpServer: module.createSdkMcpServer };
    }).catch(() => { sdkPromise = undefined; throw new Error("sdk-load-failed"); });
  }
  return sdkPromise;
}

export interface ClaudeRuntimePathCheck { readyForVersionProbe: boolean; code: string; sdkVersion: string }

/** Checks only explicitly selected paths. Never searches credentials or executes the CLI. */
export async function checkClaudeRuntimePaths(runtime: AgentRuntimeProfile, desktop: boolean): Promise<ClaudeRuntimePathCheck> {
  const result = (code: string): ClaudeRuntimePathCheck => ({ readyForVersionProbe: code === "paths-ready-version-unverified", code, sdkVersion: PINNED_AGENT_SDK_VERSION });
  if (!desktop) return result("sdk-desktop-only");
  if (!runtime.hostId || !runtime.platform || !runtime.arch) return result("runtime-host-required");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  if (!path.isAbsolute(runtime.executablePath) || /[\u0000-\u001f]/.test(runtime.executablePath)) return result("runtime-absolute-path-required");
  // .cmd/.bat require shell interpretation; never launch them as a fallback.
  if (/\.(cmd|bat|ps1)$/i.test(runtime.executablePath)) return result("runtime-select-native-or-js-entry");
  try { if (!(await fs.stat(runtime.executablePath)).isFile()) return result("runtime-file-required"); }
  catch { return result("runtime-file-missing"); }
  if (/\.[cm]?js$/i.test(runtime.executablePath)) {
    if (!path.isAbsolute(runtime.nodePath) || /[\u0000-\u001f]/.test(runtime.nodePath)) return result("runtime-node-path-required");
    try { if (!(await fs.stat(runtime.nodePath)).isFile()) return result("runtime-node-file-required"); }
    catch { return result("runtime-node-file-missing"); }
  }
  if (runtime.sdkVersion !== PINNED_AGENT_SDK_VERSION) return result("runtime-sdk-version-mismatch");
  return result("paths-ready-version-unverified");
}

export interface ClaudeEnvironmentInput {
  profile: AgentProviderProfile;
  /** Supplied by the future approved host secret resolver; never obtained from process.env. */
  credential: string;
  isolatedConfigDirectory: string;
  inherited: Record<string, string | undefined>;
}

/** Closed allowlist. Never inherits another Anthropic/OpenAI login, NODE_OPTIONS or proxies. */
export function buildClaudeSdkEnvironment(input: ClaudeEnvironmentInput): Record<string, string> {
  if (!validateAgentEndpoint(input.profile.baseUrl, input.profile.allowLocalHttp)) throw new Error("sdk-invalid-endpoint");
  if (!input.profile.mainModel.trim()) throw new Error("sdk-model-required");
  if (!input.credential || input.credential.length > 8192 || /[\u0000-\u0020\u007f]/.test(input.credential)) throw new Error("sdk-explicit-credential-required");
  if (!input.isolatedConfigDirectory || /[\u0000-\u001f]/.test(input.isolatedConfigDirectory)
    || !/^(?:[a-zA-Z]:[\\/]|\/)/.test(input.isolatedConfigDirectory)) throw new Error("sdk-isolated-config-required");
  const env: Record<string, string> = {};
  const permitted = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "LANG", "LC_ALL"]);
  for (const [key, value] of Object.entries(input.inherited)) {
    if (permitted.has(key.toUpperCase()) && typeof value === "string" && !value.includes("\u0000")) env[key] = value;
  }
  env.CLAUDE_CONFIG_DIR = input.isolatedConfigDirectory;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "LifeOS/0.3.25";
  env.ANTHROPIC_BASE_URL = input.profile.baseUrl;
  env.ANTHROPIC_MODEL = input.profile.mainModel;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = input.profile.mainModel;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = input.profile.mainModel;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = input.profile.extractionModel || input.profile.mainModel;
  env.CLAUDE_CODE_SUBAGENT_MODEL = input.profile.extractionModel || input.profile.mainModel;
  if (input.profile.authMode === "anthropic-api-key") env.ANTHROPIC_API_KEY = input.credential;
  else if (input.profile.authMode === "gateway-bearer") env.ANTHROPIC_AUTH_TOKEN = input.credential;
  else throw new Error("sdk-invalid-auth-mode");
  return env;
}

/** Preparation is not permission to execute. A3 will supply the authorised tool bridge. */
export function buildRestrictedClaudeOptions(input: {
  profile: AgentProviderProfile; runtime: AgentRuntimeProfile; environment: Record<string, string>;
  cwd: string; maxTurns: number; abortController: AbortController;
}): SdkCore.Options {
  if (!input.runtime.executablePath || input.runtime.sdkVersion !== PINNED_AGENT_SDK_VERSION) throw new Error("sdk-explicit-runtime-required");
  if (!input.environment.CLAUDE_CONFIG_DIR || input.environment.ANTHROPIC_BASE_URL !== input.profile.baseUrl
    || input.environment.ANTHROPIC_MODEL !== input.profile.mainModel) throw new Error("sdk-environment-identity-mismatch");
  if (!input.environment.ANTHROPIC_API_KEY && !input.environment.ANTHROPIC_AUTH_TOKEN) throw new Error("sdk-explicit-credential-required");
  if (input.environment.ANTHROPIC_API_KEY && input.environment.ANTHROPIC_AUTH_TOKEN) throw new Error("sdk-auth-conflict");
  if (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1) throw new Error("sdk-turn-budget-required");
  if (input.abortController.signal.aborted) throw new Error("sdk-cancelled");
  return {
    pathToClaudeCodeExecutable: input.runtime.executablePath,
    model: input.profile.mainModel, cwd: input.cwd, env: input.environment, maxTurns: input.maxTurns,
    tools: [], allowedTools: [], mcpServers: {}, settingSources: [], permissionMode: "default",
    persistSession: false,
    abortController: input.abortController,
    canUseTool: async () => ({ behavior: "deny", message: "Life OS business bridge is not enabled for this execution." })
  };
}
