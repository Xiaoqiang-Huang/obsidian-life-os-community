import type { AgentWorkingMemoryState } from "./AgentMemoryTypes";
export function isTaskResumeRequest(text: string): boolean {
  return /^(?:请)?(?:继续|恢复|接着)(?:昨天|上次|之前|刚才|今天)?(?:的)?(?:.*?)(?:任务|工作|整理|周报|答题)[。！!？?]*$/u.test(text.trim());
}
/** Caller supplies owned session IDs; never searches by account alone. */
export function selectResumeCheckpoint(text: string, states: AgentWorkingMemoryState[], owned: string[], now = new Date()) {
  const date = new Date(now); if (text.includes("昨天")) date.setDate(date.getDate() - 1);
  const day = (d: Date) => `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
  const dateRequired = /昨天|今天/u.test(text);
  const terms = text.replace(/请|继续|恢复|接着|昨天|今天|上次|之前|刚才|的|任务|工作|[，。！？!?\s]/gu, "");
  const matches = states.filter(s => owned.includes(s.sessionId) && s.policy.use && !s.policy.temporary
    && (s.checkpoint.nextActions.length > 0 || s.checkpoint.unresolved.length > 0 || s.taskMemory.openItems.length > 0)
    && (!dateRequired || day(new Date(s.lastTurnAt)) === day(date))
    && (!terms || [s.checkpoint.objective, s.checkpoint.activeWork, ...s.checkpoint.recentTopics].join(" ").includes(terms)))
    .sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  return { state: matches.length === 1 ? matches[0] : null, candidates: matches,
    message: matches.length === 0 ? "没有找到该范围内可恢复的未完成任务；请指定会话或任务名称。"
      : matches.length > 1 ? "找到多个未完成任务，请先切换到对应会话：\n" + matches.slice(0, 8).map((s,i) => `${i+1}. ${s.checkpoint.objective || s.checkpoint.activeWork}（${s.lastTurnAt}）`).join("\n") : "" };
}
