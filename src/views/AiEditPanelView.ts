import { ItemView, WorkspaceLeaf } from "obsidian";
import { AI_EDIT_PANEL_VIEW_TYPE } from "../constants";
import type PersonalLifeSystemPlugin from "../main";

export class AiEditPanelView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: PersonalLifeSystemPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return AI_EDIT_PANEL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "AI 修改";
  }

  getIcon(): string {
    return "sparkles";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("lifeos-ai-edit-panel-view");
    this.contentEl.setAttr("data-lifeos-ai-edit-panel", "true");
    const loading = this.contentEl.createDiv({ cls: "lifeos-ai-edit-panel-empty is-loading" });
    loading.createEl("strong", { text: "AI 修改侧边栏" });
    loading.createEl("span", { text: "正在挂载选区问答面板…" });
    try {
      this.plugin.mountAiEditPanel(this.contentEl);
    } catch (error) {
      console.error("[Life OS] AI edit panel view failed to open", error);
      this.contentEl.empty();
      const fallback = this.contentEl.createDiv({ cls: "lifeos-ai-edit-panel-empty is-error" });
      fallback.createEl("strong", { text: "AI 修改侧边栏加载失败" });
      fallback.createEl("span", { text: error instanceof Error ? error.message : "未知错误，请重新加载 Obsidian 后再试。" });
    }
  }

  async onClose(): Promise<void> {
    this.plugin.unmountAiEditPanel();
    this.contentEl.removeClass("lifeos-ai-edit-panel-view");
    this.contentEl.removeAttribute("data-lifeos-ai-edit-panel");
    this.contentEl.empty();
  }
}
