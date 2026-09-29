import { FileSystemAdapter, FileView, Notice, Platform, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { renderAsync } from "docx-preview";

export const WORD_PREVIEW_VIEW_TYPE = "lifeos-word-preview";
const MAX_PREVIEW_BYTES = 40 * 1024 * 1024;

/** A local, read-only view of the original DOCX. It never writes back to the vault. */
export class WordPreviewView extends FileView {
  private renderSerial = 0;

  constructor(leaf: WorkspaceLeaf, private readonly onTextSelection?: (file: TFile, selection: Selection) => void) {
    super(leaf);
    const deliverSelection = () => {
      // Let Chromium finish the drag/keyboard selection before reading its range.
      window.setTimeout(() => {
        if (!(this.file instanceof TFile)) return;
        const selection = this.contentEl.ownerDocument.getSelection();
        if (selection) this.onTextSelection?.(this.file, selection);
      }, 0);
    };
    this.registerDomEvent(this.contentEl, "mouseup", deliverSelection);
    this.registerDomEvent(this.contentEl, "keyup", deliverSelection);
  }

  getViewType(): string { return WORD_PREVIEW_VIEW_TYPE; }
  getDisplayText(): string { return this.file?.name ?? "Word 预览"; }
  getIcon(): string { return "file-text"; }
  canAcceptExtension(extension: string): boolean { return extension.toLowerCase() === "docx"; }

  async onLoadFile(file: TFile): Promise<void> {
    const serial = ++this.renderSerial;
    const root = this.contentEl;
    root.empty();
    root.addClass("lifeos-word-preview");
    const toolbar = root.createDiv({ cls: "lifeos-word-preview-toolbar" });
    const title = toolbar.createDiv({ cls: "lifeos-word-preview-title", text: file.name });
    title.setAttr("title", file.path);
    toolbar.createSpan({ cls: "lifeos-word-preview-readonly", text: "只读预览 · 原件未修改" });
    if (Platform.isDesktopApp && this.app.vault.adapter instanceof FileSystemAdapter) {
      const external = toolbar.createEl("button", { cls: "lifeos-word-preview-external", text: "用系统程序打开" });
      setIcon(external, "external-link");
      external.addEventListener("click", () => void this.openExternal(file));
    }
    const status = root.createDiv({ cls: "lifeos-word-preview-status", text: "正在本地打开 Word 文档…" });
    if (file.extension.toLowerCase() !== "docx") {
      status.setText("旧版 .doc 暂不支持预览，请先转换为 .docx。");
      return;
    }
    if (file.stat.size > MAX_PREVIEW_BYTES) {
      status.setText("文件超过 40 MB，为避免卡住 Obsidian，请用系统程序打开原件。");
      return;
    }
    try {
      const bytes = await this.app.vault.readBinary(file);
      if (serial !== this.renderSerial) return;
      const staged = document.createElement("div");
      staged.className = "lifeos-word-preview-document";
      const styles = staged.createDiv({ cls: "lifeos-word-preview-document-styles" });
      const body = staged.createDiv({ cls: "lifeos-word-preview-document-body" });
      // DOCX media stays in memory; no conversion service, network upload or vault write.
      await renderAsync(bytes, body, styles, {
        className: "lifeos-word-docx",
        useBase64URL: true,
        inWrapper: true,
        breakPages: true
      });
      if (serial !== this.renderSerial) return;
      body.querySelectorAll("a[href]").forEach(link => {
        const href = link.getAttribute("href")?.trim() ?? "";
        if (!/^(?:https?:|mailto:|#)/iu.test(href)) {
          link.removeAttribute("href");
        } else if (/^https?:/iu.test(href)) {
          link.setAttribute("target", "_blank");
          link.setAttribute("rel", "noopener noreferrer");
        }
      });
      if (!body.querySelector("section, article, p, table, img")) throw new Error("文档中没有可预览的内容");
      status.remove();
      root.appendChild(staged);
    } catch (error) {
      if (serial !== this.renderSerial) return;
      console.error("[Life OS] Word preview failed", { path: file.path, error });
      status.setText("Word 预览失败：文件可能已损坏、受密码保护或含暂不支持的内容。原文件未改变，可尝试用系统程序打开。");
    }
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    ++this.renderSerial;
    this.contentEl.empty();
  }

  private async openExternal(file: TFile): Promise<void> {
    if (!Platform.isDesktopApp || !(this.app.vault.adapter instanceof FileSystemAdapter)) return;
    if (this.app.vault.getAbstractFileByPath(file.path) !== file) {
      new Notice("原文件已移动或删除，请重新打开资料库。");
      return;
    }
    try {
      const fullPath = this.app.vault.adapter.getFullPath(file.path);
      const { shell } = require("electron") as { shell: { openPath(path: string): Promise<string> } };
      const error = await shell.openPath(fullPath);
      if (error) throw new Error(error);
    } catch (error) {
      console.error("[Life OS] Failed to open Word externally", error);
      new Notice("系统程序打开失败，请检查是否安装了 Word 或其他 DOCX 阅读器。");
    }
  }
}
