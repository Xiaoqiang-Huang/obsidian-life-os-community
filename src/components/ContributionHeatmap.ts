import { App, Modal, Notice, TFile, setIcon } from "obsidian";
import type PersonalLifeSystemPlugin from "../main";
import type { DisplayLanguage, HeatmapRange } from "../settings";
import type { DailyActivity } from "../services/ActivityService";
import { ensureFile } from "../utils/vault";
import { createModalShell } from "./ModalShell";

interface ContributionHeatmapOptions {
  app: App;
  plugin: PersonalLifeSystemPlugin;
  activities: DailyActivity[];
  onSettingsSaved: () => Promise<void> | void;
}

type HeatmapCell = DailyActivity | null;

const RANGE_LABELS: Record<DisplayLanguage, Record<HeatmapRange, string>> = {
  zh: { "30d": "过去 30 天", "90d": "过去 90 天", "1y": "过去一年" },
  en: { "30d": "the last 30 days", "90d": "the last 90 days", "1y": "the last year" }
};

const MONTH_LABELS: Record<DisplayLanguage, string[]> = {
  zh: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"],
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
};

export function createContributionHeatmap(parent: HTMLElement, options: ContributionHeatmapOptions): HTMLElement {
  const lang = options.plugin.settings.language ?? "zh";
  const range = options.plugin.settings.heatmapRange ?? "1y";
  const total = options.activities.reduce((sum, item) => sum + item.score, 0);
  const weeks = buildWeeks(options.activities);
  const card = parent.createDiv({ cls: "lifeos-contrib-card" });

  const header = card.createDiv({ cls: "lifeos-contrib-header" });
  header.createDiv({ cls: "lifeos-contrib-title", text: contributionTitle(total, range, lang) });
  const settings = header.createEl("button", { cls: "lifeos-contrib-settings", attr: { type: "button" } });
  settings.createSpan({ text: lang === "zh" ? "热力图设置" : "Contribution settings" });
  setIcon(settings.createSpan(), "chevron-down");
  settings.onclick = () => new ContributionSettingsModal(options.app, options.plugin, options.onSettingsSaved).open();

  const viewport = card.createDiv({ cls: range === "1y" ? "lifeos-contrib-scroll" : "lifeos-contrib-scroll is-compact-range" });
  const calendar = viewport.createDiv({ cls: "lifeos-contrib-calendar" });
  calendar.style.setProperty("--lifeos-contrib-weeks", String(weeks.length));
  renderMonths(calendar, weeks, lang);
  renderWeekdays(calendar, lang);
  renderGrid(calendar, weeks, options, lang);
  window.requestAnimationFrame(() => {
    viewport.scrollLeft = viewport.scrollWidth;
  });

  const footer = card.createDiv({ cls: "lifeos-contrib-footer" });
  footer.createEl("button", {
    cls: "lifeos-contrib-help",
    attr: { type: "button" },
    text: lang === "zh" ? "了解如何统计记录" : "Learn how we count contributions"
  }).onclick = () => new Notice(lang === "zh"
    ? "记录来自手动快速记录、已完成任务、学习打卡和每日复盘，可在热力图设置中调整。"
    : "Contributions are counted from manual quick records, completed tasks, check-ins, and daily summaries.");
  const legend = footer.createDiv({ cls: "lifeos-contrib-legend" });
  legend.createSpan({ text: lang === "zh" ? "少" : "Less" });
  for (const level of [0, 1, 2, 3, 4]) legend.createSpan({ cls: `lifeos-contrib-day level-${level}` });
  legend.createSpan({ text: lang === "zh" ? "多" : "More" });
  return card;
}

function contributionTitle(total: number, range: HeatmapRange, lang: DisplayLanguage): string {
  if (lang === "en") return `${total} contributions in ${RANGE_LABELS.en[range]}`;
  return `${RANGE_LABELS.zh[range]}有 ${total} 次记录`;
}

function buildWeeks(activities: DailyActivity[]): HeatmapCell[][] {
  const cells: HeatmapCell[] = [...activities];
  while (cells.length % 7 !== 0) cells.unshift(null);
  const weeks: HeatmapCell[][] = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return weeks;
}

