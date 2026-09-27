import { ItemView, Notice, TAbstractFile, TFile, WorkspaceLeaf, setIcon } from "obsidian";
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
import { renderStableView } from "../utils/stable-view-refresh";
import { saveGuardedDocument, undoGuardedDocument, type LocalEditReceipt } from "../services/GuardedDocumentService";

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

interface CheckinFormSnapshot { date: string; root: string; path: string; original: string | null; historical: boolean }

const MOODS = [
  { key: "happy", label: "顺利" },
  { key: "neutral", label: "平稳" },
  { key: "anxious", label: "焦虑" },
  { key: "tired", label: "疲惫" },
  { key: "blocked", label: "卡住" }
];

export class CheckinView extends ItemView {
  private moodValue = "neutral";
  private original: string | null = null;
  private formDate = today();
  private saving = false;
  private closed = false;
  private draftTimer: number | null = null;
  private receipt: LocalEditReceipt | null = null;
  private refreshTimer: number | null = null;
  private renderPromise: Promise<void> | null = null;
  private renderQueued = false;
  private renderRequestRevision = 0;
  private preserveScrollOnNextRender = true;

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
    this.closed = false;
    await this.render(false);
    const refresh = (file: TAbstractFile): void => {
      if (this.shouldRefreshForFile(file)) this.scheduleVaultRefresh();
    };
    this.registerEvent(this.app.vault.on("modify", refresh));
    this.registerEvent(this.app.vault.on("create", refresh));
    this.registerEvent(this.app.vault.on("delete", refresh));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (this.shouldRefreshForFile(file) || this.shouldRefreshForFile(oldPath)) this.scheduleVaultRefresh();
    }));
  }

  async onClose(): Promise<void> {
    this.closed = true;
    if (this.draftTimer !== null) { window.clearTimeout(this.draftTimer); this.draftTimer = null; await this.plugin.saveSettings().catch(() => {}); }
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.renderRequestRevision += 1;
  }

  private scheduleVaultRefresh(): void {
    // A background event must not replace an in-progress form or its CAS base.
    if (this.saving || this.plugin.settings.checkinDraft) return;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.render(true);
    }, 120);
  }

  private shouldRefreshForFile(file: TAbstractFile | string): boolean {
    const path = (typeof file === "string" ? file : file.path).replace(/\\/g, "/");
    const root = this.plugin.path("Exam", "Checkins").replace(/\\/g, "/").replace(/\/+$/g, "");
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

    const checkinsPath = this.plugin.path("Exam", "Checkins");
    await ensureFolder(this.app, checkinsPath);
    const savedDraft = this.plugin.settings.checkinDraft;
    const date = savedDraft?.root === this.plugin.getRoot() && /^\d{4}-\d{2}-\d{2}$/.test(savedDraft.date) ? savedDraft.date : today();
    this.formDate = date;
    const existingFile = this.app.vault.getAbstractFileByPath(`${checkinsPath}/${date}.md`);
    const freshOriginal = existingFile instanceof TFile ? await this.app.vault.read(existingFile) : null;
    const draft = this.plugin.settings.checkinDraft;
    this.original = draft?.date === date && draft.root === this.plugin.getRoot() ? draft.original : freshOriginal;
    const snapshot: CheckinFormSnapshot = { date, root: this.plugin.getRoot(), path: `${checkinsPath}/${date}.md`, original: this.original, historical: date !== today() };
    const record = existingFile instanceof TFile ? await this.readRecord(existingFile) : null;
    const streak = await this.calculateStreak(checkinsPath, date);
    if (revision !== this.renderRequestRevision) return;

    await renderStableView(container, (staging) => {
      const main = createLifeOSShell(staging, this.plugin, "checkins");
      main.addClass("lifeos-checkin-page");
      createHeroHeader(main, {
        app: this.app,
      kicker: "学习打卡",
      title: snapshot.historical ? `${date} 未保存草稿` : record ? "今日已打卡" : "今日学习打卡",
      description: record ? "今天已经留下进度。你可以查看记录，也可以更新今日打卡。" : "记录一次学习动作，让长期趋势更完整。",
      icon: "graduation-cap",
      meta: `连续 ${record?.streak ?? streak} 天`,
      actions: [
        { label: "打开今日日记", icon: "book-open", onClick: () => void this.plugin.openTodayNote(false) },
        { label: "查看复盘", icon: "bar-chart-3", onClick: () => void this.plugin.activateReview() }
      ]
    });

    const grid = main.createDiv({ cls: "lifeos-checkin-page-grid" });
    this.renderForm(grid, record, streak, snapshot);
      this.renderSide(grid, record, streak);
    }, {
      preserveScroll,
      isCurrent: () => revision === this.renderRequestRevision
    });
  }

  private renderForm(parent: HTMLElement, record: CheckinRecord | null, streak: number, snapshot: CheckinFormSnapshot): void {
    const saved = this.plugin.settings.checkinDraft;
    const draft = saved?.date === snapshot.date && saved.root === snapshot.root ? saved : null;
    const metrics = getExamMetricProfiles(this.plugin.settings);
    const card = createCard(parent, "lifeos-panel lifeos-checkin-form-card");
    const header = card.createDiv({ cls: "lifeos-card-heading-row" });
    const title = header.createDiv({ cls: "lifeos-card-title" });
    setIcon(title.createSpan(), "clipboard-check");
    title.createSpan({ text: "今日记录" });
    header.createSpan({ cls: "lifeos-muted-text", text: record ? "保存会更新今日记录" : "填写后保存到本地 Vault" });

    const form = card.createDiv({ cls: "lifeos-checkin-form-page" });
    if (snapshot.historical) form.createEl("p", { text: `正在恢复 ${snapshot.date} 的草稿。保存只写回这一天；保存或明确放弃后才进入今天。`, cls: "lifeos-inline-status" });
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
    this.moodValue = draft?.mood || record?.mood || this.moodValue;
    const renderMoods = () => {
      moodRow.empty();
      for (const mood of MOODS) {
        const button = moodRow.createEl("button", {
          text: mood.label,
          cls: mood.key === this.moodValue ? "is-active" : "",
          attr: { type: "button" }
        });
        button.onclick = () => {
          if (this.saving) return;
          this.moodValue = mood.key;
          persist();
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
    summary.value = draft?.summary ?? record?.summary ?? "";
    summary.maxLength = 16000;
    if (draft) { duration.value = draft.duration; tasksCompleted.value = draft.tasks; xingceQuestions.value = draft.first; interviewPractice.value = draft.second; }
    const persist = () => {
      // A read started while the form was clean may still be awaiting I/O.
      // Invalidate it before it can mount a new CAS base over this draft.
      this.renderRequestRevision += 1;
      this.plugin.settings.checkinDraft = { date: snapshot.date, root: snapshot.root, original: snapshot.original,
        duration: duration.value, tasks: tasksCompleted.value, first: xingceQuestions.value, second: interviewPractice.value,
        mood: this.moodValue, summary: summary.value };
      if (this.draftTimer !== null) window.clearTimeout(this.draftTimer);
      this.draftTimer = window.setTimeout(() => { this.draftTimer = null; void this.plugin.saveSettings().catch(() => new Notice("草稿保存失败，请勿关闭当前页面。")); }, 300);
    };
    for (const input of [duration, tasksCompleted, xingceQuestions, interviewPractice, summary]) input.oninput = persist;

    const actions = card.createDiv({ cls: "lifeos-card-actions lifeos-checkin-actions" });
    createButton(actions, "取消", () => void this.plugin.activateDashboard(), { ghost: true, icon: "arrow-left" });
    if (draft) createButton(actions, "放弃草稿并读取最新", () => { if (this.saving || !window.confirm("放弃未保存的打卡草稿？")) return; const prior = this.plugin.settings.checkinDraft; this.plugin.settings.checkinDraft = null; void this.plugin.saveSettings().then(() => this.render()).catch(error => { this.plugin.settings.checkinDraft = prior; new Notice(String(error)); }); }, { ghost: true });
    if (this.receipt) createButton(actions, "撤销上次保存", () => void (async () => { try { await undoGuardedDocument(this.app, this.receipt!); this.receipt = null; await this.render(); } catch (error) { new Notice(String(error)); } })(), { ghost: true, icon: "undo-2" });
    createButton(actions, snapshot.historical ? "保存历史草稿" : record ? "更新今日打卡" : "完成今日打卡", () => void this.submit(duration, tasksCompleted, xingceQuestions, interviewPractice, summary, record?.streak ?? streak, Boolean(record), snapshot, card), {
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
    isUpdate: boolean,
    snapshot: CheckinFormSnapshot,
    form: HTMLElement
  ): Promise<void> {
    if (this.saving) return;
    if (snapshot.root !== this.plugin.getRoot()) { new Notice("资料根目录已变化，请重新打开页面核对；草稿未丢弃。"); return; }
    if (snapshot.date !== today() && !snapshot.historical) { new Notice("日期已切换，昨天的草稿仍保留。重新进入打卡页面可恢复并保存到原日期。"); return; }
    if (snapshot.historical && !window.confirm(`将草稿保存回 ${snapshot.date}，不写入今天，确认吗？`)) return;
    if ([duration, tasksCompleted, xingceQuestions, interviewPractice].some(input => !Number.isFinite(Number(input.value)) || Number(input.value) < 0 || Number(input.value) > 1_000_000)) { new Notice("请输入 0–1000000 之间的有效数值。"); return; }
    if (isUpdate && !window.confirm("今天已经打卡。确认更新今日打卡内容吗？")) return;
    const date = snapshot.date;
    const streak = isUpdate ? currentStreak : currentStreak + 1;
    const summaryText = summary.value.trim() || "今天也完成了一次稳定的学习记录。";
    const content = this.buildCheckinMarkdown(date, streak, {
      duration: Number(duration.value) || 0,
      tasksCompleted: Number(tasksCompleted.value) || 0,
      xingceQuestions: Number(xingceQuestions.value) || 0,
      interviewPractice: Number(interviewPractice.value) || 0,
      mood: this.moodValue,
      summary: summaryText
    });

    this.saving = true;
    const inputs = Array.from(form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input, textarea, button"));
    inputs.forEach(input => input.disabled = true);
    try {
      this.receipt = await saveGuardedDocument(this.app, snapshot.path, snapshot.original, content);
      this.plugin.settings.checkinDraft = null;
      if (this.draftTimer !== null) { window.clearTimeout(this.draftTimer); this.draftTimer = null; }
      await this.plugin.saveSettings();
      new Notice(`已核对保存：${snapshot.path}`, 5000);
      if (!this.closed) await this.render();
    } catch (error) { new Notice(`保存未完成：${error instanceof Error ? error.message : String(error)}`, 7000); }
    finally { this.saving = false; inputs.forEach(input => input.disabled = false); }
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
    const content = await this.app.vault.read(file);
    if (!content.trim()) return null;
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
      // Empty CAS undo receipts are not checkins, even if the metadata cache is stale.
      const record = await this.readRecord(file);
      if (record) dates.add(record.date);
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
