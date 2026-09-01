import { ItemView, Notice, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
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
import { PeriodReviewModal } from "../modals/PeriodReviewModal";
import { ActivityService, type DailyActivity } from "../services/ActivityService";
import { DailyNoteService } from "../services/DailyNoteService";
import { DisplayFormatService, type DisplayBlock } from "../services/DisplayFormatService";
import { FileSystemService } from "../services/FileSystemService";
import { AutoReviewService, type AutoReviewDraft } from "../services/AutoReviewService";
import { PeriodReviewService } from "../services/PeriodReviewService";
import { ReviewService, type ReviewSummaryPeriod, type SummaryInfo } from "../services/ReviewService";
import { today } from "../utils/dates";
import { renderMarkdownDisplay } from "../utils/markdown-render";
import { renderStableView } from "../utils/stable-view-refresh";
import { readFile } from "../utils/vault";

export class ReviewView extends ItemView {
  private renderToken = 0;
  private renderDebounceHandle: number | null = null;
  private renderPromise: Promise<void> | null = null;
  private renderQueued = false;
  private preserveScrollOnNextRender = true;

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
    await this.render(false);
    this.registerEvent(this.app.vault.on("create", (file) => this.scheduleRender(file)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.scheduleRender(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.scheduleRender(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (this.shouldRefreshForFile(file) || this.shouldRefreshForFile(oldPath)) this.scheduleRender();
    }));
  }

  async onClose(): Promise<void> {
    this.renderToken += 1;
    this.renderQueued = false;
    if (this.renderDebounceHandle !== null) {
      window.clearTimeout(this.renderDebounceHandle);
      this.renderDebounceHandle = null;
    }
  }

  private async render(preserveScroll = true): Promise<void> {
    if (this.renderDebounceHandle !== null) {
      window.clearTimeout(this.renderDebounceHandle);
      this.renderDebounceHandle = null;
    }
    this.renderToken += 1;
    this.renderQueued = true;
    this.preserveScrollOnNextRender = preserveScroll;
    if (this.renderPromise) return this.renderPromise;

    const run = async (): Promise<void> => {
      while (this.renderQueued) {
        this.renderQueued = false;
        const token = this.renderToken;
        await this.renderPass(token, this.preserveScrollOnNextRender);
      }
    };
    this.renderPromise = run().finally(() => {
      this.renderPromise = null;
    });
    return this.renderPromise;
  }

  private async renderPass(token: number, preserveScroll: boolean): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement | undefined;
    if (!container) return;
    await this.plugin.ensureBaseStructure();
    if (!this.isCurrentRender(token)) return;
    const fs = new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);
    const reviews = new ReviewService(this.app, fs, this.plugin.settings);
    const periodReviews = new PeriodReviewService(this.app, fs, this.plugin.settings);
    const autoReviews = new AutoReviewService(this.app, fs, this.plugin.settings, this.plugin.ai);
    const [activityMap, pendingDrafts] = await Promise.all([
      new ActivityService(this.app, fs, this.plugin.settings).getDailyActivityMap(),
      autoReviews.listDrafts()
    ]);
    const activities = Array.from(activityMap.values());
    if (!this.isCurrentRender(token)) return;
    const summaryGroups = reviews.listSummariesByPeriod();
    const formalPeriodReviewCount = periodReviews.listReviews().length;
    const activeDays = activities.filter((item) => item.score > 0).length;
    const streak = this.continuousStreak(activities);
    const completedTasks = activities.reduce((sum, item) => sum + item.completedTaskCount, 0);
    const legacySummaryCount = Object.values(summaryGroups).reduce((total, items) => total + items.length, 0);
    const summaryCount = legacySummaryCount + formalPeriodReviewCount;

    await renderStableView(container, async (staging) => {
      const main = createLifeOSShell(staging, this.plugin, "review");
      main.addClass("lifeos-review-main");

    createHeroHeader(main, {
      kicker: "成长看板",
      title: streak > 0 ? `你已经连续记录 ${streak} 天` : "从今天开始看见成长轨迹",
      description: "日记、任务、打卡和复盘会逐渐形成一条可回看的成长轨迹。",
      icon: "bar-chart-3",
      actions: [
        { label: "生成今日复盘", icon: "wand-2", primary: true, onClick: () => void this.generateSummary("Daily") },
        { label: "打开今日日记", icon: "book-open", onClick: () => void this.plugin.openTodayNote(false) }
      ]
    });

    const stats = main.createDiv({ cls: "lifeos-grid lifeos-stat-grid lifeos-review-stat-grid" });
    createStatCard(stats, "记录天数", String(activeDays), "green", "calendar-days");
    createStatCard(stats, "连续记录", `${streak} 天`, "blue", "flame");
    createStatCard(stats, "完成任务数", String(completedTasks), "purple", "check-check");
    createStatCard(stats, "复盘次数", String(summaryCount), "orange", "sparkles");

    await this.renderPendingDrafts(main, pendingDrafts, autoReviews, periodReviews);

    const focus = main.createDiv({ cls: "lifeos-review-focus-grid" });
    this.renderHeatmap(focus, activities);
    const highlightHost = focus.createDiv({ cls: "lifeos-review-highlight-host" });
    const summaries = main.createDiv({ cls: "lifeos-review-grid" });
    const highlightPromise = this.renderHighlight(highlightHost, fs);
    await Promise.all([
      highlightPromise,
      this.renderSummaryList(summaries, "今日复盘", "每天三句话也能沉淀状态。", reviews, periodReviews, "Daily", summaryGroups.Daily, periodReviews.listReviews("daily")),
      this.renderSummaryList(summaries, "本周回顾", "回看这一周完成了什么。", reviews, periodReviews, "Weekly", summaryGroups.Weekly, periodReviews.listReviews("weekly")),
      this.renderSummaryList(summaries, "月度总结", "看见长期主题和反复出现的问题。", reviews, periodReviews, "Monthly", summaryGroups.Monthly, periodReviews.listReviews("monthly")),
      this.renderSummaryList(summaries, "年度脉络", "把一年里的变化整理成脉络。", reviews, periodReviews, "Yearly", summaryGroups.Yearly, [])
    ]);
    if (!this.isCurrentRender(token)) return;
    }, {
      preserveScroll,
      isCurrent: () => this.isCurrentRender(token)
    });
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
    const highlightHost = focus.createDiv({ cls: "lifeos-review-highlight-host" });
    const highlight = createCard(highlightHost, "lifeos-panel lifeos-highlight-card");
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

  private generateSummary(period: ReviewSummaryPeriod): void {
    const kind = period === "Daily" ? "daily" : period === "Weekly" ? "weekly" : period === "Monthly" ? "monthly" : "custom";
    void this.plugin.generateReport(kind);
  }

  private async renderPendingDrafts(
    parent: HTMLElement,
    drafts: AutoReviewDraft[],
    autoReviews: AutoReviewService,
    periodReviews: PeriodReviewService
  ): Promise<void> {
    const card = createCard(parent, "lifeos-panel lifeos-review-draft-queue");
    const heading = card.createDiv({ cls: "lifeos-card-heading-row" });
    const copy = heading.createDiv();
    copy.createEl("h2", { text: "待确认复盘草稿" });
    copy.createEl("p", { cls: "lifeos-muted", text: "自动复盘只会来到这里。确认、编辑并保存后，才会成为正式复盘。" });
    heading.createSpan({ cls: "lifeos-badge", text: `${drafts.length} 份待处理` });
    if (drafts.length === 0) {
      const empty = card.createDiv({ cls: "lifeos-review-draft-empty" });
      empty.createEl("strong", { text: "当前没有待确认草稿" });
      empty.createSpan({ text: this.plugin.settings.autoReviewEnabled ? "到达设定时间后会在这里生成。" : "可在设置中主动开启自动复盘，也可以手动生成。" });
      createButton(empty, "手动生成今日复盘", () => this.generateSummary("Daily"), { ghost: true, icon: "wand-2" });
      return;
    }
    const checked = await Promise.all(drafts.map(async (draft) => ({
      draft,
      sourceChanged: draft.status === "stale" || (await periodReviews.savedReviewSourceChanges(draft.path)).length > 0
    })));
    const list = card.createDiv({ cls: "lifeos-review-draft-list" });
    for (const { draft, sourceChanged } of checked) {
      const row = list.createDiv({ cls: `lifeos-review-draft-row ${sourceChanged ? "is-stale" : ""}` });
      const rowCopy = row.createDiv({ cls: "lifeos-review-draft-copy" });
      const title = rowCopy.createDiv({ cls: "lifeos-review-draft-title" });
      title.createEl("strong", { text: `${draft.window.start} 日复盘` });
      title.createSpan({ cls: sourceChanged ? "lifeos-badge is-warning" : "lifeos-badge is-success", text: sourceChanged ? "来源已变化" : "等待确认" });
      rowCopy.createDiv({
        cls: "lifeos-review-draft-meta",
        text: `生成于 ${formatReviewTime(draft.generatedAt)} · 质量 ${draft.qualityScore} 分 · ${draft.qualityStatus === "pass" ? "检查通过" : "需要复核"}`
      });
      const preview = draft.draft.replace(/^#+\s*/gmu, "").replace(/\s+/gu, " ").trim();
      rowCopy.createDiv({ cls: "lifeos-review-draft-preview", text: preview.slice(0, 180) || "草稿内容为空" });
      const actions = row.createDiv({ cls: "lifeos-review-draft-actions" });
      createButton(actions, sourceChanged ? "刷新并审核" : "审核草稿", () => {
        new PeriodReviewModal(this.app, this.plugin, draft.kind, { draftPath: draft.path }).open();
      }, { primary: true, icon: sourceChanged ? "refresh-cw" : "file-check" });
      createButton(actions, "丢弃", async () => {
        if (!window.confirm(`确认丢弃 ${draft.window.start} 的待确认复盘草稿吗？草稿会保留历史状态，不会删除日记。`)) return;
        await autoReviews.setDraftStatus(draft.path, "dismissed");
        new Notice("待确认草稿已移出队列。", 4000);
        await this.render();
      }, { ghost: true, icon: "archive-x" });
    }
  }

  private async renderSummaryList(
    parent: HTMLElement,
    title: string,
    description: string,
    reviews: ReviewService,
    periodReviewService: PeriodReviewService,
    period: ReviewSummaryPeriod,
    summaries: SummaryInfo[],
    periodReviews: Array<{ basename: string; path: string }>
  ): Promise<void> {
    const card = createCard(parent, "lifeos-summary-card");
    card.createDiv({ cls: "lifeos-summary-title", text: title });
    card.createEl("p", { text: description });
    const checkedPeriodReviews = await Promise.all(periodReviews.map(async (item) => ({
      ...item,
      sourceChanged: (await periodReviewService.savedReviewSourceChanges(item.path)).length > 0
    })));
    const items = [...checkedPeriodReviews, ...summaries]
      .filter((item, index, all) => all.findIndex((candidate) => candidate.path === item.path) === index)
      .slice(0, 5);
    const actions = card.createDiv({ cls: "lifeos-summary-actions" });
    if (items.length === 0) {
      card.createDiv({ cls: "lifeos-summary-status", text: "暂时还没有内容，先从今日复盘开始。" });
      createButton(actions, this.generateLabel(period), () => this.generateSummary(period), { primary: period === "Daily", icon: "wand-2" });
      return;
    }
    createButton(actions, this.generateLabel(period), () => this.generateSummary(period), { primary: period === "Daily", icon: "wand-2" });
    createButton(actions, "查看最新", async () => {
      const file = this.app.vault.getAbstractFileByPath(items[0].path);
      if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
    }, { ghost: true, icon: "external-link" });
    const formatter = new DisplayFormatService();
    const renderedItems = await Promise.all(items.map(async (item) => {
      const file = this.app.vault.getAbstractFileByPath(item.path);
      const content = file instanceof TFile ? await this.app.vault.read(file) : "";
      const blocks = await formatter.formatReviewHighlightForDisplay(content, item.basename, item.path);
      return { item, text: blocks[0]?.text || "已有记录，可打开查看" };
    }));
    for (const { item, text } of renderedItems) {
      const row = card.createDiv({ cls: "lifeos-summary-row" });
      const copy = row.createDiv();
      copy.createDiv({ cls: "lifeos-summary-row-date", text: item.basename });
      if ("sourceChanged" in item && item.sourceChanged) {
        copy.createDiv({ cls: "lifeos-summary-row-status", text: "来源已变化，建议刷新" });
      }
      renderMarkdownDisplay(this.app, this, copy.createDiv({ cls: "lifeos-summary-row-text" }), text, item.path);
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

  private shouldRefreshForFile(file?: TAbstractFile | string): boolean {
    if (!file) return true;
    const root = normalizeVaultPath(this.plugin.getRoot());
    const path = normalizeVaultPath(typeof file === "string" ? file : file.path);
    return path === root || path.startsWith(`${root}/`);
  }

  private isCurrentRender(token: number): boolean {
    return token === this.renderToken;
  }
}

function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/").trim();
}

function formatReviewTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "未知时间";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
