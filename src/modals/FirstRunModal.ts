import { App, Modal } from "obsidian";
import type PersonalLifeSystemPlugin from "../main";
import { createButton } from "../components/Button";

export class FirstRunModal extends Modal {
  constructor(app: App, private plugin: PersonalLifeSystemPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("lifeos-modal-host", "lifeos-first-run-modal-host");
    contentEl.addClass("lifeos-modal");

    const header = contentEl.createDiv({ cls: "lifeos-modal-header" });
    header.createDiv({ cls: "lifeos-modal-icon", text: "\u2713" });
    const copy = header.createDiv();
    copy.createEl("h2", { text: "\u6b22\u8fce\u4f7f\u7528 Life OS" });
    copy.createEl("p", { text: "\u6211\u4f1a\u5148\u4e3a\u4f60\u521b\u5efa\u672c\u5730 Markdown \u6570\u636e\u7ed3\u6784\uff0c\u7136\u540e\u76f4\u63a5\u6253\u5f00 AI \u52a9\u624b\u4e3b\u9875\u3002" });

    const actions = contentEl.createDiv({ cls: "lifeos-modal-actions" });
    createButton(actions, "\u5f00\u59cb", () => void this.finish(), { primary: true, icon: "sparkles" });
  }

  private async finish(): Promise<void> {
    await this.plugin.ensureBaseStructure();
    this.plugin.settings.hasCompletedFirstRun = true;
    await this.plugin.saveSettings();
    this.close();
    await this.plugin.activateChat();
  }
}
