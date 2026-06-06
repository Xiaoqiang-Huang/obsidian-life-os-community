import { App, Modal, Notice } from "obsidian";
import { createButton } from "../components/Button";
import { createModalShell } from "../components/ModalShell";
import type PersonalLifeSystemPlugin from "../main";
import { FileSystemService } from "../services/FileSystemService";
import { ProjectService } from "../services/ProjectService";

export class NewProjectModal extends Modal {
  constructor(
    app: App,
    private plugin: PersonalLifeSystemPlugin,
    private onSaved?: () => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-project-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: "新增项目",
      subtitle: "把一组任务组织成可以追踪的推进状态。",
      icon: "folder-plus",
      className: "lifeos-project-modal"
    });

    const form = body.createDiv({ cls: "lifeos-task-form lifeos-project-form" });
    const name = this.field(form, "项目名称", "例如：Life OS 发布");
    const type = this.select(form, "项目类型", [
      ["general", "普通项目"],
      ["study", "学习项目"],
      ["client", "客户项目"]
    ]);
    const status = this.select(form, "项目状态", [
      ["active", "进行中"],
      ["paused", "暂停"],
      ["done", "完成"]
    ]);
    const goal = this.field(form, "项目目标", "例如：本周完成交付包和更新文档");

    footer.addClass("lifeos-task-modal-footer");
    createButton(footer, "取消", () => this.close(), { ghost: true });
    createButton(
      footer,
      "保存项目",
      async () => {
        try {
          await new ProjectService(this.app, new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage)).createProject({
            name: name.value,
            type: type.value,
            status: status.value,
            goal: goal.value
          });
          new Notice("项目已创建。", 5000);
          this.close();
          await this.onSaved?.();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "项目保存失败。");
        }
      },
      { primary: true, icon: "plus" }
    );
  }

  private field(parent: HTMLElement, label: string, placeholder: string): HTMLInputElement {
    const wrap = parent.createDiv({ cls: "lifeos-form-field" });
    wrap.createEl("label", { text: label });
    return wrap.createEl("input", {
      cls: "lifeos-input lifeos-glass-input",
      attr: { type: "text", placeholder }
    });
  }

  private select(parent: HTMLElement, label: string, values: Array<[string, string]>): HTMLSelectElement {
    const wrap = parent.createDiv({ cls: "lifeos-form-field" });
    wrap.createEl("label", { text: label });
    const select = wrap.createEl("select", { cls: "lifeos-input lifeos-glass-input" });
    for (const [value, text] of values) select.createEl("option", { value, text });
    return select;
  }
}
