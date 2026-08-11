import { App, Component, Modal, Notice, TFile, setIcon } from "obsidian";
import { createButton } from "../components/Button";
import { createModalShell } from "../components/ModalShell";
import type PersonalLifeSystemPlugin from "../main";
import type { AiWorkspaceService } from "../services/AiWorkspaceService";
import {
  AI_WORKSPACE_DESKTOP_TOOLS,
  AI_WORKSPACE_TOOLS,
  AI_WORKSPACE_EXPORT_TOOLS,
  AI_WORKSPACE_NATIVE_TOOLS,
  aiWorkspaceToolSupportsDirectScan,
  aiWorkspaceToolLabel,
  type AiWorkspaceTool,
  AiWorkspaceContinuationPackage,
  AiWorkspaceImportOptions,
  AiWorkspaceImportResult,
  AiWorkspaceLocalHandoffRequest,
  AiWorkspacePreparedImport,
  AiWorkspaceProjectBinding,
  AiWorkspacePromptAsset,
  AiWorkspaceSessionSummary,
  AiWorkspaceSourceCandidate
} from "../services/ai-workspace/types";
import type { LifeOSProject } from "../types";
import { renderMarkdownDisplay } from "../utils/markdown-render";
import { workspaceSessionDisplayTitle } from "../services/ai-workspace/logic";

export class AiWorkspaceBindingModal extends Modal {
  private binding: AiWorkspaceProjectBinding | null = null;
  private workDirectories: string[] = [];
  private workListEl: HTMLElement | null = null;

  constructor(
    app: App,
    private project: LifeOSProject,
    private service: AiWorkspaceService,
    private plugin: PersonalLifeSystemPlugin,
    private onSaved?: (action: "saved" | "scan") => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-ai-workspace-modal-host");
    this.binding = await this.service.getOrCreateBinding(this.project.id);
    this.workDirectories = [...this.binding.workDirectories];
    const { body, footer } = createModalShell(this.contentEl, {
      title: `绑定工作目录：${this.project.name}`,
      subtitle: "一个项目可以绑定多个目录；国内工具、开源工具与网页 AI 分开管理，导入后仍保留各自来源。",
      icon: "folder-cog",
      className: "lifeos-ai-workspace-modal lifeos-ai-workspace-binding-modal"
    });

    const workSection = body.createDiv({ cls: "lifeos-ai-workspace-form-section" });
    this.sectionHeading(workSection, "项目工作目录", "用于判断会话属于哪个项目。只有路径匹配的会话会默认勾选。");
    this.workListEl = workSection.createDiv({ cls: "lifeos-ai-workspace-directory-list" });
    this.renderWorkDirectories();

    const directoryInput = workSection.createEl("input", {
      cls: "lifeos-ai-workspace-directory-picker",
      attr: { type: "file", multiple: "true" }
    });
    directoryInput.setAttr("webkitdirectory", "");
    const workActions = workSection.createDiv({ cls: "lifeos-ai-workspace-inline-actions" });
    createButton(workActions, "选择目录", () => directoryInput.click(), { icon: "folder-open", ghost: true });
    createButton(workActions, "手动添加", () => {
      this.workDirectories.push("");
      this.renderWorkDirectories();
    }, { icon: "plus", ghost: true });
    directoryInput.addEventListener("change", () => {
      const directory = this.service.bridge.deriveDirectoryFromFiles(Array.from(directoryInput.files ?? []));
      if (directory && !this.workDirectories.includes(directory)) this.workDirectories.push(directory);
      directoryInput.value = "";
      this.renderWorkDirectories();
    });

    const toolSection = body.createDiv({ cls: "lifeos-ai-workspace-form-section" });
    this.sectionHeading(
      toolSection,
      "工具来源",
      "Codex、Claude Code、OpenCode、CodeBuddy、WorkBuddy 和 Pi 可直接扫描；其他工具通过标准导出文件进入同一套会话管理。"
    );
    for (const tool of AI_WORKSPACE_NATIVE_TOOLS) {
      const source = this.binding.tools.find((item) => item.tool === tool);
      if (source) this.renderToolSource(toolSection, source);
    }
    const webSource = this.binding.tools.find((item) => item.tool === "web");
    if (webSource) this.renderToolSource(toolSection, webSource);
    this.renderExportToolSources(toolSection);

    footer.addClass("lifeos-task-modal-footer");
    createButton(footer, "取消", () => this.close(), { ghost: true });
    createButton(footer, "仅保存", () => void this.save(false), { ghost: true, icon: "save" });
    createButton(footer, "保存并检查会话", () => void this.save(true), { primary: true, icon: "scan-search" });
  }

  private renderWorkDirectories(): void {
    if (!this.workListEl) return;
    this.workListEl.empty();
    if (this.workDirectories.length === 0) {
      this.workListEl.createDiv({
        cls: "lifeos-ai-workspace-empty-inline",
        text: "尚未绑定目录。绑定后，扫描结果会自动识别项目归属。"
      });
      return;
    }
    this.workDirectories.forEach((directory, index) => {
      const row = this.workListEl!.createDiv({ cls: "lifeos-ai-workspace-directory-row" });
      const input = row.createEl("input", {
        cls: "lifeos-input lifeos-glass-input",
        attr: { type: "text", value: directory, placeholder: "例如 D:\\Projects\\LifeOS" }
      });
      input.addEventListener("input", () => {
        this.workDirectories[index] = input.value;
      });
      createButton(row, "移除", () => {
        this.workDirectories.splice(index, 1);
        this.renderWorkDirectories();
      }, { icon: "x", ghost: true });
    });
  }

