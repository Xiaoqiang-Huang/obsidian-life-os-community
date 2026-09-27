import { App, TFile } from "obsidian";
import type { WritebackItem } from "../writeback-preview";
import { dedupTaskLines, parseOpenTasks } from "../tasks/task-actions";
import { filterSuppressedTaskLines } from "./task-deletion-ledger";
import { canonicalTaskRoot, waitForTaskWrites, withTaskWrite, writeCanonicalTaskFile } from "./task-write-coordinator";

/** Bind task replacement approval to the bytes visible when its preview opens. */
export async function prepareTaskWritebackItems(app: App, items: WritebackItem[]): Promise<WritebackItem[]> {
  return Promise.all(items.map(async item => {
    const root = canonicalTaskRoot(item.targetPath);
    if (item.kind !== "replace" || item.expectedOriginal !== undefined) return { ...item };
    if (root) await waitForTaskWrites(app, root);
    const file = app.vault.getAbstractFileByPath(item.targetPath);
    if (file && !(file instanceof TFile)) throw new Error(`写回目标不是文件：${item.targetPath}`);
    const expectedOriginal = file instanceof TFile ? await app.vault.read(file) : null;
    if (file && (file.path !== item.targetPath || app.vault.getAbstractFileByPath(item.targetPath) !== file)) {
      throw new Error("预览读取期间任务文件已移动，请重试。");
    }
    return { ...item, expectedOriginal };
  }));
}

/** Returns false for non-task files so existing document writeback is unchanged. */
export async function applyCanonicalTaskWriteback(app: App, item: WritebackItem, appendOnly = false, requireComplete = false, onCommitted?: (before: string, after: string) => void): Promise<boolean> {
  const root = canonicalTaskRoot(item.targetPath);
  if (root && item.kind === "replace" && !appendOnly && item.expectedOriginal === undefined) {
    throw new Error("替换任务文件前需要重新预览原文，未覆盖任务。");
  }
  if (root && item.kind === "task" && item.targetPath === `${root}/open.md`) {
    // Candidate state may have changed while a preview was open. Recheck inside
    // the writer lock, retaining notes attached to each accepted task block.
    let snapshot: [string, string] | undefined;
    await withTaskWrite(app, root, "task-preview-append", async draft => {
      const blocks: Array<{ line: string; lines: string[] }> = [];
      const prefix: string[] = [];
      for (const line of item.content.split(/\r?\n/u)) {
        if (/^-\s*\[[ xX]\]\s+/u.test(line)) blocks.push({ line, lines: [line] });
        else if (blocks.length) blocks[blocks.length - 1].lines.push(line);
        else prefix.push(line);
      }
      const candidates = blocks.filter(b => /^-\s*\[ \]\s+/u.test(b.line)).map(b => b.line);
      if (!candidates.length) throw new Error("没有可写入的待办，请保留 - [ ] 任务格式后重试。");
      const file = await draft.file(item.targetPath, "# 未完成待办\n\n");
      const ledgerPath = `${root}/archive/deleted-task-index.md`;
      const ledger = draft.exists(ledgerPath) ? await draft.read(await draft.file(ledgerPath)) : "";
      const eligible = filterSuppressedTaskLines(candidates, ledger);
      const original = await draft.read(file);
      const accepted = new Set(dedupTaskLines(eligible, parseOpenTasks(original)));
      const kept = blocks.filter(b => accepted.delete(b.line));
      if (requireComplete && kept.length !== candidates.length) throw new Error("任务集合在预览后发生变化，请重新预览。本次未写入任何候选，也未写入依赖目标。");
      if (!kept.length) throw new Error("这些待办已存在或已被删除，本次没有新增；请取消此项或刷新预览后再试。");
      await draft.append(file, "\n" + [...prefix, ...kept.flatMap(b => b.lines)].join("\n") + "\n");
      snapshot = [original, await draft.read(file)];
    });
    if (snapshot) onCommitted?.(...snapshot);
    return true;
  }
  const replace = !appendOnly && item.kind === "replace";
  return writeCanonicalTaskFile(app, item.targetPath,
    current => replace ? item.content : current + item.content,
    replace ? item.expectedOriginal : undefined, onCommitted);
}
