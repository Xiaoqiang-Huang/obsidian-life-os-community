import { Modal, Notice, TFile, type App } from "obsidian";
import { createModalShell } from "../components/ModalShell";
import type { IPlugin } from "../plugin-api";
import { getExamMetricProfiles, getExamProfileLabel } from "../settings";
import { ensureFile, ensureFolder, formatDate } from "../utils";
import { listExamFiles, parseFrontmatter } from "./data";

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

function markdownYamlBlock(value: string, fallback = ""): string {
  const text = value.trim() || fallback;
  if (!text) return "\"\"";
  return `|-\n${text.split(/\r?\n/).map((line) => `  ${line}`).join("\n")}`;
}

export async function showCheckinModal(app: App, plugin: IPlugin): Promise<void> {
  const checkinsPath = plugin.path("Exam", "Checkins");
  await ensureFolder(app, checkinsPath);
  const date = formatDate();

  const todayAbstract = app.vault.getAbstractFileByPath(`${checkinsPath}/${date}.md`);
  if (todayAbstract instanceof TFile) {
    const fm = parseFrontmatter(app, todayAbstract);
    if (fm) {
      new CheckinResultModal(app, fm as unknown as CheckinRecord).open();
      return;
    }
  }

  const streak = await calculateStreak(app, checkinsPath, date);
  new CheckinModal(app, plugin, streak).open();
}

