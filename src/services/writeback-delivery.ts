import { App, TFile } from "obsidian";
import type { WritebackItem } from "../writeback-preview";
import { ensureFolder } from "../utils/vault";
import { applyCanonicalTaskWriteback } from "./task-writeback";
import { rememberWritebackUndo } from "./writeback-undo";

export interface WritebackTargetReceipt { id: string; path: string; status: "written" | "already-written" | "failed"; error?: string }
export interface WritebackReceipt { status: "complete" | "partial" | "failed"; targets: WritebackTargetReceipt[] }
export class WritebackPartialError extends Error {
  constructor(public readonly receipt: WritebackReceipt) {
    const successful = receipt.targets.filter(t => t.status !== "failed").length;
    super(`已写入 ${successful}/${receipt.targets.length} 项；仅重试失败目标，成功项不会重复追加。${receipt.targets.filter(t => t.status === "failed").map(t => `${t.path}：${t.error}`).join("；")}`);
    this.name = "WritebackPartialError";
  }
}
const queues = new WeakMap<object, Promise<unknown>>();
async function sha(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), n => n.toString(16).padStart(2, "0")).join("");
}
/** Per-target acknowledgement lives with the bytes, so partial retries survive a restart. */
export async function deliverWriteback(app: App, items: WritebackItem[], appendOnly = false): Promise<WritebackReceipt> {
  const run = async () => {
    const targets: WritebackTargetReceipt[] = [];
    for (const item of items) {
      try {
        if (!item.id || !item.targetPath || item.targetPath.startsWith("/") || /[\\:\u0000-\u001f]/u.test(item.targetPath)
          || item.targetPath.split("/").some(p => !p || p === "." || p === "..")) throw new Error("无效写回目标，未写入。");
        const key = await sha(`${item.id}\n${item.targetPath}`), contentHash = await sha(`${appendOnly ? "append" : item.kind}\n${item.content}`);
        const prefix = `<!-- lifeos-writeback:v1:${key}:`, marker = `${prefix}${contentHash} -->`;
        const existing = app.vault.getAbstractFileByPath(item.targetPath);
        if (existing && !(existing instanceof TFile)) throw new Error("写回目标不是文件。");
        const before = existing instanceof TFile ? await app.vault.read(existing) : null;
        if (before?.includes(prefix)) {
          if (!before.includes(marker)) throw new Error("此项先前已写入其他内容，请作为新的修改重新预览。");
          targets.push({ id: item.id, path: item.targetPath, status: "already-written" }); continue;
        }
        const delivered = { ...item, content: item.kind === "task" ? `\n${marker}\n${item.content}\n` : `${item.content}\n${marker}\n` };
        if (!await applyCanonicalTaskWriteback(app, delivered, appendOnly, true, (before, after) => rememberWritebackUndo(app, item.id, { path: item.targetPath, before, after }))) {
          if (!appendOnly && item.kind === "replace" && item.expectedOriginal === undefined) throw new Error("替换内容需要先预览原文，未覆盖文件。");
          if (!appendOnly && item.kind === "replace" && item.expectedOriginal !== before) throw new Error("原文已被修改或删除，请重新预览；没有覆盖人工修改。");
          const after = !appendOnly && item.kind === "replace" ? delivered.content : (before ?? "") + delivered.content;
          if (existing instanceof TFile) {
            if (typeof app.vault.process !== "function") throw new Error("当前宿主不支持安全写入，请升级 Obsidian。");
            await app.vault.process(existing, current => {
              if (current !== before || existing.path !== item.targetPath || app.vault.getAbstractFileByPath(item.targetPath) !== existing) throw new Error("保存期间原文变化，未覆盖。");
              return after;
            });
          } else {
            const slash = item.targetPath.lastIndexOf("/");
            if (slash > 0) await ensureFolder(app, item.targetPath.slice(0, slash));
            await app.vault.create(item.targetPath, after);
          }
          const file = app.vault.getAbstractFileByPath(item.targetPath);
          if (!(file instanceof TFile) || await app.vault.read(file) !== after) throw new Error("写入后核对失败，请保留当前文件后重试核对。");
          rememberWritebackUndo(app, item.id, { path: item.targetPath, before, after });
        }
        targets.push({ id: item.id, path: item.targetPath, status: "written" });
      } catch (error) {
        targets.push({ id: item.id, path: item.targetPath, status: "failed", error: error instanceof Error ? error.message : String(error) });
        // Later items may depend on this one (e.g. source note mirrors tasks).
        // Do not claim dependent writes while the primary target has failed.
        for (const pending of items.slice(targets.length)) targets.push({ id: pending.id, path: pending.targetPath, status: "failed", error: "前一目标失败，尚未执行；可继续重试。" });
        break;
      }
    }
    const failed = targets.filter(t => t.status === "failed").length;
    const receipt: WritebackReceipt = { status: !failed ? "complete" : failed === targets.length ? "failed" : "partial", targets };
    if (failed) throw new WritebackPartialError(receipt);
    return receipt;
  };
  const promise = (queues.get(app.vault) ?? Promise.resolve()).catch(() => {}).then(run);
  queues.set(app.vault, promise.catch(() => {}));
  return promise;
}
