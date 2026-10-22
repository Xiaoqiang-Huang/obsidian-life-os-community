/** Host-owned chat turn budgets. A tool-enabled model loop needs room to read
 * evidence and still produce a final answer. The old default of six model
 * requests could be exhausted by ordinary multi-file research before the tool
 * budget notice was ever reached, causing a hard REQUEST_BUDGET failure with no
 * answer. */
export const DEFAULT_CHAT_MODEL_REQUESTS = 16;
export const DEFAULT_CHAT_TOOL_CALLS = 12;
/** Leave at least this many model requests for the final answer after tools. */
export const CHAT_FINAL_ANSWER_RESERVE = 2;

/** Never allow the tool allowance to consume the reserved final-answer turns.
 * One- and two-request continuations are the narrow exception: they may spend
 * one request on a deferred read and then deliver labelled raw material (there
 * is no room for a separate synthesis). */
export function boundedChatToolCalls(requested: number, modelRequests: number): number {
  const cap = modelRequests <= 2 ? (modelRequests > 0 ? 1 : 0) : Math.max(0, Math.min(100, modelRequests) - CHAT_FINAL_ANSWER_RESERVE);
  return Math.max(0, Math.min(Math.max(0, requested), cap));
}
