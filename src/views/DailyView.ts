import { ItemView, Notice, TAbstractFile, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { createButton } from "../components/Button";
import { createCard } from "../components/Card";
import { createEmptyState } from "../components/EmptyState";
import { createHeroHeader } from "../components/HeroHeader";
import { createLifeOSShell } from "../components/LifeOSComponent";
import { DAILY_VIEW_TYPE } from "../constants";
import { requireProFeature } from "../licensing/entitlement";
import type PersonalLifeSystemPlugin from "../main";
import { QuickCaptureModal } from "../modals/QuickCaptureModal";
import { AiWorkspaceService } from "../services/AiWorkspaceService";
import { DailyNoteService } from "../services/DailyNoteService";
import { DisplayFormatService } from "../services/DisplayFormatService";
import { FileSystemService } from "../services/FileSystemService";
import { today } from "../utils/dates";
import { extractQuickRecordEntries, latestQuickRecord } from "../utils/quick-records";
import { renderMarkdownDisplay } from "../utils/markdown-render";
import { renderStableView } from "../utils/stable-view-refresh";

const WEEKDAYS = [
  "\u5468\u65e5",
  "\u5468\u4e00",
  "\u5468\u4e8c",
  "\u5468\u4e09",
  "\u5468\u56db",
  "\u5468\u4e94",
  "\u5468\u516d"
];

export class DailyView extends ItemView {
  private refreshTimer: number | null = null;
  private renderPromise: Promise<void> | null = null;
  private renderQueued = false;
  private renderRequestRevision = 0;
  private preserveScrollOnNextRender = true;

  constructor(leaf: WorkspaceLeaf, private plugin: PersonalLifeSystemPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return DAILY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "\u65e5\u8bb0";
  }

  async onOpen(): Promise<void> {
    await this.render(false);
    const refresh = (file: TAbstractFile): void => {
      if (this.shouldRefreshForFile(file)) this.scheduleVaultRefresh();
    };
    this.registerEvent(this.app.vault.on("create", refresh));
    this.registerEvent(this.app.vault.on("modify", refresh));
    this.registerEvent(this.app.vault.on("delete", refresh));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (this.shouldRefreshForFile(file) || this.shouldRefreshForFile(oldPath)) this.scheduleVaultRefresh();
    }));
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.renderRequestRevision += 1;
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
    const root = this.plugin.getRoot().replace(/\\/g, "/").replace(/\/+$/g, "");
    return path === root || path.startsWith(`${root}/`);
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
        await this.renderPass(revision, this.preserveScrollOnNextRender);
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
    await this.plugin.ensureBaseStructure();
    if (revision !== this.renderRequestRevision) return;
    const daily = this.dailyService();
    const date = today();
    const todayFile = this.app.vault.getAbstractFileByPath(daily.getTodayNotePath(date));
    const file = todayFile instanceof TFile ? todayFile : null;
    const exists = file instanceof TFile;

    await renderStableView(container, async (staging) => {
      const main = createLifeOSShell(staging, this.plugin, "diary");
      createHeroHeader(main, {
      kicker: "\u65e5\u8bb0",
      title: exists ? "\u4eca\u5929\u7684\u8bb0\u5f55\u5df2\u7ecf\u5f00\u59cb" : "\u5148\u4e3a\u4eca\u5929\u5f00\u4e00\u4e2a\u8bb0\u5f55\u5165\u53e3",
      description: "\u65e5\u8bb0\u4e0d\u7528\u5b8c\u6574\u3002\u5148\u7559\u4e0b\u51e0\u53e5\u8bdd\uff0c\u4efb\u52a1\u3001\u8bb0\u5fc6\u548c\u590d\u76d8\u624d\u6709\u4e0a\u4e0b\u6587\u3002",
      icon: "book-open",
      actions: [
        {
          label: exists ? "\u6253\u5f00\u4eca\u65e5\u65e5\u8bb0" : "\u521b\u5efa\u4eca\u65e5\u65e5\u8bb0",
          icon: exists ? "external-link" : "book-plus",
          primary: true,
          onClick: () => void this.createOrOpenToday()
        },
        {
          label: "\u5feb\u901f\u8bb0\u5f55",
          icon: "pencil-line",
          onClick: () => new QuickCaptureModal(this.app, this.plugin).open()
        },
        {
          label: "\u4e00\u952e\u590d\u76d8",
          icon: "wand-2",
          onClick: () => void this.generateReview()
        }
      ]
    });

    const layout = main.createDiv({ cls: "lifeos-daily-layout" });
    const leftColumn = layout.createDiv({ cls: "lifeos-daily-column lifeos-daily-column-main" });
    const rightColumn = layout.createDiv({ cls: "lifeos-daily-column lifeos-daily-column-side" });

    await this.renderTodayCard(leftColumn, exists, file);
    await this.renderProjectActivityCard(leftColumn, date);
    this.renderPromptCard(leftColumn);
    await this.renderRecent(rightColumn);
      await this.renderRecentQuickCard(rightColumn, file);
    }, {
      preserveScroll,
      isCurrent: () => revision === this.renderRequestRevision
    });
  }

  private async createOrOpenToday(): Promise<void> {
    await this.plugin.openTodayNote(false);
    new Notice("\u4eca\u65e5\u65e5\u8bb0\u5df2\u6253\u5f00\u3002", 5000);
  }

  private async renderTodayCard(parent: HTMLElement, exists: boolean, file: TFile | null): Promise<void> {
    const card = createCard(parent, "lifeos-panel lifeos-daily-today-card");
    const title = card.createDiv({ cls: "lifeos-card-title" });
    setIcon(title.createSpan(), "sun");
    title.createSpan({ text: "\u4eca\u65e5\u8bb0\u5f55" });

    if (!exists || !file) {
      createEmptyState(card, {
        icon: "book-plus",
        title: "\u8fd8\u6ca1\u6709\u4eca\u65e5\u65e5\u8bb0",
        description: "\u521b\u5efa\u540e\uff0c\u4f60\u53ef\u4ee5\u628a\u60f3\u6cd5\u3001\u884c\u52a8\u548c\u590d\u76d8\u90fd\u653e\u5230\u4eca\u5929\u3002",
        actions: [
          {
            label: "\u521b\u5efa\u4eca\u65e5\u65e5\u8bb0",
            icon: "book-plus",
            primary: true,
            onClick: () => void this.createOrOpenToday()
          },
          {
            label: "\u5feb\u901f\u8bb0\u5f55",
            icon: "pencil-line",
            onClick: () => new QuickCaptureModal(this.app, this.plugin).open()
          }
        ]
      });
      return;
    }

    const content = await this.app.vault.read(file);
    const blocks = await new DisplayFormatService().formatDailyRecordForDisplay(content, file.basename, file.path);
    const lines = blocks.map((block) => block.text);
    const quickRecords = extractQuickRecordEntries(content);
    const latestRecord = quickRecords[quickRecords.length - 1] ?? null;

    const stats = card.createDiv({ cls: "lifeos-daily-stats" });
    this.stat(stats, "\u72b6\u6001", "\u5df2\u521b\u5efa");
    this.stat(stats, "\u8bb0\u5f55\u6761\u6570", `${quickRecords.length} \u6761`);
    this.stat(stats, "\u5173\u952e\u8bcd", this.keyword(quickRecords.length > 0 ? quickRecords : lines));

    const preview = card.createDiv({ cls: "lifeos-daily-preview" });
    renderMarkdownDisplay(
      this.app,
      this,
      preview,
      latestRecord || "\u4eca\u5929\u7684\u65e5\u8bb0\u5df2\u7ecf\u521b\u5efa\uff0c\u8fd8\u53ef\u4ee5\u7ee7\u7eed\u8865\u5145\u5185\u5bb9\u3002",
      file.path
    );

    const actions = card.createDiv({ cls: "lifeos-card-actions" });
    createButton(actions, "\u6253\u5f00\u4eca\u65e5\u65e5\u8bb0", () => void this.app.workspace.getLeaf(false).openFile(file), {
      primary: true,
      icon: "book-open"
    });
    createButton(actions, "\u5feb\u901f\u8bb0\u5f55", () => new QuickCaptureModal(this.app, this.plugin).open(), {
      ghost: true,
      icon: "pencil-line"
    });
    createButton(actions, "\u4e00\u952e\u590d\u76d8", () => void this.generateReview(), {
      ghost: true,
      icon: "wand-2"
    });
    createButton(actions, "\u9ad8\u7ea7\uff1a\u6253\u5f00 Markdown \u6587\u4ef6", () => void this.app.workspace.getLeaf(false).openFile(file), {
      ghost: true,
      icon: "file-text"
    });
  }

  private async renderProjectActivityCard(parent: HTMLElement, date: string): Promise<void> {
    const service = new AiWorkspaceService(
      this.app,
      new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage),
      this.plugin.settings,
      this.plugin.ai
    );
    const state = await service.loadState();
    const pending = state.dailyFacts.filter((fact) => fact.date === date && fact.status === "pending");
    const confirmed = state.dailyFacts.filter((fact) => fact.date === date && fact.status === "confirmed");
    const card = createCard(parent, "lifeos-panel lifeos-daily-project-context-card");
    const title = card.createDiv({ cls: "lifeos-card-title" });
    setIcon(title.createSpan(), "git-branch");
    title.createSpan({ text: "\u4eca\u65e5\u9879\u76ee\u4e0a\u4e0b\u6587" });
    title.createSpan({
      cls: "lifeos-daily-project-context-count",
      text: pending.length > 0 ? `${pending.length} \u6761\u5f85\u786e\u8ba4` : `${confirmed.length} \u6761\u5df2\u5199\u5165`
    });

    const selected = new Set(pending.map((fact) => fact.id));
    if (pending.length === 0) {
      card.createEl("p", {
        cls: "lifeos-daily-project-context-empty",
        text: confirmed.length > 0
          ? "\u5df2\u786e\u8ba4\u7684\u9879\u76ee\u6d3b\u52a8\u5df2\u5199\u5165\u4eca\u65e5\u65e5\u62a5\uff0c\u4e0d\u4f1a\u8986\u76d6\u4f60\u7f16\u8f91\u7684\u6b63\u6587\u3002"
          : "\u5bfc\u5165\u5e76\u6574\u7406\u9879\u76ee\u4f1a\u8bdd\u540e\uff0c\u53ef\u786e\u8ba4\u7684\u4eca\u65e5\u6d3b\u52a8\u4f1a\u51fa\u73b0\u5728\u8fd9\u91cc\u3002"
      });
    } else {
      const list = card.createDiv({ cls: "lifeos-daily-project-context-list" });
      for (const fact of pending) {
        const label = list.createEl("label", { cls: "lifeos-daily-project-context-row" });
        const checkbox = label.createEl("input", { attr: { type: "checkbox" } });
        checkbox.checked = true;
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selected.add(fact.id);
          else selected.delete(fact.id);
        });
        const copy = label.createDiv();
        copy.createEl("strong", { text: fact.text });
        copy.createEl("span", { text: `\u6765\u81ea\u9879\u76ee\u4f1a\u8bdd \u00b7 ${fact.sourceNodeIds.length} \u4e2a\u8bc1\u636e\u8282\u70b9` });
      }
    }

    const actions = card.createDiv({ cls: "lifeos-card-actions" });
    if (pending.length > 0) {
      createButton(actions, "\u5199\u5165\u4eca\u65e5\u65e5\u62a5", () => void (async () => {
        if (selected.size === 0) {
          new Notice("\u8bf7\u5148\u9009\u62e9\u81f3\u5c11\u4e00\u6761\u9879\u76ee\u6d3b\u52a8\u3002");
          return;
        }
        if (!requireProFeature(this.plugin, "aiWriteback")) return;
        await service.confirmDailyFacts([...selected]);
        new Notice("\u5df2\u5199\u5165\u4eca\u65e5\u65e5\u62a5\uff0c\u624b\u5199\u5185\u5bb9\u4fdd\u6301\u4e0d\u53d8\u3002", 5000);
        await this.render();
      })(), { icon: "notebook-pen", primary: true });
      createButton(actions, "\u5ffd\u7565\u6240\u9009", () => void (async () => {
        if (selected.size === 0) return;
        if (!requireProFeature(this.plugin, "projectManagement")) return;
        await service.dismissDailyFacts([...selected]);
        new Notice("\u5df2\u5ffd\u7565\u6240\u9009\u9879\u76ee\u6d3b\u52a8\u3002", 4000);
        await this.render();
      })(), { icon: "eye-off", ghost: true });
    }
    createButton(actions, "\u6253\u5f00\u9879\u76ee\u4e0a\u4e0b\u6587", () => void this.plugin.activateAiWorkspace(), {
      icon: "git-branch",
      ghost: true
    });
  }

  private stat(parent: HTMLElement, label: string, value: string): void {
    const item = parent.createDiv({ cls: "lifeos-daily-stat" });
    item.createSpan({ text: label });
    item.createEl("strong", { text: value });
  }

  private keyword(lines: string[]): string {
    const tags = lines.join(" ").match(/#[^\s#]+/g);
    return tags?.[0] ?? "\u5f85\u6c89\u6dc0";
  }

  private async renderRecent(parent: HTMLElement): Promise<void> {
    const card = createCard(parent, "lifeos-panel lifeos-daily-recent-card");
    const title = card.createDiv({ cls: "lifeos-card-title" });
    setIcon(title.createSpan(), "calendar-days");
    title.createSpan({ text: "\u6700\u8fd1 7 \u5929" });

    const notes = this.dailyService().getRecentDailyNotes(7);
    if (notes.length === 0) {
      createEmptyState(card, {
        icon: "calendar",
        title: "\u8fd8\u6ca1\u6709\u5386\u53f2\u65e5\u8bb0",
        description: "\u4ece\u4eca\u5929\u5f00\u59cb\u8bb0\u5f55\uff0c\u6700\u8fd1 7 \u5929\u4f1a\u81ea\u52a8\u51fa\u73b0\u5728\u8fd9\u91cc\u3002",
        actions: [
          {
            label: "\u521b\u5efa\u4eca\u65e5\u65e5\u8bb0",
            icon: "book-plus",
            primary: true,
            onClick: () => void this.createOrOpenToday()
          }
        ],
        compact: true
      });
      return;
    }

    for (const note of notes) {
      const content = await this.app.vault.read(note);
      const date = new Date(note.basename);
      const quickRecord = latestQuickRecord(content);
      const row = card.createEl("button", { cls: "lifeos-daily-row", attr: { type: "button" } });
      const dateEl = row.createSpan({ cls: "lifeos-daily-row-date" });
      dateEl.createEl("strong", { text: note.basename.slice(5) });
      dateEl.createSpan({ text: Number.isNaN(date.getTime()) ? "" : WEEKDAYS[date.getDay()] });
      row.createSpan({ cls: "lifeos-daily-row-status", text: quickRecord ? "\u6709\u8bb0\u5f55" : "\u5df2\u521b\u5efa" });
      renderMarkdownDisplay(
        this.app,
        this,
        row.createDiv({ cls: "lifeos-daily-row-summary" }),
        quickRecord || "\u8fd8\u6ca1\u6709\u5feb\u901f\u8bb0\u5f55\uff0c\u6253\u5f00\u540e\u53ef\u4ee5\u7ee7\u7eed\u8865\u5145\u3002",
        note.path
      );
      row.onclick = () => void this.app.workspace.getLeaf(false).openFile(note);
    }
  }

  private renderPromptCard(parent: HTMLElement): void {
    const template = createCard(parent, "lifeos-panel lifeos-daily-prompt-card");
    template.createDiv({ cls: "lifeos-card-title", text: "\u4eca\u5929\u53ef\u4ee5\u8bb0\u5f55\u4ec0\u4e48" });
    const prompts = template.createDiv({ cls: "lifeos-daily-prompt-list" });
    ["\u5b8c\u6210\u7684\u4e8b", "\u60c5\u7eea\u53d8\u5316", "\u660e\u5929\u7ee7\u7eed\u4ec0\u4e48"].forEach((text) => prompts.createDiv({ text }));
  }

  private async renderRecentQuickCard(parent: HTMLElement, file: TFile | null): Promise<void> {
    const quick = createCard(parent, "lifeos-panel lifeos-daily-quick-card");
    quick.createDiv({ cls: "lifeos-card-title", text: "\u6700\u8fd1\u5feb\u901f\u8bb0\u5f55" });

    if (!file) {
      createEmptyState(quick, {
        icon: "pencil-line",
        title: "\u8fd8\u6ca1\u6709\u5feb\u901f\u8bb0\u5f55",
        description: "\u968f\u624b\u8bb0\u4e0b\u4e00\u53e5\u8bdd\uff0c\u5b83\u4f1a\u81ea\u52a8\u5199\u5165\u4eca\u65e5\u65e5\u8bb0\u3002",
        actions: [
          {
            label: "\u5feb\u901f\u8bb0\u5f55",
            icon: "pencil-line",
            primary: true,
            onClick: () => new QuickCaptureModal(this.app, this.plugin).open()
          }
        ],
        compact: true
      });
      return;
    }

    const records = await this.recentQuickRecords(file);
    if (records.length === 0) {
      quick.createEl("p", { cls: "lifeos-muted-text", text: "\u8fd8\u6ca1\u6709\u53ef\u5c55\u793a\u7684\u5feb\u901f\u8bb0\u5f55\u3002" });
      return;
    }

    for (const record of records) {
      const row = quick.createEl("button", { cls: "lifeos-note-line lifeos-daily-quick-row", attr: { type: "button" } });
      const copy = row.createDiv({ cls: "lifeos-daily-quick-copy" });
      renderMarkdownDisplay(this.app, this, copy.createDiv({ cls: "lifeos-daily-quick-summary" }), record.text, record.file.path);
      const meta = row.createDiv({ cls: "lifeos-daily-quick-side" });
      meta.createSpan({ cls: "lifeos-daily-quick-meta", text: record.date });
      meta.createSpan({ cls: "lifeos-daily-quick-open", text: "\u6253\u5f00" });
      row.onclick = () => void this.app.workspace.getLeaf(false).openFile(record.file);
    }
  }

  private async recentQuickRecords(todayFile: TFile): Promise<Array<{ text: string; date: string; file: TFile }>> {
    const notes = [todayFile, ...this.dailyService().getRecentDailyNotes(7).filter((note) => note.path !== todayFile.path)];
    const records: Array<{ text: string; date: string; file: TFile }> = [];
    for (const note of notes) {
      const content = await this.app.vault.read(note);
      const quickRecords = extractQuickRecordEntries(content).reverse();
      for (const text of quickRecords) {
        records.push({ text, date: note.basename, file: note });
        if (records.length >= 4) return records;
      }
    }
    return records;
  }

  private async generateReview(): Promise<void> {
    await this.plugin.generateReport("daily");
  }

  private dailyService(): DailyNoteService {
    return new DailyNoteService(this.app, new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage), this.plugin.settings);
  }
}
