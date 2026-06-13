import { ItemView, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { REVIEW_VIEW_TYPE } from "../constants";
import type PersonalLifeSystemPlugin from "../main";
import { createButton } from "../components/Button";
import { createCard } from "../components/Card";
import { createEmptyState } from "../components/EmptyState";
import { createContributionHeatmap } from "../components/ContributionHeatmap";
import { createHeroHeader } from "../components/HeroHeader";
import { createLifeOSShell } from "../components/LifeOSComponent";
import { createStatCard } from "../components/StatCard";
import { QuickCaptureModal } from "../modals/QuickCaptureModal";
import { ActivityService, type DailyActivity } from "../services/ActivityService";
import { DailyNoteService } from "../services/DailyNoteService";
import { DisplayFormatService, type DisplayBlock } from "../services/DisplayFormatService";
import { FileSystemService } from "../services/FileSystemService";
import { ReviewService, type ReviewSummaryPeriod, type SummaryInfo } from "../services/ReviewService";
import { today } from "../utils/dates";
import { renderMarkdownDisplay } from "../utils/markdown-render";
import { readFile } from "../utils/vault";

export class ReviewView extends ItemView {
  private renderToken = 0;
  private renderDebounceHandle: number | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: PersonalLifeSystemPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return REVIEW_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "多维复盘";
  }

  async onOpen(): Promise<void> {
    void this.render();
    this.registerEvent(this.app.vault.on("create", (file) => this.scheduleRender(file)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.scheduleRender(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.scheduleRender(file)));
  }

  async onClose(): Promise<void> {
    this.renderToken += 1;
    if (this.renderDebounceHandle !== null) {
      window.clearTimeout(this.renderDebounceHandle);
      this.renderDebounceHandle = null;
    }
  }

  private async render(): Promise<void> {
    const token = ++this.renderToken;
    const container = this.containerEl.children[1];
    container.empty();
    const main = createLifeOSShell(container as HTMLElement, this.plugin, "review");
    this.renderLoadingState(main);

    await this.plugin.ensureBaseStructure();
    if (!this.isCurrentRender(token)) return;

    main.empty();
    const fs = new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);
    const reviews = new ReviewService(this.app, fs, this.plugin.settings);
    const activities = Array.from(
      (await new ActivityService(this.app, fs, this.plugin.settings).getDailyActivityMap()).values()
    );
    if (!this.isCurrentRender(token)) return;
    const summaryGroups = reviews.listSummariesByPeriod();
    const activeDays = activities.filter((item) => item.score > 0).length;
    const streak = this.continuousStreak(activities);
    const completedTasks = activities.reduce((sum, item) => sum + item.completedTaskCount, 0);
    const summaryCount = activities.filter((item) => item.summaryExists).length;

    createHeroHeader(main, {
      kicker: "成长看板",
      title: streak > 0 ? `你已经连续记录 ${streak} 天` : "从今天开始看见成长轨迹",
      description: "日记、任务、打卡和复盘会逐渐形成一条可回看的成长轨迹。",
      icon: "bar-chart-3",
      actions: [
        { label: "生成今日复盘", icon: "wand-2", primary: true, onClick: () => void this.generateSummary(reviews, "Daily") },
        { label: "打开今日日记", icon: "book-open", onClick: () => void this.plugin.openTodayNote(false) }
      ]
    });

    const stats = main.createDiv({ cls: "lifeos-grid lifeos-stat-grid lifeos-review-stat-grid" });
    createStatCard(stats, "记录天数", String(activeDays), "green", "calendar-days");
    createStatCard(stats, "连续记录", `${streak} 天`, "blue", "flame");
    createStatCard(stats, "完成任务数", String(completedTasks), "purple", "check-check");
    createStatCard(stats, "复盘次数", String(summaryCount), "orange", "sparkles");

    const focus = main.createDiv({ cls: "lifeos-review-focus-grid" });
    this.renderHeatmap(focus, activities);
    await this.renderHighlight(focus, fs);
    if (!this.isCurrentRender(token)) return;

    const summaries = main.createDiv({ cls: "lifeos-review-grid" });
    await this.renderSummaryList(summaries, "今日复盘", "每天三句话也能沉淀状态。", reviews, "Daily", summaryGroups.Daily);
    await this.renderSummaryList(summaries, "本周回顾", "回看这一周完成了什么。", reviews, "Weekly", summaryGroups.Weekly);
    await this.renderSummaryList(summaries, "月度总结", "看见长期主题和反复出现的问题。", reviews, "Monthly", summaryGroups.Monthly);
    await this.renderSummaryList(summaries, "年度脉络", "把一年里的变化整理成脉络。", reviews, "Yearly", summaryGroups.Yearly);
  }

  private renderLoadingState(main: HTMLElement): void {
    createHeroHeader(main, {
      kicker: "成长看板",
      title: "正在整理复盘数据",
      description: "先打开页面，统计、热力图和复盘列表会在后台加载。",
      icon: "bar-chart-3",
      actions: [
        { label: "打开今日日记", icon: "book-open", onClick: () => void this.plugin.openTodayNote(false) }
      ]
    });

    const stats = main.createDiv({ cls: "lifeos-grid lifeos-stat-grid lifeos-review-stat-grid" });
    createStatCard(stats, "记录天数", "…", "green", "calendar-days");
    createStatCard(stats, "连续记录", "…", "blue", "flame");
    createStatCard(stats, "完成任务数", "…", "purple", "check-check");
    createStatCard(stats, "复盘次数", "…", "orange", "sparkles");

    const focus = main.createDiv({ cls: "lifeos-review-focus-grid" });
    const heatmap = createCard(focus, "lifeos-panel lifeos-contrib-card");
    createEmptyState(heatmap, {
      icon: "loader",
      title: "正在加载成长热力图",
      description: "正在读取最近记录，不会阻塞页面打开。",
      compact: true
    });
    const highlight = createCard(focus, "lifeos-panel lifeos-highlight-card");
    createEmptyState(highlight, {
      icon: "sparkles",
      title: "正在提取高光时刻",
      description: "稍后会显示最近可复盘的内容。",
      compact: true
    });

    const summaries = main.createDiv({ cls: "lifeos-review-grid" });
    for (const title of ["今日复盘", "本周回顾", "月度总结", "年度脉络"]) {
      const card = createCard(summaries, "lifeos-summary-card");
      card.createDiv({ cls: "lifeos-summary-title", text: title });
      card.createDiv({ cls: "lifeos-summary-status", text: "正在加载…" });
    }
  }

  private renderHeatmap(parent: HTMLElement, activities: DailyActivity[]): void {
    createContributionHeatmap(parent, {
      app: this.app,
      plugin: this.plugin,
      activities,
      onSettingsSaved: () => this.render()
    });
  }

  private async renderHighlight(parent: HTMLElement, fs: FileSystemService): Promise<void> {
    const highlight = createCard(parent, "lifeos-panel lifeos-highlight-card");
    highlight.createEl("h2", { text: "高光时刻" });
    const blocks = await this.collectHighlightBlocks(fs);
    if (blocks.length === 0) {
      createEmptyState(highlight, {
        icon: "sparkles",
        title: "还没有高光内容",
        description: "先记录今天发生的一件小事，复盘会慢慢长出来。",
        actions: [{ label: "快速记录", icon: "pencil-line", primary: true, onClick: () => new QuickCaptureModal(this.app, this.plugin).open() }],
        compact: true
      });
      return;
    }
    const list = highlight.createDiv({ cls: "lifeos-highlight-list" });
    for (const block of blocks.slice(0, 3)) {
      const row = list.createDiv({ cls: "lifeos-highlight-row" });
      renderMarkdownDisplay(this.app, this, row.createDiv({ cls: "lifeos-highlight-text" }), block.text, block.sourcePath);
      if (block.sourceDate) row.createDiv({ cls: "lifeos-highlight-meta", text: block.sourceDate });
    }
  }

  private async generateSummary(reviews: ReviewService, period: ReviewSummaryPeriod): Promise<void> {
    const file = await reviews.generateSummary(period);
    await this.app.workspace.getLeaf(false).openFile(file);
    await this.render();
  }

  private async renderSummaryList(
    parent: HTMLElement,
    title: string,
    description: string,
    reviews: ReviewService,
    period: ReviewSummaryPeriod,
    summaries: SummaryInfo[]
  ): Promise<void> {
    const card = createCard(parent, "lifeos-summary-card");
    card.createDiv({ cls: "lifeos-summary-title", text: title });
    card.createEl("p", { text: description });
    const items = summaries.slice(0, 5);
    const actions = card.createDiv({ cls: "lifeos-summary-actions" });
    if (items.length === 0) {
      card.createDiv({ cls: "lifeos-summary-status", text: "暂时还没有内容，先从今日复盘开始。" });
      createButton(actions, this.generateLabel(period), () => void this.generateSummary(reviews, period), { primary: period === "Daily", icon: "wand-2" });
      return;
    }
    createButton(actions, "查看最新", async () => {
      const file = this.app.vault.getAbstractFileByPath(items[0].path);
      if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
    }, { ghost: true, icon: "external-link" });
    for (const item of items) {
      const file = this.app.vault.getAbstractFileByPath(item.path);
      const content = file instanceof TFile ? await this.app.vault.read(file) : "";
      const blocks = await new DisplayFormatService().formatReviewHighlightForDisplay(content, item.basename, item.path);
      const row = card.createDiv({ cls: "lifeos-summary-row" });
      const copy = row.createDiv();
      copy.createDiv({ cls: "lifeos-summary-row-date", text: item.basename });
      renderMarkdownDisplay(this.app, this, copy.createDiv({ cls: "lifeos-summary-row-text" }), blocks[0]?.text || "已有记录，可打开查看", item.path);
      createButton(row, "打开记录", async () => {
        const file = this.app.vault.getAbstractFileByPath(item.path);
        if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
      }, { ghost: true, icon: "external-link" });
    }
  }

  private async collectHighlightBlocks(fs: FileSystemService): Promise<DisplayBlock[]> {
    const formatter = new DisplayFormatService();
    const date = today();
    const dailyPath = new DailyNoteService(this.app, fs, this.plugin.settings).getTodayNotePath(date);
    const candidates = [
      { path: fs.path("Memory", "Summaries", "Daily", `${date}.md`), date },
      { path: dailyPath, date },
      { path: fs.path("Exam", "Checkins", `${date}.md`), date },
      { path: fs.path("Tasks", "done.md"), date }
    ];
    const blocks: DisplayBlock[] = [];
    for (const item of candidates) {
      const content = await readFile(this.app, item.path);
      if (!content.trim()) continue;
      const next = await formatter.formatReviewHighlightForDisplay(content, item.date, item.path);
      blocks.push(...next);
      if (blocks.length >= 3) break;
    }
    return blocks;
  }

  private generateLabel(period: ReviewSummaryPeriod): string {
    if (period === "Weekly") return "生成本周回顾";
    if (period === "Monthly") return "生成月度总结";
    if (period === "Yearly") return "生成年终总结";
    return "生成今日复盘";
  }

  private continuousStreak(dates: DailyActivity[]): number {
    let count = 0;
    for (const item of [...dates].reverse()) {
      if (item.score <= 0) break;
      count += 1;
    }
    return count;
  }

  private scheduleRender(file?: TAbstractFile): void {
    if (!this.shouldRefreshForFile(file)) return;
    if (this.renderDebounceHandle !== null) window.clearTimeout(this.renderDebounceHandle);
    this.renderDebounceHandle = window.setTimeout(() => {
      this.renderDebounceHandle = null;
      void this.render();
    }, 350);
  }

  private shouldRefreshForFile(file?: TAbstractFile): boolean {
    if (!file || !("path" in file)) return true;
    const root = normalizeVaultPath(this.plugin.getRoot());
    const path = normalizeVaultPath(file.path);
    return path === root || path.startsWith(`${root}/`);
  }

  private isCurrentRender(token: number): boolean {
    return token === this.renderToken;
  }
}

function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/").trim();
}
