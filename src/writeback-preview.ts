import { LifeOSModal as Modal } from "./components/LifeOSModal";
import { deliverWriteback, WritebackPartialError } from "./services/writeback-delivery";
import { canUndoWriteback } from "./services/writeback-undo";
import { WritebackReceiptModal } from "./modals/WritebackReceiptModal";
import { App, Notice, TFile } from "obsidian";
import { createButton } from "./components/Button";
import { createModalShell } from "./components/ModalShell";
import { ensureFile } from "./utils";
import { applyCanonicalTaskWriteback, prepareTaskWritebackItems } from "./services/task-writeback";

export type WritebackKind = "append" | "replace" | "task" | "memory" | "daily-section";

export interface WritebackItem {
  id: string;
  kind: WritebackKind;
  title: string;
  content: string;
  targetPath: string;
  sourcePath?: string;
  /** Snapshot approved by the user; null means the file did not exist. */
  expectedOriginal?: string | null;
  checked: boolean;
}

export interface WritebackPreviewOptions {
  title: string;
  description?: string;
  confirmText?: string;
  items: WritebackItem[];
  onConfirm: (items: WritebackItem[]) => Promise<void>;
}

export async function openWritebackPreview(
  app: App,
  options: WritebackPreviewOptions
): Promise<WritebackItem[]> {
  const items = await prepareTaskWritebackItems(app, options.items);
  return new Promise((resolve) => {
    new WritebackPreviewModal(app, { ...options, items }, resolve).open();
  });
}

export async function appendWritebackItems(app: App, items: WritebackItem[]): Promise<void> {
  await deliverWriteback(app, items, true);
}
export async function applyWritebackItems(app: App, items: WritebackItem[]): Promise<void> {
  await deliverWriteback(app, items);
}

class WritebackPreviewModal extends Modal {
  private rows: Array<{
    item: WritebackItem;
    checkbox: HTMLInputElement;
    textarea: HTMLTextAreaElement;
  }> = [];
  private hasResolved = false;
  private written = new Map<string, WritebackItem>();
  private isConfirming = false;
  private confirmButtonEl: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private options: WritebackPreviewOptions,
    private resolve: (items: WritebackItem[]) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-writeback-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: this.options.title,
      subtitle: this.options.description,
      icon: "file-pen-line",
      className: "lifeos-writeback-modal"
    });

    const list = body.createDiv({ cls: "lifeos-writeback-list" });
    for (const item of this.options.items) {
      this.renderItem(list, item);
    }

    createButton(footer, "取消", () => this.finish([]), { ghost: true });
    this.confirmButtonEl = createButton(footer, this.options.confirmText ?? "确认写入", () => void this.confirm(), {
      primary: true,
      icon: "check"
    });
  }

  onClose(): void {
    if (!this.hasResolved) {
      this.resolve([...this.written.values()]);
      this.hasResolved = true;
    }
  }

  close(): void {
    if (this.isConfirming) { new Notice("正在核对写入结果，请稍候；尚未报告成功。"); return; }
    super.close();
  }

  private renderItem(parent: HTMLElement, item: WritebackItem): void {
    const card = parent.createDiv({ cls: "lifeos-writeback-card lifeos-glass-strong" });
    const header = card.createDiv({ cls: "lifeos-writeback-header" });
    const checkbox = header.createEl("input", {
      attr: { type: "checkbox", "aria-label": `选择 ${item.title}` }
    });
    checkbox.checked = item.checked;
    header.createEl("strong", { text: item.title });
    header.createEl("span", { text: item.kind, cls: "lifeos-badge" });

    card.createEl("p", {
      text: `写入：${item.targetPath}${item.sourcePath ? ` · 来源：${item.sourcePath}` : ""}`,
      cls: "lifeos-muted"
    });

    const textarea = card.createEl("textarea", { cls: "lifeos-input lifeos-glass-input" });
    textarea.value = item.content;
    textarea.rows = Math.min(12, Math.max(4, item.content.split(/\r?\n/).length + 1));

    this.rows.push({ item, checkbox, textarea });
  }

  private async confirm(): Promise<void> {
    if (this.isConfirming) return;
    const selected = this.rows
      .filter((row) => row.checkbox.checked)
      .map((row) => ({
        ...row.item,
        checked: true,
        content: row.textarea.value
      }))
      .filter((item) => item.content.trim());

    if (selected.length === 0) {
      new Notice("没有选择要写入的内容。");
      return;
    }

    this.isConfirming = true;
    if (this.confirmButtonEl) this.confirmButtonEl.disabled = true;
    try {
      await this.options.onConfirm(selected);
      this.isConfirming = false;
      this.finish(selected);
    } catch (error) {
      if (error instanceof WritebackPartialError) {
        const completed = new Set(error.receipt.targets.filter(t => t.status !== "failed").map(t => t.id));
        for (const row of this.rows) if (completed.has(row.item.id)) {
          this.written.set(row.item.id, { ...row.item, content: row.textarea.value });
          row.checkbox.checked = false; row.checkbox.disabled = true; row.textarea.disabled = true;
          row.textarea.setAttribute("aria-label", "此项已写入，重试时不会重复追加");
        }
        if (this.confirmButtonEl) this.confirmButtonEl.setText("重试未写入项");
      }
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`写入失败：${message}`, 7000);
      this.isConfirming = false;
      if (this.confirmButtonEl) this.confirmButtonEl.disabled = false;
    }
  }

  private finish(items: WritebackItem[]): void {
    if (this.isConfirming) return;
    const showReceipt = !this.hasResolved;
    if (!this.hasResolved) {
      for (const item of items) this.written.set(item.id, item);
      this.resolve([...this.written.values()]);
      this.hasResolved = true;
    }
    this.close();
    const completed = [...this.written.values()];
    if (showReceipt && completed.some(item => canUndoWriteback(this.app, item.id, item.targetPath))) new WritebackReceiptModal(this.app, completed).open();
  }
}
