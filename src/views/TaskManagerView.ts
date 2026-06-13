import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { TASKS_VIEW_TYPE } from "../constants";
import type PersonalLifeSystemPlugin from "../main";
import { createButton } from "../components/Button";
import { createLifeOSShell } from "../components/LifeOSComponent";
import { ImportProjectDocumentsModal } from "../modals/ImportProjectDocumentsModal";
import { NewProjectDocumentModal } from "../modals/NewProjectDocumentModal";
import { NewProjectModal } from "../modals/NewProjectModal";
import { NewTaskModal } from "../modals/NewTaskModal";
import { requireProFeature } from "../licensing/entitlement";
import { FileSystemService } from "../services/FileSystemService";
import { ProjectDocumentService } from "../services/ProjectDocumentService";
import { ProjectService, type LifeOSProjectOverview } from "../services/ProjectService";
import { TaskService } from "../services/TaskService";
import type { LifeOSProject, LifeOSProjectDocument, LifeOSProjectSummary, LifeOSTask } from "../types";
import { formatDate, today } from "../utils/dates";
import { renderMarkdownDisplay } from "../utils/markdown-render";

export class TaskManagerView extends ItemView {
  private toastEl: HTMLElement | null = null;
  private selectedProjectId: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: PersonalLifeSystemPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return TASKS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "任务";
  }

  async onOpen(): Promise<void> {
    await this.render();
    this.registerEvent(this.app.vault.on("modify", () => void this.render()));
  }

  private async render(): Promise<void> {
    await this.plugin.ensureBaseStructure();
    const container = this.containerEl.children[1];
    container.empty();

    const shellMain = createLifeOSShell(container as HTMLElement, this.plugin, "tasks");
    shellMain.addClass("lifeos-task-workspace");

    const fs = new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);
    const service = new TaskService(this.app, fs);
    const projectService = new ProjectService(this.app, fs);
    const projectDocumentService = new ProjectDocumentService(this.app, fs);
    const all = await service.loadAllTasks();
    const open = all.filter((task) => task.source === "open" && !task.isDone);
    const done = all.filter((task) => task.source === "done" || task.isDone);
    const projects = await projectService.loadProjects();
    const overview = ProjectService.buildOverview(projects, open, done);
    const selectedSummary = this.findSelectedSummary(overview);
    const visibleOpen = selectedSummary ? selectedSummary.openTasks : open;
    const visibleDone = selectedSummary ? selectedSummary.doneTasks : done;
    const todayTasks = this.filterTodayTasks(visibleOpen);
    const defaultProjectId = this.selectedProjectId && this.selectedProjectId !== "unassigned" ? this.selectedProjectId : undefined;

    this.renderHeader(shellMain, defaultProjectId);
    this.toastEl = shellMain.createDiv({ cls: "lifeos-toast" });
    this.toastEl.hide();

    if (open.length === 0 && done.length === 0) {
      this.renderGlobalEmpty(shellMain);
    }

    const layout = shellMain.createDiv({ cls: "lifeos-project-task-layout" });
    this.renderProjectList(layout, overview);
    const detail = layout.createDiv({ cls: "lifeos-project-task-detail" });
    this.renderSummary(detail, todayTasks, visibleOpen, visibleDone);
    this.renderProjectTaskGroups(detail, overview, service);
    await this.renderProjectDocuments(detail, overview, projects, projectDocumentService);

    const board = detail.createDiv({ cls: visibleOpen.length === 0 && visibleDone.length === 0 ? "lifeos-board is-empty-board" : "lifeos-board" });
    this.renderColumn(board, "今日任务", "先处理重要的一件事", todayTasks.length ? todayTasks : visibleOpen.slice(0, 4), service, "calendar-check");
    this.renderColumn(board, "待完成", "仍在待办池，不会丢失", visibleOpen, service, "circle");
    this.renderColumn(board, "已完成", "完成后自动归档到这里", visibleDone.slice(0, 12), service, "check-circle-2", true);
    this.renderAutoColumn(board, visibleOpen.length, service);

  }

  private renderGlobalEmpty(parent: HTMLElement): void {
    const empty = parent.createDiv({ cls: "lifeos-task-global-empty" });
    empty.createEl("h2", { text: "今天还没有行动" });
    empty.createEl("p", { text: "先创建一个最小任务，或者从今日日记提取。" });
    const actions = empty.createDiv({ cls: "lifeos-toolbar" });
    createButton(actions, "新建任务", () => new NewTaskModal(this.app, this.plugin, () => this.render()).open(), { primary: true, icon: "plus" });
    createButton(actions, "从今日日记提取", () => void this.extractTasksFromToday(), { ghost: true, icon: "wand-2" });
  }

  private renderHeader(parent: HTMLElement, defaultProjectId?: string): void {
    const header = parent.createDiv({ cls: "lifeos-page-header lifeos-task-page-header" });
    const copy = header.createDiv();
    copy.createDiv({ cls: "lifeos-kicker", text: "任务" });
    copy.createEl("h1", { text: "行动清单" });
    copy.createEl("p", { text: "把今天要推进的事放在这里。完成后归档，未完成会延续，不会丢失。" });
    const toolbar = header.createDiv({ cls: "lifeos-toolbar" });
    createButton(toolbar, "新建任务", () => new NewTaskModal(this.app, this.plugin, () => this.render(), defaultProjectId).open(), { primary: true, icon: "plus" });
    createButton(toolbar, "新增项目", () => {
      if (!requireProFeature(this.plugin, "projectManagement")) return;
      new NewProjectModal(this.app, this.plugin, () => this.render()).open();
    }, { primary: true, icon: "folder-plus" });
    createButton(toolbar, "从今日日记提取", () => void this.extractTasksFromToday(), { ghost: true, icon: "wand-2" });
  }

  private renderSummary(parent: HTMLElement, todayTasks: LifeOSTask[], open: LifeOSTask[], done: LifeOSTask[]): void {
    const stats = parent.createDiv({ cls: "lifeos-task-summary-grid" });
    this.summaryItem(stats, "今日任务", String(todayTasks.length || open.length), "今天优先处理", "calendar-check");
    this.summaryItem(stats, "待完成", String(open.length), "仍在待办池", "circle");
    this.summaryItem(stats, "已完成", String(done.length), "已归档", "check-circle-2");
    this.summaryItem(stats, "自动延续", String(open.length), "未完成会到明天", "refresh-cw");
  }

  private summaryItem(parent: HTMLElement, label: string, value: string, hint: string, icon: string): void {
    const item = parent.createDiv({ cls: "lifeos-subtle-card lifeos-task-summary-item" });
    setIcon(item.createSpan({ cls: "lifeos-status-icon" }), icon);
    const copy = item.createDiv();
    copy.createEl("strong", { text: value });
    copy.createSpan({ text: label });
    copy.createDiv({ cls: "lifeos-muted-text", text: hint });
  }

  private renderProjectList(parent: HTMLElement, overview: LifeOSProjectOverview): void {
    const panel = parent.createDiv({ cls: "lifeos-project-panel" });
    panel.createEl("h2", { text: "项目筛选" });
    panel.createEl("p", {
      text: this.selectedProjectId ? "当前只显示选中项目的任务。" : "当前显示全部项目待办。"
    });
    this.renderProjectOption(
      panel,
      "all",
      "全部项目待办",
      overview.all.openCount,
      overview.all.progress,
      this.selectedProjectId === null,
      () => {
        this.selectedProjectId = null;
        void this.render();
      }
    );
    for (const summary of overview.projects) {
      this.renderProjectOption(
        panel,
        summary.projectId ?? "",
        summary.label,
        summary.openCount,
        summary.progress,
        this.selectedProjectId === summary.projectId,
        () => {
          this.selectedProjectId = summary.projectId ?? null;
          void this.render();
        }
      );
    }
    this.renderProjectOption(
      panel,
      "unassigned",
      "未归属任务",
      overview.unassigned.openCount,
      overview.unassigned.progress,
      this.selectedProjectId === "unassigned",
      () => {
        this.selectedProjectId = "unassigned";
        void this.render();
      }
    );
    createButton(panel, "新增项目", () => {
      if (!requireProFeature(this.plugin, "projectManagement")) return;
      new NewProjectModal(this.app, this.plugin, () => this.render()).open();
    }, {
      ghost: true,
      icon: "folder-plus"
    });
  }

  private renderProjectOption(
    parent: HTMLElement,
    id: string,
    label: string,
    openCount: number,
    progress: number,
    active: boolean,
    onClick: () => void
  ): void {
    const item = parent.createEl("button", {
      cls: active ? "lifeos-project-option is-active" : "lifeos-project-option",
      attr: { type: "button", "data-project-id": id }
    });
    item.onclick = onClick;
    this.renderProgressRing(item, progress, `${progress}%`);
    const copy = item.createDiv();
    copy.createEl("strong", { text: label });
    copy.createSpan({ text: `${openCount} 个待办` });
  }

  private renderProgressRing(parent: HTMLElement, progress: number, label: string): HTMLElement {
    const ring = parent.createDiv({ cls: "lifeos-project-ring" });
    ring.style.setProperty("--lifeos-project-progress", `${Math.max(0, Math.min(progress, 100))}%`);
    ring.createSpan({ text: label });
    return ring;
  }

  private renderProjectTaskGroups(parent: HTMLElement, overview: LifeOSProjectOverview, service: TaskService): void {
    const panel = parent.createDiv({ cls: "lifeos-project-task-panel" });
    const groups = this.selectedProjectId === null
      ? [...overview.projects, overview.unassigned].filter((group) => group.openCount > 0)
      : [this.findSelectedSummary(overview)].filter((group): group is LifeOSProjectSummary => Boolean(group));

    if (groups.length === 0) {
      const empty = panel.createDiv({ cls: "lifeos-project-task-empty" });
      empty.createEl("strong", { text: "暂无项目待办" });
      empty.createSpan({ text: "没有选择项目时，这里会按项目展示所有未完成任务。" });
      createButton(empty, "新建任务", () => new NewTaskModal(this.app, this.plugin, () => this.render()).open(), {
        ghost: true,
        icon: "plus"
      });
      return;
    }

    for (const group of groups) {
      const section = panel.createDiv({ cls: "lifeos-project-task-group" });
      const head = section.createDiv({ cls: "lifeos-project-task-group-head" });
      this.renderProgressRing(head, group.progress, `${group.progress}%`);
      const copy = head.createDiv();
      copy.createEl("strong", { text: group.label });
      copy.createSpan({ text: `${group.doneCount}/${group.totalCount} 已完成，${group.openCount} 个待办` });
      createButton(
        head,
        "新增任务",
        () => new NewTaskModal(this.app, this.plugin, () => this.render(), group.projectId).open(),
        { ghost: true, icon: "plus" }
      );

      if (group.openTasks.length === 0) {
        section.createDiv({ cls: "lifeos-project-task-empty", text: "这个项目当前没有待办。" });
      }

      for (const task of group.openTasks.slice(0, 8)) {
        this.renderBoardCard(section, task, service, false);
      }
    }
  }

  private async renderProjectDocuments(
    parent: HTMLElement,
    overview: LifeOSProjectOverview,
    projects: LifeOSProject[],
    service: ProjectDocumentService
  ): Promise<void> {
    const panel = parent.createDiv({ cls: "lifeos-project-doc-panel" });
    const head = panel.createDiv({ cls: "lifeos-project-doc-head" });
    const copy = head.createDiv({ cls: "lifeos-project-doc-head-copy" });
    copy.createEl("h2", { text: "项目文档" });
    copy.createEl("p", {
      text: this.selectedProjectId && this.selectedProjectId !== "unassigned"
        ? "管理当前项目的专属资料，AI 助手选择该项目后会优先读取这里。"
        : "未选择项目时，这里展示所有项目已有文档；选择某个项目后可以新增和管理。"
    });

    const selectedProject = this.selectedProjectId && this.selectedProjectId !== "unassigned"
      ? projects.find((project) => project.id === this.selectedProjectId) ?? null
      : null;

    if (selectedProject) {
      const actions = head.createDiv({ cls: "lifeos-project-doc-head-actions" });
      createButton(actions, "新增文档", () => void this.createProjectDocument(selectedProject, service), {
        primary: true,
        icon: "file-plus"
      });
      createButton(actions, "导入文档", () => void this.importProjectDocuments(selectedProject, service), {
        primary: true,
        icon: "upload"
      });
      createButton(actions, "打开项目目录", () => void this.openProjectIndex(selectedProject, service), {
        ghost: true,
        icon: "folder-open"
      });
      const docs = await service.listDocuments(selectedProject);
      this.renderProjectDocumentList(panel, selectedProject, docs, service, true);
      return;
    }

    if (overview.projects.length === 0) {
      panel.createDiv({ cls: "lifeos-project-doc-empty", text: "还没有项目。先新增项目，再为项目沉淀专属文档。" });
      return;
    }

    let rendered = 0;
    for (const project of projects) {
      const docs = await service.listDocuments(project);
      if (docs.length === 0) continue;
      this.renderProjectDocumentList(panel, project, docs.slice(0, 4), service, false);
      rendered += 1;
    }

    if (rendered === 0) {
      panel.createDiv({ cls: "lifeos-project-doc-empty", text: "当前还没有项目文档。选择左侧项目后可以新增文档。" });
    }
  }

  private renderProjectDocumentList(
    parent: HTMLElement,
    project: LifeOSProject,
    docs: LifeOSProjectDocument[],
    service: ProjectDocumentService,
    editable: boolean
  ): void {
    const group = parent.createDiv({ cls: "lifeos-project-doc-group" });
    const title = group.createDiv({ cls: "lifeos-project-doc-group-title" });
    title.createEl("strong", { text: project.name });
    title.createSpan({ text: `${docs.length} 篇文档` });

    if (docs.length === 0) {
      group.createDiv({ cls: "lifeos-project-doc-empty", text: "这个项目还没有专属文档。" });
      return;
    }

    for (const doc of docs) {
      const item = group.createDiv({ cls: "lifeos-project-doc-item" });
      const body = item.createDiv({ cls: "lifeos-project-doc-body" });
      body.createEl("strong", { text: doc.title });
      body.createSpan({ text: doc.path });
      if (doc.excerpt) body.createDiv({ cls: "lifeos-project-doc-excerpt", text: doc.excerpt });
      const actions = item.createDiv({ cls: "lifeos-project-doc-actions" });
      createButton(actions, "打开", () => void this.openProjectDocument(doc.path), { ghost: true, icon: "file-text" });
      if (!editable) continue;
      createButton(actions, "重命名", () => void this.renameProjectDocument(project, doc, service), { ghost: true, icon: "pencil" });
      createButton(actions, "删除", () => void this.deleteProjectDocument(project, doc, service), {
        ghost: true,
        icon: "trash-2",
        className: "lifeos-button-danger"
      });
    }
  }

  private async createProjectDocument(project: LifeOSProject, service: ProjectDocumentService): Promise<void> {
    if (!requireProFeature(this.plugin, "projectDocuments")) return;
    new NewProjectDocumentModal(this.app, project, service, async (doc) => {
      await this.openProjectDocument(doc.path);
      await this.render();
    }).open();
  }

  private async importProjectDocuments(project: LifeOSProject, service: ProjectDocumentService): Promise<void> {
    if (!requireProFeature(this.plugin, "projectDocuments")) return;
    new ImportProjectDocumentsModal(this.app, project, service, async (documents) => {
      const first = documents[0]?.document;
      if (first) await this.openProjectDocument(first.path);
      await this.render();
    }).open();
  }

  private async renameProjectDocument(project: LifeOSProject, doc: LifeOSProjectDocument, service: ProjectDocumentService): Promise<void> {
    if (!requireProFeature(this.plugin, "projectDocuments")) return;
    const title = window.prompt("新的文档标题", doc.title);
    if (!title?.trim() || title.trim() === doc.title) return;
    await service.renameDocument(project, doc, title);
    new Notice("项目文档已重命名。");
    await this.render();
  }

  private async deleteProjectDocument(project: LifeOSProject, doc: LifeOSProjectDocument, service: ProjectDocumentService): Promise<void> {
    if (!requireProFeature(this.plugin, "projectDocuments")) return;
    if (!window.confirm(`确认把「${doc.title}」移动到项目 Trash 吗？`)) return;
    await service.deleteDocument(project, doc);
    new Notice("项目文档已移动到 Trash。");
    await this.render();
  }

  private async openProjectIndex(project: LifeOSProject, service: ProjectDocumentService): Promise<void> {
    if (!requireProFeature(this.plugin, "projectDocuments")) return;
    await service.ensureProjectSpace(project);
    await this.openProjectDocument(`${service.projectRootPath(project)}/index.md`);
  }

  private async openProjectDocument(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice("文档不存在或已被移动。");
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private renderColumn(
    board: HTMLElement,
    title: string,
    hint: string,
    tasks: LifeOSTask[],
    service: TaskService,
    icon: string,
    done = false
  ): void {
    const column = board.createDiv({ cls: "lifeos-board-column" });
    const head = column.createDiv({ cls: "lifeos-board-column-header" });
    const titleEl = head.createDiv();
    setIcon(titleEl.createSpan({ cls: "lifeos-status-icon" }), icon);
    titleEl.createSpan({ text: title });
    head.createSpan({ cls: "lifeos-badge", text: String(tasks.length) });
    column.createDiv({ cls: "lifeos-board-column-hint", text: hint });

    if (tasks.length === 0) {
      const empty = column.createDiv({ cls: "lifeos-board-empty" });
      empty.createDiv({ text: "暂无任务" });
      createButton(empty, "新建任务", () => new NewTaskModal(this.app, this.plugin, () => this.render()).open(), { ghost: true, icon: "plus" });
      return;
    }

    for (const task of tasks.slice(0, 12)) {
      this.renderBoardCard(column, task, service, done);
    }
  }

  private renderBoardCard(parent: HTMLElement, task: LifeOSTask, service: TaskService, doneColumn: boolean): void {
    const card = parent.createDiv({ cls: doneColumn ? "lifeos-board-card is-done" : "lifeos-board-card" });
    const top = card.createDiv({ cls: "lifeos-board-card-top" });
    const checkbox = top.createEl("input", { attr: { type: "checkbox", "aria-label": doneColumn ? "已完成任务" : "标记完成" } });
    checkbox.checked = task.isDone || doneColumn;
    checkbox.disabled = doneColumn;
    checkbox.onchange = async () => {
      await service.completeTask(task);
      await this.render();
      this.showUndoToast(task);
    };
    renderMarkdownDisplay(this.app, this, top.createDiv({ cls: "lifeos-board-card-title" }), task.text);
    const meta = card.createDiv({ cls: "lifeos-board-card-meta" });
    meta.createSpan({ text: task.date || "今天" });
    meta.createSpan({ text: task.source === "open" ? "待办任务" : "已归档" });
    for (const tag of task.tags.slice(0, 2)) meta.createSpan({ cls: "lifeos-badge", text: tag });
  }

  private renderAutoColumn(board: HTMLElement, openCount: number, service: TaskService): void {
    const column = board.createDiv({ cls: "lifeos-board-column lifeos-board-column-note" });
    const head = column.createDiv({ cls: "lifeos-board-column-header" });
    const title = head.createDiv();
    setIcon(title.createSpan({ cls: "lifeos-status-icon" }), "refresh-cw");
    title.createSpan({ text: "自动延续" });
    head.createSpan({ cls: "lifeos-badge", text: String(openCount) });
    column.createDiv({ cls: "lifeos-board-column-hint", text: "未完成任务会自动延续到明天，不会丢失。" });
    const note = column.createDiv({ cls: "lifeos-board-empty lifeos-auto-note" });
    note.createDiv({ text: openCount > 0 ? `${openCount} 个任务仍在待办池。` : "当前没有需要延续的任务。" });
    createButton(note, openCount > 0 ? "延续到明天" : "暂无需要延续", () => void this.carryover(service), {
      icon: "arrow-right",
      ghost: true
    }).disabled = openCount === 0;
  }

  private filterTodayTasks(open: LifeOSTask[]): LifeOSTask[] {
    const date = today();
    return open.filter((task) => !task.date || task.date === date || task.line.includes(date));
  }

  private findSelectedSummary(overview: LifeOSProjectOverview): LifeOSProjectSummary | null {
    if (this.selectedProjectId === "unassigned") return overview.unassigned;
    if (!this.selectedProjectId) return null;
    return overview.projects.find((item) => item.projectId === this.selectedProjectId) ?? null;
  }

  private async extractTasksFromToday(): Promise<void> {
    if (!requireProFeature(this.plugin, "aiTaskExtract")) return;
    const file = this.app.vault.getAbstractFileByPath(this.plugin.getTodayNotePath(today()));
    if (!(file instanceof TFile)) {
      new Notice("还没有今日日记，先创建一篇再提取待办。");
      await this.plugin.openTodayNote(false);
      return;
    }
    await this.plugin.extractTasksFromFile(file);
  }

  private async carryover(service: TaskService): Promise<void> {
    if (!requireProFeature(this.plugin, "taskAutoCarryover")) return;
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const count = await service.carryoverToTomorrow(formatDate(now), formatDate(tomorrow));
    new Notice(count > 0 ? `已延续 ${count} 个任务到明天` : "没有需要延续的任务");
    await this.render();
  }

  private showUndoToast(task: LifeOSTask): void {
    new Notice("任务已完成，可撤销", 5000);
    if (!this.toastEl) return;
    this.toastEl.empty();
    this.toastEl.show();
    this.toastEl.createSpan({ text: "任务已完成，可撤销" });
    createButton(this.toastEl, "撤销", async () => {
      await this.service().undoCompleteTask(task.line);
      new Notice("已撤销完成状态");
      await this.render();
    }, { ghost: true });
    window.setTimeout(() => this.toastEl?.hide(), 5000);
  }

  private service(): TaskService {
    return new TaskService(this.app, new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage));
  }
}
