import { App, TFile } from "obsidian";
import { today } from "../utils/dates";
import { ensureFile, readFile } from "../utils/vault";
import { FileSystemService } from "./FileSystemService";
import { buildDailyReviewMarkdown } from "./lifeos-logic";
import { DailyNoteService } from "./DailyNoteService";
import type { PersonalLifeSystemSettings } from "../settings";

export type ReviewSummaryPeriod = "Daily" | "Weekly" | "Monthly" | "Yearly";

export interface SummaryInfo {
  title: string;
  path: string;
  basename: string;
}

export class ReviewService {
  constructor(private app: App, private fs: FileSystemService, private settings?: PersonalLifeSystemSettings) {}

  async generateDailyReview(date = today()): Promise<TFile> {
    const dailyContent = await readFile(this.app, new DailyNoteService(this.app, this.fs, this.settings).getTodayNotePath(date));
    const openTasks = (await readFile(this.app, this.fs.path("Tasks", "open.md")))
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith("- [ ]"));
    const doneTasks = (await readFile(this.app, this.fs.path("Tasks", "done.md")))
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith("- [x]"));
    const checkinContent = await readFile(this.app, this.fs.path("Exam", "Checkins", `${date}.md`));
    const targetPath = this.fs.path("Memory", "Summaries", "Daily", `${date}.md`);
    const file = await ensureFile(this.app, targetPath, "");
    await this.app.vault.modify(file, buildDailyReviewMarkdown({ date, dailyContent, openTasks, doneTasks, checkinContent }));
    return file;
  }

  async generateSummary(period: ReviewSummaryPeriod, date = today()): Promise<TFile> {
    if (period === "Daily") return this.generateDailyReview(date);

    const window = this.periodWindow(period, date);
    const key = this.summaryKey(period, date);
    const targetPath = this.fs.path("Memory", "Summaries", period, `${key}.md`);
    const file = await ensureFile(this.app, targetPath, "");
    const content = await this.buildPeriodSummaryMarkdown(period, key, window);
    await this.app.vault.modify(file, content);
    return file;
  }

  listSummaries(period: ReviewSummaryPeriod): SummaryInfo[] {
    const prefix = this.fs.path("Memory", "Summaries", period) + "/";
    return this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(prefix))
      .sort((a, b) => b.basename.localeCompare(a.basename))
      .map((file) => ({ title: file.basename, path: file.path, basename: file.basename }));
  }

  async readHighlight(date = today()): Promise<string[]> {
    const content = await readFile(this.app, this.fs.path("Memory", "Summaries", "Daily", `${date}.md`));
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .slice(0, 4);
  }

  private async buildPeriodSummaryMarkdown(
    period: Exclude<ReviewSummaryPeriod, "Daily">,
    key: string,
    window: { start: string; end: string }
  ): Promise<string> {
    const dailySummaries = await this.collectDailySummaries(window);
    const doneTasks = (await readFile(this.app, this.fs.path("Tasks", "done.md")))
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith("- [x]"))
      .slice(-20);
    const title = period === "Weekly" ? "本周回顾" : period === "Monthly" ? "月度总结" : "年度脉络";
    const lines = [
      `# ${title}：${key}`,
      "",
      `- 范围：${window.start} 至 ${window.end}`,
      `- 生成时间：${new Date().toISOString()}`,
      "",
      "## 已有日复盘",
      dailySummaries.length > 0
        ? dailySummaries.map((item) => `- [[${item.basename}]]：${item.excerpt}`).join("\n")
        : "- 暂无日复盘。建议先生成几天日复盘，再回来看周期总结。",
      "",
      "## 完成任务摘录",
      doneTasks.length > 0 ? doneTasks.join("\n") : "- 暂无已归档任务。",
      "",
      "## 下一步",
      "- 检查哪些主题反复出现，决定是否转为任务、知识库条目或长期记忆。",
      "- 如果这里缺少内容，优先补齐当期日记和任务状态，再重新生成本页。"
    ];
    return `${lines.join("\n")}\n`;
  }

  private async collectDailySummaries(window: { start: string; end: string }): Promise<Array<{ basename: string; excerpt: string }>> {
    return Promise.all(
      this.listSummaries("Daily")
        .filter((item) => item.basename >= window.start && item.basename <= window.end)
        .slice(0, 31)
        .map(async (item) => {
          const content = await readFile(this.app, item.path);
          const excerpt = content
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.startsWith("- ") || line.startsWith("## ")) ?? "已有复盘";
          return { basename: item.basename, excerpt: excerpt.replace(/^#+\s*/, "").slice(0, 120) };
        })
    );
  }

  private summaryKey(period: Exclude<ReviewSummaryPeriod, "Daily">, date: string): string {
    const current = new Date(`${date}T00:00:00`);
    if (period === "Monthly") return date.slice(0, 7);
    if (period === "Yearly") return date.slice(0, 4);
    return `${current.getFullYear()}-W${String(this.isoWeek(current)).padStart(2, "0")}`;
  }

  private periodWindow(period: Exclude<ReviewSummaryPeriod, "Daily">, date: string): { start: string; end: string } {
    const current = new Date(`${date}T00:00:00`);
    if (period === "Yearly") return { start: `${current.getFullYear()}-01-01`, end: `${current.getFullYear()}-12-31` };
    if (period === "Monthly") {
      const start = new Date(current.getFullYear(), current.getMonth(), 1);
      const end = new Date(current.getFullYear(), current.getMonth() + 1, 0);
      return { start: this.formatLocalDate(start), end: this.formatLocalDate(end) };
    }
    const day = current.getDay() || 7;
    const start = new Date(current);
    start.setDate(current.getDate() - day + 1);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start: this.formatLocalDate(start), end: this.formatLocalDate(end) };
  }

  private isoWeek(date: Date): number {
    const current = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    current.setUTCDate(current.getUTCDate() + 4 - (current.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(current.getUTCFullYear(), 0, 1));
    return Math.ceil((((current.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  }

  private formatLocalDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
}
