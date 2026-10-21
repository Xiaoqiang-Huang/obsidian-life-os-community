import { sdkProtocolFailure, type SdkProtocolFailure } from "./SdkProtocolDiagnostic";
import { consumeAgentRequest, agentBudgetChain, type AgentRequestBudget } from "../agent/AgentRequestBudget";

export interface SdkExecutionLimits {
  maxModelRequests: number; maxOutputTokens: number; maxInputBytes: number;
  maxDurationMs: number; maxToolCalls: number; maxOutputBytes: number;
}
export interface SdkLedgerUsage { inputTokens: number; outputTokens: number; totalTokens: number }
export interface SdkLedgerEvent {
  operation: string; kind: "start" | "dispatch" | "finish";
  /** `timeout` and `interrupted` are execution-layer facts, not delivery results:
   * timeout = the turn cap fired, interrupted = the host stopped the model loop
   * for a bounded continuation/confirmation handoff. Only a real stop is `cancelled`. */
  ordinal?: number; outcome?: "success" | "error" | "cancelled" | "interrupted" | "timeout";
  usage?: SdkLedgerUsage; usageKnown?: boolean; code?: string; protocolFailure?: Readonly<SdkProtocolFailure>;
  /** Finish-only host timestamp; historical rows without it are never rewritten. */
  reportedAt?: string;
  /** Finish-only marker: the operation ended without any dispatched model request. */
  noDispatch?: boolean;
  /** Caller-priced conservative reservations, not an invoice/currency conversion. */
  reservedCosts?: number[];
  /** SDK query-pipeline USD estimate, never presented as a provider bill. */
  estimatedCostUsd?: number;
  /** Observed SDK result.num_turns only; absent/unknown is never fabricated. */
  reportedTurns?: number | null;
}
/** Host-owned durable journal. append MUST commit before resolving. No prompts,
 * bodies, keys, provider error strings or generated answers belong in this store. */
export interface SdkLedgerStore { load(): Promise<SdkLedgerEvent[]>; append(event: SdkLedgerEvent): Promise<void> }
export function sdkFault(code: string): Error { return new Error("SDK_EXECUTION_" + code); }
export function validateSdkLimits(l: SdkExecutionLimits): SdkExecutionLimits {
  const caps: Record<keyof SdkExecutionLimits, number> = { maxModelRequests: 100, maxOutputTokens: 131072, maxInputBytes: 32 * 1024 * 1024,
    maxDurationMs: 600000, maxToolCalls: 100, maxOutputBytes: 8 * 1024 * 1024 };
  if (!l) throw sdkFault("INVALID_LIMITS");
  for (const k of Object.keys(caps) as (keyof SdkExecutionLimits)[]) if (!Number.isSafeInteger(l[k]) || l[k] < (k === "maxToolCalls" ? 0 : 1) || l[k] > caps[k]) throw sdkFault("INVALID_LIMITS");
  return Object.freeze({ ...l });
}
export function sdkUsage(value: unknown): SdkLedgerUsage | undefined {
  const u = value as Record<string, unknown> | undefined;
  if (!u || ![u.input_tokens, u.output_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0].every(n => Number.isSafeInteger(n) && Number(n) >= 0)) return;
  const inputTokens = Number(u.input_tokens) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
  const outputTokens = Number(u.output_tokens), totalTokens = inputTokens + outputTokens;
  if (!Number.isSafeInteger(totalTokens)) return;
  return { inputTokens, outputTokens, totalTokens };
}
/** One serial writer per store; adapters also enforce cross-instance ownership.
 * A started/dispatched operation is NEVER automatically replayed after reload.
 * Unknown consumption remains unknown and reservations are never refunded. */
export class SdkUsageLedger {
  #tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: SdkLedgerStore) {}
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(fn); this.#tail = run.catch(() => undefined); return run;
  }
  start(operation: string): Promise<void> {
    return this.#serial(async () => {
      const rows = await this.store.load();
      if (rows.length >= 50000) throw sdkFault("LEDGER_FULL");
      if (rows.some(e => e.operation === operation)) throw sdkFault("OPERATION_ALREADY_RECORDED");
      await this.store.append({ operation, kind: "start" });
    });
  }
  dispatch(operation: string, limits: SdkExecutionLimits, body: Record<string, unknown>, budget?: AgentRequestBudget): Promise<number> {
    return this.#serial(async () => {
      const rows = await this.store.load(), own = rows.filter(e => e.operation === operation);
      if (!own.some(e => e.kind === "start") || own.some(e => e.kind === "finish")) throw sdkFault("LEDGER_STATE");
      const ordinal = own.filter(e => e.kind === "dispatch").length + 1;
      if (ordinal > limits.maxModelRequests) throw sdkFault("REQUEST_BUDGET");
      if (new TextEncoder().encode(JSON.stringify(body)).length > limits.maxInputBytes) throw sdkFault("INPUT_LIMIT");
      body.max_tokens = Math.min(Number(body.max_tokens) || limits.maxOutputTokens, limits.maxOutputTokens);
      // Existing shared/parent reservations are used at the actual HTTP boundary,
      // including CLI retries and tool-loop calls, not just once per SDK query.
      const chain = agentBudgetChain(budget), costsBefore = chain.map(b => b.reservedCost || 0);
      try { consumeAgentRequest(budget, body); } catch { throw sdkFault("REQUEST_BUDGET"); }
      await this.store.append({ operation, kind: "dispatch", ordinal, reservedCosts: chain.map((b, i) => (b.reservedCost || 0) - costsBefore[i]) });
      return ordinal;
    });
  }
  finish(operation: string, outcome: NonNullable<SdkLedgerEvent["outcome"]>, usage?: SdkLedgerUsage, code?: string, estimatedCostUsd?: number, reportedTurns?: number | null, failure?: Readonly<SdkProtocolFailure>): Promise<void> {
    return this.#serial(async () => {
      const rows = await this.store.load(), own = rows.filter(e => e.operation === operation);
      if (!own.some(e => e.kind === "start") || own.some(e => e.kind === "finish")) throw sdkFault("LEDGER_STATE");
      if (reportedTurns !== undefined && reportedTurns !== null && (!Number.isSafeInteger(reportedTurns) || reportedTurns < 0)) throw sdkFault("LEDGER_STATE");
      const noDispatch = !own.some(e => e.kind === "dispatch");
      await this.store.append({ operation, kind: "finish", outcome, usage, usageKnown: !!usage, code, estimatedCostUsd, reportedTurns, reportedAt: new Date().toISOString(), ...(noDispatch ? { noDispatch: true } : {}), ...(failure ? { protocolFailure: sdkProtocolFailure(failure.stage, new Error(failure.code), failure.status) } : {}) });
    });
  }
  records(): Promise<SdkLedgerEvent[]> { return this.#serial(() => this.store.load()); }
}
