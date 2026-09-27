import { App, Notice } from "obsidian";
import { LifeOSModal } from "../components/LifeOSModal";
import { createButton } from "../components/Button";
import { createModalShell } from "../components/ModalShell";
import { requireProFeature } from "../licensing/entitlement";
import type PersonalLifeSystemPlugin from "../main";
import { ProjectDocumentService, projectDocumentFileName } from "../services/ProjectDocumentService";
import type { LifeOSProject, LifeOSProjectDocument } from "../types";

type ProjectDocumentAction = "edit" | "rename" | "trash";

/** Native host owns Escape/focus; a close/cancel never submits the operation. */
export class ProjectDocumentActionModal extends LifeOSModal {
  private busy = false;
  private closed = false;

  constructor(app: App, private project: LifeOSProject, private document: LifeOSProjectDocument,
    private action: ProjectDocumentAction, private service: ProjectDocumentService,
    private plugin: PersonalLifeSystemPlugin, private onChanged?: () => void | Promise<void>) { super(app); }

  onOpen(): void {
    this.closed = false;
    const titles = { edit: "编辑项目文档", rename: "重命名项目文档", trash: "移入项目回收站" };
    const { body, footer } = createModalShell(this.contentEl, {
      title: titles[this.action], subtitle: `${this.project.name} · ${projectDocumentFileName(this.document)}`,
      icon: this.action === "trash" ? "trash-2" : "file-pen", className: "lifeos-project-document-action-modal"
    });
    body.createEl("p", { text: this.document.path, cls: "lifeos-project-document-path" });
    const status = body.createDiv({ text: "正在读取文档…", attr: { role: "status", "aria-live": "polite" } });
    const cancel = createButton(footer, "取消", () => this.close(), { ghost: true });
    void this.prepare(body, footer, status, cancel).catch(error => {
      if (!this.closed) { status.textContent = this.errorMessage(error); status.setAttr("role", "alert"); }
      new Notice(this.errorMessage(error));
    });
  }

  onClose(): void { this.closed = true; }

  private async prepare(body: HTMLElement, footer: HTMLElement, status: HTMLElement, cancel: HTMLButtonElement): Promise<void> {
    const before = await this.service.readDocument(this.project, this.document);
    if (this.closed) return;
    status.textContent = "";
    let field: HTMLTextAreaElement | HTMLInputElement | undefined;
    if (this.action === "edit") {
      body.createEl("p", { text: "编辑完整 Markdown 原文；保存不会自动改写正文、来源路径或生成标签。" });
      field = body.createEl("textarea", { cls: "lifeos-project-document-editor", attr: { "aria-label": "文档原文", spellcheck: "false" } });
      field.value = before;
    } else if (this.action === "rename") {
      body.createEl("p", { text: "仅更改文件名，保留所在目录、正文和原始来源；.md 扩展名可省略。" });
      field = body.createEl("input", { attr: { type: "text", "aria-label": "新文件名" } });
      field.value = projectDocumentFileName(this.document).replace(/\.md$/iu, "");
    } else {
      body.createEl("p", { text: "确认将这份文档移入当前项目的 Trash 回收站？正文和附件不会永久删除。" });
    }
    const labels = { edit: "保存修改", rename: "确认重命名", trash: "移入项目回收站" };
    const save = createButton(footer, labels[this.action], async () => {
      if (this.busy || this.closed || !requireProFeature(this.plugin, "projectDocuments")) return;
      if (this.action === "rename" && !field?.value.trim()) { status.textContent = "请输入新文件名。"; field?.focus(); return; }
      this.busy = true; save.disabled = true; cancel.disabled = true;
      status.textContent = "正在保存…";
      try {
        if (this.action === "edit") await this.service.updateDocument(this.document.path, field!.value, { project: this.project, expectedContent: before });
        else if (this.action === "rename") await this.service.renameDocument(this.project, this.document, field!.value);
        else await this.service.deleteDocument(this.project, this.document);
        new Notice(this.action === "trash" ? "文档已移入项目回收站，未永久删除。" : "项目文档已保存。");
        this.close();
        try { await this.onChanged?.(); } catch { new Notice("操作已完成，但列表刷新失败，请重新打开项目资料。"); }
      } catch (error) {
        status.textContent = this.errorMessage(error); status.setAttr("role", "alert");
        new Notice(this.errorMessage(error));
      } finally { this.busy = false; save.disabled = false; cancel.disabled = false; }
    }, { primary: true, icon: this.action === "trash" ? "trash-2" : "check" });
    (field ?? cancel).focus();
  }

  private errorMessage(error: unknown): string { return error instanceof Error ? error.message : "项目文档操作失败，请重试。"; }
}
