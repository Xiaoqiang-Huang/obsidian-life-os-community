import { App, Component, ItemView, MarkdownRenderer, Modal, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { CALENDAR_VIEW_TYPE } from "./constants";
import type { IPlugin } from "./plugin-api";
import { formatDate } from "./utils";
import { createLifeOsShell } from "./lifeos-shell";

interface DayData {
  diary: boolean;
  checkin: boolean;
  tasks: number;
  studyTasks: number;
  date: string;
}

export class CalendarView extends ItemView {
  private year: number;
  private month: number;
  private monthData = new Map<string, DayData>();
  private rootEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private plugin: IPlugin) {
    super(leaf);
    const now = new Date();
    this.year = now.getFullYear();
    this.month = now.getMonth();
  }

  getViewType(): string { return CALENDAR_VIEW_TYPE; }
  getDisplayText(): string { return "日历"; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    const shell = container.createDiv({ cls: "pls-calendar pls-layout-main" });
    const content = createLifeOsShell(this.app, this.plugin, shell, {
      active: "calendar",
      title: "日历",
      subtitle: "按时间查看任务、日记、学习打卡与复盘痕迹",
      showDirectory: true,
      onRefresh: () => this.onOpen()
    });
    this.rootEl = content.createDiv({ cls: "pls-calendar-panel" });
    await this.render();
  }

  private async render(): Promise<void> {
    this.rootEl.empty();
    await this.gatherMonthData();

    // Card wrapper matching dashboard section aesthetic
    const card = this.rootEl.createDiv({ cls: "pls-calendar-card" });
    card.createDiv({ cls: "pls-calendar-accent" });

    this.renderHeader(card);
    this.renderGrid(card);
  }

  private pad(n: number): string { return String(n).padStart(2, "0"); }

  private async gatherMonthData(): Promise<void> {
    this.monthData.clear();
    const first = `${this.year}-${this.pad(this.month + 1)}-01`;
    const last = new Date(this.year, this.month + 1, 0);
    const lastStr = `${this.year}-${this.pad(this.month + 1)}-${this.pad(last.getDate())}`;
    const allFiles = this.app.vault.getMarkdownFiles();

    // Scan all configured daily-note locations.
    for (const f of this.plugin.listDailyNotes()) {
      const m = f.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (m && m[1] >= first && m[1] <= lastStr) {
        this.getOrCreate(m[1]).diary = true;
      }
    }

    // Scan Exam/Checkins/
    const checkinRoot = this.plugin.path("Exam", "Checkins");
    for (const f of allFiles) {
      if (!f.path.startsWith(checkinRoot)) continue;
      const m = f.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (m && m[1] >= first && m[1] <= lastStr) {
        this.getOrCreate(m[1]).checkin = true;
      }
    }

    // Scan Exam/Tasks/
    const taskRoot = this.plugin.path("Exam", "Tasks");
    for (const f of allFiles) {
      if (!f.path.startsWith(taskRoot)) continue;
      const m = f.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (m && m[1] >= first && m[1] <= lastStr) {
        this.getOrCreate(m[1]).studyTasks += 1;
      }
    }

    // Parse Tasks/open.md 📅 dates
    try {
      const openPath = this.plugin.path("Tasks", "open.md");
      const file = this.app.vault.getAbstractFileByPath(openPath);
      if (file instanceof TFile) {
        const content = await this.app.vault.read(file);
        for (const line of content.split(/\r?\n/)) {
          const m = line.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
          if (m && m[1] >= first && m[1] <= lastStr) {
            this.getOrCreate(m[1]).tasks += 1;
          }
        }
      }
    } catch { /* best effort */ }
  }

  private getOrCreate(date: string): DayData {
    let d = this.monthData.get(date);
    if (!d) { d = { date, diary: false, checkin: false, tasks: 0, studyTasks: 0 }; this.monthData.set(date, d); }
    return d;
  }

  private renderHeader(root: HTMLElement): void {
    const h = root.createDiv({ cls: "pls-calendar-header" });
    const nav = h.createDiv({ cls: "pls-calendar-nav" });
    nav.createEl("button", { text: "◀" }).onclick = () => { this.month -= 1; if (this.month < 0) { this.month = 11; this.year -= 1; } void this.render(); };
    nav.createEl("button", { text: "今天", cls: "pls-btn-primary" }).onclick = () => { const n = new Date(); this.year = n.getFullYear(); this.month = n.getMonth(); void this.render(); };
    nav.createEl("button", { text: "▶" }).onclick = () => { this.month += 1; if (this.month > 11) { this.month = 0; this.year += 1; } void this.render(); };
    h.createEl("span", { cls: "pls-calendar-title", text: `${this.year}年${this.month + 1}月` });
  }

  private renderGrid(root: HTMLElement): void {
    const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
    const grid = root.createDiv({ cls: "pls-calendar-grid" });
    for (const d of weekdays) {
      grid.createDiv({ cls: "pls-calendar-weekday", text: d });
    }

    const first = new Date(this.year, this.month, 1);
    let startDow = first.getDay() - 1;
    if (startDow < 0) startDow = 6;

    const daysInMonth = new Date(this.year, this.month + 1, 0).getDate();
    const today = formatDate();

    for (let i = 0; i < startDow; i++) {
      grid.createDiv({ cls: "pls-calendar-day pls-calendar-day-empty" });
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${this.year}-${this.pad(this.month + 1)}-${this.pad(d)}`;
      const data = this.monthData.get(dateStr);
      const isToday = dateStr === today;

      const cell = grid.createDiv({ cls: `pls-calendar-day${isToday ? " pls-calendar-day-today" : ""}${data ? " pls-calendar-day-active" : ""}` });
      cell.createDiv({ cls: "pls-calendar-day-num", text: String(d) });

      if (data) {
        const row = cell.createDiv({ cls: "pls-calendar-indicators" });
        if (data.diary) row.createSpan({ cls: "pls-calendar-dot pls-calendar-dot-diary", attr: { title: "日记" } });
        if (data.checkin) row.createSpan({ cls: "pls-calendar-dot pls-calendar-dot-checkin", attr: { title: "打卡" } });
        if (data.tasks + data.studyTasks > 0) {
          row.createSpan({ cls: "pls-calendar-task-badge", text: String(data.tasks + data.studyTasks) });
        }
      }

      cell.onclick = () => new DayDetailModal(this.app, this.plugin, dateStr, data ?? null).open();
    }
  }
}

class DayDetailModal extends Modal {
  constructor(
    app: App,
    private plugin: IPlugin,
    private date: string,
    private data: DayData | null
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("pls-modal");
    contentEl.addClass("pls-calendar-detail-modal");

    // Header
    const header = contentEl.createDiv({ cls: "pls-calendar-detail-header" });
    header.createEl("h2", { text: this.date });

    // Stats row
    const stats = contentEl.createDiv({ cls: "pls-calendar-detail-stats" });
    if (this.data) {
      if (this.data.diary) stats.createSpan({ cls: "pls-calendar-detail-stat", text: "📝 日记" });
      if (this.data.checkin) stats.createSpan({ cls: "pls-calendar-detail-stat", text: "✅ 打卡" });
      if (this.data.tasks > 0) stats.createSpan({ cls: "pls-calendar-detail-stat", text: `☐ ${this.data.tasks} 待办` });
      if (this.data.studyTasks > 0) stats.createSpan({ cls: "pls-calendar-detail-stat", text: `📚 ${this.data.studyTasks} 学习` });
    }

    // Open-file buttons
    const btnRow = contentEl.createDiv({ cls: "pls-button-row" });

    const diaryTFile = this.plugin.listDailyNotes()
      .find((file) => file.basename === this.date) ?? null;
    if (diaryTFile) {
      btnRow.createEl("button", { text: "打开日记" }).onclick = () => {
        this.close();
        void this.app.workspace.getLeaf(false).openFile(diaryTFile);
      };
    }

    const checkinPath = this.plugin.path("Exam", "Checkins", `${this.date}.md`);
    const checkinFile = this.app.vault.getAbstractFileByPath(checkinPath);
    const checkinTFile = checkinFile instanceof TFile ? checkinFile : null;
    if (checkinTFile) {
      btnRow.createEl("button", { text: "打开打卡" }).onclick = () => {
        this.close();
        void this.app.workspace.getLeaf(false).openFile(checkinTFile);
      };
    }

    const studyTaskPath = this.plugin.path("Exam", "Tasks", `${this.date}.md`);
    const studyTaskFile = this.app.vault.getAbstractFileByPath(studyTaskPath);
    if (studyTaskFile instanceof TFile) {
      btnRow.createEl("button", { text: "打开学习任务" }).onclick = () => {
        this.close();
        void this.app.workspace.getLeaf(false).openFile(studyTaskFile);
      };
    }

    // Async load content
    const comp = new Component();
    void this.loadContent(contentEl, diaryTFile, checkinTFile, comp);

    // Close button
    const closeRow = contentEl.createDiv({ cls: "pls-button-row" });
    closeRow.createEl("button", { text: "关闭" }).onclick = () => this.close();
  }

  private async loadContent(
    contentEl: HTMLElement,
    diaryFile: TFile | null,
    checkinFile: TFile | null,
    comp: Component
  ): Promise<void> {
    // Diary content
    if (diaryFile instanceof TFile) {
      const content = await this.app.vault.read(diaryFile);
      const markdown = content.replace(/^---[\s\S]*?---\n*/, "").trim();
      if (markdown) {
        const section = contentEl.createDiv({ cls: "pls-calendar-detail-section" });
        const contentArea = section.createDiv({ cls: "pls-calendar-detail-content" });
        await MarkdownRenderer.render(this.app, markdown, contentArea, diaryFile.path, comp);
      }
    } else if (!this.data || (!this.data.diary && !this.data.checkin && this.data.tasks === 0 && this.data.studyTasks === 0)) {
      contentEl.createEl("p", { text: "当日无记录", cls: "pls-muted" });
    }

    // Checkin content
    if (checkinFile instanceof TFile) {
      const checkinContent = await this.app.vault.read(checkinFile);
      const markdown = checkinContent.replace(/^---[\s\S]*?---\n*/, "").trim();
      if (markdown) {
        const section = contentEl.createDiv({ cls: "pls-calendar-detail-section" });
        section.createEl("h3", { text: "📅 学习打卡" });
        const checkinArea = section.createDiv({ cls: "pls-calendar-detail-content" });
        await MarkdownRenderer.render(this.app, markdown, checkinArea, checkinFile.path, comp);
      }
    }
  }
}
