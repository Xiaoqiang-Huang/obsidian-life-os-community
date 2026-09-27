import { App, type TFile } from "obsidian";
import type { LifeOSTask } from "../types";
import { parseTaskLine } from "../utils/markdown";
import { TaskWriteDraft, withTaskWrite, waitForTaskWrites, recoverTaskWrites, type TaskWriteReceipt } from "./task-write-coordinator";
import { dedupTaskLines, parseOpenTasks } from "../tasks/task-actions";
import { FileSystemService } from "./FileSystemService";
import { carryoverOpenTasks, completeTaskMarkdown, deleteTaskMarkdown, undoTaskMarkdown } from "./lifeos-logic";
import { randomId } from "../utils/ids";
import { formatDate, formatTime } from "../utils/dates";
import { readVaultSnapshot, throwIfReadAborted } from "../utils/vault-read-cache";
import {
  appendTaskDeletionMarkers,
  filterSuppressedTaskLines,
  removeTaskDeletionMarker
} from "./task-deletion-ledger";

const OPEN_TASKS_FALLBACK = "# 未完成待办\n\n";
const DONE_TASKS_FALLBACK = "# 已完成待办\n\n";
const DELETED_TASK_INDEX_FALLBACK = [
  "# 已删除任务索引",
  "",
  "> Life OS 自动维护。这里只保存不可逆哈希，不保存任务正文。",
  ""
].join("\n");

export interface TaskBatchResult {
  receipt?: TaskWriteReceipt;
  succeeded: number;
  failed: Array<{ task: LifeOSTask; reason: string }>;
}

export interface TaskArchiveClearResult {
  cleared: number;
  openPath: string;
  backupPath: string;
}

export interface CompletedTaskArchiveClearResult {
  cleared: number;
  donePath: string;
  backupPath: string;
}

