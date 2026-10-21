import { Platform } from "obsidian";
import { AiClient, type AiRequest, type AiResponse, type AiStreamCallbacks } from "../../ai";
import type { PersonalLifeSystemSettings } from "../../settings";
import type { LifeOSAgentService } from "../LifeOSAgentService";
import { captureOrdinarySdkConfig, type OrdinarySdkSettings } from "../sdk/SdkOrdinaryConfig";

export interface WorkflowClientScope {
  purpose?: string;
  automatic?: boolean;
  channel?: "desktop" | "weixin";
  accountScopeId?: string;
  /** Host job/tool identity, never a model-provided replay key. */
  executionId?: string;
  projectScopeId?: string;
  requiredSdkIdentity?: string;
  /** Feature-specific consent, checked at dispatch and after async work. */
  approval?: () => boolean;
}
/** Versioned consent digest, never credentials. Old SDK profile approvals and
 * jobs deliberately do not match; reauthorization is required. Desktop only. */
export function workflowProfileIdentity(settings: OrdinarySdkSettings, task: "text" | "vision" = "text"): string {
  try {
    if (!Platform.isDesktopApp) return "";
    // Never load a Node builtin while evaluating the plugin on mobile/startup.
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const snapshot = captureOrdinarySdkConfig(settings, task);
    const selectedKey = snapshot.config.credentialSource === "vision-ai-key" ? settings.visionAiApiKey : settings.aiApiKey;
    return "ordinary-v1:" + createHash("sha256").update(JSON.stringify([snapshot, snapshot.upstreamHeaders(), selectedKey || ""])).digest("hex");
  } catch { return ""; }
}
/** Compatibility surface for business services; native client supplies metadata
 * only. Text, JSON and images all use the same SDK kernel as chat. */
export class WorkflowAiClient extends AiClient {
  constructor(private workflowSettings: () => PersonalLifeSystemSettings,
    private nativeClient: AiClient, private agentPort: () => LifeOSAgentService,
    private scope: WorkflowClientScope = {}) { super(workflowSettings); }
  override isConfigured(): boolean { return this.agentPort().workflowConfigured(this.scope); }
  override listModels(): Promise<string[]> { return this.nativeClient.listModels(); }
  override complete(request: AiRequest): Promise<AiResponse> { return this.agentPort().completeWorkflow(request, this.scope); }
  override completeStream(request: AiRequest, callbacks: AiStreamCallbacks, signal?: AbortSignal): Promise<AiResponse> {
    return this.agentPort().completeWorkflow(request, this.scope, callbacks, signal);
  }
}
