import { App } from "obsidian";
import type { LifeOSTask } from "../types";
import { parseTaskLine } from "../utils/markdown";
import { ensureFile, ensureFolder, readFile } from "../utils/vault";
import { FileSystemService } from "./FileSystemService";
import { carryoverOpenTasks, completeTaskMarkdown, deleteTaskMarkdown, undoTaskMarkdown } from "./lifeos-logic";
import { randomId } from "../utils/ids";
import { formatDate, formatTime } from "../utils/dates";

const OPEN_TASKS_FALLBACK = "# 未完成待办\n\n";
const DONE_TASKS_FALLBACK = "# 已完成待办\n\n";

export interface TaskBatchResult {
  succeeded: number;
  failed: Array<{ task: LifeOSTask; reason: string }>;
}

export interface TaskArchiveClearResult {
  cleared: number;
  openPath: string;
  backupPath: string;
}

export interface TaskBatchUpdate {
  /** `undefined` keeps the original value, `null` clears it. */
  projectId?: string | null;
  /** `undefined` keeps the original value, `null` clears it. */
  dueDate?: string | null;
  /** `undefined` keeps the original value, `null`/`普通` clears the priority tag. */
  priority?: string | null;
  addTags?: string[];
  removeTags?: string[];
}

export class TaskService {
  constructor(private app: App, private fs: FileSystemService) {}

  async loadOpenTasks(): Promise<LifeOSTask[]> {
    return this.readTasks("open.md", "open").then((tasks) => tasks.filter((task) => !task.isDone));
  }

  async loadDoneTasks(): Promise<LifeOSTask[]> {
    return this.readTasks("done.md", "done");
  }

  async loadAllTasks(): Promise<LifeOSTask[]> {
    const [open, done] = await Promise.all([this.readTasks("open.md", "open"), this.readTasks("done.md", "done")]);
    return [...open, ...done];
  }

