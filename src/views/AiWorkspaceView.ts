import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { createButton } from "../components/Button";
import { createCard } from "../components/Card";
import { createEmptyState } from "../components/EmptyState";
import { createHeroHeader } from "../components/HeroHeader";
import { createLifeOSShell } from "../components/LifeOSComponent";
import { AI_WORKSPACE_VIEW_TYPE } from "../constants";
import type PersonalLifeSystemPlugin from "../main";
import {
  AiWorkspaceBindingModal,
  AiWorkspaceContinuationModal,
  AiWorkspaceFileSegmentModal,
  AiWorkspaceHandoffAddendumModal,
  AiWorkspaceHandoffGeneratorModal,
  AiWorkspaceImportModal,
  AiWorkspacePromptModal
} from "../modals/AiWorkspaceModals";
import { NewProjectModal } from "../modals/NewProjectModal";
import { AiWorkspaceService } from "../services/AiWorkspaceService";
import {
  cleanWorkspaceDisplayText,
  summarizeWorkspaceNode,
  workspaceSessionDisplayTitle
} from "../services/ai-workspace/logic";
import {
  buildConversationGraphLayout,
  graphNodeAtPoint,
  graphVisibleRange,
  type AiWorkspaceGraphNode
} from "../services/ai-workspace/graph";
import { FileSystemService } from "../services/FileSystemService";
import { ProjectService } from "../services/ProjectService";
import {
  AI_WORKSPACE_TOOLS,
  aiWorkspaceToolLabel,
  type AiWorkspaceTool,
  AiWorkspaceAgentPermission,
  AiWorkspaceImportResult,
  AiWorkspaceMessage,
  AiWorkspaceNodeIndex,
  AiWorkspacePromptAsset,
  AiWorkspaceRevisionManifest,
  AiWorkspaceSessionSummary,
  AiWorkspaceState
} from "../services/ai-workspace/types";
import type { LifeOSProject } from "../types";
import { formatDate } from "../utils/dates";
import { renderMarkdownDisplay } from "../utils/markdown-render";

type AiWorkspaceTab = "overview" | "sessions" | "tree" | "versions" | "prompts";
type ReaderFilter = "all" | "user" | "assistant" | "important";
type ReaderOrder = "newest" | "oldest";

const READER_PAGE_SIZE = 80;

export class AiWorkspaceView extends ItemView {
  private selectedProjectId = "";
  private selectedSessionId = "";
  private selectedRevisionId = "";
  private activeTab: AiWorkspaceTab = "overview";
  private readerOffset = 0;
  private readerFilter: ReaderFilter = "all";
  private readerOrder: ReaderOrder = "newest";
  private readerSearch = "";
  private collapseOrdinary = false;
  private pendingJumpNodeId = "";
  private focusedNodeId = "";
  private treeResizeObserver: ResizeObserver | null = null;
  private treeAnimationFrame = 0;
  private expandedMessageIds = new Set<string>();
  private rendering = false;
  private renderQueued = false;
  private disposed = false;

  constructor(leaf: WorkspaceLeaf, private plugin: PersonalLifeSystemPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return AI_WORKSPACE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "项目上下文";
  }

  getIcon(): string {
    return "git-branch";
  }

  async onOpen(): Promise<void> {
    this.disposed = false;
    await this.render();
  }

  async onClose(): Promise<void> {
    this.disposed = true;
    this.renderQueued = false;
    this.disposeTreeCanvas();
  }

  async refreshFromAutoSync(): Promise<void> {
    await this.render();
  }