  private renderToolSource(parent: HTMLElement, source: AiWorkspaceProjectBinding["tools"][number]): void {
    const card = source.tool === "web"
      ? parent.createDiv({ cls: "lifeos-ai-workspace-tool-source is-web" })
      : parent.createEl("details", { cls: `lifeos-ai-workspace-tool-source is-${source.tool}` });
    const header = source.tool === "web"
      ? card.createDiv({ cls: "lifeos-ai-workspace-tool-source-head" })
      : card.createEl("summary", { cls: "lifeos-ai-workspace-tool-source-head" });
    const toggle = header.createEl("label", { cls: "lifeos-ai-workspace-switch" });
    const checkbox = toggle.createEl("input", { attr: { type: "checkbox" } });
    checkbox.checked = source.enabled;
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    toggle.createSpan({ text: this.toolLabel(source.tool) });
    const status = header.createSpan({ cls: "lifeos-ai-workspace-source-status" });
    const syncStatus = (): void => {
      const available = this.service.bridge.sourcePathExists(source.tool, source.sourcePath);
      status.setText(source.tool === "web"
        ? this.plugin.getBrowserCaptureStatus().running ? "本地桥运行中" : "本地桥未运行"
        : available ? "已检测到" : "路径不可用");
      status.toggleClass("is-ready", available);
      status.toggleClass("is-missing", source.tool === "web"
        ? !this.plugin.getBrowserCaptureStatus().running
        : !available);
    };
    checkbox.addEventListener("change", () => {
      source.enabled = checkbox.checked;
      card.toggleClass("is-disabled", !source.enabled);
    });
    if (source.tool === "web") {
      card.createEl("p", {
        cls: "lifeos-ai-workspace-muted",
        text: this.plugin.settings.browserCaptureEnabled
          ? this.plugin.getBrowserCaptureStatus().message
          : "扩展已经安装也需要先启用本地桥。启用后复制连接信息，粘贴到扩展的“本地连接”中。"
      });
      const actions = card.createDiv({ cls: "lifeos-ai-workspace-inline-actions" });
      createButton(actions, this.plugin.getBrowserCaptureStatus().running ? "重新启动本地桥" : "启用本地桥", () => void (async () => {
        this.plugin.settings.browserCaptureEnabled = true;
        source.enabled = true;
        checkbox.checked = true;
        await this.plugin.saveSettings();
        const next = await this.plugin.refreshBrowserCaptureBridge();
        status.setText(next.running ? "本地桥运行中" : "本地桥启动失败");
        status.toggleClass("is-ready", next.running);
        status.toggleClass("is-missing", !next.running);
        card.querySelector<HTMLElement>(".lifeos-ai-workspace-muted")?.setText(next.message);
        new Notice(next.message, 7000);
      })(), { icon: "radio-tower", primary: !this.plugin.getBrowserCaptureStatus().running, ghost: this.plugin.getBrowserCaptureStatus().running });
      createButton(actions, "复制扩展连接信息", () => void (async () => {
        await navigator.clipboard.writeText(JSON.stringify(this.plugin.getBrowserCaptureConnection(), null, 2));
        new Notice("连接信息已复制。请粘贴到浏览器扩展的“本地连接”输入框。", 7000);
      })(), { icon: "copy", ghost: true });
      card.createEl("small", {
        cls: "lifeos-ai-workspace-source-help",
        text: "连接失败时仍可在扩展中下载标准 JSON，再回到“导入会话”手动选择。"
      });
      card.toggleClass("is-disabled", !source.enabled);
      syncStatus();
      return;
    }
    const path = this.field(card, "会话数据路径", source.sourcePath, "本地会话目录或数据库路径");
    path.addEventListener("input", () => {
      source.sourcePath = path.value;
      syncStatus();
    });
    const executable = this.field(card, "可执行命令（可选）", source.executable ?? "", source.tool);
    executable.addEventListener("input", () => {
      source.executable = executable.value.trim() || undefined;
    });
    if (source.tool === "workbuddy") {
      card.createEl("small", {
        cls: "lifeos-ai-workspace-source-help",
        text: "会话从 projects 目录读取；只有导入时主动勾选“保存工具全局记忆”，才会版本化 memory/*.md，不读取身份、连接器和设置文件。"
      });
    } else if (source.tool === "codebuddy") {
      card.createEl("small", {
        cls: "lifeos-ai-workspace-source-help",
        text: "兼容 .codebuddy 与 .codebuddycn；保留会话名称、消息关系、模型和工作目录。"
      });
    } else if (source.tool === "pi") {
      card.createEl("small", {
        cls: "lifeos-ai-workspace-source-help",
        text: "读取 ~/.pi/agent/sessions 的树形 JSONL，分支关系、会话名称和工具节点均可追溯。"
      });
    }
    card.toggleClass("is-disabled", !source.enabled);
    syncStatus();
  }

  private renderExportToolSources(parent: HTMLElement): void {
    if (!this.binding) return;
    const group = parent.createDiv({ cls: "lifeos-ai-workspace-export-sources" });
    const copy = group.createDiv({ cls: "lifeos-ai-workspace-export-sources-copy" });
    copy.createEl("strong", { text: "更多主流 AI 编程工具" });
    copy.createEl("p", {
      text: "支持 Cursor、Windsurf、Gemini CLI、GitHub Copilot、Kiro、Aider、Qwen Code、Trae、通义灵码、Cline、Roo Code 和 Continue。当前使用标准 JSON 或补充导出提示词导入。"
    });
    const grid = group.createDiv({ cls: "lifeos-ai-workspace-export-source-grid" });
    for (const tool of AI_WORKSPACE_EXPORT_TOOLS) {
      const source = this.binding.tools.find((item) => item.tool === tool);
      if (!source) continue;
      const label = grid.createEl("label", { cls: "lifeos-ai-workspace-export-source" });
      const checkbox = label.createEl("input", { attr: { type: "checkbox" } });
      checkbox.checked = source.enabled;
      label.createSpan({ text: this.toolLabel(tool) });
      checkbox.addEventListener("change", () => {
        source.enabled = checkbox.checked;
      });
    }
  }

  private async save(scanAfter: boolean): Promise<void> {
    if (!this.binding) return;
    const workDirectories = Array.from(new Set(this.workDirectories.map((path) => path.trim()).filter(Boolean)));
    const enabledDirectSources = this.binding.tools.filter((source) =>
      source.enabled && aiWorkspaceToolSupportsDirectScan(source.tool)
    );
    if (scanAfter && enabledDirectSources.length > 0 && workDirectories.length === 0) {
      new Notice("请先添加项目工作目录，用于只筛选属于当前项目的会话。", 7000);
      return;
    }
    const missingSources = enabledDirectSources.filter((source) =>
      !this.service.bridge.sourcePathExists(source.tool, source.sourcePath)
    );
    if (scanAfter && missingSources.length > 0) {
      new Notice(`这些来源路径不可用：${missingSources.map((source) => this.toolLabel(source.tool)).join("、")}。请修正路径或先关闭对应来源。`, 8000);
      return;
    }
    await this.service.saveBinding({
      ...this.binding,
      workDirectories,
      updatedAt: new Date().toISOString()
    });
    new Notice("项目工作目录与工具来源已保存。", 5000);
    this.close();
    await this.onSaved?.(scanAfter ? "scan" : "saved");
  }

  private sectionHeading(parent: HTMLElement, title: string, description: string): void {
    const heading = parent.createDiv({ cls: "lifeos-ai-workspace-section-heading" });
    heading.createEl("strong", { text: title });
    heading.createEl("p", { text: description });
  }

  private field(parent: HTMLElement, label: string, value: string, placeholder: string): HTMLInputElement {
    const wrap = parent.createDiv({ cls: "lifeos-form-field" });
    wrap.createEl("label", { text: label });
    return wrap.createEl("input", {
      cls: "lifeos-input lifeos-glass-input",
      attr: { type: "text", value, placeholder }
    });
  }

  private toolLabel(tool: AiWorkspaceTool): string {
    return aiWorkspaceToolLabel(tool);
  }
}

export class AiWorkspaceImportModal extends Modal {
  private candidates: AiWorkspaceSourceCandidate[] = [];
  private selectedKeys = new Set<string>();
  private manualCandidateKeys = new Set<string>();
  private prepared: AiWorkspacePreparedImport[] = [];
  private showUnmatched = false;
  private options: AiWorkspaceImportOptions = {
    includeToolCalls: false,
    includeFileReferences: true,
    includeProjectMemory: true,
    includeToolMemory: false,
    retainRawSnapshot: true,
    redactSecrets: true
  };
  private listEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private searchEl: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private searchMetaEl: HTMLElement | null = null;
  private searchClearButton: HTMLButtonElement | null = null;
  private searchQuery = "";
  private primaryButton: HTMLButtonElement | null = null;
  private scanButton: HTMLButtonElement | null = null;
  private ignoreButton: HTMLButtonElement | null = null;
  private busy = false;

