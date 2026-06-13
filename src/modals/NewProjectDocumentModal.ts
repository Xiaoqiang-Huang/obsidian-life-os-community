import { App, Modal, Notice } from "obsidian";
import { createButton } from "../components/Button";
import { createModalShell } from "../components/ModalShell";
import { ProjectDocumentService } from "../services/ProjectDocumentService";
import type { LifeOSProject, LifeOSProjectDocument, LifeOSProjectDocumentKind } from "../types";

export class NewProjectDocumentModal extends Modal {
  constructor(
    app: App,
    private project: LifeOSProject,
    private service: ProjectDocumentService,
    private onSaved?: (document: LifeOSProjectDocument) => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-project-document-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: "新增项目文档",
      subtitle: `保存到「${this.project.name}」的专属项目资料区，AI 助手选择该项目后会优先读取。`,
      icon: "file-plus",
      className: "lifeos-task-modal lifeos-project-document-modal"
    });

    const form = body.createDiv({ cls: "lifeos-task-form lifeos-project-document-form" });
    const title = this.field(form, "文档标题", "例如：需求记录 / 会议纪要 / 资料索引");
    const kind = this.select(form, "文档类型", [
      ["note", "普通笔记"],
      ["meeting", "会议纪要"],
      ["requirement", "需求文档"],
      ["reference", "参考资料"],
      ["review", "复盘总结"]
    ]);

    const contentWrap = form.createDiv({ cls: "lifeos-form-field lifeos-form-field-wide" });
    contentWrap.createEl("label", { text: "初始内容" });
    const content = contentWrap.createEl("textarea", {
      cls: "lifeos-input lifeos-glass-input",
      attr: { placeholder: "可以先写几句背景、资料、决策、会议纪要或后续复盘。" }
    });
    content.value = "在这里记录项目背景、资料、决策、会议纪要或后续复盘。";

    footer.addClass("lifeos-task-modal-footer");
    createButton(footer, "取消", () => this.close(), { ghost: true });
    createButton(
      footer,
      "创建文档",
      async () => {
        const cleanTitle = title.value.trim();
        if (!cleanTitle) {
          new Notice("请先填写文档标题。");
          title.focus();
          return;
        }
        try {
          const document = await this.service.createDocument(this.project, {
            title: cleanTitle,
            kind: kind.value as LifeOSProjectDocumentKind,
            content: content.value
          });
          new Notice("项目文档已创建。");
          this.close();
          await this.onSaved?.(document);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "项目文档创建失败。");
        }
      },
      { primary: true, icon: "file-plus" }
    );

    title.focus();
  }

  private field(parent: HTMLElement, label: string, placeholder: string): HTMLInputElement {
    const wrap = parent.createDiv({ cls: "lifeos-form-field" });
    wrap.createEl("label", { text: label });
    return wrap.createEl("input", {
      cls: "lifeos-input lifeos-glass-input",
      attr: { type: "text", placeholder }
    });
  }

  private select(parent: HTMLElement, label: string, values: Array<[LifeOSProjectDocumentKind, string]>): HTMLSelectElement {
    const wrap = parent.createDiv({ cls: "lifeos-form-field" });
    wrap.createEl("label", { text: label });
    const select = wrap.createEl("select", { cls: "lifeos-input lifeos-glass-input" });
    for (const [value, text] of values) select.createEl("option", { value, text });
    return select;
  }
}
