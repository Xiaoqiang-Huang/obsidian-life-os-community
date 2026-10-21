import type { AiResponse } from "../../ai";
import { combineAgentSignals } from "../agent/AgentRequestBudget";
import type { SdkExecutionService } from "./SdkExecutionService";
import { captureOrdinarySdkConfig, type OrdinarySdkSettings } from "./SdkOrdinaryConfig";

type Engine = Pick<SdkExecutionService, "complete" | "dispose">;
/** Explicit, paid-capable connectivity probe. Same SDK kernel and HTTP policy,
 * isolated unsaved ordinary config, no model discovery-as-success, no tools.
 * Constructor, settings rendering and disposal never start a probe. */
export class SdkConnectionTestService {
  private stopped = false;
  private active = new Map<AbortController, Engine>();
  constructor(private readonly createEngine: (settings: () => OrdinarySdkSettings) => Engine) {}
  dispose(): void {
    this.stopped = true;
    for (const [stop, engine] of this.active) { stop.abort(); void engine.dispose().catch(() => undefined); }
    this.active.clear();
  }
  async run(input: OrdinarySdkSettings, signal?: AbortSignal, approval: () => boolean = () => true): Promise<AiResponse> {
    const stop = new AbortController(), combined = combineAgentSignals(undefined, signal);
    const abort = () => stop.abort(); combined.signal.addEventListener("abort", abort, { once: true });
    if (combined.signal.aborted) abort();
    let engine: Engine | undefined;
    try {
      const current = () => { if (this.stopped || stop.signal.aborted || approval() !== true) throw Error("sdk-connection-cancelled"); };
      current();
      // Enumerate only ordinary active fields. Dormant SDK credentials/profiles
      // and unrelated settings are neither read nor copied into a probe.
      const settings: OrdinarySdkSettings = Object.freeze({ aiProvider: input.aiProvider, aiBaseUrl: input.aiBaseUrl, aiModel: input.aiModel,
        aiApiKey: input.aiApiKey, aiEndpointPath: input.aiEndpointPath, aiAuthHeader: input.aiAuthHeader, aiAuthPrefix: input.aiAuthPrefix,
        aiExtraHeadersJson: input.aiExtraHeadersJson, aiApiVersion: input.aiApiVersion, aiReasoningEffort: input.aiReasoningEffort,
        enableVisionFileAnalysis: false, visionAiModel: "", visionAiBaseUrl: "", visionAiApiKey: "", visionAiProvider: "openai-compatible", aiModelSupportsVision: false });
      captureOrdinarySdkConfig(settings); current();
      engine = this.createEngine(() => settings); this.active.set(stop, engine);
      const response = await engine.complete({ temperature: 0, messages: [{ role: "system", content: "Connectivity probe. Reply with exactly OK. No tools." },
        { role: "user", content: "Reply with OK." }], requestBudget: { limit: 1, used: 0, signal: stop.signal, maxInputChars: 12000, maxOutputTokens: 64 } },
        { accountScopeId: "desktop", projectScopeId: "connection-probe", sessionId: "connection-probe", automatic: false,
          signal: stop.signal, approval: () => { try { current(); return true; } catch { return false; } } },
        { operationId: `connection-${crypto.randomUUID()}`, channel: "desktop", tools: [], beforeDispatch: async () => { current(); },
          limits: { maxModelRequests: 1, maxToolCalls: 0, maxOutputTokens: 64, maxInputBytes: 12000, maxOutputBytes: 4096, maxDurationMs: 30000 } });
      current();
      if (!response.ok || response.text?.trim() !== "OK") return { ok: false, terminal: true, usage: response.usage, error: "sdk-connection-probe-failed" };
      return { ok: true, text: "OK", usage: response.usage };
    } catch { return { ok: false, terminal: true, error: this.stopped || stop.signal.aborted ? "sdk-connection-cancelled" : "sdk-connection-probe-failed" }; }
    finally { stop.abort(); this.active.delete(stop); combined.signal.removeEventListener("abort", abort); combined.dispose(); try { await engine?.dispose(); } catch { throw Error("sdk-connection-cleanup-failed"); } }
  }
}
