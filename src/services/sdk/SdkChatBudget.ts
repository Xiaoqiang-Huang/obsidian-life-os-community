/** Host-owned chat turn budgets. A tool-enabled model loop needs room to read
 * evidence and still produce a final answer. The old default of six model
 * requests could be exhausted by ordinary multi-file research before the tool
 * budget notice was ever reached, causing a hard REQUEST_BUDGET failure with no
 * answer. */
export const DEFAULT_CHAT_MODEL_REQUESTS = 16;
/** null means no tool-call count ceiling; 0 still means tools disabled. */
export const DEFAULT_CHAT_TOOL_CALLS: number | null = null;
/** Leave at least this many model requests for the final answer after tools. */
export const CHAT_FINAL_ANSWER_RESERVE = 2;

/** Explicit finite caller allowances keep their final-answer reserve. A null
 * allowance is not derived from model-request counts: one model response can
 * legitimately request many independent host reads.
 * Never allow a finite tool allowance to consume the reserved final-answer turns.
 * One- and two-request continuations are the narrow exception: they may spend
 * one request on a deferred read and then deliver labelled raw material (there
 * is no room for a separate synthesis). */
export function boundedChatToolCalls(requested: number | null, modelRequests: number): number | null {
  if (requested === null) return null;
  const cap = modelRequests <= 2 ? (modelRequests > 0 ? 1 : 0) : Math.max(0, Math.min(100, modelRequests) - CHAT_FINAL_ANSWER_RESERVE);
  return Math.max(0, Math.min(Math.max(0, requested), cap));
}
