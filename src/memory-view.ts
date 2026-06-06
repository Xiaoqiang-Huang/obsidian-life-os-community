import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { createButton } from "./components/Button";
import { createCard } from "./components/Card";
import { createEmptyState } from "./components/EmptyState";
import { createHeroHeader } from "./components/HeroHeader";
import { createLifeOSShell } from "./components/LifeOSComponent";
import { createSegmentedTabs } from "./components/SegmentedTabs";
import { MEMORY_VIEW_TYPE } from "./constants";
import type PersonalLifeSystemPlugin from "./main";
import { QuickCaptureModal } from "./modals/QuickCaptureModal";
import { LIFEOS_MEMORY_CATEGORIES, FileSystemService } from "./services/FileSystemService";
import { MemoryService, type MemoryRecord } from "./services/MemoryService";
import type { PendingMemory } from "./types";
import { renderMarkdownDisplay } from "./utils/markdown-render";

type MemoryTab = "pending" | "categories" | "trash";

export class MemoryView extends ItemView {
  private activeTab: MemoryTab = "pending";
  private entries: PendingMemory[] = [];
  private selectedCategory = "其他";

  constructor(leaf: WorkspaceLeaf, private plugin: PersonalLifeSystemPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return MEMORY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "记忆审核";
  }

  async onOpen(): Promise<void> {
    await this.render();
    this.registerEvent(this.app.vault.on("modify", () => void this.render()));
    this.registerEvent(this.app.vault.on("create", () => void this.render()));
  }

  private async render(): Promise<void> {
    await this.plugin.ensureBaseStructure();
    const container = this.containerEl.children[1];
    container.empty();

    const main = createLifeOSShell(container as HTMLElement, this.plugin, "memory");
    main.addClass("lifeos-memory-page");

    const service = this.service();
    this.entries = await service.loadPending();

    createHeroHeader(main, {
      kicker: "记忆审核",
      title: "候选记忆",
      description: "AI 不会直接写入正式记忆。所有内容都会先进入候选池，只有你确认后才会保存到分类记忆。",
      icon: "brain",
      actions: [
        { label: "快速记录", icon: "pencil-line", primary: true, onClick: () => new QuickCaptureModal(this.app, this.plugin, "", "memory").open() },
        { label: "打开今日日记", icon: "book-open", onClick: () => void this.plugin.openTodayNote(false) }
      ]
    });

    this.renderSafetyNote(main);

    const layout = main.createDiv({ cls: "lifeos-memory-layout" });
    const workspace = layout.createDiv({ cls: "lifeos-memory-workspace-card" });
    const aside = layout.createDiv({ cls: "lifeos-memory-side" });

    createSegmentedTabs<MemoryTab>(
      workspace,
      [
        { id: "pending", label: "候选记忆", count: this.entries.length },
        { id: "categories", label: "分类记忆" },
        { id: "trash", label: "已忽略" }
      ],
      this.activeTab,
      (tab) => {
        this.activeTab = tab;
        void this.render();
      }
    );

    if (this.activeTab === "pending") this.renderPending(workspace, service);
    if (this.activeTab === "categories") await this.renderCategories(workspace, service);
    if (this.activeTab === "trash") await this.renderTrash(workspace, service);

    this.renderSideGuide(aside);
  }

  private renderSafetyNote(parent: HTMLElement): void {
    const note = parent.createDiv({ cls: "lifeos-info-card lifeos-memory-safety-note" });
    setIcon(note.createSpan({ cls: "lifeos-info-icon" }), "shield-check");
    const copy = note.createDiv({ cls: "lifeos-info-copy" });
    copy.createEl("h3", { text: "长期记忆由你决定" });
    copy.createEl("p", { text: "候选内容只是等待审核的草稿。确认后才进入分类记忆；忽略后会保留在已忽略列表，不会直接删除。" });
  }

