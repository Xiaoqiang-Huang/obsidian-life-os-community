import { App, TFile } from "obsidian";
import { ensureFolder } from "../utils/vault";
import { randomId } from "../utils/ids";

// One local Vault / task directory is the consistency boundary. All TaskService
// instances (including Agent channels) must enter this queue BEFORE reading.
// This is not a distributed lock across independent Obsidian processes/devices.
interface WriterState { tail: Promise<void>; pending: number; ready: boolean; movedTo?: string }
const writers = new WeakMap<object, Map<string, WriterState>>();
const MAX_JOURNAL_CHARS = 16 * 1024 * 1024;
interface Change { path: string; before: string | null; after: string; beforeHash: string; afterHash: string }
interface Journal {
  version: 1; root: string; id: string; operation: string;
  phase: "prepared" | "committed" | "rolled-back";
  changes: Change[];
}
export interface TaskWriteReceipt { id: string; status: "committed" | "no-change"; paths: string[] }
export class TaskWriteError extends Error {
  constructor(message: string, public readonly journalPath: string, public readonly recoveryRequired: boolean, public readonly indexPending = false) {
    super(`${message}${recoveryRequired && !indexPending ? `；任务写入已暂停，请保留并检查恢复记录：${journalPath}` : ""}`);
    this.name = "TaskWriteError";
  }
}
class TaskIndexNotReadyError extends Error {
  constructor(path: string) {
    super(`任务文件索引尚未就绪，请稍后重试；未写入：${path}`);
    this.name = "TaskIndexNotReadyError";
  }
}
/** Typed readiness state, never inferred from arbitrary error text. */
export function isTaskIndexPending(error: unknown): boolean {
  return error instanceof TaskIndexNotReadyError || (error instanceof TaskWriteError && error.indexPending);
}

function checkedRoot(root: string): string {
  if (!root || /[\\:\u0000-\u001f]/u.test(root) || root.split("/").some(p => !p || p === "." || p === "..")) {
    throw new Error("无效的任务目录，未写入。");
  }
  return root;
}
// Keep JSON content in an indexed Markdown file so Vault.process remains the
// compare-and-set boundary even when unsupported JSON files are not indexed.
export function taskJournalPath(root: string): string { return `${checkedRoot(root)}/archive/task-write-journal.md`; }
export function canonicalTaskRoot(path: string): string | null {
  return path.match(/^((?:.*\/)?(?:Tasks|任务))\/(?:open|done)\.md$/u)?.[1] ?? null;
}

