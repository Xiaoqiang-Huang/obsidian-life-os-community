import { App, Notice, TFile } from "obsidian";
import { LifeOSModal } from "../components/LifeOSModal";
import { createButton } from "../components/Button";
import { createModalShell } from "../components/ModalShell";

// The same TFile may appear in both the document list and recent-items list,
// or in multiple views. Keep one confirmation owner until its write settles.
const activeFiles = new WeakMap<App, WeakSet<TFile>>();

export class KnowledgeFileActionModal extends LifeOSModal {
  private busy = false;
  private closed = false;
  private ownsFile = false;

  constructor(app: App, private file: TFile, private action: "rename" | "trash",
    private submit: (name: string) => Promise<void>) { super(app); }

  onOpen(): void {
    let active = activeFiles.get(this.app);
    if (!active) { active = new WeakSet<TFile>(); activeFiles.set(this.app, active); }
    if (active.has(this.file)) {
      new Notice("这份资料已有操作弹窗，请先完成或取消。", 4000);
      this.close();
      return;
    }
    active.add(this.file);
    this.ownsFile = true;
    this.closed = false;
    const rename = this.action === "rename";
    const { body, footer } = createModalShell(this.contentEl, {
      title: rename ? "重命名知识文件" : "移入 Obsidian 回收站",
      subtitle: this.file.name, icon: rename ? "pencil" : "trash-2"
    });
    body.createEl("p", { cls: "lifeos-knowledge-file-path", text: this.file.path });
    let input: HTMLInputElement | undefined;
    if (rename) {
      body.createEl("p", { text: "仅更改文件名，保留目录和内容；.md 扩展名可省略。同名时沿用自动编号规则。" });
      input = body.createEl("input", { cls: "lifeos-knowledge-file-input", attr: { type: "text", "aria-label": "新文件名" } });
      input.value = this.file.basename;
    } else {
      body.createEl("p", { text: "确认将这份资料移入 Obsidian 回收站？本操作不会永久删除，也不会移除来源附件。" });
    }
    const status = body.createDiv({ attr: { role: "status", "aria-live": "polite" } });
    const cancel = createButton(footer, "取消", () => this.close(), { ghost: true });
    const save = createButton(footer, rename ? "确认重命名" : "移入回收站", async () => {
      if (this.busy || this.closed) return;
      if (rename && !input?.value.trim()) {
        status.textContent = "请输入新文件名。"; status.setAttr("role", "alert"); input?.focus(); return;
      }
      this.busy = true;
      save.disabled = true;
      cancel.disabled = true;
      if (input) input.disabled = true;
      status.setAttr("role", "status");
      status.textContent = "正在处理…";
      try {
        await this.submit(input?.value ?? "");
        this.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status.textContent = message;
        status.setAttr("role", "alert");
        new Notice(message, 7000);
      } finally {
        this.busy = false;
        save.disabled = false;
        cancel.disabled = false;
        if (input) input.disabled = false;
        if (this.closed) this.releaseFile();
      }
    }, { primary: true, icon: rename ? "check" : "trash-2" });
    // Destructive actions default to cancellation, never implicit confirmation.
    (input ?? cancel).focus();
  }

  onClose(): void {
    this.closed = true;
    if (!this.busy) this.releaseFile();
  }

  private releaseFile(): void {
    if (this.ownsFile) activeFiles.get(this.app)?.delete(this.file);
    this.ownsFile = false;
  }
}
