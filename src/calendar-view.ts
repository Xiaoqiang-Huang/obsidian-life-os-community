import { LifeOSModal as Modal } from "./components/LifeOSModal";
import { App, Component, ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { CALENDAR_VIEW_TYPE } from "./constants";
import type { IPlugin } from "./plugin-api";
import { formatDate } from "./utils";
import { createLifeOSShell } from "./components/LifeOSComponent";
import { createHeroHeader } from "./components/HeroHeader";
import type PersonalLifeSystemPlugin from "./main";
import { renderMarkdownDisplay } from "./utils/markdown-render";
import { renderStableView } from "./utils/stable-view-refresh";

import { DailyNoteService } from './services/DailyNoteService';
import { FileSystemService } from './services/FileSystemService';
import { parseTaskLine } from './utils/markdown';

interface DayData {
  reviewPath?: string;
  completedTasks: number;
  taskItems: Array<{ text: string; done: boolean; path: string }>;
  diary: boolean;
  checkin: boolean;
  tasks: number;
  studyTasks: number;
  date: string;
}

export class CalendarView extends ItemView {
  private year: number;
  private month: number;
  private selectedDate = formatDate();
  private dataWarnings: string[] = [];
  private monthData = new Map<string, DayData>();
  private rootEl!: HTMLElement;
  private renderPromise: Promise<void> | null = null;
  private renderQueued = false;
  private renderRequestRevision = 0;

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
    const shell = container.createDiv({ cls: "lifeos-calendar-host" });
    const content = createLifeOSShell(shell, this.plugin as PersonalLifeSystemPlugin, "calendar");
    createHeroHeader(content, {
        app: this.app,
      kicker: "日记与回顾",
      title: "日历",
      description: "按时间查看任务、日记、打卡与回顾。",
      actions: [{ label: "日记与回顾", onClick: () => void (this.plugin as PersonalLifeSystemPlugin).activateDaily(), icon: "book-open" }]
    });
    this.rootEl = content.createDiv({ cls: "pls-calendar-panel" });
    await this.render(false);
  }

  async onClose(): Promise<void> {
    this.renderQueued = false;
    this.renderRequestRevision += 1;
  }

  private async render(preserveScroll = true): Promise<void> {
    this.renderRequestRevision += 1;
    this.renderQueued = true;
    if (this.renderPromise) return this.renderPromise;

    const run = async (): Promise<void> => {
      while (this.renderQueued) {
        this.renderQueued = false;
        const revision = this.renderRequestRevision;
        await this.renderPass(revision, preserveScroll);
      }
    };
    this.renderPromise = run().finally(() => {
      this.renderPromise = null;
    });
    return this.renderPromise;
  }

  private async renderPass(revision: number, preserveScroll: boolean): Promise<void> {
    await this.gatherMonthData();
    if (revision !== this.renderRequestRevision || !this.rootEl?.isConnected) return;

    await renderStableView(this.rootEl, (staging) => {
      // Card wrapper matching dashboard section aesthetic
      const card = staging.createDiv({ cls: "pls-calendar-card" });
      card.createDiv({ cls: "pls-calendar-accent" });

      this.renderHeader(card);
      this.renderGrid(card);
      this.renderAgenda(card);
    }, {
      preserveScroll,
      isCurrent: () => revision === this.renderRequestRevision && this.rootEl.isConnected
    });
  }

  private pad(n: number): string { return String(n).padStart(2, "0"); }

  private async gatherMonthData(): Promise<void> {
    this.monthData.clear();
    this.dataWarnings = [];
    const first = `${String(this.year).padStart(4, '0')}-${this.pad(this.month + 1)}-01`;
    const last = new Date(this.year, this.month + 1, 0);
    const lastStr = `${String(this.year).padStart(4, '0')}-${this.pad(this.month + 1)}-${this.pad(last.getDate())}`;
    const allFiles = this.app.vault.getMarkdownFiles();

    // Scan all configured daily-note locations.
    for (const f of this.plugin.listDailyNotes()) {
      const m = f.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (m && m[1] >= first && m[1] <= lastStr) {
        this.getOrCreate(m[1]).diary = true;
      }
    }

    const reviewRoot = this.plugin.path('Memory', 'Summaries', 'Daily') + '/';
    for (const file of allFiles) {
      if (!file.path.startsWith(reviewRoot)) continue;
      const date = file.basename;
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date >= first && date <= lastStr) this.getOrCreate(date).reviewPath = file.path;
    }

    // Scan Exam/Checkins/
    const checkinRoot = this.plugin.path("Exam", "Checkins");
    for (const f of allFiles) {
      if (!f.path.startsWith(`${checkinRoot}/`)) continue;
      const m = f.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (m && m[1] >= first && m[1] <= lastStr) {
        this.getOrCreate(m[1]).checkin = true;
      }
    }

    // Scan Exam/Tasks/
    const taskRoot = this.plugin.path("Exam", "Tasks");
    for (const f of allFiles) {
      if (!f.path.startsWith(`${taskRoot}/`)) continue;
      const m = f.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (m && m[1] >= first && m[1] <= lastStr) {
        this.getOrCreate(m[1]).studyTasks += 1;
      }
    }

    // Use only real checkbox tasks, with completion dates for the archive.
    for (const source of ['open', 'done'] as const) {
      const taskPath = this.plugin.path('Tasks', source + '.md');
      const file = this.app.vault.getAbstractFileByPath(taskPath);
      if (!(file instanceof TFile)) continue;
      try {
        const content = await this.app.vault.read(file);
        for (const line of content.split(/\r?\n/)) {
          const task = parseTaskLine(line, source);
          if (!task) continue;
          const done = task.isDone || source === 'done';
          const date = (done ? line.match(/✅\s*(\d{4}-\d{2}-\d{2})/) : line.match(/📅\s*(\d{4}-\d{2}-\d{2})/))?.[1]
            || (!done && /\blane:today\b/.test(line) ? formatDate() : '');
          if (date < first || date > lastStr) continue;
          const day = this.getOrCreate(date);
          if (done) day.completedTasks++; else day.tasks++;
          day.taskItems.push({ text: task.text, done, path: taskPath });
        }
      } catch { this.dataWarnings.push(source === 'open' ? '待办读取失败' : '已完成任务读取失败'); }
    }
  }

  private getOrCreate(date: string): DayData {
    let d = this.monthData.get(date);
    if (!d) { d = { date, diary: false, checkin: false, tasks: 0, completedTasks: 0, taskItems: [], studyTasks: 0 }; this.monthData.set(date, d); }
    return d;
  }

  private async selectDate(value: string, focus = false): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    if (year < 100 || year > 9999 || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return;
    this.year = year; this.month = month - 1; this.selectedDate = value;
    await this.render();
    if (focus && this.selectedDate === value) this.rootEl.querySelector<HTMLButtonElement>('[data-date="' + value + '"]')?.focus();
  }

  private dateInMonth(year: number, month: number): string {
    const day = Math.min(Number(this.selectedDate.slice(8)), new Date(year, month + 1, 0).getDate());
    return String(year).padStart(4, '0') + '-' + this.pad(month + 1) + '-' + this.pad(day);
  }

  private async changeMonth(delta: number, focusSelector?: string): Promise<void> {
    const date = new Date(this.year, this.month + delta, 1);
    if (date.getFullYear() < 100 || date.getFullYear() > 9999) return;
    const value = this.dateInMonth(date.getFullYear(), date.getMonth());
    await this.selectDate(value, !focusSelector);
    if (focusSelector && this.selectedDate === value) this.rootEl.querySelector<HTMLElement>(focusSelector)?.focus();
  }

  private renderHeader(root: HTMLElement): void {
    const h = root.createDiv({ cls: 'pls-calendar-header' });
    const nav = h.createDiv({ cls: 'pls-calendar-nav' });
    const previousMonth = nav.createEl('button', { text: '◀', attr: { type: 'button', 'aria-label': '上个月', 'data-lifeos-focus-key': 'calendar-previous-month' } });
    previousMonth.disabled = this.year === 100 && this.month === 0;
    previousMonth.onclick = () => void this.changeMonth(-1, '[data-lifeos-focus-key="calendar-previous-month"]');
    nav.createEl('button', { text: '今天', attr: { type: 'button' } }).onclick = () => void this.selectDate(formatDate(), true);
    const nextMonth = nav.createEl('button', { text: '▶', attr: { type: 'button', 'aria-label': '下个月', 'data-lifeos-focus-key': 'calendar-next-month' } });
    nextMonth.disabled = this.year === 9999 && this.month === 11;
    nextMonth.onclick = () => void this.changeMonth(1, '[data-lifeos-focus-key="calendar-next-month"]');
    h.createEl('strong', { cls: 'pls-calendar-title', text: this.year + '年' + (this.month + 1) + '月' });
    const toggle = h.createEl('button', { cls: 'pls-calendar-month-toggle', text: '选择年月', attr: { type: 'button', 'aria-expanded': 'false', 'data-lifeos-focus-key': 'calendar-month-picker' } });
    const picker = root.createDiv({ cls: 'pls-calendar-month-picker' });
    picker.hidden = true;
    toggle.onclick = () => {
      picker.hidden = !picker.hidden;
      toggle.setAttribute('aria-expanded', String(!picker.hidden));
      if (!picker.hidden) year.focus();
    };
    const panel = picker.createDiv({ cls: 'pls-calendar-month-picker-panel' });
    const controls = panel.createDiv({ cls: 'pls-calendar-year-controls' });
    const previous = controls.createEl('button', { text: '上一年', attr: { type: 'button' } });
    const yearLabel = controls.createEl('label', { text: '年份' });
    const year = yearLabel.createEl('input', { attr: { type: 'number', min: '100', max: '9999', step: '1', 'aria-label': '选择年份' } });
    year.value = String(this.year);
    const next = controls.createEl('button', { text: '下一年', attr: { type: 'button' } });
    const applyYear = controls.createEl('button', { text: '跳转', attr: { type: 'button', 'aria-label': '跳转到输入年份的当前月份' } });
    panel.createEl('p', { cls: 'pls-calendar-month-picker-hint', text: '输入年份后按 Enter 或点“跳转”；也可以直接选择下方月份。' });
    const months = panel.createDiv({ cls: 'pls-calendar-month-options', attr: { role: 'group', 'aria-label': '选择月份' } });
    const error = panel.createDiv({ cls: 'pls-calendar-month-picker-error', attr: { role: 'status' } });
    error.hidden = true;
    const readYear = (): number | null => {
      const value = Number(year.value);
      const valid = /^\d{3,4}$/.test(year.value) && Number.isInteger(value) && value >= 100 && value <= 9999;
      year.setAttribute('aria-invalid', String(!valid));
      error.hidden = valid;
      error.textContent = valid ? '' : '请输入 100–9999 之间的完整年份，再选择月份。';
      return valid ? value : null;
    };
    const syncYear = () => {
      const value = readYear();
      previous.disabled = value === null || value <= 100;
      next.disabled = value === null || value >= 9999;
      applyYear.disabled = value === null;
      months.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
        button.setAttribute('aria-pressed', String(value === this.year && Number(button.dataset.month) === this.month));
      });
    };
    year.oninput = syncYear;
    year.onchange = syncYear;
    const commitYear = async () => {
      const value = readYear();
      if (value === null) { year.focus(); return; }
      await this.selectDate(this.dateInMonth(value, this.month));
      this.rootEl.querySelector<HTMLElement>('.pls-calendar-month-toggle')?.focus();
    };
    applyYear.onclick = () => void commitYear();
    year.onkeydown = event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        void commitYear();
      }
    };
    previous.onclick = () => { const value = readYear(); if (value !== null && value > 100) { year.value = String(value - 1); syncYear(); } };
    next.onclick = () => { const value = readYear(); if (value !== null && value < 9999) { year.value = String(value + 1); syncYear(); } };
    for (let month = 0; month < 12; month++) {
      const button = months.createEl('button', { text: `${month + 1}月`, attr: { type: 'button', 'data-month': String(month) } });
      button.onclick = () => void (async () => {
        const value = readYear();
        if (value === null) { year.focus(); return; }
        await this.selectDate(String(value).padStart(4, '0') + '-' + this.pad(month + 1) + '-01');
        this.rootEl.querySelector<HTMLElement>('.pls-calendar-month-toggle')?.focus();
      })();
      button.onkeydown = event => {
        const columns = getComputedStyle(months).gridTemplateColumns.split(' ').length;
        const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
        if (event.key in offsets) {
          event.preventDefault();
          months.querySelector<HTMLButtonElement>(`[data-month="${(month + offsets[event.key] + 12) % 12}"]`)?.focus();
        }
      };
    }
    syncYear();
    picker.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); picker.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); }
    });
  }

  private renderAgenda(root: HTMLElement): void {
    const legend = root.createDiv({ cls: 'pls-calendar-legend' });
    legend.createSpan({ text: '● 日记　○ 打卡　◆ 复盘　数字：待办 / 完成' });
    legend.createSpan({ text: '方向键切换日期；Page Up / Down 切换月份，按住 Shift 切换年份' });
    const agenda = root.createDiv({ cls: 'pls-calendar-agenda', attr: { 'aria-live': 'polite' } });
    agenda.createEl('h3', { text: this.selectedDate + ' · 当日安排' });
    if (this.dataWarnings.length) agenda.createEl('p', { text: this.dataWarnings.join('；') + '，列表可能不完整，请重新进入日历重试。', attr: { role: 'status' } });
    const data = this.monthData.get(this.selectedDate);
    const actions = agenda.createDiv({ cls: 'pls-calendar-agenda-actions' });
    const date = this.selectedDate;
    const diary = actions.createEl('button', { text: data?.diary ? '打开当日日记' : '创建当日日记', attr: { type: 'button', 'data-calendar-action': 'diary' } });
    diary.onclick = () => void (async () => {
      diary.disabled = true;
      try {
        const existing = this.plugin.listDailyNotes().find(file => file.basename === date);
        const service = new DailyNoteService(this.app, new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage), this.plugin.settings);
        const file = existing || await service.ensureTodayNote(date);
        await this.app.workspace.getLeaf(false).openFile(file);
        await this.render();
      } catch (error) { new Notice('打开日记失败：' + String(error)); }
      finally { diary.disabled = false; }
    })();
    actions.createEl('button', { text: '查看任务清单', attr: { type: 'button', 'data-calendar-action': 'tasks' } }).onclick = () => void this.plugin.activateTasks();
    if (data?.diary || data?.checkin || data?.studyTasks) actions.createEl('button', { text: '预览当日记录', attr: { type: 'button' } }).onclick = () => new DayDetailModal(this.app, this.plugin, date, data).open();
    if (data?.reviewPath) actions.createEl('button', { text: '打开当日复盘', attr: { type: 'button', 'data-calendar-action': 'review' } }).onclick = () => {
      const file = this.app.vault.getAbstractFileByPath(data.reviewPath!);
      if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
      else new Notice('复盘文件已变更，请重新进入日历。');
    };
    const items = data?.taskItems || [];
    if (!items.length) agenda.createEl('p', { text: '当日暂无安排的任务。无截止日期的待办请在任务清单查看。', cls: 'pls-muted' });
    const list = agenda.createEl('ul', { cls: 'pls-calendar-agenda-list' });
    for (const item of items) {
      const row = list.createEl('li', { cls: 'pls-calendar-agenda-item' });
      row.createSpan({ text: (item.done ? '已完成 · ' : '待办 · ') + item.text });
      row.createEl('button', { text: '打开来源', attr: { type: 'button', 'aria-label': '打开任务来源：' + item.text } }).onclick = () => {
        const file = this.app.vault.getAbstractFileByPath(item.path);
        if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
        else new Notice('任务来源已变更，请重新进入日历。');
      };
    }
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
      const dateStr = `${String(this.year).padStart(4, '0')}-${this.pad(this.month + 1)}-${this.pad(d)}`;
      const data = this.monthData.get(dateStr);
      const isToday = dateStr === today;

      const cell = grid.createEl("button", { attr: { type: "button", "data-date": dateStr, "aria-label": dateStr + (data ? `，待办 ${data.tasks}，完成 ${data.completedTasks}，日记 ${data.diary ? "有" : "无"}` : "，暂无记录"), "aria-pressed": String(dateStr === this.selectedDate), ...(isToday ? { "aria-current": "date" } : {}) }, cls: `pls-calendar-day${dateStr === this.selectedDate ? " is-selected" : ""}${isToday ? " pls-calendar-day-today" : ""}${data ? " pls-calendar-day-active" : ""}` });
      cell.createDiv({ cls: "pls-calendar-day-num", text: String(d) });

      if (data) {
        const row = cell.createDiv({ cls: "pls-calendar-indicators" });
        if (data.reviewPath) row.createSpan({ text: '◆', attr: { title: '复盘' } });
        if (data.diary) row.createSpan({ cls: "pls-calendar-dot pls-calendar-dot-diary", attr: { title: "日记" } });
        if (data.checkin) row.createSpan({ cls: "pls-calendar-dot pls-calendar-dot-checkin", attr: { title: "打卡" } });
        if (data.tasks + data.completedTasks + data.studyTasks > 0) {
          row.createSpan({ cls: "pls-calendar-task-badge", text: `${data.tasks + data.studyTasks} / ${data.completedTasks}` });
        }
      }

      cell.tabIndex = dateStr === this.selectedDate ? 0 : -1;
      cell.onclick = () => void this.selectDate(dateStr, true);
      cell.onkeydown = event => {
        if (event.key === 'PageUp' || event.key === 'PageDown') {
          event.preventDefault();
          void this.changeMonth((event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1));
          return;
        }
        const shifts: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
        if (!(event.key in shifts)) return;
        event.preventDefault();
        const date = new Date(this.year, this.month, d + shifts[event.key]);
        void this.selectDate(String(date.getFullYear()).padStart(4, '0') + '-' + this.pad(date.getMonth() + 1) + '-' + this.pad(date.getDate()), true);
      };
    }
  }
}