/** Generic approved file edits still use the canonical task writer boundary. */
export async function writeCanonicalTaskFile(
  app: App, path: string, transform: (current: string) => string, expected?: string | null,
  onCommitted?: (before: string, after: string) => void
): Promise<boolean> {
  if (/\/(?:Tasks|任务)\/archive\/(?:task-write-journal\.(?:json|md)|task-suggestions\.json|deleted-task-index\.md)$/u.test(path)) {
    throw new Error("任务恢复记录与删除索引不能通过通用写回修改。");
  }
  const root = canonicalTaskRoot(path);
  if (!root) return false;
  let snapshot: [string, string] | undefined;
  await withTaskWrite(app, root, "approved-file-edit", async draft => {
    if (expected === null && draft.exists(path)) throw new Error(`文件已存在，未覆盖：${path}`);
    if (typeof expected === "string" && !draft.exists(path)) throw new Error(`原文件已被删除，请重新预览：${path}`);
    const file = await draft.file(path);
    const original = await draft.read(file);
    if (typeof expected === "string" && original !== expected) throw new Error(`文件已变化，请重新预览：${path}`);
    const after = transform(original);
    await draft.modify(file, after);
    snapshot = [original, after];
  });
  if (snapshot) onCommitted?.(...snapshot);
  return true;
}
function checkTarget(root: string, path: string): void {
  if (!path.startsWith(`${root}/`)) throw new Error("恢复目标超出当前任务目录。");
  const relative = path.slice(root.length + 1);
  if (!["open.md", "done.md", "archive/deleted-task-index.md", "archive/task-suggestions.json"].includes(relative)
    && !/^archive\/(?:open|done)-backup-\d{4}-\d{2}-\d{2}-\d+(?:-\d+)?\.md$/u.test(relative)) {
    throw new Error(`不支持的任务写入目标：${path}`);
  }
}
function stateFor(app: App, root: string): WriterState {
  checkedRoot(root);
  let roots = writers.get(app.vault);
  if (!roots) writers.set(app.vault, roots = new Map());
  let state = roots.get(root);
  if (!state) roots.set(root, state = { tail: Promise.resolve(), pending: 0, ready: false });
  return state;
}
function enqueue<T>(state: WriterState, run: () => Promise<T>): Promise<T> {
  state.pending++;
  const result = state.tail.then(run);
  state.tail = result.then(() => { state.pending--; }, () => { state.pending--; state.ready = false; });
  return result;
}
function requireCurrentDirectory(state: WriterState): void {
  if (state.movedTo) throw new Error(`任务目录已移动到 ${state.movedTo}，请刷新页面后重试；未在旧目录写入。`);
}
async function digest(value: string | null): Promise<string> {
  const bytes = new TextEncoder().encode(value === null ? "absent:" : `text:${value}`);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, "0")).join("");
}
async function current(app: App, path: string): Promise<string | null> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!file) {
    // A cold Vault index can lag behind disk. Never journal an existing file as absent.
    if (await app.vault.adapter?.exists?.(path)) {
      throw new TaskIndexNotReadyError(path);
    }
    return null;
  }
  if (!(file instanceof TFile)) throw new Error(`任务目标不是文件：${path}`);
  const text = await app.vault.read(file);
  if (file.path !== path || app.vault.getAbstractFileByPath(path) !== file) throw new Error(`读取期间文件被移动：${path}`);
  return text;
}
// Never fall back to read + modify: that silently reintroduces lost updates.
function checkRecoveryCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("任务恢复检查已取消；尚未开始恢复写入。");
}
async function compareAndSet(app: App, path: string, before: string | null, after: string, signal?: AbortSignal): Promise<void> {
  checkRecoveryCancellation(signal);
  if (typeof app.vault.process !== "function") throw new Error("当前 Obsidian 不支持安全任务写入，请升级后重试。");
  const file = app.vault.getAbstractFileByPath(path);
  if (before === null) {
    if (file) throw new Error(`文件已被创建，未覆盖：${path}`);
    await ensureFolder(app, path.slice(0, path.lastIndexOf("/")));
    checkRecoveryCancellation(signal);
    await app.vault.create(path, after);
  } else {
    if (!(file instanceof TFile)) {
      // Classify only, never write through the adapter. Changed content,
      // actual deletion, directory replacement and read errors stay blocked.
      const adapter = app.vault.adapter;
      if (!file && await adapter?.exists?.(path)) {
        const stat = await adapter.stat(path);
        if (stat?.type === "file" && stat.size <= MAX_JOURNAL_CHARS * 4) {
          const text = await adapter.read(path), next = await adapter.stat(path);
          if (text === before && next?.type === "file" && next.size === stat.size && next.mtime === stat.mtime
            && await adapter.read(path) === before) throw new TaskIndexNotReadyError(path);
        }
      }
      throw new Error(`文件已被删除或替换：${path}`);
    }
    checkRecoveryCancellation(signal);
    await app.vault.process(file, value => {
      // Obsidian can queue process() itself. Cancellation before this atomic
      // callback must still prevent the first persisted compensation.
      checkRecoveryCancellation(signal);
      if (file.path !== path || app.vault.getAbstractFileByPath(path) !== file || value !== before) {
        throw new Error(`文件内容已变化，未覆盖：${path}`);
      }
      return after;
    });
  }
  if (await current(app, path) !== after) throw new Error(`写入后校验不一致：${path}`);
}
function encode(journal: Journal): string {
  const text = JSON.stringify(journal);
  if (text.length > MAX_JOURNAL_CHARS) throw new Error("任务操作记录过大，请分批处理；任务文件尚未修改。");
  return text;
}
async function decode(text: string, root: string): Promise<Journal> {
  if (text.length > MAX_JOURNAL_CHARS) throw new Error("任务恢复记录超过大小限制。");
  const j = JSON.parse(text) as Journal;
  if (!j || j.version !== 1 || typeof j.root !== "string" || !/^[\w-]{1,100}$/u.test(j.id)
    || typeof j.operation !== "string" || j.operation.length > 100
    || !["prepared", "committed", "rolled-back"].includes(j.phase)
    || !Array.isArray(j.changes) || j.changes.length === 0 || j.changes.length > 8) {
    throw new Error("任务恢复记录格式或版本不支持。");
  }
  checkedRoot(j.root);
  // A completed receipt may move with the built-in English/Chinese folder
  // migration. Never replay a prepared transaction from another scope.
  if (j.root !== root && (j.phase === "prepared"
    || j.root.replace(/(?:Tasks|任务)$/u, "") !== root.replace(/(?:Tasks|任务)$/u, "")
    || !/(?:^|\/)(?:Tasks|任务)$/u.test(j.root) || !/(?:^|\/)(?:Tasks|任务)$/u.test(root))) {
    throw new Error("任务恢复记录不属于当前目录。");
  }
  const paths = new Set<string>();
  for (const change of j.changes) {
    if (!change || typeof change.path !== "string" || paths.has(change.path)
      || (change.before !== null && typeof change.before !== "string") || typeof change.after !== "string") {
      throw new Error("任务恢复记录的文件状态无效。");
    }
    checkTarget(j.root, change.path); paths.add(change.path);
    if (await digest(change.before) !== change.beforeHash || await digest(change.after) !== change.afterHash) {
      throw new Error("任务恢复记录校验失败，未修改任务文件。");
    }
  }
  return j;
}
function isBefore(change: Change, value: string | null): boolean {
  // A newly created file is restored to empty, not deleted: Obsidian has no
  // compare-and-delete primitive. This avoids deleting a concurrent user edit.
  return value === change.before || (change.before === null && value === "");
}
async function rollback(app: App, j: Journal, signal?: AbortSignal): Promise<boolean> {
  // Preflight ALL targets before compensation. Unknown/user-edited content is
  // never overwritten; keep the full prepared record and block further writes.
  const values = await Promise.all(j.changes.map(c => current(app, c.path)));
  if (j.changes.some((c, i) => !isBefore(c, values[i]) && values[i] !== c.after)) {
    throw new Error("任务文件存在外部修改，需要人工核对，未覆盖修改内容。");
  }
  checkRecoveryCancellation(signal);
  let started = false;
  for (let i = j.changes.length - 1; i >= 0; i--) {
    const c = j.changes[i];
    if (!isBefore(c, values[i])) {
      await compareAndSet(app, c.path, c.after, c.before ?? "", started ? undefined : signal);
      // Once compensation has persisted, drain the remaining guarded writes
      // and receipt even if the plugin unloads; never abort halfway on purpose.
      started = true;
    }
  }
  return started;
}
/** Recovery inspection only. Cold Markdown indices can lag just like old JSON receipts.
 * All content is decoded and hash-checked; prepared receipts still require indexed CAS.
 * Never use this helper for task edits or adapter.write as a weaker CAS fallback.
 */
