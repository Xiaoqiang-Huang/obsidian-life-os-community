import { ItemView, type WorkspaceLeaf } from "obsidian";
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
    return "AI 编辑";
  }

  getIcon(): string {
    return "sparkles";
  }

  async onOpen(): Promise<void> {
    this.refresh();
  }

  refresh(): void {
    this.contentEl.empty();
    this.contentEl.addClass("lifeos-ai-edit-panel-view");
    this.plugin.aiEditPopover?.mountToPanel(this.contentEl);
  }

  async onClose(): Promise<void> {
    this.contentEl.removeClass("lifeos-ai-edit-panel-view");
    this.plugin.aiEditPopover?.unmountFromPanel();
  }
}