  constructor(
    app: App,
    private project: LifeOSProject,
    private service: AiWorkspaceService,
    private onImported?: (results: AiWorkspaceImportResult[]) => void | Promise<void>,
    private autoScan = false
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-ai-workspace-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: `导入 AI 会话：${this.project.name}`,
      subtitle: "主动扫描后先预览归属、重复和冲突，再确认写入。未选择的会话不会自动进入项目。",
      icon: "scan-search",
      className: "lifeos-ai-workspace-modal lifeos-ai-workspace-import-modal"
    });
    this.renderOptions(body);
    this.renderManualImport(body);
    this.progressEl = body.createDiv({ cls: "lifeos-ai-workspace-progress", text: "准备检查本地会话" });
    this.progressEl.setAttr("aria-live", "polite");
    this.renderSearch(body);
    this.listEl = body.createDiv({ cls: "lifeos-ai-workspace-import-list" });
    this.renderCandidates();

    footer.addClass("lifeos-task-modal-footer", "lifeos-ai-workspace-import-footer");
    createButton(footer, "取消", () => this.close(), { ghost: true });
    this.ignoreButton = createButton(footer, "不再显示所选", () => void this.ignoreSelected(), { icon: "eye-off", ghost: true });
    this.scanButton = createButton(footer, "检查本地会话", () => void this.scan(), { icon: "refresh-cw", ghost: true });
    this.primaryButton = createButton(footer, "预览导入", () => void this.prepare(), {
      icon: "list-checks",
      primary: true
    });
    this.syncPrimaryButton();
    if (this.autoScan) window.setTimeout(() => void this.scan(), 0);
  }

  private renderSearch(parent: HTMLElement): void {
    this.searchEl = parent.createDiv({ cls: "lifeos-ai-workspace-import-search" });
    const icon = this.searchEl.createSpan({ cls: "lifeos-ai-workspace-import-search-icon" });
    setIcon(icon, "search");
    this.searchInput = this.searchEl.createEl("input", {
      cls: "lifeos-input lifeos-glass-input",
      attr: {
        type: "search",
        placeholder: "搜索会话名称、工具、目录或会话 ID",
        "aria-label": "搜索待导入会话"
      }
    });
    this.searchMetaEl = this.searchEl.createSpan({ cls: "lifeos-ai-workspace-import-search-meta" });
    this.searchClearButton = createButton(this.searchEl, "清除搜索", () => {
      this.searchQuery = "";
      if (this.searchInput) {
        this.searchInput.value = "";
        this.searchInput.focus();
      }
      this.renderCandidates();
    }, { icon: "x", ghost: true });
    this.searchClearButton.addClass("lifeos-ai-workspace-import-search-clear");
    this.searchInput.addEventListener("input", () => {
      this.searchQuery = this.searchInput?.value ?? "";
      this.renderCandidates();
    });
    this.searchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this.searchQuery) return;
      event.preventDefault();
      this.searchQuery = "";
      if (this.searchInput) this.searchInput.value = "";
      this.renderCandidates();
    });
  }

  private renderOptions(parent: HTMLElement): void {
    const details = parent.createEl("details", { cls: "lifeos-ai-workspace-import-details" });
    details.createEl("summary", { text: "导入范围与隐私设置" });
    const section = details.createDiv({ cls: "lifeos-ai-workspace-import-options" });
    section.createEl("strong", { text: "导入内容" });
    const items: Array<{ key: keyof AiWorkspaceImportOptions; label: string; description: string }> = [
      { key: "includeProjectMemory", label: "保存项目记忆", description: "版本化保存已绑定目录中的 AGENTS.md、CLAUDE.md 和工具规则，交接给其他 AI 时一并带上。" },
      { key: "includeToolMemory", label: "保存工具全局记忆", description: "可选保存 WorkBuddy memory 等已启用工具的全局记忆；不导入身份、账号、连接器和设置文件。" },
      { key: "includeFileReferences", label: "保留文件引用", description: "记录对话涉及的文件路径，正文按需读取。" },
      { key: "includeToolCalls", label: "保留工具调用", description: "默认关闭，开启后工具调用也成为可追溯节点。" },
      { key: "retainRawSnapshot", label: "保留只读原始快照", description: "保留选中会话的原始 JSONL/导出，不扫描整库。" },
      { key: "redactSecrets", label: "标准化内容自动脱敏", description: "隐藏常见 API Key、Token 和密码；原始快照不改写。" }
    ];
    const grid = section.createDiv({ cls: "lifeos-ai-workspace-option-grid" });
    for (const item of items) {
      const label = grid.createEl("label", { cls: "lifeos-ai-workspace-check-option" });
      const checkbox = label.createEl("input", { attr: { type: "checkbox" } });
      checkbox.checked = this.options[item.key];
      const copy = label.createDiv();
      copy.createEl("strong", { text: item.label });
      copy.createEl("span", { text: item.description });
      checkbox.addEventListener("change", () => {
        this.options[item.key] = checkbox.checked;
        this.prepared = [];
        this.renderCandidates();
        this.syncPrimaryButton();
      });
    }
  }

  private renderManualImport(parent: HTMLElement): void {
    const details = parent.createEl("details", { cls: "lifeos-ai-workspace-import-details" });
    details.createEl("summary", { text: "自动扫描不可用？从文件补充导入" });
    const row = details.createDiv({ cls: "lifeos-ai-workspace-manual-import" });
    const copy = row.createDiv();
    copy.createEl("strong", { text: "导入工具导出文件" });
    copy.createEl("span", { text: "自动扫描不可用时，选择 JSON / JSONL 文件作为补充。" });
    const tool = row.createEl("select", { cls: "lifeos-input lifeos-glass-input" });
    for (const value of AI_WORKSPACE_TOOLS) {
      tool.createEl("option", { value, text: this.toolLabel(value) });
    }
    const input = row.createEl("input", {
      cls: "lifeos-ai-workspace-manual-file",
      attr: { type: "file", multiple: "true", accept: ".json,.jsonl" }
    });
    const supplementalButton = createButton(row, "复制补充导出提示词", () => void (async () => {
      try {
        if (tool.value === "web") {
          new Notice("网页 AI 请优先使用 Life OS 浏览器扩展；也可以选择扩展下载的标准 JSON。", 7000);
          return;
        }
        const result = await this.service.buildSupplementalExportPrompt(
          this.project.id,
          tool.value as AiWorkspaceTool
        );
        await navigator.clipboard.writeText(result.prompt);
        new Notice(`提示词已复制。让 ${this.toolLabel(tool.value as AiWorkspaceTool)} 执行后，再点“检查本地会话”。`, 8000);
      } catch (error) {
        new Notice(this.errorMessage(error), 7000);
      }
    })(), { icon: "clipboard-copy", ghost: true });
    const syncSupplementalLabel = (): void => {
      const label = supplementalButton.querySelector<HTMLElement>(".lifeos-v2-button-label");
      if (label) label.setText(tool.value === "web" ? "浏览器扩展说明" : "复制补充导出提示词");
    };
    tool.addEventListener("change", syncSupplementalLabel);
    syncSupplementalLabel();
    createButton(row, "选择文件", () => input.click(), { icon: "file-up", ghost: true });
    input.addEventListener("change", () => {
      try {
        for (const file of Array.from(input.files ?? [])) {
          const path = (file as File & { path?: string }).path;
          if (!path) throw new Error("当前环境没有提供文件绝对路径，请在桌面版 Obsidian 中导入。");
          const candidate = this.service.bridge.candidateFromManualFile(path, tool.value as AiWorkspaceTool);
          candidate.matchedProjectIds = [this.project.id];
          this.candidates = [...this.candidates.filter((item) => item.key !== candidate.key), candidate];
          this.manualCandidateKeys.add(candidate.key);
          this.selectedKeys.add(candidate.key);
        }
        this.prepared = [];
        this.renderCandidates();
        this.syncPrimaryButton();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "导出文件无法读取。", 7000);
      } finally {
        input.value = "";
      }
    });
  }

  private async scan(): Promise<void> {
    if (this.busy) return;
    const startedAt = performance.now();
    this.setBusy(true, "正在按工具检查本地会话…");
    try {
      const result = await this.service.scanProject(this.project.id);
      const manualCandidates = this.candidates.filter((candidate) => this.manualCandidateKeys.has(candidate.key));
      const merged = new Map<string, AiWorkspaceSourceCandidate>();
      for (const candidate of [...result.candidates, ...manualCandidates]) merged.set(candidate.key, candidate);
      this.candidates = Array.from(merged.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      this.showUnmatched = false;
      this.searchQuery = "";
      if (this.searchInput) this.searchInput.value = "";
      this.selectedKeys = new Set(
        this.candidates.filter((candidate) => candidate.matchedProjectIds.includes(this.project.id)).map((candidate) => candidate.key)
      );
      this.prepared = [];
      this.renderCandidates();
      const matched = this.matchedCandidates().length;
      const unmatched = this.candidates.length - matched;
      const elapsed = Math.max(0.1, (performance.now() - startedAt) / 1000).toFixed(1);
      const warning = result.warnings.length ? `；${result.warnings.join("；")}` : "";
      const hidden = unmatched > 0 ? `，另有 ${unmatched} 个未匹配会话已隐藏` : "";
      this.setProgress(`找到 ${matched} 个当前项目会话${hidden} · 用时 ${elapsed} 秒${warning}`);
    } catch (error) {
      this.setProgress(this.errorMessage(error));
      new Notice(this.errorMessage(error), 7000);
    } finally {
      this.setBusy(false);
    }
  }

  private renderCandidates(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    this.syncSearchUi();
    if (this.prepared.length > 0) {
      this.renderPreview();
      return;
    }
    if (this.candidates.length === 0) {
      const empty = this.listEl.createDiv({ cls: "lifeos-ai-workspace-import-empty" });
      setIcon(empty.createSpan(), "scan-search");
      const copy = empty.createDiv();
      copy.createEl("strong", { text: "尚未检查本地会话" });
      copy.createEl("p", { text: "点击“检查本地会话”，系统只列出结果，不会自动导入。" });
      return;
    }
    this.renderCandidateToolbar();
    const visibleCandidates = this.visibleCandidates();
    if (visibleCandidates.length === 0) {
      const empty = this.listEl.createDiv({ cls: "lifeos-ai-workspace-import-empty" });
      setIcon(empty.createSpan(), this.normalizedSearchQuery() ? "search-x" : "folder-search");
      const copy = empty.createDiv();
      copy.createEl("strong", {
        text: this.normalizedSearchQuery() ? "没有找到匹配的会话" : "没有与当前项目目录匹配的会话"
      });
      copy.createEl("p", {
        text: this.normalizedSearchQuery()
          ? "请尝试会话名称、工具、目录或会话 ID。"
          : "请返回检查项目工作目录；也可以主动显示未匹配会话后逐个确认。"
      });
      return;
    }
    for (const tool of AI_WORKSPACE_TOOLS) {
      const values = visibleCandidates.filter((candidate) => candidate.tool === tool);
      if (values.length === 0) continue;
      const group = this.listEl.createDiv({ cls: "lifeos-ai-workspace-import-group" });
      const heading = group.createDiv({ cls: "lifeos-ai-workspace-import-group-head" });
      heading.createEl("strong", { text: this.toolLabel(tool) });
      heading.createEl("span", { text: `${values.length} 个会话` });
      for (const candidate of values) {
        const row = group.createEl("label", { cls: "lifeos-ai-workspace-import-row" });
        const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
        checkbox.checked = this.selectedKeys.has(candidate.key);
        const copy = row.createDiv({ cls: "lifeos-ai-workspace-import-copy" });
        copy.createEl("strong", { text: this.candidateDisplayName(candidate) });
        copy.createEl("span", { text: `${this.formatTime(candidate.updatedAt)} · ${this.formatSize(candidate.size)} · ${candidate.cwd || "未识别工作目录"}` });
        const status = row.createSpan({
          cls: candidate.matchedProjectIds.includes(this.project.id)
            ? "lifeos-ai-workspace-badge is-success"
            : "lifeos-ai-workspace-badge is-warning",
          text: candidate.matchedProjectIds.includes(this.project.id) ? "目录匹配" : "需手动确认"
        });
        status.setAttr("title", candidate.matchedProjectIds.includes(this.project.id)
          ? "会话工作目录与当前项目绑定目录匹配"
          : "会话工作目录未与当前项目自动匹配");
        checkbox.addEventListener("change", () => {
          checkbox.checked ? this.selectedKeys.add(candidate.key) : this.selectedKeys.delete(candidate.key);
          this.prepared = [];
          this.renderCandidates();
          this.syncPrimaryButton();
        });
      }
    }
  }

  private renderCandidateToolbar(): void {
    if (!this.listEl) return;
    const matched = this.matchedCandidates();
    const unmatchedCount = this.candidates.length - matched.length;
    const toolbar = this.listEl.createDiv({ cls: "lifeos-ai-workspace-import-toolbar" });
    const copy = toolbar.createDiv();
    copy.createEl("strong", { text: `已选择 ${this.selectedKeys.size} 个` });
    copy.createEl("span", {
      text: `${matched.length} 个目录匹配${unmatchedCount > 0 ? ` · ${unmatchedCount} 个未匹配` : ""}`
    });
    const actions = toolbar.createDiv({ cls: "lifeos-ai-workspace-inline-actions" });
    createButton(actions, "全选匹配", () => {
      for (const candidate of matched) this.selectedKeys.add(candidate.key);
      this.renderCandidates();
      this.syncPrimaryButton();
    }, { icon: "list-checks", ghost: true });
    createButton(actions, "清空", () => {
      this.selectedKeys.clear();
      this.renderCandidates();
      this.syncPrimaryButton();
    }, { icon: "x", ghost: true });
    if (unmatchedCount > 0) {
      createButton(actions, this.showUnmatched ? "隐藏未匹配" : `显示未匹配 (${unmatchedCount})`, () => {
        this.showUnmatched = !this.showUnmatched;
        this.renderCandidates();
      }, { icon: this.showUnmatched ? "eye-off" : "eye", ghost: true });
      if (this.showUnmatched) {
        createButton(actions, "全选未匹配", () => {
          for (const candidate of this.candidates) {
            if (!candidate.matchedProjectIds.includes(this.project.id)) this.selectedKeys.add(candidate.key);
          }
          this.renderCandidates();
          this.syncPrimaryButton();
        }, { icon: "list-plus", ghost: true });
      }
    }
  }

  private renderPreview(): void {
    if (!this.listEl) return;
    const summary = this.listEl.createDiv({ cls: "lifeos-ai-workspace-preview-summary" });
    const copy = summary.createDiv();
    copy.createEl("strong", { text: `将处理 ${this.prepared.length} 个会话` });
    copy.createEl("span", { text: "冲突会创建新版本；旧版本保持可读，不覆盖原记录。" });
    createButton(summary, "返回修改选择", () => {
      this.prepared = [];
      this.renderCandidates();
      this.syncPrimaryButton();
    }, { icon: "arrow-left", ghost: true });
    for (const item of this.prepared) {
      const row = this.listEl.createDiv({ cls: "lifeos-ai-workspace-import-preview-row" });
      const copy = row.createDiv();
      copy.createEl("strong", { text: item.parsed.source.title || item.candidate.sourceSessionId });
      copy.createEl("span", {
        text: `${this.toolLabel(item.candidate.tool)} · ${item.parsed.messages.length} 个节点 · 重合 ${item.overlapCount} · 新增 ${item.newMessageCount} · 变化 ${item.changedMessageCount}`
      });
      const details = copy.createEl("details", { cls: "lifeos-ai-workspace-import-content-preview" });
      details.createEl("summary", { text: "查看实际会话内容" });
      const messages = item.parsed.messages.length <= 6
        ? item.parsed.messages
        : [...item.parsed.messages.slice(0, 4), ...item.parsed.messages.slice(-2)];
      for (const message of messages) {
        const messageRow = details.createDiv({ cls: `lifeos-ai-workspace-import-preview-message is-${message.role}` });
        messageRow.createEl("strong", {
          text: message.role === "user" ? "用户" : message.role === "assistant" ? "AI" : "工具"
        });
        messageRow.createEl("p", { text: this.previewText(message.content, 520) });
      }
      if (item.parsed.messages.length > messages.length) {
        details.createEl("small", { text: `中间 ${item.parsed.messages.length - messages.length} 个节点已折叠，导入后仍会完整保留。` });
      }
      row.createSpan({
        cls: `lifeos-ai-workspace-badge ${this.statusClass(item.status)}`,
        text: this.statusLabel(item.status)
      });
    }
  }

  private async prepare(): Promise<void> {
    if (this.busy) return;
    if (this.prepared.length > 0) {
      await this.importPrepared();
      return;
    }
    const selected = this.candidates.filter((candidate) => this.selectedKeys.has(candidate.key));
    if (selected.length === 0) {
      new Notice("请先选择要导入的会话。");
      return;
    }
    this.setBusy(true, "正在流式解析所选会话…");
    try {
      this.prepared = await this.service.prepareImports(
        this.project.id,
        selected,
        this.options,
        (label, current, total) => this.setProgress(`${current}/${total} · ${label}`)
      );
      this.renderCandidates();
      this.setProgress("导入预览已生成，请核对后确认。");
    } catch (error) {
      this.prepared = [];
      this.setProgress(this.errorMessage(error));
      new Notice(this.errorMessage(error), 8000);
    } finally {
      this.setBusy(false);
      this.syncPrimaryButton();
    }
  }

  private async importPrepared(): Promise<void> {
    this.setBusy(true, "正在分块写入会话与版本索引…");
    try {
      const results = await this.service.importPrepared(
        this.prepared,
        this.options,
        (label, current, total) => this.setProgress(`${current}/${total} · ${label}`)
      );
      const changed = results.filter((result) => result.status !== "duplicate").length;
      const duplicate = results.length - changed;
      new Notice(`已导入/更新 ${changed} 个会话，跳过 ${duplicate} 个重复会话。`, 7000);
      this.close();
      await this.onImported?.(results);
    } catch (error) {
      this.setProgress(this.errorMessage(error));
      new Notice(this.errorMessage(error), 8000);
      this.setBusy(false);
    }
  }

  private async ignoreSelected(): Promise<void> {
    const keys = Array.from(this.selectedKeys);
    if (keys.length === 0) {
      new Notice("请先选择不再显示的会话。");
      return;
    }
    await this.service.rejectCandidates(keys);
    this.candidates = this.candidates.filter((candidate) => !this.selectedKeys.has(candidate.key));
    this.selectedKeys.clear();
    this.prepared = [];
    this.renderCandidates();
    this.syncPrimaryButton();
    new Notice("这些会话以后扫描时不再重复列出。", 5000);
  }

  private setBusy(busy: boolean, message?: string): void {
    this.busy = busy;
    if (message) this.setProgress(message);
    this.primaryButton?.toggleClass("is-busy", busy);
    if (this.scanButton) this.scanButton.disabled = busy;
    if (this.ignoreButton) this.ignoreButton.disabled = busy;
    this.syncPrimaryButton();
  }

  private syncPrimaryButton(): void {
    if (!this.primaryButton) return;
    this.primaryButton.disabled = this.busy || (this.prepared.length === 0 && this.selectedKeys.size === 0);
    const label = this.primaryButton.querySelector<HTMLElement>(".lifeos-v2-button-label");
    if (label) label.textContent = this.busy ? "处理中…" : this.prepared.length > 0 ? "确认导入" : "预览导入";
  }

  private setProgress(message: string): void {
    this.progressEl?.setText(message);
  }

  private matchedCandidates(): AiWorkspaceSourceCandidate[] {
    return this.candidates.filter((candidate) => candidate.matchedProjectIds.includes(this.project.id));
  }

  private visibleCandidates(): AiWorkspaceSourceCandidate[] {
    const candidates = this.showUnmatched
      ? this.candidates
      : this.matchedCandidates();
    const tokens = this.normalizedSearchQuery().split(" ").filter(Boolean);
    if (tokens.length === 0) return candidates;
    return candidates.filter((candidate) => {
      const searchable = [
        this.candidateDisplayName(candidate),
        candidate.title,
        candidate.sourceSessionId,
        candidate.cwd,
        candidate.sourcePath,
        candidate.model,
        candidate.sourcePlatform,
        this.toolLabel(candidate.tool)
      ].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
      return tokens.every((token) => searchable.includes(token));
    });
  }

  private syncSearchUi(): void {
    if (!this.searchEl) return;
    const hidden = this.candidates.length === 0 || this.prepared.length > 0;
    this.searchEl.hidden = hidden;
    if (hidden) return;
    const total = this.showUnmatched ? this.candidates.length : this.matchedCandidates().length;
    const visible = this.visibleCandidates().length;
    this.searchMetaEl?.setText(this.normalizedSearchQuery() ? `显示 ${visible} / ${total}` : `${total} 个会话`);
    if (this.searchClearButton) this.searchClearButton.hidden = !this.normalizedSearchQuery();
  }

  private normalizedSearchQuery(): string {
    return this.searchQuery.trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
  }

  private candidateDisplayName(candidate: AiWorkspaceSourceCandidate): string {
    return workspaceSessionDisplayTitle(
      candidate.title,
      "",
      `${this.toolLabel(candidate.tool)} 会话 ${candidate.sourceSessionId.slice(0, 8)}`
    );
  }

  private statusLabel(status: AiWorkspacePreparedImport["status"]): string {
    if (status === "new") return "新会话";
    if (status === "append") return "追加版本";
    if (status === "conflict") return "变化冲突";
    return "完全重复";
  }

  private statusClass(status: AiWorkspacePreparedImport["status"]): string {
    if (status === "new") return "is-success";
    if (status === "append") return "is-info";
    if (status === "conflict") return "is-warning";
    return "";
  }

  private toolLabel(tool: AiWorkspaceTool): string {
    return aiWorkspaceToolLabel(tool);
  }

  private formatTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  private previewText(value: string, maxChars: number): string {
    const compact = value.replace(/\s+/gu, " ").trim();
    return compact.length > maxChars ? `${compact.slice(0, Math.max(0, maxChars - 3))}...` : compact;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export class AiWorkspacePromptModal extends Modal {
  constructor(
    app: App,
    private service: AiWorkspaceService,
    private projects: LifeOSProject[],
    private initial?: Partial<AiWorkspacePromptAsset> & { body?: string },
    private onSaved?: () => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-ai-workspace-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: this.initial?.id ? "保存提示词新版本" : "新建可复用提示词",
      subtitle: "先填写标题和正文即可保存，分类信息需要时再展开。",
      icon: "braces",
      className: "lifeos-ai-workspace-modal lifeos-ai-workspace-prompt-modal"
    });
    const title = this.field(body, "标题", this.initial?.title ?? "", "例如：代码审查与修复闭环");
    const bodyField = body.createDiv({ cls: "lifeos-form-field" });
    bodyField.createEl("label", { text: "提示词正文" });
    const textarea = bodyField.createEl("textarea", {
      cls: "lifeos-input lifeos-glass-input lifeos-ai-workspace-prompt-textarea",
      attr: { placeholder: "写入完整、可直接复用的提示词…" }
    });
    textarea.value = this.initial?.body ?? "";
    const details = body.createEl("details", { cls: "lifeos-ai-workspace-prompt-details" });
    details.createEl("summary", { text: "分类与版本设置（可选）" });
    const advanced = details.createDiv({ cls: "lifeos-ai-workspace-prompt-advanced" });
    const scope = this.select(advanced, "使用范围", [
      ["global", "全部项目"],
      ["project", "指定项目"]
    ], this.initial?.scope ?? "global");
    const project = this.select(advanced, "所属项目", this.projects.map((item) => [item.id, item.name]), this.initial?.projectId ?? this.projects[0]?.id ?? "");
    const tool = this.select(advanced, "适用工具", [
      ["any", "所有工具"],
      ...AI_WORKSPACE_TOOLS.map((value) => [value, aiWorkspaceToolLabel(value)] as [string, string])
    ], this.initial?.tool ?? "any");
    const tags = this.field(advanced, "标签", this.initial?.tags?.join(", ") ?? "", "例如：代码审查, 发布");
    const syncProject = (): void => {
      project.disabled = scope.value !== "project";
      project.closest<HTMLElement>(".lifeos-form-field")?.toggleClass("is-disabled", project.disabled);
    };
    scope.addEventListener("change", syncProject);
    syncProject();

    footer.addClass("lifeos-task-modal-footer");
    createButton(footer, "取消", () => this.close(), { ghost: true });
    createButton(footer, "保存版本", () => void (async () => {
      try {
        await this.service.savePrompt({
          id: this.initial?.id,
          title: title.value,
          body: textarea.value,
          scope: scope.value as "global" | "project",
          projectId: scope.value === "project" ? project.value : undefined,
          tool: tool.value as AiWorkspaceTool | "any",
          tags: tags.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
          sourceSessionId: this.initial?.sourceSessionId,
          sourceNodeIds: this.initial?.sourceNodeIds
        });
        new Notice("提示词版本已保存。", 5000);
        this.close();
        await this.onSaved?.();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "提示词保存失败。", 7000);
      }
    })(), { primary: true, icon: "save" });
  }

  private field(parent: HTMLElement, label: string, value: string, placeholder: string): HTMLInputElement {
    const wrap = parent.createDiv({ cls: "lifeos-form-field" });
    wrap.createEl("label", { text: label });
    return wrap.createEl("input", {
      cls: "lifeos-input lifeos-glass-input",
      attr: { type: "text", value, placeholder }
    });
  }

  private select(parent: HTMLElement, label: string, options: Array<[string, string]>, value: string): HTMLSelectElement {
    const wrap = parent.createDiv({ cls: "lifeos-form-field" });
    wrap.createEl("label", { text: label });
    const select = wrap.createEl("select", { cls: "lifeos-input lifeos-glass-input" });
    for (const [optionValue, text] of options) select.createEl("option", { value: optionValue, text });
    select.value = value;
    return select;
  }
}