async function readRecoveryReceipt(app: App, path: string): Promise<string | null> {
  if (app.vault.getAbstractFileByPath(path)) {
    try { return await current(app, path); }
    catch (error) {
      // The lookup can disappear between this check and current(). Only a
      // proven disk-present/index-pending state permits read-only inspection.
      // File movement, changed identity and I/O errors remain hard failures.
      if (!(error instanceof TaskIndexNotReadyError)) throw error;
    }
  }
  const adapter = app.vault.adapter;
  if (!await adapter?.exists?.(path)) return null;
  const stat = await adapter.stat(path);
  if (!stat || stat.type !== 'file' || stat.size > MAX_JOURNAL_CHARS * 4) throw new Error('任务恢复记录过大或不是文件，未修改。');
  const text = await adapter.read(path);
  const after = await adapter.stat(path);
  if (!after || after.type !== 'file' || after.size !== stat.size || after.mtime !== stat.mtime
    || text.length > MAX_JOURNAL_CHARS || await adapter.read(path) !== text) throw new Error('读取期间任务恢复记录变化，未修改。');
  return text;
}
async function recover(app: App, root: string, signal?: AbortSignal): Promise<void> {
  checkRecoveryCancellation(signal);
  let path = taskJournalPath(root);
  try {
    let text = await readRecoveryReceipt(app, path);
    if (text === null) {
      path = root + '/archive/task-write-journal.json';
      text = await readRecoveryReceipt(app, path);
    }
    checkRecoveryCancellation(signal);
    if (text === null) return;
    const j = await decode(text, root);
    if (j.phase !== "prepared") return;
    if (!(app.vault.getAbstractFileByPath(path) instanceof TFile)) {
      throw new TaskIndexNotReadyError(path);
    }
    const values = await Promise.all(j.changes.map(c => current(app, c.path)));
    let compensationStarted = false;
    if (j.changes.every((c, i) => values[i] === c.after)) j.phase = "committed";
    else { compensationStarted = await rollback(app, j, signal); j.phase = "rolled-back"; }
    await compareAndSet(app, path, text, encode(j), compensationStarted ? undefined : signal);
  } catch (error) {
    if (isTaskIndexPending(error)) {
      throw new TaskWriteError(`任务恢复正在等待索引：${error instanceof Error ? error.message : String(error)}`, path, true, true);
    }
    throw new TaskWriteError(`任务恢复失败：${error instanceof Error ? error.message : String(error)}`, path, true);
  }
}
export async function recoverTaskWrites(app: App, root: string, signal?: AbortSignal): Promise<void> {
  const state = stateFor(app, root);
  return enqueue(state, async () => { checkRecoveryCancellation(signal); requireCurrentDirectory(state); await recover(app, root, signal); state.ready = true; });
}
export async function waitForTaskWrites(app: App, root: string): Promise<void> {
  const state = stateFor(app, root);
  requireCurrentDirectory(state);
  if (!state.ready || state.pending > 0) await recoverTaskWrites(app, root);
}
export async function migrateTaskDirectory(app: App, from: string, to: string, move: () => Promise<void>): Promise<void> {
  if (from === to) return;
  const roots = [from, to].sort();
  await enqueue(stateFor(app, roots[0]), () => enqueue(stateFor(app, roots[1]), async () => {
    await recover(app, from);
    await recover(app, to);
    // Ordinary directory merge renames collisions to open_2.md. That would
    // silently hide a canonical task list. Keep both scopes intact instead;
    // cross-scope task reconciliation needs its own explicit user decision.
    for (const name of ["open.md", "done.md", "archive/deleted-task-index.md", "archive/task-suggestions.json"]) {
      if (await current(app, `${from}/${name}`) !== null && await current(app, `${to}/${name}`) !== null) {
        throw new Error(`目标任务目录已有 ${name}，未合并或移动任务；请先核对 ${from} 与 ${to} 的冲突文件。`);
      }
    }
    await move();
    stateFor(app, from).ready = false;
    stateFor(app, from).movedTo = to;
    stateFor(app, to).ready = false;
    stateFor(app, to).movedTo = undefined;
  }));
}

