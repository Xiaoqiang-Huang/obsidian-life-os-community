import type { App } from "obsidian";
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
    const projectDocumentService = this.createProjectDocumentService(fs);
    const projectWhiteboardService = new ProjectWhiteboardService(this.app, fs);
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

    const layout = shellMain.createDiv({ cls: "lifeos-project-task-layout" });
    this.renderProjectList(layout, overview);
    const detail = layout.createDiv({ cls: "lifeos-project-task-detail" });
    this.renderSummary(detail, todayTasks, visibleOpen, visibleDone);
    this.renderProjectTaskGroups(detail, overview, service);
    await this.renderProjectDocuments(detail, overview, projects, projectDocumentService, projectWhiteboardService);

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
    service: ProjectDocumentService,
    whiteboards: ProjectWhiteboardService
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
      const docs = await service.listDocuments(selectedProject);
      const summary = this.summaryForProject(selectedProject, overview);
      const actions = head.createDiv({ cls: "lifeos-project-doc-head-actions" });
      createButton(actions, "生成白板", () => {
        void this.openProjectWhiteboardModal(selectedProject, summary, docs, overview, whiteboards);
      }, {
        primary: true,
        icon: "network"
      });
      createButton(actions, "资料生成白板", () => {
        void this.importProjectDocumentsToWhiteboard(selectedProject, summary, service, whiteboards, overview);
      }, {
        ghost: true,
        icon: "files"
      });
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
    const titleCopy = title.createDiv({ cls: "lifeos-project-doc-group-title-copy" });
    titleCopy.createEl("strong", { text: project.name });
    const countEl = titleCopy.createSpan({ text: `${docs.length} 篇文档` });

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
    const resultCount = toolbar.createSpan({ cls: "lifeos-project-doc-result-count", text: `显示 ${docs.length} 篇` });
    const scroll = group.createDiv({ cls: "lifeos-project-doc-scroll" });

    const renderRows = () => {
      const filtered = this.filterProjectDocuments(docs, searchInput.value);
      countEl.setText(`${docs.length} 篇文档`);
      resultCount.setText(searchInput.value.trim() ? `找到 ${filtered.length} 篇` : `显示 ${filtered.length} 篇`);
      scroll.empty();
      if (filtered.length === 0) {
        scroll.createDiv({ cls: "lifeos-project-doc-empty is-search-empty", text: "没有匹配的项目文档。" });
        return;
      }

      for (const doc of filtered) {
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
            "aria-label": `打开文档：${doc.title}`,
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
        heading.createEl("strong", { text: doc.title });
        heading.createSpan({
          cls: "lifeos-project-doc-kind",
          text: this.projectDocumentKindLabel(doc)
        });
        const meta = body.createDiv({ cls: "lifeos-project-doc-meta" });
        for (const value of this.projectDocumentMeta(doc)) {
          meta.createSpan({ text: value });
        }
        if (doc.excerpt) {
          body.createDiv({ cls: "lifeos-project-doc-excerpt", text: doc.excerpt });
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
    if (doc.sourceName && doc.sourceName !== doc.title) meta.push(doc.sourceName);
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

  private async importProjectDocumentsToWhiteboard(
    project: LifeOSProject,
    summary: LifeOSProjectSummary,
    service: ProjectDocumentService,
    whiteboards: ProjectWhiteboardService,
    overview: LifeOSProjectOverview
  ): Promise<void> {
    if (!requireProFeature(this.plugin, "projectDocuments")) return;
    new ImportProjectDocumentsModal(this.app, project, service, async (documents) => {
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