export class AiWorkspaceContinuationModal extends Modal {
  private package: AiWorkspaceContinuationPackage | null = null;
  private previewEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private targetEl: HTMLSelectElement | null = null;
  private scopeEl: HTMLSelectElement | null = null;
  private revisionEl: HTMLSelectElement | null = null;
  private modeEl: HTMLSelectElement | null = null;
  private includeToolCallsEl: HTMLInputElement | null = null;
  private includeFilesEl: HTMLInputElement | null = null;
  private migrateButton: HTMLButtonElement | null = null;
  private readonly markdownComponent = new Component();

  constructor(
    app: App,
    private plugin: PersonalLifeSystemPlugin,
    private service: AiWorkspaceService,
    private session: AiWorkspaceSessionSummary
  ) {
    super(app);
  }

  onOpen(): void {
    this.markdownComponent.load();
    this.modalEl.addClass("lifeos-modal-host", "lifeos-ai-workspace-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: `迁移 AI 工作：${this.session.title}`,
      subtitle: "可迁移当前会话或整个项目。Life OS 会带上交接、项目记忆、文件和来源，目标工具从新会话接手。",
      icon: "arrow-right-left",
      className: "lifeos-ai-workspace-modal lifeos-ai-workspace-continuation-modal"
    });
    const controls = body.createDiv({ cls: "lifeos-ai-workspace-continuation-controls" });
    this.scopeEl = this.selectField(controls, "迁移范围", [
      ["session", "当前会话"],
      ["project", "整个项目（含会话索引与项目记忆）"]
    ]);
    this.targetEl = this.selectField(
      controls,
      "目标工具",
      AI_WORKSPACE_TOOLS.map((tool) => [tool, aiWorkspaceToolLabel(tool)] as [string, string])
    );
    this.targetEl.value = this.session.tool === "web" ? "codex" : this.session.tool;
    const revisionField = controls.createDiv({ cls: "lifeos-ai-workspace-field" });
    revisionField.createEl("label", { text: "来源版本" });
    const revision = revisionField.createEl("select", { cls: "lifeos-input lifeos-glass-input" });
    this.revisionEl = revision;
    for (const item of [...this.session.revisions].reverse()) {
      revision.createEl("option", {
        value: item.id,
        text: `${item.id} · ${this.reasonLabel(item.reason)} · ${item.messageCount} 条 · ${new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })}`
      });
    }
    revision.value = this.session.currentRevisionId;
    const modeField = controls.createDiv({ cls: "lifeos-ai-workspace-field" });
    modeField.createEl("label", { text: "携带内容" });
    const mode = modeField.createEl("select", { cls: "lifeos-input lifeos-glass-input" });
    this.modeEl = mode;
    mode.createEl("option", { value: "summary", text: "精简交接、结论与文件" });
    mode.createEl("option", { value: "outline", text: "交接 + 完整会话提纲" });
    mode.createEl("option", { value: "full", text: "包含完整可见对话（从文件读取）" });
    const includeOptions = controls.createDiv({ cls: "lifeos-ai-workspace-continuation-inclusions" });
    this.includeFilesEl = this.checkboxField(includeOptions, "携带文件引用", true, "只传路径、用途与来源，不复制项目文件本体");
    this.includeToolCallsEl = this.checkboxField(includeOptions, "携带工具调用", false, "仅在选择完整对话时加入工具节点，可能明显增大迁移包");
    const previewActions = body.createDiv({ cls: "lifeos-ai-workspace-inline-actions" });
    createButton(previewActions, "生成预览", () => void this.preview(), {
      icon: "eye",
      primary: true
    });
    this.statusEl = body.createDiv({
      cls: "lifeos-ai-workspace-progress",
      text: "选择范围、目标工具和携带内容，再生成只读预览。"
    });
    this.previewEl = body.createDiv({ cls: "lifeos-ai-workspace-continuation-preview" });

