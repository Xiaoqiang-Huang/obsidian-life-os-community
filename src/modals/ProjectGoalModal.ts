import { App, Notice } from "obsidian";
import { LifeOSModal } from "../components/LifeOSModal";
import { createModalShell } from "../components/ModalShell";
import { createButton } from "../components/Button";
import { requireProFeature } from "../licensing/entitlement";
import { ProjectService } from "../services/ProjectService";
import type PersonalLifeSystemPlugin from "../main";
import type { LifeOSProject } from "../types";
export class ProjectGoalModal extends LifeOSModal {
  private busy = false;
  constructor(app: App, private plugin: PersonalLifeSystemPlugin, private project: LifeOSProject,
    private service: ProjectService, private onSaved: () => Promise<void>) { super(app); }
  onOpen(): void {
    const { body, footer } = createModalShell(this.contentEl, { title: "编辑项目目标", subtitle: this.project.name, icon: "target" });
    body.createEl("p", { text: "目标由你维护；支持多行，最多 4000 字。清空后保存可移除目标。" });
    const field = body.createEl("textarea", { cls: "lifeos-project-goal-input", attr: { "aria-label": "项目目标", maxlength: "4000", rows: "6" } });
    field.value = this.project.goal || "";
    const status = body.createDiv({ attr: { role: "status", "aria-live": "polite" } });
    createButton(footer, "取消", () => this.close(), { ghost: true });
    const save = createButton(footer, "保存目标", async () => {
      if (this.busy || !requireProFeature(this.plugin, "projectManagement")) return;
      this.busy = true; save.disabled = true;
      try { await this.service.updateGoal(this.project.id, this.project.goal || "", field.value);
        new Notice("项目目标已保存。"); this.close(); await this.onSaved();
      } catch (e) { status.textContent = e instanceof Error ? e.message : "保存失败，输入已保留。"; }
      finally { this.busy = false; save.disabled = false; }
    }, { primary: true });
    field.focus();
  }
}
