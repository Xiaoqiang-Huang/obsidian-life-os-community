import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { createButton } from "../components/Button";
import { createCard } from "../components/Card";
import { createHeroHeader } from "../components/HeroHeader";
import { createLifeOSShell } from "../components/LifeOSComponent";
import { CHECKIN_VIEW_TYPE } from "../constants";
import type PersonalLifeSystemPlugin from "../main";
import { listExamFiles, parseFrontmatter } from "../exam/data";
import { getExamMetricProfiles, getExamProfileLabel } from "../settings";
import { ensureFile, ensureFolder } from "../utils";
import { today, formatDate } from "../utils/dates";

interface CheckinRecord {
  date: string;
  duration_minutes: number;
  tasks_completed: number;
  xingce_questions: number;
  interview_practice: number;
  mood: string;
  summary: string;
  streak: number;
}

const MOODS = [
  { key: "happy", label: "顺利" },
  { key: "neutral", label: "平稳" },
  { key: "anxious", label: "焦虑" },
  { key: "tired", label: "疲惫" },
  { key: "blocked", label: "卡住" }
];

export class CheckinView extends ItemView {
  private moodValue = "neutral";

  constructor(leaf: WorkspaceLeaf, private plugin: PersonalLifeSystemPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return CHECKIN_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "学习打卡";
  }

  async onOpen(): Promise<void> {
    await this.render();
    this.registerEvent(this.app.vault.on("modify", () => void this.render()));
    this.registerEvent(this.app.vault.on("create", () => void this.render()));
  }

  private async render(): Promise<void> {
    await this.plugin.ensureBaseStructure();
    const container = this.containerEl.children[1];
    container.empty();

    const main = createLifeOSShell(container as HTMLElement, this.plugin, "checkins");
    main.addClass("lifeos-checkin-page");

    const checkinsPath = this.plugin.path("Exam", "Checkins");
    await ensureFolder(this.app, checkinsPath);
    const date = today();
    const existingFile = this.app.vault.getAbstractFileByPath(`${checkinsPath}/${date}.md`);
    const record = existingFile instanceof TFile ? await this.readRecord(existingFile) : null;
    const streak = await this.calculateStreak(checkinsPath, date);

    createHeroHeader(main, {
      kicker: "学习打卡",
      title: record ? "今日已打卡" : "今日学习打卡",
      description: record ? "今天已经留下进度。你可以查看记录，也可以更新今日打卡。" : "记录一次学习动作，让长期趋势更完整。",
      icon: "graduation-cap",
      meta: `连续 ${record?.streak ?? streak} 天`,
      actions: [
        { label: "打开今日日记", icon: "book-open", onClick: () => void this.plugin.openTodayNote(false) },
        { label: "查看复盘", icon: "bar-chart-3", onClick: () => void this.plugin.activateReview() }
      ]
    });

    const grid = main.createDiv({ cls: "lifeos-checkin-page-grid" });
    this.renderForm(grid, record, streak);
    this.renderSide(grid, record, streak);
  }