    footer.addClass("lifeos-task-modal-footer");
    createButton(footer, "关闭", () => this.close(), { ghost: true });
    createButton(footer, "复制启动提示", () => void this.copy(), { icon: "copy", ghost: true });
    createButton(footer, "打开迁移包入口", () => void this.openExport(), { icon: "file-text", ghost: true });
    if (this.session.tool === "web" && this.session.sourceUrl) {
      createButton(footer, "打开来源网页", () => void this.openWeb(), { icon: "external-link", ghost: true });
    } else if (this.session.tool !== "web") {
      createButton(footer, "打开原会话", () => void this.openOriginal(), { icon: "history", ghost: true });
    }
    this.migrateButton = createButton(
      footer,
      `迁移到 ${aiWorkspaceToolLabel(this.targetEl.value as AiWorkspaceTool)}`,
      () => void this.openNew(),
      { icon: "arrow-right-left", primary: true }
    );
    this.targetEl.addEventListener("change", () => {
      this.package = null;
      this.updateMigrateButtonLabel();
      this.statusEl?.setText("目标工具已改变，请重新生成预览。");
    });
    this.scopeEl.addEventListener("change", () => {
      this.package = null;
      this.statusEl?.setText("迁移范围已改变，请重新生成预览。");
    });
    this.revisionEl.addEventListener("change", () => {
      this.package = null;
      this.statusEl?.setText("来源版本已改变，请重新生成预览。");
    });
    this.modeEl.addEventListener("change", () => {
      this.package = null;
      this.statusEl?.setText("携带内容已改变，请重新生成预览。");
    });
    this.includeFilesEl.addEventListener("change", () => {
      this.package = null;
      this.statusEl?.setText("文件引用选项已改变，请重新生成预览。");
    });
    this.includeToolCallsEl.addEventListener("change", () => {
      this.package = null;
      this.statusEl?.setText("工具调用选项已改变，请重新生成预览。");
    });
  }

  private selectField(
    parent: HTMLElement,
    label: string,
    options: Array<[string, string]>
  ): HTMLSelectElement {
    const field = parent.createDiv({ cls: "lifeos-ai-workspace-field" });
    field.createEl("label", { text: label });
    const select = field.createEl("select", { cls: "lifeos-input lifeos-glass-input" });
    for (const [value, text] of options) select.createEl("option", { value, text });
    return select;
  }

  private checkboxField(
    parent: HTMLElement,
    label: string,
    checked: boolean,
    description: string
  ): HTMLInputElement {
    const field = parent.createEl("label", { cls: "lifeos-ai-workspace-inclusion-option" });
    const input = field.createEl("input", { attr: { type: "checkbox" } });
    input.checked = checked;
    const copy = field.createDiv({ cls: "lifeos-ai-workspace-inclusion-copy" });
    copy.createEl("strong", { text: label });
    copy.createEl("span", { text: description });
    return input;
  }

  private updateMigrateButtonLabel(): void {
    if (!this.migrateButton || !this.targetEl) return;
    const label = `迁移到 ${aiWorkspaceToolLabel(this.targetEl.value as AiWorkspaceTool)}`;
    const text = this.migrateButton.querySelector<HTMLElement>(".lifeos-v2-button-label");
    if (text) text.setText(label);
    else this.migrateButton.setAttr("aria-label", label);
  }

  private async preview(): Promise<void> {
    if (!this.revisionEl || !this.modeEl || !this.scopeEl || !this.targetEl || !this.includeToolCallsEl || !this.includeFilesEl) return;
    this.statusEl?.setText("正在生成只读预览与导出文件…");
    try {
      this.package = await this.service.buildContinuationPackage(
        this.session.id,
        this.revisionEl.value,
        this.modeEl.value as "summary" | "outline" | "full",
        {
          scope: this.scopeEl.value as "session" | "project",
          targetTool: this.targetEl.value as AiWorkspaceTool,
          includeToolCalls: this.includeToolCallsEl.checked,
          includeFiles: this.includeFilesEl.checked
        }
      );
      if (this.previewEl) {
        renderMarkdownDisplay(this.app, this.markdownComponent, this.previewEl, this.package.markdown, this.package.exportPath);
      }
      this.statusEl?.setText(
        `五文件迁移包已生成 · ${this.package.scope === "project" ? "整个项目" : "当前会话"} · ${aiWorkspaceToolLabel(this.package.targetTool)}`
      );
    } catch (error) {
      this.statusEl?.setText(error instanceof Error ? error.message : "预览生成失败。");
    }
  }

  private async ensurePackage(): Promise<AiWorkspaceContinuationPackage | null> {
    if (this.package) return this.package;
    new Notice("请先生成并核对上下文预览。");
    return null;
  }

  private async copy(): Promise<void> {
    const pkg = await this.ensurePackage();
    if (!pkg) return;
    await navigator.clipboard.writeText(pkg.launchPrompt);
    new Notice("目标工具启动提示已复制。", 4000);
  }

  private async openExport(): Promise<void> {
    const pkg = await this.ensurePackage();
    if (!pkg) return;
    const file = this.app.vault.getAbstractFileByPath(pkg.exportPath);
    if (!(file instanceof TFile)) {
      new Notice(`导出文件位于：${pkg.exportPath}`, 6000);
      return;
    }
    await this.app.workspace.getLeaf(true).openFile(file);
    this.close();
  }

  private async openOriginal(): Promise<void> {
    const pkg = await this.ensurePackage();
    if (!pkg) return;
    const prompt = this.launchPrompt(pkg);
    const state = await this.service.loadState();
    const executable = state.bindings
      .find((binding) => binding.projectId === this.session.projectId)
      ?.tools.find((tool) => tool.tool === this.session.tool)
      ?.executable;
    const result = await this.service.bridge.openOriginalSession(
      this.session.tool,
      this.session.sourceSessionId,
      this.session.cwd,
      prompt,
      executable
    );
    new Notice(result.message, result.opened ? 5000 : 8000);
    if (result.opened) this.close();
  }

  private async openWeb(): Promise<void> {
    const sourceUrl = this.safeWebUrl(this.session.sourceUrl || "");
    if (!sourceUrl) {
      new Notice("这条网页会话没有可用的原始链接。", 7000);
      return;
    }
    window.open(sourceUrl, "_blank", "noopener,noreferrer");
    new Notice("已打开来源网页。迁移到其他工具请使用右下角主按钮。", 5000);
  }

  private async openNew(): Promise<void> {
    const pkg = await this.ensurePackage();
    if (!pkg) return;
    const target = pkg.targetTool;
    const prompt = this.launchPrompt(pkg);
    await navigator.clipboard.writeText(prompt);
    if (target === "web") {
      new Notice("迁移提示词已复制。请在目标网页 AI 新建会话后粘贴发送。", 7000);
      return;
    }
    const state = await this.service.loadState();
    const executable = state.bindings
      .find((binding) => binding.projectId === this.session.projectId)
      ?.tools.find((tool) => tool.tool === target)
      ?.executable;
    const result = await this.service.bridge.openNewToolSession(
      target,
      this.session.cwd,
      prompt,
      executable
    );
    new Notice(result.message, result.opened ? 5000 : 8000);
    if (result.opened) this.close();
  }

  private launchPrompt(pkg: AiWorkspaceContinuationPackage): string {
    return pkg.launchPrompt;
  }

  private safeWebUrl(value: string): string {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
    } catch {
      return "";
    }
  }

  private reasonLabel(reason: AiWorkspaceSessionSummary["revisions"][number]["reason"]): string {
    return reason === "initial" ? "首次导入" : reason === "append" ? "增量追加" : "冲突修订";
  }

  onClose(): void {
    this.markdownComponent.unload();
    this.contentEl.empty();
  }
}

