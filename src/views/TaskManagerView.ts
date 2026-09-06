import type { App, TAbstractFile } from "obsidian";
import { ItemView, Modal, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { TASKS_VIEW_TYPE } from "../constants";
import type PersonalLifeSystemPlugin from "../main";
import { createButton } from "../components/Button";
import { createLifeOSShell } from "../components/LifeOSComponent";
import { createModalShell } from "../components/ModalShell";
import { ImportProjectDocumentsModal } from "../modals/ImportProjectDocumentsModal";
import { NewProjectDocumentModal } from "../modals/NewProjectDocumentModal";
import { NewProjectModal } from "../modals/NewProjectModal";
import { NewTaskModal } from "../modals/NewTaskModal";
import { requireProFeature } from "../licensing/entitlement";
import { FileSystemService } from "../services/FileSystemService";
import { ProjectDocumentService, type ProjectDocumentAiFormatterInput } from "../services/ProjectDocumentService";
import { PdfOcrService } from "../services/PdfOcrService";
import { ProjectService, type LifeOSProjectOverview } from "../services/ProjectService";
import {
  ProjectWhiteboardService,
  type ProjectWhiteboardGenerateOptions,
  type ProjectWhiteboardStyle
} from "../services/ProjectWhiteboardService";
import { TaskService, type TaskBatchUpdate, type TaskLane } from "../services/TaskService";
import type { LifeOSProject, LifeOSProjectDocument, LifeOSProjectSummary, LifeOSTask } from "../types";
import { formatDate, today } from "../utils/dates";
import { renderMarkdownDisplay } from "../utils/markdown-render";
import {
  captureStableViewState,
  renderStableView,
  restoreStableViewState
} from "../utils/stable-view-refresh";

const TASK_COLUMN_PAGE_SIZE = 10;
const TASK_COLUMN_INITIAL_LIMIT: Record<"today" | "open" | "done", number> = {
  today: 6,
  open: 10,
  done: 8
};

export class TaskManagerView extends ItemView {
  private toastEl: HTMLElement | null = null;
  private selectedProjectId: string | null = null;
  private refreshTimer: number | null = null;
  private renderPromise: Promise<void> | null = null;
  private renderQueued = false;
  private renderRequestRevision = 0;
  private preserveScrollOnNextRender = true;
  private vaultRefreshSuppression = 0;
  private selectedTaskKeys = new Set<string>();
  private updateTaskBatchUi: (() => void) | null = null;
  private taskColumnVisibleLimits = new Map<string, number>();
  private projectDocumentsExpanded = false;
  private draggedTask: LifeOSTask | null = null;

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
    this.renderLoadingState();
    void this.render(false);
    const refresh = (file: TAbstractFile): void => {
      if (this.vaultRefreshSuppression > 0 || !this.shouldRefreshForFile(file)) return;
      this.scheduleVaultRefresh();
    };
    this.registerEvent(this.app.vault.on("create", refresh));
    this.registerEvent(this.app.vault.on("modify", refresh));
    this.registerEvent(this.app.vault.on("delete", refresh));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (this.vaultRefreshSuppression > 0) return;
      if (this.shouldRefreshForFile(file) || this.shouldRefreshForFile(oldPath)) this.scheduleVaultRefresh();
    }));
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.renderRequestRevision += 1;
  }

  /** Refresh hook used by the shared Agent after changing task view preferences. */
  refreshFromExternalChange(): void {
    void this.render(true);
  }

  private scheduleVaultRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.render(true);
    }, 120);
  }

  private shouldRefreshForFile(file: TAbstractFile | string): boolean {
    const path = (typeof file === "string" ? file : file.path).replace(/\\/g, "/");
    const fs = new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);
    const roots = [fs.path("Tasks"), fs.path("Projects")]
      .map((entry) => entry.replace(/\\/g, "/").replace(/\/+$/g, ""));
    return roots.some((root) => path === root || path.startsWith(`${root}/`));
  }

  private async withVaultRefreshSuppressed<T>(operation: () => Promise<T>): Promise<T> {
    this.vaultRefreshSuppression += 1;
    try {
      return await operation();
    } finally {
      this.vaultRefreshSuppression = Math.max(0, this.vaultRefreshSuppression - 1);
    }
  }

  private async render(preserveScroll = true): Promise<void> {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.renderRequestRevision += 1;
    this.renderQueued = true;
    this.preserveScrollOnNextRender = preserveScroll;
    if (this.renderPromise) return this.renderPromise;

    const run = async (): Promise<void> => {
      while (this.renderQueued) {
        this.renderQueued = false;
        const revision = this.renderRequestRevision;
        const shouldPreserveScroll = this.preserveScrollOnNextRender;
        await this.renderPass(revision, shouldPreserveScroll);
      }
    };
    this.renderPromise = run().finally(() => {
      this.renderPromise = null;
    });
    return this.renderPromise;
  }

  private async renderPass(revision: number, preserveScroll: boolean): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement | undefined;
    if (!container) return;
    // Capture before any asynchronous reads. If another refresh is already in
    // flight, waiting until the DOM swap can otherwise snapshot a scrollTop
    // that Obsidian has already reset after the clicked control lost focus.
    const stableViewState = preserveScroll ? captureStableViewState(container) : null;
    try {
      await this.plugin.ensureBaseStructure();
      if (revision !== this.renderRequestRevision) return;
      const fs = new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);
      const service = new TaskService(this.app, fs);
      const projectService = new ProjectService(this.app, fs);
      const projectDocumentService = this.createProjectDocumentService(fs);
      const projectWhiteboardService = new ProjectWhiteboardService(this.app, fs);
      const [all, projects] = await Promise.all([service.loadAllTasks(), projectService.loadProjects()]);
      if (revision !== this.renderRequestRevision) return;
      const open = all.filter((task) => task.source === "open" && !task.isDone);
      const done = all.filter((task) => task.source === "done" || task.isDone);
      const overview = ProjectService.buildOverview(projects, open, done);
      const selectedSummary = this.findSelectedSummary(overview);
      const visibleOpen = selectedSummary ? selectedSummary.openTasks : open;
      const visibleDone = selectedSummary ? selectedSummary.doneTasks : done;
      const showCompleted = this.plugin.settings.taskManagerShowCompleted !== false;
      const displayedDone = showCompleted ? visibleDone : [];
      const visibleTaskKeys = new Set([...visibleOpen, ...displayedDone].map((task) => this.taskStableKey(task)));
      this.selectedTaskKeys = new Set([...this.selectedTaskKeys].filter((key) => visibleTaskKeys.has(key)));
      const todayTasks = this.filterTodayTasks(visibleOpen);
      const pendingTasks = visibleOpen.filter((task) => this.taskLane(task) === "open");
      const defaultProjectId = this.selectedProjectId && this.selectedProjectId !== "unassigned" ? this.selectedProjectId : undefined;
      this.updateTaskBatchUi = null;
      let nextToastEl: HTMLElement | null = null;
      let projectDocumentsSlot: HTMLElement | null = null;
      const swapped = await renderStableView(container, (staging) => {
        const shellMain = createLifeOSShell(staging, this.plugin, "tasks");
        shellMain.addClass("lifeos-task-workspace");

        this.renderHeader(shellMain, defaultProjectId);
        nextToastEl = shellMain.createDiv({ cls: "lifeos-toast" });
        nextToastEl.hide();

        const layout = shellMain.createDiv({ cls: "lifeos-project-task-layout" });
        this.renderProjectList(layout, overview);
        const detail = layout.createDiv({ cls: "lifeos-project-task-detail" });
        this.renderSummary(detail, todayTasks, pendingTasks, visibleDone);
        projectDocumentsSlot = this.renderProjectDocumentsLoading(detail);
        this.renderTaskBatchToolbar(detail, {
          today: todayTasks,
          open: pendingTasks,
          done: displayedDone
        }, service, projects, done.length);

        const boardClasses = [
          "lifeos-board",
          visibleOpen.length === 0 && displayedDone.length === 0 ? "is-empty-board" : "",
          showCompleted ? "" : "is-completed-hidden"
        ].filter(Boolean).join(" ");
        const board = detail.createDiv({ cls: boardClasses });
        this.renderColumn(board, "today", "今日任务", "今天明确要推进的任务", todayTasks, service, "calendar-check");
        this.renderColumn(board, "open", "待完成", "仍在待办池，不会丢失", pendingTasks, service, "circle");
        if (showCompleted) this.renderColumn(board, "done", "已完成", "完成后自动归档到这里", visibleDone, service, "check-circle-2");
        this.renderAutoColumn(board, visibleOpen.length, service);
      }, {
        preserveScroll: false,
        isCurrent: () => revision === this.renderRequestRevision
      });
      if (!swapped) return;
      if (stableViewState) {
        restoreStableViewState(container, stableViewState, () => revision === this.renderRequestRevision);
      }
      this.toastEl = nextToastEl;
      if (projectDocumentsSlot) {
        void this.hydrateProjectDocuments(
          projectDocumentsSlot,
          revision,
          overview,
          projects,
          projectDocumentService,
          projectWhiteboardService
        );
      }
    } catch (error) {
      if (revision !== this.renderRequestRevision) return;
      console.error("[Life OS] Failed to render task manager", error);
      this.renderTaskErrorState(container, error);
    }
  }

  private renderLoadingState(): void {
    const container = this.containerEl.children[1] as HTMLElement | undefined;
    if (!container) return;
    container.empty();
    const main = createLifeOSShell(container, this.plugin, "tasks");
    main.addClass("lifeos-task-workspace", "is-loading");

    const header = main.createDiv({ cls: "lifeos-page-header lifeos-task-page-header lifeos-task-loading-header" });
    const copy = header.createDiv();
    copy.createDiv({ cls: "lifeos-kicker", text: "任务" });
    copy.createEl("h1", { text: "行动清单" });
    copy.createEl("p", { text: "页面已打开，正在读取任务和项目；项目文档会随后加载。" });
    const status = header.createDiv({ cls: "lifeos-task-loading-status" });
    setIcon(status.createSpan(), "loader");
    status.createSpan({ text: "正在加载任务" });

    const stats = main.createDiv({ cls: "lifeos-task-summary-grid lifeos-task-loading-stats" });
    for (const label of ["今日任务", "待完成", "已完成", "自动延续"]) {
      const card = stats.createDiv({ cls: "lifeos-subtle-card lifeos-task-summary-item lifeos-task-loading-card" });
      card.createDiv({ cls: "lifeos-task-skeleton is-icon" });
      const cardCopy = card.createDiv();
      cardCopy.createDiv({ cls: "lifeos-task-skeleton is-value" });
      cardCopy.createSpan({ text: label });
      cardCopy.createDiv({ cls: "lifeos-task-skeleton is-caption" });
    }

    const layout = main.createDiv({ cls: "lifeos-project-task-layout lifeos-task-loading-layout" });
    const projects = layout.createDiv({ cls: "lifeos-project-panel lifeos-task-loading-panel" });
    projects.createEl("h2", { text: "项目筛选" });
    projects.createEl("p", { text: "正在读取项目…" });
    for (let index = 0; index < 4; index += 1) projects.createDiv({ cls: "lifeos-task-skeleton is-row" });
    const detail = layout.createDiv({ cls: "lifeos-project-task-detail lifeos-task-loading-detail" });
    for (let index = 0; index < 3; index += 1) detail.createDiv({ cls: "lifeos-task-skeleton is-panel" });
  }

  private renderTaskErrorState(container: HTMLElement, error: unknown): void {
    container.empty();
    const main = createLifeOSShell(container, this.plugin, "tasks");
    main.addClass("lifeos-task-workspace");
    const card = main.createDiv({ cls: "lifeos-task-load-error" });
    setIcon(card.createSpan({ cls: "lifeos-task-load-error-icon" }), "triangle-alert");
    const copy = card.createDiv();
    copy.createEl("h2", { text: "任务加载失败" });
    copy.createEl("p", { text: error instanceof Error ? error.message : "暂时无法读取任务，请重试。" });
    createButton(card, "重新加载", () => {
      this.renderLoadingState();
      void this.render(false);
    }, { primary: true, icon: "refresh-cw" });
  }

  private renderProjectDocumentsLoading(parent: HTMLElement): HTMLElement {
    const slot = parent.createDiv({ cls: "lifeos-project-doc-slot" });
    const panel = slot.createDiv({ cls: "lifeos-project-doc-panel is-loading is-collapsed" });
    const head = panel.createDiv({ cls: "lifeos-project-doc-head" });
    const copy = head.createDiv({ cls: "lifeos-project-doc-head-copy" });
    copy.createEl("h2", { text: "项目文档" });
    copy.createEl("p", { text: "默认收起；文档正在后台读取。" });
    const status = head.createDiv({ cls: "lifeos-project-doc-loading-status" });
    setIcon(status.createSpan(), "loader");
    status.createSpan({ text: "加载中" });
    return slot;
  }

  private async hydrateProjectDocuments(
    slot: HTMLElement,
    revision: number,
    overview: LifeOSProjectOverview,
    projects: LifeOSProject[],
    service: ProjectDocumentService,
    whiteboards: ProjectWhiteboardService
  ): Promise<void> {
    try {
      await this.withVaultRefreshSuppressed(() => renderStableView(slot, async (staging) => {
        await this.renderProjectDocuments(staging, overview, projects, service, whiteboards);
      }, {
        preserveScroll: true,
        isCurrent: () => revision === this.renderRequestRevision && slot.isConnected
      }));
    } catch (error) {
      if (revision !== this.renderRequestRevision || !slot.isConnected) return;
      await renderStableView(slot, (staging) => {
        const panel = staging.createDiv({ cls: "lifeos-project-doc-panel is-error" });
        panel.createEl("h2", { text: "项目文档暂时无法加载" });
        panel.createEl("p", { text: error instanceof Error ? error.message : "请稍后重试。" });
        createButton(panel, "重试", () => void this.hydrateProjectDocuments(
          slot,
          revision,
          overview,
          projects,
          service,
          whiteboards
        ), { ghost: true, icon: "refresh-cw" });
      }, {
        preserveScroll: true,
        isCurrent: () => revision === this.renderRequestRevision && slot.isConnected
      });
    }
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

  private renderSummary(parent: HTMLElement, todayTasks: LifeOSTask[], pendingTasks: LifeOSTask[], done: LifeOSTask[]): void {
    const stats = parent.createDiv({ cls: "lifeos-task-summary-grid" });
    this.summaryItem(stats, "今日任务", String(todayTasks.length), "今天优先处理", "calendar-check");
    this.summaryItem(stats, "待完成", String(pendingTasks.length), "仍在待办池", "circle");
    this.summaryItem(stats, "已完成", String(done.length), "已归档", "check-circle-2");
    this.summaryItem(stats, "自动延续", String(todayTasks.length + pendingTasks.length), "未完成会到明天", "refresh-cw");
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
    const options = panel.createDiv({ cls: "lifeos-project-options" });
    this.renderProjectOption(
      options,
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
        options,
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
      options,
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
    createButton(options, "新增项目", () => {
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
    const copy = item.createDiv({ cls: "lifeos-project-option-copy" });
    const row = copy.createDiv({ cls: "lifeos-project-option-row" });
    row.createEl("strong", { text: label });
    row.createSpan({ text: `${openCount} 个待办 · ${progress}%` });
    const progressTrack = copy.createDiv({
      cls: "lifeos-project-progress-track",
      attr: {
        role: "progressbar",
        "aria-label": `${label}完成进度`,
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": String(Math.max(0, Math.min(progress, 100)))
      }
    });
    const progressFill = progressTrack.createDiv({ cls: "lifeos-project-progress-fill" });
    progressFill.setCssProps({
      "--lifeos-project-progress": `${Math.max(0, Math.min(progress, 100))}%`
    });
  }

  private async renderProjectDocuments(
    parent: HTMLElement,
    overview: LifeOSProjectOverview,
    projects: LifeOSProject[],
    service: ProjectDocumentService,
    whiteboards: ProjectWhiteboardService
  ): Promise<void> {
    const selectedProject = this.selectedProjectId && this.selectedProjectId !== "unassigned"
      ? projects.find((project) => project.id === this.selectedProjectId) ?? null
      : null;
    const projectDocuments = selectedProject
      ? [{ project: selectedProject, docs: await service.listDocuments(selectedProject) }]
      : await Promise.all(projects.map(async (project) => ({
        project,
        docs: await service.listDocuments(project)
      })));
    const totalDocuments = projectDocuments.reduce((total, entry) => total + entry.docs.length, 0);
    const panel = parent.createDiv({
      cls: `lifeos-project-doc-panel${this.projectDocumentsExpanded ? "" : " is-collapsed"}`
    });
    const head = panel.createDiv({ cls: "lifeos-project-doc-head" });
    const copy = head.createDiv({ cls: "lifeos-project-doc-head-copy" });
    copy.createEl("h2", { text: "项目文档" });
    copy.createEl("p", {
      text: selectedProject
        ? `${selectedProject.name} · ${totalDocuments} 篇；默认收起，不遮挡任务。`
        : `${totalDocuments} 篇项目资料；选择项目后可新增、导入和管理。`
    });
    const contentId = `lifeos-project-doc-content-${(this.selectedProjectId ?? "all").replace(/[^A-Za-z0-9_-]/gu, "-")}`;
    const content = panel.createDiv({ cls: "lifeos-project-doc-content", attr: { id: contentId } });
    let contentRendered = false;
    const renderContent = (): void => {
      if (contentRendered) return;
      contentRendered = true;

      if (selectedProject) {
        const docs = projectDocuments[0]?.docs ?? [];
        const summary = this.summaryForProject(selectedProject, overview);
        const actions = content.createDiv({ cls: "lifeos-project-doc-head-actions lifeos-project-doc-content-actions" });
        createButton(actions, "生成白板", () => {
          void this.openProjectWhiteboardModal(selectedProject, summary, docs, overview, whiteboards);
        }, { primary: true, icon: "network" });
        createButton(actions, "资料生成白板", () => {
          void this.importProjectDocumentsToWhiteboard(selectedProject, summary, service, whiteboards, overview);
        }, { ghost: true, icon: "files" });
        createButton(actions, "打开最近白板", () => void this.openLatestProjectWhiteboard(selectedProject, whiteboards), {
          ghost: true,
          icon: "panel-top-open"
        });
        createButton(actions, "新增文档", () => void this.createProjectDocument(selectedProject, service), {
          ghost: true,
          icon: "file-plus"
        });
        createButton(actions, "导入文档", () => void this.importProjectDocuments(selectedProject, service), {
          ghost: true,
          icon: "upload"
        });
        createButton(actions, "打开项目目录", () => void this.openProjectIndex(selectedProject, service), {
          ghost: true,
          icon: "folder-open"
        });
        this.renderProjectDocumentList(content, selectedProject, docs, service, true);
        return;
      }

      if (overview.projects.length === 0) {
        content.createDiv({ cls: "lifeos-project-doc-empty", text: "还没有项目。先新增项目，再为项目沉淀专属文档。" });
        return;
      }

      let rendered = 0;
      for (const { project, docs } of projectDocuments) {
        if (docs.length === 0) continue;
        this.renderProjectDocumentList(content, project, docs, service, false, 4);
        rendered += 1;
      }
      if (rendered === 0) {
        content.createDiv({ cls: "lifeos-project-doc-empty", text: "当前还没有项目文档。选择左侧项目后可以新增文档。" });
      }
    };
    const collapsedLabel = `展开项目文档${totalDocuments > 0 ? `（${totalDocuments}）` : ""}`;
    const toggle = createButton(head, this.projectDocumentsExpanded ? "收起项目文档" : collapsedLabel, () => {
      this.projectDocumentsExpanded = !this.projectDocumentsExpanded;
      syncExpandedState();
    }, {
      ghost: true,
      icon: this.projectDocumentsExpanded ? "chevron-up" : "chevron-down",
      className: "lifeos-project-doc-toggle"
    });
    const syncExpandedState = (): void => {
      if (this.projectDocumentsExpanded) renderContent();
      panel.toggleClass("is-collapsed", !this.projectDocumentsExpanded);
      content.hidden = !this.projectDocumentsExpanded;
      toggle.setAttr("aria-expanded", String(this.projectDocumentsExpanded));
      toggle.setAttr("aria-controls", contentId);
      toggle.setAttr("aria-label", this.projectDocumentsExpanded ? "收起项目文档" : collapsedLabel);
      toggle.querySelector<HTMLElement>(".lifeos-v2-button-label")?.setText(
        this.projectDocumentsExpanded ? "收起项目文档" : collapsedLabel
      );
      const icon = toggle.querySelector<HTMLElement>(".lifeos-v2-button-icon");
      if (icon) setIcon(icon, this.projectDocumentsExpanded ? "chevron-up" : "chevron-down");
    };
    syncExpandedState();
  }

  private renderProjectDocumentList(
    parent: HTMLElement,
    project: LifeOSProject,
    docs: LifeOSProjectDocument[],
    service: ProjectDocumentService,
    editable: boolean,
    previewLimit = 0
  ): void {
    const group = parent.createDiv({ cls: "lifeos-project-doc-group" });
    const title = group.createDiv({ cls: "lifeos-project-doc-group-title" });
    const titleCopy = title.createDiv({ cls: "lifeos-project-doc-group-title-copy" });
    titleCopy.createEl("strong", { text: project.name });
    const countEl = titleCopy.createSpan({ text: `${docs.length} 篇文档` });
    const sourceSummary = this.projectDocumentSourceSummary(docs);
    if (sourceSummary) {
      titleCopy.createSpan({
        cls: "lifeos-project-doc-source-summary",
        text: `来源：${sourceSummary}`,
        attr: {
          title: `${docs.length} 篇可检索 Markdown 整理稿，由这些原始文件导入生成。`
        }
      });
    }

    if (docs.length === 0) {
      group.createDiv({ cls: "lifeos-project-doc-empty", text: "这个项目还没有专属文档。" });
      return;
    }

    const toolbar = group.createDiv({ cls: "lifeos-project-doc-list-toolbar" });
    const search = toolbar.createDiv({ cls: "lifeos-project-doc-search" });
    setIcon(search.createSpan({ cls: "lifeos-project-doc-search-icon" }), "search");
    const searchInput = search.createEl("input", {
      cls: "lifeos-input",
      attr: {
        type: "search",
        placeholder: "搜索标题、正文或来源",
        "aria-label": `搜索${project.name}的项目文档`
      }
    });
    const initialVisibleCount = previewLimit > 0 ? Math.min(previewLimit, docs.length) : docs.length;
    const resultMeta = toolbar.createDiv({ cls: "lifeos-project-doc-result-meta" });
    const resultCount = resultMeta.createSpan({
      cls: "lifeos-project-doc-result-count",
      text: previewLimit > 0 && docs.length > initialVisibleCount
        ? `显示 ${initialVisibleCount} / ${docs.length} 篇`
        : `显示 ${docs.length} 篇`
    });
    if (previewLimit > 0 && docs.length > initialVisibleCount) {
      createButton(resultMeta, "查看全部", () => {
        this.selectedProjectId = project.id;
        this.projectDocumentsExpanded = true;
        void this.render().then(() => {
          this.containerEl.querySelector<HTMLElement>(".lifeos-project-doc-panel")?.scrollIntoView({
            block: "start",
            behavior: "auto"
          });
        });
      }, {
        ghost: true,
        icon: "list",
        className: "lifeos-project-doc-view-all"
      });
    }
    const scroll = group.createDiv({ cls: "lifeos-project-doc-scroll" });

    const renderRows = () => {
      const query = searchInput.value.trim();
      const filtered = this.filterProjectDocuments(docs, query);
      const visibleDocs = previewLimit > 0 && !query
        ? filtered.slice(0, previewLimit)
        : filtered;
      countEl.setText(`${docs.length} 篇文档`);
      resultCount.setText(query
        ? `找到 ${filtered.length} 篇`
        : previewLimit > 0 && visibleDocs.length < filtered.length
          ? `显示 ${visibleDocs.length} / ${filtered.length} 篇`
          : `显示 ${visibleDocs.length} 篇`);
      scroll.empty();
      if (filtered.length === 0) {
        scroll.createDiv({ cls: "lifeos-project-doc-empty is-search-empty", text: "没有匹配的项目文档。" });
        return;
      }

      for (const doc of visibleDocs) {
        const displayName = this.projectDocumentDisplayName(doc);
        const item = scroll.createDiv({
          cls: "lifeos-project-doc-item",
          attr: { "data-document-kind": doc.sourceKind || doc.kind }
        });
        const leading = item.createDiv({ cls: "lifeos-project-doc-leading" });
        setIcon(leading, this.projectDocumentIcon(doc));
        const body = item.createDiv({
          cls: "lifeos-project-doc-body",
          attr: {
            role: "button",
            tabindex: "0",
            "aria-label": `打开文档：${displayName}`,
            title: doc.path
          }
        });
        body.addEventListener("click", () => void this.openProjectDocument(doc.path));
        body.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          void this.openProjectDocument(doc.path);
        });
        const heading = body.createDiv({ cls: "lifeos-project-doc-title-row" });
        heading.createEl("strong", { text: displayName, attr: { title: doc.path } });
        heading.createSpan({
          cls: "lifeos-project-doc-kind",
          text: this.projectDocumentKindLabel(doc)
        });
        const meta = body.createDiv({ cls: "lifeos-project-doc-meta" });
        for (const value of this.projectDocumentMeta(doc)) {
          meta.createSpan({ text: value });
        }
        if (doc.excerpt) {
          body.createDiv({ cls: "lifeos-project-doc-excerpt", text: this.compactProjectDocumentExcerpt(doc.excerpt) });
        } else {
          body.createDiv({
            cls: "lifeos-project-doc-excerpt is-empty",
            text: doc.textImportMode === "attachment-only" ? "仅保存原始文件，尚未生成可检索正文。" : "暂无正文摘要。"
          });
        }
        const actions = item.createDiv({ cls: "lifeos-project-doc-actions" });
        this.createProjectDocumentIconAction(actions, "打开文档", "file-text", () => void this.openProjectDocument(doc.path));
        if (!editable) continue;
        this.createProjectDocumentIconAction(actions, "重命名文档", "pencil", () => {
          void this.renameProjectDocument(project, doc, service);
        });
        this.createProjectDocumentIconAction(actions, "删除文档", "trash-2", () => {
          void this.deleteProjectDocument(project, doc, service);
        }, true);
      }
    };

    searchInput.addEventListener("input", renderRows);
    renderRows();
  }

  private filterProjectDocuments(docs: LifeOSProjectDocument[], query: string): LifeOSProjectDocument[] {
    const keywords = query
      .trim()
      .toLocaleLowerCase("zh-CN")
      .split(/\s+/u)
      .filter(Boolean);
    if (keywords.length === 0) return docs;
    return docs.filter((doc) => {
      const haystack = [
        doc.title,
        doc.excerpt,
        doc.sourceName,
        doc.sourceKind,
        doc.sourceSize,
        doc.kind,
        doc.path
      ].filter(Boolean).join("\n").toLocaleLowerCase("zh-CN");
      return keywords.every((keyword) => haystack.includes(keyword));
    });
  }

  private projectDocumentSourceSummary(docs: LifeOSProjectDocument[]): string {
    const counts = new Map<string, number>();
    for (const doc of docs) {
      const descriptor = `${doc.sourceKind ?? ""} ${doc.sourceName ?? ""}`.toLocaleLowerCase("en-US");
      const kind = /\bpdf\b/u.test(descriptor)
        ? "PDF"
        : /\b(?:word|docx?|rtf)\b/u.test(descriptor)
          ? "Word"
          : /\b(?:markdown|md)\b/u.test(descriptor)
            ? "Markdown"
            : /\b(?:image|png|jpe?g|webp|gif|bmp|avif)\b/u.test(descriptor)
              ? "图片"
              : "其他";
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return ["PDF", "Word", "Markdown", "图片", "其他"]
      .filter((kind) => (counts.get(kind) ?? 0) > 0)
      .map((kind) => `${counts.get(kind)} ${kind}`)
      .join(" · ");
  }

  private projectDocumentDisplayName(doc: LifeOSProjectDocument): string {
    const rawTitle = String(doc.title || doc.sourceName || doc.path || "未命名文档").trim();
    const wikiTarget = rawTitle.match(/^\[\[([\s\S]+?)\]\]$/u)?.[1] ?? rawTitle;
    const [target, alias] = wikiTarget.split("|").map((part) => part.trim());
    if (alias) return alias;
    const cleanTarget = target.replace(/#.*$/u, "").replace(/\\/gu, "/").replace(/\/+$/u, "");
    if (!cleanTarget.includes("/") && !cleanTarget.startsWith("..")) return cleanTarget || "未命名文档";
    const segments = cleanTarget.split("/").filter(Boolean);
    return segments[segments.length - 1] || "未命名文档";
  }

  private compactProjectDocumentExcerpt(value: string): string {
    return value
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu, (_match, target: string, alias?: string) => {
        if (alias?.trim()) return alias.trim();
        const clean = target.replace(/#.*$/u, "").replace(/\\/gu, "/");
        const segments = clean.split("/").filter(Boolean);
        return segments[segments.length - 1] || target;
      })
      .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
      .replace(/(?:\.\.\/)+(?:Projects|项目)\/[^\s\]]*\/([^/\s\]]+)/gu, "$1")
      .replace(/\s+/gu, " ")
      .trim();
  }

  private projectDocumentIcon(doc: LifeOSProjectDocument): string {
    if (doc.sourceKind === "pdf") return "file-type-2";
    if (doc.sourceKind === "word") return "file-text";
    if (doc.sourceKind === "image") return "image";
    if (doc.kind === "meeting") return "messages-square";
    if (doc.kind === "requirement") return "list-checks";
    if (doc.kind === "review") return "history";
    return "file-text";
  }

  private projectDocumentKindLabel(doc: LifeOSProjectDocument): string {
    const sourceLabels: Record<string, string> = {
      pdf: "PDF",
      word: "Word",
      image: "图片",
      markdown: "Markdown",
      text: "文本",
      csv: "CSV",
      json: "JSON"
    };
    if (doc.sourceKind && sourceLabels[doc.sourceKind]) return sourceLabels[doc.sourceKind];
    const kindLabels: Record<LifeOSProjectDocument["kind"], string> = {
      note: "笔记",
      meeting: "会议",
      requirement: "需求",
      reference: "资料",
      review: "复盘"
    };
    return kindLabels[doc.kind];
  }

  private projectDocumentMeta(doc: LifeOSProjectDocument): string[] {
    const meta: string[] = [];
    if (doc.sourceName && doc.sourceName !== doc.title) {
      meta.push(this.projectDocumentDisplayName({ ...doc, title: doc.sourceName }));
    }
    if (doc.sourceSize) meta.push(doc.sourceSize);
    if (typeof doc.characterCount === "number" && doc.characterCount > 0) {
      meta.push(doc.characterCount >= 10000
        ? `${(doc.characterCount / 10000).toFixed(1)} 万字`
        : `${doc.characterCount.toLocaleString("zh-CN")} 字`);
    }
    if (doc.textImportMode === "ai-formatted") meta.push("AI 排版");
    else if (doc.textImportMode === "plain-text") meta.push("原文导入");
    else if (doc.textImportMode === "attachment-only") meta.push("仅原件");
    if ((doc.warningCount ?? 0) > 0) meta.push(`${doc.warningCount} 条识别提示`);
    if (doc.mtime > 0) {
      meta.push(new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(new Date(doc.mtime)));
    }
    return meta;
  }

  private createProjectDocumentIconAction(
    parent: HTMLElement,
    label: string,
    icon: string,
    onClick: () => void,
    danger = false
  ): HTMLButtonElement {
    const button = createButton(parent, label, onClick, {
      ghost: true,
      icon,
      className: `lifeos-project-doc-icon-action${danger ? " lifeos-button-danger" : ""}`
    });
    button.setAttr("aria-label", label);
    button.title = label;
    return button;
  }

  private createProjectDocumentService(fs: FileSystemService): ProjectDocumentService {
    return new ProjectDocumentService(this.app, fs, {
      pdfOcr: new PdfOcrService(this.app, {
        engine: this.plugin.settings.pdfOcrEngine,
        paddleEndpoint: this.plugin.settings.paddleOcrEndpoint
      }),
      aiFormatter: (input) => this.formatImportedProjectDocumentWithAi(input)
    });
  }

  private async formatImportedProjectDocumentWithAi(input: ProjectDocumentAiFormatterInput): Promise<{ markdown: string }> {
    const response = await this.plugin.ai.complete({
      responseFormat: "text",
      temperature: 0.15,
      reasoningEffort: "default",
      skipModelCheck: true,
      messages: [
        {
          role: "system",
          content: [
            "You are the Life OS project document formatting assistant.",
            "The original file has already been fully extracted and will be sent to you in ordered batches.",
            "This is a formatting pass over imported source text, not a summarization or analysis task.",
            "Format the current batch paragraph by paragraph as readable Markdown: headings, paragraphs, lists, tables, or code blocks.",
            "Every source paragraph, line, question number, option, table cell, figure caption, citation, date, number, and proper noun must still be represented in your output.",
            "Do not summarize, omit, translate, deduplicate, rewrite facts, merge away paragraphs, or invent content.",
            "If a fragment is messy or uncertain, copy it unchanged instead of shortening it.",
            "Return only the formatted Markdown for the current batch. Do not wrap it in code fences and do not add explanations, disclaimers, or an AI signature."
          ].join("\n")
        },
        {
          role: "user",
          content: [
            `Project: ${input.project.name}`,
            `Document: ${input.title}`,
            `Source: ${input.sourceName}`,
            `Type: ${input.importKind}`,
            `Batch: ${input.chunkIndex ?? 1}/${input.chunkCount ?? 1}`,
            `Batch characters: ${input.chunkTextLength ?? input.text.length}`,
            `Full extracted characters: ${input.fullTextLength ?? input.text.length}`,
            "",
            "Format only this ordered source batch. Keep one-to-one coverage with the source text and do not omit any sentence, number, option, or line:",
            "----- SOURCE BATCH START -----",
            input.text,
            "----- SOURCE BATCH END -----"
          ].join("\n")
        }
      ]
    });
    const responseText = response.text?.trim() ?? "";
    if (!response.ok || !responseText) {
      throw new Error(response.error || "AI formatter returned no markdown.");
    }
    return { markdown: responseText };
  }

  private async createProjectDocument(project: LifeOSProject, service: ProjectDocumentService): Promise<void> {
    if (!requireProFeature(this.plugin, "projectDocuments")) return;
    new NewProjectDocumentModal(this.app, project, service, this.plugin, async (doc) => {
      await this.openProjectDocument(doc.path);
      await this.render();
    }).open();
  }

  private async importProjectDocuments(project: LifeOSProject, service: ProjectDocumentService): Promise<void> {
    if (!requireProFeature(this.plugin, "projectDocuments")) return;
    new ImportProjectDocumentsModal(this.app, project, service, this.plugin, async (documents) => {
      const first = documents[0]?.document;
      if (first) await this.openProjectDocument(first.path);
      await this.render();
    }).open();
  }

  private async importProjectDocumentsToWhiteboard(
    project: LifeOSProject,
    summary: LifeOSProjectSummary,
    service: ProjectDocumentService,
    whiteboards: ProjectWhiteboardService,
    overview: LifeOSProjectOverview
  ): Promise<void> {
    if (!requireProFeature(this.plugin, "projectDocuments")) return;
    new ImportProjectDocumentsModal(this.app, project, service, this.plugin, async (documents) => {
      const importedDocs = documents.map((item) => item.document);
      const latestDocs = await service.listDocuments(project);
      const importedPaths = new Set(importedDocs.map((doc) => doc.path));
      const mergedDocs = [
        ...importedDocs,
        ...latestDocs.filter((doc) => !importedPaths.has(doc.path))
      ];
      const result = await whiteboards.generate({
        project,
        summary,
        documents: mergedDocs,
        relatedTasks: this.relatedTasksForProject(project, overview),
        options: {
          style: "file-board",
          includeDocuments: true,
          includeRelatedTasks: true,
          includeDataComponents: true
        }
      });
      new Notice(`已生成资料白板：${result.nodeCount} 个节点。`);
      await this.openProjectDocument(result.canvasPath);
      await this.render();
    }).open();
  }

  private async openProjectWhiteboardModal(
    project: LifeOSProject,
    summary: LifeOSProjectSummary,
    documents: LifeOSProjectDocument[],
    overview: LifeOSProjectOverview,
    service: ProjectWhiteboardService
  ): Promise<void> {
    if (!requireProFeature(this.plugin, "projectManagement")) return;
    new ProjectWhiteboardModal(this.app, project, async (options) => {
      const result = await service.generate({
        project,
        summary,
        documents,
        relatedTasks: this.relatedTasksForProject(project, overview),
        options
      });
      new Notice(`已生成项目白板：${result.nodeCount} 个节点。`);
      await this.openProjectDocument(result.canvasPath);
      await this.render();
    }).open();
  }

  private async openLatestProjectWhiteboard(project: LifeOSProject, service: ProjectWhiteboardService): Promise<void> {
    if (!requireProFeature(this.plugin, "projectManagement")) return;
    const prefix = `${service.whiteboardsPath(project)}/`;
    const files = this.app.vault.getFiles()
      .filter((file) => file.path.startsWith(prefix) && file.extension === "canvas")
      .sort((left, right) => (right.stat?.mtime ?? 0) - (left.stat?.mtime ?? 0));
    const latest = files[0];
    if (!latest) {
      new Notice("这个项目还没有白板。");
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(latest);
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

  private renderTaskBatchToolbar(
    parent: HTMLElement,
    taskGroups: Record<TaskLane, LifeOSTask[]>,
    service: TaskService,
    projects: LifeOSProject[],
    allCompletedCount: number
  ): void {
    const groups: Record<TaskLane, LifeOSTask[]> = {
      today: this.uniqueVisibleTasks(taskGroups.today),
      open: this.uniqueVisibleTasks(taskGroups.open),
      done: this.uniqueVisibleTasks(taskGroups.done)
    };
    const unique = this.uniqueVisibleTasks([...groups.today, ...groups.open, ...groups.done]);
    if (unique.length === 0 && allCompletedCount === 0) return;
    const selectedTasks = (): LifeOSTask[] => unique.filter((task) => this.selectedTaskKeys.has(this.taskStableKey(task)));
    const toolbar = parent.createDiv({ cls: "lifeos-task-batch-toolbar" });
    const selection = toolbar.createDiv({ cls: "lifeos-task-batch-selection" });
    const selectAllControl = selection.createEl("label", { cls: "lifeos-task-select-all-control" });
    const selectAll = selectAllControl.createEl("input", {
      cls: "lifeos-task-select-all",
      attr: { type: "checkbox", "aria-label": "全选当前筛选结果" }
    });
    selectAllControl.createSpan({ text: "全选当前范围" });
    const selectionCopy = selection.createDiv({ cls: "lifeos-batch-selection-copy" });
    const selectedLabel = selectionCopy.createEl("strong", { text: "批量处理" });
    selectionCopy.createSpan({ text: `当前范围 ${unique.length} 项` });

    const quickSelect = toolbar.createDiv({ cls: "lifeos-task-batch-quick-select" });
    const selectOnly = (tasks: LifeOSTask[]): void => {
      for (const task of unique) {
        const key = this.taskStableKey(task);
        this.selectedTaskKeys.delete(key);
        this.syncTaskSelectionDom(key, false);
      }
      for (const task of tasks) {
        const key = this.taskStableKey(task);
        this.selectedTaskKeys.add(key);
        this.syncTaskSelectionDom(key, true);
      }
      syncToolbar();
    };
    const selectToday = createButton(quickSelect, "全选今日", () => selectOnly(groups.today), {
      ghost: true,
      icon: "calendar-check"
    });
    const selectPending = createButton(quickSelect, "全选待办", () => selectOnly(groups.open), {
      ghost: true,
      icon: "circle"
    });
    const selectCompleted = createButton(quickSelect, "全选已完成", () => selectOnly(groups.done), {
      ghost: true,
      icon: "check-circle-2"
    });
    selectToday.disabled = groups.today.length === 0;
    selectPending.disabled = groups.open.length === 0;
    selectCompleted.disabled = groups.done.length === 0;

    const actions = toolbar.createDiv({ cls: "lifeos-task-batch-actions" });
    const edit = createButton(actions, "批量编辑", () => {
      const selected = selectedTasks();
      if (selected.length === 0) return;
      new TaskBatchEditModal(this.app, selected, projects, async (update) => {
        await this.runTaskBatch(() => service.batchUpdateTasks(selected, update), "更新");
      }).open();
    }, { icon: "list-pen", ghost: true });
    const complete = createButton(actions, "归档所选", () => void this.runTaskBatch(
      () => service.batchCompleteTasks(selectedTasks().filter((task) => task.source === "open" && !task.isDone)),
      "归档"
    ), { icon: "check-check", primary: true });
    const restore = createButton(actions, "恢复所选", () => void this.runTaskBatch(
      () => service.batchRestoreTasks(selectedTasks().filter((task) => task.source === "done" || task.isDone)),
      "恢复"
    ), { icon: "rotate-ccw", ghost: true });
    const remove = createButton(actions, "删除所选", () => {
      const selected = selectedTasks();
      if (selected.length === 0) return;
      new TaskDeleteConfirmModal(this.app, selected.length, async () => {
        await this.runTaskBatch(() => service.batchDeleteTasks(selected), "删除");
      }).open();
    }, { icon: "trash-2", ghost: true });
    remove.addClass("lifeos-task-batch-delete");
    const clearCompleted = createButton(actions, "清空全部已完成", () => {
      if (allCompletedCount === 0) return;
      new TaskClearCompletedConfirmModal(this.app, allCompletedCount, async () => {
        const result = await this.withVaultRefreshSuppressed(() => service.archiveAndClearDoneTasks());
        this.selectedTaskKeys.clear();
        new Notice(
          result.cleared > 0
            ? `已清空 ${result.cleared} 项已完成任务，完整备份保存在 ${result.backupPath}。`
            : "当前没有可清空的已完成任务。",
          7000
        );
        await this.render(true);
      }).open();
    }, { icon: "archive-x", ghost: true });
    clearCompleted.addClass("lifeos-task-clear-completed");
    clearCompleted.disabled = allCompletedCount === 0;
    const clear = createButton(actions, "清空选择", () => {
      for (const task of unique) {
        const key = this.taskStableKey(task);
        this.selectedTaskKeys.delete(key);
        this.syncTaskSelectionDom(key, false);
      }
      syncToolbar();
    }, { icon: "x", ghost: true });

    const syncToolbar = (): void => {
      const selected = selectedTasks();
      const selectedOpen = selected.filter((task) => task.source === "open" && !task.isDone);
      const selectedDone = selected.filter((task) => task.source === "done" || task.isDone);
      selectAll.checked = selected.length > 0 && selected.length === unique.length;
      selectAll.indeterminate = selected.length > 0 && selected.length < unique.length;
      selectedLabel.setText(selected.length > 0 ? `已选 ${selected.length} 项` : "批量处理");
      edit.disabled = selected.length === 0;
      complete.disabled = selectedOpen.length === 0;
      restore.disabled = selectedDone.length === 0;
      remove.disabled = selected.length === 0;
      clear.disabled = selected.length === 0;
    };
    selectAll.onchange = () => {
      for (const task of unique) {
        const key = this.taskStableKey(task);
        if (selectAll.checked) this.selectedTaskKeys.add(key);
        else this.selectedTaskKeys.delete(key);
        this.syncTaskSelectionDom(key, selectAll.checked);
      }
      syncToolbar();
    };
    this.updateTaskBatchUi = syncToolbar;
    syncToolbar();
  }

  private async runTaskBatch(
    operation: () => Promise<{ succeeded: number; failed: Array<{ reason: string }> }>,
    actionLabel: string
  ): Promise<void> {
    try {
      const result = await this.withVaultRefreshSuppressed(operation);
      this.selectedTaskKeys.clear();
      new Notice(
        result.failed.length > 0
          ? `${actionLabel} ${result.succeeded} 项，${result.failed.length} 项因内容已变化未处理。`
          : `已${actionLabel} ${result.succeeded} 项任务。`,
        6000
      );
      await this.render(true);
    } catch (error) {
      new Notice(`${actionLabel}任务失败：${error instanceof Error ? error.message : String(error)}`, 7000);
    }
  }

  private uniqueVisibleTasks(tasks: LifeOSTask[]): LifeOSTask[] {
    const seen = new Set<string>();
    return tasks.filter((task) => {
      const key = this.taskStableKey(task);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private renderColumn(
    board: HTMLElement,
    columnKey: "today" | "open" | "done",
    title: string,
    hint: string,
    tasks: LifeOSTask[],
    service: TaskService,
    icon: string
  ): void {
    const uniqueTasks = this.uniqueVisibleTasks(tasks);
    const column = board.createDiv({
      cls: "lifeos-board-column",
      attr: {
        "data-task-column": columnKey,
        "aria-label": `${title}，可将任务拖放到这里`
      }
    });
    this.configureTaskDropTarget(column, columnKey, service);
    const head = column.createDiv({ cls: "lifeos-board-column-header" });
    const titleEl = head.createDiv();
    setIcon(titleEl.createSpan({ cls: "lifeos-status-icon" }), icon);
    titleEl.createSpan({ text: title });
    head.createSpan({ cls: "lifeos-badge", text: String(uniqueTasks.length) });
    column.createDiv({ cls: "lifeos-board-column-hint", text: hint });

    if (uniqueTasks.length === 0) {
      const empty = column.createDiv({ cls: "lifeos-board-empty" });
      empty.createDiv({ text: "暂无任务" });
      createButton(empty, "新建任务", () => new NewTaskModal(this.app, this.plugin, () => this.render()).open(), { ghost: true, icon: "plus" });
      return;
    }

    const list = column.createDiv({ cls: "lifeos-board-column-list" });
    list.setAttr("data-lifeos-scroll-key", `task-column:${title}`);
    const footer = column.createDiv({ cls: "lifeos-board-column-footer" });
    const limitKey = `${this.selectedProjectId ?? "all"}:${columnKey}`;
    const initialLimit = TASK_COLUMN_INITIAL_LIMIT[columnKey];

    const renderVisibleTasks = (): void => {
      const visibleLimit = Math.max(initialLimit, this.taskColumnVisibleLimits.get(limitKey) ?? initialLimit);
      const visibleTasks = uniqueTasks.slice(0, visibleLimit);
      list.empty();
      footer.empty();
      for (const task of visibleTasks) this.renderBoardCard(list, task, service, columnKey);

      if (uniqueTasks.length <= initialLimit) return;
      const status = footer.createSpan({
        cls: "lifeos-board-column-count",
        text: `已显示 ${visibleTasks.length}/${uniqueTasks.length}`
      });
      status.setAttr("aria-live", "polite");
      const actions = footer.createDiv({ cls: "lifeos-board-column-footer-actions" });
      if (visibleTasks.length < uniqueTasks.length) {
        const nextCount = Math.min(TASK_COLUMN_PAGE_SIZE, uniqueTasks.length - visibleTasks.length);
        createButton(actions, `再显示 ${nextCount} 项`, () => {
          this.taskColumnVisibleLimits.set(limitKey, visibleTasks.length + TASK_COLUMN_PAGE_SIZE);
          renderVisibleTasks();
        }, { ghost: true, icon: "chevron-down" });
      }
      if (visibleTasks.length > initialLimit) {
        createButton(actions, "收起", () => {
          this.taskColumnVisibleLimits.set(limitKey, initialLimit);
          renderVisibleTasks();
          column.scrollIntoView({ block: "nearest" });
        }, { ghost: true, icon: "chevron-up" });
      }
    };

    renderVisibleTasks();
  }

  private renderBoardCard(parent: HTMLElement, task: LifeOSTask, service: TaskService, columnKey: TaskLane): void {
    const key = this.taskStableKey(task);
    const selected = this.selectedTaskKeys.has(key);
    const doneColumn = columnKey === "done";
    const card = parent.createDiv({
      cls: `${doneColumn ? "lifeos-board-card is-done" : "lifeos-board-card"}${selected ? " is-selected" : ""}`,
      attr: { draggable: "true", "aria-grabbed": "false" }
    });
    card.setAttr("data-lifeos-task-key", key);
    card.addEventListener("dragstart", (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, input, select, textarea")) {
        event.preventDefault();
        return;
      }
      this.draggedTask = task;
      card.addClass("is-dragging");
      card.setAttr("aria-grabbed", "true");
      event.dataTransfer?.setData("text/plain", key);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      this.draggedTask = null;
      card.removeClass("is-dragging");
      card.setAttr("aria-grabbed", "false");
      this.clearTaskDropTargets();
    });
    const top = card.createDiv({ cls: "lifeos-board-card-top" });
    const select = top.createEl("input", {
      cls: "lifeos-task-select",
      attr: { type: "checkbox", "aria-label": `选择任务：${task.text}` }
    });
    select.checked = selected;
    select.onchange = () => {
      if (select.checked) this.selectedTaskKeys.add(key);
      else this.selectedTaskKeys.delete(key);
      this.syncTaskSelectionDom(key, select.checked);
      this.updateTaskBatchUi?.();
    };
    renderMarkdownDisplay(this.app, this, top.createDiv({ cls: "lifeos-board-card-title" }), task.text);
    const meta = card.createDiv({ cls: "lifeos-board-card-meta" });
    const dueDate = this.taskDueDate(task);
    const completedDate = task.line.match(/✅\s*(20\d{2}-\d{2}-\d{2})/u)?.[1] || "";
    meta.createSpan({ text: dueDate || completedDate || (columnKey === "today" ? "今天" : "无截止日期") });
    meta.createSpan({ text: task.source === "open" ? "待办任务" : "已归档" });
    for (const tag of task.tags.slice(0, 2)) meta.createSpan({ cls: "lifeos-badge", text: tag });
    const actions = card.createDiv({ cls: "lifeos-board-card-actions" });
    const move = actions.createEl("select", {
      cls: "lifeos-task-lane-select",
      attr: { "aria-label": `移动任务：${task.text}` }
    });
    move.createEl("option", { value: "", text: "移动到…" });
    move.createEl("option", { value: "today", text: "移动到今日" });
    move.createEl("option", { value: "open", text: "移动到待办" });
    move.createEl("option", { value: "done", text: "移动到已完成" });
    move.value = "";
    move.onchange = () => {
      const targetLane = move.value as TaskLane;
      move.value = "";
      if (!targetLane || targetLane === columnKey) return;
      void this.runTaskLaneMove(task, targetLane, service);
    };
    move.addEventListener("dragstart", (event) => event.preventDefault());
    this.createTaskCardIconAction(actions, "修改任务", "pencil", () => new EditTaskModal(this.app, task, async (data) => {
      await this.withVaultRefreshSuppressed(() => service.updateTask(task, data));
      new Notice("任务已更新。", 4000);
      await this.render(true);
    }).open(), { ghost: true, className: "is-edit" });
    const stateActionLabel = doneColumn ? "恢复任务" : "完成任务";
    this.createTaskCardIconAction(actions, stateActionLabel, doneColumn ? "rotate-ccw" : "check", () => void (async () => {
      card.addClass("is-updating");
      try {
        if (doneColumn) {
          await this.withVaultRefreshSuppressed(() => service.undoCompleteTask(task.line));
          new Notice("任务已恢复到待完成。", 4000);
          await this.render(true);
        } else {
          await this.withVaultRefreshSuppressed(() => service.completeTask(task));
          await this.render(true);
          this.showUndoToast(task);
        }
      } catch (error) {
        card.removeClass("is-updating");
        new Notice(`${doneColumn ? "恢复" : "完成"}任务失败：${error instanceof Error ? error.message : String(error)}`, 7000);
      }
    })(), {
      primary: !doneColumn,
      ghost: doneColumn,
      className: "is-state"
    });
    this.createTaskCardIconAction(actions, "删除任务", "trash-2", () => new TaskDeleteConfirmModal(this.app, 1, async () => {
      await this.withVaultRefreshSuppressed(() => service.deleteTask(task));
      this.selectedTaskKeys.delete(key);
      new Notice("任务已删除。", 4000);
      await this.render(true);
    }).open(), { ghost: true, className: "is-delete" });
  }

  private createTaskCardIconAction(
    parent: HTMLElement,
    label: string,
    icon: string,
    onClick: () => void,
    options: { primary?: boolean; ghost?: boolean; className?: string } = {}
  ): HTMLButtonElement {
    const button = createButton(parent, label, onClick, {
      icon,
      primary: options.primary,
      ghost: options.ghost,
      className: ["lifeos-board-card-action", "lifeos-task-card-icon-action", options.className]
        .filter(Boolean)
        .join(" ")
    });
    button.setAttr("aria-label", label);
    button.setAttr("title", label);
    return button;
  }

  private configureTaskDropTarget(column: HTMLElement, lane: TaskLane, service: TaskService): void {
    column.addEventListener("dragover", (event) => {
      if (!this.draggedTask || this.taskLane(this.draggedTask) === lane) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      column.addClass("is-drop-target");
    });
    column.addEventListener("dragleave", (event) => {
      if (event.relatedTarget instanceof Node && column.contains(event.relatedTarget)) return;
      column.removeClass("is-drop-target");
    });
    column.addEventListener("drop", (event) => {
      event.preventDefault();
      const task = this.draggedTask;
      this.draggedTask = null;
      this.clearTaskDropTargets();
      if (!task || this.taskLane(task) === lane) return;
      void this.runTaskLaneMove(task, lane, service);
    });
  }

  private clearTaskDropTargets(): void {
    const container = this.containerEl.children[1] as HTMLElement | undefined;
    if (!container) return;
    for (const element of Array.from(container.querySelectorAll<HTMLElement>(".lifeos-board-column.is-drop-target"))) {
      element.removeClass("is-drop-target");
    }
  }

  private async runTaskLaneMove(task: LifeOSTask, lane: TaskLane, service: TaskService): Promise<void> {
    const labels: Record<TaskLane, string> = { today: "今日", open: "待办", done: "已完成" };
    try {
      await this.withVaultRefreshSuppressed(() => service.moveTaskToLane(task, lane, formatDate()));
      new Notice(`任务已移动到“${labels[lane]}”。`, 3500);
      await this.render(true);
    } catch (error) {
      new Notice(`移动任务失败：${error instanceof Error ? error.message : String(error)}`, 7000);
    }
  }

  private syncTaskSelectionDom(key: string, selected: boolean): void {
    const container = this.containerEl.children[1] as HTMLElement | undefined;
    if (!container) return;
    for (const card of Array.from(container.querySelectorAll<HTMLElement>("[data-lifeos-task-key]"))) {
      if (card.dataset.lifeosTaskKey !== key) continue;
      card.toggleClass("is-selected", selected);
      const checkbox = card.querySelector<HTMLInputElement>(".lifeos-task-select");
      if (checkbox) checkbox.checked = selected;
    }
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
    return open.filter((task) => this.taskLane(task) === "today");
  }

  private taskLane(task: LifeOSTask): TaskLane {
    if (task.source === "done" || task.isDone) return "done";
    const explicitLane = task.line.match(/(?:^|\s)lane:(today|open)(?=\s|$)/u)?.[1];
    if (explicitLane === "today" || explicitLane === "open") return explicitLane;
    return this.taskDueDate(task) === today() ? "today" : "open";
  }

  private taskDueDate(task: LifeOSTask): string {
    return task.line.match(/📅\s*(20\d{2}-\d{2}-\d{2})/u)?.[1] || "";
  }

  private taskStableKey(task: LifeOSTask): string {
    const blockId = task.line.match(/\^([\w-]+)\s*$/u)?.[1];
    return blockId || `${task.source}:${task.date || ""}:${task.text}:${task.line}`;
  }

  private findSelectedSummary(overview: LifeOSProjectOverview): LifeOSProjectSummary | null {
    if (this.selectedProjectId === "unassigned") return overview.unassigned;
    if (!this.selectedProjectId) return null;
    return overview.projects.find((item) => item.projectId === this.selectedProjectId) ?? null;
  }

  private summaryForProject(project: LifeOSProject, overview: LifeOSProjectOverview): LifeOSProjectSummary {
    return overview.projects.find((item) => item.projectId === project.id) ?? {
      project,
      projectId: project.id,
      label: project.name,
      openTasks: [],
      doneTasks: [],
      totalCount: 0,
      openCount: 0,
      doneCount: 0,
      progress: 0
    };
  }

  private relatedTasksForProject(project: LifeOSProject, overview: LifeOSProjectOverview): LifeOSTask[] {
    const terms = [project.name, project.goal ?? ""]
      .flatMap((value) => value.toLowerCase().split(/[\s,，、/|]+/))
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
    if (terms.length === 0) return [];
    return overview.unassigned.openTasks
      .filter((task) => terms.some((term) => task.text.toLowerCase().includes(term)))
      .slice(0, 10);
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
      try {
        await this.withVaultRefreshSuppressed(() => this.service().undoCompleteTask(task.line));
        new Notice("已撤销完成状态");
        await this.render(true);
      } catch (error) {
        new Notice(`撤销失败：${error instanceof Error ? error.message : String(error)}`, 7000);
      }
    }, { ghost: true });
    window.setTimeout(() => this.toastEl?.hide(), 5000);
  }

  private service(): TaskService {
    return new TaskService(this.app, new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage));
  }
}

interface EditTaskDraft {
  title: string;
  dueDate?: string;
}

class EditTaskModal extends Modal {
  constructor(
    app: App,
    private task: LifeOSTask,
    private onSave: (data: EditTaskDraft) => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-task-edit-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: "修改任务",
      subtitle: "只更新当前任务；标签、项目归属和备注会继续保留。",
      icon: "pencil",
      className: "lifeos-task-modal lifeos-task-edit-modal"
    });
    const form = body.createDiv({ cls: "lifeos-task-edit-form" });
    const titleField = form.createDiv({ cls: "lifeos-form-field lifeos-form-field-wide" });
    titleField.createEl("label", { text: "任务标题" });
    const title = titleField.createEl("input", {
      cls: "lifeos-input lifeos-glass-input",
      attr: { type: "text", value: this.task.text, placeholder: "填写任务标题" }
    });
    title.value = this.task.text;

    const dueField = form.createDiv({ cls: "lifeos-form-field" });
    dueField.createEl("label", { text: "截止日期" });
    const dueDate = dueField.createEl("input", {
      cls: "lifeos-input lifeos-glass-input",
      attr: { type: "date" }
    });
    dueDate.value = this.task.line.match(/📅\s*(20\d{2}-\d{2}-\d{2})/u)?.[1] || "";

    footer.addClass("lifeos-task-modal-footer");
    createButton(footer, "取消", () => this.close(), { ghost: true });
    const save = createButton(footer, "保存修改", () => void (async () => {
      const nextTitle = title.value.trim();
      if (!nextTitle) {
        new Notice("任务标题不能为空。", 3000);
        title.focus();
        return;
      }
      save.disabled = true;
      try {
        await this.onSave({ title: nextTitle, dueDate: dueDate.value.trim() });
        this.close();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "任务修改失败。", 6000);
      } finally {
        save.disabled = false;
      }
    })(), { primary: true, icon: "save" });
    title.focus();
    title.select();
  }
}

