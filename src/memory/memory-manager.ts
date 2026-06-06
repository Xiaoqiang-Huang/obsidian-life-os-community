import { App, Modal, Notice, TFile } from "obsidian";
import type { IPlugin } from "../plugin-api";
import { LIFEOS_MEMORY_CATEGORIES, FileSystemService } from "../services/FileSystemService";
import { MemoryService } from "../services/MemoryService";
import type { PendingMemory } from "../types";
import { renderMarkdownDisplay } from "../utils/markdown-render";

interface MemoryEntry extends PendingMemory {
  _checkbox?: HTMLInputElement;
}

/**
 * Legacy Life OS modal kept for old shell imports.
 * All memory parsing and writes must go through MemoryService so old entry points
 * cannot create the pre-standard candidate format again.
 */
export class MemoryManagerModal extends Modal {
  private entries: MemoryEntry[] = [];
  private selectedCategory = "其他";
  private selectAll = true;

  constructor(app: App, private plugin: IPlugin) {
    super(app);
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pls-modal");
    contentEl.createEl("h2", { text: "记忆审核" });
    contentEl.createEl("p", {
      text: "AI 不会直接写入正式记忆。所有内容都会先进入候选池，只有你确认后才会保存到分类记忆。",
      cls: "pls-muted"
    });

    this.entries = (await this.service().loadPending()).map((entry) => ({
      ...entry,
      selected: entry.selected ?? true
    }));

    if (this.entries.length === 0) {
      contentEl.createEl("p", {
        text: "暂无候选记忆。结束今日日记后，Life OS 会把值得沉淀的片段放到这里，等待你确认。",
        cls: "pls-muted"
      });
      contentEl.createEl("button", { text: "关闭" }).onclick = () => this.close();
      return;
    }

    this.renderToolbar(contentEl);
    const list = contentEl.createDiv({ cls: "pls-writeback-list" });
    for (const entry of this.entries) this.renderCard(list, entry);

    const footer = contentEl.createDiv({ cls: "pls-button-row", attr: { style: "margin-top: 12px;" } });
    footer.createEl("button", { text: "关闭" }).onclick = () => this.close();
  }

  private renderToolbar(container: HTMLElement): void {
    const toolbar = container.createDiv({
      cls: "pls-button-row",
      attr: { style: "margin-bottom: 12px; flex-wrap: wrap; gap: 8px; align-items: center;" }
    });

    const selectLabel = toolbar.createEl("label", {
      attr: { style: "display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;" }
    });
    const selectAll = selectLabel.createEl("input", { attr: { type: "checkbox" } });
    selectAll.checked = this.selectAll;
    selectAll.onchange = () => {
      this.selectAll = selectAll.checked;
      this.entries.forEach((entry) => (entry.selected = this.selectAll));
      this.updateCheckboxStates();
      this.updateSelectedCount();
    };
    selectLabel.createSpan({ text: "全选" });

    toolbar.createSpan({ cls: "pls-muted", text: `已选 ${this.entries.length} 条` });

    const categoryGroup = toolbar.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;" } });
    categoryGroup.createSpan({ text: "保存到", cls: "pls-muted" });
    const category = categoryGroup.createEl("select", { attr: { style: "min-width:100px;" } });
    for (const item of LIFEOS_MEMORY_CATEGORIES) category.createEl("option", { value: item, text: item });
    category.value = this.selectedCategory;
    category.onchange = () => (this.selectedCategory = category.value);

    const confirm = toolbar.createEl("button", { text: "批量确认", cls: "pls-btn-primary" });
    confirm.onclick = () => void this.confirmSelected();

    const ignore = toolbar.createEl("button", { text: "批量忽略" });
    ignore.onclick = () => void this.ignoreSelected();
  }

  private renderCard(container: HTMLElement, entry: MemoryEntry): void {
    const card = container.createDiv({ cls: "pls-writeback-card" });
    const header = card.createDiv({ cls: "pls-writeback-header" });
    const checkbox = header.createEl("input", { attr: { type: "checkbox" } });
    checkbox.checked = entry.selected ?? true;
    checkbox.onchange = () => {
      entry.selected = checkbox.checked;
      this.updateSelectedCount();
    };
    entry._checkbox = checkbox;

    header.createEl("strong", {
      text: entry.content.slice(0, 60) + (entry.content.length > 60 ? "..." : "")
    });
    header.createEl("span", { text: entry.category || this.selectedCategory, cls: "pls-muted" });
    renderMarkdownDisplay(this.app, this, card.createDiv({ cls: "pls-muted" }), entry.content);
    const meta = card.createDiv({ cls: "pls-muted" });
    meta.createSpan({ text: `来源：${entry.source || "quick-capture"}` });
    meta.createSpan({ text: ` · ${entry.created || "未记录时间"}` });
  }

  private updateCheckboxStates(): void {
    for (const entry of this.entries) {
      if (entry._checkbox) entry._checkbox.checked = entry.selected ?? true;
    }
  }

  private updateSelectedCount(): void {
    const muted = this.contentEl.querySelector(".pls-button-row .pls-muted");
    if (muted) muted.textContent = `已选 ${this.selectedEntries().length} 条`;
  }

  private selectedEntries(): PendingMemory[] {
    return this.entries
      .filter((entry) => entry.selected)
      .map((entry) => ({ ...entry, category: entry.category || this.selectedCategory }));
  }

  private async confirmSelected(): Promise<void> {
    const selected = this.selectedEntries();
    if (selected.length === 0) {
      new Notice("请先选择记忆条目。");
      return;
    }
    await this.service().confirm(selected, this.selectedCategory);
    new Notice(`已确认 ${selected.length} 条记忆。`);
    await this.render();
  }

  private async ignoreSelected(): Promise<void> {
    const selected = this.selectedEntries();
    if (selected.length === 0) {
      new Notice("请先选择记忆条目。");
      return;
    }
    if (!window.confirm(`确认忽略 ${selected.length} 条候选记忆吗？忽略后会保留在候选池记录中。`)) return;
    await this.service().ignore(selected);
    new Notice(`已忽略 ${selected.length} 条记忆。`);
    await this.render();
  }

  private openSource(entry: PendingMemory): void {
    if (!entry.source || !entry.source.endsWith(".md")) return;
    const file = this.app.vault.getAbstractFileByPath(entry.source);
    if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
  }

  private service(): MemoryService {
    return new MemoryService(this.app, new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage));
  }
}
