export interface AgentRequestBudget {
  limit: number; used: number; signal?: AbortSignal; parent?: AgentRequestBudget; parents?: AgentRequestBudget[];
  maxInputChars?: number; maxOutputTokens?: number;
  /** Reservations in caller-specified currency, not a provider invoice. */
  maxReservedCost?: number; reservedCost?: number;
  inputPricePerMillion?: number; outputPricePerMillion?: number;
}
export function agentBudgetChain(budget?: AgentRequestBudget): AgentRequestBudget[] {
  const result: AgentRequestBudget[] = [], visiting = new Set<AgentRequestBudget>(), seen = new Set<AgentRequestBudget>();
  const visit = (b: AgentRequestBudget) => {
    if (visiting.has(b)) throw new Error("请求预算引用循环");
    if (seen.has(b)) return;
    visiting.add(b);
    if (b.parent) visit(b.parent);
    for (const parent of b.parents || []) visit(parent);
    visiting.delete(b); seen.add(b); result.push(b);
  };
  if (budget) visit(budget);
  return result;
}
export function agentBudgetAborted(budget?: AgentRequestBudget): boolean {
  return agentBudgetChain(budget).some(b => b.signal?.aborted);
}
export function combineAgentSignals(budget?: AgentRequestBudget, signal?: AbortSignal) {
  const signals = [...new Set([signal, ...agentBudgetChain(budget).map(b => b.signal)].filter((s): s is AbortSignal => !!s))];
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const s of signals) { if (s.aborted) abort(); else s.addEventListener("abort", abort, {once:true}); }
  return { signal: controller.signal, dispose: () => signals.forEach(s => s.removeEventListener("abort", abort)) };
}
export function consumeAgentRequest(budget?: AgentRequestBudget, body?: Record<string, unknown>) {
  if (!budget) return;
  const chain = agentBudgetChain(budget);
  for (const b of chain) {
    if (b.signal?.aborted) throw new Error("执行已取消");
    if (b.maxOutputTokens !== undefined && (!Number.isSafeInteger(b.maxOutputTokens) || b.maxOutputTokens <= 0)) throw new Error("输出上限无效");
    if (b.maxInputChars !== undefined && (!Number.isSafeInteger(b.maxInputChars) || b.maxInputChars < 0)) throw new Error("输入上限无效");
    if (b.reservedCost !== undefined && (!Number.isFinite(b.reservedCost) || b.reservedCost < 0)) throw new Error("费用预留记录无效");
    if (!Number.isSafeInteger(b.limit) || b.limit < 0 || !Number.isSafeInteger(b.used) || b.used < 0 || b.used >= b.limit) throw new Error("AI 实际请求次数预算已用尽");
  }
  const chars = body ? JSON.stringify(body).length : 0;
  const caps = chain.map(b => b.maxOutputTokens).filter((n): n is number => Number.isSafeInteger(n) && n! > 0);
  if (body && caps.length) body.max_tokens = Math.min(Number(body.max_tokens) || Infinity, ...caps);
  const reservations = chain.map(b => {
    if (b.maxInputChars !== undefined && chars > b.maxInputChars) throw new Error("请求内容超过本轮输入上限");
    if (b.maxReservedCost === undefined) return 0;
    if (![b.maxReservedCost, b.inputPricePerMillion, b.outputPricePerMillion].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)
      || !body || !Number.isFinite(Number(body.max_tokens))) throw new Error("金额预算需要明确单价和输出上限；未发送请求");
    if (/"image_url"|"base64"/u.test(JSON.stringify(body))) throw new Error("图片费用尚不能可靠估算，金额限制模式下未发送图片请求");
    const reservation = (new TextEncoder().encode(JSON.stringify(body)).length * b.inputPricePerMillion! + Number(body.max_tokens) * b.outputPricePerMillion!) / 1_000_000;
    if ((b.reservedCost || 0) + reservation > b.maxReservedCost!) throw new Error("本轮费用预留预算已用尽");
    return reservation;
  });
  chain.forEach((b,i) => { b.used++; b.reservedCost = (b.reservedCost || 0) + reservations[i]; });
}
