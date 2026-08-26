import { App } from "obsidian";
import type { LifeOSTask } from "../types";
import { parseTaskLine } from "../utils/markdown";
import { ensureFile, readFile } from "../utils/vault";
import { FileSystemService } from "./FileSystemService";
import { carryoverOpenTasks, completeTaskMarkdown, undoTaskMarkdown } from "./lifeos-logic";
import { randomId } from "../utils/ids";
import { formatDate, formatTime } from "../utils/dates";

const OPEN_TASKS_FALLBACK = "# 未完成待办\n\n";
const DONE_TASKS_FALLBACK = "# 已完成待办\n\n";

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
    const title = data.title.trim();
    if (!title) throw new Error("任务标题不能为空");
    const file = await ensureFile(this.app, this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const content = await this.app.vault.read(file);
    const lines = content.split(/\r?\n/u);
    const index = lines.findIndex((line) => line.trim() === task.line.trim());
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
    const nextDueDate = data.dueDate === undefined ? task.date : data.dueDate.trim();
    const due = nextDueDate ? ` 📅 ${nextDueDate}` : "";
    const nextLine = `- [ ] ${title}${metadata ? ` ${metadata}` : ""}${due}${blockId ? ` ${blockId}` : ""}`;
    lines[index] = nextLine;
    await this.app.vault.modify(file, lines.join("\n"));
    return nextLine;
  }

  async deleteOpenTask(task: LifeOSTask): Promise<void> {
    const file = await ensureFile(this.app, this.fs.path("Tasks", "open.md"), OPEN_TASKS_FALLBACK);
    const content = await this.app.vault.read(file);
    const lines = content.split(/\r?\n/u);
    const index = lines.findIndex((line) => line.trim() === task.line.trim());
    if (index < 0) throw new Error("待办已变化或已不存在，请重新查看待办后操作。");

    let end = index + 1;
    while (end < lines.length && /^(?:\s{2,}|\t)\S/u.test(lines[end])) end += 1;
    lines.splice(index, end - index);
    await this.app.vault.modify(file, lines.join("\n"));
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
}