class TaskBatchEditModal extends Modal {
  constructor(
    app: App,
    private tasks: LifeOSTask[],
    private projects: LifeOSProject[],
    private onSave: (update: TaskBatchUpdate) => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-batch-edit-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: `批量编辑 ${this.tasks.length} 项任务`,
      subtitle: "一次修改项目、日期、优先级或标签；任务标题和备注保持不变。",
      icon: "list-pen",
      className: "lifeos-task-modal lifeos-task-batch-edit-modal"
    });

    const summary = body.createDiv({ cls: "lifeos-task-batch-edit-summary" });
    summary.createEl("strong", { text: `已选择 ${this.tasks.length} 项` });
    summary.createSpan({
      text: this.tasks.slice(0, 3).map((task) => task.text).join("、") + (this.tasks.length > 3 ? "…" : "")
    });

    const form = body.createDiv({ cls: "lifeos-task-batch-edit-form" });
    const projectField = this.field(form, "归属项目", "仅修改项目归属，不影响任务内容。");
    const project = projectField.createEl("select", { cls: "lifeos-input lifeos-glass-input" });
    project.createEl("option", { value: "__keep__", text: "保持原项目" });
    project.createEl("option", { value: "__clear__", text: "清除项目归属" });
    for (const item of this.projects) project.createEl("option", { value: item.id, text: item.name });

    const dueField = this.field(form, "截止日期", "可以统一设置，也可以清除已有日期。");
    const dueControls = dueField.createDiv({ cls: "lifeos-task-batch-date-controls" });
    const dueMode = dueControls.createEl("select", { cls: "lifeos-input lifeos-glass-input" });
    dueMode.createEl("option", { value: "keep", text: "保持原日期" });
    dueMode.createEl("option", { value: "set", text: "设置统一日期" });
    dueMode.createEl("option", { value: "clear", text: "清除截止日期" });
    const dueDate = dueControls.createEl("input", {
      cls: "lifeos-input lifeos-glass-input",
      attr: { type: "date", "aria-label": "批量设置截止日期" }
    });
    const syncDueDate = (): void => {
      dueDate.disabled = dueMode.value !== "set";
      dueField.toggleClass("is-setting-date", dueMode.value === "set");
    };
    dueMode.onchange = syncDueDate;
    syncDueDate();

    const priorityField = this.field(form, "优先级", "普通会清除已有 priority 标签。");
    const priority = priorityField.createEl("select", { cls: "lifeos-input lifeos-glass-input" });
    priority.createEl("option", { value: "__keep__", text: "保持原优先级" });
    priority.createEl("option", { value: "__clear__", text: "普通（清除优先级）" });
    priority.createEl("option", { value: "重要", text: "重要" });
    priority.createEl("option", { value: "紧急", text: "紧急" });

    const addTagsField = this.field(form, "添加标签", "多个标签用空格或逗号分隔，无需输入 #。");
    const addTags = addTagsField.createEl("input", {
      cls: "lifeos-input lifeos-glass-input",
      attr: { type: "text", placeholder: "例如：科研 本周" }
    });

    const removeTagsField = this.field(form, "移除标签", "系统标签 #pls/task 不会被移除。");
    const removeTags = removeTagsField.createEl("input", {
      cls: "lifeos-input lifeos-glass-input",
      attr: { type: "text", placeholder: "例如：旧计划 待确认" }
    });

    footer.addClass("lifeos-task-modal-footer");
    createButton(footer, "取消", () => this.close(), { ghost: true });
    const save = createButton(footer, "应用到所选任务", () => void (async () => {
      const update: TaskBatchUpdate = {};
      if (project.value !== "__keep__") update.projectId = project.value === "__clear__" ? null : project.value;
      if (dueMode.value === "clear") update.dueDate = null;
      if (dueMode.value === "set") {
        if (!dueDate.value) {
          new Notice("请先选择截止日期。", 3000);
          dueDate.focus();
          return;
        }
        update.dueDate = dueDate.value;
      }
      if (priority.value !== "__keep__") update.priority = priority.value === "__clear__" ? null : priority.value;
      const add = this.parseTags(addTags.value);
      const remove = this.parseTags(removeTags.value);
      if (add.length > 0) update.addTags = add;
      if (remove.length > 0) update.removeTags = remove;
      if (Object.keys(update).length === 0) {
        new Notice("请至少选择一项要批量修改的内容。", 3000);
        return;
      }

      save.disabled = true;
      try {
        await this.onSave(update);
        this.close();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "批量编辑任务失败。", 6000);
      } finally {
        save.disabled = false;
      }
    })(), { primary: true, icon: "check-check" });
  }

  private field(parent: HTMLElement, label: string, hint: string): HTMLElement {
    const field = parent.createDiv({ cls: "lifeos-form-field lifeos-task-batch-edit-field" });
    field.createEl("label", { text: label });
    field.createEl("p", { cls: "lifeos-muted-text", text: hint });
    return field;
  }

  private parseTags(value: string): string[] {
    return [...new Set(value.split(/[\s,，]+/u).map((tag) => tag.trim().replace(/^#+/u, "")).filter(Boolean))];
  }
}

class TaskDeleteConfirmModal extends Modal {
  constructor(
    app: App,
    private count: number,
    private onConfirm: () => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-task-delete-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: this.count > 1 ? `删除 ${this.count} 个任务？` : "删除这个任务？",
      subtitle: "删除后不会进入已完成列表，请确认这些任务不再需要。",
      icon: "trash-2",
      className: "lifeos-task-modal lifeos-task-delete-modal"
    });
    body.createDiv({
      cls: "lifeos-task-delete-warning",
      text: this.count > 1 ? `将永久删除当前选中的 ${this.count} 个任务。` : "将永久删除当前任务。"
    });
    footer.addClass("lifeos-task-modal-footer");
    createButton(footer, "取消", () => this.close(), { ghost: true });
    const confirm = createButton(footer, "确认删除", () => void (async () => {
      confirm.disabled = true;
      try {
        await this.onConfirm();
        this.close();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "删除任务失败。", 6000);
      } finally {
        confirm.disabled = false;
      }
    })(), { primary: true, icon: "trash-2" });
    confirm.addClass("lifeos-danger-button");
  }
}

