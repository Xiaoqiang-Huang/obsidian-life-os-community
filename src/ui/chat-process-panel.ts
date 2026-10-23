import type { LifeOSAgentEvent } from "../services/agent/LifeOSAgentTypes";

/**
 * P1 感知层：聊天实时处理面板。
 *
 * 只呈现可验证的执行过程：阶段、工具、来源定位、耗时与原因码。
 * 不读取也不呈现模型内部文本（event.detail / 模型输出），因此面板内容
 * 不构成“私有思维链”展示。
 */

export type ChatProcessStageId = "prepare" | "search" | "tools" | "generate" | "finalize";
export type ChatProcessStageState = "pending" | "active" | "done" | "skipped" | "failed";
export type ChatProcessToolState = "running" | "completed" | "failed" | "waiting";
export type ChatProcessRunStatus = "running" | "completed" | "interrupted" | "error";

export const CHAT_PROCESS_STAGE_LABELS: Record<ChatProcessStageId, string> = {
  prepare: "准备上下文",
  search: "检索资料",
  tools: "读取/执行工具",
  generate: "生成回答",
  finalize: "整理/写入"
};

export const CHAT_PROCESS_STAGE_ORDER: readonly ChatProcessStageId[] = ["prepare", "search", "tools", "generate", "finalize"];

/** 工具名的用户可读映射；未知工具回落到原始 id，便于核对。 */
export const CHAT_PROCESS_TOOL_LABELS: Record<string, string> = {
  "vault-file-read": "读取文件",
  "vault-file-list": "列出文件",
  "pdf-page-read": "读取 PDF 页",
  "docx-text-read": "读取 Word",
  "lifeos-search": "检索资料",
  "web-search": "联网搜索",
  "web-page-read": "读取网页",
  "knowledge-save": "写入知识库",
  "summary-generate": "生成周报/复盘",
  "tool-capabilities": "检查能力",
  "project-list": "读取项目清单",
  "subagent-rag": "证据整理"
};

const SEARCH_TOOLS = new Set(["lifeos-search", "web-search", "web-page-read"]);
const FINALIZE_TOOLS = new Set(["knowledge-save"]);
const TOOL_EVENT_TYPES = new Set([
  "tool-started",
  "tool-completed",
  "tool-failed",
  "tool-confirmation-required"
]);

export interface ChatProcessPanelOptions {
  /** 与 ChatView 的 runStartedAt 对齐；缺省为构造时刻。 */
  startedAt?: number;
  /** 测试注入；生产环境使用 Date.now。 */
  now?: () => number;
  /** 计时刷新间隔，默认 1000ms。 */
  tickMs?: number;
  /** 测试可关闭真实计时器，改为手动 tick。 */
  autoTick?: boolean;
}

export interface ChatProcessStageSnapshot {
  id: ChatProcessStageId;
  label: string;
  state: ChatProcessStageState;
}

export interface ChatProcessToolSnapshot {
  key: string;
  toolId: string;
  label: string;
  args: string;
  state: ChatProcessToolState;
  durationMs: number | null;
  reasonCode: string;
}

export interface ChatProcessSnapshot {
  status: ChatProcessRunStatus;
  reasonCode: string;
  startedAt: number;
  finishedAt: number | null;
  firstTokenMs: number | null;
  expanded: boolean;
  bodyHidden: boolean;
  stageStates: ChatProcessStageSnapshot[];
  toolEntries: ChatProcessToolSnapshot[];
  stepCount: number;
  toolCount: number;
  summary: string;
  hint: "none" | "soft" | "strong";
  /** D-14: the bounded synthesis reports its own effort level ("default"). */
  synthesisEffort: string;
}

interface StageView {
  id: ChatProcessStageId;
  el: HTMLElement;
  stateEl: HTMLElement;
  state: ChatProcessStageState;
}

interface ToolView {
  key: string;
  toolId: string;
  label: string;
  args: string;
  state: ChatProcessToolState;
  durationMs: number | null;
  reasonCode: string;
  startedAt: number;
  el: HTMLElement;
  stateEl: HTMLElement;
}

