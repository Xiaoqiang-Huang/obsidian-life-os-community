import { App, Modal, Notice, setIcon } from "obsidian";
import { createButton } from "../components/Button";
import { createModalShell } from "../components/ModalShell";
import {
  PROJECT_DOCUMENT_IMPORT_ACCEPT,
  ProjectDocumentService,
  type ProjectDocumentImportResult
} from "../services/ProjectDocumentService";
import type { LifeOSProject } from "../types";

export class ImportProjectDocumentsModal extends Modal {
  private files: File[] = [];
  private listEl: HTMLElement | null = null;
  private importButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private project: LifeOSProject,
    private service: ProjectDocumentService,
    private onImported?: (documents: ProjectDocumentImportResult[]) => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-project-import-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: "导入项目文档",
      subtitle: `把 PDF、Word、Markdown、文本和图片放进「${this.project.name}」的项目资料库。`,
      icon: "upload-cloud",
      className: "lifeos-task-modal lifeos-project-import-modal"
    });

    const input = body.createEl("input", {
      cls: "lifeos-project-import-input",
      attr: {
        type: "file",
        multiple: "true",
        accept: PROJECT_DOCUMENT_IMPORT_ACCEPT
      }
    });

    input.addEventListener("change", () => {
      this.addFiles(input.files);
      input.value = "";
    });

    const drop = body.createDiv({ cls: "lifeos-project-import-drop", attr: { tabindex: "0" } });
    setIcon(drop.createSpan({ cls: "lifeos-project-import-drop-icon" }), "files");
    const copy = drop.createDiv({ cls: "lifeos-project-import-drop-copy" });
    copy.createEl("strong", { text: "拖拽文件到这里，或选择文件" });
    copy.createEl("span", { text: "PDF / Word 会保存原文件并生成项目资料页；文本类会同步写入可检索正文。" });
    createButton(drop, "选择文件", () => input.click(), { ghost: true, icon: "paperclip" });

    drop.addEventListener("dragover", (event) => {
      event.preventDefault();
      drop.addClass("is-dragging");
    });
    drop.addEventListener("dragleave", () => drop.removeClass("is-dragging"));
    drop.addEventListener("drop", (event) => {
      event.preventDefault();
      drop.removeClass("is-dragging");
      this.addFiles(event.dataTransfer?.files ?? null);
    });
    drop.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        input.click();
      }
    });

    this.listEl = body.createDiv({ cls: "lifeos-project-import-list" });
    this.renderList();

    footer.addClass("lifeos-task-modal-footer");
    createButton(footer, "取消", () => this.close(), { ghost: true });
    this.importButton = createButton(footer, "导入文档", () => void this.importSelectedFiles(), {
      primary: true,
      icon: "upload"
    });
    this.syncImportButton();
  }

  private addFiles(fileList: FileList | File[] | null): void {
    const nextFiles = Array.from(fileList ?? []);
    if (nextFiles.length === 0) return;
    const seen = new Set(this.files.map((file) => this.fileKey(file)));
    for (const file of nextFiles) {
      const key = this.fileKey(file);
      if (seen.has(key)) continue;
      this.files.push(file);
      seen.add(key);
    }
    this.renderList();
    this.syncImportButton();
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    this.listEl.classList.toggle("is-empty", this.files.length === 0);
    if (this.files.length === 0) {
      this.listEl.createDiv({ cls: "lifeos-project-import-empty", text: "还没有选择文件。" });
      return;
    }
    for (const file of this.files) {
      const row = this.listEl.createDiv({ cls: "lifeos-project-import-item" });
      setIcon(row.createSpan({ cls: "lifeos-project-import-item-icon" }), this.fileIcon(file));
      const copy = row.createDiv({ cls: "lifeos-project-import-item-copy" });
      copy.createEl("strong", { text: file.name });
      copy.createSpan({ text: `${this.fileKindLabel(file)} · ${this.formatSize(file.size)}` });
      createButton(row, "移除", () => {
        this.files = this.files.filter((item) => this.fileKey(item) !== this.fileKey(file));
        this.renderList();
        this.syncImportButton();
      }, { ghost: true, icon: "x" });
    }
  }

  private async importSelectedFiles(): Promise<void> {
    if (this.files.length === 0) {
      new Notice("请先选择要导入的文档。");
      return;
    }
    this.importButton?.setAttr("disabled", "true");
    try {
      const imported = await this.service.importDocuments(this.project, this.files);
      new Notice(`已导入 ${imported.length} 个项目文档。`);
      this.close();
      await this.onImported?.(imported);
    } catch (error) {
      this.importButton?.removeAttribute("disabled");
      new Notice(error instanceof Error ? error.message : "项目文档导入失败。");
    }
  }

  private syncImportButton(): void {
    if (!this.importButton) return;
    this.importButton.disabled = this.files.length === 0;
  }

  private fileKey(file: File): string {
    return `${file.name}:${file.size}:${file.lastModified}`;
  }

  private fileIcon(file: File): string {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".pdf")) return "file-type-2";
    if (lower.endsWith(".doc") || lower.endsWith(".docx")) return "file-text";
    if (file.type.startsWith("image/")) return "image";
    return "file";
  }

  private fileKindLabel(file: File): string {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".pdf")) return "PDF";
    if (lower.endsWith(".doc") || lower.endsWith(".docx")) return "Word";
    if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "Markdown";
    if (lower.endsWith(".csv")) return "CSV";
    if (lower.endsWith(".json")) return "JSON";
    if (file.type.startsWith("image/")) return "图片";
    return "文档";
  }

  private formatSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
}