  private renderPending(parent: HTMLElement, service: MemoryService): void {
    const tools = parent.createDiv({ cls: "lifeos-memory-tools" });

    const categoryGroup = tools.createDiv({ cls: "lifeos-field-group" });
    categoryGroup.createDiv({ cls: "lifeos-setting-label", text: "保存到" });
    const select = categoryGroup.createEl("select", { cls: "lifeos-input lifeos-select" });
    for (const category of LIFEOS_MEMORY_CATEGORIES) select.createEl("option", { value: category, text: category });
    select.value = this.selectedCategory;
    select.onchange = () => (this.selectedCategory = select.value);

    const actions = tools.createDiv({ cls: "lifeos-memory-bulk-actions" });
    createButton(actions, "全选", () => {
      const next = this.entries.some((entry) => !entry.selected);
      this.entries.forEach((entry) => (entry.selected = next));
      this.renderPendingList(parent.querySelector(".lifeos-memory-list") as HTMLElement);
    }, { ghost: true, icon: "check-square" });
    createButton(actions, "批量确认", () => void this.confirmSelected(service), { primary: true, icon: "check" });
    createButton(actions, "批量忽略", () => void this.ignoreSelected(service), { ghost: true, icon: "archive-x", className: "lifeos-button-danger" });

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
        compact: true,
        actions: [
          { label: "打开今日日记", icon: "book-open", primary: true, onClick: () => void this.plugin.openTodayNote(false) },
          { label: "快速记录", icon: "pencil-line", onClick: () => new QuickCaptureModal(this.app, this.plugin, "", "memory").open() }
        ]
      });
      return;
    }

    for (const entry of this.entries) this.renderMemoryCandidate(list, entry);
  }

  private renderMemoryCandidate(parent: HTMLElement, entry: PendingMemory): void {
    const item = parent.createDiv({ cls: "lifeos-memory-review-card" });
    const checkbox = item.createEl("input", { attr: { type: "checkbox", "aria-label": "选择候选记忆" } });
    checkbox.checked = entry.selected;
    checkbox.onchange = () => (entry.selected = checkbox.checked);

    const body = item.createDiv({ cls: "lifeos-memory-review-body" });
    const editor = body.createEl("textarea", { cls: "lifeos-input lifeos-memory-editor" });
    editor.value = entry.content;
    editor.rows = Math.min(5, Math.max(2, entry.content.split(/\r?\n/).length + 1));
    editor.onchange = () => (entry.content = editor.value.trim());

    const meta = body.createDiv({ cls: "lifeos-memory-meta-row" });
    meta.createSpan({ cls: "lifeos-badge", text: this.sourceLabel(entry.source) });
    meta.createSpan({ text: entry.created || "未记录时间" });

    const controls = body.createDiv({ cls: "lifeos-memory-inline-controls" });
    const category = controls.createEl("select", { cls: "lifeos-input lifeos-select" });
    for (const option of LIFEOS_MEMORY_CATEGORIES) category.createEl("option", { value: option, text: option });
    category.value = entry.category || this.selectedCategory;
    category.onchange = () => (entry.category = category.value);

    const important = controls.createEl("label", { cls: "lifeos-toggle lifeos-toggle-card" });
    const importantInput = important.createEl("input", { attr: { type: "checkbox" } });
    importantInput.checked = entry.importance === "important";
    important.createSpan({ text: "重要" });
    importantInput.onchange = () => (entry.importance = importantInput.checked ? "important" : "normal");

    createButton(controls, "确认", () => void this.confirmEntries([entry]), { primary: true, icon: "check" });
    createButton(controls, "忽略", () => void this.ignoreEntries([entry]), { ghost: true, icon: "archive-x" });
    createButton(controls, "来源", () => this.openSource(entry), { ghost: true, icon: "external-link" });
  }

  private async renderCategories(parent: HTMLElement, service: MemoryService): Promise<void> {
    const tools = parent.createDiv({ cls: "lifeos-memory-tools" });
    const group = tools.createDiv({ cls: "lifeos-field-group" });
    group.createDiv({ cls: "lifeos-setting-label", text: "查看分类" });
    const select = group.createEl("select", { cls: "lifeos-input lifeos-select" });
    for (const category of LIFEOS_MEMORY_CATEGORIES) select.createEl("option", { value: category, text: category });
    select.value = this.selectedCategory;

    const list = parent.createDiv({ cls: "lifeos-memory-list" });
    const render = async () => {
      this.selectedCategory = select.value;
      this.renderRecords(list, await service.loadCategory(this.selectedCategory), "这个分类还没有正式记忆。确认候选记忆后，会在这里出现。");
    };
    select.onchange = () => void render();
    await render();
  }

  private async renderTrash(parent: HTMLElement, service: MemoryService): Promise<void> {
    const list = parent.createDiv({ cls: "lifeos-memory-list" });
    this.renderRecords(list, await service.loadIgnored(), "已忽略的候选记忆会保留在这里，方便日后回看。");
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
      const item = parent.createDiv({ cls: "lifeos-memory-record-row" });
      renderMarkdownDisplay(this.app, this, item.createDiv({ cls: "lifeos-memory-content" }), record.content);
      const meta = item.createDiv({ cls: "lifeos-memory-meta-row" });
      meta.createSpan({ cls: "lifeos-badge", text: record.status || "已保存" });
      if (record.source) meta.createSpan({ text: this.sourceLabel(record.source) });
      if (record.created) meta.createSpan({ text: record.created });
    }
  }

  private renderSideGuide(parent: HTMLElement): void {
    const guide = createCard(parent, "lifeos-panel lifeos-memory-guide");
    guide.createEl("h3", { text: "记忆如何进入正式库" });
    const steps = [
      ["候选", "AI 或快速记录只会放入候选池。"],
      ["确认", "你可以编辑内容、分类和重要性。"],
      ["沉淀", "确认后保存到对应分类 Markdown。"]
    ];
    for (const [title, copy] of steps) {
      const row = guide.createDiv({ cls: "lifeos-memory-guide-row" });
      row.createEl("strong", { text: title });
      row.createSpan({ text: copy });
    }
  }

  private async confirmSelected(service: MemoryService): Promise<void> {
    await this.confirmEntries(this.entries.filter((entry) => entry.selected), service);
  }

  private async confirmEntries(entries: PendingMemory[], service = this.service()): Promise<void> {
    if (entries.length === 0) {
      new Notice("请先选择候选记忆。");
      return;
    }
    await service.confirm(entries, this.selectedCategory);
    await this.render();
  }

  private async ignoreSelected(service: MemoryService): Promise<void> {
    await this.ignoreEntries(this.entries.filter((entry) => entry.selected), service);
  }

  private async ignoreEntries(entries: PendingMemory[], service = this.service()): Promise<void> {
    if (entries.length === 0) {
      new Notice("请先选择候选记忆。");
      return;
    }
    if (!window.confirm(`确认忽略 ${entries.length} 条候选记忆吗？忽略后会进入已忽略列表，不会直接删除。`)) return;
    await service.ignore(entries);
    await this.render();
  }

  private openSource(entry: PendingMemory): void {
    const source = entry.source?.includes(".md") ? entry.source : "";
    if (!source) {
      new Notice("这条记忆没有可打开的来源文件。");
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(source);
    if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
    else new Notice("没有找到来源文件。");
  }

  private sourceLabel(source: string): string {
    if (!source) return "未知来源";
    if (source === "quick-capture") return "快速记录";
    if (source === "ai") return "AI 候选";
    return source;
  }

  private service(): MemoryService {
    return new MemoryService(this.app, new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage));
  }
}
