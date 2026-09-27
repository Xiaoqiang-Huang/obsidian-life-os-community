import { App, TFile } from "obsidian";
import { FileSystemService } from "./FileSystemService";
import { TaskService } from "./TaskService";
import { withTaskWrite, waitForTaskWrites, type TaskWriteDraft } from "./task-write-coordinator";
import { normalizeTaskIdentityTitle, parseTaskLine, parseOpenTasks, dedupTaskLines } from "../tasks/task-actions";
import { formatDate } from "../utils/dates";

export interface TaskSuggestion {
  id: string;
  line: string;
  sourcePath: string;
  sourceKind: "daily" | "project" | "conversation";
  createdOn: string;
}
interface SuggestionState {
  version: 1;
  pending: TaskSuggestion[];
  /** Hashed semantic identities persist across source/date/ID changes. */
  decided: string[];
  days: Record<string, number>;
}
export interface SuggestionPolicy { dailyLimit: number; sourceLimit: number; paused?: boolean }
const MAX_PENDING = 100, MAX_DECISIONS = 10000;
export const taskSuggestionPath = (root: string): string => `${root}/archive/task-suggestions.json`;
export function normalizeTaskSuggestionDailyLimit(value: unknown): number {
  if (value === undefined || value === null || String(value).trim() === "") return 5;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(50, Math.max(0, n)) : 5;
}
function emptyState(): SuggestionState { return { version: 1, pending: [], decided: [], days: {} }; }
function decode(text: string): SuggestionState {
  if (!text) return emptyState(); // Includes coordinator rollback of a newly created file.
  if (text.length > 2_000_000) throw new Error("候选记录超过安全上限，未继续自动提取。");
  const s = JSON.parse(text) as SuggestionState;
  if (s?.version !== 1 || !Array.isArray(s.pending) || s.pending.length > MAX_PENDING
    || !Array.isArray(s.decided) || s.decided.length > MAX_DECISIONS || !s.days || typeof s.days !== "object" || Array.isArray(s.days)
    || s.decided.some(id => !/^[a-f0-9]{64}$/.test(id))
    || Object.entries(s.days).some(([day, count]) => !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isSafeInteger(count) || count < 0)
    || s.pending.some(p => !p || !/^[a-f0-9]{64}$/.test(p.id) || typeof p.line !== "string" || p.line.length > 8000
      || !parseTaskLine(p.line)?.isOpen || /[\r\n]/.test(p.line) || typeof p.sourcePath !== "string"
      || !["daily", "project", "conversation"].includes(p.sourceKind) || !/^\d{4}-\d{2}-\d{2}$/.test(p.createdOn))
    || new Set(s.pending.map(p => p.id)).size !== s.pending.length) throw new Error("候选记录损坏或版本不支持，未重置或重新提取。");
  return s;
}
async function identity(line: string): Promise<string> {
  const task = parseTaskLine(line)!;
  const project = line.match(/\bproject:([^\s^]+)/u)?.[1] ?? "";
  const value = `${project}\n${normalizeTaskIdentityTitle(task.title.replace(/\s+(?:project|source):[^\s^]+/giu, ""))}`;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, "0")).join("");
}

