import { ItemView, Notice, TFile, TFolder, type TAbstractFile, WorkspaceLeaf, setIcon } from "obsidian";
import { DASHBOARD_VIEW_TYPE } from "./constants";
import type { IPlugin } from "./plugin-api";
import { XingceQuestionModal, InterviewPracticeModal } from "./modals";
import { ensureFile, formatDate } from "./utils";
import { listExamFiles, parseFrontmatter } from "./exam/data";
import { completeAndArchiveTask, getTaskStats, parseTaskLine } from "./tasks/task-actions";
import { undoTaskMarkdown } from "./services/lifeos-logic";
import { FileSystemService } from "./services/FileSystemService";
import { MemoryService } from "./services/MemoryService";
import { MemoryManagerModal } from "./memory/memory-manager";
import { createLifeOsShell, markLifeOsLeaf } from "./lifeos-shell";
import { QuickCaptureModal } from "./quick-capture";
import { getExamProfileLabel } from "./settings";

export class DashboardView extends ItemView {
  private pendingUndo: { taskLine: string; timeout: ReturnType<typeof setTimeout> } | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: IPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return DASHBOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.plugin.settings.systemName;
  }

  async onOpen(): Promise<void> {
    void this.render();

    this.registerEvent(this.app.vault.on("modify", () => this.refresh()));
    this.registerEvent(this.app.vault.on("create", () => this.refresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.refresh()));
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.refresh()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refresh()));
  }

  async refresh(): Promise<void> {
    await this.render();
  }

  async render(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    const layoutClass = this.plugin.settings.viewLayout === "main" ? "pls-layout-main" : "pls-layout-sidebar";
    const root = container.createDiv({ cls: `pls-dashboard ${layoutClass}` });
    this.applyBackgroundImage(root);
    const dashboardBody = this.plugin.settings.viewLayout === "main"
      ? createLifeOsShell(this.app, this.plugin, root, {
        active: "dashboard",
        title: this.plugin.settings.systemName,
        subtitle: "今天也要好好努力，成为更好的自己",
        showDirectory: true,
        onRefresh: () => this.refresh()
      })
      : root;

    if (this.plugin.settings.viewLayout !== "main") {
      const header = dashboardBody.createDiv({ cls: "pls-dashboard-header" });
      const titleWrap = header.createDiv();
      titleWrap.createEl("h2", {
        text: `${this.plugin.settings.systemName}`
      });
      titleWrap.createEl("p", {
        cls: "pls-dashboard-subtitle",
        text: "今天也要好好努力，成为更好的自己"
      });
      const headerActions = header.createDiv({ cls: "pls-header-actions" });
      const datePill = headerActions.createDiv({
        cls: "pls-date-pill",
        text: new Date().toLocaleDateString("zh-CN", {
          month: "long",
          day: "numeric",
          weekday: "long"
        })
      });
      this.prependIcon(datePill, "calendar-days");

      const themeWrap = header.createDiv({ cls: "pls-theme-switcher" });
      const themeSelect = themeWrap.createEl("select");
      const themes: { value: string; label: string }[] = [
        { value: "cool", label: "清冷" },
        { value: "dark-tech", label: "暗夜" },
        { value: "wabi", label: "侘寂" },
        { value: "pastel", label: "粉彩" }
      ];
      for (const t of themes) {
        themeSelect.createEl("option", { value: t.value, text: t.label });
      }
      themeSelect.value = this.plugin.settings.theme;
      themeSelect.onchange = () => void this.plugin.setTheme(themeSelect.value);
    }

    await this.renderTodayOverview(dashboardBody);
    await this.renderProductDashboard(dashboardBody);
    if (this.plugin.settings.viewLayout === "main") {
      return;
    }

    // ── 快速操作 ──
    const quick = dashboardBody.createDiv({ cls: "pls-section pls-section-quick" });
    this.createSectionTitle(quick, "今日工作台", "layout-grid");
    const quickRow = quick.createDiv({ cls: "pls-button-row" });
    this.createDashboardButton(quickRow, "打开今日记录", "edit-3", () => void this.openTodayNoteStyled(), "pls-btn-primary");
    this.createDashboardButton(quickRow, "结束今日记录", "book-open-check", () => void this.plugin.finishTodayNote());
    this.createDashboardButton(quickRow, "Chat 对话", "message-circle", () => void this.plugin.activateChat());
    this.createDashboardButton(quickRow, "日历", "calendar-days", () => void this.plugin.activateCalendar());

    // ── 待办与记忆 ──
    const tasks = dashboardBody.createDiv({ cls: "pls-section pls-section-tasks" });
    this.createSectionTitle(tasks, "待办与记忆", "clipboard-list");
    await this.renderOpenTasks(tasks);
    const taskRow = tasks.createDiv({ cls: "pls-button-row pls-task-actions" });
    this.createDashboardButton(taskRow, "全部", "", () => void openPath(this.plugin, this.plugin.path("Tasks", "open.md")), "pls-active");
    this.createDashboardButton(taskRow, "未完成", "", () => void openPath(this.plugin, this.plugin.path("Tasks", "open.md")));
    this.createDashboardButton(taskRow, "已完成", "", () => void openPath(this.plugin, this.plugin.path("Tasks", "done.md")));
    this.createDashboardButton(taskRow, "记忆管理", "brain", () => new MemoryManagerModal(this.app, this.plugin).open());
    tasks.createDiv({ cls: "pls-task-illustration", attr: { "aria-hidden": "true" } });

    // ── AI 助手 ──
    const ai = dashboardBody.createDiv({ cls: "pls-section pls-section-ai" });
    this.createSectionTitle(ai, "AI 助手", "bot");
    const configured = this.plugin.ai.isConfigured();
    if (!configured) {
      ai.createEl("p", {
        cls: "pls-muted",
        text: "AI 未配置。请先在设置中填写 API Key 和 Base URL。"
      });
    } else {
      ai.createEl("p", {
        cls: "pls-muted",
        text: `${this.plugin.settings.aiProvider} / ${this.plugin.settings.aiModel}`
      });
      const aiRow = ai.createDiv({ cls: "pls-button-row" });
      this.createDashboardButton(aiRow, "总结当前打开的笔记", "sparkles", () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice("请先打开一篇笔记。"); return; }
        new Notice(`AI 正在总结：${file.path}`);
        void this.plugin.summarizeFile(file);
      });
      this.createDashboardButton(aiRow, "从当前打开的笔记提取待办", "list-checks", () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice("请先打开一篇笔记。"); return; }
        new Notice(`AI 正在提取待办：${file.path}`);
        void this.plugin.extractTasksFromFile(file);
      });
    }
    ai.createDiv({ cls: "pls-ai-robot-illustration", attr: { "aria-hidden": "true" } });

    // ── 报告与分析（始终可见）──
    const reportSection = dashboardBody.createDiv({ cls: "pls-section pls-section-reports" });
    this.createSectionTitle(reportSection, "报告与分析", "bar-chart-3");
    const reportRow = reportSection.createDiv({ cls: "pls-button-row" });
    this.createDashboardButton(reportRow, "日报", "calendar-range", () => void this.plugin.generateReport("daily"), "pls-btn-primary");
    this.createDashboardButton(reportRow, "周报", "calendar", () => void this.plugin.generateReport("weekly"));
    this.createDashboardButton(reportRow, "月报", "calendar-days", () => void this.plugin.generateReport("monthly"));
    this.createDashboardButton(reportRow, "情绪追踪", "heart", () => void this.plugin.showEmotionTracking());
    this.createDashboardButton(reportRow, "日记检索", "search", () => void this.plugin.showDiarySearch());
    reportSection.createDiv({ cls: "pls-report-illustration", attr: { "aria-hidden": "true" } });

    // ── 备考模块 ──
    if (this.plugin.settings.enableExamModule) {
      const exam = dashboardBody.createDiv({ cls: "pls-section pls-section-exam" });
      this.createSectionTitle(exam, getExamProfileLabel(this.plugin.settings), "graduation-cap");

      const examRow = exam.createDiv({ cls: "pls-button-row" });
      this.createDashboardButton(examRow, "今日打卡", "check-square", () => void this.plugin.showCheckinModal(), "pls-btn-primary");
      this.createDashboardButton(examRow, "训练计划", "target", () => void this.plugin.showTrainingPlan(), "pls-btn-primary");
      this.createDashboardButton(examRow, "新增错题", "plus-square", () => new XingceQuestionModal(this.app, this.plugin).open());
      this.createDashboardButton(examRow, "专项练习", "mic", () => new InterviewPracticeModal(this.app, this.plugin).open());

      const examRow2 = exam.createDiv({ cls: "pls-button-row" });
      this.createDashboardButton(examRow2, "练习统计", "pie-chart", () => void this.plugin.showXingceStats());
      this.createDashboardButton(examRow2, "练习趋势", "trending-up", () => void this.plugin.showInterviewTrends());
      this.createDashboardButton(examRow2, "学习目标", "flag", () => void this.runDashboardAction("学习目标打开", () => this.plugin.showGoalsList()));
      this.createDashboardButton(examRow2, "今日任务", "list-todo", () => void this.plugin.showTodayTasks());
      this.createDashboardButton(examRow2, "学习资料", "folder-open", () => void this.plugin.showUploadMaterial());
    }

    // ── 提示 ──
    const tip = dashboardBody.createDiv({ cls: "pls-muted pls-dashboard-tip", attr: { style: "text-align:center;margin-top:8px;" } });
    tip.createSpan({ text: "提示：在命令面板（Ctrl+P）搜索「错题」「练习」「打卡」可快速操作" });
  }

  private async renderTodayOverview(root: HTMLElement): Promise<void> {
    const section = root.createDiv({ cls: "pls-section pls-section-overview" });
    this.createSectionTitle(section, "今日概览", "sparkles");
    const grid = section.createDiv({ cls: "pls-stat-grid" });
    const todayPath = this.plugin.getTodayNotePath();
    const todayFile = this.app.vault.getAbstractFileByPath(todayPath);
    const summaryFile = this.app.vault.getAbstractFileByPath(
      this.plugin.path("Memory", "Summaries", "Daily", `${formatDate()}.md`)
    );
    const checkinFile = this.app.vault.getAbstractFileByPath(
      this.plugin.path("Exam", "Checkins", `${formatDate()}.md`)
    );
    const openTasks = await this.getOpenTasks();
    const pendingMemories = await this.countPendingMemories();

    this.renderStatCard(grid, todayFile instanceof TFile ? "已创建" : "未创建", "今日记录", "blue", "book-marked");
    this.renderStatCard(grid, summaryFile instanceof TFile ? "已总结" : "待总结", "长期积累", "green", "sprout", true);
    this.renderStatCard(grid, String(openTasks.length), "未完成待办", "amber", "star");
    this.renderStatCard(grid, checkinFile instanceof TFile ? "已打卡" : "未打卡", "学习打卡", "purple", "credit-card");

    const detail = section.createDiv({ cls: "pls-muted", attr: { style: "margin-top:8px;" } });
    const streak = await this.getCheckinStreak();
    if (streak > 0) {
      detail.createSpan({ text: `连续打卡 ${streak} 天 · ` });
    }
    if (pendingMemories > 0) {
      detail.createSpan({ text: `${pendingMemories} 条待确认记忆` });
    } else {
      detail.createSpan({ text: "记忆库空闲" });
    }
  }

  private renderStatCard(parent: HTMLElement, value: string, label: string, tone: string, icon: string, chevron = false): void {
    const card = parent.createDiv({ cls: `pls-stat-card pls-stat-${tone}` });
    const iconWrap = card.createSpan({ cls: "pls-stat-icon" });
    setIcon(iconWrap, icon);
    const textWrap = card.createDiv({ cls: "pls-stat-copy" });
    textWrap.createDiv({ cls: "pls-stat-value", text: value });
    textWrap.createDiv({ cls: "pls-stat-label", text: label });
    if (chevron) {
      const chevronEl = card.createSpan({ cls: "pls-stat-chevron" });
      setIcon(chevronEl, "chevron-right");
    }
  }

  private async renderProductDashboard(root: HTMLElement): Promise<void> {
    const openTasks = await this.getOpenTasks();
    const pendingMemories = await this.countPendingMemories();
    const todayFile = this.app.vault.getAbstractFileByPath(this.plugin.getTodayNotePath());
    const checkinFile = this.app.vault.getAbstractFileByPath(
      this.plugin.path("Exam", "Checkins", `${formatDate()}.md`)
    );

    const stage = root.createDiv({ cls: "pls-lifeos-product-stage" });
    const hero = stage.createDiv({ cls: "pls-product-hero-card" });
    const heroCopy = hero.createDiv({ cls: "pls-product-hero-copy" });
    const eyebrow = heroCopy.createDiv({ cls: "pls-product-eyebrow" });
    setIcon(eyebrow.createSpan(), "gem");
    eyebrow.createSpan({ text: "Life OS" });
    heroCopy.createEl("h3", { text: "一站式今日概览" });
    heroCopy.createEl("p", { text: "任务、日记、打卡、记忆与复盘同屏查看，打开就知道现在该做什么。" });

    const heroActions = hero.createDiv({ cls: "pls-product-hero-actions" });
    this.createDashboardButton(heroActions, "快速记录", "zap", () => new QuickCaptureModal(this.app, this.plugin).open(), "pls-btn-primary");
    this.createDashboardButton(heroActions, "打开 AI 助手", "bot", () => void this.plugin.activateChat());
    this.createDashboardButton(heroActions, "查看日历", "calendar-days", () => void this.plugin.activateCalendar());

    const focusPanel = hero.createDiv({ cls: "pls-product-focus-panel" });
    focusPanel.createDiv({ cls: "pls-product-focus-kicker", text: "当前焦点" });
    const firstTask = openTasks[0] ? parseTaskLine(openTasks[0]) : null;
    this.renderFocusItem(
      focusPanel,
      "任务",
      firstTask?.title ?? (openTasks.length > 0 ? `${openTasks.length} 个待推进事项` : "今天暂无待办"),
      openTasks.length > 0 ? `${openTasks.length} 项` : "轻一点",
      "check-square",
      "green",
      () => void this.plugin.activateTasks()
    );
    this.renderFocusItem(
      focusPanel,
      "日记",
      todayFile instanceof TFile ? "今日记录已创建，可以继续补充。" : "还没有今日记录，先写一句也很好。",
      todayFile instanceof TFile ? "已创建" : "待记录",
      "book-open",
      "blue",
      () => void this.openTodayNoteStyled()
    );
    this.renderFocusItem(
      focusPanel,
      "记忆",
      pendingMemories > 0 ? "有候选记忆等待确认沉淀。" : "暂无候选记忆，保持记录即可。",
      `${pendingMemories} 条`,
      "brain",
      "orange",
      () => void this.plugin.activateMemory()
    );
    this.renderFocusItem(
      focusPanel,
      "复盘",
      "把今天整理成可回顾的成长片段。",
      "生成",
      "sparkles",
      "purple",
      () => void this.plugin.generateReport("daily")
    );

    const featureGrid = stage.createDiv({ cls: "pls-product-feature-grid" });
    this.renderFeatureCard(featureGrid, "智能记录", "想到就记，自动归档", "pencil-line", "purple", () => new QuickCaptureModal(this.app, this.plugin).open());
    this.renderFeatureCard(featureGrid, "任务管理", `${openTasks.length} 个待推进`, "check-square", "green", () => void this.plugin.activateTasks());
    this.renderFeatureCard(featureGrid, "记忆系统", `${pendingMemories} 条待确认`, "brain", "orange", () => void this.plugin.activateMemory());
    this.renderFeatureCard(featureGrid, "复盘成长", "日 / 周 / 月沉淀", "bar-chart-3", "blue", () => void this.plugin.generateReport("daily"));

    const dailyBoard = stage.createDiv({ cls: "pls-product-daily-board" });
    const taskPanel = dailyBoard.createDiv({ cls: "pls-product-panel pls-product-panel-tasks" });
    this.createSectionTitle(taskPanel, "今日任务", "check-square");
    await this.renderCompactTasks(taskPanel, openTasks);
    const taskFooter = taskPanel.createDiv({ cls: "pls-product-panel-footer" });
    this.createDashboardButton(taskFooter, "新增记录", "plus", () => new QuickCaptureModal(this.app, this.plugin).open());
    this.createDashboardButton(taskFooter, "全部任务", "arrow-right", () => void this.plugin.activateTasks(), "pls-btn-primary");

    const diaryPanel = dailyBoard.createDiv({ cls: "pls-product-panel" });
    this.createSectionTitle(diaryPanel, "今日日记", "book-open");
    diaryPanel.createEl("p", {
      cls: "pls-product-panel-text",
      text: todayFile instanceof TFile ? "今日记录已创建，可以继续补充灵感、任务和复盘。" : "今日记录尚未创建，点击下方按钮开始记录。"
    });
    this.createDashboardButton(diaryPanel.createDiv({ cls: "pls-product-panel-footer" }), todayFile instanceof TFile ? "继续记录" : "创建日记", "edit-3", () => void this.openTodayNoteStyled(), "pls-btn-primary");

    const checkinPanel = dailyBoard.createDiv({ cls: "pls-product-panel" });
    this.createSectionTitle(checkinPanel, "学习打卡", "graduation-cap");
    checkinPanel.createEl("p", {
      cls: "pls-product-panel-text",
      text: checkinFile instanceof TFile ? "今天已经打卡，继续保持节奏。" : "还没有学习打卡，留一个小小的完成感。"
    });
    this.createDashboardButton(checkinPanel.createDiv({ cls: "pls-product-panel-footer" }), checkinFile instanceof TFile ? "查看打卡" : "今日打卡", "check-circle", () => void this.plugin.showCheckinModal());

    const reviewPanel = dailyBoard.createDiv({ cls: "pls-product-panel pls-product-panel-review" });
    this.createSectionTitle(reviewPanel, "复盘总结", "sparkles");
    reviewPanel.createEl("p", {
      cls: "pls-product-panel-text",
      text: "把今天的记录整理成可回顾的长期成长片段。"
    });
    const reviewActions = reviewPanel.createDiv({ cls: "pls-product-panel-footer" });
    this.createDashboardButton(reviewActions, "生成日报", "calendar-range", () => void this.plugin.generateReport("daily"), "pls-btn-primary");
    this.createDashboardButton(reviewActions, "情绪追踪", "heart", () => void this.plugin.showEmotionTracking());
  }

  private renderFeatureCard(parent: HTMLElement, title: string, description: string, icon: string, tone: string, onClick: () => void): void {
    const card = parent.createEl("button", { cls: `pls-product-feature-card tone-${tone}` });
    const iconEl = card.createSpan({ cls: "pls-product-feature-icon" });
    setIcon(iconEl, icon);
    card.createSpan({ cls: "pls-product-feature-title", text: title });
    card.createSpan({ cls: "pls-product-feature-desc", text: description });
    card.onclick = onClick;
  }

  private renderFocusItem(
    parent: HTMLElement,
    label: string,
    text: string,
    badge: string,
    icon: string,
    tone: string,
    onClick: () => void
  ): void {
    const item = parent.createEl("button", {
      cls: `pls-product-focus-item tone-${tone}`,
      attr: { type: "button" }
    });
    const iconEl = item.createSpan({ cls: "pls-product-focus-icon" });
    setIcon(iconEl, icon);
    const body = item.createSpan({ cls: "pls-product-focus-body" });
    body.createSpan({ cls: "pls-product-focus-label", text: label });
    body.createSpan({ cls: "pls-product-focus-text", text });
    item.createSpan({ cls: "pls-product-focus-badge", text: badge });
    item.onclick = onClick;
  }

  private async renderCompactTasks(parent: HTMLElement, tasks: string[]): Promise<void> {
    const list = parent.createDiv({ cls: "pls-product-task-list" });
    if (tasks.length === 0) {
      list.createDiv({ cls: "pls-product-empty-line", text: "暂无待办，今天可以轻一点。" });
      return;
    }
    for (const task of tasks.slice(0, 5)) {
      const parsed = parseTaskLine(task);
      const row = list.createDiv({ cls: "pls-product-task-row" });
      const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
      row.createSpan({ text: parsed?.title ?? task.replace(/^- \[ \]\s*/, "") });
      checkbox.onchange = () => void this.completeTask(task);
    }
  }

  private createMainShell(root: HTMLElement): HTMLElement {
    const scenery = root.createDiv({ cls: "pls-scenery", attr: { "aria-hidden": "true" } });
    scenery.createDiv({ cls: "pls-window-sky" });
    scenery.createDiv({ cls: "pls-cherry-branch" });
    scenery.createDiv({ cls: "pls-pet-cat" });
    scenery.createDiv({ cls: "pls-desk-plant" });

    const sidebar = root.createDiv({ cls: "pls-visual-sidebar" });
    const brand = sidebar.createDiv({ cls: "pls-sidebar-brand" });
    const feather = brand.createSpan({ cls: "pls-brand-icon" });
    setIcon(feather, "feather");
    const brandCopy = brand.createDiv();
    brandCopy.createDiv({ cls: "pls-sidebar-title", text: this.plugin.settings.systemName });
    brandCopy.createDiv({ cls: "pls-sidebar-subtitle", text: "记录成长，规划未来" });
    sidebar.createDiv({ cls: "pls-sidebar-divider" });

    const nav = sidebar.createDiv({ cls: "pls-sidebar-nav pls-sidebar-actions" });
    this.createSidebarItem(nav, "今日", "edit-3", () => void this.openTodayNoteStyled(), true);
    this.createSidebarItem(nav, "Chat", "message-circle", () => void this.plugin.activateChat());
    this.createSidebarItem(nav, "日历", "calendar-days", () => void this.plugin.activateCalendar());
    this.createSidebarItem(nav, "检索", "search", () => void this.plugin.showDiarySearch());
    sidebar.createDiv({ cls: "pls-sidebar-divider pls-sidebar-tree-divider" });
    this.renderRootDirectoryTree(sidebar);

    const footer = sidebar.createDiv({ cls: "pls-sidebar-footer" });
    this.createIconButton(
      footer,
      this.plugin.settings.sidebarDirectoryCollapsed ? "panel-left-open" : "panel-left-close",
      this.plugin.settings.sidebarDirectoryCollapsed ? "展开侧目录" : "收起侧目录",
      () => void this.toggleSidebarDirectory()
    );
    this.createIconButton(footer, "settings", "设置", () => this.openObsidianSettings());
    this.createIconButton(footer, "moon", "夜间模式", () => void this.plugin.setTheme("dark-tech"));

    return root.createDiv({ cls: "pls-main-content" });
  }

  private createSidebarItem(parent: HTMLElement, label: string, icon: string, onClick: () => void, active = false): HTMLElement {
    const item = parent.createDiv({ cls: active ? "pls-sidebar-item is-active" : "pls-sidebar-item" });
    const head = item.createEl("button", { cls: "pls-sidebar-item-head" });
    const iconEl = head.createSpan({ cls: "pls-sidebar-icon" });
    setIcon(iconEl, icon);
    head.createSpan({ cls: "pls-sidebar-label", text: label });
    if (active) {
      const chevron = head.createSpan({ cls: "pls-sidebar-chevron" });
      setIcon(chevron, "chevron-up");
    }
    head.onclick = onClick;
    return item;
  }

  private createIconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "pls-icon-button", attr: { "aria-label": label, title: label } });
    setIcon(button, icon);
    button.onclick = onClick;
    return button;
  }

  private renderRootDirectoryTree(parent: HTMLElement): void {
    const rootPath = this.plugin.getRoot();
    const rootFolder = this.app.vault.getAbstractFileByPath(rootPath);
    const tree = parent.createDiv({ cls: "pls-sidebar-tree" });
    const header = tree.createDiv({ cls: "pls-sidebar-tree-header" });
    const iconEl = header.createSpan({ cls: "pls-sidebar-icon" });
    setIcon(iconEl, "folder-tree");
    header.createSpan({ text: rootPath || "Vault" });
    const toggle = header.createEl("button", {
      cls: "pls-tree-toggle",
      attr: { "aria-label": this.plugin.settings.sidebarDirectoryCollapsed ? "展开侧目录" : "收起侧目录" }
    });
    setIcon(toggle, this.plugin.settings.sidebarDirectoryCollapsed ? "chevrons-down-up" : "chevrons-up-down");
    toggle.onclick = () => void this.toggleSidebarDirectory();

    if (this.plugin.settings.sidebarDirectoryCollapsed) {
      tree.createDiv({ cls: "pls-sidebar-tree-empty", text: "侧目录已收起" });
      return;
    }

    if (!(rootFolder instanceof TFolder)) {
      const empty = tree.createDiv({ cls: "pls-sidebar-tree-empty" });
      empty.createDiv({ text: "目录尚未初始化" });
      this.createDashboardButton(empty, "创建基础目录", "folder-plus", () => void this.initializeRootFolder(), "pls-btn-primary");
      return;
    }

    const currentPath = this.app.workspace.getActiveFile()?.path ?? "";
    const list = tree.createDiv({ cls: "pls-file-tree" });
    this.renderFolderChildren(list, rootFolder, currentPath, 0);
  }

  private renderFolderChildren(parent: HTMLElement, folder: TFolder, currentPath: string, depth: number): void {
    const children = [...folder.children]
      .filter((child) => child instanceof TFolder || child instanceof TFile)
      .sort((a, b) => {
        if (a instanceof TFolder && b instanceof TFile) return -1;
        if (a instanceof TFile && b instanceof TFolder) return 1;
        if (folder.name === "Daily" && a instanceof TFile && b instanceof TFile) {
          return b.basename.localeCompare(a.basename);
        }
        return a.name.localeCompare(b.name, "zh-CN");
      });

    for (const child of children) {
      if (child instanceof TFolder) {
        this.renderFolderNode(parent, child, currentPath, depth);
      } else if (child instanceof TFile && child.extension === "md") {
        this.renderFileNode(parent, child, currentPath, depth);
      }
    }
  }

  private renderFolderNode(parent: HTMLElement, folder: TFolder, currentPath: string, depth: number): void {
    const hasActiveChild = currentPath.startsWith(`${folder.path}/`);
    const details = parent.createEl("details", {
      cls: hasActiveChild ? `pls-tree-folder has-active-child depth-${Math.min(depth, 3)}` : `pls-tree-folder depth-${Math.min(depth, 3)}`,
      attr: { open: depth < 1 || hasActiveChild ? "open" : null }
    });
    details.style.setProperty("--pls-tree-depth", String(depth));
    const summary = details.createEl("summary", { cls: "pls-tree-folder-summary" });
    const chevron = summary.createSpan({ cls: "pls-tree-chevron" });
    setIcon(chevron, "chevron-right");
    const iconEl = summary.createSpan({ cls: "pls-tree-icon" });
    setIcon(iconEl, "folder");
    summary.createSpan({ cls: "pls-tree-label", text: folder.name });
    const count = folder.children.filter((child) => child instanceof TFolder || child instanceof TFile && child.extension === "md").length;
    summary.createSpan({ cls: "pls-tree-count", text: String(count) });
    const children = details.createDiv({ cls: "pls-tree-children" });
    this.renderFolderChildren(children, folder, currentPath, depth + 1);
  }

  private renderFileNode(parent: HTMLElement, file: TFile, currentPath: string, depth: number): void {
    const button = parent.createEl("button", {
      cls: file.path === currentPath ? `pls-tree-file is-active depth-${Math.min(depth, 3)}` : `pls-tree-file depth-${Math.min(depth, 3)}`
    });
    button.style.setProperty("--pls-tree-depth", String(depth));
    const iconEl = button.createSpan({ cls: "pls-tree-icon" });
    setIcon(iconEl, this.getFileIcon(file));
    button.createSpan({ cls: "pls-tree-label", text: file.basename });
    button.onclick = () => void this.openStyledFile(file);
  }

  private getFileIcon(file: TFile): string {
    if (/^\d{4}-\d{2}-\d{2}$/.test(file.basename)) return "calendar-days";
    if (file.basename.toLowerCase().includes("open")) return "list-todo";
    if (file.basename.toLowerCase().includes("done")) return "check-check";
    if (file.path.includes("/Memory/")) return "book-open";
    if (file.path.includes("/Templates/")) return "copy";
    if (file.path.includes("/Exam/")) return "graduation-cap";
    return "file-text";
  }

  private async initializeRootFolder(): Promise<void> {
    await this.plugin.ensureBaseStructure();
    await this.refresh();
  }

  private async toggleSidebarDirectory(): Promise<void> {
    this.plugin.settings.sidebarDirectoryCollapsed = !this.plugin.settings.sidebarDirectoryCollapsed;
    await this.plugin.saveSettings();
    await this.refresh();
  }

  private async openTodayNoteStyled(): Promise<void> {
    const file = await this.plugin.openTodayNote(false);
    this.markActiveLeafAsLifeView();
    await this.refresh();
  }

  private async openStyledFile(file: TFile): Promise<void> {
    await this.app.workspace.getLeaf(false).openFile(file);
    this.markActiveLeafAsLifeView();
    await this.refresh();
  }

  private markActiveLeafAsLifeView(): void {
    markLifeOsLeaf(this.app);
  }

  private createSectionTitle(parent: HTMLElement, text: string, icon: string): HTMLElement {
    const title = parent.createEl("h3", { cls: "pls-section-title" });
    const iconEl = title.createSpan({ cls: "pls-section-title-icon" });
    setIcon(iconEl, icon);
    title.createSpan({ text });
    return title;
  }

  private createDashboardButton(parent: HTMLElement, text: string, icon: string, onClick: () => void, className = ""): HTMLButtonElement {
    const button = parent.createEl("button", { cls: className });
    if (icon) {
      const iconEl = button.createSpan({ cls: "pls-button-icon" });
      setIcon(iconEl, icon);
    }
    button.createSpan({ text });
    button.onclick = onClick;
    return button;
  }

  private prependIcon(parent: HTMLElement, icon: string): void {
    const iconEl = parent.createSpan({ cls: "pls-inline-icon" });
    setIcon(iconEl, icon);
    parent.prepend(iconEl);
  }

  private openObsidianSettings(): void {
    const appWithSettings = this.app as unknown as { setting?: { open: () => void } };
    if (appWithSettings.setting) {
      appWithSettings.setting.open();
      return;
    }
    new Notice("请从 Obsidian 设置中打开个人人生系统设置。");
  }

  private applyBackgroundImage(root: HTMLElement): void {
    const imageUrl = this.plugin.getBackgroundResourceUrl();
    if (!imageUrl) return;
    root.addClass("pls-has-custom-bg");
    root.style.setProperty("--pls-custom-bg", `url("${imageUrl.replace(/"/g, "%22")}")`);
  }

  private getVaultResourceUrl(path: string): string | null {
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (!(abstract instanceof TFile)) return null;
    const adapter = this.app.vault.adapter as unknown as {
      getResourcePath?: (normalizedPath: string) => string;
    };
    return adapter.getResourcePath?.(abstract.path) ?? null;
  }

  private async runDashboardAction(label: string, action: () => void | Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`${label}失败：${message}`);
      console.error(`[Personal Life System] ${label} failed`, error);
    }
  }

  private async getOpenTasks(): Promise<string[]> {
    const path = this.plugin.path("Tasks", "open.md");
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (!(abstract instanceof TFile)) {
      return [];
    }
    const content = await this.app.vault.read(abstract);
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- [ ]"));
  }

  private async renderOpenTasks(parent: HTMLElement): Promise<void> {
    const tasks = await this.getOpenTasks();
    if (tasks.length === 0) {
      const empty = parent.createDiv({ cls: "pls-empty" });
      empty.createDiv({ cls: "pls-empty-icon", text: "📋" });
      empty.createEl("p", { cls: "pls-empty-title", text: "暂无未完成待办" });
      empty.createEl("p", { cls: "pls-empty-hint", text: "点击下方按钮从当前打开的笔记提取待办" });
      empty.createEl("button", { text: "从当前打开的笔记提取待办" }).onclick = () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice("请先打开一篇笔记。"); return; }
        new Notice(`AI 正在提取待办：${file.path}`);
        void this.plugin.extractTasksFromFile(file);
      };
      return;
    }
    const stats = getTaskStats(
      tasks
        .map((line) => parseTaskLine(line))
        .filter((t): t is NonNullable<ReturnType<typeof parseTaskLine>> => t !== null)
    );
    if (stats.overdue > 0 || stats.dueToday > 0) {
      const badgeRow = parent.createDiv({ cls: "pls-muted", attr: { style: "margin-bottom: 4px;" } });
      if (stats.overdue > 0) badgeRow.createSpan({ text: `${stats.overdue} 个过期 `, cls: "pls-bad" });
      if (stats.dueToday > 0) badgeRow.createSpan({ text: `${stats.dueToday} 个今日到期` });
    }
    const list = parent.createDiv({ cls: "pls-task-preview" });
    const showCount = tasks.length > 5 ? 5 : tasks.length;
    const renderTaskRow = (container: HTMLElement, task: string) => {
      const parsed = parseTaskLine(task);
      const displayText = parsed?.title ?? task.replace(/^- \[ \]\s*/, "");
      const row = container.createDiv({ cls: "pls-list-item" });
      const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
      row.createEl("span", { text: displayText, cls: "pls-item-title" });
      checkbox.onchange = () => void this.completeTask(task);
    };
    for (let i = 0; i < showCount; i++) {
      renderTaskRow(list, tasks[i]);
    }
    if (tasks.length > 5) {
      const expandRow = parent.createDiv({ cls: "pls-muted", attr: { style: "margin-top:4px;" } });
      expandRow.createEl("a", {
        text: `展开全部 ${tasks.length} 条`,
        attr: { href: "#" }
      }).onclick = (e) => {
        e.preventDefault();
        expandRow.remove();
        for (let i = 5; i < tasks.length; i++) {
          renderTaskRow(list, tasks[i]);
        }
      };
    }
  }

  private async completeTask(taskLine: string): Promise<void> {
    // Cancel any pending undo
    if (this.pendingUndo) {
      clearTimeout(this.pendingUndo.timeout);
      this.pendingUndo = null;
    }

    const updated = await completeAndArchiveTask(
      this.app,
      taskLine,
      this.plugin.path("Tasks", "open.md"),
      this.plugin.path("Tasks", "done.md")
    );

    if (!updated) {
      new Notice("任务状态更新失败，请检查任务文件。");
      return;
    }

    const parsed = parseTaskLine(taskLine);
    const title = parsed?.title ?? taskLine.replace(/^- \[ \]\s*/, "");

    // Show undo notice
    const undoNotice = new Notice(`已完成：${title.slice(0, 30)}  [撤销]`, 5000);
    const undoEl = (undoNotice as unknown as { noticeEl: HTMLElement }).noticeEl;
    if (undoEl) {
      const undoBtn = undoEl.querySelector("span");
      if (undoBtn) {
        undoBtn.addClass("pls-clickable");
      }
    }

    this.pendingUndo = {
      taskLine,
      timeout: setTimeout(() => {
        this.pendingUndo = null;
      }, 5000)
    };

    // Handle undo via click on the notice
    const checkUndo = () => {
      if (this.pendingUndo?.taskLine === taskLine) {
        // Undo: remove the done line from done.md and restore open task
        void this.undoCompleteTask(taskLine);
        clearTimeout(this.pendingUndo.timeout);
        this.pendingUndo = null;
      }
    };
    (undoNotice as unknown as { noticeEl: HTMLElement }).noticeEl.addEventListener("click", checkUndo, { once: true });

    await this.refresh();
  }

  private async undoCompleteTask(taskLine: string): Promise<void> {
    const openPath = this.plugin.path("Tasks", "open.md");
    const donePath = this.plugin.path("Tasks", "done.md");
    const openFile = await ensureFile(this.app, openPath, "# Open Tasks\n\n");
    const doneFile = await ensureFile(this.app, donePath, "# Done Tasks\n\n");
    const openContent = await this.app.vault.read(openFile);
    const doneContent = await this.app.vault.read(doneFile);
    const result = undoTaskMarkdown(openContent, doneContent, taskLine);
    if (result.openContent !== openContent) await this.app.vault.modify(openFile, result.openContent);
    if (result.doneContent !== doneContent) await this.app.vault.modify(doneFile, result.doneContent);

    new Notice("已撤销。");
    await this.refresh();
  }

  private async countPendingMemories(): Promise<number> {
    const fs = new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);
    return (await new MemoryService(this.app, fs).loadPending()).length;
  }

  private async getCheckinStreak(): Promise<number> {
    const date = formatDate();
    const checkinPath = this.plugin.path("Exam", "Checkins", `${date}.md`);
    const abstract = this.app.vault.getAbstractFileByPath(checkinPath);
    if (!(abstract instanceof TFile)) return 0;
    const fm = parseFrontmatter(this.app, abstract);
    return typeof fm?.streak === "number" ? fm.streak : Number(fm?.streak ?? 0);
  }
}

async function openPath(plugin: IPlugin, path: string): Promise<void> {
  const file = await ensureFile(plugin.app, path, "");
  await plugin.app.workspace.getLeaf(false).openFile(file);
  plugin.app.workspace.activeLeaf?.view.containerEl.addClass("pls-life-file-leaf");
}
