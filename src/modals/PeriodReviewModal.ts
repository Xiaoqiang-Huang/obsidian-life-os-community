import { App, Component, Modal, Notice, TFile } from "obsidian";
import { createButton } from "../components/Button";
import { createModalShell } from "../components/ModalShell";
import type { IPlugin } from "../plugin-api";
import { DailyNoteService } from "../services/DailyNoteService";
import { FileSystemService } from "../services/FileSystemService";
import { AutoReviewService } from "../services/AutoReviewService";
import {
  PeriodReviewService,
  type PeriodReviewFacts,
  type PeriodReviewKind,
  type PeriodReviewWindow,
  type PeriodReviewGenerationResult
} from "../services/PeriodReviewService";
import type { ReviewQualityReport } from "../services/ReviewQualityService";
import { formatDate } from "../utils/dates";
import { renderMarkdownDisplay } from "../utils/markdown-render";

export class PeriodReviewModal extends Modal {
  private readonly service: PeriodReviewService;
  private readonly autoReviews: AutoReviewService;
  private kind: PeriodReviewKind;
  private window: PeriodReviewWindow;
  private facts: PeriodReviewFacts | null = null;
  private selectedPaths = new Set<string>();
  private sourceState: Array<{ path: string; hash: string; mtime: number }> = [];
  private draft = "";
  private userNotes = "";
  private draftEdited = false;
  private previousDrafts: string[] = [];
  private quality: ReviewQualityReport | null = null;
  private draftMode: "preview" | "edit" = "preview";
  private instruction = "";
  private refreshToken = 0;
  private readonly markdownComponent = new Component();
  private draftPath = "";
  private draftSourceHash = "";
  private draftStatus: "pending" | "stale" | "saved" | "dismissed" = "pending";

  constructor(
    app: App,
    private plugin: IPlugin,
    initialKind: PeriodReviewKind,
    private options: { draftPath?: string } = {}
  ) {
    super(app);
    this.kind = initialKind;
    this.service = new PeriodReviewService(
      app,
      new FileSystemService(app, plugin.getRoot(), plugin.settings.directoryLanguage),
      plugin.settings
    );
    this.autoReviews = new AutoReviewService(
      app,
      new FileSystemService(app, plugin.getRoot(), plugin.settings.directoryLanguage),
      plugin.settings,
      plugin.ai
    );
    this.window = initialKind === "custom"
      ? this.service.windowFor("weekly")
      : this.service.windowFor(initialKind);
  }

  onOpen(): void {
    this.markdownComponent.load();
    this.modalEl.addClass("lifeos-modal-host", "lifeos-period-review-modal-host");
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    if (this.options.draftPath) {
      const draft = await this.autoReviews.readDraft(this.options.draftPath);
      if (!draft) {
        new Notice("待确认复盘草稿已不存在。", 6000);
        this.close();
        return;
      }
      this.draftPath = draft.path;
      this.draftSourceHash = draft.sourceHash;
      this.draftStatus = draft.status;
      this.kind = draft.kind;
      this.window = draft.window;
      this.draft = draft.draft;
      this.userNotes = draft.userNotes;
    }
    await this.refreshFacts(true);
  }

  private async refreshFacts(resetSelection = false): Promise<void> {
    const token = ++this.refreshToken;
    const error = this.service.validateWindow(this.window);
    if (error) {
      new Notice(error);
      return;
    }
    this.renderLoading();
    try {
      const preview = await this.service.collectFacts(this.kind, this.window);
      if (token !== this.refreshToken) return;
      const available = new Set(preview.allCandidates.map((item) => item.path));
      if (resetSelection || this.selectedPaths.size === 0 || !Array.from(this.selectedPaths).some((path) => available.has(path))) {
        this.selectedPaths = this.service.defaultSelectedPaths(preview.allCandidates);
      } else {
        this.selectedPaths = new Set(Array.from(this.selectedPaths).filter((path) => available.has(path)));
      }
      this.facts = await this.service.collectFacts(this.kind, this.window, this.selectedPaths);
      if (token !== this.refreshToken) return;
      this.sourceState = this.service.sourceStates(this.facts);
      if (this.draft.trim()) this.quality = this.service.validateDraft(this.draft, this.facts);
      this.render();
    } catch (error) {
      if (token !== this.refreshToken) return;
      this.contentEl.empty();
      this.contentEl.createEl("p", { text: error instanceof Error ? error.message : "读取复盘资料失败。" });
    }
  }

