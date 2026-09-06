import type { LifeOSAgentTaskMemory, LifeOSAgentToolResult } from "./LifeOSAgentTypes";

const MAX_ITEMS = 16;

/** Small structured memory kept across compaction; never stores attachments. */
export class AgentTaskMemoryService {
  private readonly states = new Map<string, LifeOSAgentTaskMemory>();

  get(sessionId: string): LifeOSAgentTaskMemory {
    const state = this.ensure(sessionId);
    return this.clone(state);
  }

  restore(sessionId: string, value: Partial<LifeOSAgentTaskMemory> | null | undefined): LifeOSAgentTaskMemory {
    if (!value) return this.get(sessionId);
    const state: LifeOSAgentTaskMemory = {
      sessionId,
      goal: this.clean(value.goal, 800),
      currentFocus: this.clean(value.currentFocus, 800),
      openItems: this.unique(value.openItems || []),
      decisions: this.unique(value.decisions || []),
      completedItems: this.unique(value.completedItems || []),
      constraints: this.unique(value.constraints || []),
      corrections: this.unique(value.corrections || []),
      unresolved: this.unique(value.unresolved || []),
      nextActions: this.unique(value.nextActions || []),
      recentTopics: this.unique(value.recentTopics || []),
      lastSummary: this.clean(value.lastSummary, 1_600),
      updatedAt: this.validDate(value.updatedAt) || new Date().toISOString()
    };
    this.states.set(sessionId, state);
    return this.clone(state);
  }

  snapshot(sessionId: string): LifeOSAgentTaskMemory {
    return this.get(sessionId);
  }

  observeUserTurn(sessionId: string, content: string): LifeOSAgentTaskMemory {
    const state = this.ensure(sessionId);
    const text = this.clean(content, 800);
    if (!text) return this.get(sessionId);
    if (!state.goal) state.goal = text;
    state.currentFocus = text;
    state.recentTopics = this.unique([...state.recentTopics, ...this.topicPhrases(text)]);
    const todo = text.match(/(?:下一步|待办|需要|请|帮我|记得)[：:]?\s*(.{3,160})/u)?.[1];
    if (todo) {
      state.openItems = this.unique([...state.openItems, todo]);
      state.nextActions = this.unique([...state.nextActions, todo]);
    }
    const correction = this.extractClause(text, /(?:不是|并非|纠正|改一下|以后不要|别再|不要再)[：:]?\s*(.{3,220})/u);
    if (correction) state.corrections = this.unique([...state.corrections, correction]);
    const constraint = this.extractClause(text, /(?:必须|不要|只允许|只能|务必|需要保持|偏好|我希望)[：:]?\s*(.{3,220})/u);
    if (constraint) state.constraints = this.unique([...state.constraints, constraint]);
    const unresolved = this.extractClause(text, /(?:还没有|尚未|仍未|无法|待确认|有待|卡在)[：:]?\s*(.{3,220})/u);
    if (unresolved) state.unresolved = this.unique([...state.unresolved, unresolved]);
    const decision = this.extractClause(text, /(?:决定|采用|选择|改为|确认使用)[：:]?\s*(.{3,220})/u);
    if (decision) state.decisions = this.unique([...state.decisions, decision]);
    state.updatedAt = new Date().toISOString();
    return this.get(sessionId);
  }

  observeToolResult(sessionId: string, result: LifeOSAgentToolResult): LifeOSAgentTaskMemory {
    const state = this.ensure(sessionId);
    const summary = `${result.toolId}: ${this.clean(result.ok ? result.output : result.error, 240)}`;
    if (result.ok) {
      if (/^(?:task-complete|task-delete)$/u.test(result.toolId)) state.completedItems = this.unique([...state.completedItems, summary]);
      else if (/^(?:task-add|diary-add|knowledge-save|link-save)$/u.test(result.toolId)) state.decisions = this.unique([...state.decisions, summary]);
      state.lastSummary = summary;
      state.recentTopics = this.unique([...state.recentTopics, result.toolId]);
    }
    state.updatedAt = new Date().toISOString();
    return this.get(sessionId);
  }

  updateSummary(sessionId: string, summary: string): LifeOSAgentTaskMemory {
    const state = this.ensure(sessionId);
    state.lastSummary = this.clean(summary, 1_600);
    state.updatedAt = new Date().toISOString();
    return this.get(sessionId);
  }

  toPrompt(sessionId: string): string {
    const state = this.ensure(sessionId);
    const lines = [
      state.goal ? `目标：${state.goal}` : "",
      state.currentFocus ? `当前焦点：${state.currentFocus}` : "",
      state.openItems.length ? `未完成：${state.openItems.join("；")}` : "",
      state.decisions.length ? `已确认决定：${state.decisions.join("；")}` : "",
      state.constraints.length ? `约束与偏好：${state.constraints.join("；")}` : "",
      state.corrections.length ? `用户纠正：${state.corrections.join("；")}` : "",
      state.unresolved.length ? `待核实：${state.unresolved.join("；")}` : "",
      state.nextActions.length ? `下一步：${state.nextActions.join("；")}` : "",
      state.recentTopics.length ? `近期主题：${state.recentTopics.join("、")}` : "",
      state.lastSummary ? `最近执行摘要：${state.lastSummary}` : ""
    ].filter(Boolean);
    return lines.length ? lines.join("\n") : "当前没有需要跨轮保留的任务状态。";
  }

  clear(sessionId: string): void {
    this.states.delete(sessionId);
  }

  private ensure(sessionId: string): LifeOSAgentTaskMemory {
    const existing = this.states.get(sessionId);
    if (existing) return existing;
    const state: LifeOSAgentTaskMemory = {
      sessionId,
      goal: "",
      currentFocus: "",
      openItems: [],
      decisions: [],
      completedItems: [],
      constraints: [],
      corrections: [],
      unresolved: [],
      nextActions: [],
      recentTopics: [],
      lastSummary: "",
      updatedAt: new Date(0).toISOString()
    };
    this.states.set(sessionId, state);
    return state;
  }

  private unique(items: string[]): string[] {
    return Array.from(new Set(items.map((item) => this.clean(item, 320)).filter(Boolean))).slice(-MAX_ITEMS);
  }

  private clean(value: unknown, max: number): string {
    return String(value || "").replace(/\s+/gu, " ").trim().slice(0, max);
  }

  private clone(state: LifeOSAgentTaskMemory): LifeOSAgentTaskMemory {
    return {
      ...state,
      openItems: [...state.openItems],
      decisions: [...state.decisions],
      completedItems: [...state.completedItems],
      constraints: [...state.constraints],
      corrections: [...state.corrections],
      unresolved: [...state.unresolved],
      nextActions: [...state.nextActions],
      recentTopics: [...state.recentTopics]
    };
  }

  private extractClause(text: string, pattern: RegExp): string {
    const match = text.match(pattern);
    return this.clean(match?.[1] || match?.[0] || "", 260);
  }

  private topicPhrases(text: string): string[] {
    const normalized = text.replace(/[，。！？、；：,.!?;:\n\r]+/gu, " ");
    const latin = normalized.match(/[A-Za-z][A-Za-z0-9_.+-]{2,32}/gu) || [];
    const chinese = normalized.match(/[\p{Script=Han}]{2,12}/gu) || [];
    return [...latin, ...chinese].slice(0, 8);
  }

  private validDate(value: unknown): string {
    const date = new Date(String(value || ""));
    return Number.isFinite(date.getTime()) ? date.toISOString() : "";
  }
}
