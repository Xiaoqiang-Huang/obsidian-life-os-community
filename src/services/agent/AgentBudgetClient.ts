import type { AiClient, AiRequest, AiStreamCallbacks } from "../../ai";
import type { AgentRequestBudget } from "./AgentRequestBudget";
const budgets = new WeakMap<object, AgentRequestBudget>();
export function agentBudgetOf(ai: AiClient) { return budgets.get(ai); }
/** Per-operation facade; never mutates the global client's settings or active budget. */
export function withAgentBudget(ai: AiClient, budget: AgentRequestBudget): AiClient {
  const scoped = Object.create(ai) as AiClient;
  const attach = (r: AiRequest): AiRequest => {
    // A join preserves both ancestor chains without mutating caller-owned counters or links.
    const joined = r.requestBudget && r.requestBudget !== budget
      ? { limit: Number.MAX_SAFE_INTEGER, used: 0, parents: [r.requestBudget, budget] } : budget;
    return { ...r, requestBudget: joined, skipModelCheck: true };
  };
  scoped.complete = r => ai.complete(attach(r));
  scoped.completeStream = (r: AiRequest, callbacks: AiStreamCallbacks, signal?: AbortSignal) => ai.completeStream(attach(r), callbacks, signal || budget.signal);
  budgets.set(scoped, budget); return scoped;
}