function renderMonths(parent: HTMLElement, weeks: HeatmapCell[][], lang: DisplayLanguage): void {
  const months = parent.createDiv({ cls: "lifeos-contrib-months" });
  months.createSpan();
  let lastMonth = -1;
  for (const week of weeks) {
    const firstDay = week.find(Boolean);
    if (!firstDay) {
      months.createSpan();
      continue;
    }
    const month = Number(firstDay.date.slice(5, 7)) - 1;
    months.createSpan({ text: month !== lastMonth ? MONTH_LABELS[lang][month] : "" });
    lastMonth = month;
  }
}

function renderWeekdays(parent: HTMLElement, lang: DisplayLanguage): void {
  const weekdays = parent.createDiv({ cls: "lifeos-contrib-weekdays" });
  const labels = lang === "zh" ? ["", "一", "", "三", "", "五", ""] : ["", "Mon", "", "Wed", "", "Fri", ""];
  for (const label of labels) weekdays.createSpan({ text: label });
}

function renderGrid(parent: HTMLElement, weeks: HeatmapCell[][], options: ContributionHeatmapOptions, lang: DisplayLanguage): void {
  const grid = parent.createDiv({ cls: "lifeos-contrib-grid" });
  const card = parent.closest(".lifeos-contrib-card");
  const tooltipHost = card instanceof HTMLElement ? card : parent;
  const tooltip = tooltipHost.createDiv({ cls: "lifeos-contrib-tooltip" });
  tooltip.hide();
  for (const week of weeks) {
    const column = grid.createDiv({ cls: "lifeos-contrib-week" });
    for (const day of week) {
      if (!day) {
        column.createSpan({ cls: "lifeos-contrib-day is-empty" });
        continue;
      }
      const text = tooltipText(day, lang);
      const cell = column.createEl("button", {
        cls: `lifeos-contrib-day level-${day.level}`,
        attr: { type: "button", "aria-label": text, title: text }
      });
      cell.onmouseenter = () => showTooltip(tooltipHost, tooltip, cell, text);
      cell.onmouseleave = () => tooltip.hide();
      cell.onfocus = () => showTooltip(tooltipHost, tooltip, cell, text);
      cell.onblur = () => tooltip.hide();
      cell.onclick = () => void openOrCreateDaily(options, day.date, lang);
    }
  }
}

function showTooltip(parent: HTMLElement, tooltip: HTMLElement, cell: HTMLElement, text: string): void {
  tooltip.setText(text);
  tooltip.show();
  const parentBox = parent.getBoundingClientRect();
  const cellBox = cell.getBoundingClientRect();
  const left = Math.min(Math.max(8, cellBox.left - parentBox.left - 86), Math.max(8, parentBox.width - 190));
  const top = Math.max(8, cellBox.top - parentBox.top - 62);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function tooltipText(day: DailyActivity, lang: DisplayLanguage): string {
  if (lang === "en") {
    return [
      day.date,
      `${day.score} contributions`,
      `Quick records: ${day.dailyRecordCount}`,
      `Completed tasks: ${day.completedTaskCount}`,
      `Check-in: ${day.checkinExists ? "Yes" : "No"}`,
      `Daily summary: ${day.summaryExists ? "Yes" : "No"}`
    ].join("\n");
  }
  return [
    day.date,
    `${day.score} 次记录`,
    `快速记录: ${day.dailyRecordCount}`,
    `完成任务：${day.completedTaskCount}`,
    `学习打卡：${day.checkinExists ? "有" : "无"}`,
    `今日复盘：${day.summaryExists ? "有" : "无"}`
  ].join("\n");
}

async function openOrCreateDaily(options: ContributionHeatmapOptions, date: string, lang: DisplayLanguage): Promise<void> {
  const path = options.plugin.getTodayNotePath(date);
  const existing = options.app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await options.app.workspace.getLeaf(false).openFile(existing);
    return;
  }
  const message = lang === "zh" ? "这一天还没有日记，是否创建？" : "No daily note for this day. Create one?";
  if (!window.confirm(message)) return;
  const file = await ensureFile(options.app, path, `---\ntype: daily-note\ndate: ${date}\n---\n\n# ${date}\n\n## 快速记录\n\n## 今日复盘\n\n`);
  new Notice(lang === "zh" ? "日记已创建。" : "Daily note created.");
  await options.app.workspace.getLeaf(false).openFile(file);
  await options.onSettingsSaved();
}

