import { App, Modal, Notice, setIcon } from "obsidian";
import { createButton } from "../components/Button";
import { createModalShell } from "../components/ModalShell";
import { requireProFeature } from "../licensing/entitlement";
import type PersonalLifeSystemPlugin from "../main";
import {
  PROJECT_DOCUMENT_IMPORT_ACCEPT,
  ProjectDocumentService,
  type ProjectDocumentImportProgress,
  type ProjectDocumentImportResult,
  type ProjectDocumentTextImportMode
} from "../services/ProjectDocumentService";
import type { LifeOSProject } from "../types";
import {
  asRelativeReadableImportFile,
  configureDirectoryInput,
  importFileRelativePath,
  importFileSelectionKey,
  mergeSupportedImportFiles
} from "../utils/import-file-selection";

export class ImportProjectDocumentsModal extends Modal {
  private files: File[] = [];
  private skippedFileCount = 0;
  private listEl: HTMLElement | null = null;
  private importButton: HTMLButtonElement | null = null;
  private progressEl: HTMLElement | null = null;
  private textMode: ProjectDocumentTextImportMode = "ai-formatted";
  private importBusy = false;

  constructor(
    app: App,
    private project: LifeOSProject,
    private service: ProjectDocumentService,
    private plugin: PersonalLifeSystemPlugin,
    private onImported?: (documents: ProjectDocumentImportResult[]) => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-project-import-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: "导入项目文档",
      subtitle: `先保存原文件，再完整提取正文；选择 AI 整理时会按段落分批处理「${this.project.name}」的项目资料。`,
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
    const directoryInput = body.createEl("input", {
      cls: "lifeos-project-import-input",
      attr: {
        type: "file",
        multiple: "true",
        accept: PROJECT_DOCUMENT_IMPORT_ACCEPT,
        webkitdirectory: "",
        directory: ""
      }
    });
    configureDirectoryInput(directoryInput);
    directoryInput.addEventListener("change", () => {
      this.addFiles(directoryInput.files);
      directoryInput.value = "";
    });

    const drop = body.createDiv({ cls: "lifeos-project-import-drop", attr: { tabindex: "0" } });
    setIcon(drop.createSpan({ cls: "lifeos-project-import-drop-icon" }), "files");
    const copy = drop.createDiv({ cls: "lifeos-project-import-drop-copy" });
    copy.createEl("strong", { text: "拖拽文件到这里，或选择文件" });
    copy.createEl("span", { text: "可一次选择整个目录。PDF / Word 会先保存原件；可读正文会完整写入项目文档，再按下方选项整理为可检索 Markdown。" });
    createButton(drop, "选择文件", () => input.click(), { ghost: true, icon: "paperclip" });
    createButton(drop, "选择目录", () => directoryInput.click(), { ghost: true, icon: "folder-open" });

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

    this.renderTextModeOptions(body);

    this.listEl = body.createDiv({ cls: "lifeos-project-import-list" });
    this.renderList();
    this.progressEl = body.createDiv({ cls: "lifeos-project-import-progress", text: "准备导入" });
    this.progressEl.setAttr("aria-live", "polite");

    footer.addClass("lifeos-task-modal-footer");
    createButton(footer, "取消", () => this.close(), { ghost: true });
    this.importButton = createButton(footer, "导入文档", () => void this.importSelectedFiles(), {
      primary: true,
      icon: "upload",
      className: "lifeos-project-import-submit"
    });
    this.syncImportButton();
  }