async function calculateStreak(app: App, checkinsPath: string, today: string): Promise<number> {
  const files = listExamFiles(app, checkinsPath);
  const dates = new Set<string>();

  for (const file of files) {
    const fm = parseFrontmatter(app, file);
    if (fm?.date) dates.add(String(fm.date));
  }

  let streak = 0;
  const cursor = new Date(today);
  cursor.setDate(cursor.getDate() - 1);
  while (true) {
    const date = formatDate(cursor);
    if (!dates.has(date)) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

class CheckinModal extends Modal {
  private moodValue = "neutral";

  constructor(app: App, private plugin: IPlugin, private currentStreak: number) {
    super(app);
  }

  onOpen(): void {
    const metrics = getExamMetricProfiles(this.plugin.settings);
    this.modalEl.addClass("lifeos-modal-host", "lifeos-checkin-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: "今日学习打卡",
      subtitle: `当前连续打卡 ${this.currentStreak} 天。记录一次学习动作，让长期趋势更完整。`,
      icon: "graduation-cap",
      className: "lifeos-checkin-modal"
    });

    const form = body.createDiv({ cls: "lifeos-checkin-form" });

    const dataGroup = form.createDiv({ cls: "lifeos-form-group lifeos-form-field-wide" });
    dataGroup.createDiv({ cls: "lifeos-form-group-title", text: "学习数据" });
    const dataGrid = dataGroup.createDiv({ cls: "lifeos-checkin-data-grid" });
    const duration = this.numberField(dataGrid, "学习时长", "分钟", "0");
    const tasksCompleted = this.numberField(dataGrid, "完成任务", "个", "0");
    const xingceQuestions = this.numberField(dataGrid, metrics[0]?.label ?? "练习数量", metrics[0]?.unit ?? "项", "0");
    const interviewPractice = this.numberField(dataGrid, metrics[1]?.label ?? "复盘次数", metrics[1]?.unit ?? "次", "0");

    const moodGroup = form.createDiv({ cls: "lifeos-form-group lifeos-form-field-wide" });
    moodGroup.createDiv({ cls: "lifeos-form-group-title", text: "今日状态" });
    const moodRow = moodGroup.createDiv({ cls: "lifeos-mood-grid" });
    const moods = [
      { key: "happy", label: "顺利" },
      { key: "neutral", label: "平稳" },
      { key: "anxious", label: "焦虑" },
      { key: "tired", label: "疲惫" },
      { key: "blocked", label: "卡住" }
    ];
    const renderMoods = () => {
      moodRow.empty();
      for (const mood of moods) {
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
      cls: "lifeos-input",
      attr: { placeholder: "今天完成了什么，哪里卡住了，明天继续什么。" }
    });

    createNativeButton(footer, "取消", () => this.close(), false);
    createNativeButton(footer, "完成今日打卡", () => void this.submit(duration, tasksCompleted, xingceQuestions, interviewPractice, summary), true);
  }

  private numberField(parent: HTMLElement, label: string, suffix: string, value: string): HTMLInputElement {
    const wrap = parent.createDiv({ cls: "lifeos-form-field" });
    wrap.createEl("label", { text: label });
    const inputWrap = wrap.createDiv({ cls: "lifeos-number-input" });
    const input = inputWrap.createEl("input", {
      cls: "lifeos-input",
      attr: { placeholder: value, type: "number", inputmode: "numeric", min: "0" },
      value
    });
    inputWrap.createSpan({ text: suffix });
    return input;
  }

  private async submit(
    duration: HTMLInputElement,
    tasksCompleted: HTMLInputElement,
    xingceQuestions: HTMLInputElement,
    interviewPractice: HTMLInputElement,
    summary: HTMLTextAreaElement
  ): Promise<void> {
    const date = formatDate();
    const streak = this.currentStreak + 1;
    const checkinsPath = this.plugin.path("Exam", "Checkins");
    const file = await ensureFile(this.app, `${checkinsPath}/${date}.md`, "");
    const summaryText = summary.value.trim() || "今天也完成了一次稳定的学习记录。";
    const metrics = getExamMetricProfiles(this.plugin.settings);
    const firstMetric = metrics[0] ?? { label: "练习数量", unit: "项" };
    const secondMetric = metrics[1] ?? { label: "复盘次数", unit: "次" };

    const content = `---
date: ${date}
duration_minutes: ${Number(duration.value) || 0}
tasks_completed: ${Number(tasksCompleted.value) || 0}
xingce_questions: ${Number(xingceQuestions.value) || 0}
interview_practice: ${Number(interviewPractice.value) || 0}
mood: ${this.moodValue}
summary: ${markdownYamlBlock(summaryText)}
streak: ${streak}
exam_profile: ${getExamProfileLabel(this.plugin.settings)}
---

# ${date} 学习打卡

- 连续打卡：${streak} 天
- 学习时长：${duration.value || "0"} 分钟
- 完成任务：${tasksCompleted.value || "0"} 个
- ${firstMetric.label}：${xingceQuestions.value || "0"} ${firstMetric.unit}
- ${secondMetric.label}：${interviewPractice.value || "0"} ${secondMetric.unit}
- 今日状态：${this.moodValue}

## 总结

${summaryText}
`;

    await this.app.vault.modify(file, content);
    this.close();
    new Notice(`打卡成功，已连续 ${streak} 天。`, 5000);
  }
}

function createNativeButton(parent: HTMLElement, label: string, onClick: () => void, primary: boolean): HTMLButtonElement {
  const button = parent.createEl("button", {
    cls: primary ? "lifeos-button lifeos-button-primary" : "lifeos-button lifeos-button-ghost",
    attr: { type: "button" },
    text: label
  });
  button.onclick = onClick;
  return button;
}

class CheckinResultModal extends Modal {
  constructor(app: App, private record: CheckinRecord) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-checkin-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: "今日已打卡",
      subtitle: "今天的学习记录已经保存，可以继续补充日记或进入复盘。",
      icon: "check-circle-2",
      className: "lifeos-checkin-modal"
    });

    const grid = body.createDiv({ cls: "lifeos-checkin-result-grid" });
    this.resultItem(grid, "连续打卡", `${this.record.streak} 天`);
    this.resultItem(grid, "学习时长", `${this.record.duration_minutes} 分钟`);
    this.resultItem(grid, "完成任务", `${this.record.tasks_completed} 个`);
    this.resultItem(grid, "学习状态", this.record.mood);
    if (this.record.summary) {
      const summary = body.createDiv({ cls: "lifeos-info-card tone-green" });
      summary.createEl("h3", { text: "今日总结" });
      summary.createEl("p", { text: this.record.summary });
    }
    createNativeButton(footer, "关闭", () => this.close(), true);
  }

  private resultItem(parent: HTMLElement, label: string, value: string): void {
    const item = parent.createDiv({ cls: "lifeos-result-item" });
    item.createSpan({ cls: "lifeos-result-label", text: label });
    item.createSpan({ cls: "lifeos-result-value", text: value });
  }
}