export interface TaskDraftFile { path: string }
/** Explicit in-memory write plan. These methods never modify the Vault. */
export class TaskWriteDraft {
  private entries = new Map<string, { before: string | null; after: string }>();
  constructor(private app: App, private root: string) {}
  exists(path: string): boolean { return this.entries.has(path) || !!this.app.vault.getAbstractFileByPath(path); }
  async file(path: string, fallback = ""): Promise<TaskDraftFile> {
    checkTarget(this.root, path);
    if (!this.entries.has(path)) {
      const before = await current(this.app, path);
      this.entries.set(path, { before, after: before ?? fallback });
    }
    return { path };
  }
  async read(file: TaskDraftFile): Promise<string> {
    if (!this.entries.has(file.path)) await this.file(file.path);
    return this.entries.get(file.path)!.after;
  }
  async modify(file: TaskDraftFile, text: string): Promise<void> {
    if (!this.entries.has(file.path)) await this.file(file.path);
    this.entries.get(file.path)!.after = text;
  }
  async append(file: TaskDraftFile, text: string): Promise<void> { await this.modify(file, (await this.read(file)) + text); }
  async create(path: string, text: string): Promise<void> {
    if (this.exists(path)) throw new Error(`备份文件已存在：${path}`);
    await this.modify(await this.file(path), text);
  }
  async commit(operation: string): Promise<TaskWriteReceipt> {
    const changes: Change[] = [];
    for (const [path, e] of this.entries) {
      if (await current(this.app, path) !== e.before) throw new Error(`文件内容已变化，任务未写入：${path}`);
      if (e.before !== e.after) changes.push({ path, ...e, beforeHash: await digest(e.before), afterHash: await digest(e.after) });
    }
    if (!changes.length) return { id: "", status: "no-change", paths: [] };
    if (changes.length > 8) throw new Error("单次任务写入文件过多，请分批操作。");
    // Archive bytes must exist before the canonical task file is cleared.
    changes.sort((a, b) => Number(b.path.includes("-backup-")) - Number(a.path.includes("-backup-")));
    const j: Journal = { version: 1, root: this.root, id: randomId("task-write"), operation, phase: "prepared", changes };
    const path = taskJournalPath(this.root), prepared = encode(j);
    // Failures here cannot remove any task; a post-create rejection leaves an
    // all-before journal which the next recovery safely terminates.
    await compareAndSet(this.app, path, await current(this.app, path), prepared);
    try {
      for (const c of changes) await compareAndSet(this.app, c.path, c.before, c.after);
      for (const [target, e] of this.entries) {
        if (await current(this.app, target) !== e.after) throw new Error(`提交期间文件已变化：${target}`);
      }
      await compareAndSet(this.app, path, prepared, encode({ ...j, phase: "committed" }));
      return { id: j.id, status: "committed", paths: changes.map(c => c.path) };
    } catch (error) {
      let recoveryRequired = false;
      try {
        const journalText = await current(this.app, path);
        // An acknowledgement may have reached disk before its Promise rejects.
        // Verify it rather than rolling back underneath a committed receipt.
        if (journalText === encode({ ...j, phase: "committed" })) {
          // Every target was verified before this exact receipt was persisted.
          // A subsequent human edit does not undo that historical commit and
          // must not be rolled back or misreported as an unresolved transaction.
          return { id: j.id, status: "committed", paths: changes.map(c => c.path) };
        }
        if (journalText !== prepared) throw new Error("恢复记录已变化");
        await rollback(this.app, j);
        await compareAndSet(this.app, path, journalText, encode({ ...j, phase: "rolled-back" }));
      } catch { recoveryRequired = true; }
      throw new TaskWriteError(`${error instanceof Error ? error.message : String(error)}${recoveryRequired ? "" : "；本次任务写入已回滚。"}`, path, recoveryRequired);
    }
  }
}
export async function withTaskWrite<T>(app: App, root: string, operation: string, run: (draft: TaskWriteDraft) => Promise<T>): Promise<{ value: T; receipt: TaskWriteReceipt }> {
  const state = stateFor(app, root);
  return enqueue(state, async () => {
    requireCurrentDirectory(state);
    await recover(app, root);
    const draft = new TaskWriteDraft(app, root);
    const value = await run(draft);
    const receipt = await draft.commit(operation);
    state.ready = true;
    return { value, receipt };
  });
}