  private renderLoading(): void {
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: "lifeos-period-review-loading", text: "正在整理已确认的日报、任务和打卡资料…" });
  }

  private render(): void {
    const facts = this.facts;
    if (!facts) return;
    const { body, footer } = createModalShell(this.contentEl, {
      title: this.draftPath ? "待确认复盘草稿" : "周期复盘工作台",
      subtitle: this.draftPath
        ? `当前草稿状态：${this.draftStatus === "stale" || this.draftSourceHash !== facts.sourceHash ? "来源已变化" : "等待确认"}。可编辑、刷新或保存为正式版本。`
        : `当前为${this.kindLabel()}。先确认事实来源，再让 AI 生成；日报原文不会被 AI 改写。`,
      icon: "calendar-range",
      className: "lifeos-period-review-modal"
    });
    body.addClass("lifeos-period-review-body");
    this.renderRange(body);
    this.renderFacts(body, facts);
    this.renderSources(body, facts);
    this.renderDraft(body);

    const actions = footer.createDiv({ cls: "lifeos-toolbar lifeos-period-review-footer" });
    createButton(actions, "取消", () => this.close(), { ghost: true });
    if (this.draft.trim()) {
      if (this.draftPath) {
        createButton(actions, "仅保存草稿", () => void this.savePendingDraft(), { ghost: true, icon: "save" });
        createButton(actions, "保存为正式复盘", () => void this.save(), { primary: true, icon: "badge-check" });
      } else {
        createButton(actions, "保存为新版本", () => void this.save(), { primary: true, icon: "save" });
      }
    } else {
      createButton(actions, "生成复盘草稿", () => void this.generate(), {
        primary: true,
        icon: "sparkles",
        className: "lifeos-period-review-primary-action"
      });
    }
  }

  private renderRange(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "lifeos-period-review-section" });
    section.createEl("h3", { text: "统计范围" });
    const presets = section.createDiv({ cls: "lifeos-period-review-presets" });
    const addPreset = (label: string, kind: Exclude<PeriodReviewKind, "custom">, reference?: Date) => {
      createButton(presets, label, () => {
        this.kind = kind;
        this.window = this.service.windowFor(kind, reference ? formatDate(reference) : formatDate());
        this.archiveAndResetDraft();
        void this.refreshFacts(true);
      }, { ghost: this.kind !== kind });
    };
    addPreset("今天", "daily");
    addPreset("本周", "weekly");
    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);
    addPreset("上周", "weekly", lastWeek);
    addPreset("本月", "monthly");
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    addPreset("上月", "monthly", lastMonth);

    const fields = section.createDiv({ cls: "lifeos-period-review-date-fields" });
    const start = this.dateField(fields, "开始日期", this.window.start);
    const end = this.dateField(fields, "结束日期", this.window.end);
    const apply = () => {
      start.value = this.normalizeDateInput(start.value);
      end.value = this.normalizeDateInput(end.value);
      this.kind = "custom";
      this.window = { start: start.value, end: end.value };
      this.archiveAndResetDraft();
      void this.refreshFacts(false);
    };
    start.onchange = apply;
    end.onchange = apply;
  }

  private dateField(parent: HTMLElement, label: string, value: string): HTMLInputElement {
    const field = parent.createEl("label", { cls: "lifeos-period-review-date-field" });
    field.createSpan({ text: label });
    const input = field.createEl("input", {
      cls: "lifeos-input lifeos-period-review-date-input",
      attr: {
        type: "text",
        inputmode: "numeric",
        maxlength: "10",
        placeholder: "YYYY-MM-DD",
        "aria-label": label
      }
    }) as HTMLInputElement;
    input.value = value;
    return input;
  }

  private normalizeDateInput(value: string): string {
    const compact = value.trim();
    const match = compact.match(/^(\d{4})[\-/.](\d{1,2})[\-/.](\d{1,2})$/);
    if (!match) return compact;
    const [, year, month, day] = match;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  private renderFacts(parent: HTMLElement, facts: PeriodReviewFacts): void {
    const section = parent.createDiv({ cls: "lifeos-period-review-section lifeos-period-review-facts" });
    section.createEl("h3", { text: "已确认事实快照" });
    const grid = section.createDiv({ cls: "lifeos-period-review-fact-grid" });
    const addFact = (label: string, value: string) => {
      const item = grid.createDiv({ cls: "lifeos-period-review-fact" });
      item.createSpan({ text: label });
      item.createEl("strong", { text: value });
    };
    addFact("范围天数", `${this.daysInWindow()} 天`);
    addFact("纳入日报", `${facts.sources.length} 篇`);
    addFact("完成任务", `${facts.completedTasks.length} 项`);
    addFact("学习打卡", `${facts.checkins.length} 次`);
    addFact("确认项目活动", `${facts.confirmedProjectActivities.length} 条`);
    if (facts.missingDates.length > 0) {
      section.createDiv({
        cls: "lifeos-period-review-warning",
        text: `缺少 ${facts.missingDates.length} 天日报：${facts.missingDates.join("、")}`
      });
    } else {
      section.createDiv({
        cls: "lifeos-period-review-confirmed",
        text: "日报、任务和打卡来源已整理，可直接生成复盘草稿。"
      });
    }
    if (facts.checkins.some((item) => item.tasksCompleted > 0) && facts.completedTasks.length > 0) {
      section.createDiv({ cls: "lifeos-period-review-note", text: "打卡中的“完成任务”是自填指标，未与任务系统相加，避免重复统计。" });
    }
    if (facts.pendingProjectActivities.length > 0) {
      const pending = section.createEl("details", { cls: "lifeos-period-review-pending-evidence" });
      pending.createEl("summary", { text: `${facts.pendingProjectActivities.length} 条项目活动仍待确认（仅预览，不进入事实包）` });
      const list = pending.createEl("ul");
      for (const item of facts.pendingProjectActivities.slice(0, 8)) {
        list.createEl("li", { text: `${item.date} · ${item.sessionTitle}：${item.text}` });
      }
    }
  }

  private renderSources(parent: HTMLElement, facts: PeriodReviewFacts): void {
    const section = parent.createDiv({ cls: "lifeos-period-review-section" });
    const heading = section.createDiv({ cls: "lifeos-card-heading-row" });
    heading.createEl("h3", { text: "纳入日报" });
    createButton(heading, "刷新来源", () => void this.refreshFacts(false), { ghost: true, icon: "refresh-cw" });
    const list = section.createDiv({ cls: "lifeos-period-review-source-list" });
    if (facts.allCandidates.length === 0) {
      const empty = list.createDiv({ cls: "lifeos-period-review-empty-state" });
      empty.createEl("strong", { text: "这个范围内还没有可纳入的日报" });
      empty.createDiv({
        cls: "lifeos-muted",
        text: "补充日报后，复盘会以你的原始记录为主线；未补充时会仅依据任务和打卡事实。"
      });
      const actions = empty.createDiv({ cls: "lifeos-period-review-empty-actions" });
      if (this.daysInWindow() === 1) {
        createButton(actions, "创建并打开日报", () => void this.createDailyNote(), { ghost: true, icon: "book-open" });
      }
      return;
    }
    section.createEl("p", { cls: "lifeos-muted", text: "同一天有多份日报时默认选最新一份；可切换，但同一天只能纳入一份。" });
    for (const source of facts.allCandidates) {
      const row = list.createDiv({ cls: "lifeos-period-review-source" });
      const checkbox = row.createEl("input", { attr: { type: "checkbox", "aria-label": `纳入 ${source.path}` } }) as HTMLInputElement;
      checkbox.checked = this.selectedPaths.has(source.path);
      checkbox.onchange = () => {
        if (checkbox.checked) {
          for (const candidate of facts.allCandidates.filter((item) => item.date === source.date)) this.selectedPaths.delete(candidate.path);
          this.selectedPaths.add(source.path);
        } else {
          this.selectedPaths.delete(source.path);
        }
        this.archiveAndResetDraft();
        void this.refreshFacts(false);
      };
      const copy = row.createDiv();
      copy.createEl("strong", { text: source.date });
      copy.createDiv({ cls: "lifeos-muted", text: source.path });
      if (source.duplicate) copy.createSpan({ cls: "lifeos-badge", text: "同日重复" });
      const preview = source.cleanContent.replace(/\s+/g, " ").slice(0, 150) || "未识别到已填写正文";
      copy.createDiv({ cls: "lifeos-period-review-source-preview", text: preview });
      createButton(row, "打开", async () => {
        const file = this.app.vault.getAbstractFileByPath(source.path);
        if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
      }, { ghost: true, icon: "external-link" });
    }
  }

  private renderDraft(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "lifeos-period-review-section lifeos-period-review-draft" });
    section.createEl("h3", { text: "AI 复盘草稿（待确认）" });
    section.createEl("p", { cls: "lifeos-muted", text: "AI 区、用户补充和事实快照彼此隔离。重新生成只更新 AI 区；保存时总会新建正式版本。" });
    const userNotes = section.createEl("textarea", {
      cls: "lifeos-input lifeos-period-review-user-notes",
      attr: { placeholder: "用户补充（可选）：写下只属于这份复盘的判断、背景或提醒。AI 重新生成不会覆盖这里。" }
    }) as HTMLTextAreaElement;
    userNotes.value = this.userNotes;
    userNotes.rows = 3;
    userNotes.oninput = () => { this.userNotes = userNotes.value; };
    if (this.draftPath && (this.draftStatus === "stale" || (this.facts && this.draftSourceHash !== this.facts.sourceHash))) {
      section.createDiv({
        cls: "lifeos-period-review-warning",
        text: "这份草稿生成后，事实来源又发生了变化。旧内容仍保留，但必须手动重新生成后才能保存为正式复盘。"
      });
    }
    const instruction = section.createEl("textarea", {
      cls: "lifeos-input",
      attr: { placeholder: "可选：例如重点分析学习节奏，不分析情绪。" }
    }) as HTMLTextAreaElement;
    instruction.value = this.instruction;
    instruction.rows = 2;
    instruction.oninput = () => { this.instruction = instruction.value; };

    const actions = section.createDiv({ cls: "lifeos-period-review-draft-actions" });
    if (this.draft.trim()) {
      const modes = actions.createDiv({ cls: "lifeos-period-review-mode-toggle" });
      createButton(modes, "预览", () => {
        this.draftMode = "preview";
        this.render();
      }, { primary: this.draftMode === "preview", className: "lifeos-period-review-mode-button" });
      createButton(modes, "编辑", () => {
        this.draftMode = "edit";
        this.render();
      }, { primary: this.draftMode === "edit", className: "lifeos-period-review-mode-button" });
      createButton(actions, "重新生成完整草稿", () => void this.generate(), { primary: true, icon: "refresh-cw" });
      for (const name of this.service.draftSections(this.facts!)) {
        createButton(actions, `重生成${name}`, () => void this.generate(name), { ghost: true, icon: "refresh-cw" });
      }
      if (this.previousDrafts.length > 0) {
        createButton(actions, `恢复上一版（${this.previousDrafts.length}）`, () => {
          const previous = this.previousDrafts.pop();
          if (!previous) return;
          this.draft = previous;
          this.draftEdited = true;
          this.quality = this.facts ? this.service.validateDraft(this.draft, this.facts) : null;
          this.render();
        }, { ghost: true, icon: "history" });
      }
    }
    this.renderQuality(section);
    if (this.draft.trim() && this.draftMode === "preview") {
      renderMarkdownDisplay(
        this.app,
        this.markdownComponent,
        section.createDiv({ cls: "lifeos-period-review-draft-preview" }),
        this.draft
      );
      return;
    }
    const draft = section.createEl("textarea", {
      cls: "lifeos-input lifeos-period-review-draft-input",
      attr: { placeholder: "确认来源后生成草稿。你可以直接编辑草稿，再保存为新的复盘版本。" }
    }) as HTMLTextAreaElement;
    draft.value = this.draft;
    draft.rows = 20;
    draft.oninput = () => {
      this.draft = draft.value;
      this.draftEdited = true;
      this.quality = this.facts ? this.service.validateDraft(this.draft, this.facts) : null;
    };
  }

  onClose(): void {
    this.markdownComponent.unload();
    this.contentEl.empty();
  }

  private async generate(section?: string): Promise<void> {
    const facts = this.facts;
    if (!facts) return;
    const changed = await this.service.factsSourceChanges(facts);
    if (changed.length > 0) {
      new Notice(`来源已变化，请先刷新来源：${changed.slice(0, 2).join("、")}`, 7000);
      return;
    }
    if (this.draftEdited && this.draft.trim()) {
      const confirmed = window.confirm("当前 AI 草稿包含手动编辑。继续重新生成会替换 AI 区，但会保留为上一版，用户补充和事实快照不受影响。确认继续吗？");
      if (!confirmed) return;
      this.previousDrafts.push(this.draft);
    } else if (this.draft.trim()) {
      this.previousDrafts.push(this.draft);
    }
    try {
      new Notice(section ? `正在重生成${section}…` : "正在生成周期复盘草稿…", 5000);
      const generated: PeriodReviewGenerationResult = await this.service.generateDraftWithQuality(this.plugin.ai, facts, this.instruction, section);
      this.draft = section && this.draft.trim()
        ? this.service.replaceDraftSection(this.draft, section, generated.draft)
        : generated.draft;
      this.quality = section ? this.service.validateDraft(this.draft, facts) : generated.quality;
      this.draftSourceHash = facts.sourceHash;
      this.draftStatus = "pending";
      this.draftEdited = false;
      this.draftMode = "preview";
      this.render();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "AI 生成失败。", 7000);
    }
  }

  private async save(): Promise<void> {
    const facts = this.facts;
    if (!facts || !this.draft.trim()) {
      new Notice("请先生成或填写 AI 复盘草稿。", 5000);
      return;
    }
    const changed = await this.service.factsSourceChanges(facts);
    if (changed.length > 0) {
      new Notice(`来源已变化，请先刷新来源再保存：${changed.slice(0, 2).join("、")}`, 7000);
      return;
    }
    const quality = this.service.validateDraft(this.draft, facts);
    this.quality = quality;
    if (!quality.ok) {
      this.draftMode = "edit";
      this.render();
      new Notice(`草稿尚未通过质量检查：${quality.errors[0] ?? "请检查结构和来源"}`, 8000);
      return;
    }
    let file: TFile;
    if (this.draftPath) {
      if (this.draftSourceHash !== facts.sourceHash) {
        new Notice("来源已变化，请先重新生成草稿，再保存为正式复盘。", 8000);
        return;
      }
      await this.autoReviews.refreshDraft(this.draftPath, facts, this.draft, this.userNotes, quality, this.instruction);
      file = await this.autoReviews.promoteDraft(this.draftPath, this.draft, this.userNotes, this.instruction, facts);
    } else {
      file = await this.service.saveReview(facts, this.draft, this.instruction, this.userNotes);
    }
    await this.app.workspace.getLeaf(false).openFile(file);
    new Notice(`复盘已保存：${file.basename}`, 6000);
    this.close();
  }

  private async savePendingDraft(): Promise<void> {
    const facts = this.facts;
    if (!facts || !this.draftPath || !this.draft.trim()) return;
    const quality = this.service.validateDraft(this.draft, facts);
    if (this.draftSourceHash === facts.sourceHash) {
      await this.autoReviews.refreshDraft(this.draftPath, facts, this.draft, this.userNotes, quality, this.instruction);
      this.draftStatus = "pending";
    } else {
      await this.autoReviews.updateDraft(this.draftPath, this.draft, this.userNotes);
      await this.autoReviews.setDraftStatus(this.draftPath, "stale");
      this.draftStatus = "stale";
    }
    this.draftEdited = false;
    new Notice(this.draftStatus === "stale" ? "编辑已保存，但草稿来源仍已过期。" : "待确认草稿已保存。", 5000);
    this.render();
  }

  private async createDailyNote(): Promise<void> {
    const dailyNotes = new DailyNoteService(
      this.app,
      new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage),
      this.plugin.settings
    );
    const file = await dailyNotes.ensureTodayNote(this.window.start, false);
    await this.app.workspace.getLeaf(false).openFile(file);
    this.close();
  }

  private kindLabel(): string {
    if (this.kind === "daily") return "日复盘";
    if (this.kind === "weekly") return "周复盘";
    if (this.kind === "monthly") return "月复盘";
    return "自定义周期复盘";
  }

  private daysInWindow(): number {
    const start = new Date(`${this.window.start}T12:00:00`);
    const end = new Date(`${this.window.end}T12:00:00`);
    return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  }

  private archiveAndResetDraft(): void {
    if (this.draft.trim()) this.previousDrafts.push(this.draft);
    this.draft = "";
    this.draftEdited = false;
    this.quality = null;
  }

  private renderQuality(parent: HTMLElement): void {
    if (!this.quality || !this.draft.trim()) return;
    const card = parent.createDiv({
      cls: `lifeos-period-review-quality ${this.quality.ok ? "is-pass" : "is-warning"}`
    });
    const heading = card.createDiv({ cls: "lifeos-card-heading-row" });
    heading.createEl("strong", { text: this.quality.ok ? "质量检查通过" : "草稿仍需确认" });
    heading.createSpan({ text: `${this.quality.score} 分 · 引用覆盖 ${Math.round(this.quality.citationCoverage * 100)}%` });
    const issues = [...this.quality.errors, ...this.quality.warnings];
    if (issues.length > 0) {
      const list = card.createEl("ul");
      for (const issue of issues.slice(0, 6)) list.createEl("li", { text: issue });
    }
  }
}
