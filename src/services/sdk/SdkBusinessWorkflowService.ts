import type { AiRequest, AiResponse, AiStreamCallbacks } from "../../ai";
import type { PersonalLifeSystemSettings } from "../../settings";
import { agentBudgetChain, combineAgentSignals } from "../agent/AgentRequestBudget";
import type { AgentExecutionOutbox } from "../agent/AgentExecutionOutbox";
import { workflowProfileIdentity, type WorkflowClientScope } from "../agent/WorkflowAiClient";
import { captureOrdinarySdkConfig } from "./SdkOrdinaryConfig";

import type { SdkExecutionService } from "./SdkExecutionService";

interface Host {
  getSettings(): PersonalLifeSystemSettings;
  hasEntitlement(): boolean;
  engine: Pick<SdkExecutionService, "complete" | "stream" | "refreshConfiguration">;
  outbox: AgentExecutionOutbox;
}
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map(n => n.toString(16).padStart(2, "0")).join("");
const notify = (c: AiStreamCallbacks | undefined, name: keyof AiStreamCallbacks, value?: string) => { try { (c?.[name] as ((s?: string) => void) | undefined)?.(value); } catch { /* no paid retry */ } };
/** Supplied-data-only workflow: no planner/recall/tools/SDK settings/fallback.
 * Shares the channel kernel, usage ledger and original durable host outbox. */
export class SdkBusinessWorkflowService {
  #disposed = false;
  #active = new Set<() => void>();
  constructor(private readonly host: Host) {}
  configured(scope: WorkflowClientScope): boolean {
    if (this.#disposed) return false;
    try { return !!workflowProfileIdentity(this.host.getSettings()) && this.allowed(scope); } catch { return false; }
  }
  private allowed(scope: WorkflowClientScope): boolean {
    const s = this.host.getSettings();
    if (scope.automatic && this.host.hasEntitlement() !== true) return false;
    if (scope.approval && scope.approval() !== true) return false;
    const identity = workflowProfileIdentity(s);
    if (scope.requiredSdkIdentity && scope.requiredSdkIdentity !== identity) return false;
    return !scope.automatic || !!identity && s.sdkAutomaticWorkflowsEnabled === true && s.sdkAutomaticWorkflowIdentity === identity;
  }
  refreshConfiguration(): void { for (const check of this.#active) check(); }
  dispose(): void { this.#disposed = true; for (const check of this.#active) check(); }
  async run(request: AiRequest, scope: WorkflowClientScope = {}, callbacks?: AiStreamCallbacks, signal?: AbortSignal): Promise<AiResponse> {
    scope = { ...scope };
    let combined: ReturnType<typeof combineAgentSignals> | undefined, recheck: (() => void) | undefined;
    const stop = new AbortController(); let started = false;
    try {
      combined = combineAgentSignals(request.requestBudget, signal);
      combined.signal.addEventListener("abort", () => stop.abort(), { once: true });
      if (combined.signal.aborted) stop.abort();
      if (request.tools?.length) throw Error("sdk-workflow-native-tools-not-supported");
      const purpose = scope.purpose || "plugin-text";
      if (!/^[a-z0-9-]{1,48}$/.test(purpose) || scope.executionId !== undefined && (!scope.executionId || scope.executionId.length > 512 || /[\u0000-\u001f]/.test(scope.executionId))) throw Error("sdk-workflow-scope-invalid");
      const task = request.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === "image_url")) ? "vision" : "text";
      if (task === "vision" && scope.automatic) throw Error("sdk-workflow-automatic-vision-not-authorized");
      const snapshot = captureOrdinarySdkConfig(this.host.getSettings(), task);
      const fresh = () => {
        if (this.#disposed || stop.signal.aborted) throw Error("sdk-cancelled");
        if (!this.allowed(scope)) throw Error("sdk-workflow-automatic-approval-required");
        if (!snapshot.matches(captureOrdinarySdkConfig(this.host.getSettings(), task))) throw Error("sdk-workflow-identity-changed");
      };
      recheck = () => { try { fresh(); } catch { stop.abort(); } }; this.#active.add(recheck); fresh();
      // Freeze data before asynchronous preparation; shared host budgets stay live.
      const input: AiRequest = { ...request, messages: JSON.parse(JSON.stringify(request.messages)) };
      const payload = JSON.stringify([input.messages, input.responseFormat, input.temperature, input.model, input.reasoningEffort]);
      const binding = await snapshot.bindingDigest(), fingerprint = await hash(payload); fresh();
      const account = scope.accountScopeId || (scope.channel === "weixin" ? "" : "desktop");
      if (!account) throw Error("sdk-workflow-scope-invalid");
      const namespace = JSON.stringify(["workflow-v2", scope.channel || "desktop", account, scope.projectScopeId || "all-projects", purpose]);
      // Input key supports several bounded stages in a single explicit host job.
      // Config is NOT in turn ID: same job/input cannot silently switch accounts.
      const turn = scope.executionId ? `workflow-${await hash(scope.executionId)}-${fingerprint}` : scope.automatic ? `workflow-${fingerprint}` : `workflow-${crypto.randomUUID()}`;
      const result = await this.host.outbox.scopedEffect(turn, namespace, JSON.stringify([namespace, binding]), "sdk-workflow", payload, async () => {
        fresh();
        const chain = agentBudgetChain(input.requestBudget);
        const caps = chain.map(b => b.maxOutputTokens).filter((n): n is number => n !== undefined);
        const outputLimit = Math.min(131072, ...(caps.length ? caps : [4096]));
        const operationId = await hash(JSON.stringify([namespace, turn])); fresh();
        const sdkScope = { accountScopeId: account, projectScopeId: scope.projectScopeId || "all-projects", sessionId: `workflow:${purpose}`,
          automatic: scope.automatic === true, signal: stop.signal, approval: () => { try { fresh(); return true; } catch { return false; } } };
        const control = { operationId, channel: scope.channel || "desktop", allowImages: () => { try { fresh(); return task === "vision"; } catch { return false; } },
          limits: { maxModelRequests: 1, maxToolCalls: 0, maxOutputTokens: outputLimit, maxInputBytes: 32 * 1024 * 1024, maxOutputBytes: 4 * 1024 * 1024, maxDurationMs: 90000 } };
        return callbacks ? this.host.engine.stream(input, {
          onStart: () => { fresh(); started = true; notify(callbacks, "onStart"); },
          onToken: token => { try { fresh(); notify(callbacks, "onToken", token); } catch { stop.abort(); } }
        }, sdkScope, control) : this.host.engine.complete(input, sdkScope, control);
      });
      fresh();
      if (result.ok) { if (!started && callbacks) { notify(callbacks, "onStart"); notify(callbacks, "onToken", result.text || ""); } notify(callbacks, "onDone", result.text || ""); }
      else notify(callbacks, /CANCELLED|sdk-cancelled/.test(result.error || "") ? "onAbort" : "onError", result.error || "sdk-workflow-failed");
      return result;
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      const error = stop.signal.aborted ? "sdk-cancelled" : /^sdk-[a-z-]{1,100}$/.test(code) ? code : code.startsWith("agent-outbox-") ? "sdk-workflow-receipt-unconfirmed" : "sdk-workflow-failed";
      notify(callbacks, error === "sdk-cancelled" ? "onAbort" : "onError", error);
      return { ok: false, terminal: true, error };
    } finally { if (recheck) this.#active.delete(recheck); stop.abort(); combined?.dispose(); }
  }
}
