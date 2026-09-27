import { App, Notice, TFile } from "obsidian";
import { LifeOSModal } from "../components/LifeOSModal";
import { createModalShell } from "../components/ModalShell";
import { createButton } from "../components/Button";
import { canUndoWriteback, undoWriteback } from "../services/writeback-undo";
import type { WritebackItem } from "../writeback-preview";

export class WritebackReceiptModal extends LifeOSModal {
  constructor(app: App, private items: WritebackItem[]) { super(app); }
  onOpen(): void {
    const { body, footer } = createModalShell(this.contentEl, { title: "本次写入凭证", subtitle: "以下目标已完成写后核对。可打开来源；未被后续编辑的内容可逐项撤销。", icon: "file-check-2" });
    body.createEl("p", { text: "撤销仅限本次运行内的最近 20 个目标，且受容量限制。重启后请打开来源核对；新建文件撤销后保留空文件，不删除其他内容。", cls: "lifeos-muted" });
    for (const item of this.items) {
      const row = body.createDiv({ cls: "lifeos-panel" });
      row.createEl("strong", { text: item.title });
      row.createEl("p", { text: item.targetPath, cls: "lifeos-path", attr: { title: item.targetPath } });
      const actions = row.createDiv({ cls: "lifeos-actions" });
      createButton(actions, "打开来源", () => { const file = this.app.vault.getAbstractFileByPath(item.targetPath); if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file); else new Notice("来源已移动或删除，请用文件名搜索。"); }, { icon: "file-text" });
      if (canUndoWriteback(this.app, item.id, item.targetPath)) {
        const button = createButton(actions, "撤销这一项", () => void (async () => {
          button.disabled = true;
          try { await undoWriteback(this.app, item.id, item.targetPath); button.setText("已撤销并核对"); }
          catch (error) { new Notice(String(error), 7000); button.disabled = false; }
        })(), { icon: "undo-2" });
      }
    }
    createButton(footer, "完成", () => this.close(), { primary: true });
  }
}
