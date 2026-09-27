import { App, TFile } from "obsidian";
import { ensureFolder } from "../utils/vault";
export interface LocalEditReceipt { path: string; before: string | null; after: string }
/** A fresh preview plus native process CAS. Never overwrite intervening edits. */
export async function saveGuardedDocument(app: App, path: string, before: string | null, after: string): Promise<LocalEditReceipt> {
  if (!path || /[\\:\u0000-\u001f]/u.test(path) || path.startsWith("/") || path.split("/").some(p => !p || p === "." || p === "..")) throw new Error("文件路径无效。");
  const file = app.vault.getAbstractFileByPath(path);
  if (before === null) {
    if (file) throw new Error("文件已被另一处创建，未覆盖。请先打开来源核对。");
    await ensureFolder(app, path.slice(0, path.lastIndexOf("/")));
    await app.vault.create(path, after);
  } else {
    if (!(file instanceof TFile)) throw new Error("文件已被移动或删除，未重建。");
    await app.vault.process(file, current => {
      if (current !== before || file.path !== path || app.vault.getAbstractFileByPath(path) !== file) throw new Error("文件在编辑期间发生变化，草稿已保留；请打开来源核对后重试。");
      return after;
    });
  }
  const saved = app.vault.getAbstractFileByPath(path);
  if (!(saved instanceof TFile) || await app.vault.read(saved) !== after) throw new Error("保存后核对失败，未报告成功；请打开来源检查。");
  return { path, before, after };
}
export async function undoGuardedDocument(app: App, receipt: LocalEditReceipt): Promise<void> {
  // Leave an empty file for a newly created document instead of a racy delete.
  await saveGuardedDocument(app, receipt.path, receipt.after, receipt.before ?? "");
}