  private renderForm(parent: HTMLElement, record: CheckinRecord | null, streak: number): void {
    const metrics = getExamMetricProfiles(this.plugin.settings);
    const card = createCard(parent, "lifeos-panel lifeos-checkin-form-card");
    const header = card.createDiv({ cls: "lifeos-card-heading-row" });
    const title = header.createDiv({ cls: "lifeos-card-title" });
    setIcon(title.createSpan(), "clipboard-check");
    title.createSpan({ text: "今日记录" });
    header.createSpan({ cls: "lifeos-muted-text", text: record ? "保存会更新今日记录" : "填写后保存到本地 Vault" });

    const form = card.createDiv({ cls: "lifeos-checkin-form-page" });
    const dataGroup = form.createDiv({ cls: "lifeos-form-group lifeos-form-field-wide" });
    dataGroup.createDiv({ cls: "lifeos-form-group-title", text: "学习数据" });
    const dataGrid = dataGroup.createDiv({ cls: "lifeos-checkin-data-grid" });
    const duration = this.numberField(dataGrid, "学习时长", "分钟", String(record?.duration_minutes ?? 0));
    const tasksCompleted = this.numberField(dataGrid, "完成任务", "个", String(record?.tasks_completed ?? 0));
    const xingceQuestions = this.numberField(dataGrid, metrics[0]?.label ?? "练习数量", metrics[0]?.unit ?? "项", String(record?.xingce_questions ?? 0));
    const interviewPractice = this.numberField(dataGrid, metrics[1]?.label ?? "复盘次数", metrics[1]?.unit ?? "次", String(record?.interview_practice ?? 0));

    const moodGroup = form.createDiv({ cls: "lifeos-form-group lifeos-form-field-wide" });
    moodGroup.createDiv({ cls: "lifeos-form-group-title", text: "今日状态" });
    const moodRow = moodGroup.createDiv({ cls: "lifeos-mood-grid lifeos-mood-grid-page" });
    this.moodValue = record?.mood || this.moodValue;
    const renderMoods = () => {
      moodRow.empty();
      for (const mood of MOODS) {
        const button = moodRow.createEl("button", {
          text: mood.label,
          cls: mood.key === this.moodValue ? "is-active" : "",
          attr: { type: "button" }
        });
        button.onclick = () => {
          this.moodValue = mood.key;
          renderMoods();
        };
      }
    };
    renderMoods();

    const summaryWrap = form.createDiv({ cls: "lifeos-form-group lifeos-form-field-wide" });
    summaryWrap.createDiv({ cls: "lifeos-form-group-title", text: "今日一句" });
    const summary = summaryWrap.createEl("textarea", {
      cls: "lifeos-input lifeos-soft-input lifeos-checkin-summary",
      attr: { placeholder: "今天完成了什么，哪里卡住了，明天继续什么..." }
    });
    summary.value = record?.summary || "";

    const actions = card.createDiv({ cls: "lifeos-card-actions lifeos-checkin-actions" });
    createButton(actions, "取消", () => void this.plugin.activateDashboard(), { ghost: true, icon: "arrow-left" });
    createButton(actions, record ? "更新今日打卡" : "完成今日打卡", () => void this.submit(duration, tasksCompleted, xingceQuestions, interviewPractice, summary, streak, Boolean(record)), {
      primary: true,
      icon: "check-circle-2"
    });
  }

  private renderSide(parent: HTMLElement, record: CheckinRecord | null, streak: number): void {
    const panel = createCard(parent, "lifeos-panel lifeos-checkin-side");
    panel.createEl("h3", { text: "打卡状态" });
    const stats = panel.createDiv({ cls: "lifeos-checkin-side-stats" });
    this.sideStat(stats, "今日", record ? "已打卡" : "待打卡");
    this.sideStat(stats, "连续", `${record?.streak ?? streak} 天`);
    this.sideStat(stats, "状态", record ? this.moodLabel(record.mood) : "未记录");
    panel.createEl("p", { cls: "lifeos-muted-text", text: record ? "今日记录已保存到备考打卡目录。再次保存会更新同一天的打卡内容。" : `打卡不会要求完美，只要留下今天的${getExamProfileLabel(this.plugin.settings)}学习动作。` });
  }

  private sideStat(parent: HTMLElement, label: string, value: string): void {
    const item = parent.createDiv({ cls: "lifeos-result-item" });
    item.createSpan({ cls: "lifeos-result-label", text: label });
    item.createSpan({ cls: "lifeos-result-value", text: value });
  }

  private numberField(parent: HTMLElement, label: string, suffix: string, value: string): HTMLInputElement {
    const wrap = parent.createDiv({ cls: "lifeos-form-field" });
    wrap.createEl("label", { text: label });
    const inputWrap = wrap.createDiv({ cls: "lifeos-number-input" });
    const input = inputWrap.createEl("input", {
      cls: "lifeos-input",
      attr: { placeholder: value, type: "number", inputmode: "numeric", min: "0" }
    });
    input.value = value;
    inputWrap.createSpan({ text: suffix });
    return input;
  }

  private async submit(
    duration: HTMLInputElement,
    tasksCompleted: HTMLInputElement,
    xingceQuestions: HTMLInputElement,
    interviewPractice: HTMLInputElement,
    summary: HTMLTextAreaElement,
    currentStreak: number,
    isUpdate: boolean
  ): Promise<void> {
    if (isUpdate && !window.confirm("今天已经打卡。确认更新今日打卡内容吗？")) return;
    const date = today();
    const streak = isUpdate ? currentStreak : currentStreak + 1;
    const checkinsPath = this.plugin.path("Exam", "Checkins");
    const file = await ensureFile(this.app, `${checkinsPath}/${date}.md`, "");
    const summaryText = summary.value.trim() || "今天也完成了一次稳定的学习记录。";
    const content = this.buildCheckinMarkdown(date, streak, {
      duration: Number(duration.value) || 0,
      tasksCompleted: Number(tasksCompleted.value) || 0,
      xingceQuestions: Number(xingceQuestions.value) || 0,
      interviewPractice: Number(interviewPractice.value) || 0,
      mood: this.moodValue,
      summary: summaryText
    });

    await this.app.vault.modify(file, content);
    new Notice(isUpdate ? "今日打卡已更新。" : `打卡成功，已连续 ${streak} 天。`, 5000);
    await this.render();
  }