export type TaskLane = "today" | "open" | "done";

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
  constructor(private app: App, private fs: FileSystemService, private transaction?: TaskWriteDraft) {}

  private get tx(): TaskWriteDraft {
    if (!this.transaction) throw new Error("任务写入必须先进入协调层。");
    return this.transaction;
  }

  private async write<T>(operation: string, run: (service: TaskService) => Promise<T>): Promise<T> {
    const result = await withTaskWrite(this.app, this.fs.path("Tasks"), operation,
      draft => run(new TaskService(this.app, this.fs, draft)));
    if (result.value && typeof result.value === "object" && "succeeded" in result.value) {
      Object.assign(result.value, { receipt: result.receipt });
    }
    return result.value;
  }

  async recoverPendingWrites(signal?: AbortSignal): Promise<void> {
    await recoverTaskWrites(this.app, this.fs.path("Tasks"), signal);
  }

  async loadOpenTasks(signal?: AbortSignal): Promise<LifeOSTask[]> {
    return this.readTasks("open.md", "open", signal).then((tasks) => tasks.filter((task) => !task.isDone));
  }

  async loadDoneTasks(signal?: AbortSignal): Promise<LifeOSTask[]> {
    return this.readTasks("done.md", "done", signal);
  }

  async loadAllTasks(signal?: AbortSignal): Promise<LifeOSTask[]> {
    const [open, done] = await Promise.all([this.readTasks("open.md", "open", signal), this.readTasks("done.md", "done", signal)]);
    return [...open, ...done];
  }

  async completeTask(task: LifeOSTask): Promise<string> {
    if (!this.transaction) return this.write("complete-task", service => service.completeTask(task));
    const openFile = await this.tx.file(this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const doneFile = await this.tx.file(this.fs.path("Tasks", "done.md"), DONE_TASKS_FALLBACK);
    const openContent = await this.tx.read(openFile);
    const doneContent = await this.tx.read(doneFile);
    this.requireCurrentTask(openContent, task.line);
    const result = completeTaskMarkdown(
      openContent,
      doneContent,
      task.line,
      `${formatDate()} ${formatTime()}`
    );
    if (result.openContent === openContent) {
      throw new Error("待办已变化或已不存在，请重新查看待办后操作。");
    }
    await this.recordDeletedTaskLines([task.line]);
    await this.tx.modify(openFile, result.openContent);
    await this.tx.modify(doneFile, result.doneContent);
    return result.doneLine;
  }

  async moveTaskToLane(task: LifeOSTask, lane: TaskLane, _activeDate = formatDate()): Promise<string> {
    if (!this.transaction) return this.write("move-task", service => service.moveTaskToLane(task, lane, _activeDate));
    if (lane === "done") {
      if (task.source === "done" || task.isDone) return task.line;
      return this.completeTask(task);
    }

    if (task.source === "open" && !task.isDone) {
      const openFile = await this.tx.file(this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
      const lines = (await this.tx.read(openFile)).split(/\r?\n/u);
      const index = this.findTaskLineIndex(lines, task.line);
      if (index < 0) throw new Error("待办已变化或已不存在，请重新查看待办后操作。");
      const nextLine = this.applyLaneToLine(lines[index], lane);
      if (nextLine !== lines[index]) {
        lines[index] = nextLine;
        await this.tx.modify(openFile, lines.join("\n"));
      }
      await this.unsuppressTaskLine(nextLine);
      return nextLine;
    }

    const openFile = await this.tx.file(this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const doneFile = await this.tx.file(this.fs.path("Tasks", "done.md"), DONE_TASKS_FALLBACK);
    const openContent = await this.tx.read(openFile);
    const doneContent = await this.tx.read(doneFile);
    const restored = undoTaskMarkdown(openContent, doneContent, task.line);
    this.requireCurrentTask(doneContent, task.line);
    if (restored.doneContent === doneContent) {
      throw new Error("已完成任务已变化或已不存在，请重新查看待办后操作。");
    }
    const openLines = restored.openContent.split(/\r?\n/u);
    const restoredIndex = this.findTaskLineIndex(openLines, restored.openLine);
    if (restoredIndex < 0) throw new Error("任务已恢复，但无法设置目标分组，请重新加载后再试。");
    const nextLine = this.applyLaneToLine(openLines[restoredIndex], lane);
    openLines[restoredIndex] = nextLine;
    await this.tx.modify(openFile, openLines.join("\n"));
    await this.tx.modify(doneFile, restored.doneContent);
    await this.unsuppressTaskLine(nextLine);
    return nextLine;
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
    if (!this.transaction) return this.write("create-task", service => service.createTask(data));
    const title = data.title.trim();
    if (!title) throw new Error("任务标题不能为空");
    const file = await this.tx.file(this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const tags = ["#pls/task"];
    if (data.category?.trim()) tags.push(`#${data.category.trim().replace(/\s+/g, "-")}`);
    if (data.priority?.trim() && data.priority.trim() !== "普通") tags.push(`#priority/${data.priority.trim()}`);
    const due = data.dueDate?.trim() ? ` 📅 ${data.dueDate.trim()}` : "";
    const project = data.projectId?.trim() ? ` project:${data.projectId.trim()}` : "";
    const source = data.source?.trim() ? ` source:${data.source.trim()}` : "";
    const note = data.note?.trim() ? `\n  - note: ${data.note.trim().replace(/\r?\n/g, " ")}` : "";
    const line = `- [ ] ${title} ${tags.join(" ")}${project}${due}${source} ^${randomId("task")}${note}\n`;
    await this.tx.append(file, line);
    await this.unsuppressTaskLine(line);
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
    if (!this.transaction) return this.write("update-task", service => service.updateTask(task, data));
    const title = data.title.trim();
    if (!title) throw new Error("任务标题不能为空");
    const file = await this.taskFile(task.source);
    const content = await this.tx.read(file);
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
    await this.recordDeletedTaskLines([sourceLine]);
    await this.tx.modify(file, lines.join("\n"));
    await this.unsuppressTaskLine(nextLine);
    return nextLine;
  }

  async deleteOpenTask(task: LifeOSTask): Promise<void> {
    return this.deleteTask(task);
  }

  async deleteTask(task: LifeOSTask): Promise<void> {
    if (!this.transaction) return this.write("delete-task", service => service.deleteTask(task));
    const file = await this.taskFile(task.source);
    const content = await this.tx.read(file);
    this.requireCurrentTask(content, task.line);
    const result = deleteTaskMarkdown(content, task.line);
    if (!result.removed) throw new Error("待办已变化或已不存在，请重新查看待办后操作。");
    await this.recordDeletedTaskLines([task.line]);
    await this.tx.modify(file, result.content);
  }

  async undoCompleteTask(originalOpenLine: string): Promise<void> {
    if (!this.transaction) return this.write("undo-completion", service => service.undoCompleteTask(originalOpenLine));
    const openFile = await this.tx.file(this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const doneFile = await this.tx.file(this.fs.path("Tasks", "done.md"), DONE_TASKS_FALLBACK);
    const openContent = await this.tx.read(openFile);
    const doneContent = await this.tx.read(doneFile);
    // The toast holds the pre-completion line, while the completed card holds
    // the done line. Only checkbox/date changes are implicit in an undo; a
    // changed title or metadata needs a fresh user decision.
    const normalizeUndoLine = (line: string) => line.trim()
      .replace(/^-\s*\[[ xX]\]/u, "- [ ]")
      .replace(/\s*✅\s*20\d{2}-\d{2}-\d{2}/gu, "")
      .replace(/\s+/gu, " ");
    const completedLines = doneContent.split(/\r?\n/u).filter(line =>
      /^-\s*\[[xX]\]/u.test(line.trim()) && normalizeUndoLine(line) === normalizeUndoLine(originalOpenLine));
    if (completedLines.length !== 1) throw new Error("已完成任务已变化或已不存在，请重新查看后恢复。");
    this.requireCurrentTask(doneContent, completedLines[0]);
    const result = undoTaskMarkdown(
      openContent,
      doneContent,
      completedLines[0]
    );
    if (result.doneContent === doneContent) {
      throw new Error("已完成任务已变化或已不存在，请重新查看待办后操作。");
    }
    await this.tx.modify(openFile, result.openContent);
    await this.tx.modify(doneFile, result.doneContent);
    await this.unsuppressTaskLine(result.openLine);
  }

  async batchCompleteTasks(tasks: LifeOSTask[]): Promise<TaskBatchResult> {
    if (!this.transaction) return this.write("batch-complete", service => service.batchCompleteTasks(tasks));
    const selected = this.uniqueTasks(tasks).filter((task) => task.source === "open" && !task.isDone);
    if (selected.length === 0) return { succeeded: 0, failed: [] };
    const openFile = await this.tx.file(this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const doneFile = await this.tx.file(this.fs.path("Tasks", "done.md"), DONE_TASKS_FALLBACK);
    let openContent = await this.tx.read(openFile);
    let doneContent = await this.tx.read(doneFile);
    const failed: TaskBatchResult["failed"] = [];
    const completedLines: string[] = [];
    let succeeded = 0;
    const completedAt = `${formatDate()} ${formatTime()}`;
    for (const task of selected) {
      if (this.findTaskLineIndex(openContent.split(/\r?\n/u), task.line) < 0) {
        failed.push({ task, reason: "任务已变化或已不存在" });
        continue;
      }
      const result = completeTaskMarkdown(openContent, doneContent, task.line, completedAt);
      if (result.openContent === openContent) {
        failed.push({ task, reason: "任务已变化或已不存在" });
        continue;
      }
      openContent = result.openContent;
      doneContent = result.doneContent;
      completedLines.push(task.line);
      succeeded += 1;
    }
    if (succeeded > 0) {
      await this.recordDeletedTaskLines(completedLines);
      await this.tx.modify(openFile, openContent);
      await this.tx.modify(doneFile, doneContent);
    }
    return { succeeded, failed };
  }

  async batchRestoreTasks(tasks: LifeOSTask[]): Promise<TaskBatchResult> {
    if (!this.transaction) return this.write("batch-restore", service => service.batchRestoreTasks(tasks));
    const selected = this.uniqueTasks(tasks).filter((task) => task.source === "done" || task.isDone);
    if (selected.length === 0) return { succeeded: 0, failed: [] };
    const openFile = await this.tx.file(this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const doneFile = await this.tx.file(this.fs.path("Tasks", "done.md"), DONE_TASKS_FALLBACK);
    let openContent = await this.tx.read(openFile);
    let doneContent = await this.tx.read(doneFile);
    const failed: TaskBatchResult["failed"] = [];
    const restoredLines: string[] = [];
    let succeeded = 0;
    for (const task of selected) {
      if (this.findTaskLineIndex(doneContent.split(/\r?\n/u), task.line) < 0) {
        failed.push({ task, reason: "任务已变化或已不存在" });
        continue;
      }
      const removable = deleteTaskMarkdown(doneContent, task.line);
      if (!removable.removed) {
        failed.push({ task, reason: "任务已变化或已不存在" });
        continue;
      }
      const result = undoTaskMarkdown(openContent, doneContent, task.line);
      openContent = result.openContent;
      doneContent = result.doneContent;
      restoredLines.push(result.openLine);
      succeeded += 1;
    }
    if (succeeded > 0) {
      await this.tx.modify(openFile, openContent);
      await this.tx.modify(doneFile, doneContent);
      await this.unsuppressTaskLines(restoredLines);
    }
    return { succeeded, failed };
  }

  async batchDeleteTasks(tasks: LifeOSTask[]): Promise<TaskBatchResult> {
    if (!this.transaction) return this.write("batch-delete", service => service.batchDeleteTasks(tasks));
    const selected = this.uniqueTasks(tasks);
    if (selected.length === 0) return { succeeded: 0, failed: [] };
    const openFile = await this.tx.file(this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const doneFile = await this.tx.file(this.fs.path("Tasks", "done.md"), DONE_TASKS_FALLBACK);
    let openContent = await this.tx.read(openFile);
    let doneContent = await this.tx.read(doneFile);
    const failed: TaskBatchResult["failed"] = [];
    const deletedLines: string[] = [];
    let succeeded = 0;
    let openChanged = false;
    let doneChanged = false;
    for (const task of selected) {
      const current = task.source === "done" ? doneContent : openContent;
      if (this.findTaskLineIndex(current.split(/\r?\n/u), task.line) < 0) {
        failed.push({ task, reason: "任务已变化或已不存在" });
        continue;
      }
      const result = deleteTaskMarkdown(current, task.line);
      if (!result.removed) {
        failed.push({ task, reason: "任务已变化或已不存在" });
        continue;
      }
      if (task.source === "done") {
        doneContent = result.content;
        doneChanged = true;
      } else {
        openContent = result.content;
        openChanged = true;
      }
      deletedLines.push(task.line);
      succeeded += 1;
    }
    if (succeeded > 0) {
      await this.recordDeletedTaskLines(deletedLines);
      if (openChanged) await this.tx.modify(openFile, openContent);
      if (doneChanged) await this.tx.modify(doneFile, doneContent);
    }
    return { succeeded, failed };
  }

  /**
   * Clears the canonical open-task file only after preserving its exact
   * contents in Tasks/archive. Unfinished tasks are intentionally not moved
   * to done.md because that would falsify completion history.
   */
  async archiveAndClearOpenTasks(): Promise<TaskArchiveClearResult> {
    if (!this.transaction) return this.write("archive-open", service => service.archiveAndClearOpenTasks());
    const openPath = this.fs.path("Tasks", "open.md");
    const openFile = await this.tx.file(openPath, OPEN_TASKS_FALLBACK);
    const original = await this.tx.read(openFile);
    const unfinished = original
      .split(/\r?\n/u)
      .map((line) => parseTaskLine(line, "open"))
      .filter((task): task is LifeOSTask => task !== null && !task.isDone);
    if (unfinished.length === 0) return { cleared: 0, openPath, backupPath: "" };

    const archiveFolder = this.fs.path("Tasks", "archive");
    const stamp = `${formatDate()}-${formatTime().replace(/[^0-9]/gu, "") || "0000"}`;
    let backupPath = `${archiveFolder}/open-backup-${stamp}.md`;
    let suffix = 2;
    while (this.tx.exists(backupPath)) {
      backupPath = `${archiveFolder}/open-backup-${stamp}-${suffix}.md`;
      suffix += 1;
    }

    await this.tx.create(backupPath, original);
    await this.recordDeletedTaskLines(unfinished.map((task) => task.line));
    await this.tx.modify(openFile, OPEN_TASKS_FALLBACK);
    return { cleared: unfinished.length, openPath, backupPath };
  }

  /** Preserve the exact completed-task history before clearing the visible archive. */
  async archiveAndClearDoneTasks(): Promise<CompletedTaskArchiveClearResult> {
    if (!this.transaction) return this.write("archive-done", service => service.archiveAndClearDoneTasks());
    const donePath = this.fs.path("Tasks", "done.md");
    const doneFile = await this.tx.file(donePath, DONE_TASKS_FALLBACK);
    const original = await this.tx.read(doneFile);
    const completed = original
      .split(/\r?\n/u)
      .map((line) => parseTaskLine(line, "done"))
      .filter((task): task is LifeOSTask => task !== null && task.isDone);
    if (completed.length === 0) return { cleared: 0, donePath, backupPath: "" };

    const archiveFolder = this.fs.path("Tasks", "archive");
    const stamp = `${formatDate()}-${formatTime().replace(/[^0-9]/gu, "") || "0000"}`;
    let backupPath = `${archiveFolder}/done-backup-${stamp}.md`;
    let suffix = 2;
    while (this.tx.exists(backupPath)) {
      backupPath = `${archiveFolder}/done-backup-${stamp}-${suffix}.md`;
      suffix += 1;
    }

    await this.tx.create(backupPath, original);
    await this.tx.modify(doneFile, DONE_TASKS_FALLBACK);
    return { cleared: completed.length, donePath, backupPath };
  }

  /**
   * Automatic extraction and carryover must respect an explicit deletion,
   * including after the plugin or Obsidian has restarted.
   */
  async filterSuppressedAutomaticTaskLines(taskLines: string[]): Promise<string[]> {
    if (taskLines.length === 0) return [];
    const path = this.deletedTaskIndexPath();
    if (this.transaction) {
      if (!this.tx.exists(path)) return [...taskLines];
      return filterSuppressedTaskLines(taskLines, await this.tx.read(await this.tx.file(path)));
    }
    await waitForTaskWrites(this.app, this.fs.path("Tasks"));
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !file.path.endsWith(".md")) return [...taskLines];
    return filterSuppressedTaskLines(taskLines, await this.app.vault.read(file as TFile));
  }

  /** Re-check deletion and duplicate state INSIDE the writer lock at delivery. */
  async appendAutomaticTasks(taskLines: string[], heading = "", limit = taskLines.length): Promise<string[]> {
    if (!this.transaction) return this.write("automatic-tasks", service => service.appendAutomaticTasks(taskLines, heading, limit));
    const candidates = taskLines.filter(line => !!parseTaskLine(line, "open") && !parseTaskLine(line, "open")!.isDone);
    const file = await this.tx.file(this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const eligible = await this.filterSuppressedAutomaticTaskLines(candidates);
    const additions = dedupTaskLines(eligible, parseOpenTasks(await this.tx.read(file)))
      .slice(0, Math.max(0, Math.floor(Number.isFinite(limit) ? limit : 0)));
    if (additions.length) await this.tx.append(file, "\n" + (heading ? heading + "\n\n" : "") + additions.join("\n") + "\n");
    return additions;
  }

  async batchUpdateTasks(tasks: LifeOSTask[], update: TaskBatchUpdate): Promise<TaskBatchResult> {
    if (!this.transaction) return this.write("batch-update", service => service.batchUpdateTasks(tasks, update));
    const selected = this.uniqueTasks(tasks);
    if (selected.length === 0) return { succeeded: 0, failed: [] };

    const openFile = await this.tx.file(this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const doneFile = await this.tx.file(this.fs.path("Tasks", "done.md"), DONE_TASKS_FALLBACK);
    const openLines = (await this.tx.read(openFile)).split(/\r?\n/u);
    const doneLines = (await this.tx.read(doneFile)).split(/\r?\n/u);
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

    if (openChanged) await this.tx.modify(openFile, openLines.join("\n"));
    if (doneChanged) await this.tx.modify(doneFile, doneLines.join("\n"));
    return { succeeded, failed };
  }

  async carryoverToTomorrow(today: string, tomorrow: string): Promise<number> {
    if (!this.transaction) return this.write("carryover", service => service.carryoverToTomorrow(today, tomorrow));
    const openFile = await this.tx.file(this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const result = carryoverOpenTasks(await this.tx.read(openFile), today, tomorrow);
    if (result.count > 0) {
      await this.tx.modify(openFile, result.content);
    }
    return result.count;
  }

  private async readTasks(fileName: "open.md" | "done.md", source: "open" | "done", signal?: AbortSignal): Promise<LifeOSTask[]> {
    throwIfReadAborted(signal);
    const path = this.fs.path("Tasks", fileName);
    await waitForTaskWrites(this.app, this.fs.path("Tasks"));
    throwIfReadAborted(signal);
    if (!this.app.vault.getAbstractFileByPath(path)) return [];
    const content = await readVaultSnapshot(this.app, path, signal);
    throwIfReadAborted(signal);
    return content
      .split(/\r?\n/)
      .map((line) => parseTaskLine(line, source))
      .filter((task): task is LifeOSTask => task !== null);
  }

  private async taskFile(source: LifeOSTask["source"]) {
    return this.tx.file(
      this.fs.path("Tasks", source === "done" ? "done.md" : "open.md"),
      source === "done" ? DONE_TASKS_FALLBACK : OPEN_TASKS_FALLBACK
    );
  }

  private deletedTaskIndexPath(): string {
    return this.fs.path("Tasks", "archive", "deleted-task-index.md");
  }

  private async recordDeletedTaskLines(taskLines: string[]): Promise<void> {
    if (taskLines.length === 0) return;
    const ledgerFile = await this.tx.file(this.deletedTaskIndexPath(), DELETED_TASK_INDEX_FALLBACK);
    const current = await this.tx.read(ledgerFile);
    const next = appendTaskDeletionMarkers(current, taskLines);
    if (next.added > 0) {
      await this.tx.append(ledgerFile, next.content.slice(current.length));
    }
  }

  private async unsuppressTaskLine(taskLine: string): Promise<void> {
    await this.unsuppressTaskLines([taskLine]);
  }

  private async unsuppressTaskLines(taskLines: string[]): Promise<void> {
    if (taskLines.length === 0) return;
    if (!this.tx.exists(this.deletedTaskIndexPath())) return;
    const ledgerFile = await this.tx.file(this.deletedTaskIndexPath());
    const current = await this.tx.read(ledgerFile);
    let content = current;
    let removed = false;
    for (const taskLine of taskLines) {
      const next = removeTaskDeletionMarker(content, taskLine);
      content = next.content;
      removed = removed || next.removed;
    }
    if (removed) {
      await this.tx.modify(ledgerFile, content);
    }
  }

  private findTaskLineIndex(lines: string[], taskLine: string): number {
    const matches = lines.map((line, index) => line.trim() === taskLine.trim() ? index : -1).filter(index => index >= 0);
    if (matches.length !== 1) return -1;
    const blockId = taskLine.trim().match(/\^([^\s]+)$/u)?.[1];
    if (blockId && lines.filter(line => line.trim().match(/\^([^\s]+)$/u)?.[1] === blockId).length !== 1) return -1;
    return matches[0];
  }

  private requireCurrentTask(content: string, taskLine: string): void {
    if (this.findTaskLineIndex(content.split(/\r?\n/u), taskLine) < 0) {
      throw new Error("待办已变化或已不存在，请重新查看待办后操作。");
    }
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

  private applyLaneToLine(line: string, lane: Exclude<TaskLane, "done">): string {
    const blockId = line.match(/\s+(\^[A-Za-z0-9_-]+)\s*$/u)?.[1] || "";
    const withoutBlockId = line.replace(/\s+\^[A-Za-z0-9_-]+\s*$/u, "").trimEnd();
    const withoutLane = withoutBlockId.replace(/\s+lane:(?:today|open)(?=\s|$)/gu, "");
    return `${withoutLane} lane:${lane}${blockId ? ` ${blockId}` : ""}`;
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