  async completeTask(task: LifeOSTask): Promise<string> {
    const openFile = await ensureFile(this.app, this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const doneFile = await ensureFile(this.app, this.fs.path("Tasks", "done.md"), DONE_TASKS_FALLBACK);
    const result = completeTaskMarkdown(
      await this.app.vault.read(openFile),
      await this.app.vault.read(doneFile),
      task.line,
      `${formatDate()} ${formatTime()}`
    );
    await this.app.vault.modify(openFile, result.openContent);
    await this.app.vault.modify(doneFile, result.doneContent);
    return result.doneLine;
  }

  async createTask(data: {
    title: string;
    category?: string;
    dueDate?: string;
    priority?: string;
    projectId?: string;
    source?: string;
    note?: string;
  }): Promise<string> {
    const title = data.title.trim();
    if (!title) throw new Error("任务标题不能为空");
    const file = await ensureFile(this.app, this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const tags = ["#pls/task"];
    if (data.category?.trim()) tags.push(`#${data.category.trim().replace(/\s+/g, "-")}`);
    if (data.priority?.trim() && data.priority.trim() !== "普通") tags.push(`#priority/${data.priority.trim()}`);
    const due = data.dueDate?.trim() ? ` 📅 ${data.dueDate.trim()}` : "";
    const project = data.projectId?.trim() ? ` project:${data.projectId.trim()}` : "";
    const source = data.source?.trim() ? ` source:${data.source.trim()}` : "";
    const note = data.note?.trim() ? `\n  - note: ${data.note.trim().replace(/\r?\n/g, " ")}` : "";
    const line = `- [ ] ${title} ${tags.join(" ")}${project}${due}${source} ^${randomId("task")}${note}\n`;
    await this.app.vault.append(file, line);
    return line;
  }

  async updateOpenTask(
    task: LifeOSTask,
    data: { title: string; dueDate?: string }
  ): Promise<string> {
    return this.updateTask(task, data);
  }

  async updateTask(
    task: LifeOSTask,
    data: { title: string; dueDate?: string }
  ): Promise<string> {
    const title = data.title.trim();
    if (!title) throw new Error("任务标题不能为空");
    const file = await this.taskFile(task.source);
    const content = await this.app.vault.read(file);
    const lines = content.split(/\r?\n/u);
    const index = this.findTaskLineIndex(lines, task.line);
    if (index < 0) throw new Error("待办已变化或已不存在，请重新查看待办后操作。");

    const sourceLine = lines[index].trim();
    const body = sourceLine.replace(/^-\s*\[[ xX]\]\s+/u, "");
    if (!body.startsWith(task.text)) throw new Error("无法安全识别待办标题，未修改。");
    const blockId = body.match(/\s+(\^[^\s]+)\s*$/u)?.[1] || "";
    const metadata = body
      .slice(task.text.length)
      .replace(/\s*\^[^\s]+\s*$/u, "")
      .replace(/\s*📅\s*20\d{2}-\d{2}-\d{2}/gu, "")
      .trim();
    const existingDueDate = body.match(/📅\s*(20\d{2}-\d{2}-\d{2})/u)?.[1] || "";
    const nextDueDate = data.dueDate === undefined ? existingDueDate : data.dueDate.trim();
    const due = nextDueDate ? ` 📅 ${nextDueDate}` : "";
    const checkbox = task.source === "done" || task.isDone ? "x" : " ";
    const nextLine = `- [${checkbox}] ${title}${metadata ? ` ${metadata}` : ""}${due}${blockId ? ` ${blockId}` : ""}`;
    lines[index] = nextLine;
    await this.app.vault.modify(file, lines.join("\n"));
    return nextLine;
  }

  async deleteOpenTask(task: LifeOSTask): Promise<void> {
    return this.deleteTask(task);
  }

  async deleteTask(task: LifeOSTask): Promise<void> {
    const file = await this.taskFile(task.source);
    const content = await this.app.vault.read(file);
    const result = deleteTaskMarkdown(content, task.line);
    if (!result.removed) throw new Error("待办已变化或已不存在，请重新查看待办后操作。");
    await this.app.vault.modify(file, result.content);
  }

  async undoCompleteTask(originalOpenLine: string): Promise<void> {
    const openFile = await ensureFile(this.app, this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const doneFile = await ensureFile(this.app, this.fs.path("Tasks", "done.md"), DONE_TASKS_FALLBACK);
    const result = undoTaskMarkdown(
      await this.app.vault.read(openFile),
      await this.app.vault.read(doneFile),
      originalOpenLine
    );
    await this.app.vault.modify(openFile, result.openContent);
    await this.app.vault.modify(doneFile, result.doneContent);
  }

  async batchCompleteTasks(tasks: LifeOSTask[]): Promise<TaskBatchResult> {
    const selected = this.uniqueTasks(tasks).filter((task) => task.source === "open" && !task.isDone);
    if (selected.length === 0) return { succeeded: 0, failed: [] };
    const openFile = await ensureFile(this.app, this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const doneFile = await ensureFile(this.app, this.fs.path("Tasks", "done.md"), DONE_TASKS_FALLBACK);
    let openContent = await this.app.vault.read(openFile);
    let doneContent = await this.app.vault.read(doneFile);
    const failed: TaskBatchResult["failed"] = [];
    let succeeded = 0;
    const completedAt = `${formatDate()} ${formatTime()}`;
    for (const task of selected) {
      const result = completeTaskMarkdown(openContent, doneContent, task.line, completedAt);
      if (result.openContent === openContent) {
        failed.push({ task, reason: "任务已变化或已不存在" });
        continue;
      }
      openContent = result.openContent;
      doneContent = result.doneContent;
      succeeded += 1;
    }
    if (succeeded > 0) {
      await this.app.vault.modify(openFile, openContent);
      await this.app.vault.modify(doneFile, doneContent);
    }
    return { succeeded, failed };
  }

  async batchRestoreTasks(tasks: LifeOSTask[]): Promise<TaskBatchResult> {
    const selected = this.uniqueTasks(tasks).filter((task) => task.source === "done" || task.isDone);
    if (selected.length === 0) return { succeeded: 0, failed: [] };
    const openFile = await ensureFile(this.app, this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const doneFile = await ensureFile(this.app, this.fs.path("Tasks", "done.md"), DONE_TASKS_FALLBACK);
    let openContent = await this.app.vault.read(openFile);
    let doneContent = await this.app.vault.read(doneFile);
    const failed: TaskBatchResult["failed"] = [];
    let succeeded = 0;
    for (const task of selected) {
      const removable = deleteTaskMarkdown(doneContent, task.line);
      if (!removable.removed) {
        failed.push({ task, reason: "任务已变化或已不存在" });
        continue;
      }
      const result = undoTaskMarkdown(openContent, doneContent, task.line);
      openContent = result.openContent;
      doneContent = result.doneContent;
      succeeded += 1;
    }
    if (succeeded > 0) {
      await this.app.vault.modify(openFile, openContent);
      await this.app.vault.modify(doneFile, doneContent);
    }
    return { succeeded, failed };
  }

  async batchDeleteTasks(tasks: LifeOSTask[]): Promise<TaskBatchResult> {
    const selected = this.uniqueTasks(tasks);
    if (selected.length === 0) return { succeeded: 0, failed: [] };
    const openFile = await ensureFile(this.app, this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const doneFile = await ensureFile(this.app, this.fs.path("Tasks", "done.md"), DONE_TASKS_FALLBACK);
    let openContent = await this.app.vault.read(openFile);
    let doneContent = await this.app.vault.read(doneFile);
    const failed: TaskBatchResult["failed"] = [];
    let succeeded = 0;
    for (const task of selected) {
      const current = task.source === "done" ? doneContent : openContent;
      const result = deleteTaskMarkdown(current, task.line);
      if (!result.removed) {
        failed.push({ task, reason: "任务已变化或已不存在" });
        continue;
      }
      if (task.source === "done") doneContent = result.content;
      else openContent = result.content;
      succeeded += 1;
    }
    if (succeeded > 0) {
      await this.app.vault.modify(openFile, openContent);
      await this.app.vault.modify(doneFile, doneContent);
    }
    return { succeeded, failed };
  }

  /**
   * Clears the canonical open-task file only after preserving its exact
   * contents in Tasks/archive. Unfinished tasks are intentionally not moved
   * to done.md because that would falsify completion history.
   */
  async archiveAndClearOpenTasks(): Promise<TaskArchiveClearResult> {
    const openPath = this.fs.path("Tasks", "open.md");
    const openFile = await ensureFile(this.app, openPath, OPEN_TASKS_FALLBACK);
    const original = await this.app.vault.read(openFile);
    const unfinished = original
      .split(/\r?\n/u)
      .map((line) => parseTaskLine(line, "open"))
      .filter((task): task is LifeOSTask => task !== null && !task.isDone);
    if (unfinished.length === 0) return { cleared: 0, openPath, backupPath: "" };

    const archiveFolder = this.fs.path("Tasks", "archive");
    await ensureFolder(this.app, archiveFolder);
    const stamp = `${formatDate()}-${formatTime().replace(/[^0-9]/gu, "") || "0000"}`;
    let backupPath = `${archiveFolder}/open-backup-${stamp}.md`;
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(backupPath)) {
      backupPath = `${archiveFolder}/open-backup-${stamp}-${suffix}.md`;
      suffix += 1;
    }

    await this.app.vault.create(backupPath, original);
    try {
      await this.app.vault.modify(openFile, OPEN_TASKS_FALLBACK);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`任务备份已保存到 ${backupPath}，但清空 open.md 失败：${message}`);
    }
    return { cleared: unfinished.length, openPath, backupPath };
  }

  async batchUpdateTasks(tasks: LifeOSTask[], update: TaskBatchUpdate): Promise<TaskBatchResult> {
    const selected = this.uniqueTasks(tasks);
    if (selected.length === 0) return { succeeded: 0, failed: [] };

    const openFile = await ensureFile(this.app, this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const doneFile = await ensureFile(this.app, this.fs.path("Tasks", "done.md"), DONE_TASKS_FALLBACK);
    const openLines = (await this.app.vault.read(openFile)).split(/\r?\n/u);
    const doneLines = (await this.app.vault.read(doneFile)).split(/\r?\n/u);
    const failed: TaskBatchResult["failed"] = [];
    let succeeded = 0;
    let openChanged = false;
    let doneChanged = false;

    for (const task of selected) {
      const lines = task.source === "done" ? doneLines : openLines;
      const index = this.findTaskLineIndex(lines, task.line);
      if (index < 0) {
        failed.push({ task, reason: "任务已变化或已不存在" });
        continue;
      }

      const current = lines[index];
      const next = this.applyBatchUpdateToLine(current, update);
      lines[index] = next;
      succeeded += 1;
      if (next !== current) {
        if (task.source === "done") doneChanged = true;
        else openChanged = true;
      }
    }

    if (openChanged) await this.app.vault.modify(openFile, openLines.join("\n"));
    if (doneChanged) await this.app.vault.modify(doneFile, doneLines.join("\n"));
    return { succeeded, failed };
  }

  async carryoverToTomorrow(today: string, tomorrow: string): Promise<number> {
    const openFile = await ensureFile(this.app, this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const result = carryoverOpenTasks(await this.app.vault.read(openFile), today, tomorrow);
    if (result.count > 0) {
      await this.app.vault.modify(openFile, result.content);
    }
    return result.count;
  }

  private async readTasks(fileName: "open.md" | "done.md", source: "open" | "done"): Promise<LifeOSTask[]> {
    const path = this.fs.path("Tasks", fileName);
    await ensureFile(this.app, path, fileName === "open.md" ? OPEN_TASKS_FALLBACK : DONE_TASKS_FALLBACK);
    const content = await readFile(this.app, path);
    return content
      .split(/\r?\n/)
      .map((line) => parseTaskLine(line, source))
      .filter((task): task is LifeOSTask => task !== null);
  }

  private async taskFile(source: LifeOSTask["source"]) {
    return ensureFile(
      this.app,
      this.fs.path("Tasks", source === "done" ? "done.md" : "open.md"),
      source === "done" ? DONE_TASKS_FALLBACK : OPEN_TASKS_FALLBACK
    );
  }

  private findTaskLineIndex(lines: string[], taskLine: string): number {
    const targetId = taskLine.match(/\^([A-Za-z0-9_-]+)/u)?.[1];
    return lines.findIndex((line) => {
      if (targetId) return line.match(/\^([A-Za-z0-9_-]+)/u)?.[1] === targetId;
      return line.trim() === taskLine.trim();
    });
  }

  private uniqueTasks(tasks: LifeOSTask[]): LifeOSTask[] {
    const seen = new Set<string>();
    return tasks.filter((task) => {
      const key = task.line.match(/\^([A-Za-z0-9_-]+)/u)?.[1]
        || `${task.source}:${task.line.trim()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private applyBatchUpdateToLine(line: string, update: TaskBatchUpdate): string {
    const blockId = line.match(/\s+(\^[A-Za-z0-9_-]+)\s*$/u)?.[1] || "";
    let next = line.replace(/\s+\^[A-Za-z0-9_-]+\s*$/u, "").trimEnd();

    if (update.projectId !== undefined) {
      next = next.replace(/\s+project:[A-Za-z0-9_-]+/gu, "");
      const projectId = this.cleanMetadataToken(update.projectId ?? "");
      if (projectId) next += ` project:${projectId}`;
    }

    if (update.dueDate !== undefined) {
      next = next.replace(/\s*📅\s*20\d{2}-\d{2}-\d{2}/gu, "");
      const dueDate = (update.dueDate ?? "").trim();
      if (dueDate) {
        if (!/^20\d{2}-\d{2}-\d{2}$/u.test(dueDate)) throw new Error(`无效截止日期：${dueDate}`);
        next += ` 📅 ${dueDate}`;
      }
    }

    if (update.priority !== undefined) {
      next = next.replace(/\s+#priority\/[^\s^]+/gu, "");
      const priority = this.cleanTag(update.priority ?? "");
      if (priority && priority !== "普通") next += ` #priority/${priority}`;
    }

    for (const rawTag of update.removeTags ?? []) {
      const tag = this.cleanTag(rawTag);
      if (!tag || tag === "pls/task") continue;
      next = next.replace(new RegExp(`\\s+#${this.escapeRegExp(tag)}(?=\\s|$)`, "gu"), "");
    }

    for (const rawTag of update.addTags ?? []) {
      const tag = this.cleanTag(rawTag);
      if (!tag || this.hasTag(next, tag)) continue;
      next += ` #${tag}`;
    }

    return `${next.trimEnd()}${blockId ? ` ${blockId}` : ""}`;
  }

  private cleanMetadataToken(value: string): string {
    return value.trim().replace(/\s+/gu, "-").replace(/[^A-Za-z0-9_-]/gu, "");
  }

  private cleanTag(value: string): string {
    return value.trim().replace(/^#+/u, "").replace(/\s+/gu, "-").replace(/[\s^#]/gu, "");
  }

  private hasTag(line: string, tag: string): boolean {
    return new RegExp(`(?:^|\\s)#${this.escapeRegExp(tag)}(?=\\s|$)`, "u").test(line);
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
}