const TOOL_ARG_KEYS = ["path", "filePath", "file", "targetPath", "query", "q", "url", "title", "page", "pageNumber", "pages"];

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncate(value: string, limit = 160): string {
  const clean = value.replace(/\s+/gu, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function formatSeconds(ms: number): string {
  const value = Math.max(0, ms) / 1000;
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}s`;
}

function eventMetadata(event: LifeOSAgentEvent): Record<string, string | number | boolean> {
  return event.metadata && typeof event.metadata === "object" ? event.metadata : {};
}

/** 只提取“定位信息”型参数（路径/页码/查询词/URL），不读取文件正文或模型输出。 */
export function chatProcessToolArgs(event: LifeOSAgentEvent): string {
  const metadata = eventMetadata(event);
  const explicit = text(metadata.argsSummary);
  if (explicit) return truncate(explicit);
  const parts: string[] = [];
  for (const key of TOOL_ARG_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) parts.push(truncate(value, 80));
    else if (typeof value === "number" && Number.isFinite(value)) parts.push(String(value));
  }
  if (parts.length) return truncate(parts.join(" · "));
  const summary = text(event.summary);
  if (!summary || /^执行\s+\S+$/u.test(summary) || /^工具\s+\S+\s+(?:完成|未完成)$/u.test(summary)) return "";
  const colon = summary.lastIndexOf("：");
  if (colon >= 0 && colon < summary.length - 1) return truncate(summary.slice(colon + 1));
  return "";
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export class ChatProcessPanel {
  readonly el: HTMLElement;

  private readonly doc: Document;
  private readonly options: Required<Pick<ChatProcessPanelOptions, "startedAt" | "now" | "tickMs" | "autoTick">>;
  private readonly headEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly summaryEl: HTMLElement;
  private readonly timerEl: HTMLElement;
  private readonly firstTokenEl: HTMLElement;
  private readonly toggleEl: HTMLButtonElement;
  private readonly bodyEl: HTMLElement;
  private readonly stagesEl: HTMLElement;
  private readonly stageViews: StageView[] = [];
  private readonly toolsEl: HTMLElement;
  private readonly toolsEmptyEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly reasonEl: HTMLElement;
  private readonly metaEl: HTMLElement;
  private readonly toolViews: ToolView[] = [];
  private readonly everActivated = new Set<ChatProcessStageId>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private status: ChatProcessRunStatus = "running";
  private reasonCode = "";
  private currentStage: ChatProcessStageId = "prepare";
  private firstTokenMs: number | null = null;
  private finishedAt: number | null = null;
  private expanded = true;
  private hint: "none" | "soft" | "strong" = "none";
  private unknownToolSequence = 0;
  /** D-14: config-level label of the bounded synthesis effort; never reasoning text. */
  private synthesisEffort = "";

  constructor(parent: HTMLElement, options: ChatProcessPanelOptions = {}) {
    this.doc = parent.ownerDocument;
    this.options = {
      startedAt: typeof options.startedAt === "number" && Number.isFinite(options.startedAt) ? options.startedAt : Date.now(),
      now: options.now || (() => Date.now()),
      tickMs: options.tickMs && options.tickMs > 0 ? options.tickMs : 1000,
      autoTick: options.autoTick !== false
    };

    this.el = this.createElement("section", "lifeos-chat-process-panel lifeos-chat-process-narrow-safe is-running");
    this.el.setAttribute("role", "status");
    this.el.setAttribute("aria-live", "polite");
    this.el.setAttribute("aria-label", "聊天处理进度");
    this.el.dataset.status = "running";
    this.el.dataset.phase = "prepare";
    this.el.dataset.hint = "none";

    this.headEl = this.createElement("div", "lifeos-chat-process-head");
    const spinner = this.createElement("span", "lifeos-chat-process-spinner");
    spinner.setAttribute("aria-hidden", "true");
    this.headEl.appendChild(spinner);
    this.titleEl = this.createElement("span", "lifeos-chat-process-title");
    this.titleEl.setAttribute("aria-live", "polite");
    this.titleEl.setAttribute("aria-atomic", "true");
    this.headEl.appendChild(this.titleEl);
    this.summaryEl = this.createElement("span", "lifeos-chat-process-summary");
    this.summaryEl.hidden = true;
    this.headEl.appendChild(this.summaryEl);
    this.timerEl = this.createElement("span", "lifeos-chat-process-timer");
    this.timerEl.setAttribute("aria-hidden", "true");
    this.headEl.appendChild(this.timerEl);
    this.firstTokenEl = this.createElement("span", "lifeos-chat-process-first-token");
    this.firstTokenEl.hidden = true;
    this.headEl.appendChild(this.firstTokenEl);
    this.toggleEl = this.createElement("button", "lifeos-chat-process-toggle") as HTMLButtonElement;
    this.toggleEl.setAttribute("type", "button");
    this.toggleEl.setAttribute("aria-expanded", "true");
    this.toggleEl.textContent = "收起";
    this.toggleEl.addEventListener("click", (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      this.toggle();
    });
    this.headEl.appendChild(this.toggleEl);
    this.el.appendChild(this.headEl);

    this.bodyEl = this.createElement("div", "lifeos-chat-process-body");
    this.stagesEl = this.createElement("ol", "lifeos-chat-process-stages");
    this.stagesEl.setAttribute("aria-label", "处理阶段");
    this.bodyEl.appendChild(this.stagesEl);
    for (const id of CHAT_PROCESS_STAGE_ORDER) {
      const item = this.createElement("li", "lifeos-chat-process-stage is-pending");
      item.dataset.stage = id;
      const labelEl = this.createElement("span", "lifeos-chat-process-stage-label");
      labelEl.textContent = CHAT_PROCESS_STAGE_LABELS[id];
      const stateEl = this.createElement("span", "lifeos-chat-process-stage-state");
      stateEl.textContent = "待开始";
      item.appendChild(labelEl);
      item.appendChild(stateEl);
      this.stagesEl.appendChild(item);
      this.stageViews.push({ id, el: item, stateEl, state: "pending" });
    }

    this.toolsEl = this.createElement("ul", "lifeos-chat-process-tools");
    this.toolsEl.setAttribute("aria-label", "工具明细");
    this.bodyEl.appendChild(this.toolsEl);
    this.toolsEmptyEl = this.createElement("div", "lifeos-chat-process-tools-empty");
    this.toolsEmptyEl.textContent = "尚未调用工具";
    this.bodyEl.appendChild(this.toolsEmptyEl);

    this.hintEl = this.createElement("div", "lifeos-chat-process-hint");
    this.hintEl.hidden = true;
    this.bodyEl.appendChild(this.hintEl);

    this.reasonEl = this.createElement("div", "lifeos-chat-process-reason");
    this.reasonEl.hidden = true;
    this.bodyEl.appendChild(this.reasonEl);

    this.metaEl = this.createElement("div", "lifeos-chat-process-meta");
    this.bodyEl.appendChild(this.metaEl);
    this.el.appendChild(this.bodyEl);
    parent.appendChild(this.el);

    this.activate("prepare");
    this.tick();
    if (this.options.autoTick) {
      this.timer = setInterval(() => this.tick(), this.options.tickMs);
    }
  }

  static toolLabel(toolId: string | undefined): string {
    const id = text(toolId);
    return CHAT_PROCESS_TOOL_LABELS[id] || id || "工具";
  }

  handleEvent(event: LifeOSAgentEvent): void {
    if (!event || this.status !== "running") return;
    const type = String(event.type || "");
    // D-14: the bounded synthesis announces its own effort level. This is a
    // configuration label (not model text); it is shown in metadata only.
    const synthesisEffort = text(eventMetadata(event).synthesisEffort);
    if (synthesisEffort) {
      this.synthesisEffort = truncate(synthesisEffort, 24);
      this.el.dataset.synthesisEffort = this.synthesisEffort;
    }
    if (type === "tool-started") {
      this.startTool(event);
    } else if (type === "tool-completed" || type === "tool-failed" || type === "tool-confirmation-required") {
      this.finishTool(event, type === "tool-completed" ? "completed" : type === "tool-failed" ? "failed" : "waiting");
    }

    const stage = this.stageForEvent(event);
    if (stage) {
      if (type === "tool-failed") {
        const view = this.stageViews.find(item => item.id === stage);
        if (view) this.setState(view, "failed");
      } else this.activate(stage);
    }
    this.tick();
  }

  markFirstToken(ms: number): void {
    if (this.status !== "running") return;
    if (typeof ms !== "number" || !Number.isFinite(ms)) return;
    this.firstTokenMs = Math.max(0, ms);
    this.activate("generate");
    this.renderHead();
    this.renderMeta();
  }

  finish(status: ChatProcessRunStatus, reasonCode = ""): void {
    if (this.status !== "running") return;
    this.status = status;
    this.reasonCode = text(reasonCode);
    this.finishedAt = this.options.now();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.hintEl.hidden = true;
    this.hint = "none";
    this.el.dataset.hint = "none";
    if (status === "completed") {
      this.activate("finalize");
      for (const stage of this.stageViews) if (stage.state === "active") this.setState(stage, "done");
      this.expanded = false;
    } else {
      for (const stage of this.stageViews) {
        if (stage.state === "active") this.setState(stage, "failed");
      }
      this.expanded = true;
    }
    for (const stage of this.stageViews) {
      if (stage.state === "pending") this.setState(stage, "skipped");
    }
    this.tick();
    this.renderHead();
    this.renderBodyState();
  }

  toggle(): void {
    this.expanded = !this.expanded;
    this.renderBodyState();
  }

  tick(): void {
    const elapsed = Math.max(0, (this.finishedAt ?? this.options.now()) - this.options.startedAt);
    this.timerEl.textContent = `已用 ${Math.floor(elapsed / 1000)}s`;
    if (this.status === "running") {
      this.hint = elapsed > 45000 ? "strong" : elapsed > 15000 ? "soft" : "none";
      this.hintEl.textContent = this.hint === "strong"
        ? "仍在读取/生成，可随时停止，不会丢失已生成内容"
        : this.hint === "soft"
          ? "仍在处理，可停止"
          : "";
      this.hintEl.hidden = this.hint === "none";
      this.el.dataset.hint = this.hint;
    }
    this.renderHead();
    this.renderMeta();
  }

  snapshot(): ChatProcessSnapshot {
    return {
      status: this.status,
      reasonCode: this.reasonCode,
      startedAt: this.options.startedAt,
      finishedAt: this.finishedAt,
      firstTokenMs: this.firstTokenMs,
      expanded: this.expanded,
      bodyHidden: this.bodyEl.hidden,
      stageStates: this.stageViews.map((stage) => ({ id: stage.id, label: CHAT_PROCESS_STAGE_LABELS[stage.id], state: stage.state })),
      toolEntries: this.toolViews.map((tool) => ({
        key: tool.key,
        toolId: tool.toolId,
        label: tool.label,
        args: tool.args,
        state: tool.state,
        durationMs: tool.durationMs,
        reasonCode: tool.reasonCode
      })),
      stepCount: this.everActivated.size,
      toolCount: this.toolViews.length,
      summary: this.summaryText(),
      hint: this.hint,
      synthesisEffort: this.synthesisEffort
    };
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.el.remove();
  }

  private createElement(tag: string, cls: string): HTMLElement {
    const node = this.doc.createElement(tag);
    node.className = cls;
    return node;
  }

  private stageForEvent(event: LifeOSAgentEvent): ChatProcessStageId | null {
    switch (event.type) {
      case "turn-started":
      case "context-prepared":
        return "prepare";
      case "plan-created": {
        const summary = text(event.summary);
        return /识别|读取|工具/u.test(summary) && !/检索|搜索|多源读取/u.test(summary) ? "tools" : "search";
      }
      case "tool-started":
      case "tool-completed":
      case "tool-failed":
      case "tool-confirmation-required": {
        const id = text(event.toolId);
        if (event.type !== "tool-completed" && FINALIZE_TOOLS.has(id)) return "tools";
        return this.stageForTool(id);
      }
      case "subagent-started":
      case "subagent-completed":
        return "tools";
      case "model-started":
      case "model-streaming":
      case "answer-verified":
        return event.type === "answer-verified" ? "finalize" : "generate";
      case "memory-state-loaded":
      case "memory-recalled":
        // Memory preparation happens before the answer; mapping it to the final
        // stage made the panel jump forward and back on every turn.
        return "prepare";
      case "memory-state-saved":
      case "memory-extraction-enqueued":
      case "memory-extraction-completed":
      case "turn-completed":
        return "finalize";
      case "turn-stopped":
        // Stopping is not evidence of a completed answer or completed tools.
        // finish(error/interrupted) marks the actual active stages unfinished.
        return null;
      default:
        return null;
    }
  }

  private stageForTool(toolId: string | undefined): ChatProcessStageId {
    const id = text(toolId);
    if (SEARCH_TOOLS.has(id)) return "search";
    if (FINALIZE_TOOLS.has(id)) return "finalize";
    return "tools";
  }

  private activate(id: ChatProcessStageId): void {
    const index = CHAT_PROCESS_STAGE_ORDER.indexOf(id);
    if (index < 0) return;
    const target = this.stageViews[index];
    if (!target) return;
    for (let i = 0; i < index; i += 1) {
      const stage = this.stageViews[i];
      if (stage.state === "active") this.setState(stage, "done");
      else if (stage.state === "pending" && !this.everActivated.has(stage.id)) this.setState(stage, "skipped");
    }
    if (!this.everActivated.has(id) || target.state === "skipped") {
      this.setState(target, "active");
      this.everActivated.add(id);
    }
    if (target.state === "pending") this.setState(target, "active");
    if (index >= CHAT_PROCESS_STAGE_ORDER.indexOf(this.currentStage)) {
      this.currentStage = id;
      this.el.dataset.phase = id;
    }
    this.renderHead();
  }

  private setState(stage: StageView, state: ChatProcessStageState): void {
    stage.state = state;
    stage.el.className = "lifeos-chat-process-stage is-" + state;
    stage.stateEl.textContent = state === "done" ? "已完成"
      : state === "active" ? "进行中"
        : state === "skipped" ? "未触发"
          : state === "failed" ? "未完成" : "待开始";
    stage.el.dataset.state = state;
  }

  private startTool(event: LifeOSAgentEvent): void {
    const toolId = text(event.toolId) || text(eventMetadata(event).toolId as string) || "tool";
    const callId = text(event.callId) || text(eventMetadata(event).callId as string);
    const key = callId || `${toolId}:local-${++this.unknownToolSequence}`;
    const existing = this.findTool(key, toolId, true);
    const args = chatProcessToolArgs(event);
    if (existing) {
      existing.args = args || existing.args;
      existing.state = "running";
      this.updateTool(existing);
      return;
    }
    const item = this.createElement("li", "lifeos-chat-process-tool is-running");
    item.dataset.toolId = toolId;
    item.dataset.callId = key;
    const nameEl = this.createElement("span", "lifeos-chat-process-tool-name");
    nameEl.textContent = ChatProcessPanel.toolLabel(toolId);
    const argsEl = this.createElement("span", "lifeos-chat-process-tool-args");
    argsEl.textContent = args;
    const stateEl = this.createElement("span", "lifeos-chat-process-tool-state");
    stateEl.textContent = "进行中";
    item.appendChild(nameEl);
    item.appendChild(argsEl);
    item.appendChild(stateEl);
    this.toolsEl.appendChild(item);
    const view: ToolView = {
      key,
      toolId,
      label: ChatProcessPanel.toolLabel(toolId),
      args,
      state: "running",
      durationMs: null,
      reasonCode: "",
      startedAt: this.options.now(),
      el: item,
      stateEl
    };
    this.toolViews.push(view);
    this.toolsEmptyEl.hidden = true;
    this.el.dataset.tools = String(this.toolViews.length);
    this.renderMeta();
  }

  private finishTool(event: LifeOSAgentEvent, state: ChatProcessToolState): void {
    const toolId = text(event.toolId) || text(eventMetadata(event).toolId as string) || "tool";
    const callId = text(event.callId) || text(eventMetadata(event).callId as string);
    let view = callId ? this.findTool(callId, toolId, true) : null;
    if (!view) view = this.findTool("", toolId, true);
    if (!view) {
      this.startTool(event);
      view = this.toolViews[this.toolViews.length - 1] || null;
    }
    if (!view) return;
    view.state = state;
    const duration = typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
      ? Math.max(0, event.durationMs)
      : state === "waiting" ? null : Math.max(0, this.options.now() - view.startedAt);
    view.durationMs = duration;
    view.reasonCode = state === "failed" ? (text(eventMetadata(event).code as string) || "tool-failed") : "";
    this.updateTool(view);
  }

  private findTool(key: string, toolId: string, runningOnly: boolean): ToolView | null {
    for (let i = this.toolViews.length - 1; i >= 0; i -= 1) {
      const tool = this.toolViews[i];
      if (key && tool.key === key) return tool;
      if (!key && tool.toolId === toolId && (!runningOnly || tool.state === "running" || tool.state === "waiting")) return tool;
    }
    if (key) {
      for (let i = this.toolViews.length - 1; i >= 0; i -= 1) {
        const tool = this.toolViews[i];
        if (tool.toolId === toolId && (!runningOnly || tool.state === "running")) return tool;
      }
    }
    return null;
  }

  private updateTool(view: ToolView): void {
    view.el.className = "lifeos-chat-process-tool is-" + view.state;
    view.el.dataset.state = view.state;
    if (view.state === "completed") {
      view.stateEl.textContent = view.durationMs === null ? "✓ 完成" : `✓ 完成 · ${formatSeconds(view.durationMs)}`;
    } else if (view.state === "failed") {
      view.stateEl.textContent = `失败 · ${view.reasonCode || "tool-failed"}`;
    } else if (view.state === "waiting") {
      view.stateEl.textContent = "等待确认";
    } else {
      view.stateEl.textContent = "进行中";
    }
    this.renderMeta();
  }

  private renderHead(): void {
    const title = this.titleEl;
    if (this.status === "completed") {
      title.hidden = true;
      this.summaryEl.hidden = false;
      this.summaryEl.textContent = this.summaryText();
      this.timerEl.hidden = true;
      this.firstTokenEl.hidden = true;
      this.el.className = "lifeos-chat-process-panel lifeos-chat-process-narrow-safe is-completed is-collapsed";
    } else if (this.status === "interrupted" || this.status === "error") {
      title.hidden = false;
      title.textContent = this.status === "interrupted"
        ? `已停止${this.reasonCode ? `（${this.reasonCode}）` : ""}`
        : `处理失败${this.reasonCode ? `（${this.reasonCode}）` : ""}`;
      this.summaryEl.hidden = true;
      this.timerEl.hidden = false;
      this.reasonEl.hidden = false;
      this.reasonEl.textContent = `原因码：${this.reasonCode || this.status}`;
      this.el.className = `lifeos-chat-process-panel lifeos-chat-process-narrow-safe is-${this.status === "interrupted" ? "stopped" : "failed"}`;
      this.firstTokenEl.hidden = this.firstTokenMs === null;
    } else {
      title.hidden = false;
      title.textContent = `正在处理 · ${CHAT_PROCESS_STAGE_LABELS[this.currentStage]}`;
      this.summaryEl.hidden = true;
      this.timerEl.hidden = false;
      this.el.className = "lifeos-chat-process-panel lifeos-chat-process-narrow-safe is-running";
      this.firstTokenEl.hidden = this.firstTokenMs === null;
    }
    this.el.dataset.status = this.status;
    this.el.dataset.phase = this.currentStage;
    if (this.firstTokenMs !== null) this.firstTokenEl.textContent = `首字 ${formatSeconds(this.firstTokenMs)}`;
    this.timerEl.textContent = `已用 ${Math.floor(Math.max(0, (this.finishedAt ?? this.options.now()) - this.options.startedAt) / 1000)}s`;
    this.renderBodyState();
  }

  private renderBodyState(): void {
    this.bodyEl.hidden = !this.expanded;
    this.toggleEl.setAttribute("aria-expanded", this.expanded ? "true" : "false");
    this.toggleEl.textContent = this.expanded ? "收起" : "展开";
  }

  private renderMeta(): void {
    const count = this.toolViews.length;
    const parts = [`${this.everActivated.size} 个阶段`, `${count} 个工具`];
    if (this.firstTokenMs !== null) parts.push(`首字 ${formatSeconds(this.firstTokenMs)}`);
    if (this.finishedAt !== null) parts.push(`总计 ${formatSeconds(this.finishedAt - this.options.startedAt)}`);
    if (this.synthesisEffort) parts.push(`综合档 ${this.synthesisEffort}`);
    this.metaEl.textContent = collapseWhitespace(parts.join(" · "));
  }

  private summaryText(): string {
    const total = (this.finishedAt ?? this.options.now()) - this.options.startedAt;
    const first = this.firstTokenMs === null ? "未到达" : formatSeconds(this.firstTokenMs);
    return collapseWhitespace(`已处理 ${this.everActivated.size} 步 · ${this.toolViews.length} 个工具 · 首字 ${first} · 总计 ${formatSeconds(total)}`);
  }
}
