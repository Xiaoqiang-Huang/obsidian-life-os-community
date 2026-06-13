import type { App, TFile } from "obsidian";
import type { HeatmapRange, PersonalLifeSystemSettings } from "../settings";
import { formatDate } from "../utils/dates";
import { extractQuickRecordEntries } from "../utils/quick-records";
import type { FileSystemService } from "./FileSystemService";

export interface DailyActivity {
  date: string;
  score: number;
  level: 0 | 1 | 2 | 3 | 4;
  dailyNoteExists: boolean;
  dailyRecordCount: number;
  completedTaskCount: number;
  checkinExists: boolean;
  summaryExists: boolean;
}

interface DailyNoteSignal {
  dailyRecordCount: number;
  hasLongBody: boolean;
}

export function rangeDates(rangeMode: HeatmapRange, end = new Date()): string[] {
  const count = rangeMode === "1y" ? 371 : rangeMode === "90d" ? 90 : 30;
  const dates: string[] = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    const date = new Date(end);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - index);
    dates.push(formatDate(date));
  }
  return dates;
}

export function countDailyRecordLines(markdown: string): number {
  return extractQuickRecordEntries(markdown).length;
}

export function countCompletedTasksForDate(doneMarkdown: string, date: string): number {
  return countCompletedTasksByDate(doneMarkdown).get(date) ?? 0;
}

export function countCompletedTasksByDate(doneMarkdown: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of doneMarkdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^-\s*\[[xX]\]/.test(trimmed)) continue;
    const dates = new Set(trimmed.match(/\d{4}-\d{2}-\d{2}/g) ?? []);
    for (const date of dates) {
      counts.set(date, (counts.get(date) ?? 0) + 1);
    }
  }
  return counts;
}

export function activityLevel(activity: Pick<DailyActivity, "score">): 0 | 1 | 2 | 3 | 4 {
  if (activity.score <= 0) return 0;
  if (activity.score <= 1) return 1;
  if (activity.score <= 3) return 2;
  if (activity.score <= 6) return 3;
  return 4;
}

export class ActivityService {
  private static dailySignalCache = new Map<string, { mtime: number; signal: DailyNoteSignal }>();

  constructor(private app: App, private fs: FileSystemService, private settings: PersonalLifeSystemSettings) {}

  async getDailyActivityMap(rangeMode = this.settings.heatmapRange): Promise<Map<string, DailyActivity>> {
    const dates = rangeDates(rangeMode);
    const doneContent = this.settings.heatmapIncludeTasks
      ? await readVaultFile(this.app, this.fs.path("Tasks", "done.md"))
      : "";
    const completedTasksByDate = this.settings.heatmapIncludeTasks
      ? countCompletedTasksByDate(doneContent)
      : new Map<string, number>();
    const result = new Map<string, DailyActivity>();

    for (const date of dates) {
      const dailyPath = this.dailyNotePath(date);
      const checkinPath = this.fs.path("Exam", "Checkins", `${date}.md`);
      const summaryPath = this.fs.path("Memory", "Summaries", "Daily", `${date}.md`);
      const dailyFile = this.app.vault.getAbstractFileByPath(dailyPath);
      const checkinFile = this.app.vault.getAbstractFileByPath(checkinPath);
      const summaryFile = this.app.vault.getAbstractFileByPath(summaryPath);

      const dailyNoteExists = isFileLike(dailyFile);
      const checkinExists = isFileLike(checkinFile);
      const summaryExists = isFileLike(summaryFile);
      const dailySignal = dailyNoteExists && this.settings.heatmapIncludeDaily
        ? await this.readDailySignal(dailyFile as TFile)
        : { dailyRecordCount: 0, hasLongBody: false };
      const dailyRecordCount = dailySignal.dailyRecordCount;
      const completedTaskCount = completedTasksByDate.get(date) ?? 0;

      let score = 0;
      if (this.settings.heatmapIncludeDaily && dailyNoteExists) {
        score += 1;
        if (dailyRecordCount > 0) score += 1;
        score += Math.min(3, dailyRecordCount);
        if (dailySignal.hasLongBody) score += 1;
      }
      if (this.settings.heatmapIncludeTasks) score += completedTaskCount;
      if (this.settings.heatmapIncludeCheckins && checkinExists) score += 1;
      if (this.settings.heatmapIncludeSummaries && summaryExists) score += 1;

      const activity: DailyActivity = {
        date,
        score,
        level: 0,
        dailyNoteExists,
        dailyRecordCount,
        completedTaskCount,
        checkinExists,
        summaryExists
      };
      activity.level = activityLevel(activity);
      result.set(date, activity);
    }

    return result;
  }

  private async readDailySignal(file: TFile): Promise<DailyNoteSignal> {
    const mtime = file.stat?.mtime ?? 0;
    const cached = ActivityService.dailySignalCache.get(file.path);
    if (cached && cached.mtime === mtime) return cached.signal;

    const vault = this.app.vault as App["vault"] & { cachedRead?: (file: TFile) => Promise<string> };
    const dailyContent = vault.cachedRead ? await vault.cachedRead(file) : await this.app.vault.read(file);
    const signal = {
      dailyRecordCount: countDailyRecordLines(dailyContent),
      hasLongBody: dailyContent.replace(/^---[\s\S]*?---\s*/m, "").trim().length > 120
    };
    ActivityService.dailySignalCache.set(file.path, { mtime, signal });
    return signal;
  }

  private dailyNotePath(date: string): string {
    const folder = this.settings.useDailyNotesPlugin ? getDailyNotesFolder(this.app) : "";
    return folder ? `${folder}/${date}.md` : this.fs.path("Daily", `${date}.md`);
  }
}

function isFileLike(value: unknown): value is TFile {
  return Boolean(value && typeof value === "object" && "path" in value && "basename" in value);
}

async function readVaultFile(app: App, filePath: string): Promise<string> {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!isFileLike(file)) return "";
  return app.vault.read(file);
}

function getDailyNotesFolder(app: App): string {
  const config = (app as unknown as {
    internalPlugins?: {
      plugins?: Record<string, { instance?: { options?: { folder?: string } } }>;
    };
  }).internalPlugins?.plugins?.["daily-notes"]?.instance?.options;
  return (config?.folder ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/").trim();
}
