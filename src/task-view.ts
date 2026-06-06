import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { TASKS_VIEW_TYPE } from "./constants";
import type { IPlugin } from "./plugin-api";
import { QuickCaptureModal } from "./quick-capture";
import { createLifeOsShell } from "./lifeos-shell";
import { ensureFile, formatDate } from "./utils";
import { completeAndArchiveTask, parseTaskLine, type ParsedTask } from "./tasks/task-actions";

type TaskBoardTab = "today" | "pending" | "done" | "auto";

interface TaskItem extends ParsedTask {
  source: "open" | "done";
}

export class TaskView extends ItemView {
  private activeTab: TaskBoardTab = "today";
  private rootEl!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: IPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return TASKS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "任务管理";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    const shell = container.createDiv({ cls: "pls-tasks pls-layout-main" });
    const content = createLifeOsShell(this.app, this.plugin, shell, {
      active: "tasks",
      title: "任务管理，轻松推进每一天",
      subtitle: "提取待办、完成归档、未完成自动延续，让行动保持清晰。",
      showDirectory: true,
      onRefresh: () => this.render()
    });
    this.rootEl = content.createDiv({ cls: "pls-task-board" });
    await this.render();
  }

  private async render(): Promise<void> {
    this.rootEl.empty();
    const tasks = await this.loadTasks();
    const openTasks = tasks.filter((task) => task.isOpen);
    const doneTasks = tasks.filter((task) => !task.isOpen);
    const today = formatDate();
    const todayTasks = openTasks.filter((task) => !task.dueDate || task.dueDate === today);
    const pendingTasks = openTasks.filter((task) => task.dueDate && task.dueDate > today);
    const autoTasks = openTasks.filter((task) => !task.dueDate || task.dueDate < today);

    this.renderToolbar();
    this.renderStats({
      all: openTasks.length,
      today: todayTasks.length,
      pending: pendingTasks.length,
      done: doneTasks.length,
      auto: autoTasks.length
    });

    const workspace = this.rootEl.createDiv({ cls: "pls-task-workspace" });
    const main = workspace.createDiv({ cls: "pls-task-main-panel" });
    this.renderTabs(main, {
      today: todayTasks.length,
      pending: pendingTasks.length,
      done: doneTasks.length,
      auto: autoTasks.length
    });

    const visibleTasks = this.getVisibleTasks(tasks);
    this.renderTaskList(main, visibleTasks);
    this.renderMechanismRail(workspace, todayTasks.length, autoTasks.length, doneTasks.length);
  }

  private renderToolbar(): void {
    const toolbar = this.rootEl.createDiv({ cls: "pls-task-toolbar" });
    const copy = toolbar.createDiv({ cls: "pls-task-toolbar-copy" });
    const eyebrow = copy.createDiv({ cls: "pls-product-eyebrow" });
    setIcon(eyebrow.createSpan(), "check-circle-2");
    eyebrow.createSpan({ text: "清晰任务视图" });
    copy.createEl("p", { text: "今日优先、待办分层、过期自动延续，减少每天重新整理任务的摩擦。" });

    const actions = toolbar.createDiv({ cls: "pls-task-toolbar-actions" });
    this.createActionButton(actions, "新增任务", "plus", () => new QuickCaptureModal(this.app, this.plugin).open(), true);
    this.createActionButton(actions, "打开 open.md", "external-link", () => void this.openTaskFile("open.md"));
    this.createActionButton(actions, "刷新", "refresh-cw", () => void this.render());
  }

  private renderStats(stats: { all: number; today: number; pending: number; done: number; auto: number }): void {
    const grid = this.rootEl.createDiv({ cls: "pls-task-stat-grid" });
    this.renderStat(grid, "全部任务", String(stats.all), "list-checks", "purple");
    this.renderStat(grid, "今日任务", String(stats.today), "sun", "blue");
    this.renderStat(grid, "待完成", String(stats.pending), "clock-3", "green");
    this.renderStat(grid, "自动延续", String(stats.auto), "refresh-cw", "orange");
  }

  private renderStat(parent: HTMLElement, label: string, value: string, icon: string, tone: string): void {
    const card = parent.createDiv({ cls: `pls-task-stat tone-${tone}` });
    setIcon(card.createSpan({ cls: "pls-task-stat-icon" }), icon);
    const copy = card.createDiv();
    copy.createDiv({ cls: "pls-task-stat-value", text: value });
    copy.createDiv({ cls: "pls-task-stat-label", text: label });
  }

  private renderTabs(parent: HTMLElement, counts: Record<TaskBoardTab, number>): void {
    const tabs = parent.createDiv({ cls: "pls-task-tabs" });
    const items: Array<{ id: TaskBoardTab; label: string }> = [
      { id: "today", label: "今日任务" },
      { id: "pending", label: "待完成" },
      { id: "done", label: "已完成" },
      { id: "auto", label: "自动延续" }
    ];
    for (const item of items) {
      const button = tabs.createEl("button", {
        cls: item.id === this.activeTab ? "is-active" : "",
        attr: { type: "button" }
      });
      button.createSpan({ text: item.label });
      button.createSpan({ cls: "pls-task-tab-count", text: String(counts[item.id]) });
      button.onclick = () => {
        this.activeTab = item.id;
        void this.render();
      };
    }
  }

  private renderTaskList(parent: HTMLElement, tasks: TaskItem[]): void {
    const list = parent.createDiv({ cls: "pls-task-list-card" });
    if (tasks.length === 0) {
      const empty = list.createDiv({ cls: "pls-product-empty-line" });
      empty.setText(this.activeTab === "done" ? "还没有已完成任务。" : "这里暂时没有任务，可以轻一点。");
      return;
    }

    for (const task of tasks) {
      this.renderTaskRow(list, task);
    }
  }

  private renderTaskRow(parent: HTMLElement, task: TaskItem): void {
    const row = parent.createDiv({ cls: task.isOpen ? "pls-task-board-row" : "pls-task-board-row is-done" });
    const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
    checkbox.checked = !task.isOpen;
    checkbox.disabled = !task.isOpen;
    checkbox.onchange = () => void this.completeTask(task);

    const body = row.createDiv({ cls: "pls-task-board-row-body" });
    body.createDiv({ cls: "pls-task-board-title", text: task.title || "未命名任务" });
    const meta = body.createDiv({ cls: "pls-task-board-meta" });
    const tags = task.tags.filter((tag) => tag !== "pls/task").slice(0, 3);
    for (const tag of tags) {
      meta.createSpan({ cls: "pls-task-chip", text: tag });
    }
    if (task.dueDate) {
      meta.createSpan({ cls: this.getDueTone(task.dueDate), text: `📅 ${task.dueDate}` });
    }
    if (task.carriedFromDate) {
      meta.createSpan({ cls: "pls-task-chip", text: `延续自 ${task.carriedFromDate}` });
    }

    const actions = row.createDiv({ cls: "pls-task-row-actions" });
    if (task.isOpen) {
      this.createIconAction(actions, "延续", "refresh-cw", () => void this.extendTask(task));
    }
    this.createIconAction(actions, "查看", "file-text", () => void this.openTaskFile(task.source === "done" ? "done.md" : "open.md"));
  }

  private renderMechanismRail(parent: HTMLElement, todayCount: number, autoCount: number, doneCount: number): void {
    const rail = parent.createDiv({ cls: "pls-task-mechanism-rail" });
    rail.createDiv({ cls: "pls-task-rail-title", text: "任务智能机制" });
    this.renderMechanismCard(rail, "跨日延续", "未完成任务可一键延续到明日，不遗漏重要事项。", "calendar-plus", "purple", autoCount);
    this.renderMechanismCard(rail, "自动归档", "完成后保留勾选状态，复盘时能看到行动痕迹。", "archive", "green", doneCount);
    this.renderMechanismCard(rail, "完成回顾", "今日任务聚合呈现，便于晚上做一次轻复盘。", "bar-chart-3", "orange", todayCount);
  }

  private renderMechanismCard(
    parent: HTMLElement,
    title: string,
    text: string,
    icon: string,
    tone: string,
    count: number
  ): void {
    const card = parent.createDiv({ cls: `pls-task-mechanism-card tone-${tone}` });
    setIcon(card.createSpan({ cls: "pls-task-mechanism-icon" }), icon);
    const copy = card.createDiv();
    copy.createDiv({ cls: "pls-task-mechanism-title", text: title });
    copy.createEl("p", { text });
    copy.createSpan({ cls: "pls-task-mechanism-count", text: `${count} 项` });
  }

  private getVisibleTasks(tasks: TaskItem[]): TaskItem[] {
    const today = formatDate();
    if (this.activeTab === "done") {
      return tasks.filter((task) => !task.isOpen).slice(0, 24);
    }
    const openTasks = tasks.filter((task) => task.isOpen);
    if (this.activeTab === "pending") {
      return openTasks.filter((task) => task.dueDate && task.dueDate > today);
    }
    if (this.activeTab === "auto") {
      return openTasks.filter((task) => !task.dueDate || task.dueDate < today);
    }
    return openTasks.filter((task) => !task.dueDate || task.dueDate === today);
  }

  private async loadTasks(): Promise<TaskItem[]> {
    await this.plugin.ensureBaseStructure();
    const open = await this.readTaskFile("open.md", "open");
    const done = await this.readTaskFile("done.md", "done");
    return [...open, ...done];
  }

  private async readTaskFile(fileName: "open.md" | "done.md", source: "open" | "done"): Promise<TaskItem[]> {
    const path = this.plugin.path("Tasks", fileName);
    const file = await ensureFile(this.app, path, fileName === "open.md" ? "# 未完成待办\n\n" : "# 已完成待办\n\n");
    const content = await this.app.vault.read(file);
    return content
      .split(/\r?\n/)
      .map((line) => parseTaskLine(line))
      .filter((task): task is ParsedTask => task !== null)
      .map((task) => ({ ...task, source }));
  }

  private async completeTask(task: TaskItem): Promise<void> {
    if (!task.isOpen) return;
    const updated = await completeAndArchiveTask(
      this.app,
      task.line,
      this.plugin.path("Tasks", "open.md"),
      this.plugin.path("Tasks", "done.md")
    );
    if (!updated) {
      new Notice("任务状态更新失败，请检查 open.md。");
      checkboxFocusReset(this.rootEl);
      return;
    }
    new Notice("已完成任务。");
    await this.render();
  }

  private async extendTask(task: TaskItem): Promise<void> {
    if (!task.isOpen) return;
    const path = this.plugin.path("Tasks", "open.md");
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowText = formatDate(tomorrow);
    const source = await this.app.vault.read(file);
    const nextLine = this.withDueDate(task, tomorrowText);
    if (nextLine === task.line) return;
    await this.app.vault.modify(file, source.replace(task.line, nextLine));
    new Notice(`已延续到 ${tomorrowText}`);
    await this.render();
  }

  private withDueDate(task: TaskItem, dueDate: string): string {
    if (task.dueDate) {
      return task.line.replace(/📅\s*\d{4}-\d{2}-\d{2}/, `📅 ${dueDate}`);
    }
    const blockSuffix = task.blockId ? ` ^${task.blockId}` : "";
    const withoutBlock = task.blockId
      ? task.line.replace(new RegExp(`\\s*\\^${escapeRegExp(task.blockId)}$`), "")
      : task.line;
    const carry = task.carriedFromDate ? "" : ` 📌 ${formatDate()}`;
    return `${withoutBlock}${carry} 📅 ${dueDate}${blockSuffix}`;
  }

  private getDueTone(dueDate: string): string {
    const today = formatDate();
    if (dueDate < today) return "pls-task-chip is-hot";
    if (dueDate === today) return "pls-task-chip is-today";
    return "pls-task-chip";
  }

  private async openTaskFile(fileName: "open.md" | "done.md"): Promise<void> {
    const path = this.plugin.path("Tasks", fileName);
    const file = await ensureFile(this.app, path, fileName === "open.md" ? "# 未完成待办\n\n" : "# 已完成待办\n\n");
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private createActionButton(parent: HTMLElement, label: string, icon: string, onClick: () => void, primary = false): void {
    const button = parent.createEl("button", { cls: primary ? "pls-btn-primary" : "", attr: { type: "button" } });
    setIcon(button.createSpan({ cls: "pls-button-icon" }), icon);
    button.createSpan({ text: label });
    button.onclick = onClick;
  }

  private createIconAction(parent: HTMLElement, label: string, icon: string, onClick: () => void): void {
    const button = parent.createEl("button", { attr: { type: "button", title: label, "aria-label": label } });
    setIcon(button, icon);
    button.onclick = onClick;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function checkboxFocusReset(root: HTMLElement): void {
  const active = root.ownerDocument.activeElement;
  if (active instanceof HTMLElement) {
    active.blur();
  }
}
