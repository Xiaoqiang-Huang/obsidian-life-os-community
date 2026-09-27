import { App, TFile } from "obsidian";
import { FileSystemService } from "./FileSystemService";
import { ensureFolder } from "../utils/vault";
export interface CaptureReceipt { id: string; path: string; hash: string; savedAt: string }
async function hash(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), n => n.toString(16).padStart(2, "0")).join("");
}
/** Local-only first record. No model, network, automatic tasks or directory migration. */
export class LocalCaptureService {
  constructor(private app: App, private fs: FileSystemService) {}
  async save(id: string, text: string): Promise<CaptureReceipt> {
    if (!/^[a-z0-9-]{12,80}$/u.test(id) || !text.trim() || text.length > 16000) throw new Error("请填写 1–16000 字的记录。");
    const path = this.fs.path("Inbox", `${id}.md`), body = `# 我的记录\n\n${text.trim()}\n`;
    await ensureFolder(this.app, this.fs.path("Inbox"));
    if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.create(path, body);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || await this.app.vault.read(file) !== body) throw new Error("记录已变化，未覆盖；请打开来源查看。");
    return { id, path, hash: await hash(body), savedAt: new Date().toISOString() };
  }
  async find(receipt: CaptureReceipt): Promise<string> {
    this.validate(receipt);
    const file = this.app.vault.getAbstractFileByPath(receipt.path);
    if (!(file instanceof TFile)) throw new Error("记录已移走或删除，可在 Obsidian 搜索文件名找回。");
    return this.app.vault.read(file);
  }
  async undo(receipt: CaptureReceipt): Promise<boolean> {
    this.validate(receipt);
    const file = this.app.vault.getAbstractFileByPath(receipt.path);
    if (!file) return false;
    const after = `<!-- lifeos-capture-undone:${receipt.id} -->\n`;
    if (!(file instanceof TFile)) throw new Error("来源不是文件，未撤销。");
    const before = await this.app.vault.read(file);
    if (before === after) return false;
    if (await hash(before) !== receipt.hash) throw new Error("保存后已被编辑，撤销已停止，保留你的新内容。请打开来源手动处理。");
    // Clear only the unchanged record atomically. Keep an empty receipt file, never race a deletion with human edits.
    await this.app.vault.process(file, current => {
      if (current !== before || file.path !== receipt.path) throw new Error("记录正在变化，未撤销。");
      return after;
    });
    if (await this.app.vault.read(file) !== after) throw new Error("撤销后文件发生变化，请打开来源核对。");
    return true;
  }
  private validate(receipt: CaptureReceipt): void {
    if (!receipt || !/^[a-z0-9-]{12,80}$/u.test(receipt.id) || receipt.path !== this.fs.path("Inbox", `${receipt.id}.md`)
      || !/^[a-f0-9]{64}$/u.test(receipt.hash)) throw new Error("保存凭证无效，未访问其他文件。");
  }
}
