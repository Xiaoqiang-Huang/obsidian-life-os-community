import { ItemView, WorkspaceLeaf } from "obsidian";
import { createLifeOSShell } from "../components/LifeOSComponent";
import { SETTINGS_VIEW_TYPE } from "../constants";
import type PersonalLifeSystemPlugin from "../main";
import { PersonalLifeSystemSettingTab } from "../settings-tab";

/** Full-page settings workspace. Native Obsidian settings only links here. */
export class LifeOSSettingsView extends ItemView {
  private settingTab: PersonalLifeSystemSettingTab | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: PersonalLifeSystemPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return SETTINGS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Life OS 设置中心";
  }

  getIcon(): string {
    return "settings-2";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  async onClose(): Promise<void> {
    this.settingTab?.hide();
    this.settingTab?.containerEl.detach();
    this.settingTab = null;
  }

  private render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    const main = createLifeOSShell(container, this.plugin, "settings");
    main.addClass("lifeos-settings-main");
    const page = main.createDiv({ cls: "lifeos-settings-page" });
    this.settingTab?.hide();
    this.settingTab = new PersonalLifeSystemSettingTab(this.app, this.plugin, "full");
    page.appendChild(this.settingTab.containerEl);
    this.settingTab.display();
  }
}