class TaskClearCompletedConfirmModal extends Modal {
  constructor(
    app: App,
    private count: number,
    private onConfirm: () => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-completed-task-clear-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: `清空全部 ${this.count} 项已完成任务？`,
      subtitle: "系统会先逐字备份 done.md，再清空已完成列表；待办和今日任务不会受影响。",
      icon: "archive-x",
      className: "lifeos-task-modal lifeos-completed-task-clear-modal"
    });
    body.createDiv({
      cls: "lifeos-task-delete-warning",
      text: "这是全项目操作。备份会保存在 Tasks/archive，之后仍可手动查阅。"
    });
    footer.addClass("lifeos-task-modal-footer");
    createButton(footer, "取消", () => this.close(), { ghost: true });
    const confirm = createButton(footer, "备份并清空", () => void (async () => {
      confirm.disabled = true;
      try {
        await this.onConfirm();
        this.close();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "清空已完成任务失败。", 7000);
      } finally {
        confirm.disabled = false;
      }
    })(), { primary: true, icon: "archive-x" });
    confirm.addClass("lifeos-danger-button");
  }
}

class ProjectWhiteboardModal extends Modal {
  private selectedStyle: ProjectWhiteboardStyle = "knowledge-map";
  private includeDocuments = true;
  private includeRelatedTasks = true;
  private includeDataComponents = true;
  private styleCards = new Map<ProjectWhiteboardStyle, HTMLButtonElement>();