export class AiWorkspaceHandoffGeneratorModal extends Modal {
  private toolEl: HTMLSelectElement | null = null;
  private statusEl: HTMLElement | null = null;
  private pathEl: HTMLElement | null = null;
  private request: AiWorkspaceLocalHandoffRequest | null = null;

  constructor(
    app: App,
    private service: AiWorkspaceService,
    private session: AiWorkspaceSessionSummary,
    private onImported: () => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-ai-workspace-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: "用本地 AI 工具生成交接",
      subtitle: "Life OS 先生成只读任务文件；本地工具只负责整理并把结果写回指定位置，读取结果前不会替换当前交接。",
      icon: "terminal",
      className: "lifeos-ai-workspace-modal lifeos-ai-workspace-handoff-generator-modal"
    });
    const field = body.createDiv({ cls: "lifeos-ai-workspace-field" });
    field.createEl("label", { text: "生成工具" });
    this.toolEl = field.createEl("select", { cls: "lifeos-input lifeos-glass-input" });
    for (const tool of AI_WORKSPACE_DESKTOP_TOOLS) {
      this.toolEl.createEl("option", { value: tool, text: aiWorkspaceToolLabel(tool) });
    }
    this.toolEl.value = this.session.tool === "web" ? "codex" : this.session.tool;
    this.toolEl.addEventListener("change", () => {
      this.request = null;
      this.pathEl?.setText("");
      this.statusEl?.setText("生成工具已改变，请重新启动本地生成任务。");
    });
    const steps = body.createEl("ol", { cls: "lifeos-ai-workspace-local-handoff-steps" });
    steps.createEl("li", { text: "启动工具后，它会读取 Life OS 生成的任务文件。" });
    steps.createEl("li", { text: "等待工具写出结果，再回到这里点击“读取生成结果”。" });
    steps.createEl("li", { text: "Life OS 校验结构后保存为当前版本的交接快照。" });
    this.statusEl = body.createDiv({
      cls: "lifeos-ai-workspace-progress",
      text: "尚未启动本地生成任务。"
    });
    this.pathEl = body.createEl("code", { cls: "lifeos-ai-workspace-local-handoff-path" });

    footer.addClass("lifeos-task-modal-footer");
    createButton(footer, "关闭", () => this.close(), { ghost: true });
    createButton(footer, "读取生成结果", () => void this.importResult(), {
      icon: "refresh-cw",
      ghost: true
    });
    createButton(footer, "启动本地工具生成", () => void this.start(), {
      icon: "play",
      primary: true
    });
  }

  private async ensureRequest(): Promise<AiWorkspaceLocalHandoffRequest> {
    if (this.request) return this.request;
    if (!this.toolEl) throw new Error("请选择本地 AI 工具。");
    this.request = await this.service.prepareLocalHandoffGeneration(
      this.session.id,
      this.session.currentRevisionId,
      this.toolEl.value as AiWorkspaceTool
    );
    this.pathEl?.setText(this.service.absoluteVaultPath(this.request.outputPath));
    return this.request;
  }

  private async start(): Promise<void> {
    this.statusEl?.setText("正在准备只读任务文件…");
    try {
      const request = await this.ensureRequest();
      await navigator.clipboard.writeText(request.prompt);
      const state = await this.service.loadState();
      const executable = state.bindings
        .find((binding) => binding.projectId === this.session.projectId)
        ?.tools.find((tool) => tool.tool === request.tool)
        ?.executable;
      const result = await this.service.bridge.openNewToolSession(
        request.tool,
        this.session.cwd,
        request.prompt,
        executable
      );
      this.statusEl?.setText(result.opened
        ? "工具已启动。完成生成后回到这里读取结果。"
        : `${result.message} 提示词已复制，可手动在工具中运行。`);
      new Notice(result.message, result.opened ? 5000 : 8000);
    } catch (error) {
      this.statusEl?.setText(error instanceof Error ? error.message : "本地生成任务启动失败。");
    }
  }

  private async importResult(): Promise<void> {
    this.statusEl?.setText("正在读取并校验本地交接结果…");
    try {
      const request = await this.ensureRequest();
      await this.service.importLocalHandoffResult(
        this.session.id,
        this.session.currentRevisionId,
        request.outputPath
      );
      this.statusEl?.setText("本地交接结果已保存。");
      await this.onImported();
      new Notice("本地工具生成的交接已刷新。", 5000);
      this.close();
    } catch (error) {
      this.statusEl?.setText(error instanceof Error ? error.message : "尚未读取到有效结果。");
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class AiWorkspaceHandoffAddendumModal extends Modal {
  constructor(
    app: App,
    private service: AiWorkspaceService,
    private session: AiWorkspaceSessionSummary,
    private initialValue: string,
    private onSaved: () => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-ai-workspace-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: "编辑交接用户补充",
      subtitle: "记录只有你能确认的限制、验收口径或接手说明。刷新 AI 交接时，本区域会原样保留。",
      icon: "square-pen",
      className: "lifeos-ai-workspace-modal lifeos-ai-workspace-handoff-addendum-modal"
    });
    const field = body.createDiv({ cls: "lifeos-ai-workspace-field" });
    field.createEl("label", { text: "用户补充" });
    const textarea = field.createEl("textarea", {
      cls: "lifeos-input lifeos-glass-input lifeos-ai-workspace-handoff-addendum-input",
      attr: {
        placeholder: "例如：发布前必须完成移动端验收；不要修改用户手写日报；某个决定仍待我确认。"
      }
    });
    textarea.value = this.initialValue;
    footer.addClass("lifeos-task-modal-footer");
    createButton(footer, "取消", () => this.close(), { ghost: true });
    createButton(footer, "保存用户补充", () => void (async () => {
      try {
        await this.service.saveHandoffUserAddendum(this.session.id, textarea.value);
        await this.onSaved();
        new Notice("交接用户补充已保存，后续刷新不会覆盖。", 4500);
        this.close();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "用户补充保存失败。", 7000);
      }
    })(), { icon: "save", primary: true });
    window.setTimeout(() => textarea.focus(), 20);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class AiWorkspaceFileSegmentModal extends Modal {
  private startLine: number;
  private bodyEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private previousButton: HTMLButtonElement | null = null;
  private nextButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private service: AiWorkspaceService,
    private filePath: string,
    startLine = 1
  ) {
    super(app);
    this.startLine = Math.max(1, startLine);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-ai-workspace-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: this.filePath.split(/[\\/]/).pop() || this.filePath,
      subtitle: this.filePath,
      icon: "file-search",
      className: "lifeos-ai-workspace-modal lifeos-ai-workspace-file-modal"
    });
    this.statusEl = body.createDiv({ cls: "lifeos-ai-workspace-progress" });
    this.bodyEl = body.createEl("pre", { cls: "lifeos-ai-workspace-file-segment" });
    footer.addClass("lifeos-task-modal-footer");
    createButton(footer, "关闭", () => this.close(), { ghost: true });
    this.previousButton = createButton(footer, "前 200 行", () => void this.load(this.startLine - 200), { icon: "chevron-up", ghost: true });
    this.nextButton = createButton(footer, "后 200 行", () => void this.load(this.startLine + 200), { icon: "chevron-down", primary: true });
    void this.load(this.startLine);
  }

  private async load(startLine: number): Promise<void> {
    try {
      const result = await this.service.bridge.readFileSegment(this.filePath, Math.max(1, startLine), 200);
      this.startLine = result.startLine;
      this.statusEl?.setText(`第 ${result.startLine}-${result.endLine} 行`);
      this.bodyEl?.setText(result.text || "该范围没有可显示内容。");
      if (this.previousButton) this.previousButton.disabled = !result.hasPrevious;
      if (this.nextButton) this.nextButton.disabled = !result.hasNext;
    } catch (error) {
      this.statusEl?.setText(error instanceof Error ? error.message : "文件片段读取失败。");
      this.bodyEl?.setText("");
    }
  }
}
