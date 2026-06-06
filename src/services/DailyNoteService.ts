import { App, TFile } from "obsidian";
import { DEFAULT_LIGHT_DAILY_TEMPLATE, FULL_DAILY_TEMPLATE } from "../constants";
import type { PersonalLifeSystemSettings } from "../settings";
import { formatTime, today } from "../utils/dates";
import { ensureFile, readFile, joinPath, normalizePath } from "../utils/vault";
import { extractQuickRecordEntries } from "../utils/quick-records";
import { FileSystemService } from "./FileSystemService";

export class DailyNoteService {
  constructor(
    private app: App,
    private fs: FileSystemService,
    private settings?: PersonalLifeSystemSettings
  ) {}

  getTodayNotePath(date = today()): string {
    const dailyFolder = this.settings?.useDailyNotesPlugin ? this.getDailyNotesFolder() : null;
    return dailyFolder ? joinPath(dailyFolder, `${date}.md`) : this.fs.path("Daily", `${date}.md`);
  }

  exists(date = today()): boolean {
    return this.app.vault.getAbstractFileByPath(this.getTodayNotePath(date)) instanceof TFile;
  }

  async ensureTodayNote(date = today(), fullTemplate = false): Promise<TFile> {
    return ensureFile(this.app, this.getTodayNotePath(date), this.renderTemplate(date, fullTemplate));
  }

  async ensureToday(): Promise<TFile> {
    return this.ensureTodayNote(today(), false);
  }

  async readTodayNote(date = today()): Promise<string> {
    return readFile(this.app, this.getTodayNotePath(date));
  }

  async appendQuickRecord(content: string, date = today()): Promise<TFile> {
    const file = await this.ensureTodayNote(date);
    await this.app.vault.append(file, `\n## 快速记录\n- ${formatTime()} ${content}\n`);
    return file;
  }

  getRecentDailyNotes(days: number): TFile[] {
    return this.listDailyNotes().slice(-days).reverse();
  }

  async getDailyRecordCount(date = today()): Promise<number> {
    return extractQuickRecordEntries(await this.readTodayNote(date)).length;
  }

  listDailyNotes(): TFile[] {
    const roots = new Set<string>();
    const dailyFolder = this.settings?.useDailyNotesPlugin ? this.getDailyNotesFolder() : null;
    if (dailyFolder) roots.add(dailyFolder);
    roots.add(this.fs.path("Daily"));
    return this.app.vault.getMarkdownFiles()
      .filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file.name))
      .filter((file) => Array.from(roots).some((root) => file.path.startsWith(`${root}/`)))
      .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }

  private renderTemplate(date: string, fullTemplate: boolean): string {
    const template = fullTemplate ? FULL_DAILY_TEMPLATE : DEFAULT_LIGHT_DAILY_TEMPLATE;
    return template
      .replace(/\{\{date\}\}/g, date)
      .replace(/\{\{assistantName\}\}/g, this.settings?.assistantName || "Life OS");
  }

  private getDailyNotesFolder(): string | null {
    const config = (this.app as unknown as {
      internalPlugins?: {
        plugins?: Record<string, { instance?: { options?: { folder?: string } } }>;
      };
    }).internalPlugins?.plugins?.["daily-notes"]?.instance?.options;
    const folder = normalizePath(config?.folder ?? "");
    return folder || null;
  }
}