  private addFiles(fileList: FileList | File[] | null): void {
    const result = mergeSupportedImportFiles(this.files, fileList, { visibleLimit: 80 });
    if (result.added === 0 && result.skipped.length === 0 && result.duplicates === 0) return;
    this.files = result.files;
    this.skippedFileCount += result.skipped.length;
    if (result.skipped.length > 0) {
      new Notice(`已跳过 ${result.skipped.length} 个暂不支持的文件；其余 ${result.added} 个文档已加入。`, 5000);
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
    this.listEl.createDiv({
      cls: "lifeos-project-import-summary",
      text: `已选择 ${this.files.length} 个文档${this.skippedFileCount > 0 ? ` · 已跳过 ${this.skippedFileCount} 个不支持文件` : ""}`
    });
    for (const file of this.files.slice(0, 80)) {
      const row = this.listEl.createDiv({ cls: "lifeos-project-import-item" });
      setIcon(row.createSpan({ cls: "lifeos-project-import-item-icon" }), this.fileIcon(file));
      const copy = row.createDiv({ cls: "lifeos-project-import-item-copy" });
      copy.createEl("strong", { text: importFileRelativePath(file) });
      copy.createSpan({ text: `${this.fileKindLabel(file)} · ${this.formatSize(file.size)}` });
      createButton(row, "移除", () => {
        this.files = this.files.filter((item) => importFileSelectionKey(item) !== importFileSelectionKey(file));
        this.renderList();
        this.syncImportButton();
      }, { ghost: true, icon: "x" });
    }
    if (this.files.length > 80) {
      this.listEl.createDiv({ cls: "lifeos-project-import-summary", text: `列表仅预览前 80 个文件，导入时会处理全部 ${this.files.length} 个文档。` });
    }
  }

  private async importSelectedFiles(): Promise<void> {
    if (!requireProFeature(this.plugin, "projectDocuments")) return;
    if (this.files.length === 0) {
      new Notice("请先选择要导入的文档。");
      return;
    }
    this.setImportButtonBusy(true);
    if (this.textMode === "ai-formatted") {
      new Notice("正在导入：先完整提取正文，再逐段 AI 整理格式…", 4000);
    }
    try {
      const imported = await this.service.importDocuments(this.project, this.files.map(asRelativeReadableImportFile), {
        textMode: this.textMode,
        onProgress: (progress) => this.renderImportProgress(progress)
      });
      new Notice(`已导入 ${imported.length} 个项目文档。`);
      this.close();
      await this.onImported?.(imported);
    } catch (error) {
      this.setImportButtonBusy(false);
      new Notice(error instanceof Error ? error.message : "项目文档导入失败。");
    }
  }

  private syncImportButton(): void {
    if (!this.importButton) return;
    this.importButton.disabled = this.importBusy || this.files.length === 0;
    this.importButton.title = this.files.length === 0
      ? "先选择要导入的文档"
      : this.textMode === "ai-formatted"
        ? "先完整导入正文，再按段落批次进行 AI Markdown 整理"
        : "导入项目文档";
  }

  private setImportButtonBusy(isBusy: boolean): void {
    this.importBusy = isBusy;
    this.importButton?.toggleClass("is-busy", isBusy);
    const label = this.importButton?.querySelector<HTMLElement>(".lifeos-v2-button-label");
    if (label) label.textContent = isBusy
      ? this.textMode === "ai-formatted" ? "提取并逐段排版…" : "正在导入…"
      : "导入文档";
    this.syncImportButton();
  }

  private renderImportProgress(progress: ProjectDocumentImportProgress): void {
    if (!this.progressEl) return;
    const stage = progress.stage === "saving"
      ? "保存原文件"
      : progress.stage === "extracting"
        ? "提取正文"
        : progress.stage === "formatting"
          ? "逐段 AI 整理"
          : progress.stage === "writing"
            ? "写入项目文档"
            : "已完成";
    const chunk = progress.stage === "formatting" && progress.chunkIndex && progress.chunkCount
      ? ` · 第 ${progress.chunkIndex}/${progress.chunkCount} 段`
      : "";
    this.progressEl.setText(`${progress.fileIndex}/${progress.fileCount} · ${progress.sourceName} · ${stage}${chunk}`);
    const label = this.importButton?.querySelector<HTMLElement>(".lifeos-v2-button-label");
    if (label && this.importBusy) label.textContent = `${stage}${chunk}`;
  }

  private renderTextModeOptions(body: HTMLElement): void {
    const panel = body.createDiv({ cls: "lifeos-project-import-options" });
    const copy = panel.createDiv({ cls: "lifeos-project-import-options-copy" });
    copy.createEl("strong", { text: "正文处理方式" });
    copy.createEl("span", { text: "先决定是否完整导入可检索正文；AI 只在正文导入后按段落调整格式，不负责读取原文件。" });
    const options: Array<{ mode: ProjectDocumentTextImportMode; title: string; description: string }> = [
      {
        mode: "ai-formatted",
        title: "先完整导入，再逐段 AI 整理格式",
        description: "推荐。先把可读正文完整写入，再按段落批次交给 AI 调整标题、段落、列表和表格；疑似漏内容会自动保留原文。"
      },
      {
        mode: "plain-text",
        title: "只导入原始文本",
        description: "保存原文件并写入本地解析文本，不调用 AI，速度更快。"
      },
      {
        mode: "attachment-only",
        title: "只保存原文件",
        description: "不提取全文、不生成可检索正文，适合暂存大文件或敏感资料。"
      }
    ];
    const group = panel.createDiv({ cls: "lifeos-project-import-option-list" });
    for (const option of options) {
      const label = group.createEl("label", {
        cls: option.mode === this.textMode ? "lifeos-project-import-option is-active" : "lifeos-project-import-option"
      });
      const radio = label.createEl("input", {
        attr: {
          type: "radio",
          name: "lifeos-project-import-text-mode",
          value: option.mode
        }
      });
      radio.checked = option.mode === this.textMode;
      const text = label.createDiv({ cls: "lifeos-project-import-option-copy" });
      text.createEl("strong", { text: option.title });
      text.createEl("span", { text: option.description });
      radio.addEventListener("change", () => {
        this.textMode = option.mode;
        for (const item of Array.from(group.querySelectorAll<HTMLElement>(".lifeos-project-import-option"))) {
          item.toggleClass("is-active", item === label);
        }
        this.syncImportButton();
      });
    }
  }

  private fileKey(file: File): string {
    return importFileSelectionKey(file);
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
