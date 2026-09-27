import { App, TFile } from "obsidian";
import { saveGuardedDocument, type LocalEditReceipt } from "./GuardedDocumentService";
import { canonicalTaskRoot, withTaskWrite } from "./task-write-coordinator";
import { appendTaskDeletionMarkers, taskDeletionFingerprint } from "./task-deletion-ledger";
import { parseTaskLine } from "../tasks/task-actions";

// Local bounded undo history, never placed in a model prompt or synced to WeChat.
const histories = new WeakMap<object, Map<string, LocalEditReceipt>>();
/** Immutable acknowledgement, not a fresh-file read masquerading as approved bytes. */
export function snapshotWritebackUndo(app: App, id: string, path: string): Readonly<LocalEditReceipt> | null {
  const receipt = histories.get(app.vault)?.get(`${id}\0${path}`);
  return receipt ? Object.freeze({ ...receipt }) : null;
}
export function rememberWritebackUndo(app: App, id: string, receipt: LocalEditReceipt): void {
  const history = histories.get(app.vault) ?? new Map<string, LocalEditReceipt>();
  histories.set(app.vault, history);
  if ((receipt.before?.length ?? 0) + receipt.after.length > 2_000_000) return;
  const key = `${id}\0${receipt.path}`;
  history.delete(key); history.set(key, receipt);
  const size = () => [...history.values()].reduce((n, r) => n + (r.before?.length ?? 0) + r.after.length, 0);
  while (history.size > 20 || size() > 8_000_000) history.delete(history.keys().next().value!);
}
export function canUndoWriteback(app: App, id: string, path: string): boolean { return histories.get(app.vault)?.has(`${id}\0${path}`) === true; }
export async function undoWriteback(app: App, id: string, path: string): Promise<void> {
  const history = histories.get(app.vault), key = `${id}\0${path}`, receipt = history?.get(key);
  if (!receipt) throw new Error("本次运行的撤销凭证已失效，请打开来源核对。");
  const root = canonicalTaskRoot(path);
  if (root) await withTaskWrite(app, root, "undo-approved-writeback", async draft => {
    if (!draft.exists(path)) throw new Error("任务文件已移动或删除，未重建。");
    const file = await draft.file(path);
    const current = await draft.read(file);
    if (current !== receipt.after && current !== (receipt.before ?? "")) throw new Error("保存后任务已变化，未覆盖新修改。请在任务页逐项处理。");
    const lines = (content: string) => content.split(/\r?\n/u).filter(line => parseTaskLine(line) !== null);
    const old = new Set(lines(receipt.before ?? "").map(taskDeletionFingerprint));
    const removed = lines(receipt.after).filter(line => !old.has(taskDeletionFingerprint(line)));
    if (removed.length) {
      const ledger = await draft.file(`${root}/archive/deleted-task-index.md`);
      await draft.modify(ledger, appendTaskDeletionMarkers(await draft.read(ledger), removed).content);
    }
    await draft.modify(file, receipt.before ?? "");
  });
  else {
    // A host can commit then throw. Retrying undo may acknowledge an exact
    // restoration, but must never overwrite any intervening human edit.
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || await app.vault.read(file) !== (receipt.before ?? "")) {
      await saveGuardedDocument(app, path, receipt.after, receipt.before ?? "");
    }
  }
  history!.delete(key);
}
