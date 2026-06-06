import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { DASHBOARD_VIEW_TYPE } from "../constants";
import { createButton } from "../components/Button";
import { createCard } from "../components/Card";
import { createEmptyState } from "../components/EmptyState";
import { createHeroHeader } from "../components/HeroHeader";
import { createLifeOSShell } from "../components/LifeOSComponent";
import { createStatCard } from "../components/StatCard";
import { createTaskRow } from "../components/TaskRow";
import type PersonalLifeSystemPlugin from "../main";
import { NewTaskModal } from "../modals/NewTaskModal";
import { QuickCaptureModal } from "../modals/QuickCaptureModal";
import { FileSystemService } from "../services/FileSystemService";
import { ReviewService } from "../services/ReviewService";
import { TaskService } from "../services/TaskService";
import { getExamProfileLabel } from "../settings";
import { currentDateLabel, today } from "../utils/dates";

export class LifeOSDashboardView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: PersonalLifeSystemPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return DASHBOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Life OS";
  }

  async onOpen(): Promise<void> {
    await this.render();
    this.registerEvent(this.app.vault.on("modify", () => void this.render()));
    this.registerEvent(this.app.vault.on("create", () => void this.render()));
    this.registerEvent(this.app.vault.on("delete", () => void this.render()));
  }

  private async render(): Promise<void> {
    await this.plugin.ensureBaseStructure();
    const container = this.containerEl.children[1];
    container.empty();

    const main = createLifeOSShell(container as HTMLElement, this.plugin, "dashboard");
    const fs = new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);
    const tasks = new TaskService(this.app, fs);
    const openTasks = await tasks.loadOpenTasks();
    const date = today();
    const todayFile = this.app.vault.getAbstractFileByPath(this.plugin.getTodayNotePath(date));
    const checkinFile = this.app.vault.getAbstractFileByPath(fs.path("Exam", "Checkins", `${date}.md`));
    const summaryFile = this.app.vault.getAbstractFileByPath(fs.path("Memory", "Summaries", "Daily", `${date}.md`));
    const weeklySummaryCount = this.countThisWeekDailySummaries(fs);
    const hasTodayNote = todayFile instanceof TFile;
    const hasCheckin = checkinFile instanceof TFile;
    const hasReview = summaryFile instanceof TFile;
    const recommendation = this.getTodayRecommendation(openTasks.length, hasTodayNote, hasCheckin, hasReview);

    createHeroHeader(main, {
      kicker: "今日行动",
      title: "今天",
      description: "先完成一件重要的小事。",
      meta: currentDateLabel(),
      icon: "sparkles",
      actions: [
        { label: "立即打卡", icon: "graduation-cap", primary: true, onClick: () => void this.plugin.showCheckinModal() },
        { label: "快速记录", icon: "pencil-line", onClick: () => new QuickCaptureModal(this.app, this.plugin).open() },
        { label: "新建任务", icon: "plus", onClick: () => new NewTaskModal(this.app, this.plugin, () => this.render()).open() },
        { label: "打开今日日记", icon: "book-open", onClick: () => void this.plugin.openTodayNote(false) }
      ]
    });

    const workspace = main.createDiv({ cls: "lifeos-dashboard-grid" });
    const center = workspace.createDiv({ cls: "lifeos-dashboard-center" });
    const right = workspace.createDiv({ cls: "lifeos-dashboard-right" });
    right.addClass("lifeos-aux-panel");
    right.addClass("lifeos-dashboard-rail");

    const statGrid = center.createDiv({ cls: "lifeos-grid lifeos-stat-grid" });
    createStatCard(statGrid, "待处理任务", String(openTasks.length), "purple", "check-square");
    createStatCard(statGrid, "今日日记", hasTodayNote ? "已创建" : "待开始", "blue", "book-open");
    createStatCard(statGrid, `${getExamProfileLabel(this.plugin.settings)}打卡`, hasCheckin ? "已打卡" : "待打卡", "green", "graduation-cap");
    createStatCard(statGrid, "本周复盘", String(weeklySummaryCount), "orange", "bar-chart-3");

    this.renderRecommendedAction(center, recommendation, hasCheckin);
    this.renderLlmWikiReminder(center, fs);
    this.renderTodayTasks(center, tasks, openTasks, hasTodayNote ? todayFile : null);

    const statusGrid = center.createDiv({ cls: "lifeos-status-grid" });
    this.renderDailyCard(statusGrid, hasTodayNote);
    this.renderCheckinCard(statusGrid, hasCheckin);
    this.renderReviewCard(statusGrid, hasReview);

    this.renderAssistant(right);
    this.renderQuickActions(right, hasTodayNote);
    this.renderWorkflowGuide(right);
  }

  private getTodayRecommendation(taskCount: number, hasTodayNote: boolean, hasCheckin: boolean, hasReview: boolean): { title: string; description: string } {
    if (!hasTodayNote && taskCount === 0) {
      return { title: "先给今天开一个轻入口", description: "建议先创建今日日记，或者用快速记录写下第一条想法。Life OS 会把记录、任务和记忆慢慢整理起来。" };
    }
    if (taskCount > 0) {
      return { title: `今天有 ${taskCount} 个待处理任务`, description: "先完成最小的一件事，再回到今日日记补一句复盘。" };
    }
    if (!hasCheckin) return { title: `今天建议先完成一次${getExamProfileLabel(this.plugin.settings)}打卡`, description: "记录一次学习动作，就能让长期趋势更完整。" };
    if (!hasReview) return { title: "今天已经有记录，可以做一次简短复盘", description: "复盘不用很长，三句话也足够沉淀今天的状态。" };
    return { title: "今天的核心记录已经完整", description: "保持这个节奏，明天打开时会更容易接上当前状态。" };
  }

  private renderRecommendedAction(parent: HTMLElement, recommendation: { title: string; description: string }, hasCheckin: boolean): void {
    const card = createCard(parent, "lifeos-recommendation-card lifeos-card-primary");
    const copy = card.createDiv({ cls: "lifeos-recommendation-copy" });
    copy.createDiv({ cls: "lifeos-kicker", text: "今日推荐行动" });
    copy.createEl("h2", { text: hasCheckin ? recommendation.title : `今天建议先完成一次${getExamProfileLabel(this.plugin.settings)}打卡` });
    copy.createEl("p", { text: hasCheckin ? recommendation.description : "记录一次学习动作，就能让长期趋势更完整。" });
    const actions = card.createDiv({ cls: "lifeos-recommendation-actions" });
    createButton(actions, hasCheckin ? "快速记录" : "立即打卡", () => {
      if (hasCheckin) new QuickCaptureModal(this.app, this.plugin).open();
      else void this.plugin.showCheckinModal();
    }, { primary: true, icon: hasCheckin ? "pencil-line" : "graduation-cap" });
    createButton(actions, "打开今日日记", () => void this.plugin.openTodayNote(false), { ghost: true, icon: "book-open" });
    createButton(actions, "新建任务", () => new NewTaskModal(this.app, this.plugin, () => this.render()).open(), { ghost: true, icon: "plus" });
  }

  private renderLlmWikiReminder(parent: HTMLElement, fs: FileSystemService): void {
    if (this.plugin.settings.llmWikiDashboardReminder === false) return;

    const count = this.countLlmWikiPending(fs);
    if (count <= 0) return;

    const card = createCard(parent, "lifeos-panel lifeos-llmwiki-dashboard-reminder");
    this.cardTitle(card, `知识库有 ${count} 条内容待整理`, "library");
    card.createEl("p", { text: "这些是你主动保存到 LLM Wiki 的 Raw 资料或 Draft，详细处理请到 Knowledge 页面完成。" });
    createButton(card, "打开 Knowledge", () => void this.plugin.activateKnowledge(), { primary: true, icon: "book-open" });
  }

  private renderTodayTasks(parent: HTMLElement, service: TaskService, openTasks: Awaited<ReturnType<TaskService["loadOpenTasks"]>>, todayFile: TFile | null): void {
    const card = createCard(parent, "lifeos-panel lifeos-task-focus-card lifeos-card-primary");
    const header = card.createDiv({ cls: "lifeos-card-heading-row" });
    this.cardTitle(header, "今日任务", "check-square");
    header.createDiv({ cls: "lifeos-card-subtle", text: "先处理最重要的一件事，未完成任务不会丢失。" });
    const list = card.createDiv({ cls: "lifeos-task-list" });
    if (openTasks.length === 0) {
      createEmptyState(list, {
        icon: "list-plus",
        title: "今天还没有任务",
        description: "可以先创建一个最小行动，也可以从日记里提取待办。",
        actions: [
          { label: "新建任务", icon: "plus", primary: true, onClick: () => new NewTaskModal(this.app, this.plugin, () => this.render()).open() },
          { label: "快速记录", icon: "pencil-line", onClick: () => new QuickCaptureModal(this.app, this.plugin).open() },
          { label: "从今日日记提取待办", icon: "wand-2", onClick: () => void this.extractTasksFromToday(todayFile) }
        ]
      });
      const examples = list.createDiv({ cls: "lifeos-example-tasks" });
      examples.createDiv({ cls: "lifeos-example-title", text: "示例，不会写入文件" });
      ["阅读 30 分钟 #学习", "整理今天的想法 #复盘"].forEach((text) => {
        const row = examples.createDiv({ cls: "lifeos-example-task-row" });
        row.createSpan({ text: "[ ]" });
        row.createSpan({ text });
      });
    } else {
      for (const task of openTasks.slice(0, 5)) {
        createTaskRow(list, this.app, this, task, async () => {
          await service.completeTask(task);
          new Notice("任务已完成，已归档到已完成任务。", 5000);
          await this.render();
        });
      }
    }
    const actions = card.createDiv({ cls: "lifeos-card-actions" });
    createButton(actions, "查看全部任务", () => void this.plugin.activateTasks(), { ghost: true, icon: "arrow-right" });
    createButton(actions, "新建任务", () => new NewTaskModal(this.app, this.plugin, () => this.render()).open(), { primary: openTasks.length > 0, icon: "plus" });
  }

  private async extractTasksFromToday(todayFile: TFile | null): Promise<void> {
    if (!todayFile) {
      new Notice("还没有今日日记，先创建一篇再提取任务。");
      await this.plugin.openTodayNote(false);
      return;
    }
    await this.plugin.extractTasksFromFile(todayFile);
  }

  private renderDailyCard(parent: HTMLElement, exists: boolean): void {
    const card = createCard(parent, "lifeos-status-card tone-blue lifeos-card-secondary");
    this.cardTitle(card, "今日日记", "book-open");
    card.createEl("p", { text: exists ? "今天的记录已经开始，可以随时继续补充。" : "还没有今日日记。先创建一个安放今天的容器。" });
    createButton(card, exists ? "打开今日日记" : "创建今日日记", () => void this.plugin.openTodayNote(false), {
      primary: !exists,
      icon: exists ? "external-link" : "book-plus"
    });
  }

  private renderCheckinCard(parent: HTMLElement, exists: boolean): void {
    const card = createCard(parent, "lifeos-status-card tone-green lifeos-card-secondary");
    this.cardTitle(card, `${getExamProfileLabel(this.plugin.settings)}打卡`, "graduation-cap");
    card.createEl("p", { text: exists ? "今天已经打卡，长期趋势会更稳定。" : `记录一次${getExamProfileLabel(this.plugin.settings)}学习动作，让成长有迹可循。` });
    createButton(card, exists ? "查看打卡" : "今日打卡", () => void this.plugin.showCheckinModal(), { icon: "check-circle", primary: !exists });
  }

  private renderReviewCard(parent: HTMLElement, exists: boolean): void {
    const card = createCard(parent, "lifeos-status-card tone-orange lifeos-card-secondary");
    this.cardTitle(card, "今日复盘", "sparkles");
    card.createEl("p", { text: exists ? "今日复盘已经生成，可以进入复盘页继续整理。" : "用几句话总结今天，后续会沉淀成长趋势。" });
    createButton(card, exists ? "打开复盘页" : "生成今日复盘", async () => {
      if (exists) {
        await this.plugin.activateReview();
        return;
      }
      const fs = new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);
      await new ReviewService(this.app, fs, this.plugin.settings).generateDailyReview();
      new Notice("今日复盘已生成。");
      await this.render();
    }, { primary: !exists, icon: exists ? "bar-chart-3" : "wand-2" });
  }

  private renderAssistant(parent: HTMLElement): void {
    const card = createCard(parent, "lifeos-panel lifeos-ai-card lifeos-card-secondary");
    this.cardTitle(card, "AI 助手建议", "bot");
    card.createEl("p", { text: "我会结合你的日记、任务、记忆和复盘，给出更贴合当前状态的建议。" });
    const input = card.createEl("input", { cls: "lifeos-input", attr: { placeholder: "例如：我今天最该先做什么？" } });
    createButton(card, "问 Life OS", () => {
      const prompt = input.value.trim();
      input.value = "";
      void this.plugin.activateChat(prompt);
    }, { primary: true, icon: "send" });
  }

  private renderQuickActions(parent: HTMLElement, hasTodayNote: boolean): void {
    const card = createCard(parent, "lifeos-panel lifeos-card-subtle lifeos-quick-actions-card");
    this.cardTitle(card, "快捷操作", "zap");
    const grid = card.createDiv({ cls: "lifeos-action-grid" });
    this.actionTile(grid, "快速记录", "随手记下想法", "pencil-line", () => new QuickCaptureModal(this.app, this.plugin).open(), true);
    this.actionTile(grid, "新建任务", "创建一个最小行动", "plus", () => new NewTaskModal(this.app, this.plugin, () => this.render()).open());
    this.actionTile(grid, "记忆审核", "确认后再沉淀", "brain", () => void this.plugin.activateMemory());
    this.actionTile(grid, hasTodayNote ? "打开今日日记" : "创建今日日记", "今天的一切从这里开始", "book-open", () => void this.plugin.activateDaily());
  }

  private renderWorkflowGuide(parent: HTMLElement): void {
    const card = createCard(parent, "lifeos-panel lifeos-workflow-card lifeos-card-subtle");
    this.cardTitle(card, "Life OS 如何工作", "route");
    const steps = [
      ["记录今天", "日记、打卡和快速记录先保存到本地 Vault。"],
      ["整理任务", "待办进入任务池，完成后自动归档。"],
      ["沉淀记忆", "AI 只放入候选池，确认后才进入正式记忆。"]
    ];
    const list = card.createDiv({ cls: "lifeos-workflow-list" });
    steps.forEach(([title, description], index) => {
      const item = list.createDiv({ cls: "lifeos-workflow-item" });
      item.createSpan({ cls: "lifeos-workflow-index", text: String(index + 1) });
      const copy = item.createDiv({ cls: "lifeos-workflow-copy-block" });
      copy.createDiv({ cls: "lifeos-workflow-title", text: title });
      copy.createDiv({ cls: "lifeos-workflow-copy", text: description });
    });
  }

  private actionTile(parent: HTMLElement, title: string, description: string, icon: string, onClick: () => void, primary = false): void {
    const button = parent.createEl("button", {
      cls: primary ? "lifeos-action-tile is-primary" : "lifeos-action-tile",
      attr: { type: "button" }
    });
    setIcon(button.createSpan({ cls: "lifeos-action-tile-icon" }), icon);
    const copy = button.createSpan({ cls: "lifeos-action-tile-copy" });
    copy.createSpan({ cls: "lifeos-action-tile-title", text: title });
    copy.createSpan({ cls: "lifeos-action-tile-description", text: description });
    button.onclick = onClick;
  }

  private cardTitle(parent: HTMLElement, title: string, icon: string): void {
    const header = parent.createDiv({ cls: "lifeos-card-title" });
    setIcon(header.createSpan(), icon);
    header.createSpan({ text: title });
  }

  private countThisWeekDailySummaries(fs: FileSystemService): number {
    const now = new Date();
    const day = now.getDay() || 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - day + 1);
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    return this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(fs.path("Memory", "Summaries", "Daily") + "/"))
      .filter((file) => {
        const match = file.basename.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) return false;
        const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        return date >= monday && date <= sunday;
      }).length;
  }

  private countLlmWikiPending(fs: FileSystemService): number {
    const prefixes = [
      fs.path("Knowledge", "LLMWiki", "Raw", "Inbox") + "/",
      fs.path("Knowledge", "LLMWiki", "Wiki", "Drafts") + "/"
    ];

    return this.app.vault.getMarkdownFiles()
      .filter((file) => file.basename !== "index")
      .filter((file) => file.path.endsWith(".md"))
      .filter((file) => prefixes.some((prefix) => file.path.startsWith(prefix)))
      .length;
  }
}
