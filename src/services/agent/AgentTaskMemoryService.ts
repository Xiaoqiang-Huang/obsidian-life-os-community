import type { LifeOSAgentTaskMemory, LifeOSAgentToolResult } from "./LifeOSAgentTypes";

const MAX_ITEMS = 16;

/** Small structured memory kept across compaction; never stores attachments. */
export class AgentTaskMemoryService {
  private readonly states = new Map<string, LifeOSAgentTaskMemory>();

  get(sessionId: string): LifeOSAgentTaskMemory {
    return { ...this.ensure(sessionId), openItems: [...this.ensure(sessionId).openItems], decisions: [...this.ensure(sessionId).decisions], completedItems: [...this.ensure(sessionId).completedItems] };
  }

  observeUserTurn(sessionId: string, content: string): LifeOSAgentTaskMemory {
    const state = this.ensure(sessionId);
    const text = this.clean(content, 800);
    if (!text) return this.get(sessionId);
    if (!state.goal) state.goal = text;
    state.currentFocus = text;
    const todo = text.match(/(?:下一步|待办|需要|请|帮我|记得)[：:]?\s*(.{3,160})/u)?.[1];
    if (todo) state.openItems = this.unique([...state.openItems, todo]);
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
}