/** Background suggestions are not tasks. Budget, decisions and accepted tasks commit together. */
export class TaskSuggestionService {
  constructor(private app: App, private fs: FileSystemService, private day: () => string = () => formatDate()) {}
  private get root(): string { return this.fs.path("Tasks"); }
  private async state(draft?: TaskWriteDraft): Promise<SuggestionState> {
    const path = taskSuggestionPath(this.root);
    if (draft) return draft.exists(path) ? decode(await draft.read(await draft.file(path))) : emptyState();
    await waitForTaskWrites(this.app, this.root);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file && !(file instanceof TFile)) throw new Error("候选记录路径被目录占用。");
    return file ? decode(await this.app.vault.read(file as TFile)) : emptyState();
  }
  async snapshot(): Promise<{ pending: TaskSuggestion[]; usedToday: number }> {
    const s = await this.state();
    return { pending: s.pending, usedToday: s.days[this.day()] ?? 0 };
  }
  async propose(lines: string[], source: Pick<TaskSuggestion, "sourcePath" | "sourceKind">, policy: SuggestionPolicy) {
    const limit = normalizeTaskSuggestionDailyLimit(policy.dailyLimit);
    if (policy.paused || limit === 0) return { added: [], remaining: 0, paused: true };
    if (!source.sourcePath || /[\r\n\u0000]/u.test(source.sourcePath)) throw new Error("候选任务缺少有效来源。");
    const result = await withTaskWrite(this.app, this.root, "suggest-tasks", async draft => {
      const s = await this.state(draft), day = this.day();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("候选预算日期无效。");
      const used = s.days[day] ?? 0;
      const allowance = Math.min(Math.max(0, limit - used), MAX_PENDING - s.pending.length,
        Math.max(0, Math.min(50, Math.floor(Number.isFinite(policy.sourceLimit) ? policy.sourceLimit : 3))));
      if (!allowance || s.decided.length >= MAX_DECISIONS) return { added: [], remaining: Math.max(0, limit - used), paused: false };
      const service = new TaskService(this.app, this.fs, draft);
      const openPath = this.fs.path("Tasks", "open.md"), donePath = this.fs.path("Tasks", "done.md");
      const existing = [openPath, donePath];
      let canonical = "";
      for (const path of existing) if (draft.exists(path)) canonical += "\n" + await draft.read(await draft.file(path));
      const eligible = await service.filterSuppressedAutomaticTaskLines(lines.filter(line => line.length <= 8000 && !/[\r\n]/.test(line) && parseTaskLine(line)?.isOpen));
      const novel = dedupTaskLines(eligible, parseOpenTasks(canonical.replace(/\[x\]/gi, "[ ]")));
      const canonicalIds = await Promise.all(parseOpenTasks(canonical.replace(/\[x\]/gi, "[ ]")).map(task => identity(task.line)));
      const known = new Set([...s.decided, ...s.pending.map(p => p.id), ...canonicalIds]), added: TaskSuggestion[] = [];
      for (const line of novel) {
        const id = await identity(line);
        if (known.has(id)) continue;
        known.add(id); added.push({ id, line, ...source, createdOn: day });
        if (added.length >= allowance) break;
      }
      if (added.length) {
        s.pending.push(...added); s.days[day] = used + added.length;
        // Calendar history is bounded, but rejection identities are never silently evicted.
        s.days = Object.fromEntries(Object.entries(s.days).sort(([a], [b]) => b.localeCompare(a)).slice(0, 366));
        await draft.modify(await draft.file(taskSuggestionPath(this.root)), JSON.stringify(s));
      }
      return { added, remaining: Math.max(0, limit - used - added.length), paused: false };
    });
    return { ...result.value, receipt: result.receipt };
  }
  async decide(ids: string[], decision: "accept" | "reject") {
    if (decision !== "accept" && decision !== "reject") throw new Error("候选处理方式无效。");
    const result = await withTaskWrite(this.app, this.root, `suggestions-${decision}`, async draft => {
      const s = await this.state(draft), selected = new Set(ids);
      const pending = s.pending.filter(p => selected.has(p.id));
      if (!pending.length) return { added: [] as string[], handled: 0, skipped: ids.length };
      if (s.decided.length + pending.length > MAX_DECISIONS) throw new Error("已达候选历史容量，请导出并人工整理；未丢弃忽略记录。");
      const canonicalIds = new Set<string>();
      for (const name of ["open.md", "done.md"]) {
        const path = this.fs.path("Tasks", name);
        if (!draft.exists(path)) continue;
        for (const task of parseOpenTasks((await draft.read(await draft.file(path))).replace(/\[x\]/gi, "[ ]"))) canonicalIds.add(await identity(task.line));
      }
      const novel = pending.filter(p => !canonicalIds.has(p.id));
      const added = decision === "accept" ? await new TaskService(this.app, this.fs, draft).appendAutomaticTasks(novel.map(p => p.line)) : [];
      s.pending = s.pending.filter(p => !selected.has(p.id));
      s.decided = [...new Set([...s.decided, ...pending.map(p => p.id)])];
      await draft.modify(await draft.file(taskSuggestionPath(this.root)), JSON.stringify(s));
      return { added, handled: pending.length, skipped: ids.length - pending.length };
    });
    return { ...result.value, receipt: result.receipt };
  }
}
