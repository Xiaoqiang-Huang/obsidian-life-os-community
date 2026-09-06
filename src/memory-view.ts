import { ItemView, Notice, TAbstractFile, TFile, WorkspaceLeaf, setIcon } from "obsidian";
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
import type {
  AgentMemoryDiagnostics,
  AgentMemoryRecord,
  AgentMemoryStatus,
  AgentSkillSuggestion
} from "./services/agent/AgentMemoryTypes";
import type { PendingMemory } from "./types";
import { renderMarkdownDisplay } from "./utils/markdown-render";
import { renderStableView } from "./utils/stable-view-refresh";

type MemoryTab = "pending" | "categories" | "agent" | "trash";
type AgentMemoryFilter = "active" | "candidate" | "confirmed" | "external" | "inactive" | "all";

export class MemoryView extends ItemView {
  private activeTab: MemoryTab = "pending";
  private entries: PendingMemory[] = [];
  private refreshTimer: number | null = null;
  private renderPromise: Promise<void> | null = null;
  private renderQueued = false;
  private renderRequestRevision = 0;
  private preserveScrollOnNextRender = true;
  private selectedCategory = "其他";
  private agentMemoryFilter: AgentMemoryFilter = "active";

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
    await this.render(false);
    const refresh = (file: TAbstractFile): void => {
      if (this.shouldRefreshForFile(file)) this.scheduleVaultRefresh();
    };
    this.registerEvent(this.app.vault.on("modify", refresh));
    this.registerEvent(this.app.vault.on("create", refresh));
    this.registerEvent(this.app.vault.on("delete", refresh));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (this.shouldRefreshForFile(file) || this.shouldRefreshForFile(oldPath)) this.scheduleVaultRefresh();
    }));
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.renderRequestRevision += 1;
  }

  private scheduleVaultRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.render(true);
    }, 120);
  }

  private shouldRefreshForFile(file: TAbstractFile | string): boolean {
    const path = (typeof file === "string" ? file : file.path).replace(/\\/g, "/");
    const root = this.plugin.path("Memory").replace(/\\/g, "/").replace(/\/+$/g, "");
    return path === root || path.startsWith(`${root}/`);
  }

  private async render(preserveScroll = true): Promise<void> {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.renderRequestRevision += 1;
    this.renderQueued = true;
    this.preserveScrollOnNextRender = preserveScroll;
    if (this.renderPromise) return this.renderPromise;

    const run = async (): Promise<void> => {
      while (this.renderQueued) {
        this.renderQueued = false;
        const revision = this.renderRequestRevision;
        await this.renderPass(revision, this.preserveScrollOnNextRender);
      }
    };
    this.renderPromise = run().finally(() => {
      this.renderPromise = null;
    });
    return this.renderPromise;
  }

  private async renderPass(revision: number, preserveScroll: boolean): Promise<void> {
    await this.plugin.ensureBaseStructure();
    if (revision !== this.renderRequestRevision) return;
    const container = this.containerEl.children[1] as HTMLElement | undefined;
    if (!container) return;
    const service = this.service();
    const entries = await service.loadPending();
    if (revision !== this.renderRequestRevision) return;
    this.entries = entries;

    await renderStableView(container, async (staging) => {
      const main = createLifeOSShell(staging, this.plugin, "memory");
      main.addClass("lifeos-memory-page");

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
        { id: "agent", label: "Agent 回忆" },
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
    if (this.activeTab === "agent") await this.renderAgentMemory(workspace);
    if (this.activeTab === "trash") await this.renderTrash(workspace, service);

      this.renderSideGuide(aside, this.activeTab);
    }, {
      preserveScroll,
      isCurrent: () => revision === this.renderRequestRevision
    });
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

  private async renderAgentMemory(parent: HTMLElement): Promise<void> {
    const [diagnostics, records, suggestions] = await Promise.all([
      this.plugin.agent.getMemoryDiagnostics(),
      this.plugin.agent.listAgentMemories(true),
      this.plugin.agent.listAgentSkillSuggestions()
    ]);

    const dashboard = parent.createDiv({ cls: "lifeos-agent-memory-dashboard" });
    this.renderAgentMemoryDiagnostics(dashboard, diagnostics);

    const actions = dashboard.createDiv({ cls: "lifeos-agent-memory-dashboard-actions" });
    createButton(actions, "处理待提炼", () => void this.runAgentMemoryAction(
      () => this.plugin.agent.processPendingMemories(),
      (result) => `已处理 ${result.completed}/${result.claimed} 个任务，新增 ${result.added} 条回忆。`
    ), { primary: diagnostics.queuedJobCount > 0, ghost: diagnostics.queuedJobCount === 0, icon: "sparkles" });
    createButton(actions, "导入项目记忆", () => void this.runAgentMemoryAction(
      () => this.plugin.agent.importExternalMemories(),
      (result) => `已扫描 ${result.scanned} 条项目记忆，新增 ${result.added} 条、更新 ${result.updated} 条。`
    ), { ghost: true, icon: "download" });
    createButton(actions, "运行维护", () => void this.runAgentMemoryAction(
      () => this.plugin.agent.runMemoryMaintenance(),
      () => "Agent 记忆维护完成。"
    ), { ghost: true, icon: "refresh-cw" });

    if (suggestions.length > 0) this.renderAgentSkillSuggestions(parent, suggestions);

    const section = parent.createDiv({ cls: "lifeos-agent-memory-section" });
    const heading = section.createDiv({ cls: "lifeos-agent-memory-section-heading" });
    const headingCopy = heading.createDiv();
    headingCopy.createEl("h3", { text: "生成式回忆" });
    headingCopy.createEl("p", { text: "由对话提炼，按项目和可选渠道/账号隔离。候选可确认；遗忘后不会再被召回或重新生成。" });

    const filter = heading.createEl("select", {
      cls: "lifeos-input lifeos-select lifeos-agent-memory-filter",
      attr: { "aria-label": "筛选 Agent 回忆" }
    });
    const filters: Array<[AgentMemoryFilter, string]> = [
      ["active", "可用回忆"],
      ["candidate", "待确认"],
      ["confirmed", "已确认"],
      ["external", "外部工具"],
      ["inactive", "陈旧 / 已取代 / 已遗忘"],
      ["all", "全部"]
    ];
    for (const [value, label] of filters) filter.createEl("option", { value, text: label });
    filter.value = this.agentMemoryFilter;

    const list = section.createDiv({ cls: "lifeos-agent-memory-list" });
    const renderList = () => {
      const visible = records.filter((record) => this.agentRecordMatchesFilter(record, this.agentMemoryFilter));
      this.renderAgentMemoryRecords(list, visible);
    };
    filter.onchange = () => {
      this.agentMemoryFilter = filter.value as AgentMemoryFilter;
      renderList();
    };
    renderList();
  }

  private renderAgentMemoryDiagnostics(parent: HTMLElement, diagnostics: AgentMemoryDiagnostics): void {
    const header = parent.createDiv({ cls: "lifeos-agent-memory-dashboard-header" });
    const copy = header.createDiv();
    copy.createEl("h3", { text: "Agent 记忆索引" });
    copy.createEl("p", { text: "权威资料保持原文；这里只管理 AI 生成的回忆、工作检查点与外部工具候选。" });
    const identity = header.createSpan({ cls: "lifeos-badge", text: diagnostics.storeId });
    identity.setAttr("title", `存储：${diagnostics.storePath}\n读取路径：${diagnostics.readPath}`);

    const stats = parent.createDiv({ cls: "lifeos-agent-memory-stat-grid" });
    const rows: Array<[string, number, string]> = [
      ["总回忆", diagnostics.recordCount, "database"],
      ["待确认", diagnostics.candidateCount, "circle-help"],
      ["已确认", diagnostics.confirmedCount, "badge-check"],
      ["外部工具", diagnostics.externalRecordCount, "import"],
      ["工作检查点", diagnostics.workingStateCount, "save"],
      ["待处理", diagnostics.queuedJobCount, "loader-circle"]
    ];
    for (const [label, value, icon] of rows) {
      const item = stats.createDiv({ cls: "lifeos-agent-memory-stat" });
      setIcon(item.createSpan({ cls: "lifeos-agent-memory-stat-icon" }), icon);
      const itemCopy = item.createDiv();
      itemCopy.createEl("strong", { text: String(value) });
      itemCopy.createSpan({ text: label });
    }
    if (diagnostics.lastError) {
      const error = parent.createDiv({ cls: "lifeos-agent-memory-error" });
      setIcon(error.createSpan(), "triangle-alert");
      error.createSpan({ text: diagnostics.lastError });
    }
  }

  private renderAgentMemoryRecords(parent: HTMLElement, records: AgentMemoryRecord[]): void {
    parent.empty();
    if (records.length === 0) {
      createEmptyState(parent, {
        icon: "brain-circuit",
        title: "当前筛选没有回忆",
        description: "继续与桌面 AI 或微信 Bot 协作后，后台会把可跨会话复用的事实、偏好、决定和纠正放到这里。",
        compact: true
      });
      return;
    }

    for (const record of records) {
      const card = parent.createDiv({ cls: `lifeos-agent-memory-record is-${record.status}` });
      const top = card.createDiv({ cls: "lifeos-agent-memory-record-top" });
      const copy = top.createDiv({ cls: "lifeos-agent-memory-record-copy" });
      copy.createEl("h4", { text: record.title || "未命名回忆" });
      const badges = copy.createDiv({ cls: "lifeos-agent-memory-record-badges" });
      badges.createSpan({ cls: `lifeos-badge is-${record.status}`, text: this.agentMemoryStatusLabel(record.status) });
      badges.createSpan({ cls: "lifeos-badge", text: this.agentMemoryKindLabel(record.kind) });
      badges.createSpan({ cls: "lifeos-badge", text: this.agentMemoryAuthorityLabel(record.authority) });
      if (record.scope.projectScopeId) badges.createSpan({ cls: "lifeos-badge", text: `项目：${record.scope.projectScopeId}` });
      if (record.scope.channel) badges.createSpan({ cls: "lifeos-badge", text: `渠道：${record.scope.channel === "weixin" ? "微信" : "桌面"}` });
      if (record.scope.accountId) badges.createSpan({ cls: "lifeos-badge", text: `账号：${this.abbreviate(record.scope.accountId, 20)}` });
      if (record.sourceTool) badges.createSpan({ cls: "lifeos-badge", text: `来源工具：${record.sourceTool}` });

      const controls = top.createDiv({ cls: "lifeos-agent-memory-record-actions" });
      if (record.status !== "forgotten" && record.status !== "confirmed") {
        createButton(controls, "确认", () => void this.changeAgentMemory(record.id, "confirm"), { primary: true, icon: "check" });
      }
      if (record.status !== "forgotten") {
        createButton(controls, "遗忘", () => void this.changeAgentMemory(record.id, "forget"), { ghost: true, icon: "trash-2", className: "lifeos-button-danger" });
      }

      renderMarkdownDisplay(this.app, this, card.createDiv({ cls: "lifeos-agent-memory-record-content" }), record.content);
      const meta = card.createDiv({ cls: "lifeos-agent-memory-record-meta" });
      meta.createSpan({ text: `置信度 ${Math.round(record.confidence * 100)}%` });
      meta.createSpan({ text: `更新 ${this.relativeTime(record.updatedAt)}` });
      if (record.lastAccessedAt) meta.createSpan({ text: `最近召回 ${this.relativeTime(record.lastAccessedAt)}` });
      if (record.supersedes?.length) meta.createSpan({ text: `取代 ${record.supersedes.length} 条旧回忆` });

      const evidence = card.createEl("details", { cls: "lifeos-agent-memory-evidence" });
      evidence.createEl("summary", { text: `证据与来源（${record.evidence.length}）` });
      if (record.evidence.length === 0) {
        evidence.createEl("p", { text: "这条回忆没有可核对证据，不会被视为已确认事实。" });
      } else {
        for (const item of record.evidence.slice(0, 3)) {
          const row = evidence.createDiv({ cls: "lifeos-agent-memory-evidence-row" });
          const evidenceCopy = row.createDiv();
          evidenceCopy.createEl("p", { text: item.excerpt || "无可读摘录" });
          const source = [item.path, item.turnId ? `节点 ${item.turnId}` : "", item.capturedAt ? this.relativeTime(item.capturedAt) : ""]
            .filter(Boolean)
            .join(" · ");
          if (source) evidenceCopy.createEl("small", { text: source });
          if (item.path) createButton(row, "打开", () => this.openAgentEvidence(item.path || ""), { ghost: true, icon: "external-link" });
        }
      }
    }
  }

  private renderAgentSkillSuggestions(parent: HTMLElement, suggestions: AgentSkillSuggestion[]): void {
    const section = parent.createDiv({ cls: "lifeos-agent-skill-suggestions" });
    const heading = section.createDiv({ cls: "lifeos-agent-memory-section-heading" });
    const copy = heading.createDiv();
    copy.createEl("h3", { text: "可复用 Skill 建议" });
    copy.createEl("p", { text: "同一流程重复出现后才提示；不会自动创建或改写 Skill。" });
    heading.createSpan({ cls: "lifeos-badge", text: `${suggestions.length} 条` });

    const list = section.createDiv({ cls: "lifeos-agent-skill-list" });
    for (const suggestion of suggestions) {
      const card = list.createDiv({ cls: "lifeos-agent-skill-card" });
      const cardCopy = card.createDiv();
      cardCopy.createEl("h4", { text: suggestion.title });
      cardCopy.createEl("p", { text: suggestion.reason });
      cardCopy.createEl("small", { text: `已出现 ${suggestion.occurrences} 次` });
      const controls = card.createDiv({ cls: "lifeos-agent-memory-record-actions" });
      createButton(controls, "复制草稿", () => void navigator.clipboard.writeText(suggestion.examplePrompt).then(
        () => new Notice("Skill 草稿已复制。"),
        () => new Notice("复制失败，请稍后重试。")
      ), { primary: true, icon: "copy" });
      createButton(controls, "忽略", () => void (async () => {
        await this.plugin.agent.dismissAgentSkillSuggestion(suggestion.id);
        await this.render(true);
      })(), { ghost: true, icon: "x" });
    }
  }

  private agentRecordMatchesFilter(record: AgentMemoryRecord, filter: AgentMemoryFilter): boolean {
    if (filter === "all") return true;
    if (filter === "active") return record.status === "candidate" || record.status === "confirmed";
    if (filter === "external") return record.authority === "external" && record.status !== "forgotten" && record.status !== "superseded";
    if (filter === "inactive") return ["stale", "superseded", "forgotten"].includes(record.status);
    return record.status === filter;
  }

  private async runAgentMemoryAction<T>(action: () => Promise<T>, success: (result: T) => string): Promise<void> {
    try {
      const result = await action();
      new Notice(success(result));
      await this.render(true);
    } catch (error) {
      new Notice(`操作失败：${String(error instanceof Error ? error.message : error)}`);
    }
  }

  private async changeAgentMemory(recordId: string, action: "confirm" | "forget"): Promise<void> {
    if (action === "forget" && !window.confirm("遗忘后该内容不会再参与召回，也不会被同一内容重新生成。确认遗忘吗？")) return;
    const changed = action === "confirm"
      ? await this.plugin.agent.confirmAgentMemory(recordId)
      : await this.plugin.agent.forgetAgentMemory(recordId);
    new Notice(changed ? (action === "confirm" ? "已确认这条 Agent 回忆。" : "已遗忘这条 Agent 回忆。") : "内容没有变化。");
    await this.render(true);
  }

  private openAgentEvidence(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
    else new Notice("来源文件已移动或不存在。证据摘录仍保留在回忆记录中。");
  }

  private agentMemoryStatusLabel(status: AgentMemoryStatus): string {
    if (status === "confirmed") return "已确认";
    if (status === "stale") return "已陈旧";
    if (status === "superseded") return "已取代";
    if (status === "forgotten") return "已遗忘";
    return "待确认";
  }

  private agentMemoryKindLabel(kind: AgentMemoryRecord["kind"]): string {
    const labels: Record<AgentMemoryRecord["kind"], string> = {
      preference: "偏好",
      fact: "事实",
      decision: "决定",
      procedure: "流程",
      correction: "纠正",
      "open-loop": "待继续",
      workflow: "工作流",
      external: "外部记忆"
    };
    return labels[kind];
  }

  private agentMemoryAuthorityLabel(authority: AgentMemoryRecord["authority"]): string {
    if (authority === "confirmed") return "用户确认";
    if (authority === "external") return "外部快照";
    return "AI 提炼";
  }

  private relativeTime(value: string): string {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return "未知时间";
    const delta = Math.max(0, Date.now() - timestamp);
    if (delta < 60_000) return "刚刚";
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
    if (delta < 30 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
    return new Date(timestamp).toLocaleDateString("zh-CN");
  }

  private abbreviate(value: string, max: number): string {
    if (value.length <= max) return value;
    return `${value.slice(0, Math.max(4, max - 5))}…${value.slice(-4)}`;
  }

  private renderSideGuide(parent: HTMLElement, tab: MemoryTab): void {
    const guide = createCard(parent, "lifeos-panel lifeos-memory-guide");
    const agent = tab === "agent";
    guide.createEl("h3", { text: agent ? "Agent 如何使用回忆" : "记忆如何进入正式库" });
    const steps = agent
      ? [
        ["范围", "先按项目，再按可选渠道或账号隔离。"],
        ["渐进", "先查索引，每轮只注入最相关的少量证据。"],
        ["核对", "候选可确认；陈旧内容会降级，遗忘内容永久排除。"]
      ]
      : [
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
