import { App, Modal, Notice } from "obsidian";
import { createButton } from "../components/Button";
import { createModalShell } from "../components/ModalShell";
import type PersonalLifeSystemPlugin from "../main";
import { FileSystemService } from "../services/FileSystemService";
import { ProjectService } from "../services/ProjectService";
import { TaskService } from "../services/TaskService";

export class NewTaskModal extends Modal {
  constructor(
    app: App,
    private plugin: PersonalLifeSystemPlugin,
    private onSaved?: () => void | Promise<void>,
    private defaultProjectId?: string
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-task-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: "新建任务",
      subtitle: "把一个想法变成可执行的最小行动。",
      icon: "check-square",
      className: "lifeos-task-modal"
    });

    const form = body.createDiv({ cls: "lifeos-task-form" });
    const title = this.field(form, "任务标题", "例如：阅读 30 分钟");
    const category = this.field(form, "分类", "学习 / 项目 / 健康");
    const project = this.projectSelect(form, "归属项目");
    void this.loadProjectOptions(project);
    const dueDate = this.field(form, "截止日期", "YYYY-MM-DD", "date");
    const priority = this.select(form, "优先级", ["普通", "重要", "紧急"]);
    const source = this.field(form, "来源", "手动创建 / 今日日记 / 快速记录");
    source.value = "手动创建";

    const noteWrap = form.createDiv({ cls: "lifeos-form-field lifeos-form-field-wide" });
    noteWrap.createEl("label", { text: "备注" });
    const note = noteWrap.createEl("textarea", {
      cls: "lifeos-input lifeos-glass-input",
      attr: { placeholder: "可以补充上下文，非必填。" }
    });

    footer.addClass("lifeos-task-modal-footer");
    createButton(footer, "取消", () => this.close(), { ghost: true });
    createButton(
      footer,
      "保存任务",
      async () => {
        try {
          await new TaskService(this.app, new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage)).createTask({
            title: title.value,
            category: category.value,
            projectId: project.value,
            dueDate: dueDate.value,
            priority: priority.value,
            source: source.value,
            note: note.value
          });
          new Notice("任务已添加到待办。", 5000);
          this.close();
          await this.onSaved?.();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "任务保存失败。");
        }
      },
      { primary: true, icon: "plus" }
    );
  }

  private field(parent: HTMLElement, label: string, placeholder: string, type = "text"): HTMLInputElement {
    const wrap = parent.createDiv({ cls: "lifeos-form-field" });
    wrap.createEl("label", { text: label });
    return wrap.createEl("input", {
      cls: "lifeos-input lifeos-glass-input",
      attr: { type, placeholder }
    });
  }

  private projectSelect(parent: HTMLElement, label: string): HTMLSelectElement {
    const wrap = parent.createDiv({ cls: "lifeos-form-field" });
    wrap.createEl("label", { text: label });
    const select = wrap.createEl("select", { cls: "lifeos-input lifeos-glass-input" });
    select.createEl("option", { value: "", text: "未归属" });
    return select;
  }

  private async loadProjectOptions(select: HTMLSelectElement): Promise<void> {
    const projects = await new ProjectService(
      this.app,
      new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage)
    ).loadProjects();
    for (const item of projects) {
      const option = select.createEl("option", { value: item.id, text: item.name });
      if (item.id === this.defaultProjectId) option.selected = true;
    }
  }

  private select(parent: HTMLElement, label: string, values: string[]): HTMLSelectElement {
    const wrap = parent.createDiv({ cls: "lifeos-form-field" });
    wrap.createEl("label", { text: label });
    const select = wrap.createEl("select", { cls: "lifeos-input lifeos-glass-input" });
    for (const value of values) select.createEl("option", { value, text: value });
    return select;
  }
}
