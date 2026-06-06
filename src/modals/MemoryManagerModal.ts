import { App, Modal, Notice, TFile, setIcon } from "obsidian";
import { createButton } from "../components/Button";
import { createEmptyState } from "../components/EmptyState";
import { createModalShell } from "../components/ModalShell";
import { createSegmentedTabs } from "../components/SegmentedTabs";
import type PersonalLifeSystemPlugin from "../main";
import { LIFEOS_MEMORY_CATEGORIES, FileSystemService } from "../services/FileSystemService";
import { MemoryService, type MemoryRecord } from "../services/MemoryService";
import type { PendingMemory } from "../types";
import { renderMarkdownDisplay } from "../utils/markdown-render";
import { QuickCaptureModal } from "./QuickCaptureModal";

type MemoryTab = "pending" | "categories" | "trash";

export class MemoryManagerModal extends Modal {
  private activeTab: MemoryTab = "pending";
  private entries: PendingMemory[] = [];
  private category = "其他";

  constructor(app: App, private plugin: PersonalLifeSystemPlugin) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-memory-modal-host");
    await this.render();
  }

  private async render(): Promise<void> {
    const service = this.service();
    this.entries = await service.loadPending();
    const { body, footer } = createModalShell(this.contentEl, {
      title: "记忆审核台",
      subtitle: "AI 不会直接写入正式记忆。所有内容都会先进入候选池，只有你确认后才会保存到分类记忆。",
      icon: "brain",
      className: "lifeos-memory-modal"
    });

    const guard = body.createDiv({ cls: "lifeos-info-card tone-blue lifeos-info-card-soft" });
    setIcon(guard.createSpan({ cls: "lifeos-info-icon" }), "shield-check");
    const guardCopy = guard.createDiv({ cls: "lifeos-info-copy" });
    guardCopy.createEl("h3", { text: "长期记忆由你决定" });
    guardCopy.createEl("p", { text: "候选记忆不会自动污染正式记忆。你可以逐条确认、修改分类、标记重要，也可以忽略不需要沉淀的内容。" });

    createSegmentedTabs<MemoryTab>(
      body,
      [
        { id: "pending", label: "候选记忆", count: this.entries.length },
        { id: "categories", label: "分类记忆" },
        { id: "trash", label: "回收站" }
      ],
      this.activeTab,
      (tab) => {
        this.activeTab = tab;
        void this.render();
      }
    );

    if (this.activeTab === "pending") this.renderPending(body, service);
    if (this.activeTab === "categories") await this.renderCategories(body, service);
    if (this.activeTab === "trash") await this.renderTrash(body, service);

    createButton(footer, "关闭", () => this.close(), { ghost: true, icon: "x" });
  }

  private renderPending(parent: HTMLElement, service: MemoryService): void {
    const categoryGroup = parent.createDiv({ cls: "lifeos-memory-category-group" });
    categoryGroup.createDiv({ cls: "lifeos-setting-label", text: "保存到分类" });
    const select = categoryGroup.createEl("select", { cls: "lifeos-input" });
    for (const category of LIFEOS_MEMORY_CATEGORIES) select.createEl("option", { value: category, text: category });
    select.value = this.category;
    select.onchange = () => (this.category = select.value);

    const toolbar = parent.createDiv({ cls: "lifeos-memory-toolbar" });
    createButton(toolbar, "全选", () => {
      const shouldSelect = this.entries.some((entry) => !entry.selected);
      this.entries.forEach((entry) => (entry.selected = shouldSelect));
      this.renderPendingList(parent.querySelector(".lifeos-memory-list") as HTMLElement);
    }, { ghost: true, icon: "check-square" });
    createButton(toolbar, "批量确认", () => void this.confirmSelected(service), { primary: true, icon: "check" });
    createButton(toolbar, "批量忽略", () => void this.ignoreSelected(service), { ghost: true, icon: "archive-x", className: "lifeos-button-danger" });

    const list = parent.createDiv({ cls: "lifeos-memory-list" });
    this.renderPendingList(list);
  }

  private renderPendingList(list: HTMLElement): void {
    list.empty();
    if (this.entries.length === 0) {
      createEmptyState(list, {
        icon: "sparkles",
        title: "暂无候选记忆",
        description: "结束今日日记后，Life OS 会把值得沉淀的片段放到这里，等待你确认。",
        actions: [
          { label: "打开今日日记", icon: "book-open", primary: true, onClick: () => void this.plugin.openTodayNote(false) },
          { label: "快速记录", icon: "pencil-line", onClick: () => this.closeAndCapture() }
        ]
      });
      return;
    }
    for (const entry of this.entries) this.renderEditableMemory(list, entry);
  }

  private renderEditableMemory(parent: HTMLElement, entry: PendingMemory): void {
    const item = parent.createDiv({ cls: "lifeos-memory-item lifeos-memory-editable" });
    const checkbox = item.createEl("input", { attr: { type: "checkbox", "aria-label": "选择候选记忆" } });
    checkbox.checked = entry.selected;
    checkbox.onchange = () => (entry.selected = checkbox.checked);

    const body = item.createDiv({ cls: "lifeos-memory-body" });
    const content = body.createEl("textarea", { cls: "lifeos-input lifeos-memory-editor" });
    content.value = entry.content;
    content.onchange = () => (entry.content = content.value.trim());

    const controls = body.createDiv({ cls: "lifeos-memory-controls" });
    const category = controls.createEl("select", { cls: "lifeos-input" });
    for (const item of LIFEOS_MEMORY_CATEGORIES) category.createEl("option", { value: item, text: item });
    category.value = entry.category || this.category;
    category.onchange = () => (entry.category = category.value);

    const important = controls.createEl("label", { cls: "lifeos-toggle lifeos-toggle-card" });
    const importantInput = important.createEl("input", { attr: { type: "checkbox" } });
    importantInput.checked = entry.importance === "important";
    important.createSpan({ text: "标记重要" });
    importantInput.onchange = () => (entry.importance = importantInput.checked ? "important" : "normal");

    createButton(controls, "查看来源", () => this.openSource(entry), { ghost: true, icon: "external-link" });

    const meta = body.createDiv({ cls: "lifeos-memory-meta" });
    meta.createSpan({ cls: "lifeos-badge", text: entry.source || "quick-capture" });
    meta.createSpan({ text: entry.created || "未记录时间" });
  }

  private openSource(entry: PendingMemory): void {
    const maybePath = entry.source?.includes(".md") ? entry.source : "";
    if (!maybePath) {
      new Notice("这条记忆没有可打开的来源文件。");
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(maybePath);
    if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
    else new Notice("没有找到来源文件。");
  }

  private closeAndCapture(): void {
    this.close();
    new QuickCaptureModal(this.app, this.plugin, "", "memory").open();
  }

  private async renderCategories(parent: HTMLElement, service: MemoryService): Promise<void> {
    const categoryGroup = parent.createDiv({ cls: "lifeos-memory-category-group" });
    categoryGroup.createDiv({ cls: "lifeos-setting-label", text: "查看分类" });
    const select = categoryGroup.createEl("select", { cls: "lifeos-input" });
    for (const category of LIFEOS_MEMORY_CATEGORIES) select.createEl("option", { value: category, text: category });
    select.value = this.category;
    const list = parent.createDiv({ cls: "lifeos-memory-list" });
    const render = async () => {
      this.category = select.value;
      this.renderRecords(list, await service.loadCategory(this.category), "这个分类还没有正式记忆。确认候选记忆后，会在这里出现。");
    };
    select.onchange = () => void render();
    await render();
  }

  private async renderTrash(parent: HTMLElement, service: MemoryService): Promise<void> {
    const list = parent.createDiv({ cls: "lifeos-memory-list" });
    this.renderRecords(list, await service.loadIgnored(), "回收站暂时为空。被忽略的候选记忆会保留在这里，便于回看。");
  }

  private renderRecords(parent: HTMLElement, records: MemoryRecord[], emptyText: string): void {
    parent.empty();
    if (records.length === 0) {
      createEmptyState(parent, {
        icon: "folder-open",
        title: "还没有内容",
        description: emptyText,
        compact: true,
        actions: [{ label: "查看候选记忆", icon: "brain", primary: true, onClick: () => {
          this.activeTab = "pending";
          void this.render();
        } }]
      });
      return;
    }
    for (const record of records) {
      const item = parent.createDiv({ cls: "lifeos-memory-item" });
      renderMarkdownDisplay(this.app, this, item.createDiv({ cls: "lifeos-memory-content" }), record.content);
      const meta = item.createDiv({ cls: "lifeos-memory-meta" });
      meta.createSpan({ cls: "lifeos-badge", text: record.status || "已保存" });
      if (record.source) meta.createSpan({ text: record.source });
      if (record.created) meta.createSpan({ text: record.created });
    }
  }

  private async confirmSelected(service: MemoryService): Promise<void> {
    const selected = this.entries.filter((entry) => entry.selected);
    if (selected.length === 0) {
      new Notice("请先选择候选记忆。");
      return;
    }
    await service.confirm(selected, this.category);
    new Notice("已保存到正式记忆。");
    await this.render();
  }

  private async ignoreSelected(service: MemoryService): Promise<void> {
    const selected = this.entries.filter((entry) => entry.selected);
    if (selected.length === 0) {
      new Notice("请先选择候选记忆。");
      return;
    }
    if (!window.confirm(`确认忽略 ${selected.length} 条候选记忆吗？忽略后会移入回收站。`)) return;
    await service.ignore(selected);
    await this.render();
  }

  private service(): MemoryService {
    return new MemoryService(this.app, new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage));
  }
}