class DayDetailModal extends Modal {
  private markdownComponent: Component | null = null;

  onClose(): void {
    this.markdownComponent?.unload();
    this.markdownComponent = null;
    this.contentEl.empty();
  }

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
      if (this.data.completedTasks > 0) stats.createSpan({ cls: 'pls-calendar-detail-stat', text: '已完成 ' + this.data.completedTasks });
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
    this.markdownComponent = comp;
    comp.load();
    void this.loadContent(contentEl, diaryTFile, checkinTFile, comp).catch(error => {
      if (this.markdownComponent === comp) new Notice("读取当日记录失败：" + String(error));
    });

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
      if (this.markdownComponent !== comp) return;
      const markdown = content.replace(/^---[\s\S]*?---\n*/, "").trim();
      if (markdown) {
        const section = contentEl.createDiv({ cls: "pls-calendar-detail-section" });
        const contentArea = section.createDiv({ cls: "pls-calendar-detail-content" });
        await renderMarkdownDisplay(this.app, comp, contentArea, markdown, diaryFile.path);
      }
    } else if (!this.data || (!this.data.diary && !this.data.checkin && this.data.tasks === 0 && this.data.studyTasks === 0)) {
      contentEl.createEl("p", { text: "当日无记录", cls: "pls-muted" });
    }

    // Checkin content
    if (checkinFile instanceof TFile) {
      const checkinContent = await this.app.vault.read(checkinFile);
      if (this.markdownComponent !== comp) return;
      const markdown = checkinContent.replace(/^---[\s\S]*?---\n*/, "").trim();
      if (markdown) {
        const section = contentEl.createDiv({ cls: "pls-calendar-detail-section" });
        section.createEl("h3", { text: "📅 学习打卡" });
        const checkinArea = section.createDiv({ cls: "pls-calendar-detail-content" });
        await renderMarkdownDisplay(this.app, comp, checkinArea, markdown, checkinFile.path);
      }
    }
  }
}
