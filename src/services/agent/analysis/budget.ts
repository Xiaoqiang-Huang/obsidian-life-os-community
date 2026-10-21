import type { Category, JobBudget, BudgetLimits, UsageInput } from "./types";
export const CATEGORIES: Category[] = ["api", "sdk", "vision", "search", "write"];
export function newBudget(limits: BudgetLimits): JobBudget {
  if (!Number.isSafeInteger(limits.sdkTurns) || limits.sdkTurns < 0) throw new Error("invalid-sdk-turn-limit");
  for (const c of CATEGORIES) if (!Number.isSafeInteger(limits[c]) || limits[c] < 0) throw new Error("invalid-request-limit");
  for (const n of [limits.tokens, limits.cost, limits.durationMs]) if (n !== null && (!Number.isFinite(n) || n < 0)) throw new Error("invalid-budget-limit");
  if (limits.cost !== null && !limits.currency) throw new Error("currency-required");
  return { limits, requests: { api: 0, sdk: 0, vision: 0, search: 0, write: 0 }, tokens: 0, cost: 0,
    unknown: false, reservations: [], receipts: [], cumulative: {}, sdkTurns: 0 };
}
export function reserve(b: JobBudget, executionId: string, taskId: string, category: Category,
  tokens: number, cost: number | null, now: number, startedAt: number, sdkTurns = category === "sdk" ? 1 : 0, profile = ""): void {
  if (b.unknown) throw new Error("uncertain-consumption");
  if (!Number.isSafeInteger(tokens) || tokens < 0 || (cost !== null && (!Number.isFinite(cost) || cost < 0))) throw new Error("invalid-reservation");
  if (b.reservations.some(r => r.executionId === executionId)) throw new Error("duplicate-execution");
  const held = b.reservations.filter(r => r.state !== "settled");
  if (!Number.isSafeInteger(sdkTurns) || sdkTurns < 0 || (category !== "sdk" && sdkTurns !== 0)) throw new Error("invalid-sdk-turn-reservation");
  if (b.sdkTurns + held.reduce((s, r) => s + r.sdkTurns, 0) + sdkTurns > b.limits.sdkTurns) throw new Error("sdk-turn-budget-exhausted");
  if (b.requests[category] >= b.limits[category]) throw new Error("request-budget-exhausted");
  if (b.limits.durationMs !== null && now - startedAt >= b.limits.durationMs) throw new Error("duration-budget-exhausted");
  if (b.limits.tokens !== null && b.tokens + held.reduce((sum, r) => sum + r.tokens, 0) + tokens > b.limits.tokens) throw new Error("token-budget-exhausted");
  if (b.limits.cost !== null && (cost === null || held.some(r => r.cost === null)
    || b.cost + held.reduce((sum, r) => sum + (r.cost || 0), 0) + cost > b.limits.cost)) throw new Error("cost-budget-required");
  b.requests[category]++; b.reservations.push({ executionId, taskId, category, tokens, cost, state: "reserved", startedAt: now, sdkTurns, profile });
}
/** Receipt identity is execution-bound. Cumulative session receipts charge only monotone deltas. */
export function settle(b: JobBudget, executionId: string, profile: string, usage?: UsageInput): void {
  const r = b.reservations.find(s => s.executionId === executionId);
  if (!r) throw new Error("unknown-reservation");
  if (r.state === "settled") return;
  const uncertain = (): void => { r.state = "uncertain"; b.unknown = true; };
  if (!usage || usage.executionId !== executionId || usage.taskId !== r.taskId || usage.profile !== profile
    || (r.profile && usage.profile !== r.profile) || usage.category !== r.category || !usage.receiptId) { uncertain(); return; }
  if (b.receipts.some(s => s.receiptId === usage.receiptId && s.profile === profile)) { uncertain(); return; }
  if ([usage.tokens, usage.cost, usage.sdkHttpRequests, usage.sdkTurns].some(n => n !== null && (!Number.isFinite(n) || n < 0))
    || (b.limits.cost !== null && usage.currency !== b.limits.currency)) { uncertain(); return; }
  let deltaTokens = usage.tokens, deltaCost = usage.cost;
  if (usage.basis === "cumulative") {
    if (!usage.counterId) { uncertain(); return; }
    const key = JSON.stringify([usage.profile, usage.category, usage.counterId]);
    const old = b.cumulative[key];
    if (old && ((usage.tokens !== null && old.tokens !== null && usage.tokens < old.tokens)
      || (usage.cost !== null && old.cost !== null && usage.cost < old.cost))) { uncertain(); return; }
    // A caller must seed a previously used SDK session's counters before its first reservation.
    deltaTokens = usage.tokens === null ? null : usage.tokens - (old?.tokens || 0);
    deltaCost = usage.cost === null ? null : usage.cost - (old?.cost || 0);
    b.cumulative[key] = { tokens: usage.tokens, cost: usage.cost };
  } else if (usage.basis !== "incremental") { uncertain(); return; }
  b.receipts.push({ ...usage, deltaTokens, deltaCost });
  b.tokens += deltaTokens || 0; b.cost += deltaCost || 0; r.state = "settled";
  if (r.category === "sdk") {
    if (usage.sdkTurns === null || !Number.isSafeInteger(usage.sdkTurns)) b.unknown = true;
    else b.sdkTurns += usage.sdkTurns;
    if (b.sdkTurns > b.limits.sdkTurns || (usage.sdkTurns !== null && usage.sdkTurns > r.sdkTurns)) b.unknown = true;
  }
  if ((deltaTokens === null && b.limits.tokens !== null) || (deltaCost === null && b.limits.cost !== null)
    || (b.limits.tokens !== null && b.tokens > b.limits.tokens) || (b.limits.cost !== null && b.cost > b.limits.cost)) b.unknown = true;
}
export function remainingBudget(b: JobBudget): BudgetLimits {
  const result = { ...b.limits };
  for (const c of CATEGORIES) result[c] = Math.max(0, b.limits[c] - b.requests[c]);
  const held = b.reservations.filter(r => r.state !== "settled");
  result.sdkTurns = Math.max(0, b.limits.sdkTurns - b.sdkTurns - held.reduce((s, r) => s + r.sdkTurns, 0));
  if (result.tokens !== null) result.tokens = Math.max(0, result.tokens - b.tokens - held.reduce((s, r) => s + r.tokens, 0));
  if (result.cost !== null) result.cost = Math.max(0, result.cost - b.cost - held.reduce((s, r) => s + (r.cost || 0), 0));
  return result;
}
export function consumptionUncertain(b: JobBudget): boolean {
  return b.reservations.some(r => r.state === "uncertain")
    || (b.limits.tokens !== null && (b.tokens > b.limits.tokens || b.receipts.some(r => r.deltaTokens === null)))
    || (b.limits.cost !== null && (b.cost > b.limits.cost || b.receipts.some(r => r.deltaCost === null)))
    || b.sdkTurns > b.limits.sdkTurns || b.receipts.some(r => r.category === "sdk" && r.sdkTurns === null);
}
