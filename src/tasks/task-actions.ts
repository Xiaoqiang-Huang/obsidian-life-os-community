import { App, TFile } from "obsidian";
import { ensureFile, formatDate } from "../utils";
import { completeTaskMarkdown } from "../services/lifeos-logic";

export interface ParsedTask {
  line: string;
  title: string;
  tags: string[];
  dueDate?: string;
  carriedFromDate?: string;
  blockId?: string;
  isOpen: boolean;
}

/** Parse a markdown task line like "- [ ] Do something #pls/task 📌 2026-05-14 📅 2026-05-15 ^abc123" */
export function parseTaskLine(line: string): ParsedTask | null {
  const trimmed = line.trim();
  const openMatch = trimmed.match(/^-\s*\[([ x])\]\s+(.+)$/);
  if (!openMatch) return null;

  const isOpen = openMatch[1] === " ";
  const body = openMatch[2];

  // Extract block ID: ^block-id or ^block-id at end
  const blockMatch = body.match(/\^(\S+)$/);
  const blockId = blockMatch ? blockMatch[1] : undefined;
  const bodyWithoutBlock = blockMatch ? body.slice(0, blockMatch.index).trim() : body;

  // Extract due date: 📅 YYYY-MM-DD
  const dueMatch = bodyWithoutBlock.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
  const dueDate = dueMatch ? dueMatch[1] : undefined;

  // Extract carryover source date: 📌 YYYY-MM-DD
  const carriedMatch = bodyWithoutBlock.match(/📌\s*(\d{4}-\d{2}-\d{2})/);
  const carriedFromDate = carriedMatch ? carriedMatch[1] : undefined;

  // Extract tags: #tag or #nested/tag (supports Unicode chars like Chinese)
  const tagRegex = /#([^\s^📅📌]+)/g;
  const tags: string[] = [];
  let match;
  while ((match = tagRegex.exec(bodyWithoutBlock)) !== null) {
    tags.push(match[1]);
  }

  // Extract title: remove tags, due date, carryover marker, block ID
  let title = bodyWithoutBlock;
  title = title.replace(/\^(\S+)$/, "").trim();
  title = title.replace(/📅\s*\d{4}-\d{2}-\d{2}/, "").trim();
  title = title.replace(/📌\s*\d{4}-\d{2}-\d{2}/, "").trim();
  title = title.replace(/#[^\s^📅📌]+/g, "").trim();

  return { line: trimmed, title, tags, dueDate, carriedFromDate, blockId, isOpen };
}

/** Check if a new task duplicates an existing one by comparing normalized titles */
export function findDuplicateTask(
  newTitle: string,
  existingTasks: ParsedTask[]
): ParsedTask | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const newNorm = norm(newTitle);
  return existingTasks.find((t) => norm(t.title) === newNorm);
}

/** Deduplicate AI-extracted task lines against existing tasks in open.md */
export function dedupTaskLines(
  newLines: string[],
  existingTasks: ParsedTask[]
): string[] {
  return newLines.filter((line) => {
    const parsed = parseTaskLine(line);
    if (!parsed) return true; // Keep non-task lines
    return !findDuplicateTask(parsed.title, existingTasks);
  });
}

/** Parse all open tasks from open.md */
export function parseOpenTasks(content: string): ParsedTask[] {
  return content
    .split(/\r?\n/)
    .map((line) => parseTaskLine(line))
    .filter((t): t is ParsedTask => t !== null && t.isOpen);
}

/** Complete a task: mark [x] in open.md. Returns true if the task was actually updated. */
export async function completeAndArchiveTask(
  app: App,
  taskLine: string,
  openPath: string,
  donePath: string
): Promise<boolean> {
  const openFile = await ensureFile(app, openPath, "# Open Tasks\n\n");
  const doneFile = await ensureFile(app, donePath, "# Done Tasks\n\n");
  if (!(openFile instanceof TFile)) return false;
  if (!(doneFile instanceof TFile)) return false;

  const openContent = await app.vault.read(openFile);
  const doneContent = await app.vault.read(doneFile);
  const now = new Date();
  const completedAt = `${formatDate(now)} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const result = completeTaskMarkdown(openContent, doneContent, taskLine, completedAt);

  if (result.openContent === openContent && result.doneContent === doneContent) return false;
  await app.vault.modify(openFile, result.openContent);
  await app.vault.modify(doneFile, result.doneContent);
  return true;
}

/** Find all task lines with #pls/task across the vault */
export function findAllTasks(app: App, basePath: string): TFile[] {
  const prefix = basePath.endsWith("/") ? basePath : basePath + "/";
  return app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix));
}

/** Get task completion stats: open, done today, overdue */
export function getTaskStats(tasks: ParsedTask[]): {
  total: number;
  overdue: number;
  dueToday: number;
} {
  const today = formatDate();
  let overdue = 0;
  let dueToday = 0;

  for (const task of tasks) {
    if (task.dueDate) {
      if (task.dueDate === today) dueToday++;
      else if (task.dueDate < today) overdue++;
    }
  }

  return { total: tasks.length, overdue, dueToday };
}
