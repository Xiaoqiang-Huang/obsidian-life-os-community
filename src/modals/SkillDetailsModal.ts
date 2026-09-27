import { App } from "obsidian";
import { LifeOSModal } from "../components/LifeOSModal";
import { createModalShell } from "../components/ModalShell";
import { createButton } from "../components/Button";
import type { AiSkill } from "../services/AiSkillService";

export class SkillDetailsModal extends LifeOSModal {
  constructor(app: App, private skill: AiSkill) { super(app); }
  onOpen(): void {
    this.contentEl.empty();
    const { body, footer } = createModalShell(this.contentEl, { title: this.skill.name, subtitle: "查看方法与完整指令；仅查看不会选择 Skill，也不会调用 AI。", icon: "sparkles" });
    body.addClass("lifeos-skill-detail");
    body.createEl("p", { text: this.skill.description });
    if (this.skill.lens) body.createEl("p", { text: `使用视角：${this.skill.lens}` });
    body.createEl("h3", { text: "完整指令" });
    body.createEl("pre", { text: this.skill.systemPrompt });
    createButton(footer, "关闭", () => this.close());
  }
}