class ContributionSettingsModal extends Modal {
  constructor(
    app: App,
    private plugin: PersonalLifeSystemPlugin,
    private onSaved: () => Promise<void> | void
  ) {
    super(app);
  }

  onOpen(): void {
    const lang = this.plugin.settings.language ?? "zh";
    this.modalEl.addClass("lifeos-modal-host", "lifeos-contrib-settings-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: lang === "zh" ? "热力图设置" : "Contribution settings",
      subtitle: lang === "zh" ? "选择显示范围、语言和统计内容。" : "Choose range, language, and contribution sources.",
      icon: "calendar-range",
      className: "lifeos-contrib-settings-modal"
    });

    const form = body.createDiv({ cls: "lifeos-contrib-settings-form" });
    const range = this.select(form, lang === "zh" ? "显示范围" : "Range", [
      ["30d", lang === "zh" ? "最近 30 天" : "Last 30 days"],
      ["90d", lang === "zh" ? "最近 90 天" : "Last 90 days"],
      ["1y", lang === "zh" ? "最近一年" : "Last year"]
    ], this.plugin.settings.heatmapRange ?? "1y");
    const language = this.select(form, lang === "zh" ? "显示语言" : "Display Language", [
      ["zh", "中文"],
      ["en", "English"]
    ], lang);

    const sources = form.createDiv({ cls: "lifeos-contrib-source-group" });
    sources.createDiv({ cls: "lifeos-setting-label", text: lang === "zh" ? "统计内容" : "Contribution sources" });
    const daily = this.checkbox(sources, lang === "zh" ? "日记记录" : "Daily notes", this.plugin.settings.heatmapIncludeDaily);
    const tasks = this.checkbox(sources, lang === "zh" ? "完成任务" : "Completed tasks", this.plugin.settings.heatmapIncludeTasks);
    const checkins = this.checkbox(sources, lang === "zh" ? "学习打卡" : "Check-ins", this.plugin.settings.heatmapIncludeCheckins);
    const summaries = this.checkbox(sources, lang === "zh" ? "今日复盘" : "Daily summaries", this.plugin.settings.heatmapIncludeSummaries);

    footer.createEl("button", {
      cls: "lifeos-button lifeos-button-ghost",
      attr: { type: "button" },
      text: lang === "zh" ? "取消" : "Cancel"
    }).onclick = () => this.close();
    footer.createEl("button", {
      cls: "lifeos-button lifeos-button-primary",
      attr: { type: "button" },
      text: lang === "zh" ? "保存设置" : "Save settings"
    }).onclick = () => void this.save(range.value as HeatmapRange, language.value as DisplayLanguage, daily.checked, tasks.checked, checkins.checked, summaries.checked);
  }

  private select(parent: HTMLElement, label: string, options: Array<[string, string]>, value: string): HTMLSelectElement {
    const field = parent.createDiv({ cls: "lifeos-form-field" });
    field.createEl("label", { text: label });
    const select = field.createEl("select", { cls: "lifeos-input" });
    for (const [id, text] of options) select.createEl("option", { value: id, text });
    select.value = value;
    return select;
  }

  private checkbox(parent: HTMLElement, label: string, checked: boolean): HTMLInputElement {
    const wrap = parent.createEl("label", { cls: "lifeos-toggle lifeos-toggle-card" });
    const input = wrap.createEl("input", { attr: { type: "checkbox" } });
    input.checked = checked;
    wrap.createSpan({ text: label });
    return input;
  }

  private async save(
    range: HeatmapRange,
    language: DisplayLanguage,
    includeDaily: boolean,
    includeTasks: boolean,
    includeCheckins: boolean,
    includeSummaries: boolean
  ): Promise<void> {
    this.plugin.settings.heatmapRange = range;
    this.plugin.settings.language = language;
    this.plugin.settings.heatmapIncludeDaily = includeDaily;
    this.plugin.settings.heatmapIncludeTasks = includeTasks;
    this.plugin.settings.heatmapIncludeCheckins = includeCheckins;
    this.plugin.settings.heatmapIncludeSummaries = includeSummaries;
    await this.plugin.saveSettings();
    await this.onSaved();
    new Notice(language === "zh" ? "热力图设置已保存" : "Contribution settings saved");
    this.close();
  }
}
