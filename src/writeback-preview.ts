import { App, Modal, Notice, TFile } from "obsidian";
import { createButton } from "./components/Button";
import { createModalShell } from "./components/ModalShell";
import { ensureFile } from "./utils";

export type WritebackKind = "append" | "replace" | "task" | "memory" | "daily-section";

export interface WritebackItem {
  id: string;
  kind: WritebackKind;
  title: string;
  content: string;
  targetPath: string;
  sourcePath?: string;
  checked: boolean;
}

export interface WritebackPreviewOptions {
  title: string;
  description?: string;
  confirmText?: string;
  items: WritebackItem[];
  onConfirm: (items: WritebackItem[]) => Promise<void>;
}

export function openWritebackPreview(
  app: App,
  options: WritebackPreviewOptions
): Promise<WritebackItem[]> {
  return new Promise((resolve) => {
    new WritebackPreviewModal(app, options, resolve).open();
  });
}

export async function appendWritebackItems(app: App, items: WritebackItem[]): Promise<void> {
  for (const item of items) {
    const file = await ensureFile(app, item.targetPath, "");
    await app.vault.append(file, item.content);
  }
}

export async function applyWritebackItems(app: App, items: WritebackItem[]): Promise<void> {
  for (const item of items) {
    const existing = app.vault.getAbstractFileByPath(item.targetPath);
    if (item.kind === "replace") {
      if (existing instanceof TFile) {
        await app.vault.modify(existing, item.content);
      } else {
        await ensureFile(app, item.targetPath, item.content);
      }
      continue;
    }

    const file = existing instanceof TFile
      ? existing
      : await ensureFile(app, item.targetPath, "");
    await app.vault.append(file, item.content);
  }
}

class WritebackPreviewModal extends Modal {
  private rows: Array<{
    item: WritebackItem;
    checkbox: HTMLInputElement;
    textarea: HTMLTextAreaElement;
  }> = [];
  private hasResolved = false;

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
    createButton(footer, this.options.confirmText ?? "确认写入", () => void this.confirm(), {
      primary: true,
      icon: "check"
    });
  }

  onClose(): void {
    if (!this.hasResolved) {
      this.resolve([]);
      this.hasResolved = true;
    }
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

    await this.options.onConfirm(selected);
    this.finish(selected);
  }

  private finish(items: WritebackItem[]): void {
    if (!this.hasResolved) {
      this.resolve(items);
      this.hasResolved = true;
    }
    this.close();
  }
}