  private buildCheckinMarkdown(date: string, streak: number, data: {
    duration: number;
    tasksCompleted: number;
    xingceQuestions: number;
    interviewPractice: number;
    mood: string;
    summary: string;
  }): string {
    const metrics = getExamMetricProfiles(this.plugin.settings);
    const firstMetric = metrics[0] ?? { label: "练习数量", unit: "项" };
    const secondMetric = metrics[1] ?? { label: "复盘次数", unit: "次" };
    return `---\ndate: ${date}\nduration_minutes: ${data.duration}\ntasks_completed: ${data.tasksCompleted}\nxingce_questions: ${data.xingceQuestions}\ninterview_practice: ${data.interviewPractice}\nmood: ${data.mood}\nsummary: ${markdownYamlBlock(data.summary)}\nstreak: ${streak}\nexam_profile: ${getExamProfileLabel(this.plugin.settings)}\n---\n\n# ${date} 学习打卡\n\n- 连续打卡：${streak} 天\n- 学习时长：${data.duration} 分钟\n- 完成任务：${data.tasksCompleted} 个\n- ${firstMetric.label}：${data.xingceQuestions} ${firstMetric.unit}\n- ${secondMetric.label}：${data.interviewPractice} ${secondMetric.unit}\n- 今日状态：${this.moodLabel(data.mood)}\n\n## 总结\n\n${data.summary}\n`;
  }

  private async readRecord(file: TFile): Promise<CheckinRecord | null> {
    const fm = parseFrontmatter(this.app, file);
    if (fm) return this.recordFromFrontmatter(fm);
    const content = await this.app.vault.read(file);
    const date = file.basename;
    return {
      date,
      duration_minutes: Number(this.matchFrontmatter(content, "duration_minutes")) || 0,
      tasks_completed: Number(this.matchFrontmatter(content, "tasks_completed")) || 0,
      xingce_questions: Number(this.matchFrontmatter(content, "xingce_questions")) || 0,
      interview_practice: Number(this.matchFrontmatter(content, "interview_practice")) || 0,
      mood: this.matchFrontmatter(content, "mood") || "neutral",
      summary: this.extractSummary(content),
      streak: Number(this.matchFrontmatter(content, "streak")) || 1
    };
  }

  private recordFromFrontmatter(fm: Record<string, unknown>): CheckinRecord {
    return {
      date: String(fm.date ?? today()),
      duration_minutes: Number(fm.duration_minutes) || 0,
      tasks_completed: Number(fm.tasks_completed) || 0,
      xingce_questions: Number(fm.xingce_questions) || 0,
      interview_practice: Number(fm.interview_practice) || 0,
      mood: String(fm.mood ?? "neutral"),
      summary: String(fm.summary ?? ""),
      streak: Number(fm.streak) || 1
    };
  }

  private matchFrontmatter(content: string, key: string): string {
    return content.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
  }

  private extractSummary(content: string): string {
    return content.split("## 总结")[1]?.trim() ?? "";
  }

  private async calculateStreak(checkinsPath: string, date: string): Promise<number> {
    const files = listExamFiles(this.app, checkinsPath);
    const dates = new Set<string>();
    for (const file of files) {
      const fm = parseFrontmatter(this.app, file);
      dates.add(String(fm?.date ?? file.basename));
    }
    let streak = 0;
    const cursor = new Date(date);
    cursor.setDate(cursor.getDate() - 1);
    while (dates.has(formatDate(cursor))) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  private moodLabel(value: string): string {
    return MOODS.find((mood) => mood.key === value)?.label ?? value;
  }
}

function markdownYamlBlock(value: string, fallback = ""): string {
  const text = value.trim() || fallback;
  if (!text) return "\"\"";
  return `|-\n${text.split(/\r?\n/).map((line) => `  ${line}`).join("\n")}`;
}