  constructor(
    app: App,
    private project: LifeOSProject,
    private onGenerate: (options: ProjectWhiteboardGenerateOptions) => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-project-whiteboard-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: "生成项目白板",
      subtitle: `为「${this.project.name}」创建一张可缩放、可连接、可继续整理的 Obsidian Canvas。`,
      icon: "network",
      className: "lifeos-task-modal lifeos-project-whiteboard-modal"
    });

    const styles = body.createDiv({ cls: "lifeos-project-whiteboard-style-grid" });
    for (const style of ProjectWhiteboardService.styles()) {
      const card = styles.createEl("button", {
        cls: "lifeos-project-whiteboard-style-card",
        attr: { type: "button" }
      });
      setIcon(card.createSpan({ cls: "lifeos-project-whiteboard-style-icon" }), style.icon);
      const copy = card.createDiv({ cls: "lifeos-project-whiteboard-style-copy" });
      copy.createEl("strong", { text: style.label });
      copy.createSpan({ text: style.description });
      card.onclick = () => {
        this.selectedStyle = style.id;
        this.syncStyleCards();
      };
      this.styleCards.set(style.id, card);
    }

    const options = body.createDiv({ cls: "lifeos-project-whiteboard-options" });
    options.createEl("h3", { text: "生成内容" });
    this.renderOption(options, "项目文档和导入资料", "Markdown、PDF、图片和附件会进入白板文件节点。", this.includeDocuments, (checked) => {
      this.includeDocuments = checked;
    });
    this.renderOption(options, "相关未归属任务", "把名字或目标匹配到当前项目的未归属任务一起放入白板。", this.includeRelatedTasks, (checked) => {
      this.includeRelatedTasks = checked;
    });
    this.renderOption(options, "统计组件", "生成任务进度、看板快照和热力图占位节点。", this.includeDataComponents, (checked) => {
      this.includeDataComponents = checked;
    });

    const note = body.createDiv({ cls: "lifeos-project-whiteboard-note" });
    setIcon(note.createSpan(), "info");
    note.createSpan({ text: "每次生成都会创建一个新版本，不覆盖已经手动整理过的白板。" });

    footer.addClass("lifeos-task-modal-footer");
    createButton(footer, "取消", () => this.close(), { ghost: true });
    createButton(footer, "生成白板", () => void this.generate(), { primary: true, icon: "wand-2" });
    this.syncStyleCards();
  }

  private renderOption(
    parent: HTMLElement,
    title: string,
    description: string,
    checked: boolean,
    onChange: (checked: boolean) => void
  ): void {
    const label = parent.createEl("label", { cls: "lifeos-project-whiteboard-option" });
    const input = label.createEl("input", { attr: { type: "checkbox" } });
    input.checked = checked;
    input.onchange = () => onChange(input.checked);
    const copy = label.createDiv();
    copy.createEl("strong", { text: title });
    copy.createSpan({ text: description });
  }

  private syncStyleCards(): void {
    for (const [style, card] of this.styleCards) {
      card.toggleClass("is-active", style === this.selectedStyle);
    }
  }

  private async generate(): Promise<void> {
    try {
      await this.onGenerate({
        style: this.selectedStyle,
        includeDocuments: this.includeDocuments,
        includeRelatedTasks: this.includeRelatedTasks,
        includeDataComponents: this.includeDataComponents
      });
      this.close();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "项目白板生成失败。");
    }
  }
}