  private service(): AiWorkspaceService {
    return new AiWorkspaceService(
      this.app,
      new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage),
      this.plugin.settings,
      this.plugin.ai
    );
  }

  private async render(): Promise<void> {
    if (this.disposed) return;
    if (this.rendering) {
      this.renderQueued = true;
      return;
    }
    this.rendering = true;
    try {
      do {
        this.renderQueued = false;
        await this.renderOnce();
      } while (this.renderQueued && !this.disposed);
    } finally {
      this.rendering = false;
    }
  }

  private async renderOnce(): Promise<void> {
    try {
      await this.plugin.ensureBaseStructure();
      const service = this.service();
      const projectService = new ProjectService(
        this.app,
        new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage)
      );
      const [projects, state] = await Promise.all([projectService.loadProjects(), service.loadState(true)]);
      this.normalizeSelection(projects, state);
      const container = this.containerEl.children[1] as HTMLElement;
      this.disposeTreeCanvas();
      container.empty();
      const main = createLifeOSShell(container, this.plugin, "workspace");
      main.addClass("lifeos-ai-workspace");
      this.renderHero(main, projects, state, service);
      if (projects.length === 0) {
        this.renderNoProjects(main);
        return;
      }
      this.renderProjectBar(main, projects, state);
      this.renderTabs(main);
      const body = main.createDiv({ cls: `lifeos-ai-workspace-body is-${this.activeTab}` });
      if (this.activeTab === "overview") await this.renderOverview(body, projects, state, service);
      if (this.activeTab === "sessions") await this.renderSessions(body, projects, state, service);
      if (this.activeTab === "tree") await this.renderTree(body, projects, state, service);
      if (this.activeTab === "versions") await this.renderVersions(body, projects, state, service);
      if (this.activeTab === "prompts") await this.renderPrompts(body, projects, state, service);
    } catch (error) {
      console.error("[Life OS] AI Workspace render failed.", error);
      this.renderFailure(error);
    }
  }

  private renderFailure(error: unknown): void {
    const container = this.containerEl.children[1] as HTMLElement | undefined;
    if (!container) return;
    container.empty();
    const main = container.createDiv({ cls: "lifeos-ai-workspace-failure" });
    setIcon(main.createSpan(), "triangle-alert");
    const copy = main.createDiv();
    copy.createEl("strong", { text: "项目上下文暂时无法显示" });
    copy.createEl("p", {
      text: error instanceof Error
        ? `页面数据没有被修改。错误：${error.message}`
        : "页面数据没有被修改，请重试。"
    });
    createButton(main, "重新加载", () => void this.render(), { icon: "refresh-cw", primary: true });
  }

  private renderHero(
    main: HTMLElement,
    projects: LifeOSProject[],
    state: AiWorkspaceState,
    service: AiWorkspaceService
  ): void {
    const selected = projects.find((project) => project.id === this.selectedProjectId);
    const projectSessions = state.sessions.filter((session) => session.projectId === selected?.id);
    createHeroHeader(main, {
      kicker: "项目上下文",
      title: selected ? `${selected.name} 的 AI 协作历史` : "把 AI 协作变成可继续的项目资产",
      description: selected
        ? `${projectSessions.length} 个会话按来源工具分开管理；每条可见对话都是可追溯节点。`
        : "绑定工作目录，主动导入会话，再把确认后的结论、任务、提示词和项目事实接回 Life OS。",
      icon: "git-branch",
      actions: selected ? [
        {
          label: "绑定目录",
          icon: "folder-cog",
          onClick: () => this.openBinding(selected, service)
        },
        {
          label: "导入会话",
          icon: "scan-search",
          primary: true,
          onClick: () => this.openImport(selected, service)
        }
      ] : [
        {
          label: "新建项目",
          icon: "folder-plus",
          primary: true,
          onClick: () => this.openNewProjectWizard()
        }
      ]
    });
  }

  private renderNoProjects(main: HTMLElement): void {
    createEmptyState(main, {
      icon: "folder-plus",
      title: "先创建一个项目",
      description: "会话归属由用户选择。创建项目后再绑定工作目录，不会自动发现或导入未归属会话。",
      actions: [{
        label: "添加项目",
        icon: "folder-plus",
        primary: true,
        onClick: () => this.openNewProjectWizard()
      }]
    });
  }

  private renderProjectBar(
    main: HTMLElement,
    projects: LifeOSProject[],
    state: AiWorkspaceState
  ): void {
    const bar = main.createDiv({ cls: "lifeos-ai-workspace-project-bar" });
    const selectorWrap = bar.createDiv({ cls: "lifeos-ai-workspace-project-selector" });
    setIcon(selectorWrap.createSpan(), "folder-kanban");
    const selector = selectorWrap.createEl("select", {
      cls: "lifeos-input lifeos-glass-input",
      attr: { "aria-label": "选择项目" }
    });
    for (const project of projects) {
      const count = state.sessions.filter((session) => session.projectId === project.id).length;
      selector.createEl("option", { value: project.id, text: `${project.name} · ${count} 个会话` });
    }
    selector.value = this.selectedProjectId;
    selector.addEventListener("change", () => {
      this.selectedProjectId = selector.value;
      this.selectedSessionId = "";
      this.selectedRevisionId = "";
      this.resetReaderState();
      void this.render();
    });
    const active = projects.filter((project) => project.status === "active").length;
    const pending = state.dailyFacts.filter((fact) => fact.status === "pending").length;
    const meta = bar.createDiv({ cls: "lifeos-ai-workspace-project-meta" });
    const tracked = state.sessions.filter((session) =>
      session.projectId === this.selectedProjectId && session.tracking.enabled
    ).length;
    meta.createSpan({ text: `${active} 个进行中项目` });
    meta.createSpan({ text: `${tracked} 个自动跟踪` });
    meta.createSpan({ text: `${pending} 条日报候选` });
    const actions = bar.createDiv({ cls: "lifeos-ai-workspace-inline-actions" });
    createButton(actions, "新建项目", () => this.openNewProjectWizard(), {
      icon: "folder-plus",
      ghost: true
    });
    createButton(actions, "刷新", () => void this.render(), { icon: "refresh-cw", ghost: true });
    createButton(actions, "检查会话更新", () => void this.plugin.refreshTrackedAiWorkspaceSessions(true), {
      icon: "radio-tower",
      ghost: true
    });
    if (state.lastScanAt) {
      actions.createSpan({
        cls: "lifeos-ai-workspace-last-scan",
        text: `上次检查 ${this.formatTime(state.lastScanAt)}`
      });
    }
  }

  private renderTabs(main: HTMLElement): void {
    const tabs: Array<{ id: AiWorkspaceTab; label: string; icon: string }> = [
      { id: "overview", label: "项目总览", icon: "layout-dashboard" },
      { id: "sessions", label: "会话阅读器", icon: "messages-square" },
      { id: "tree", label: "会话过程树", icon: "git-fork" },
      { id: "versions", label: "会话交接", icon: "clipboard-copy" },
      { id: "prompts", label: "提示词库", icon: "braces" }
    ];
    const tabbar = main.createDiv({ cls: "lifeos-ai-workspace-tabs", attr: { role: "tablist" } });
    for (const tab of tabs) {
      const button = tabbar.createEl("button", {
        cls: tab.id === this.activeTab ? "lifeos-ai-workspace-tab is-active" : "lifeos-ai-workspace-tab",
        attr: { type: "button", role: "tab", "aria-selected": tab.id === this.activeTab ? "true" : "false" }
      });
      setIcon(button.createSpan(), tab.icon);
      button.createSpan({ text: tab.label });
      button.addEventListener("click", () => {
        this.activeTab = tab.id;
        void this.render();
      });
    }
  }

  private async renderOverview(
    parent: HTMLElement,
    projects: LifeOSProject[],
    state: AiWorkspaceState,
    service: AiWorkspaceService
  ): Promise<void> {
    const project = this.currentProject(projects);
    if (!project) return;
    const projectSessions = this.projectSessions(state);
    const binding = state.bindings.find((item) => item.projectId === project.id);
    const facts = state.dailyFacts.filter((fact) =>
      fact.projectId === project.id
      && fact.date === formatDate()
      && fact.status !== "dismissed"
    );
    const pendingFacts = facts.filter((fact) => fact.status === "pending");
    const confirmedFacts = facts.filter((fact) => fact.status === "confirmed");
    const latestSession = projectSessions[0];
    const brief = parent.createDiv({ cls: "lifeos-ai-workspace-overview-brief" });
    const briefCopy = brief.createDiv();
    briefCopy.createSpan({ cls: "lifeos-ai-workspace-overview-eyebrow", text: "当前项目" });
    briefCopy.createEl("strong", { text: project.goal || "尚未填写项目目标" });
    briefCopy.createEl("p", {
      text: latestSession
        ? this.analysisPreview(
          latestSession.activity?.summary || latestSession.analysis.summary,
          `最近更新了“${this.sessionTitle(latestSession)}”`,
          260
        )
        : "绑定目录并导入第一段会话后，这里会显示项目当前推进到哪里。"
    });
    const briefMeta = brief.createDiv({ cls: "lifeos-ai-workspace-overview-meta" });
    briefMeta.createSpan({
      cls: `lifeos-ai-workspace-badge ${project.status === "active" ? "is-success" : ""}`,
      text: project.status === "active" ? "进行中" : project.status === "paused" ? "已暂停" : "已完成"
    });
    briefMeta.createSpan({ text: latestSession ? `最近活动 ${this.formatTime(latestSession.updatedAt)}` : "暂无活动" });
    const stats = parent.createDiv({ cls: "lifeos-ai-workspace-stats" });
    this.stat(stats, String(projectSessions.length), "已导入会话", "按工具分开管理");
    this.stat(stats, String(projectSessions.reduce((sum, session) => sum + session.messageCount, 0)), "可追溯节点", "每条可见对话一个节点");
    this.stat(
      stats,
      String(facts.length),
      "今日日报摘要",
      confirmedFacts.length > 0 ? `${confirmedFacts.length} 条已由 AI 写入保护区` : `${pendingFacts.length} 条待确认`
    );
    this.stat(stats, String(state.prompts.filter((prompt) => prompt.status === "active" && (!prompt.projectId || prompt.projectId === project.id)).length), "可用提示词", "全局与项目专属");

    const layout = parent.createDiv({ cls: "lifeos-ai-workspace-overview-grid" });
    const mainColumn = layout.createDiv({ cls: "lifeos-ai-workspace-overview-main" });
    const sideColumn = layout.createDiv({ cls: "lifeos-ai-workspace-overview-side" });

    const activity = createCard(mainColumn, "lifeos-panel lifeos-ai-workspace-panel");
    this.panelHeading(activity, "最近项目活动", "按会话更新时间排序", "activity");
    if (projectSessions.length === 0) {
      createEmptyState(activity, {
        icon: "messages-square",
        title: "还没有导入会话",
        description: binding?.workDirectories.length
          ? "目录已绑定。主动检查后选择需要的会话，再预览导入。"
          : "先绑定项目工作目录，系统才能判断哪些会话属于这个项目。",
        actions: [{
          label: binding?.workDirectories.length ? "检查并导入" : "绑定工作目录",
          icon: binding?.workDirectories.length ? "scan-search" : "folder-cog",
          primary: true,
          onClick: () => binding?.workDirectories.length
            ? this.openImport(project, service)
            : this.openBinding(project, service)
        }]
      });
    } else {
      for (const session of projectSessions.slice(0, 6)) this.renderActivityRow(activity, session);
      const handoff = activity.createDiv({ cls: "lifeos-ai-workspace-handoff" });
      handoff.createEl("strong", { text: "建议从这里继续" });
      const latest = projectSessions[0];
      handoff.createEl("p", {
        text: this.analysisPreview(
          latest.analysis.tasks.find((task) => task.status !== "dismissed")?.text
            || latest.analysis.summary,
          "打开最近会话，核对当前结论和下一步。",
          220
        )
      });
      const actions = handoff.createDiv({ cls: "lifeos-ai-workspace-inline-actions" });
      createButton(actions, "打开会话", () => {
        this.selectedSessionId = latest.id;
        this.selectedRevisionId = latest.currentRevisionId;
        this.activeTab = "sessions";
        void this.render();
      }, { icon: "messages-square", primary: true });
      createButton(actions, "迁移会话或项目", () => new AiWorkspaceContinuationModal(this.app, this.plugin, service, latest).open(), {
        icon: "arrow-right-left",
        ghost: true
      });
    }

    const daily = createCard(mainColumn, "lifeos-panel lifeos-ai-workspace-panel");
    this.panelHeading(daily, "日报中的项目活动", "增量总结写入保护区，不覆盖用户正文", "notebook-pen");
    this.renderDailyFacts(daily, facts, service);

    const tools = createCard(sideColumn, "lifeos-panel lifeos-ai-workspace-panel");
    this.panelHeading(tools, "工具与目录", binding ? "已绑定" : "待绑定", "folder-cog");
    if (!binding?.workDirectories.length) {
      tools.createEl("p", { cls: "lifeos-ai-workspace-muted", text: "尚未绑定项目工作目录。" });
    } else {
      for (const directory of binding.workDirectories) {
        const row = tools.createDiv({ cls: "lifeos-ai-workspace-path-row" });
        setIcon(row.createSpan(), "folder");
        row.createEl("code", { text: directory });
      }
    }
    const toolCounts = tools.createDiv({ cls: "lifeos-ai-workspace-tool-counts" });
    const visibleTools = AI_WORKSPACE_TOOLS.filter((tool) =>
      projectSessions.some((session) => session.tool === tool)
    );
    for (const tool of visibleTools) {
      const count = projectSessions.filter((session) => session.tool === tool).length;
      const row = toolCounts.createDiv({ cls: `lifeos-ai-workspace-tool-count is-${tool}` });
      row.createEl("strong", { text: this.toolLabel(tool) });
      row.createSpan({ text: `${count} 个会话` });
    }
    if (visibleTools.length === 0) {
      toolCounts.createDiv({ cls: "lifeos-ai-workspace-empty-inline", text: "尚未导入任何工具会话。" });
    }
    const memoryCount = state.projectMemories.filter((memory) =>
      memory.projectId === project.id && memory.status !== "missing"
    ).length;
    const memoryStatus = tools.createDiv({ cls: "lifeos-ai-workspace-project-memory-status" });
    setIcon(memoryStatus.createSpan(), "brain");
    const memoryCopy = memoryStatus.createDiv();
    memoryCopy.createEl("strong", { text: "项目记忆" });
    memoryCopy.createSpan({
      text: memoryCount > 0
        ? `${memoryCount} 个项目规则或工具记忆来源已版本化，交接时自动带入`
        : "会话进展会形成共享记忆；尚未发现项目规则或已授权的工具记忆"
    });
    const toolActions = tools.createDiv({ cls: "lifeos-ai-workspace-inline-actions" });
    createButton(toolActions, "更新项目记忆", () => void (async () => {
      const memories = await service.refreshProjectMemory(project.id);
      new Notice(`项目记忆已更新：${memories.length} 个来源文件。`, 5000);
      await this.render();
    })(), { icon: "refresh-cw", ghost: true });
    createButton(toolActions, "管理目录与来源", () => this.openBinding(project, service), {
      icon: "settings-2",
      ghost: true
    });

    const agent = createCard(sideColumn, "lifeos-panel lifeos-ai-workspace-panel");
    this.panelHeading(agent, "Life OS Agent 权限", this.permissionLabel(state.agentPermission), "shield-check");
    agent.createEl("p", {
      cls: "lifeos-ai-workspace-muted",
      text: "权限控制 Agent 能否写入 Workspace、项目资产或启动外部工具；当天会话更新会先由 AI 增量总结，再写入日报保护区。"
    });
    const select = agent.createEl("select", { cls: "lifeos-input lifeos-glass-input" });
    const permissions: Array<[AiWorkspaceAgentPermission, string]> = [
      ["read-only", "只读：读取摘要与确认事实"],
      ["workspace-write", "Workspace 写入：可生成摘要和提示词"],
      ["project-write", "项目写入：可创建项目资产候选"],
      ["full", "完整权限：允许启动外部工具"]
    ];
    for (const [value, label] of permissions) select.createEl("option", { value, text: label });
    select.value = state.agentPermission;
    select.addEventListener("change", () => void (async () => {
      await service.setAgentPermission(select.value as AiWorkspaceAgentPermission);
      new Notice("Life OS Agent 权限已更新。", 4000);
      await this.render();
    })());
  }

  private async renderSessions(
    parent: HTMLElement,
    projects: LifeOSProject[],
    state: AiWorkspaceState,
    service: AiWorkspaceService
  ): Promise<void> {
    const project = this.currentProject(projects);
    if (!project) return;
    const sessions = this.projectSessions(state);
    if (sessions.length === 0) {
      createEmptyState(parent, {
        icon: "messages-square",
        title: "没有可阅读的项目会话",
        description: "导入后，消息会从上往下显示，长会话按页加载，并可搜索、收起和节点跳转。",
        actions: [{
          label: "导入会话",
          icon: "scan-search",
          primary: true,
          onClick: () => this.openImport(project, service)
        }]
      });
      return;
    }
    const session = this.currentSession(sessions);
    if (!session) return;
    const revisionId = this.selectedRevisionId || session.currentRevisionId;
    const manifest = await service.getRevisionManifest(session, revisionId);
    const layout = parent.createDiv({ cls: "lifeos-ai-workspace-reader-layout" });
    const sessionRail = layout.createEl("aside", { cls: "lifeos-ai-workspace-session-rail" });
    this.renderSessionRail(sessionRail, sessions);
    const reader = layout.createEl("section", { cls: "lifeos-ai-workspace-reader" });
    await this.renderReader(reader, session, revisionId, manifest, service, projects);
    const outline = layout.createEl("aside", { cls: "lifeos-ai-workspace-outline" });
    this.renderOutline(outline, session, manifest);
  }

  private renderSessionRail(parent: HTMLElement, sessions: AiWorkspaceSessionSummary[]): void {
    const head = parent.createDiv({ cls: "lifeos-ai-workspace-rail-head" });
    head.createEl("strong", { text: "项目会话" });
    head.createEl("span", { text: `${sessions.length} 个` });
    for (const tool of AI_WORKSPACE_TOOLS) {
      const toolSessions = sessions.filter((session) => session.tool === tool);
      if (toolSessions.length === 0) continue;
      const group = parent.createDiv({ cls: `lifeos-ai-workspace-session-group is-${tool}` });
      const title = group.createDiv({ cls: "lifeos-ai-workspace-session-group-title" });
      title.createEl("strong", { text: this.toolLabel(tool) });
      title.createSpan({ text: String(toolSessions.length) });
      for (const session of toolSessions) {
        const displayTitle = this.sessionTitle(session);
        const button = group.createEl("button", {
          cls: session.id === this.selectedSessionId
            ? "lifeos-ai-workspace-session-button is-active"
            : "lifeos-ai-workspace-session-button",
          attr: { type: "button", title: displayTitle }
        });
        button.createEl("strong", { text: displayTitle });
        button.createEl("span", { text: `${session.messageCount} 节点 · ${this.shortTime(session.updatedAt)}` });
        button.addEventListener("click", () => {
          this.selectedSessionId = session.id;
          this.selectedRevisionId = session.currentRevisionId;
          this.resetReaderState();
          void this.render();
        });
      }
    }
  }

  private async renderReader(
    parent: HTMLElement,
    session: AiWorkspaceSessionSummary,
    revisionId: string,
    manifest: AiWorkspaceRevisionManifest | null,
    service: AiWorkspaceService,
    projects: LifeOSProject[]
  ): Promise<void> {
    const head = parent.createDiv({ cls: "lifeos-ai-workspace-reader-head" });
    const copy = head.createDiv();
    const tool = copy.createDiv({ cls: `lifeos-ai-workspace-tool-label is-${session.tool}`, text: this.sourceLabel(session) });
    tool.setAttr("title", `来源：${this.sourceLabel(session)}`);
    copy.createEl("h2", { text: this.sessionTitle(session, 96) });
    copy.createEl("p", {
      text: `${session.tool === "web" ? session.sourceUrl || "未记录原始网页" : session.cwd || "未记录工作目录"} · ${session.messageCount} 个节点 · ${session.revisions.length} 个版本`
    });
    copy.createEl("small", {
      cls: `lifeos-ai-workspace-tracking-status is-${session.tracking.status}`,
      text: session.tool === "web"
        ? "浏览器扩展保存新内容时自动追加"
        : `${session.tracking.enabled ? "自动跟踪中" : "自动跟踪已暂停"} · ${session.tracking.message || "等待检查更新"}`
    });
    const actions = head.createDiv({ cls: "lifeos-ai-workspace-inline-actions" });
    const lifecycle = actions.createEl("select", {
      cls: "lifeos-input lifeos-glass-input lifeos-ai-workspace-lifecycle-select",
      attr: { "aria-label": "会话状态" }
    });
    for (const value of ["active", "done", "paused", "stale"] as AiWorkspaceSessionSummary["lifecycle"][]) {
      lifecycle.createEl("option", { value, text: this.lifecycleLabel(value) });
    }
    lifecycle.value = session.lifecycle;
    lifecycle.addEventListener("change", () => void (async () => {
      await service.setSessionLifecycle(
        session.id,
        lifecycle.value as AiWorkspaceSessionSummary["lifecycle"]
      );
      new Notice("会话状态已更新。", 4000);
      await this.render();
    })());
    if (session.tool !== "web") {
      const tracking = createButton(
        actions,
        session.tracking.enabled ? "暂停自动跟踪" : "开启自动跟踪",
        () => void (async () => {
          await service.setSessionTracking(session.id, !session.tracking.enabled);
          new Notice(session.tracking.enabled ? "已暂停自动跟踪。" : "已开启自动跟踪。", 4000);
          await this.render();
        })(),
        {
          icon: session.tracking.enabled ? "pause-circle" : "radio",
          ghost: true
        }
      );
      tracking.addClass("lifeos-ai-workspace-tracking-button");
      tracking.toggleClass("is-active", session.tracking.enabled);
      tracking.setAttr(
        "title",
        session.tracking.enabled
          ? "暂停后不再自动检查这个会话的新消息"
          : "开启后定期检查并自动追加这个会话的新消息"
      );
    }
    createButton(actions, "AI 整理", () => void this.analyzeSession(session, service), { icon: "sparkles", ghost: true });
    createButton(actions, "迁移到其他工具", () => new AiWorkspaceContinuationModal(this.app, this.plugin, service, session).open(), {
      icon: "arrow-right-left",
      primary: true
    });

    const toolbar = parent.createDiv({ cls: "lifeos-ai-workspace-reader-toolbar" });
    const revision = toolbar.createEl("select", {
      cls: "lifeos-input lifeos-glass-input",
      attr: { "aria-label": "选择会话版本" }
    });
    for (const item of [...session.revisions].reverse()) {
      revision.createEl("option", { value: item.id, text: `${item.id} · ${this.reasonLabel(item.reason)} · ${item.messageCount} 条` });
    }
    revision.value = revisionId;
    revision.addEventListener("change", () => {
      this.selectedRevisionId = revision.value;
      this.resetReaderState();
      void this.render();
    });
    const search = toolbar.createEl("input", {
      cls: "lifeos-input lifeos-glass-input lifeos-ai-workspace-reader-search",
      attr: { type: "search", placeholder: "搜索消息、结论或文件路径", value: this.readerSearch }
    });
    search.addEventListener("input", () => {
      this.readerSearch = search.value;
      this.renderSearchMatches(parent, manifest, search.value);
    });
    const filters = toolbar.createDiv({ cls: "lifeos-ai-workspace-reader-filters" });
    for (const [value, label] of [
      ["all", "全部"],
      ["user", "用户"],
      ["assistant", "AI"],
      ["important", "关键"]
    ] as Array<[ReaderFilter, string]>) {
      const button = filters.createEl("button", {
        cls: value === this.readerFilter ? "is-active" : "",
        attr: { type: "button" },
        text: label
      });
      button.addEventListener("click", () => {
        this.readerFilter = value;
        void this.render();
      });
    }
    const order = toolbar.createDiv({ cls: "lifeos-ai-workspace-reader-order", attr: { role: "group", "aria-label": "阅读顺序" } });
    for (const [value, label] of [["newest", "最新优先"], ["oldest", "从头阅读"]] as Array<[ReaderOrder, string]>) {
      const button = order.createEl("button", {
        cls: value === this.readerOrder ? "is-active" : "",
        attr: { type: "button" },
        text: label
      });
      button.addEventListener("click", () => {
        this.readerOrder = value;
        this.readerOffset = 0;
        this.pendingJumpNodeId = "";
        void this.render();
      });
    }
    createButton(toolbar, this.collapseOrdinary ? "展开普通对话" : "收起普通对话", () => {
      this.collapseOrdinary = !this.collapseOrdinary;
      void this.render();
    }, { icon: this.collapseOrdinary ? "chevrons-down" : "chevrons-up", ghost: true });
    const matchHost = parent.createDiv({ cls: "lifeos-ai-workspace-search-matches" });
    matchHost.hide();

    if (!manifest) {
      parent.createDiv({ cls: "lifeos-ai-workspace-error", text: "当前版本索引无法读取，请重新导入该会话或切换旧版本。" });
      return;
    }
    if (this.pendingJumpNodeId) {
      const target = manifest.nodes.find((node) => node.id === this.pendingJumpNodeId);
      if (target) {
        const logicalSequence = this.readerOrder === "newest"
          ? Math.max(0, manifest.nodes.length - 1 - target.sequence)
          : target.sequence;
        this.readerOffset = Math.floor(logicalSequence / READER_PAGE_SIZE) * READER_PAGE_SIZE;
      }
    }
    const pageLimit = Math.min(READER_PAGE_SIZE, Math.max(1, manifest.nodes.length - this.readerOffset));
    const sourceOffset = this.readerOrder === "newest"
      ? Math.max(0, manifest.nodes.length - this.readerOffset - pageLimit)
      : this.readerOffset;
    const page = await service.loadMessagePage(session, revisionId, sourceOffset, pageLimit);
    const chat = parent.createDiv({ cls: "lifeos-ai-workspace-chat" });
    const orderedMessages = this.readerOrder === "newest"
      ? [...page.messages].reverse()
      : page.messages;
    const visible = orderedMessages.filter((message) => this.messageVisible(message));
    if (visible.length === 0) {
      chat.createDiv({ cls: "lifeos-ai-workspace-empty-inline", text: "当前页没有符合筛选条件的消息。" });
    } else {
      for (const message of visible) this.renderMessage(chat, message, session, service, projects);
    }
    const pager = parent.createDiv({ cls: "lifeos-ai-workspace-reader-pager" });
    const start = Math.min(page.total, this.readerOffset + 1);
    const end = Math.min(page.total, this.readerOffset + page.messages.length);
    pager.createSpan({
      text: `${this.readerOrder === "newest" ? "按最新计" : "按最早计"} ${start}-${end} / ${page.total}`
    });
    createButton(pager, this.readerOrder === "newest" ? "更新一页" : "上一页", () => {
      this.readerOffset = Math.max(0, this.readerOffset - READER_PAGE_SIZE);
      this.pendingJumpNodeId = "";
      this.focusedNodeId = "";
      void this.render();
    }, { icon: "chevron-left", ghost: true }).disabled = this.readerOffset <= 0;
    createButton(pager, this.readerOrder === "newest" ? "更早一页" : "下一页", () => {
      this.readerOffset += READER_PAGE_SIZE;
      this.pendingJumpNodeId = "";
      this.focusedNodeId = "";
      void this.render();
    }, { icon: "chevron-right", ghost: true }).disabled = this.readerOffset + page.messages.length >= page.total;
    if (this.pendingJumpNodeId) {
      const pendingNodeId = this.pendingJumpNodeId;
      window.setTimeout(() => {
        if (!parent.isConnected) return;
        const node = parent.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(pendingNodeId)}"]`);
        if (!node) return;
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        node.addClass("is-focused");
        if (this.pendingJumpNodeId === pendingNodeId) this.pendingJumpNodeId = "";
      }, 0);
    }
  }

  private renderSearchMatches(
    readerParent: HTMLElement,
    manifest: AiWorkspaceRevisionManifest | null,
    query: string
  ): void {
    const host = readerParent.querySelector<HTMLElement>(".lifeos-ai-workspace-search-matches");
    if (!host) return;
    host.empty();
    const normalized = query.trim().toLowerCase();
    if (!manifest || !normalized) {
      host.hide();
      return;
    }
    const matches = manifest.nodes.filter((node) =>
      node.preview.toLowerCase().includes(normalized)
      || node.summary?.toLowerCase().includes(normalized)
      || node.fileReferences.some((file) => file.path.toLowerCase().includes(normalized))
    ).slice(0, 30);
    host.show();
    const head = host.createDiv({ cls: "lifeos-ai-workspace-search-head" });
    head.createEl("strong", { text: `找到 ${matches.length}${matches.length === 30 ? "+" : ""} 个节点` });
    createButton(head, "关闭", () => {
      host.hide();
    }, { icon: "x", ghost: true });
    for (const node of matches) {
      const button = host.createEl("button", { cls: "lifeos-ai-workspace-search-result", attr: { type: "button" } });
      button.createEl("strong", { text: `#${node.sequence + 1} · ${this.roleLabel(node.role)}` });
      button.createEl("span", { text: this.nodeSummary(node, 120) });
      button.addEventListener("click", () => this.jumpToNode(node.id));
    }
  }

  private renderMessage(
    parent: HTMLElement,
    message: AiWorkspaceMessage,
    session: AiWorkspaceSessionSummary,
    service: AiWorkspaceService,
    projects: LifeOSProject[]
  ): void {
    const article = parent.createEl("article", {
      cls: `lifeos-ai-workspace-message is-${message.role}${message.sequence === 0 && message.role === "user" ? " is-opening" : ""}${message.important ? " is-important" : ""}${message.id === this.focusedNodeId ? " is-focused" : ""}`,
      attr: { "data-node-id": message.id }
    });
    const marker = article.createDiv({ cls: "lifeos-ai-workspace-message-marker" });
    marker.createSpan({ text: message.role === "user" ? "你" : message.role === "assistant" ? "AI" : "T" });
    const content = article.createDiv({ cls: "lifeos-ai-workspace-message-content" });
    const meta = content.createDiv({ cls: "lifeos-ai-workspace-message-meta" });
    meta.createEl("strong", { text: message.role === "assistant" ? this.sourceLabel(session) : this.roleLabel(message.role) });
    meta.createEl("time", { text: this.formatTime(message.timestamp) });
    meta.createSpan({ text: `节点 ${message.sequence + 1}` });
    if (message.sequence === 0 && message.role === "user") {
      meta.createSpan({ cls: "lifeos-ai-workspace-badge", text: "会话起点" });
    }
    if (message.important) meta.createSpan({ cls: "lifeos-ai-workspace-badge is-warning", text: "关键" });
    const messageActions = meta.createDiv({ cls: "lifeos-ai-workspace-message-actions" });
    createButton(messageActions, "查看过程节点", () => {
      this.activeTab = "tree";
      this.pendingJumpNodeId = message.id;
      this.focusedNodeId = message.id;
      void this.render();
    }, { icon: "git-commit-horizontal", ghost: true });
    createButton(messageActions, "复制全文", () => void (async () => {
      await navigator.clipboard.writeText(message.content);
      new Notice("这条对话的完整内容已复制。", 4000);
    })(), { icon: "copy", ghost: true });
    if (message.role !== "tool") {
      createButton(messageActions, "存入提示词库", () => new AiWorkspacePromptModal(this.app, service, projects, {
        title: this.promptTitleFromMessage(message),
        body: message.content,
        scope: "project",
        projectId: session.projectId,
        tool: session.tool,
        sourceSessionId: session.id,
        sourceNodeIds: [message.id]
      }, () => this.render()).open(), { icon: "bookmark-plus", ghost: true });
    }
    const body = content.createDiv({ cls: "lifeos-ai-workspace-message-body" });
    const isLongMessage = message.content.length > 1800 || message.content.split(/\r?\n/u).length > 36;
    const isExpanded = this.expandedMessageIds.has(message.id);
    if (isLongMessage && !isExpanded) {
      body.addClass("is-collapsed-preview");
      body.createEl("p", { text: cleanWorkspaceDisplayText(message.content, 900) });
    } else {
      renderMarkdownDisplay(this.app, this, body, message.content, session.notePath);
    }
    if (isLongMessage) {
      createButton(content, isExpanded ? "收起长内容" : "展开完整内容", () => {
        if (isExpanded) this.expandedMessageIds.delete(message.id);
        else this.expandedMessageIds.add(message.id);
        void this.render();
      }, { icon: isExpanded ? "chevron-up" : "chevron-down", ghost: true });
    }
    if (message.fileReferences.length > 0) {
      const files = content.createDiv({ cls: "lifeos-ai-workspace-message-files" });
      for (const file of message.fileReferences.slice(0, 12)) {
        const absolute = this.resolveFilePath(session.cwd, file.path);
        const button = files.createEl("button", { attr: { type: "button", title: absolute } });
        setIcon(button.createSpan(), "file-code-2");
        button.createSpan({ text: file.path });
        button.addEventListener("click", () => new AiWorkspaceFileSegmentModal(this.app, service, absolute, file.line ?? 1).open());
      }
    }
  }

  private renderOutline(
    parent: HTMLElement,
    session: AiWorkspaceSessionSummary,
    manifest: AiWorkspaceRevisionManifest | null
  ): void {
    const head = parent.createDiv({ cls: "lifeos-ai-workspace-rail-head" });
    head.createEl("strong", { text: "会话提纲" });
    head.createEl("span", { text: this.readerOrder === "newest" ? "最新在前" : "最早在前" });
    const analysisByNode = new Map(session.analysis.outline.map((item) => [item.nodeId, item]));
    const nodes = (manifest?.nodes ?? []).filter((node) => node.role !== "tool");
    const orderedNodes = this.readerOrder === "newest" ? [...nodes].reverse() : nodes;
    const items = orderedNodes.slice(0, 120).map((node) => {
      const analyzed = analysisByNode.get(node.id);
      return {
        nodeId: node.id,
        title: `${String(node.sequence + 1).padStart(2, "0")} · ${this.roleLabel(node.role)}`,
        description: analyzed?.description || node.summary || summarizeWorkspaceNode(node.preview, node.role)
      };
    });
    for (const item of items.slice(0, 120)) {
      const button = parent.createEl("button", {
        cls: "lifeos-ai-workspace-outline-button",
        attr: { type: "button" }
      });
      button.createEl("strong", { text: cleanWorkspaceDisplayText(item.title, 48) });
      button.createEl("span", { text: cleanWorkspaceDisplayText(item.description, 110) });
      button.addEventListener("click", () => this.jumpToNode(item.nodeId));
    }
  }

  private async renderTree(
    parent: HTMLElement,
    projects: LifeOSProject[],
    state: AiWorkspaceState,
    service: AiWorkspaceService
  ): Promise<void> {
    const sessions = this.projectSessions(state);
    if (sessions.length === 0) {
      parent.createDiv({ cls: "lifeos-ai-workspace-empty-inline", text: "导入会话后，这里会按工具展示每一条对话节点。" });
      return;
    }
    const session = this.currentSession(sessions);
    if (!session) return;
    const manifest = await service.getRevisionManifest(session, this.selectedRevisionId || session.currentRevisionId);
    if (!manifest) {
      parent.createDiv({ cls: "lifeos-ai-workspace-error", text: "当前版本节点索引无法读取。" });
      return;
    }
    const panel = createCard(parent, "lifeos-panel lifeos-ai-workspace-tree-panel");
    const header = panel.createDiv({ cls: "lifeos-ai-workspace-tree-head" });
    const copy = header.createDiv();
    copy.createEl("strong", { text: `${this.toolLabel(session.tool)} · ${this.sessionTitle(session, 96)}` });
    copy.createEl("p", { text: `${manifest.nodes.length} 个可追溯节点 · 每张卡片说明这一节点正在做什么 · 默认定位最新节点` });
    const sessionSelect = header.createEl("select", { cls: "lifeos-input lifeos-glass-input" });
    for (const item of sessions) {
      sessionSelect.createEl("option", {
        value: item.id,
        text: `${this.toolLabel(item.tool)} · ${this.sessionTitle(item)}`
      });
    }
    sessionSelect.value = session.id;
    sessionSelect.addEventListener("change", () => {
      this.selectedSessionId = sessionSelect.value;
      const next = sessions.find((item) => item.id === sessionSelect.value);
      this.selectedRevisionId = next?.currentRevisionId ?? "";
      this.focusedNodeId = "";
      this.pendingJumpNodeId = "";
      void this.render();
    });
    const searchWrap = header.createDiv({ cls: "lifeos-ai-workspace-tree-search" });
    setIcon(searchWrap.createSpan(), "search");
    const search = searchWrap.createEl("input", {
      cls: "lifeos-input",
      attr: { type: "search", placeholder: "搜索内容、摘要或文件" }
    });
    const results = panel.createDiv({ cls: "lifeos-ai-workspace-tree-search-results" });
    const toolbar = panel.createDiv({ cls: "lifeos-ai-workspace-tree-toolbar" });
    const legend = toolbar.createDiv({ cls: "lifeos-ai-workspace-tree-legend" });
    for (const [role, label] of [["user", "用户"], ["assistant", "AI"], ["tool", "工具"]] as const) {
      const item = legend.createSpan({ cls: `is-${role}` });
      item.createSpan();
      item.appendText(label);
    }
    const toolbarActions = toolbar.createDiv({ cls: "lifeos-ai-workspace-inline-actions" });
    const zoomOut = createButton(toolbarActions, "缩小", () => undefined, {
      icon: "zoom-out",
      ghost: true,
      className: "lifeos-ai-workspace-tree-control"
    });
    const zoomIn = createButton(toolbarActions, "放大", () => undefined, {
      icon: "zoom-in",
      ghost: true,
      className: "lifeos-ai-workspace-tree-control"
    });
    const fitAll = createButton(toolbarActions, "适应全部", () => undefined, {
      icon: "maximize-2",
      ghost: true,
      className: "lifeos-ai-workspace-tree-control"
    });
    const locateCurrent = createButton(toolbarActions, "当前节点", () => undefined, {
      icon: "locate-fixed",
      primary: true,
      className: "lifeos-ai-workspace-tree-control"
    });
    zoomOut.title = "缩小画板";
    zoomIn.title = "放大画板";
    fitAll.title = "显示全部节点";
    locateCurrent.title = "回到当前节点";
    const zoomValue = toolbarActions.createSpan({ cls: "lifeos-ai-workspace-tree-zoom", text: "90%" });

    const workspace = panel.createDiv({ cls: "lifeos-ai-workspace-tree-workspace" });
    const viewport = workspace.createDiv({
      cls: "lifeos-ai-workspace-tree",
      attr: {
        tabindex: "0",
        role: "application",
        "aria-label": "会话过程节点画布"
      }
    });
    const canvas = viewport.createEl("canvas", {
      cls: "lifeos-ai-workspace-tree-canvas",
      attr: { "aria-hidden": "true" }
    });
    const inspector = workspace.createDiv({ cls: "lifeos-ai-workspace-tree-inspector" });
    const layout = buildConversationGraphLayout(manifest.nodes);
    const current = layout.nodes[layout.nodes.length - 1] ?? null;
    let selected = (this.pendingJumpNodeId && layout.byId.get(this.pendingJumpNodeId)) || current;
    let scale = viewport.clientWidth < 680 ? 0.72 : 0.9;
    let panX = 0;
    let panY = 0;
    let initialized = false;
    let dragging = false;
    let moved = false;
    let pointerX = 0;
    let pointerY = 0;

    const color = (name: string, fallback: string): string =>
      getComputedStyle(panel).getPropertyValue(name).trim() || fallback;
    const roundedRect = (
      context: CanvasRenderingContext2D,
      x: number,
      y: number,
      width: number,
      height: number,
      radius: number
    ): void => {
      const r = Math.min(radius, width / 2, height / 2);
      context.beginPath();
      context.moveTo(x + r, y);
      context.lineTo(x + width - r, y);
      context.quadraticCurveTo(x + width, y, x + width, y + r);
      context.lineTo(x + width, y + height - r);
      context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
      context.lineTo(x + r, y + height);
      context.quadraticCurveTo(x, y + height, x, y + height - r);
      context.lineTo(x, y + r);
      context.quadraticCurveTo(x, y, x + r, y);
      context.closePath();
    };
    const fitText = (context: CanvasRenderingContext2D, value: string, maxWidth: number): string => {
      if (context.measureText(value).width <= maxWidth) return value;
      let output = value;
      while (output.length > 4 && context.measureText(`${output}…`).width > maxWidth) {
        output = output.slice(0, -1);
      }
      return `${output}…`;
    };
    const wrapText = (
      context: CanvasRenderingContext2D,
      value: string,
      maxWidth: number,
      maxLines = 2
    ): string[] => {
      const words = Array.from(value);
      const lines: string[] = [];
      let currentLine = "";
      for (const word of words) {
        if (context.measureText(`${currentLine}${word}`).width <= maxWidth) {
          currentLine += word;
          continue;
        }
        if (currentLine) lines.push(currentLine);
        currentLine = word;
        if (lines.length >= maxLines - 1) break;
      }
      if (currentLine && lines.length < maxLines) lines.push(currentLine);
      const consumed = lines.join("").length;
      if (consumed < value.length && lines.length > 0) {
        lines[lines.length - 1] = fitText(context, `${lines[lines.length - 1]}…`, maxWidth);
      }
      return lines;
    };
    const resizeCanvas = (): void => {
      const width = Math.max(1, viewport.clientWidth);
      const height = Math.max(1, viewport.clientHeight);
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      if (!initialized && selected) {
        panX = width / 2 - (selected.x + selected.width / 2) * scale;
        panY = height / 2 - (selected.y + selected.height / 2) * scale;
        initialized = true;
      }
      requestDraw();
    };
    const drawNode = (
      context: CanvasRenderingContext2D,
      item: AiWorkspaceGraphNode,
      isSelected: boolean,
      isCurrent: boolean
    ): void => {
      const accent = color("--interactive-accent", "#2563eb");
      const border = isSelected || isCurrent ? accent : color("--background-modifier-border", "#d6d9df");
      const surfaces = {
        user: color("--background-primary", "#ffffff"),
        assistant: color("--background-secondary", "#f6f7f9"),
        tool: color("--background-primary-alt", "#f4f5f7")
      };
      roundedRect(context, item.x, item.y, item.width, item.height, 8);
      context.fillStyle = surfaces[item.node.role];
      context.fill();
      context.lineWidth = isSelected ? 2.5 : isCurrent ? 2 : 1;
      context.strokeStyle = border;
      context.stroke();
      context.fillStyle = item.node.role === "user"
        ? color("--color-green", "#16845b")
        : item.node.role === "assistant"
          ? color("--color-blue", "#2563eb")
          : color("--text-muted", "#68707d");
      context.fillRect(item.x, item.y, 5, item.height);
      context.fillStyle = color("--text-muted", "#68707d");
      context.font = "600 11px sans-serif";
      context.fillText(
        `#${item.node.sequence + 1}  ${this.roleLabel(item.node.role)}  ${this.formatTime(item.node.timestamp)}`,
        item.x + 16,
        item.y + 21
      );
      context.fillStyle = color("--text-normal", "#171a21");
      context.font = "600 13px sans-serif";
      const summary = this.nodeSummary(item.node, 132);
      const lines = wrapText(context, summary, item.width - 32, 2);
      lines.forEach((line, index) => {
        context.fillText(line, item.x + 16, item.y + 47 + index * 18);
      });
      context.fillStyle = color("--text-muted", "#68707d");
      context.font = "11px sans-serif";
      const footer = [
        item.node.important ? "关键节点" : "普通节点",
        item.node.fileReferences.length > 0 ? `${item.node.fileReferences.length} 个文件` : "",
        isCurrent ? "当前" : ""
      ].filter(Boolean).join(" · ");
      context.fillText(fitText(context, footer, item.width - 32), item.x + 16, item.y + 87);
    };
    const draw = (): void => {
      this.treeAnimationFrame = 0;
      if (!canvas.isConnected) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = color("--background-primary", "#ffffff");
      context.fillRect(0, 0, width, height);
      context.save();
      context.globalAlpha = 0.22;
      context.strokeStyle = color("--background-modifier-border", "#d6d9df");
      context.lineWidth = 1;
      const gridSize = 28;
      for (let x = ((panX % gridSize) + gridSize) % gridSize; x < width; x += gridSize) {
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
      }
      for (let y = ((panY % gridSize) + gridSize) % gridSize; y < height; y += gridSize) {
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
      }
      context.restore();
      context.save();
      context.translate(panX, panY);
      context.scale(scale, scale);
      const visible = graphVisibleRange(layout, -panY / scale, (height - panY) / scale);
      context.lineWidth = 1.5;
      context.strokeStyle = color("--background-modifier-border", "#d6d9df");
      for (let index = visible.start; index < visible.end; index += 1) {
        const item = layout.nodes[index];
        const fallbackParent = index > 0 ? layout.nodes[index - 1] : null;
        const parentNode = item.node.parentId ? layout.byId.get(item.node.parentId) : fallbackParent;
        if (!parentNode) continue;
        const startX = parentNode.x + parentNode.width / 2;
        const startY = parentNode.y + parentNode.height;
        const endX = item.x + item.width / 2;
        const endY = item.y;
        const middleY = startY + Math.max(12, (endY - startY) / 2);
        context.beginPath();
        context.moveTo(startX, startY);
        context.bezierCurveTo(startX, middleY, endX, middleY, endX, endY);
        context.stroke();
      }
      for (let index = visible.start; index < visible.end; index += 1) {
        const item = layout.nodes[index];
        drawNode(context, item, item.node.id === selected?.node.id, item.node.id === current?.node.id);
      }
      context.restore();
      zoomValue.setText(`${Math.round(scale * 100)}%`);
    };
    const requestDraw = (): void => {
      if (this.treeAnimationFrame) cancelAnimationFrame(this.treeAnimationFrame);
      this.treeAnimationFrame = requestAnimationFrame(draw);
    };
    const renderInspector = (): void => {
      inspector.empty();
      if (!selected) {
        inspector.createEl("p", { text: "当前会话没有可显示节点。" });
        return;
      }
      const node = selected.node;
      const head = inspector.createDiv({ cls: "lifeos-ai-workspace-tree-inspector-head" });
      const badge = head.createSpan({ cls: `is-${node.role}`, text: `#${node.sequence + 1}` });
      const title = head.createDiv();
      title.createEl("span", { cls: "lifeos-ai-workspace-tree-inspector-eyebrow", text: "这个节点在做什么" });
      title.createEl("strong", { text: this.nodeSummary(node, 150) });
      title.createEl("span", {
        text: `${this.roleLabel(node.role)} · ${node.important ? "关键节点" : "普通节点"} · ${this.formatTime(node.timestamp)}`
      });
      const preview = inspector.createEl("details", { cls: "lifeos-ai-workspace-tree-inspector-content" });
      preview.createEl("summary", { text: "查看节点内容摘要" });
      preview.createEl("p", {
        cls: "lifeos-ai-workspace-tree-inspector-preview",
        text: cleanWorkspaceDisplayText(node.preview, 720)
      });
      if (node.parentId) {
        const parentNode = layout.byId.get(node.parentId);
        if (parentNode) {
          const parentButton = inspector.createEl("button", {
            cls: "lifeos-ai-workspace-tree-parent",
            attr: { type: "button" }
          });
          setIcon(parentButton.createSpan(), "corner-up-left");
          parentButton.createSpan({ text: `上一个关联节点 #${parentNode.node.sequence + 1}` });
          parentButton.addEventListener("click", () => selectAndCenter(parentNode));
        }
      }
      if (node.fileReferences.length > 0) {
        const files = inspector.createDiv({ cls: "lifeos-ai-workspace-message-files" });
        for (const file of node.fileReferences.slice(0, 8)) {
          const fileButton = files.createEl("button", { attr: { type: "button" } });
          setIcon(fileButton.createSpan(), "file-code-2");
          fileButton.createSpan({ text: file.path });
          fileButton.addEventListener("click", () => new AiWorkspaceFileSegmentModal(
            this.app,
            service,
            this.resolveFilePath(session.cwd, file.path),
            file.line ?? 1
          ).open());
        }
      }
      const actions = inspector.createDiv({ cls: "lifeos-ai-workspace-inline-actions" });
      createButton(actions, "在阅读器打开", () => this.jumpToNode(node.id), {
        icon: "message-square-text",
        primary: true
      });
      createButton(actions, "复制节点", () => void navigator.clipboard.writeText(node.preview), {
        icon: "copy",
        ghost: true
      });
    };
    const centerOn = (item: AiWorkspaceGraphNode, nextScale = scale): void => {
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      scale = Math.max(0.12, Math.min(1.8, nextScale));
      panX = width / 2 - (item.x + item.width / 2) * scale;
      panY = height / 2 - (item.y + item.height / 2) * scale;
      requestDraw();
    };
    const selectAndCenter = (item: AiWorkspaceGraphNode): void => {
      selected = item;
      this.focusedNodeId = item.node.id;
      centerOn(item, Math.max(scale, 0.72));
      renderInspector();
    };
    const changeZoom = (factor: number, anchorX = viewport.clientWidth / 2, anchorY = viewport.clientHeight / 2): void => {
      const worldX = (anchorX - panX) / scale;
      const worldY = (anchorY - panY) / scale;
      const next = Math.max(0.12, Math.min(1.8, scale * factor));
      panX = anchorX - worldX * next;
      panY = anchorY - worldY * next;
      scale = next;
      requestDraw();
    };
    const renderSearchResults = (): void => {
      results.empty();
      const query = search.value.trim().toLowerCase();
      if (!query) {
        results.removeClass("is-visible");
        requestDraw();
        return;
      }
      const matches = layout.nodes.filter((item) => {
        const node = item.node;
        return node.preview.toLowerCase().includes(query)
          || node.summary?.toLowerCase().includes(query)
          || node.fileReferences.some((file) => file.path.toLowerCase().includes(query));
      });
      results.addClass("is-visible");
      const summary = results.createDiv({ cls: "lifeos-ai-workspace-tree-search-summary" });
      summary.createSpan({ text: `找到 ${matches.length} 个节点` });
      if (matches.length === 0) return;
      for (const item of matches.slice(0, 20)) {
        const button = results.createEl("button", { attr: { type: "button" } });
        button.createEl("strong", { text: `#${item.node.sequence + 1} · ${this.roleLabel(item.node.role)}` });
        button.createEl("span", { text: this.nodeSummary(item.node, 110) });
        button.addEventListener("click", () => {
          selectAndCenter(item);
          results.removeClass("is-visible");
        });
      }
      requestDraw();
    };

    zoomOut.addEventListener("click", () => changeZoom(0.82));
    zoomIn.addEventListener("click", () => changeZoom(1.22));
    fitAll.addEventListener("click", () => {
      scale = Math.max(0.12, Math.min(1.2, Math.min(
        (viewport.clientWidth - 48) / layout.width,
        (viewport.clientHeight - 48) / layout.height
      )));
      panX = (viewport.clientWidth - layout.width * scale) / 2;
      panY = (viewport.clientHeight - layout.height * scale) / 2;
      requestDraw();
    });
    locateCurrent.addEventListener("click", () => {
      if (current) selectAndCenter(current);
    });
    search.addEventListener("input", renderSearchResults);
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      const first = results.querySelector<HTMLButtonElement>("button");
      first?.click();
    });
    viewport.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      changeZoom(event.deltaY < 0 ? 1.12 : 0.89, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    viewport.addEventListener("pointerdown", (event) => {
      dragging = true;
      moved = false;
      pointerX = event.clientX;
      pointerY = event.clientY;
      viewport.setPointerCapture(event.pointerId);
      viewport.addClass("is-panning");
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - pointerX;
      const dy = event.clientY - pointerY;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      panX += dx;
      panY += dy;
      pointerX = event.clientX;
      pointerY = event.clientY;
      requestDraw();
    });
    const stopDragging = (event: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      viewport.removeClass("is-panning");
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    };
    viewport.addEventListener("pointerup", (event) => {
      stopDragging(event);
      if (moved) return;
      const rect = viewport.getBoundingClientRect();
      const hit = graphNodeAtPoint(
        layout,
        (event.clientX - rect.left - panX) / scale,
        (event.clientY - rect.top - panY) / scale
      );
      if (hit) {
        selected = hit;
        this.focusedNodeId = hit.node.id;
        renderInspector();
        requestDraw();
      }
    });
    viewport.addEventListener("pointercancel", stopDragging);
    viewport.addEventListener("dblclick", (event) => {
      const rect = viewport.getBoundingClientRect();
      const hit = graphNodeAtPoint(
        layout,
        (event.clientX - rect.left - panX) / scale,
        (event.clientY - rect.top - panY) / scale
      );
      if (hit) this.jumpToNode(hit.node.id);
    });
    this.treeResizeObserver = new ResizeObserver(() => {
      if (!viewport.isConnected) {
        this.treeResizeObserver?.disconnect();
        return;
      }
      resizeCanvas();
    });
    this.treeResizeObserver.observe(viewport);
    renderInspector();
    resizeCanvas();
    if (this.pendingJumpNodeId) this.pendingJumpNodeId = "";
    void projects;
  }

  private async renderVersions(
    parent: HTMLElement,
    projects: LifeOSProject[],
    state: AiWorkspaceState,
    service: AiWorkspaceService
  ): Promise<void> {
    const sessions = this.projectSessions(state);
    if (sessions.length === 0) {
      parent.createDiv({ cls: "lifeos-ai-workspace-empty-inline", text: "尚无可交接的会话。" });
      return;
    }
    const session = this.currentSession(sessions);
    if (!session) return;
    const selector = parent.createDiv({ cls: "lifeos-ai-workspace-version-selector" });
    const selectorCopy = selector.createDiv();
    selectorCopy.createEl("strong", { text: "当前交接会话" });
    selectorCopy.createEl("span", { text: "交接按版本保存；会话新增后可手动刷新，不会静默覆盖旧交接。" });
    const select = selector.createEl("select", { cls: "lifeos-input lifeos-glass-input" });
    for (const item of sessions) {
      select.createEl("option", {
        value: item.id,
        text: `${this.toolLabel(item.tool)} · ${this.sessionTitle(item)}`
      });
    }
    select.value = session.id;
    select.addEventListener("change", () => {
      this.selectedSessionId = select.value;
      const next = sessions.find((item) => item.id === select.value);
      this.selectedRevisionId = next?.currentRevisionId ?? "";
      void this.render();
    });
    const handoffView = await service.getHandoffViewState(session.id);
    const handoff = handoffView.document;
    const methodLabel = handoff.method === "ai"
      ? "内置 AI 生成"
      : handoff.method === "local-tool"
        ? "本地 AI 工具生成"
        : "本地规则草稿";
    const selectorActions = selector.createDiv({ cls: "lifeos-ai-workspace-inline-actions" });
    createButton(selectorActions, "复制交接文档", () => void (async () => {
      await navigator.clipboard.writeText(handoff.markdown);
      new Notice("完整交接文档已复制，可直接交给另一个 AI。", 4500);
    })(), { icon: "copy", primary: true });
    createButton(selectorActions, "导出 Markdown", () => void (async () => {
      const file = await service.saveHandoffDocument(handoff);
      await this.app.workspace.getLeaf(true).openFile(file);
      new Notice("交接文档已导出。", 4000);
    })(), { icon: "file-down", ghost: true });
    createButton(selectorActions, "迁移到其他工具", () => new AiWorkspaceContinuationModal(
      this.app,
      this.plugin,
      service,
      session
    ).open(), { icon: "arrow-right-left", ghost: true });

    const layout = parent.createDiv({ cls: "lifeos-ai-workspace-handoff-grid" });
    const document = createCard(layout, "lifeos-panel lifeos-ai-workspace-panel lifeos-ai-workspace-handoff-document");
    this.panelHeading(
      document,
      "会话接手简报",
      `${methodLabel} · ${handoff.revisionId} · ${this.formatTime(handoff.generatedAt)}`,
      "clipboard-list"
    );
    if (handoffView.stale) {
      const stale = document.createDiv({ cls: "lifeos-ai-workspace-handoff-alert is-stale" });
      setIcon(stale.createSpan(), "refresh-cw");
      const staleCopy = stale.createDiv();
      staleCopy.createEl("strong", { text: "会话已有新节点，当前交接已过期" });
      staleCopy.createEl("span", { text: handoffView.staleReason || "建议刷新后再迁移给其他工具。" });
      createButton(stale, "用内置 AI 刷新", () => void this.refreshHandoffWithAi(session, service), {
        icon: "sparkles",
        primary: true
      });
    }
    const meta = document.createDiv({ cls: "lifeos-ai-workspace-handoff-meta" });
    const metaRows = [
      [`质量 ${handoff.quality.score} 分`, handoff.quality.passed ? "is-good" : "is-warning"],
      [`覆盖 ${handoffView.sourceNodeCount}/${handoffView.currentNodeCount} 节点`, handoffView.stale ? "is-warning" : "is-good"],
      [`关键引用 ${Math.round(handoff.quality.citationCoverage * 100)}%`, handoff.quality.citationCoverage >= 0.8 ? "is-good" : "is-warning"],
      [methodLabel, ""]
    ] as Array<[string, string]>;
    for (const [label, stateClass] of metaRows) {
      meta.createSpan({ cls: `lifeos-ai-workspace-handoff-chip ${stateClass}`.trim(), text: label });
    }
    const summary = document.createDiv({ cls: "lifeos-ai-workspace-handoff-summary" });
    summary.createSpan({ text: "一分钟接手" });
    summary.createEl("p", { text: handoff.executiveSummary });
    const progress = summary.createDiv({ cls: "lifeos-ai-workspace-handoff-progress" });
    setIcon(progress.createSpan(), "gauge");
    progress.createEl("strong", { text: "当前进度" });
    progress.createEl("p", { text: handoff.progress });
    const actionRows = handoff.actionPlan.map((item, index) =>
      `${index + 1}. ${item.action}｜对象：${item.target}｜预期：${item.expectedResult}｜验收：${item.acceptanceCriteria}`
    );
    const verifiedRows = handoff.verifiedCompleted.map((item) =>
      `${item.title}｜${item.summary}${item.acceptanceCriteria.length ? `｜依据：${item.acceptanceCriteria.join("；")}` : ""}`
    );
    const claimedRows = handoff.claimedCompleted.map((item) => `${item.title}｜${item.summary}`);
    const partialRows = handoff.partialCompleted.map((item) => `${item.title}｜${item.summary}`);
    const primary = document.createDiv({ cls: "lifeos-ai-workspace-handoff-primary" });
    this.assetSection(primary, "当前状态", handoff.currentState);
    this.assetSection(primary, "下一步与验收", actionRows.length ? actionRows : handoff.nextActions);
    this.assetSection(primary, "已验证完成", verifiedRows);
    this.assetSection(primary, "限制与风险", handoff.constraints);
    const addendum = document.createDiv({ cls: "lifeos-ai-workspace-handoff-addendum" });
    const addendumCopy = addendum.createDiv();
    addendumCopy.createEl("strong", { text: "用户补充（AI 刷新不会覆盖）" });
    addendumCopy.createEl("p", {
      text: handoff.userAddendum || "尚未补充只有你能确认的限制、验收口径或接手说明。"
    });
    createButton(addendum, handoff.userAddendum ? "编辑补充" : "添加补充", () => new AiWorkspaceHandoffAddendumModal(
      this.app,
      service,
      session,
      handoff.userAddendum,
      () => this.render()
    ).open(), { icon: "square-pen", ghost: true });
    const supporting = document.createEl("details", {
      cls: "lifeos-ai-workspace-handoff-supporting"
    });
    supporting.createEl("summary", { text: "展开详细背景、待验证事项、里程碑与全部证据" });
    const supportingBody = supporting.createDiv({ cls: "lifeos-ai-workspace-handoff-supporting-body" });
    this.assetSection(supportingBody, "用户目标", handoff.userIntent);
    this.assetSection(supportingBody, "声称完成（待验证）", claimedRows);
    this.assetSection(supportingBody, "部分完成", partialRows);
    this.assetSection(supportingBody, "待处理事项", handoff.pending);
    this.assetSection(supportingBody, "验证与证据", handoff.validation);
    this.assetSection(supportingBody, "关键决定", handoff.decisions);
    this.assetSection(supportingBody, "背景与目标", handoff.background);
    this.assetSection(supportingBody, "工作范围与当前要求", handoff.scope);
    this.assetSection(supportingBody, "项目共享记忆与工具规则", handoff.projectMemory);
    this.assetSection(supportingBody, "未决问题", handoff.openQuestions);
    this.assetSection(supportingBody, "运行环境与来源", handoff.environment);
    this.assetSection(supportingBody, "关键命令", handoff.commands);
    this.assetSection(supportingBody, "相关文件", handoff.files);
    this.assetSection(supportingBody, "覆盖范围与可信边界", handoff.provenance);
    const documentActions = document.createDiv({ cls: "lifeos-ai-workspace-inline-actions" });
    createButton(documentActions, "用内置 AI 刷新", () => void this.refreshHandoffWithAi(session, service), {
      icon: "sparkles",
      primary: true
    });
    createButton(documentActions, "用本地工具生成", () => new AiWorkspaceHandoffGeneratorModal(
      this.app,
      service,
      session,
      () => this.render()
    ).open(), { icon: "terminal", ghost: true });
    createButton(documentActions, "打开当前会话", () => {
      this.activeTab = "sessions";
      this.selectedRevisionId = session.currentRevisionId;
      this.readerOrder = "newest";
      this.readerOffset = 0;
      void this.render();
    }, { icon: "messages-square", ghost: true });

    const context = createCard(layout, "lifeos-panel lifeos-ai-workspace-panel lifeos-ai-workspace-handoff-context");
    this.panelHeading(context, "会话脉络与最近上下文", "里程碑可回溯到原始节点", "history");
    this.assetSection(context, "会话里程碑", handoff.milestones);
    this.assetSection(context, "交接前的最近对话", handoff.latestContext);
    this.assetSection(context, "来源信息", [
      `${this.sourceLabel(session)} · ${session.sourceSessionId}`,
      session.cwd || session.sourceUrl || "未记录工作目录",
      `${session.currentRevisionId} · ${session.messageCount} 个节点 · ${this.formatTime(session.updatedAt)}`,
      session.tracking.enabled ? "自动跟踪中" : "自动跟踪已暂停"
    ]);
    const history = context.createEl("details", { cls: "lifeos-ai-workspace-handoff-history" });
    history.createEl("summary", { text: `查看 ${session.revisions.length} 个历史版本` });
    for (const revision of [...session.revisions].reverse()) {
      const row = history.createDiv({
        cls: revision.id === session.currentRevisionId
          ? "lifeos-ai-workspace-version-row is-current"
          : "lifeos-ai-workspace-version-row"
      });
      const copy = row.createDiv();
      copy.createEl("strong", { text: `${revision.id} · ${this.reasonLabel(revision.reason)}` });
      copy.createEl("span", { text: `${revision.messageCount} 个节点 · ${this.formatTime(revision.createdAt)}` });
      createButton(row, "阅读", () => {
        this.selectedRevisionId = revision.id;
        this.activeTab = "sessions";
        this.readerOrder = "newest";
        this.readerOffset = 0;
        void this.render();
      }, { icon: "book-open", ghost: true });
    }
    void projects;
  }

  private async renderPrompts(
    parent: HTMLElement,
    projects: LifeOSProject[],
    state: AiWorkspaceState,
    service: AiWorkspaceService
  ): Promise<void> {
    const project = this.currentProject(projects);
    if (!project) return;
    const header = parent.createDiv({ cls: "lifeos-ai-workspace-prompt-head" });
    const copy = header.createDiv();
    copy.createEl("h2", { text: "提示词库" });
    copy.createEl("p", { text: "常用提示词单独版本化；全局提示词和项目专属提示词在这里统一查找。" });
    createButton(header, "新建提示词", () => new AiWorkspacePromptModal(this.app, service, projects, {
      scope: "project",
      projectId: project.id,
      tool: "any"
    }, () => this.render()).open(), { icon: "plus", primary: true });
    const search = parent.createEl("input", {
      cls: "lifeos-input lifeos-glass-input lifeos-ai-workspace-prompt-search",
      attr: { type: "search", placeholder: "搜索标题或标签" }
    });
    const list = parent.createDiv({ cls: "lifeos-ai-workspace-prompt-list" });
    const renderList = (): void => {
      list.empty();
      const query = search.value.trim().toLowerCase();
      const prompts = state.prompts
        .filter((prompt) => prompt.status === "active")
        .filter((prompt) => prompt.scope === "global" || prompt.projectId === project.id)
        .filter((prompt) => !query || `${prompt.title} ${prompt.tags.join(" ")}`.toLowerCase().includes(query))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (prompts.length === 0) {
        list.createDiv({ cls: "lifeos-ai-workspace-empty-inline", text: "没有符合条件的提示词。" });
        return;
      }
      for (const prompt of prompts) void this.renderPromptAsset(list, prompt, projects, service);
    };
    search.addEventListener("input", renderList);
    renderList();
  }

  private async renderPromptAsset(
    parent: HTMLElement,
    prompt: AiWorkspacePromptAsset,
    projects: LifeOSProject[],
    service: AiWorkspaceService
  ): Promise<void> {
    const item = parent.createDiv({ cls: "lifeos-ai-workspace-prompt-item" });
    const head = item.createDiv({ cls: "lifeos-ai-workspace-prompt-item-head" });
    const copy = head.createDiv();
    copy.createEl("strong", { text: prompt.title });
    copy.createEl("span", {
      text: `${prompt.scope === "global" ? "全部项目" : projects.find((project) => project.id === prompt.projectId)?.name ?? "项目"} · ${prompt.tool === "any" ? "所有工具" : this.toolLabel(prompt.tool)} · v${prompt.currentVersion}`
    });
    const badges = head.createDiv({ cls: "lifeos-ai-workspace-prompt-tags" });
    for (const tag of prompt.tags) badges.createSpan({ text: tag });
    const markdown = await service.readPrompt(prompt);
    const body = item.createDiv({ cls: "lifeos-ai-workspace-prompt-preview" });
    renderMarkdownDisplay(this.app, this, body, this.stripPromptFrontmatter(markdown), prompt.versionPaths[prompt.currentVersion - 1]);
    const actions = item.createDiv({ cls: "lifeos-ai-workspace-inline-actions" });
    createButton(actions, "复制", () => void (async () => {
      await navigator.clipboard.writeText(this.stripPromptFrontmatter(markdown));
      await service.markPromptUsed(prompt.id);
      new Notice("提示词已复制。", 4000);
    })(), { icon: "copy", primary: true });
    createButton(actions, "保存新版本", () => new AiWorkspacePromptModal(this.app, service, projects, {
      ...prompt,
      body: this.stripPromptFrontmatter(markdown).replace(/^# .+\n+/u, "")
    }, () => this.render()).open(), { icon: "git-commit-horizontal", ghost: true });
    createButton(actions, "归档", () => void (async () => {
      await service.archivePrompt(prompt.id);
      await this.render();
    })(), { icon: "archive", ghost: true });
  }

  private renderDailyFacts(
    parent: HTMLElement,
    facts: AiWorkspaceState["dailyFacts"],
    service: AiWorkspaceService
  ): void {
    if (facts.length === 0) {
      parent.createEl("p", {
        cls: "lifeos-ai-workspace-muted",
        text: "今天还没有会话增量摘要。会话更新后，内置 AI 会先分析本次变化，再写入日报保护区。"
      });
      return;
    }
    const pending = facts.filter((fact) => fact.status === "pending");
    const selected = new Set(pending.map((fact) => fact.id));
    const list = parent.createDiv({ cls: "lifeos-ai-workspace-daily-list" });
    for (const fact of facts) {
      const row = list.createDiv({
        cls: fact.status === "confirmed"
          ? "lifeos-ai-workspace-daily-row is-confirmed"
          : "lifeos-ai-workspace-daily-row"
      });
      if (fact.status === "pending") {
        const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
        checkbox.checked = true;
        checkbox.addEventListener("change", () => {
          checkbox.checked ? selected.add(fact.id) : selected.delete(fact.id);
        });
      } else {
        setIcon(row.createSpan({ cls: "lifeos-ai-workspace-daily-status-icon" }), "check-circle-2");
      }
      const copy = row.createDiv();
      copy.createEl("strong", { text: cleanWorkspaceDisplayText(fact.text, 260) });
      copy.createEl("span", {
        text: `${fact.generatedBy === "ai" ? "AI 增量总结" : "本地规则摘要"} · ${fact.sourceNodeIds.length} 个来源节点`
      });
      row.createSpan({
        cls: `lifeos-ai-workspace-badge ${fact.status === "confirmed" ? "is-success" : "is-warning"}`,
        text: fact.status === "confirmed" ? "已写入日报" : "待确认"
      });
    }
    if (pending.length === 0) return;
    const actions = parent.createDiv({ cls: "lifeos-ai-workspace-inline-actions" });
    createButton(actions, "确认写入日报", () => void (async () => {
      const file = await service.confirmDailyFacts(Array.from(selected));
      if (!file) {
        new Notice("请选择要写入日报的项目事实。");
        return;
      }
      new Notice("项目事实已写入日报保护区，原有正文未被改写。", 6000);
      await this.render();
    })(), { icon: "notebook-pen", primary: true });
    createButton(actions, "忽略所选", () => void (async () => {
      await service.dismissDailyFacts(Array.from(selected));
      await this.render();
    })(), { icon: "x", ghost: true });
  }

  private renderActivityRow(parent: HTMLElement, session: AiWorkspaceSessionSummary): void {
    const displayTitle = this.sessionTitle(session);
    const row = parent.createDiv({ cls: "lifeos-ai-workspace-activity-row" });
    const marker = row.createSpan({ cls: `lifeos-ai-workspace-tool-dot is-${session.tool}` });
    marker.setAttr("title", this.toolLabel(session.tool));
    const copy = row.createDiv();
    copy.createEl("strong", { text: displayTitle });
    copy.createEl("p", {
      text: this.analysisPreview(session.activity?.summary || session.analysis.summary, "尚未生成摘要。", 220)
    });
    copy.createEl("span", {
      text: [
        this.toolLabel(session.tool),
        `${session.messageCount} 节点`,
        session.activity?.progress ? cleanWorkspaceDisplayText(session.activity.progress, 90) : "",
        this.formatTime(session.updatedAt)
      ].filter(Boolean).join(" · ")
    });
    row.createSpan({ cls: `lifeos-ai-workspace-badge ${session.lifecycle === "active" ? "is-success" : ""}`, text: this.lifecycleLabel(session.lifecycle) });
    createButton(row, "打开", () => {
      this.selectedSessionId = session.id;
      this.selectedRevisionId = session.currentRevisionId;
      this.activeTab = "sessions";
      this.resetReaderState();
      void this.render();
    }, { icon: "arrow-right", ghost: true });
  }

  private jumpToNode(nodeId: string): void {
    this.pendingJumpNodeId = nodeId;
    this.focusedNodeId = nodeId;
    this.activeTab = "sessions";
    void this.render();
  }

  private async refreshAfterImportResults(results: AiWorkspaceImportResult[]): Promise<void> {
    let latest = results[0];
    for (const result of results) {
      if (result.status !== "duplicate") latest = result;
    }
    if (latest) {
      this.selectedProjectId = latest.session.projectId;
      this.selectedSessionId = latest.session.id;
      this.selectedRevisionId = latest.session.currentRevisionId;
      this.activeTab = "sessions";
    } else {
      this.selectedRevisionId = "";
    }
    this.resetReaderState();
    await this.render();
  }

  private openImport(project: LifeOSProject, service: AiWorkspaceService, autoScan = false): void {
    new AiWorkspaceImportModal(
      this.app,
      project,
      service,
      (results) => this.refreshAfterImportResults(results),
      autoScan
    ).open();
  }

  private openBinding(project: LifeOSProject, service: AiWorkspaceService): void {
    new AiWorkspaceBindingModal(this.app, project, service, this.plugin, async (action) => {
      await this.render();
      if (action === "scan") this.openImport(project, this.service(), true);
    }).open();
  }

  private openNewProjectWizard(): void {
    new NewProjectModal(
      this.app,
      this.plugin,
      async (project) => {
        this.selectedProjectId = project.id;
        this.selectedSessionId = "";
        this.selectedRevisionId = "";
        this.resetReaderState();
        await this.render();
        this.openBinding(project, this.service());
      },
      {
        title: "添加 AI 协作项目",
        subtitle: "先创建项目档案，再绑定目录并选择 Codex、Claude Code、OpenCode、网页 AI 或其他标准导出来源。",
        submitLabel: "下一步：绑定目录"
      }
    ).open();
  }

  private async analyzeSession(session: AiWorkspaceSessionSummary, service: AiWorkspaceService): Promise<void> {
    new Notice("正在分段整理会话；长会话会先分块再汇总。", 5000);
    try {
      await service.analyzeSessionWithAi(session.id);
      new Notice("会话摘要、结论、待办和提示词候选已更新。", 6000);
      await this.render();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "会话 AI 整理失败。", 8000);
    }
  }

  private async refreshHandoffWithAi(
    session: AiWorkspaceSessionSummary,
    service: AiWorkspaceService
  ): Promise<void> {
    new Notice("正在用内置 AI 重建当前版本交接；原交接会保留到新结果校验通过。", 5000);
    try {
      const result = await service.generateHandoffWithAi(session.id, session.currentRevisionId);
      const degraded = result.method === "rules"
        && result.quality.warnings.some((item) => /AI.+未通过|尚未配置/u.test(item));
      new Notice(
        degraded
          ? "AI 结果未通过质量门禁，已保留上一个有效交接并展示完整规则版。"
          : "当前版本交接已刷新并通过质量门禁。",
        degraded ? 8000 : 5000
      );
      await this.render();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "AI 交接生成失败。", 8000);
    }
  }

  private messageVisible(message: AiWorkspaceMessage): boolean {
    if (this.collapseOrdinary && !message.important) return false;
    if (this.readerFilter === "all") return true;
    if (this.readerFilter === "important") return message.important;
    return message.role === this.readerFilter;
  }

  private resetReaderState(): void {
    this.readerOffset = 0;
    this.readerOrder = "newest";
    this.readerFilter = "all";
    this.readerSearch = "";
    this.collapseOrdinary = false;
    this.pendingJumpNodeId = "";
    this.focusedNodeId = "";
    this.expandedMessageIds.clear();
  }

  private normalizeSelection(projects: LifeOSProject[], state: AiWorkspaceState): void {
    if (!projects.some((project) => project.id === this.selectedProjectId)) {
      this.selectedProjectId = projects.find((project) => project.status === "active")?.id ?? projects[0]?.id ?? "";
    }
    const sessions = this.projectSessions(state);
    if (!sessions.some((session) => session.id === this.selectedSessionId)) {
      this.selectedSessionId = sessions[0]?.id ?? "";
      this.selectedRevisionId = sessions[0]?.currentRevisionId ?? "";
    }
    const session = sessions.find((item) => item.id === this.selectedSessionId);
    if (session && !session.revisions.some((revision) => revision.id === this.selectedRevisionId)) {
      this.selectedRevisionId = session.currentRevisionId;
    }
  }

  private currentProject(projects: LifeOSProject[]): LifeOSProject | null {
    return projects.find((project) => project.id === this.selectedProjectId) ?? null;
  }

  private projectSessions(state: AiWorkspaceState): AiWorkspaceSessionSummary[] {
    return state.sessions
      .filter((session) => session.projectId === this.selectedProjectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private currentSession(sessions: AiWorkspaceSessionSummary[]): AiWorkspaceSessionSummary | null {
    return sessions.find((session) => session.id === this.selectedSessionId) ?? sessions[0] ?? null;
  }

  private stat(parent: HTMLElement, value: string, label: string, note: string): void {
    const item = parent.createDiv({ cls: "lifeos-ai-workspace-stat" });
    item.createEl("strong", { text: value });
    item.createEl("span", { text: label });
    item.createEl("small", { text: note });
  }

  private panelHeading(parent: HTMLElement, title: string, meta: string, icon: string): void {
    const head = parent.createDiv({ cls: "lifeos-ai-workspace-panel-head" });
    const copy = head.createDiv();
    setIcon(copy.createSpan(), icon);
    copy.createEl("h2", { text: title });
    head.createEl("span", { text: meta });
  }

  private assetSection(parent: HTMLElement, title: string, values: string[]): void {
    const section = parent.createDiv({ cls: "lifeos-ai-workspace-asset-section" });
    section.createEl("strong", { text: title });
    if (values.length === 0) {
      section.createEl("p", { text: "暂无。" });
      return;
    }
    const list = section.createEl("ul");
    for (const value of values) list.createEl("li", { text: value });
  }

  private analysisReviewSection(
    parent: HTMLElement,
    title: string,
    kind: "conclusion" | "task",
    session: AiWorkspaceSessionSummary,
    service: AiWorkspaceService
  ): void {
    const section = parent.createDiv({ cls: "lifeos-ai-workspace-asset-section" });
    section.createEl("strong", { text: title });
    const items = kind === "conclusion" ? session.analysis.conclusions : session.analysis.tasks;
    if (items.length === 0) {
      section.createEl("p", { cls: "lifeos-ai-workspace-muted", text: "暂无。" });
      return;
    }
    const list = section.createDiv({ cls: "lifeos-ai-workspace-analysis-list" });
    for (const item of items) {
      const status = item.status ?? "candidate";
      const row = list.createDiv({ cls: `lifeos-ai-workspace-analysis-row is-${status}` });
      const copy = row.createDiv();
      copy.createEl("p", { text: cleanWorkspaceDisplayText(item.text, 280) });
      copy.createEl("span", { text: `${item.nodeIds.length} 个来源节点` });
      row.createSpan({
        cls: `lifeos-ai-workspace-badge ${status === "confirmed" ? "is-success" : status === "dismissed" ? "" : "is-warning"}`,
        text: status === "confirmed" ? "已确认" : status === "dismissed" ? "已忽略" : "待确认"
      });
      const actions = row.createDiv({ cls: "lifeos-ai-workspace-inline-actions" });
      createButton(actions, status === "confirmed" ? "取消确认" : "确认", () => void (async () => {
        await service.setAnalysisItemStatus(
          session.id,
          kind,
          item.text,
          status === "confirmed" ? "candidate" : "confirmed"
        );
        await this.render();
      })(), { icon: status === "confirmed" ? "undo-2" : "check", primary: status !== "confirmed", ghost: status === "confirmed" });
      if (status !== "dismissed") {
        createButton(actions, "忽略", () => void (async () => {
          await service.setAnalysisItemStatus(session.id, kind, item.text, "dismissed");
          await this.render();
        })(), { icon: "x", ghost: true });
      }
    }
  }

  private renderOutcomeFiles(
    parent: HTMLElement,
    session: AiWorkspaceSessionSummary,
    service: AiWorkspaceService
  ): void {
    const section = parent.createDiv({ cls: "lifeos-ai-workspace-asset-section" });
    section.createEl("strong", { text: "涉及文件" });
    if (session.fileReferences.length === 0) {
      section.createEl("p", { cls: "lifeos-ai-workspace-muted", text: "本次会话没有识别到文件引用。" });
      return;
    }
    section.createEl("p", {
      cls: "lifeos-ai-workspace-muted",
      text: `共识别 ${session.fileReferences.length} 个文件引用，点击可按行读取原文件。`
    });
    const files = section.createDiv({ cls: "lifeos-ai-workspace-message-files" });
    for (const file of session.fileReferences.slice(0, 16)) {
      const absolute = this.resolveFilePath(session.cwd, file.path);
      const button = files.createEl("button", { attr: { type: "button", title: absolute } });
      setIcon(button.createSpan(), "file-code-2");
      button.createSpan({ text: file.path });
      button.addEventListener("click", () => new AiWorkspaceFileSegmentModal(
        this.app,
        service,
        absolute,
        file.line ?? 1
      ).open());
    }
  }

  private promptTitleFromMessage(message: AiWorkspaceMessage): string {
    const summary = cleanWorkspaceDisplayText(message.content, 42) || `节点 ${message.sequence + 1}`;
    return `${message.role === "user" ? "用户指令" : "AI 回复"}：${summary}`;
  }

  private sessionTitle(session: AiWorkspaceSessionSummary, maxChars = 72): string {
    return workspaceSessionDisplayTitle(
      session.title,
      session.analysis.summary,
      `${this.sourceLabel(session)} 会话`,
      maxChars
    );
  }

  private analysisPreview(value: string | undefined, fallback: string, maxChars: number): string {
    if (!value?.trim()) return fallback;
    const cleaned = cleanWorkspaceDisplayText(value, maxChars);
    return cleaned === "未提取到可读内容。" ? fallback : cleaned;
  }

  private disposeTreeCanvas(): void {
    this.treeResizeObserver?.disconnect();
    this.treeResizeObserver = null;
    if (this.treeAnimationFrame) {
      cancelAnimationFrame(this.treeAnimationFrame);
      this.treeAnimationFrame = 0;
    }
  }

  private nodeSummary(node: AiWorkspaceNodeIndex, maxChars = 120): string {
    const stored = node.summary?.trim() || "";
    const generic = /^(?:用户要做|AI 回复|工具执行)[：:]/u.test(stored);
    const summary = !stored || generic
      ? summarizeWorkspaceNode(node.preview, node.role, maxChars)
      : stored;
    return cleanWorkspaceDisplayText(summary, maxChars);
  }

  private resolveFilePath(cwd: string, filePath: string): string {
    const normalized = filePath.replace(/\//g, "\\");
    if (/^[A-Za-z]:\\/.test(normalized) || normalized.startsWith("\\\\")) return normalized;
    const base = cwd.replace(/[\\/]+$/, "");
    return base ? `${base}\\${normalized.replace(/^\.?\\+/, "")}` : normalized;
  }

  private stripPromptFrontmatter(markdown: string): string {
    return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/m, "").trim();
  }

  private shortId(value: string): string {
    return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value;
  }

  private formatTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
  }

  private shortTime(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  }

  private toolLabel(tool: AiWorkspaceTool): string {
    return aiWorkspaceToolLabel(tool);
  }

  private sourceLabel(session: AiWorkspaceSessionSummary): string {
    return session.tool === "web" && session.sourcePlatform
      ? session.sourcePlatform
      : this.toolLabel(session.tool);
  }

  private roleLabel(role: AiWorkspaceNodeIndex["role"]): string {
    return role === "user" ? "用户" : role === "assistant" ? "AI 回复" : "工具调用";
  }

  private reasonLabel(reason: AiWorkspaceSessionSummary["revisions"][number]["reason"]): string {
    return reason === "initial" ? "首次导入" : reason === "append" ? "增量追加" : "冲突修订";
  }

  private lifecycleLabel(value: AiWorkspaceSessionSummary["lifecycle"]): string {
    return value === "active" ? "进行中" : value === "done" ? "已完成" : value === "paused" ? "已暂停" : "已失效";
  }

  private permissionLabel(value: AiWorkspaceAgentPermission): string {
    return value === "read-only"
      ? "只读"
      : value === "workspace-write"
        ? "Workspace 写入"
        : value === "project-write"
          ? "项目写入"
          : "完整权限";
  }
}
