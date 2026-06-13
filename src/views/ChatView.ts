import { ItemView, Notice, TFile, WorkspaceLeaf, requestUrl } from "obsidian";
import { appendAiGeneratedFooter, buildSystemPrompt, type AiMessage, type AiMessageContent, type AiUsage } from "../ai";
import { App, Modal } from "obsidian";
import { createButton } from "../components/Button";
import { createCard } from "../components/Card";
import { createEmptyState } from "../components/EmptyState";
import { createLifeOSShell } from "../components/LifeOSComponent";
import { createModalShell } from "../components/ModalShell";
import { createChipGroup } from "../components/SegmentedTabs";
import { CHAT_VIEW_TYPE } from "../constants";
import type PersonalLifeSystemPlugin from "../main";
import { ChatContextService, type ChatContextBundle, type ChatContextStatusCard } from "../services/ChatContextService";
import { ChatService, type ChatHistoryItem } from "../services/ChatService";
import { parseKnowledgeWritebackCandidate, parseMemoryWritebackCandidate, type KnowledgeWritebackCandidate, type MemoryWritebackCandidate } from "../services/ChatWritebackParser";
import { FileSystemService } from "../services/FileSystemService";
import { ProjectDocumentService } from "../services/ProjectDocumentService";
import { ProjectService } from "../services/ProjectService";
import {
  AiDocumentEditService,
  formatAiDocumentEditTargetForPrompt,
  parseAiDocumentEditCandidate,
  type AiDocumentEditCandidate,
  type AiDocumentEditTarget
} from "../services/AiDocumentEditService";
import { AI_SKILL_CATEGORIES, buildImportedAiSkillRecord, composeAiSkillPrompt, createImportedAiSkills, getAiSkills, getAiSkillsByCategory, normalizeAiSkillIds, normalizeGitHubSkillUrl, type AiSkill, type ImportedAiSkillRecord } from "../services/AiSkillService";
import { LlmWikiIntakeService, type LlmWikiSaveInput, type LlmWikiSaveResult } from "../services/LlmWikiIntakeService";
import { LlmWikiPathService } from "../services/LlmWikiPathService";
import { LlmWikiUndoService } from "../services/LlmWikiUndoService";
import { CHAT_IMPORT_ACCEPT, buildImportedDocumentsContextMarkdown, buildImportedDocumentsMarkdown, buildImportedDocumentsSummary, formatAttachmentSize, formatImportedDocumentReference, readImportedFile, saveImportedFileToVault, type ImportedDocument } from "../services/DocumentImportService";
import { PdfOcrService } from "../services/PdfOcrService";
import { buildNumericEvidenceMarkdown, extractNumericEvidence, hasNumericIntent, type NumericEvidence } from "../services/NumericEvidenceService";
import { MemoryService } from "../services/MemoryService";
import { fetchReadableUrl, searchWebAsMarkdown, type WebContextRequestOptions } from "../services/WebContextService";
import { applyAiProviderSelection, getAvailableAiProviderOptions, getCivilServiceInterviewThinkingModelPrompt, getExamChatModeLabel, getExamProfileLabel, localizeLifeOsPathParts, normalizeDirectoryLanguage, type AiProviderOption, type AiReasoningEffort, type AssistantStyle, type AssistantVerbosity } from "../settings";
import type { ChatContextMode } from "../settings";
import { requireProFeature, type ProFeatureId } from "../licensing/entitlement";
import type { ChatMessage, LifeOSProject } from "../types";
import { appendWritebackItems, applyWritebackItems, openWritebackPreview, type WritebackItem } from "../writeback-preview";
import { today } from "../utils/dates";
import { renderMarkdownDisplay } from "../utils/markdown-render";
import { writeFile as writeVaultFile } from "../utils/vault";

type UiChatMode = "chat" | "exam";
type UiChatContextMode = "smart" | "semantic" | "global";
type UiChatStyle = "warm-companion" | "concise-executor" | "strict-coach";
type UiChatLength = AssistantVerbosity;
type UiChatReasoningEffort = AiReasoningEffort;
type ChatRunStatus = "completed" | "interrupted" | "error" | "saved";
type RequestedWriteTarget = "diary" | "knowledge" | "memory" | "project-document" | null;
type WritebackTarget = "diary" | "knowledge" | "memory" | "project-document";

interface RecognizedWritebackCandidates {
  diary: DiaryWritebackCandidate | null;
  knowledge: KnowledgeWritebackCandidate | null;
  memory: MemoryWritebackCandidate | null;
}

interface DiaryWritebackCandidate {
  title: string;
  targetPath: string;
  content: string;
}

const MODE_LABELS: Record<Exclude<UiChatMode, "exam">, string> = { chat: "日常对话" };
const CONTEXT_MODE_LABELS: Record<UiChatContextMode, string> = {
  smart: "智能上下文",
  semantic: "语义增强",
  global: "全局分析"
};
const STYLE_LABELS: Record<UiChatStyle, string> = {
  "warm-companion": "温和",
  "concise-executor": "简洁",
  "strict-coach": "严格"
};
const LENGTH_LABELS: Record<UiChatLength, string> = { brief: "简短", normal: "标准", detailed: "详细" };
const AI_REASONING_EFFORT_OPTIONS: Array<{ id: UiChatReasoningEffort; label: string }> = [
  { id: "default", label: "默认" },
  { id: "low", label: "low" },
  { id: "medium", label: "medium" },
  { id: "high", label: "high" },
  { id: "max", label: "max" }
];
const CHAT_CONTEXT_WINDOW_TOKEN_BUDGET = 512000;
const CHAT_AUTO_COMPACT_MESSAGE_LIMIT = 30;
const QUICK_QUESTIONS = ["总结今天", "拆解任务", "复盘本周", "学习建议"];
const EXAM_QUICK_QUESTIONS = [
  "生成面试题",
  "评价我的回答",
  "按模型拆题",
  "保存练习记录"
];
const AI_GENERATED_FOOTER_PATTERN = /(?:^|\n)\s*(?:AI生成|AI鐢熸垚)\s*$/u;

export class LifeOSChatView extends ItemView {
  private messages: ChatMessage[] = [];
  private logEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private fileInputEl: HTMLInputElement | null = null;
  private attachmentListEl: HTMLElement | null = null;
  private loadingEl!: HTMLElement;
  private stopButtonEl!: HTMLButtonElement;
  private sendButtonEl!: HTMLButtonElement;
  private aiToggleEl!: HTMLInputElement;
  private diaryToggleEl!: HTMLInputElement;
  private contextEl: HTMLElement | null = null;
  private historyDrawerEl: HTMLElement | null = null;
  private contextDrawerEl: HTMLElement | null = null;
  private chatShellEl: HTMLElement | null = null;
  private sidePanelEl: HTMLElement | null = null;
  private runtimeStatusEl: HTMLElement | null = null;
  private activeDrawerKind: "history" | "context" | null = null;
  private contextCards: ChatContextStatusCard[] = [];
  private mode: UiChatMode;
  private contextMode: UiChatContextMode;
  private style: UiChatStyle;
  private length: UiChatLength;
  private reasoningEffort: UiChatReasoningEffort;
  private selectedSkillIds: string[];
  private selectedProjectScopeId = "";
  private isSkillPickerExpanded = false;
  private isProviderSwitchExpanded = false;
  private abortController: AbortController | null = null;
  private isStreaming = false;
  private stopNoticeShown = false;
  private streamTimedOut = false;
  private lastContextBundle: ChatContextBundle | null = null;
  private compressedContextSummary = "";
  private compressedContextMessageCount = 0;
  private compressedContextSourceCount = 0;
  private compressedContextUpdatedAt = "";
  private lastApiUsage: AiUsage | null = null;
  private visualViewportHandler: (() => void) | null = null;
  private composerResizeDragCleanup: (() => void) | null = null;
  private manualComposerHeight: number | null = null;
  private importedDocuments: ImportedDocument[] = [];
  private lastImportedDocuments: ImportedDocument[] = [];
  private importedAiSkills: AiSkill[] = [];

  constructor(leaf: WorkspaceLeaf, private plugin: PersonalLifeSystemPlugin) {
    super(leaf);
    this.mode = plugin.settings.defaultChatMode === "exam" ? "exam" : "chat";
    this.contextMode = this.normalizeContextMode(plugin.settings.defaultChatContextMode ?? "smart");
    this.style = this.normalizeStyle(plugin.settings.assistantStyle);
    this.length = plugin.settings.assistantVerbosity || "normal";
    this.reasoningEffort = this.normalizeReasoningEffort(plugin.settings.aiReasoningEffort);
    this.importedAiSkills = createImportedAiSkills(plugin.settings.importedAiSkills);
    this.selectedSkillIds = normalizeAiSkillIds(plugin.settings.defaultAiSkillIds, plugin.settings.defaultAiSkillId, this.importedAiSkills);
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "AI 助手";
  }

  async onOpen(): Promise<void> {
    await this.plugin.ensureBaseStructure();
    const draftInput = this.inputEl?.value ?? "";
    const importedSnapshot = [...this.importedDocuments];
    this.detachMobileViewportListener();
    this.detachComposerResizeDrag();
    this.containerEl.addClass("lifeos-chat-view-host");
    const container = this.containerEl.children[1] as HTMLElement;
    container.addClass("lifeos-chat-view-content");
    container.empty();
    this.historyDrawerEl = null;
    this.contextDrawerEl = null;
    this.contextEl = null;
    this.sidePanelEl = null;
    this.chatShellEl = null;
    this.runtimeStatusEl = null;
    this.fileInputEl = null;
    this.attachmentListEl = null;
    this.importedDocuments = importedSnapshot;
    this.importedAiSkills = createImportedAiSkills(this.plugin.settings.importedAiSkills);
    this.selectedSkillIds = normalizeAiSkillIds(this.plugin.settings.defaultAiSkillIds, this.plugin.settings.defaultAiSkillId, this.importedAiSkills);
    this.activeDrawerKind = null;
    const main = createLifeOSShell(container as HTMLElement, this.plugin, "chat");
    main.addClass("lifeos-chat-main-host");
    main.parentElement?.addClass("lifeos-chat-main-parent");
    main.closest(".lifeos-root")?.addClass("lifeos-chat-root");
    const root = main.createDiv({ cls: "lifeos-chat-shell lifeos-chat-shell-focused" });
    this.chatShellEl = root;
    const service = this.service();
    this.contextCards = await this.contextService().collectStatusCards();
    this.renderConversation(root, service);
    const pending = this.plugin.consumePendingChatPrompt();
    if (pending) {
      this.inputEl.value = pending;
      this.resizeComposer();
      this.inputEl.focus();
    } else if (draftInput && this.inputEl) {
      this.inputEl.value = draftInput;
      this.resizeComposer();
    }
  }

  async onClose(): Promise<void> {
    this.detachMobileViewportListener();
    this.detachComposerResizeDrag();
    this.containerEl.removeClass("lifeos-chat-view-host");
  }

  private renderConversation(parent: HTMLElement, service: ChatService): void {
    this.sidePanelEl = parent.createDiv({ cls: "lifeos-chat-side-panel", attr: { "aria-live": "polite" } });
    const panel = createCard(parent, "lifeos-chat-main");
    const top = panel.createDiv({ cls: "lifeos-chat-top" });
    const copy = top.createDiv({ cls: "lifeos-chat-top-copy" });
    copy.createEl("h1", { text: this.plugin.settings.assistantName || "Life OS" });
    copy.createEl("p", { text: "我会优先参考你的本地内容，而不是从零开始聊天。写入日记、知识或记忆前都需要你确认。" });
    const actions = top.createDiv({ cls: "lifeos-chat-top-actions" });
    const utilityAnchor = actions.createDiv({ cls: "lifeos-chat-utility-anchor" });
    createButton(actions, "新对话", () => this.startNewConversation(), { ghost: true, icon: "plus" });
    const saveToLifeButton = createButton(actions, "保存到 Life OS", () => void this.saveCurrentChatToLifeOS(), { ghost: true, icon: "save" });
    saveToLifeButton.disabled = !this.isLlmWikiEnabled();
    if (!this.isLlmWikiEnabled()) saveToLifeButton.title = "LLM Wiki 已在设置中关闭";
    createButton(actions, "清空当前会话", () => this.clearCurrentConversation(), { ghost: true, icon: "trash-2" });
    createButton(utilityAnchor, "聊天历史", () => void this.toggleHistoryPanel(service), { ghost: true, icon: "messages-square" });
    createButton(utilityAnchor, "上下文来源", () => this.toggleContextPanel(), { ghost: true, icon: "panel-right" });

    this.renderControlSummary(panel);

    this.logEl = panel.createDiv({ cls: "lifeos-chat-log" });
    this.renderMessages();
    this.scrollLogToBottom();
    this.loadingEl = panel.createDiv({ cls: "lifeos-chat-loading", text: "Life OS 正在整理上下文..." });
    this.loadingEl.hide();

    this.runtimeStatusEl = panel.createDiv({ cls: "lifeos-chat-runtime-status", attr: { "aria-live": "polite" } });
    this.renderRuntimeStatus(service);

    const quick = panel.createDiv({ cls: "lifeos-chat-quick" });
    for (const text of this.quickQuestionsForCurrentMode()) {
      createButton(quick, text, () => {
        this.inputEl.value = this.quickQuestionPrompt(text);
        this.resizeComposer();
        this.inputEl.focus();
      }, { ghost: true });
    }

    const composer = panel.createDiv({ cls: "lifeos-chat-composer" });
    this.renderComposerControls(composer);
    const attachmentBar = composer.createDiv({ cls: "lifeos-chat-attachment-bar" });
    attachmentBar.dataset.accept = CHAT_IMPORT_ACCEPT;
    this.fileInputEl = attachmentBar.createEl("input", {
      cls: "lifeos-chat-file-input",
      attr: {
        type: "file",
        multiple: "true",
        accept: CHAT_IMPORT_ACCEPT
      }
    });
    this.fileInputEl.onchange = () => void this.handleAttachmentFiles(this.fileInputEl?.files ?? null);
    createButton(attachmentBar, "添加文件", () => this.fileInputEl?.click(), {
      ghost: true,
      icon: "paperclip",
      className: "lifeos-chat-upload-button"
    });
    attachmentBar.createSpan({ cls: "lifeos-chat-attachment-hint", text: "支持文本、Markdown、CSV、JSON、PDF、DOCX、图片；扫描版 PDF 会自动 OCR，图片识别需要视觉模型" });
    this.attachmentListEl = composer.createDiv({ cls: "lifeos-chat-attachment-list" });
    this.renderAttachmentList();
    const resizeHandle = composer.createDiv({
      cls: "lifeos-chat-composer-resize-handle",
      attr: {
        role: "separator",
        "aria-orientation": "horizontal",
        "aria-label": "拖动调整输入框高度",
        title: "向上拖动放大输入框，向下拖动缩小"
      }
    });
    this.inputEl = composer.createEl("textarea", {
      cls: "lifeos-input",
      attr: { placeholder: "告诉我你想分析什么，或选择上面的快捷问题。" }
    });
    this.bindComposerResizeHandle(resizeHandle);
    composer.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.files?.length) return;
      event.preventDefault();
      composer.addClass("is-dragging-file");
    });
    composer.addEventListener("dragleave", () => composer.removeClass("is-dragging-file"));
    composer.addEventListener("drop", (event) => {
      if (!event.dataTransfer?.files?.length) return;
      event.preventDefault();
      composer.removeClass("is-dragging-file");
      void this.handleAttachmentFiles(event.dataTransfer.files);
    });
    this.inputEl.addEventListener("keydown", (event) => {
      const modEnter = event.key === "Enter" && (event.ctrlKey || event.metaKey);
      const plainEnter = event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey;
      const shouldSend = this.plugin.settings.chatSendBehavior === "modEnterToSend" ? modEnter : plainEnter;
      if (shouldSend) {
        event.preventDefault();
        void this.send(service);
      }
    });
    this.inputEl.addEventListener("paste", (event) => {
      const files = event.clipboardData?.files;
      if (!files || files.length === 0) return;
      void this.handleAttachmentFiles(files);
    });
    this.inputEl.addEventListener("input", () => this.resizeComposer());
    this.inputEl.addEventListener("focus", () => this.keepComposerVisible(true));
    this.visualViewportHandler = () => {
      this.resizeComposer();
      this.keepComposerVisible();
    };
    window.visualViewport?.addEventListener("resize", this.visualViewportHandler);
    const sendActions = composer.createDiv({ cls: "lifeos-chat-send-actions" });
    this.sendButtonEl = createButton(sendActions, "发送问题", () => void this.send(service), { primary: true, icon: "send", className: "lifeos-chat-send" });
    this.stopButtonEl = createButton(sendActions, "停止生成", () => this.stopGeneration(), { ghost: true, icon: "square", className: "lifeos-chat-stop" });
    this.stopButtonEl.hide();
  }

  private renderControlSummary(parent: HTMLElement): void {
    const selectedSkills = getAiSkills(this.selectedSkillIds, this.importedAiSkills);
    const activeProvider = getAvailableAiProviderOptions(this.plugin.settings).find((option) => option.active);
    const effort = AI_REASONING_EFFORT_OPTIONS.find((option) => option.id === this.reasoningEffort)?.label ?? this.reasoningEffort;
    const summary = parent.createDiv({ cls: "lifeos-chat-control-summary" });

    const addSummaryItem = (label: string, value: string): void => {
      const item = summary.createDiv({ cls: "lifeos-chat-control-summary-chip" });
      item.createSpan({ text: label });
      item.createEl("strong", { text: value });
    };

    addSummaryItem("Skill", selectedSkills.map((skill) => skill.name).join(" + ") || "Life OS 总管");
    addSummaryItem("模式", this.mode === "exam" ? getExamChatModeLabel(this.plugin.settings) : MODE_LABELS.chat);
    addSummaryItem("上下文", CONTEXT_MODE_LABELS[this.contextMode]);
    addSummaryItem("推理", effort);
    addSummaryItem("模型", activeProvider ? `${activeProvider.label} / ${activeProvider.model || "未设置"}` : "未配置");
    addSummaryItem("项目", this.selectedProjectScopeId ? "已选项目" : "全部项目");
    addSummaryItem("写入", this.plugin.settings.autoApplyChatToDaily ? "确认后写入" : "不写入");
  }

  private renderComposerControls(parent: HTMLElement): void {
    const controls = parent.createDiv({
      cls: this.isSkillPickerExpanded
        ? "lifeos-chat-controls lifeos-chat-composer-controls has-expanded-skill-picker"
        : "lifeos-chat-controls lifeos-chat-composer-controls"
    });
    const primary = controls.createDiv({ cls: "lifeos-chat-primary-controls" });
    this.renderSkillSelect(primary);
    const modeBox = primary.createDiv({ cls: "lifeos-chat-chip-controls" });
    this.renderModeControls(modeBox, false);
    this.renderAiProviderSwitch(primary);

    const toggles = controls.createDiv({ cls: "lifeos-chat-toggles" });
    this.aiToggleEl = this.toggle(
      toggles,
      "AI 回复",
      this.plugin.settings.chatDefaultAiReply !== false,
      undefined,
      { on: "开启", off: "关闭" }
    );
    this.diaryToggleEl = this.toggle(
      toggles,
      "记入",
      this.plugin.settings.autoApplyChatToDaily,
      "日记 / 知识库 / 记忆",
      { on: "确认后写入", off: "不写入" }
    );
    this.aiToggleEl.onchange = () => {
      this.plugin.settings.chatDefaultAiReply = this.aiToggleEl.checked;
      void this.plugin.saveSettings();
    };
    this.diaryToggleEl.onchange = () => {
      this.plugin.settings.autoApplyChatToDaily = this.diaryToggleEl.checked;
      void this.plugin.saveSettings();
    };

    const details = controls.createEl("details", { cls: "lifeos-chat-advanced-controls" });
    details.createEl("summary", { text: "更多回复设置" });
    const advanced = details.createDiv({ cls: "lifeos-chat-chip-controls lifeos-chat-advanced-grid" });
    this.renderContextModeControls(advanced);
    this.renderReasoningEffortControls(advanced);
    this.renderProjectScopeSelect(advanced);
    this.renderSecondaryControls(advanced);
  }

  private renderRuntimeStatus(service?: ChatService): void {
    if (!this.runtimeStatusEl) return;
    this.runtimeStatusEl.empty();
    const contextTokens = this.estimateCurrentContextTokens();
    const budgetTokens = this.contextWindowTokenBudget();
    const percent = Math.min(100, Math.round((contextTokens / Math.max(1, budgetTokens)) * 100));
    const context = this.runtimeStatusEl.createDiv({ cls: "lifeos-chat-runtime-metric" });
    context.setAttr("title", "这里显示的是 Life OS 的本地上下文预算估算，不是模型 API 的硬上限；真实上限取决于当前 AI 模型。");
    context.createSpan({ cls: "lifeos-chat-runtime-label", text: "上下文预算" });
    context.createSpan({ cls: "lifeos-chat-runtime-value", text: `${contextTokens.toLocaleString()} / ${budgetTokens.toLocaleString()} tok` });
    context.createSpan({ cls: "lifeos-chat-runtime-pill", text: `${percent}%` });

    const summary = this.runtimeStatusEl.createDiv({ cls: "lifeos-chat-runtime-metric" });
    summary.createSpan({ cls: "lifeos-chat-runtime-label", text: "压缩摘要" });
    summary.createSpan({
      cls: "lifeos-chat-runtime-value",
      text: this.compressedContextSummary
        ? `${this.compressedContextSourceCount} 条 / ${this.estimateTextTokens(this.compressedContextSummary).toLocaleString()} tok`
        : "未启用"
    });

    const usage = this.runtimeStatusEl.createDiv({ cls: "lifeos-chat-runtime-metric" });
    usage.createSpan({ cls: "lifeos-chat-runtime-label", text: "API 用量" });
    usage.createSpan({ cls: "lifeos-chat-runtime-value", text: this.formatApiUsage(this.lastApiUsage) });

    const actions = this.runtimeStatusEl.createDiv({ cls: "lifeos-chat-runtime-actions" });
    const runtimeService = service ?? this.service();
    createButton(actions, "压缩上下文", () => void this.manualCompactContext(runtimeService), { ghost: true, icon: "archive" });
    createButton(actions, "/ 指令", () => void this.appendLocalCommandResult("/help", this.slashCommandHelpMarkdown(), runtimeService), { ghost: true, icon: "terminal" });
  }

  private async manualCompactContext(service?: ChatService): Promise<void> {
    if (!requireProFeature(this.plugin, "aiContextEngine")) return;
    const summary = this.compactConversationContext("manual");
    const message = summary
      ? `已压缩早期对话。后续 AI 会优先带上这段摘要，并保留最近几轮原文。\n\n${this.compressedContextSummary}`
      : "当前会话还不需要压缩：最近几轮对话已经会直接进入上下文。";
    await this.appendLocalCommandResult("/compact", message, service);
  }

  private async handleSlashCommand(raw: string, service: ChatService): Promise<boolean> {
    const command = raw.trim().split(/\s+/)[0]?.toLowerCase();
    if (!command?.startsWith("/")) return false;
    const gatedFeature = this.featureForSlashCommand(command);
    if (gatedFeature && !requireProFeature(this.plugin, gatedFeature)) return true;

    if (command === "/clear") {
      this.inputEl.value = "";
      this.startNewConversation();
      new Notice("当前会话已清空。", 3000);
      return true;
    }

    if (command === "/compact" || command === "/compress") {
      await this.manualCompactContext(service);
      return true;
    }

    if (command === "/usage") {
      await this.appendLocalCommandResult(raw, this.usageStatusMarkdown(), service);
      return true;
    }

    if (command === "/memory") {
      await this.appendLocalCommandResult(raw, this.memoryStatusMarkdown(), service);
      return true;
    }

    if (command === "/remember" || command === "/mem") {
      await this.rememberFromSlashCommand(raw, service);
      return true;
    }

    if (command === "/sources") {
      this.toggleContextPanel();
      await this.appendLocalCommandResult(raw, "已打开上下文来源侧栏。本轮 AI 会优先参考侧栏列出的本地来源。", service);
      return true;
    }

    if (command === "/help" || command === "/?") {
      await this.appendLocalCommandResult(raw, this.slashCommandHelpMarkdown(), service);
      return true;
    }

    await this.appendLocalCommandResult(raw, `暂不认识这个指令：\`${command}\`。\n\n${this.slashCommandHelpMarkdown()}`, service);
    return true;
  }

  private featureForSlashCommand(command: string): ProFeatureId | null {
    if (command === "/remember" || command === "/mem") return "aiWriteback";
    if (command === "/compact" || command === "/compress") return "aiContextEngine";
    if (command === "/usage" || command === "/memory" || command === "/sources") return "aiContextEngine";
    return null;
  }

  private async appendLocalCommandResult(command: string, markdown: string, service?: ChatService): Promise<void> {
    if (this.inputEl) {
      this.inputEl.value = "";
      this.resizeComposer();
    }
    this.messages.push({ role: "user", content: command });
    this.messages.push({ role: "ai", content: markdown.trim() });
    this.renderMessages();
    this.scrollLogToBottom();
    this.renderRuntimeStatus(service);
    if (service) {
      await service.saveConversation(this.messages, this.saveOptions("saved", this.lastContextBundle?.contextSources ?? []));
    }
  }

  private slashCommandHelpMarkdown(): string {
    return [
      "## 可用 / 指令",
      "- `/compact`：把早期对话压缩成本地摘要，后续提问会带上摘要。",
      "- `/usage`：查看当前本地上下文预算和上一轮 API 用量。",
      "- `/sources`：打开上下文来源侧栏。",
      "- `/memory`：查看当前摘要和本地记忆来源状态。",
      "- `/remember 内容`：把一条长期偏好或稳定事实放入记忆待确认。",
      "- `/clear`：清空当前会话显示，不删除已经保存的历史。"
    ].join("\n");
  }

  private usageStatusMarkdown(): string {
    const contextTokens = this.estimateCurrentContextTokens();
    const budgetTokens = this.contextWindowTokenBudget();
    return [
      "## 当前上下文状态",
      `- 本地上下文预算：${contextTokens.toLocaleString()} / ${budgetTokens.toLocaleString()} tok`,
      "- 说明：这是 Life OS 发送前的保守预算估算，不是模型 API 的硬上限；真实上限取决于当前模型。",
      `- 压缩摘要：${this.compressedContextSummary ? `${this.compressedContextSourceCount} 条消息已摘要` : "未启用"}`,
      `- 上一轮 API 用量：${this.formatApiUsage(this.lastApiUsage)}`
    ].join("\n");
  }

  private memoryStatusMarkdown(): string {
    const memoryCard = this.contextCards.find((card) => card.key === "memory");
    return [
      "## 记忆与摘要状态",
      `- 长期记忆来源：${memoryCard?.available ? memoryCard.main : "暂未读取到可用记忆"}`,
      `- 压缩摘要：${this.compressedContextSummary ? this.compactForSummary(this.compressedContextSummary, 900) : "当前没有压缩摘要"}`,
      "- AI 写入长期记忆仍然需要确认，不会直接进入正式记忆。"
    ].join("\n");
  }

  private async rememberFromSlashCommand(raw: string, service: ChatService): Promise<void> {
    const content = raw.replace(/^\/(?:remember|mem)\s*/i, "").trim();
    if (!content) {
      await this.appendLocalCommandResult(
        raw,
        "请在指令后写入要记住的内容，例如：`/remember 我更喜欢先看结论，再看证据。`",
        service
      );
      return;
    }

    try {
      await new MemoryService(this.app, new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage))
        .appendCandidate({
          content,
          category: this.inferManualMemoryCategory(content),
          source: "ai-chat-slash",
          importance: "normal"
        });
      await this.appendLocalCommandResult(
        raw,
        `已加入记忆待确认：${content}\n\n它还没有进入正式长期记忆。请在“记忆”页面确认、编辑或忽略。`,
        service
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.appendLocalCommandResult(raw, `记忆写入待确认失败：${message}`, service);
    }
  }

  private inferManualMemoryCategory(content: string): string {
    if (/偏好|喜欢|不喜欢|习惯|倾向|希望|更想|更愿意/u.test(content)) return "偏好";
    if (/项目|插件|仓库|代码|开发|发布|产品/u.test(content)) return "项目";
    if (/备考|考试|公考|学习|课程|论文|研究/u.test(content)) return "学习";
    if (/健康|睡眠|运动|身体|情绪/u.test(content)) return "健康";
    return "其他";
  }

  private maybeAutoCompactConversationContext(extraText: string, documents: ImportedDocument[]): boolean {
    const documentText = documents.map((document) => document.text).join("\n\n");
    const projectedTokens = this.estimateCurrentContextTokens(`${extraText}\n${documentText}`);
    const shouldCompact = projectedTokens >= Math.floor(this.contextWindowTokenBudget() * 0.72) || this.messages.length - this.compressedContextMessageCount > CHAT_AUTO_COMPACT_MESSAGE_LIMIT;
    if (!shouldCompact) return false;
    return Boolean(this.compactConversationContext("auto"));
  }

  private compactConversationContext(reason: "manual" | "auto"): string {
    const keepRecent = 8;
    const end = Math.max(this.compressedContextMessageCount, this.messages.length - keepRecent);
    const source = this.messages.slice(this.compressedContextMessageCount, end);
    if (source.length === 0) return "";

    const lines = source.map((message, index) => {
      const role = message.role === "user" ? "用户" : (this.plugin.settings.assistantName || "AI");
      return `${index + 1}. ${role}: ${this.compactForSummary(message.content, 260)}`;
    });
    const stamp = new Date().toLocaleString();
    const block = [
      `### ${reason === "auto" ? "自动" : "手动"}压缩 ${stamp}`,
      `覆盖消息：${this.compressedContextMessageCount + 1}-${end}`,
      lines.join("\n")
    ].join("\n");
    this.compressedContextSummary = [this.compressedContextSummary, block].filter(Boolean).join("\n\n").slice(-7000);
    this.compressedContextMessageCount = end;
    this.compressedContextSourceCount += source.length;
    this.compressedContextUpdatedAt = stamp;
    this.renderRuntimeStatus();
    return block;
  }

  private resetContextCompression(): void {
    this.compressedContextSummary = "";
    this.compressedContextMessageCount = 0;
    this.compressedContextSourceCount = 0;
    this.compressedContextUpdatedAt = "";
    this.lastApiUsage = null;
    this.renderRuntimeStatus();
  }

  private contextWindowTokenBudget(): number {
    return CHAT_CONTEXT_WINDOW_TOKEN_BUDGET;
  }

  private estimateCurrentContextTokens(extraText = ""): number {
    const texts = [
      this.compressedContextSummary,
      this.messages.map((message) => `${message.role}: ${message.content}`).join("\n\n"),
      this.lastContextBundle?.promptContext ?? "",
      this.inputEl?.value ?? "",
      extraText
    ].filter(Boolean);
    return this.estimateTextTokens(texts.join("\n\n"));
  }

  private estimateAiMessagesTokens(messages: AiMessage[]): number {
    return messages.reduce((total, message) => total + this.estimateTextTokens(this.aiMessageContentToText(message.content)) + 4, 0);
  }

  private aiMessageContentToText(content: AiMessageContent): string {
    if (typeof content === "string") return content;
    return content.map((part) => part.type === "text" ? part.text : `[image:${part.image_url.detail ?? "auto"}]`).join("\n");
  }

  private estimateTextTokens(text: string): number {
    const normalized = String(text || "").trim();
    if (!normalized) return 0;
    const cjk = normalized.match(/[\u3400-\u9fff]/g)?.length ?? 0;
    const other = Math.max(0, normalized.length - cjk);
    return Math.max(1, Math.ceil(cjk * 0.9 + other / 4));
  }

  private compactForSummary(text: string, maxChars: number): string {
    const cleaned = this.stripAiGeneratedFooter(String(text || ""))
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length <= maxChars) return cleaned;
    return `${cleaned.slice(0, maxChars).trimEnd()}...`;
  }

  private formatApiUsage(usage: AiUsage | null): string {
    if (!usage) return "暂无";
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const total = usage.totalTokens ?? input + output;
    const suffix = usage.estimated ? "估算" : "实际";
    return `${total.toLocaleString()} tok（入 ${input.toLocaleString()} / 出 ${output.toLocaleString()}，${suffix}）`;
  }

  private buildApiUsage(actual: AiUsage | undefined, estimatedInputTokens: number, outputText: string): AiUsage {
    const estimatedOutputTokens = this.estimateTextTokens(outputText);
    const inputTokens = actual?.inputTokens ?? estimatedInputTokens;
    const outputTokens = actual?.outputTokens ?? estimatedOutputTokens;
    return {
      inputTokens,
      outputTokens,
      totalTokens: actual?.totalTokens ?? inputTokens + outputTokens,
      estimated: actual?.totalTokens === undefined && actual?.inputTokens === undefined && actual?.outputTokens === undefined
    };
  }

  private quickQuestionsForCurrentMode(): string[] {
    return this.mode === "exam" ? EXAM_QUICK_QUESTIONS : QUICK_QUESTIONS;
  }

  private quickQuestionPrompt(label: string): string {
    if (this.mode !== "exam") return label;
    const examLabel = getExamProfileLabel(this.plugin.settings);
    if (label === "生成面试题") {
      return `请生成一道${examLabel}结构化面试题。要求：给出题干、测评要素、答题提醒；先不要直接给完整答案，等我回答后再评价。`;
    }
    if (label === "评价我的回答") {
      return `请评价我上一条${examLabel}面试回答。按“输入问题-处理实操-输出闭环”指出优点、问题、可改写版本和下一次训练建议。`;
    }
    if (label === "按模型拆题") {
      return `请用“输入问题-处理实操-输出闭环”模型拆解这道${examLabel}面试题，先给审题路径，再给可落地的答题框架。`;
    }
    if (label === "保存练习记录") {
      return `请把这次${examLabel}面试练习整理成今日记录候选，包含题目、我的回答、评价要点和下一次训练任务，写入前需要我确认。`;
    }
    return label;
  }

  private renderAiProviderSwitch(parent: HTMLElement): void {
    const options = getAvailableAiProviderOptions(this.plugin.settings);
    const active = options.find((option) => option.active);
    const group = parent.createDiv({
      cls: this.isProviderSwitchExpanded
        ? "lifeos-chat-provider-switch is-expanded"
        : "lifeos-chat-provider-switch is-collapsed"
    });
    const head = group.createDiv({ cls: "lifeos-chat-provider-head" });
    head.createSpan({ cls: "lifeos-chip-label", text: "AI 模型" });
    head.createSpan({
      cls: "lifeos-chat-provider-current",
      text: active ? `${active.label} / ${active.model || "未设置模型"}` : "未配置"
    });
    const toggle = head.createEl("button", {
      cls: "lifeos-chat-provider-toggle",
      text: this.isProviderSwitchExpanded ? "收起" : "切换模型",
      attr: {
        type: "button",
        "aria-expanded": this.isProviderSwitchExpanded ? "true" : "false"
      }
    });
    toggle.disabled = this.isStreaming || options.length <= 1;
    this.bindProviderSwitchToggle(toggle, !this.isProviderSwitchExpanded);

    if (!this.isProviderSwitchExpanded) return;

    const list = group.createDiv({ cls: "lifeos-chat-provider-list" });
    for (const option of options) {
      const button = list.createEl("button", {
        cls: option.active ? "lifeos-chat-provider-button is-active" : "lifeos-chat-provider-button",
        attr: {
          type: "button",
          "aria-pressed": option.active ? "true" : "false",
          title: option.configured ? `切换到 ${option.label}` : `请先在设置中配置 ${option.label}`
        }
      });
      button.disabled = this.isStreaming || option.active || !option.configured;
      button.createSpan({ cls: "lifeos-chat-provider-name", text: option.label });
      button.createSpan({ cls: "lifeos-chat-provider-model", text: option.model || "未设置模型" });
      button.onclick = () => void this.switchAiProvider(option);
    }
  }

  private async switchAiProvider(option: AiProviderOption): Promise<void> {
    if (option.active) return;
    if (this.isStreaming) {
      new Notice("当前正在生成，停止后再切换 AI。");
      return;
    }
    if (!option.configured) {
      new Notice(`请先在设置中配置 ${option.label} 的 API。`);
      return;
    }

    const draftInput = this.inputEl?.value ?? "";
    applyAiProviderSelection(this.plugin.settings, option.id);
    await this.plugin.saveSettings();
    new Notice(`已切换 AI：${option.label} / ${this.plugin.settings.aiModel}`);
    this.isProviderSwitchExpanded = false;
    await this.onOpen();
    if (draftInput && this.inputEl) {
      this.inputEl.value = draftInput;
      this.resizeComposer();
      this.inputEl.focus();
    }
  }

  private bindProviderSwitchToggle(button: HTMLButtonElement, expanded: boolean): void {
    let pointerHandled = false;
    const toggle = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      this.setProviderSwitchExpanded(expanded);
    };
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      pointerHandled = true;
      toggle(event);
    });
    button.addEventListener("click", (event) => {
      if (pointerHandled) {
        pointerHandled = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      toggle(event);
    });
  }

  private setProviderSwitchExpanded(expanded: boolean): void {
    if (this.isProviderSwitchExpanded === expanded) return;
    this.isProviderSwitchExpanded = expanded;
    void this.onOpen();
  }

  private renderSkillSelect(parent: HTMLElement): void {
    const group = parent.createDiv({ cls: this.isSkillPickerExpanded ? "lifeos-chat-skill-control is-expanded" : "lifeos-chat-skill-control is-collapsed" });
    const selectedSkills = getAiSkills(this.selectedSkillIds, this.importedAiSkills);
    const names = selectedSkills.map((skill) => skill.name).join(" + ");
    const head = group.createDiv({ cls: "lifeos-chat-skill-head" });
    const skillCount = AI_SKILL_CATEGORIES.reduce((total, category) => total + getAiSkillsByCategory(category.id, this.importedAiSkills).length, 0) - 1;
    head.createSpan({ cls: "lifeos-chip-label", text: "名人 Skill（公开方法论）" });
    const toggle = head.createEl("button", {
      cls: "lifeos-muted-link lifeos-skill-expand-button",
      text: this.isSkillPickerExpanded ? "收起" : `展开选择（${skillCount} 个）`,
      attr: {
        type: "button",
        "aria-expanded": this.isSkillPickerExpanded ? "true" : "false"
      }
    });
    this.bindSkillPickerToggle(toggle, !this.isSkillPickerExpanded);

    const selected = group.createDiv({ cls: "lifeos-chat-selected-skills" });
    for (const skill of selectedSkills.slice(0, 3)) {
      const chip = selected.createEl("button", {
        cls: "lifeos-skill-chip is-active is-selected-summary",
        attr: { type: "button", title: `取消 ${skill.name}` }
      });
      chip.createSpan({ text: skill.name });
      chip.onclick = () => this.toggleSkill(skill.id);
    }
    if (this.selectedSkillIds.length > 3) {
      selected.createSpan({ cls: "lifeos-skill-more-count", text: `+${this.selectedSkillIds.length - 3}` });
    }

    group.createDiv({
      cls: "lifeos-chat-skill-hint",
      text: this.isSkillPickerExpanded
        ? `当前组合：${names}。来自精选公开方法论库，不含在世中国公众人物、刚去世中国人物、关系蒸馏、万能角色生成器和猎奇 Skill。`
        : `当前模式：${names}`
    });

    if (!this.isSkillPickerExpanded) return;

    const picker = group.createDiv({ cls: "lifeos-skill-picker" });
    const tools = picker.createDiv({ cls: "lifeos-skill-picker-tools" });
    tools.createSpan({ text: "按分类选择，可多选。真人 Skill 是公开方法论镜片；角色 Skill 只借用具体角色的价值观和问题意识。" });
    const toolActions = tools.createDiv({ cls: "lifeos-skill-picker-tool-actions" });
    createButton(toolActions, "安装 GitHub Skill", () => this.openGitHubSkillInstallModal(), { ghost: true, icon: "download" });
    const collapseButton = createButton(toolActions, "收起", () => this.setSkillPickerExpanded(false), { ghost: true });
    this.bindSkillPickerToggle(collapseButton, false);
    createButton(toolActions, "清空", () => {
      this.selectedSkillIds = ["lifeos-general"];
      this.persistSelectedSkills();
      void this.onOpen();
    }, { ghost: true });

    for (const category of AI_SKILL_CATEGORIES) {
      const skills = getAiSkillsByCategory(category.id, this.importedAiSkills);
      if (skills.length === 0) continue;
      const details = picker.createEl("details", { cls: "lifeos-skill-category" });
      if (category.id === "system" || this.selectedSkillIds.some((id) => skills.some((skill) => skill.id === id))) {
        details.open = true;
      }
      const summary = details.createEl("summary");
      summary.createSpan({ cls: "lifeos-skill-category-title", text: category.label });
      summary.createSpan({ cls: "lifeos-skill-category-count", text: `${skills.length}` });
      details.createDiv({ cls: "lifeos-skill-category-desc", text: category.description });
      const list = details.createDiv({ cls: "lifeos-chat-skill-list lifeos-chat-skill-list-expanded" });
      for (const skill of skills) {
        const chip = list.createEl("button", {
          cls: this.selectedSkillIds.includes(skill.id) ? "lifeos-skill-chip is-active" : "lifeos-skill-chip",
          attr: { type: "button", title: `${skill.name}｜${skill.description}` }
        });
        chip.createSpan({ text: skill.name });
        chip.onclick = () => this.toggleSkill(skill.id);
      }
    }
  }

  private toggleSkill(id: string): void {
    const next = new Set(this.selectedSkillIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selectedSkillIds = normalizeAiSkillIds(Array.from(next), undefined, this.importedAiSkills);
    this.persistSelectedSkills();
    void this.onOpen();
  }

  private bindSkillPickerToggle(button: HTMLButtonElement, expanded: boolean): void {
    let pointerHandled = false;
    const toggle = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      this.setSkillPickerExpanded(expanded);
    };
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      pointerHandled = true;
      toggle(event);
    });
    button.addEventListener("click", (event) => {
      if (pointerHandled) {
        pointerHandled = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      toggle(event);
    });
  }

  private setSkillPickerExpanded(expanded: boolean): void {
    if (this.isSkillPickerExpanded === expanded) return;
    this.isSkillPickerExpanded = expanded;
    void this.onOpen();
  }

  private openGitHubSkillInstallModal(): void {
    if (!requireProFeature(this.plugin, "aiSkillImport")) return;
    new GitHubSkillInstallModal(this.app, this.plugin, (record) => this.installImportedAiSkill(record)).open();
  }

  private async installImportedAiSkill(record: ImportedAiSkillRecord): Promise<void> {
    if (!requireProFeature(this.plugin, "aiSkillImport")) return;
    const localPath = `${this.plugin.getRoot().replace(/\/+$/, "")}/Skills/Imported/${record.id}.md`;
    const savedRecord = { ...record, localPath };
    await writeVaultFile(this.app, localPath, record.markdown);

    const existing = this.plugin.settings.importedAiSkills ?? [];
    this.plugin.settings.importedAiSkills = [
      ...existing.filter((item) => item.id !== savedRecord.id),
      savedRecord
    ];
    this.importedAiSkills = createImportedAiSkills(this.plugin.settings.importedAiSkills);
    this.selectedSkillIds = normalizeAiSkillIds([...this.selectedSkillIds, savedRecord.id], undefined, this.importedAiSkills);
    this.plugin.settings.defaultAiSkillIds = this.selectedSkillIds;
    this.plugin.settings.defaultAiSkillId = this.selectedSkillIds[0] ?? "lifeos-general";
    await this.plugin.saveSettings();
    new Notice(`GitHub Skill 已安装：${savedRecord.name}`);
    await this.onOpen();
  }

  private persistSelectedSkills(): void {
    this.plugin.settings.defaultAiSkillIds = this.selectedSkillIds;
    this.plugin.settings.defaultAiSkillId = this.selectedSkillIds[0] ?? "lifeos-general";
    void this.plugin.saveSettings();
  }

  private renderModeControls(parent: HTMLElement, showHint = true): void {
    const chips = createChipGroup<UiChatMode>(parent, "模式", [
      { id: "chat", label: MODE_LABELS.chat },
      { id: "exam", label: getExamChatModeLabel(this.plugin.settings) }
    ], this.mode, (value) => {
      this.mode = value;
      this.plugin.settings.defaultChatMode = value;
      void this.plugin.saveSettings();
      void this.onOpen();
    });
    chips.addClass("lifeos-segmented-light");
    if (showHint) {
      chips.createDiv({
        cls: "lifeos-chat-mode-hint",
        text: this.mode === "exam"
          ? `当前：${getExamChatModeLabel(this.plugin.settings)}，可以生成面试题、等待你回答，并按“输入问题-处理实操-输出闭环”评价。`
          : "当前：日常对话，适合整理日记、任务、知识、记忆和复盘。"
      });
    }
  }

  private renderContextModeControls(parent: HTMLElement): void {
    const chips = createChipGroup<UiChatContextMode>(parent, "上下文", [
      { id: "smart", label: CONTEXT_MODE_LABELS.smart },
      { id: "semantic", label: CONTEXT_MODE_LABELS.semantic },
      { id: "global", label: CONTEXT_MODE_LABELS.global }
    ], this.contextMode, (value) => {
      if (value !== "smart" && !requireProFeature(this.plugin, "aiContextEngine")) return;
      this.contextMode = value;
      this.plugin.settings.defaultChatContextMode = value;
      void this.plugin.saveSettings();
    });
    chips.addClass("lifeos-chat-context-mode-control");
  }

  private renderProjectScopeSelect(parent: HTMLElement): void {
    const group = parent.createDiv({ cls: "lifeos-chat-project-scope" });
    group.createSpan({ cls: "lifeos-chip-label", text: "项目问答" });
    const select = group.createEl("select", {
      cls: "lifeos-project-scope-select",
      attr: { "aria-label": "选择 AI 助手项目范围" }
    });
    select.createEl("option", { text: "全部项目", value: "" });
    select.value = this.selectedProjectScopeId;
    select.onchange = () => {
      if (select.value && !requireProFeature(this.plugin, "projectDocuments")) {
        select.value = "";
        this.selectedProjectScopeId = "";
        return;
      }
      this.selectedProjectScopeId = select.value;
    };
    void this.loadProjectScopeOptions(select);
  }

  private async loadProjectScopeOptions(select: HTMLSelectElement): Promise<void> {
    const current = this.selectedProjectScopeId;
    try {
      const fs = new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);
      const projects = await new ProjectService(this.app, fs).loadProjects();
      for (const project of projects) {
        select.createEl("option", { text: project.name, value: project.id });
      }
      const hasCurrent = !current || projects.some((project) => project.id === current);
      this.selectedProjectScopeId = hasCurrent ? current : "";
      select.value = this.selectedProjectScopeId;
    } catch {
      select.title = "项目列表暂时无法读取";
    }
  }

  private renderReasoningEffortControls(parent: HTMLElement): void {
    const chips = createChipGroup<UiChatReasoningEffort>(parent, "推理强度", AI_REASONING_EFFORT_OPTIONS, this.reasoningEffort, (value) => {
      if (value !== "default" && !requireProFeature(this.plugin, "aiReasoningEffort")) return;
      this.reasoningEffort = value;
      this.plugin.settings.aiReasoningEffort = value;
      void this.plugin.saveSettings();
    });
    chips.addClass("lifeos-chat-reasoning-effort-control");
    chips.setAttr("title", "支持 reasoning/effort 的模型会使用该参数；不支持时会自动回退。");
  }

  private renderSecondaryControls(parent: HTMLElement): void {
    createChipGroup<UiChatStyle>(parent, "风格", [
      { id: "warm-companion", label: STYLE_LABELS["warm-companion"] },
      { id: "concise-executor", label: STYLE_LABELS["concise-executor"] },
      { id: "strict-coach", label: STYLE_LABELS["strict-coach"] }
    ], this.style, (value) => {
      this.style = value;
      this.plugin.settings.assistantStyle = value;
      void this.plugin.saveSettings();
    });
    createChipGroup<UiChatLength>(parent, "长度", [
      { id: "brief", label: LENGTH_LABELS.brief },
      { id: "normal", label: LENGTH_LABELS.normal },
      { id: "detailed", label: LENGTH_LABELS.detailed }
    ], this.length, (value) => {
      this.length = value;
      this.plugin.settings.assistantVerbosity = value;
      void this.plugin.saveSettings();
    });
  }

  private async toggleHistoryPanel(service: ChatService): Promise<void> {
    if (this.activeDrawerKind === "history") {
      this.closeSideDrawer();
      return;
    }
    const drawer = this.openSideDrawer("history", "lifeos-chat-history-drawer");
    this.historyDrawerEl = drawer;
    const header = drawer.createDiv({ cls: "lifeos-chat-drawer-header" });
    header.createEl("h2", { text: "聊天历史" });
    const headerActions = header.createDiv({ cls: "lifeos-chat-drawer-actions" });
    const list = drawer.createDiv({ cls: "lifeos-history-list" });
    const clearButton = createButton(headerActions, "清空历史", () => void this.clearHistory(service, list, clearButton), {
      ghost: true,
      icon: "trash-2",
      className: "lifeos-button-danger lifeos-history-clear-button"
    });
    createButton(headerActions, "收起", () => {
      this.closeSideDrawer();
    }, { ghost: true });
    await this.renderHistoryList(list, service, clearButton);
  }

  private async renderHistoryList(parent: HTMLElement, service: ChatService, clearButton?: HTMLButtonElement): Promise<void> {
    parent.empty();
    const items = await service.loadHistory(50);
    if (clearButton) clearButton.disabled = items.length === 0;
    if (items.length === 0) {
      createEmptyState(parent, { icon: "messages-square", title: "还没有历史对话", description: "开始提问后，这里会显示最近的本地对话。", actions: [], compact: true });
      return;
    }
    for (const item of items) this.renderHistoryItem(parent, item, service, clearButton);
  }

  private renderHistoryItem(parent: HTMLElement, item: ChatHistoryItem, service: ChatService, clearButton?: HTMLButtonElement): void {
    const row = parent.createDiv({ cls: "lifeos-history-entry" });
    const button = row.createEl("button", { cls: "lifeos-history-item", attr: { type: "button" } });
    button.createSpan({ cls: "lifeos-history-title", text: this.historyTitle(item) });
    button.createSpan({ cls: "lifeos-history-subtitle", text: this.formatHistoryTime(item.title) });
    button.onclick = () => {
      this.messages = item.messages.length > 0 ? item.messages : this.messages;
      this.resetContextCompression();
      this.renderMessages();
      this.scrollLogToBottom();
      this.closeSideDrawer();
    };
    createButton(row, "删除", async () => {
      if (!window.confirm(`确认删除这条聊天历史吗？\n${this.historyTitle(item)}`)) return;
      const deleted = await service.deleteHistoryItem(item.path);
      new Notice(deleted ? "聊天历史已删除。" : "这条聊天历史已经不存在。");
      await this.renderHistoryList(parent, service, clearButton);
    }, { ghost: true, icon: "trash-2", className: "lifeos-button-danger lifeos-history-delete" });
  }

  private async clearHistory(service: ChatService, list: HTMLElement, clearButton: HTMLButtonElement): Promise<void> {
    if (!window.confirm("确认清空所有聊天历史吗？当前正在输入的内容不会被清空。")) return;
    const count = await service.clearHistory();
    new Notice(count > 0 ? `已清空 ${count} 条聊天历史。` : "没有可清空的聊天历史。");
    await this.renderHistoryList(list, service, clearButton);
  }

  private toggleContextPanel(): void {
    if (this.activeDrawerKind === "context") {
      this.closeSideDrawer();
      return;
    }
    const drawer = this.openSideDrawer("context", "lifeos-chat-context-drawer");
    this.contextDrawerEl = drawer;
    const header = drawer.createDiv({ cls: "lifeos-chat-drawer-header" });
    header.createEl("h2", { text: "上下文来源" });
    createButton(header, "收起", () => {
      this.closeSideDrawer();
    }, { ghost: true });
    drawer.createEl("p", { cls: "lifeos-muted", text: "AI 会参考这些本地内容。路径只作辅助信息，写回日记前需要你确认。" });
    this.contextEl = drawer;
    this.renderContextCards();
  }

  private openSideDrawer(kind: "history" | "context", drawerClass: string): HTMLElement {
    this.closeSideDrawer();
    const host = this.sidePanelEl ?? this.chatShellEl?.createDiv({ cls: "lifeos-chat-side-panel", attr: { "aria-live": "polite" } });
    if (!host) {
      throw new Error("Chat side panel is not ready.");
    }
    this.sidePanelEl = host;
    this.chatShellEl?.addClass("has-side-panel");
    this.activeDrawerKind = kind;
    return host.createDiv({ cls: `lifeos-chat-drawer ${drawerClass}` });
  }

  private closeSideDrawer(): void {
    this.historyDrawerEl = null;
    this.contextDrawerEl = null;
    this.contextEl = null;
    this.activeDrawerKind = null;
    this.sidePanelEl?.empty();
    this.chatShellEl?.removeClass("has-side-panel");
  }

  private renderContextCards(): void {
    if (!this.contextEl) return;
    const old = this.contextEl.querySelectorAll(".lifeos-context-item");
    old.forEach((el) => el.remove());
    for (const item of this.contextCards) {
      const card = this.contextEl.createDiv({ cls: `lifeos-context-item ${item.available ? "" : "is-empty"}` });
      card.createEl("strong", { text: item.label });
      card.createSpan({ text: item.main });
      card.createEl("small", { text: this.humanizeContextDetail(item), attr: { title: item.path } });
    }
  }

  private humanizeContextDetail(item: ChatContextStatusCard): string {
    if (!item.available) return item.detail || "暂未读取";
    if (item.key === "knowledge" && item.detail.includes("Knowledge")) return "知识库暂无最近笔记";
    return item.detail || item.path;
  }

  private async handleAttachmentFiles(files: FileList | File[] | null): Promise<void> {
    const incoming = Array.from(files ?? []);
    if (incoming.length === 0) return;
    if (!requireProFeature(this.plugin, "knowledgeImport")) return;
    const maxCount = Math.max(1, this.plugin.settings.maxChatAttachmentCount ?? 5);
    const maxBytes = Math.max(256 * 1024, this.plugin.settings.maxChatAttachmentBytes ?? 6 * 1024 * 1024);
    if (this.importedDocuments.length + incoming.length > maxCount) {
      new Notice(`最多同时导入 ${maxCount} 个文件。`);
      return;
    }

    for (const file of incoming) {
      try {
        const imported = await readImportedFile(file, {
          maxBytes,
          allowImageVision: this.canUseVisionModel(),
          enablePdfOcr: true,
          pdfOcr: new PdfOcrService(this.app)
        });
        try {
          const saved = await saveImportedFileToVault(this.app, file, {
            folderPath: this.chatAttachmentArchiveFolder()
          });
          imported.vaultPath = saved.vaultPath;
          imported.obsidianLink = saved.obsidianLink;
        } catch (archiveError) {
          const message = archiveError instanceof Error ? archiveError.message : String(archiveError);
          imported.warnings.push(`附件未归档到 Vault：${message}`);
        }
        this.importedDocuments.push(imported);
        if (imported.kind === "image" && !imported.dataUrl) {
          new Notice("图片已作为附件记录。识别图片需要先在设置中启用并填写视觉模型。", 6000);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`文件导入失败：${message}`, 7000);
      }
    }

    if (this.fileInputEl) this.fileInputEl.value = "";
    this.renderAttachmentList();
    this.keepComposerVisible(true);
  }

  private renderAttachmentList(): void {
    if (!this.attachmentListEl) return;
    this.attachmentListEl.empty();
    this.attachmentListEl.classList.toggle("is-empty", this.importedDocuments.length === 0);
    if (this.importedDocuments.length === 0) return;
    for (const document of this.importedDocuments) {
      const chip = this.attachmentListEl.createDiv({ cls: `lifeos-chat-attachment-chip is-${document.kind}` });
      chip.createSpan({
        cls: "lifeos-chat-attachment-chip-label",
        text: `${document.name} · ${document.kind} · ${formatAttachmentSize(document.size)}`
      });
      if (document.warnings.length > 0) {
        chip.createSpan({ cls: "lifeos-chat-attachment-warning", text: document.warnings[0] });
      }
      const remove = chip.createEl("button", {
        cls: "lifeos-chat-attachment-chip-action",
        text: "移除",
        attr: { type: "button", "aria-label": `移除 ${document.name}` }
      });
      remove.onclick = () => {
        this.importedDocuments = this.importedDocuments.filter((item) => item.id !== document.id);
        this.renderAttachmentList();
      };
    }
  }

  private canUseVisionModel(): boolean {
    return this.plugin.settings.enableVisionFileAnalysis === true && Boolean(this.plugin.settings.visionAiModel?.trim());
  }

  private chatAttachmentArchiveFolder(): string {
    const language = normalizeDirectoryLanguage(this.plugin.settings.directoryLanguage);
    return [
      this.plugin.getRoot(),
      ...localizeLifeOsPathParts(["Knowledge", "Attachments", today()], language)
    ].filter(Boolean).join("/");
  }

  private visionRequestModel(documents: ImportedDocument[]): string | undefined {
    const hasVisionImage = documents.some((document) => document.kind === "image" && document.dataUrl);
    if (!hasVisionImage || !this.canUseVisionModel()) return undefined;
    return this.plugin.settings.visionAiModel.trim();
  }

  private buildUserMessageContent(content: string, documents: ImportedDocument[]): string {
    const parts = [content || "请分析我导入的文件。"];
    const summary = buildImportedDocumentsSummary(documents);
    if (summary) parts.push(`导入文件：\n${summary}`);
    return parts.join("\n\n");
  }

  private buildEvidenceForRequest(content: string, documents: ImportedDocument[]): NumericEvidence[] {
    const evidence: NumericEvidence[] = [];
    evidence.push(...extractNumericEvidence({ text: content, sourceLabel: "用户输入", maxItems: 40 }));
    for (const document of documents) {
      if (!document.text.trim()) continue;
      evidence.push(...extractNumericEvidence({ text: document.text, sourceLabel: document.name, maxItems: 40 }));
    }
    return evidence.slice(0, 120);
  }

  private renderMessages(): void {
    if (!this.logEl) return;
    this.logEl.empty();
    if (this.messages.length === 0) {
      const assistantName = this.plugin.settings.assistantName || "Life OS";
      const welcome = this.logEl.createDiv({ cls: "lifeos-chat-welcome" });
      welcome.createEl("h2", { text: `你好，我是 ${assistantName}` });
      welcome.createEl("p", { text: "我可以结合你的日记、任务、记忆和复盘，帮你分析当前状态。" });
      welcome.createEl("p", { text: "我会优先参考你的本地内容，而不是从零开始聊天。" });
      welcome.createEl("p", { cls: "lifeos-chat-safe-note", text: "AI 写入日记、知识或记忆前需要你确认。" });
      return;
    }
    for (const message of this.messages) this.renderMessage(message);
  }

  private renderMessage(message: ChatMessage): HTMLElement {
    const roleClass = message.role === "user" ? "lifeos-chat-bubble-user" : "lifeos-chat-bubble-ai";
    const bubble = this.logEl.createDiv({ cls: `lifeos-chat-bubble ${roleClass}` });
    const header = bubble.createDiv({ cls: "lifeos-chat-bubble-header" });
    header.createDiv({ cls: "lifeos-chat-bubble-label", text: message.role === "user" ? "我" : (this.plugin.settings.assistantName || "Life OS") });
    const copy = header.createEl("button", {
      cls: "lifeos-chat-copy-button",
      text: "复制",
      attr: { type: "button", "aria-label": "复制这条对话" }
    });
    copy.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.copyMessageToClipboard(message.content);
    };
    const content = bubble.createDiv({ cls: "lifeos-chat-bubble-content" });
    renderMarkdownDisplay(this.app, this, content, message.content);
    if (message.role === "ai") this.renderWritebackActions(bubble, message.content);
    return content;
  }

  private async copyMessageToClipboard(content: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(content);
      new Notice("对话内容已复制。", 2200);
      return;
    } catch {
      const copied = this.copyMessageWithFallback(content);
      new Notice(copied ? "对话内容已复制。" : "复制失败，请手动选中内容复制。", 3000);
    }
  }

  private copyMessageWithFallback(content: string): boolean {
    const textarea = document.createElement("textarea");
    textarea.value = content;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    textarea.setAttribute("readonly", "true");
    document.body.appendChild(textarea);
    textarea.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      textarea.remove();
    }
  }

  private renderWritebackActions(parent: HTMLElement, content: string): void {
    const knowledge = this.parseKnowledgeWriteback(content);
    const diary = this.parseDiaryWriteback(content);
    const memory = this.parseMemoryWriteback(content);
    const candidates: RecognizedWritebackCandidates = { diary, knowledge, memory };
    if (!knowledge && !diary && !memory) return;
    const actions = parent.createDiv({ cls: "lifeos-chat-writeback-actions" });
    createButton(
      actions,
      "选择记入位置",
      () => void this.previewRecognizedWritebackChoice("", content, candidates, this.inferCandidateTarget(candidates)),
      { primary: true, icon: "file-check-2" }
    );
    const target = diary?.targetPath || knowledge?.targetPath || memory?.targetPath || "日记 / 知识库 / 记忆";
    actions.createSpan({ cls: "lifeos-muted", text: `下一步确认：${target}` });
  }

  private async send(service: ChatService): Promise<void> {
    if (this.isStreaming) return;
    const content = this.inputEl.value.trim();
    const documents = [...this.importedDocuments];
    if (!content && documents.length === 0) {
      new Notice("先写下你想问 Life OS 的内容。");
      return;
    }
    if (documents.length === 0 && await this.handleSlashCommand(content, service)) {
      return;
    }
    if (this.aiToggleEl.checked && !requireProFeature(this.plugin, "aiChat")) return;
    this.inputEl.value = "";
    if (documents.length > 0) this.lastImportedDocuments = documents;
    this.importedDocuments = [];
    this.renderAttachmentList();
    this.resizeComposer();
    const userDisplayContent = this.buildUserMessageContent(content, documents);
    const userMessage: ChatMessage = { role: "user", content: userDisplayContent };
    this.messages.push(userMessage);
    this.renderMessages();
    this.scrollLogToBottom();
    const autoCompacted = this.maybeAutoCompactConversationContext(content, documents);
    if (autoCompacted) {
      new Notice("上下文接近窗口上限，已自动生成本地摘要。", 4000);
    }
    this.renderRuntimeStatus(service);

    if (!this.aiToggleEl.checked) {
      await service.saveConversation(this.messages, this.saveOptions("saved", []));
      new Notice("已保存记录。");
      return;
    }

    if (!this.plugin.ai.isConfigured()) {
      const message = appendAiGeneratedFooter("AI 尚未配置，请先到设置中填写 Provider、Base URL 和 Model。");
      this.messages.push({ role: "ai", content: message });
      this.renderMessages();
      this.scrollLogToBottom();
      await service.saveConversation(this.messages, this.saveOptions("error", ["AI 未配置"]));
      new Notice(message, 6000);
      return;
    }

    const assistant: ChatMessage = { role: "ai", content: "" };
    this.messages.push(assistant);
    this.renderMessages();
    this.scrollLogToBottom();
    let assistantContent = this.logEl.lastElementChild?.querySelector(".lifeos-chat-bubble-content") as HTMLElement | null;
    this.abortController = new AbortController();
    this.isStreaming = true;
    this.stopNoticeShown = false;
    this.streamTimedOut = false;
    this.sendButtonEl.disabled = true;
    this.stopButtonEl.show();
    this.loadingEl.show();
    let streamed = "";
    const runState: { status: ChatRunStatus } = { status: "completed" };
    let numericEvidenceForRun: NumericEvidence[] = [];
    let numericIntentForRun = false;
    let documentEditTarget: AiDocumentEditTarget | null = null;
    let documentEditPromptContext = "";
    let estimatedInputTokens = 0;
    let resultUsage: AiUsage | undefined;
    const timeoutHandle = window.setTimeout(() => {
      if (!this.abortController || !this.isStreaming) return;
      this.streamTimedOut = true;
      this.abortController.abort();
    }, 90000);

    try {
      documentEditTarget = await this.resolveDocumentEditTarget(content);
      documentEditPromptContext = formatAiDocumentEditTargetForPrompt(documentEditTarget, content);
      const importedContextMarkdown = buildImportedDocumentsContextMarkdown(documents, content || "请分析这些导入文件。");
      const numericEvidence = this.buildEvidenceForRequest(content, documents);
      numericEvidenceForRun = numericEvidence;
      numericIntentForRun = hasNumericIntent(content) || documents.some((document) => hasNumericIntent(document.text));
      const numericEvidenceMarkdown = buildNumericEvidenceMarkdown(numericEvidence);
      const contextQuestion = [
        content || "请分析这些导入文件。",
        documentEditPromptContext,
        importedContextMarkdown,
        numericEvidenceMarkdown
      ].filter(Boolean).join("\n\n");
      this.lastContextBundle = await this.contextService().buildContextBundle({
        userMessage: contextQuestion,
        contextMode: this.contextMode,
        maxChars: this.selectedSkillIds.length > 1 ? 26000 : 34000,
        projectScopeId: this.selectedProjectScopeId || undefined,
        fetchUrl: (url) => this.fetchUrlText(url),
        searchWeb: (query) => this.searchWebText(query)
      });
      this.contextCards = this.lastContextBundle.statusCards;
      this.renderRuntimeStatus(service);

      const aiMessages = this.buildAiMessages(content || "请分析这些导入文件。", this.lastContextBundle.promptContext, documents, importedContextMarkdown, numericEvidenceMarkdown, documentEditPromptContext);
      estimatedInputTokens = this.estimateAiMessagesTokens(aiMessages);
      const result = await this.plugin.ai.completeStream(
        {
          temperature: this.mode === "exam" ? 0.25 : 0.45,
          model: this.visionRequestModel(documents),
          reasoningEffort: this.reasoningEffort,
          messages: aiMessages
        },
        {
          onStart: () => {
            if (assistantContent) assistantContent.setText("正在生成...");
          },
          onToken: (token) => {
            streamed += token;
            assistant.content = streamed;
            if (assistantContent) assistantContent.setText(streamed);
            this.scrollLogToBottom();
          },
          onDone: (text) => {
            streamed = text || streamed;
            assistant.content = streamed;
          },
          onAbort: () => {
            runState.status = "interrupted";
            if (this.streamTimedOut) {
              assistant.content = streamed || "生成超时：本轮上下文可能过长。请少选几个 Skill，或点“上下文来源”确认本轮读取内容后重试。";
            }
          },
          onError: (error) => {
            runState.status = "error";
            assistant.content = streamed || `AI 请求失败：${error}`;
          }
        },
        this.abortController.signal
      );
      resultUsage = result.usage;

      if (!result.ok && runState.status !== "interrupted") {
        runState.status = "error";
        assistant.content = streamed || `AI 请求失败：${result.error ?? "未知错误"}`;
      } else if (runState.status === "interrupted") {
        assistant.content = streamed || (this.streamTimedOut ? "生成超时：本轮上下文可能过长。请减少 Skill 或上下文后重试。" : "已停止生成。");
      } else {
        assistant.content = streamed || result.text || "";
      }
    } catch (error) {
      runState.status = "error";
      const message = error instanceof Error ? error.message : String(error);
      assistant.content = streamed || `AI 请求失败：${message}`;
      new Notice(`AI 请求失败：${message}`, 7000);
    } finally {
      window.clearTimeout(timeoutHandle);
      if (runState.status === "completed" && numericIntentForRun) {
        assistant.content = this.addNumericEvidenceWarningIfNeeded(assistant.content, numericEvidenceForRun);
      }
      if (assistant.content.trim()) assistant.content = appendAiGeneratedFooter(assistant.content);
      if (estimatedInputTokens > 0 || assistant.content.trim()) {
        this.lastApiUsage = this.buildApiUsage(resultUsage, estimatedInputTokens, assistant.content);
      }
      this.finishStreaming();
      this.renderMessages();
      this.scrollLogToBottom();
      this.renderRuntimeStatus(service);
      await service.saveConversation(this.messages, this.saveOptions(runState.status, this.lastContextBundle?.contextSources));
      const requestedWriteTarget = this.detectRequestedWriteTarget(content);
      const writebackCandidates: RecognizedWritebackCandidates = {
        diary: this.parseDiaryWriteback(assistant.content),
        knowledge: this.parseKnowledgeWriteback(assistant.content),
        memory: this.parseMemoryWriteback(assistant.content)
      };
      const documentEditCandidate = parseAiDocumentEditCandidate(assistant.content, documentEditTarget);
      if (runState.status === "completed" && documentEditCandidate) {
        await this.previewDocumentEditWriteback(documentEditCandidate);
        return;
      }
      if (
        runState.status === "completed"
        && this.shouldOfferWritebackTargetChoice(content, assistant.content, writebackCandidates, requestedWriteTarget)
      ) {
        await this.previewRecognizedWritebackChoice(content, assistant.content, writebackCandidates, requestedWriteTarget, documents);
      }
    }
  }

  private addNumericEvidenceWarningIfNeeded(content: string, evidence: NumericEvidence[]): string {
    const text = String(content || "");
    if (!text.trim()) return text;
    if (/资料不足|证据不足|没有足够|无法确认|无法根据.*得出|缺少.*证据/u.test(text)) return text;
    const citesEvidence = evidence.some((item) => item.sourceLabel && text.includes(item.sourceLabel)) ||
      /证据|来源|原文|候选数字|Candidate numeric evidence|第\s*\d+\s*行/u.test(text);
    if (citesEvidence) return text;
    return `${text.trimEnd()}\n\n> 数字证据提醒：这条回答涉及数字，但没有明确引用本地来源。请以原始日记、知识库或导入文件为准，再确认后写入。`;
  }

  private buildAiMessages(
    content: string,
    context: string,
    documents: ImportedDocument[] = [],
    importedMarkdown = "",
    numericEvidenceMarkdown = "",
    documentEditMarkdown = ""
  ): Array<{ role: "system" | "user" | "assistant"; content: AiMessageContent }> {
    const history = this.messages
      .slice(-8, -1)
      .filter((message) => message.content.trim())
      .map((message) => ({ role: message.role === "ai" ? "assistant" as const : "user" as const, content: message.content }));
    const selectedSkills = getAiSkills(this.selectedSkillIds, this.importedAiSkills);
    const skillPrompt = composeAiSkillPrompt(this.selectedSkillIds, this.plugin.settings.defaultAiSkillId, this.importedAiSkills);
    const skillNames = selectedSkills.map((skill) => skill.name).join(" + ");
    const selectedSkillGuard = [
      `本轮界面当前选中的 Skill：${skillNames || "Life OS 总管"}。`,
      "回答口吻必须以本轮当前选中 Skill 为准。历史消息、压缩摘要或旧回复中出现的其他 Skill 只能作为事实背景，不能延续其口吻。",
      selectedSkills.length > 1
        ? "因为当前是多选 Skill，请按已选 Skill 分段回答，不要把多个口吻混成一个平均人格。"
        : "因为当前是单选 Skill，请只使用这个 Skill 的第一人称方法论口吻，不要切换到未选中的人物或角色。"
    ].join("\n");
    const modeHint = this.mode === "exam" ? `你正在做${getExamProfileLabel(this.plugin.settings)}辅导。` : "你是日常个人上下文助手。";
    const examCoachingPrompt = this.mode === "exam"
      ? [
        "考公/备考辅导模式要求：",
        "- 如果用户要求生成面试题，先给一道题目、测评要素和答题提醒，不要替用户直接答完；明确提示“你可以先回答，我再评价”。",
        "- 如果用户给出回答，请按客观评价、优点、问题、可改写版本、下一次训练建议进行反馈。",
        "- 面试拆题优先使用“输入问题-处理实操-输出闭环”：先说明政策/问题从哪里来，再讲可运行机制，最后闭环到群众、治理、长期运营或个人成长。",
        getCivilServiceInterviewThinkingModelPrompt()
      ].join("\n")
      : "";
    const compressedHistory = this.compressedContextSummary
      ? [
        "## 已压缩的历史对话摘要",
        "下面是 Life OS 在本地生成的早期对话摘要，用来延续上下文；最近几轮原文仍会单独提供。",
        this.compressedContextSummary
      ].join("\n")
      : "";
    const userPrompt = [
      `当前 AI 处理方式：${skillNames}`,
      selectedSkillGuard,
      modeHint,
      examCoachingPrompt,
      `回复风格：${STYLE_LABELS[this.style]}，长度：${LENGTH_LABELS[this.length]}`,
      "请严格基于下面的 Life OS 上下文回答。区分事实、推测和建议，不要编造不存在的本地内容。",
      "当用户询问单独项目进度、各项目未完成任务或任务分析时，必须优先引用“项目任务概览”中的项目名、进度、未完成任务和最近完成任务，再结合日记、知识库、记忆和复盘分析原因与下一步；没有证据就说明资料不足。",
      "当上下文里出现“项目文档：...”时，说明用户在 AI 助手中选择了专属项目；回答该项目问答必须优先引用这些项目文档，再补充项目任务概览和其他本地资料。",
      "如果上下文包含 URL Context 或 Web Search，请把它们当作外部网页快照使用，并在回答中说明来源链接；如果网页读取失败，明确说明未读到网页正文，不要用常识猜成事实。",
      "涉及金额、次数、日期、进度、分数、统计或趋势时，必须引用候选数字证据表（Candidate numeric evidence）或 Life OS 上下文中的原文；没有证据就说明资料不足。",
      "如果用户表达了保存、记入、归档或沉淀的意图，请先判断最合适的位置：今日日记、知识库、项目文档或记忆。用户无需自行复制内容，插件会提供选择位置和确认预览。",
      "如果用户要求修改、编辑、规整、润色、校对、调整格式或管理某个已有文档，必须优先使用“AI 文档编辑目标”里的目标文档全文；输出完整修改后的 Markdown，并使用“最终写回预览：文档修改”格式。不要声称已经改完文件，插件会让用户确认后再写入。",
      "如果需要保存到日记，请输出“最终写回预览：今日日记”和完整 Markdown 正文，插件会提供确认按钮。",
      "如果需要保存到知识库，请输出“最终写回预览：知识库条目”，包含“建议路径：知识库/...”和完整 Markdown 正文，插件会提供确认按钮。",
      "如果用户明确要求保存到当前项目、项目文档或项目资料，请输出“最终写回预览：项目文档”，给出适合放入项目 Documents 的 Markdown 正文；插件会按当前选中的项目创建专属文档。",
      "如果需要沉淀长期记忆，请输出“最终写回预览：记忆候选”，包含“分类：...”和“重要性：low|normal|high”，再给出候选记忆正文，插件会提供确认按钮。",
      compressedHistory,
      context,
      documentEditMarkdown,
      importedMarkdown,
      numericEvidenceMarkdown || (hasNumericIntent(content) ? "## Candidate numeric evidence\nNo numeric evidence was extracted from the imported files or user input." : ""),
      `用户问题：\n${content}`
    ].filter(Boolean).join("\n\n");
    const imageParts = documents
      .filter((document) => document.kind === "image" && document.dataUrl && this.canUseVisionModel())
      .map((document) => ({
        type: "image_url" as const,
        image_url: { url: document.dataUrl!, detail: "auto" as const }
      }));
    const userContent: AiMessageContent = imageParts.length > 0
      ? [{ type: "text", text: userPrompt }, ...imageParts]
      : userPrompt;
    return [
      { role: "system", content: `${buildSystemPrompt({ ...this.plugin.settings, assistantStyle: this.style, assistantVerbosity: this.length })}\n\n${skillPrompt}\n\n${selectedSkillGuard}` },
      ...history,
      { role: "user", content: userContent }
    ];
  }

  private stopGeneration(): void {
    if (!this.abortController || !this.isStreaming) return;
    this.abortController.abort();
    this.stopNoticeShown = true;
    new Notice("已停止生成。已生成内容会保留。", 4000);
  }

  private finishStreaming(): void {
    this.isStreaming = false;
    this.abortController = null;
    if (this.sendButtonEl) this.sendButtonEl.disabled = false;
    this.loadingEl?.hide();
    this.stopButtonEl?.hide();
  }

  private scrollLogToBottom(): void {
    if (!this.logEl) return;
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private async previewDiaryWriteback(userContent: string, aiContent: string): Promise<void> {
    if (!requireProFeature(this.plugin, "aiWriteback")) return;
    const date = today();
    const body = [`**我：** ${userContent}`];
    if (aiContent.trim()) body.push(`**${this.plugin.settings.assistantName || "Life OS"}：** ${aiContent}`);
    const item: WritebackItem = {
      id: `chat-diary-${Date.now()}`,
      kind: "append",
      title: "写入今日日记",
      content: `\n## AI 对话记录\n\n${body.join("\n\n")}\n`,
      targetPath: this.plugin.getTodayNotePath(date),
      checked: true
    };
    const selected = await openWritebackPreview(this.app, {
      title: "写回今日日记前确认",
      description: "AI 内容不会直接写入。请先检查下面的内容，确认后才会保存到今日日记。",
      confirmText: "确认写入",
      items: [item],
      onConfirm: async (items) => appendWritebackItems(this.app, items)
    });
    if (selected.length > 0) new Notice("AI 对话已写入今日日记。", 5000);
  }

  private async previewDiaryCandidateWriteback(candidate: DiaryWritebackCandidate, documents: ImportedDocument[] = []): Promise<void> {
    if (!requireProFeature(this.plugin, "aiWriteback")) return;
    const item: WritebackItem = {
      id: `chat-diary-candidate-${Date.now()}`,
      kind: "append",
      title: candidate.title,
      content: `\n${this.appendAttachmentReferences(candidate.content.trim(), documents)}\n`,
      targetPath: candidate.targetPath,
      checked: true
    };
    const selected = await openWritebackPreview(this.app, {
      title: "写入今日日记前确认",
      description: "AI 整理内容会先给你检查，确认后才会写入今日日记。",
      confirmText: "确认写入今日日记",
      items: [item],
      onConfirm: async (items) => appendWritebackItems(this.app, items)
    });
    if (selected.length > 0) new Notice("内容已写入今日日记。", 5000);
  }

  private async previewKnowledgeWriteback(candidate: KnowledgeWritebackCandidate, documents: ImportedDocument[] = []): Promise<void> {
    if (!requireProFeature(this.plugin, "aiWriteback")) return;
    const item: WritebackItem = {
      id: `chat-knowledge-${Date.now()}`,
      kind: "append",
      title: candidate.title,
      content: `${this.appendAttachmentReferences(candidate.content.trimEnd(), documents)}\n`,
      targetPath: candidate.targetPath,
      checked: true
    };
    const selected = await openWritebackPreview(this.app, {
      title: "写入知识库前确认",
      description: "AI 内容不会直接落库。请先检查路径和正文，确认后才会保存为 Markdown 知识笔记。",
      confirmText: "确认写入知识库",
      items: [item],
      onConfirm: async (items) => applyWritebackItems(this.app, items)
    });
    const file = selected[0] ? this.app.vault.getAbstractFileByPath(selected[0].targetPath) : null;
    if (file instanceof TFile) {
      new Notice("知识库条目已写入。", 5000);
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  private parseKnowledgeWriteback(content: string): KnowledgeWritebackCandidate | null {
    return parseKnowledgeWritebackCandidate(this.stripAiGeneratedFooter(content), {
      rootFolder: this.plugin.getRoot(),
      directoryLanguage: this.plugin.settings.directoryLanguage
    });
  }

  private async previewMemoryWriteback(candidate: MemoryWritebackCandidate, documents: ImportedDocument[] = []): Promise<void> {
    if (!requireProFeature(this.plugin, "aiWriteback")) return;
    const item: WritebackItem = {
      id: `chat-memory-${Date.now()}`,
      kind: "append",
      title: candidate.title,
      content: this.appendInlineAttachmentReferences(candidate.content.trim(), documents),
      targetPath: candidate.targetPath,
      checked: true
    };
    const selected = await openWritebackPreview(this.app, {
      title: "写入记忆前确认",
      description: "长期记忆会先进入待确认列表，之后你可以在记忆页面确认或忽略。",
      confirmText: "确认写入记忆",
      items: [item],
      onConfirm: async (items) => {
        const content = items[0]?.content.trim();
        if (!content) return;
        await new MemoryService(this.app, new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage)).appendCandidate({
          content,
          category: candidate.category,
          importance: candidate.importance,
          source: "ai-chat"
        });
      }
    });
    if (selected.length > 0) new Notice("记忆候选已写入待确认列表。", 5000);
  }

  private async resolveDocumentEditTarget(userContent: string): Promise<AiDocumentEditTarget | null> {
    const target = await new AiDocumentEditService(this.app).resolveTarget(userContent);
    if (target && !requireProFeature(this.plugin, "aiDocumentEdit")) return null;
    return target;
  }

  private async previewDocumentEditWriteback(candidate: AiDocumentEditCandidate): Promise<void> {
    if (!requireProFeature(this.plugin, "aiDocumentEdit")) return;
    if (!requireProFeature(this.plugin, "aiWriteback")) return;
    const item: WritebackItem = {
      id: `chat-document-edit-${Date.now()}`,
      kind: candidate.mode === "append" ? "append" : "replace",
      title: candidate.mode === "append" ? `追加到文档：${candidate.targetPath}` : candidate.title,
      content: candidate.content,
      targetPath: candidate.targetPath,
      checked: true
    };
    const selected = await openWritebackPreview(this.app, {
      title: candidate.mode === "append" ? "追加到文档前确认" : "修改文档前确认",
      description: "AI 不会直接改文件。请先检查目标路径和 Markdown 内容，确认后才会写入指定文档。",
      confirmText: candidate.mode === "append" ? "确认追加到文档" : "确认修改文档",
      items: [item],
      onConfirm: async (items) => applyWritebackItems(this.app, items)
    });
    const file = selected[0] ? this.app.vault.getAbstractFileByPath(selected[0].targetPath) : null;
    if (file instanceof TFile) {
      new Notice(candidate.mode === "append" ? "内容已追加到文档。" : "文档已按 AI 预览更新。", 5000);
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  private async previewProjectDocumentWriteback(
    userContent: string,
    aiContent: string,
    documents: ImportedDocument[] = []
  ): Promise<void> {
    if (!requireProFeature(this.plugin, "projectDocuments")) return;
    if (!requireProFeature(this.plugin, "aiWriteback")) return;
    const project = await this.getSelectedProjectForWriteback();
    if (!project) {
      new Notice("请先在 AI 助手上方选择一个具体项目，再写入项目文档。", 6000);
      return;
    }

    const fs = new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);
    const projectDocuments = new ProjectDocumentService(this.app, fs);
    const title = this.projectDocumentWritebackTitle(userContent, aiContent);
    const content = this.appendAttachmentReferences(this.projectDocumentWritebackContent(userContent, aiContent), documents);
    let createdPath = "";
    const item: WritebackItem = {
      id: `chat-project-document-${Date.now()}`,
      kind: "replace",
      title: `写入项目文档：${title}`,
      content: `${content.trim()}\n`,
      targetPath: `${projectDocuments.documentsPath(project)}/${title}.md`,
      checked: true
    };
    const selected = await openWritebackPreview(this.app, {
      title: "写入项目文档前确认",
      description: `将保存到项目「${project.name}」的 Documents 目录。AI 内容不会直接落库，确认后才会创建项目文档。`,
      confirmText: "确认写入项目文档",
      items: [item],
      onConfirm: async (items) => {
        const selectedItem = items[0];
        if (!selectedItem?.content.trim()) return;
        const created = await projectDocuments.createDocument(project, {
          title: title,
          kind: "note",
          content: selectedItem.content.trim()
        });
        createdPath = created.path;
      }
    });
    if (selected.length === 0 || !createdPath) return;
    const file = this.app.vault.getAbstractFileByPath(createdPath);
    new Notice(`项目文档已写入：${project.name}`, 5000);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
  }

  private async getSelectedProjectForWriteback(): Promise<LifeOSProject | null> {
    if (!this.selectedProjectScopeId) return null;
    const fs = new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);
    const projects = await new ProjectService(this.app, fs).loadProjects();
    return projects.find((project) => project.id === this.selectedProjectScopeId) ?? null;
  }

  private projectDocumentWritebackContent(userContent: string, aiContent: string): string {
    const cleanedAi = this.stripAiGeneratedFooter(aiContent)
      .replace(/^最终写回预览[：:]\s*项目文档\s*$/gmu, "")
      .replace(/^建议标题[：:].*$/gmu, "")
      .replace(/^建议路径[：:].*$/gmu, "")
      .trim();
    return cleanedAi || userContent.trim() || "项目文档";
  }

  private projectDocumentWritebackTitle(userContent: string, aiContent: string): string {
    const cleanedAi = this.stripAiGeneratedFooter(aiContent);
    const explicitTitle = `${userContent}\n${cleanedAi}`.match(/(?:标题|文档名|建议标题)[：:]\s*([^\n]{2,80})/u)?.[1];
    const headingTitle = cleanedAi.match(/^#{1,3}\s+(.{2,80})$/mu)?.[1];
    const fallback = this.compactWritebackContent(userContent) || this.compactWritebackContent(cleanedAi) || "AI 助手写回";
    const title = (explicitTitle || headingTitle || fallback)
      .replace(/[\\/#?*[\]:|<>]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 48);
    return title || "AI 助手写回";
  }

  private shouldOfferWritebackTargetChoice(
    userContent: string,
    aiContent: string,
    candidates: RecognizedWritebackCandidates,
    requestedWriteTarget: RequestedWriteTarget
  ): boolean {
    if (!this.stripAiGeneratedFooter(aiContent).trim()) return false;
    if (requestedWriteTarget) return true;
    if (candidates.diary || candidates.knowledge || candidates.memory) return true;
    if (this.diaryToggleEl?.checked) return true;
    return this.hasGenericWritebackIntent(userContent);
  }

  private async previewRecognizedWritebackChoice(
    userContent: string,
    aiContent: string,
    candidates: RecognizedWritebackCandidates,
    requestedWriteTarget: RequestedWriteTarget,
    documents: ImportedDocument[] = []
  ): Promise<void> {
    const recommendedTarget = requestedWriteTarget ?? this.inferCandidateTarget(candidates) ?? "diary";
    const selectedProject = await this.getSelectedProjectForWriteback();
    if (recommendedTarget === "project-document" && !selectedProject) {
      new Notice("请先在 AI 助手上方选择一个具体项目，再写入项目文档。", 6000);
      return;
    }
    const selectedTarget = await openWritebackTargetChoice(this.app, {
      recommendedTarget,
      candidates,
      project: selectedProject
    });
    if (!selectedTarget) return;
    await this.runSelectedWritebackTarget(selectedTarget, userContent, aiContent, candidates, documents);
  }

  private async runSelectedWritebackTarget(
    target: WritebackTarget,
    userContent: string,
    aiContent: string,
    candidates: RecognizedWritebackCandidates,
    documents: ImportedDocument[] = []
  ): Promise<void> {
    if (target === "diary") {
      if (candidates.diary) {
        await this.previewDiaryCandidateWriteback(candidates.diary, documents);
      } else {
        await this.previewDiaryWriteback(
          this.appendInlineAttachmentReferences(userContent || "保存这段 AI 对话", documents),
          this.appendAttachmentReferences(aiContent, documents)
        );
      }
      return;
    }

    if (target === "knowledge") {
      if (candidates.knowledge) {
        await this.previewKnowledgeWriteback(candidates.knowledge, documents);
      } else {
        const content = this.appendAttachmentReferences(this.knowledgeSaveContentForLlmWiki(aiContent, candidates.knowledge), documents);
        await this.previewLlmWikiSave(content, { instruction: userContent || "保存到知识库" });
      }
      return;
    }

    if (target === "project-document") {
      await this.previewProjectDocumentWriteback(userContent, aiContent, documents);
      return;
    }

    const memory = candidates.memory ?? this.buildFallbackMemoryCandidate(userContent, aiContent);
    if (!memory) {
      new Notice("没有识别到适合加入记忆的内容。你可以先让 AI 提炼成一条长期记忆。", 6000);
      return;
    }
    await this.previewMemoryWriteback(memory, documents);
  }

  private inferCandidateTarget(candidates: RecognizedWritebackCandidates): WritebackTarget | null {
    if (candidates.knowledge && !candidates.diary && !candidates.memory) return "knowledge";
    if (candidates.memory && !candidates.diary && !candidates.knowledge) return "memory";
    if (candidates.diary && !candidates.knowledge && !candidates.memory) return "diary";
    if (candidates.knowledge) return "knowledge";
    if (candidates.memory) return "memory";
    if (candidates.diary) return "diary";
    return null;
  }

  private hasGenericWritebackIntent(content: string): boolean {
    return /保存|写入|记入|记到|存入|存到|放进|收进|归档|沉淀|记下来|帮我记/u.test(content);
  }

  private buildFallbackMemoryCandidate(userContent: string, aiContent: string): MemoryWritebackCandidate | null {
    const content = this.compactWritebackContent(aiContent) || this.compactWritebackContent(userContent);
    if (!content) return null;
    const language = normalizeDirectoryLanguage(this.plugin.settings.directoryLanguage);
    const targetPath = [
      this.plugin.getRoot(),
      ...localizeLifeOsPathParts(["Memory", "Inbox", "pending-memories.md"], language)
    ].filter(Boolean).join("/");
    return {
      title: `加入记忆候选：${content.slice(0, 36)}`,
      targetPath,
      content,
      category: "其他",
      importance: "normal"
    };
  }

  private compactWritebackContent(content: string): string {
    const cleaned = this.stripAiGeneratedFooter(content)
      .replace(/^最终写回预览[：:].*$/gmu, "")
      .replace(/^建议路径[：:].*$/gmu, "")
      .replace(/^分类[：:].*$/gmu, "")
      .replace(/^重要性[：:].*$/gmu, "")
      .trim();
    const firstMeaningful = cleaned
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*]\s*(?:\[[ xX]\]\s*)?/u, "").trim())
      .find((line) => line && !/^#{1,6}\s*$/.test(line));
    return (firstMeaningful || cleaned).replace(/^#{1,6}\s*/u, "").slice(0, 420).trim();
  }

  private detectRequestedWriteTarget(content: string): RequestedWriteTarget {
    const source = content.trim();
    if (!source) return null;
    if (/(?:^|[\n。！？!?])\s*(?:请|帮我|麻烦)?\s*记住\s*[：:，,]/u.test(source)) return "memory";
    const saveVerb = "(?:保存|写入|记入|记到|存入|存到|放进|收进|归档到|整理成|沉淀到|加入)";
    const projectDocumentNoun = "(?:项目文档|项目资料|项目专属文档|当前项目文档|当前项目资料|所选项目文档|所选项目资料)";
    const knowledgeNoun = "(?:LLM\\s*Wiki|知识库|知识笔记|资料库|资料|素材|文档|文章|PDF|Markdown|CSV|JSON)";
    const memoryNoun = "(?:长期记忆|记忆|记住)";
    const diaryNoun = "(?:今日日记|今日记录|今天记录|日记)";
    const directTargets: Array<{ target: Exclude<RequestedWriteTarget, null>; pattern: RegExp }> = [
      { target: "project-document", pattern: new RegExp(`${saveVerb}\\s*(?:到|至|进|入|为|成|在)?\\s*(?:一个|一条|这条|当前|对应的|我的)?\\s*${projectDocumentNoun}`, "u") },
      { target: "diary", pattern: new RegExp(`${saveVerb}\\s*(?:到|至|进|入|为|成|在)?\\s*(?:一个|一条|这条|当前|对应的|我的)?\\s*${diaryNoun}`, "u") },
      { target: "memory", pattern: new RegExp(`${saveVerb}\\s*(?:到|至|进|入|为|成|在)?\\s*(?:一个|一条|这条|当前|对应的|我的)?\\s*${memoryNoun}`, "u") },
      { target: "knowledge", pattern: new RegExp(`${saveVerb}\\s*(?:到|至|进|入|为|成|在)?\\s*(?:一个|一条|这条|当前|对应的|我的)?\\s*${knowledgeNoun}`, "iu") }
    ];
    const directTarget = this.bestExplicitWriteTarget(source, directTargets);
    if (directTarget) return directTarget;

    const reverseTargets: Array<{ target: Exclude<RequestedWriteTarget, null>; pattern: RegExp }> = [
      { target: "project-document", pattern: new RegExp(`${projectDocumentNoun}\\s*(?:里|中|内|这里)?\\s*(?:保存|写入|记入|记录|追加|补充|归档)`, "u") },
      { target: "diary", pattern: new RegExp(`${diaryNoun}\\s*(?:里|中|内|这里)?\\s*(?:保存|写入|记入|记录|追加|补充)`, "u") },
      { target: "memory", pattern: new RegExp(`${memoryNoun}\\s*(?:里|中|内|这里)?\\s*(?:保存|写入|记入|记录|追加|补充)`, "u") },
      { target: "knowledge", pattern: new RegExp(`${knowledgeNoun}\\s*(?:里|中|内|这里)?\\s*(?:保存|写入|记入|记录|追加|补充|归档)`, "iu") }
    ];
    return this.bestExplicitWriteTarget(source, reverseTargets);
  }

  private bestExplicitWriteTarget(
    source: string,
    specs: Array<{ target: Exclude<RequestedWriteTarget, null>; pattern: RegExp }>
  ): RequestedWriteTarget {
    let best: { target: Exclude<RequestedWriteTarget, null>; index: number } | null = null;
    const matchedTargets = new Set<Exclude<RequestedWriteTarget, null>>();
    for (const spec of specs) {
      const match = spec.pattern.exec(source);
      if (!match) continue;
      const index = match.index ?? 0;
      if (this.isNegatedWriteTargetMention(source, index)) continue;
      matchedTargets.add(spec.target);
      if (!best || index < best.index) best = { target: spec.target, index };
    }
    if (matchedTargets.has("project-document")) return "project-document";
    if (matchedTargets.size > 1) return null;
    return best?.target ?? null;
  }

  private isNegatedWriteTargetMention(source: string, index: number): boolean {
    const punctuation = ["，", ",", "。", ".", "；", ";", "！", "!", "？", "?"];
    const clauseStart = punctuation.reduce((start, mark) => Math.max(start, source.lastIndexOf(mark, index - 1) + 1), 0);
    const prefix = source.slice(clauseStart, index).trim();
    if (/(?:不要|别|不用|无需|不能)/u.test(prefix)) return true;
    const clausePreview = source.slice(clauseStart, Math.min(source.length, index + 80));
    return /(?:不要|别|不用|无需|不能)\s*(?:把|将)?[\s\S]{0,48}(?:保存|写入|记入|记到|存入|存到|放进|收进|归档|加入)/u.test(clausePreview);
  }

  private knowledgeSaveContentForLlmWiki(aiContent: string, candidate: KnowledgeWritebackCandidate | null): string {
    const candidateContent = candidate?.content.trim();
    if (candidateContent) return candidateContent;
    return this.stripAiGeneratedFooter(aiContent).trim();
  }

  private appendAttachmentReferences(content: string, documents: ImportedDocument[]): string {
    const references = documents.filter((document) => document.vaultPath || document.name);
    if (references.length === 0) return content;
    return `${content.trimEnd()}\n\n## 附件\n${references.map(formatImportedDocumentReference).join("\n")}`;
  }

  private appendInlineAttachmentReferences(content: string, documents: ImportedDocument[]): string {
    const references = documents
      .filter((document) => document.vaultPath || document.name)
      .map((document) => document.vaultPath ? document.vaultPath : document.name);
    if (references.length === 0) return content;
    return `${content.trim()}（附件：${references.join("；")}）`;
  }

  private parseDiaryWriteback(content: string): DiaryWritebackCandidate | null {
    const marker = content.search(/最终写回预览[：:]\s*(今日日记|日记)/u);
    if (marker < 0) return null;
    const source = this.stripAiGeneratedFooter(content.slice(marker));
    const fenced = source.match(/```(?:markdown|md)?\s*\n([\s\S]*?)```/i);
    const body = this.stripAiGeneratedFooter(fenced?.[1]?.trim() || this.extractDiaryWritebackBody(source));
    if (!body.trim()) return null;
    return {
      title: "写入今日日记",
      targetPath: this.plugin.getTodayNotePath(today()),
      content: body
    };
  }

  private parseMemoryWriteback(content: string): MemoryWritebackCandidate | null {
    return parseMemoryWritebackCandidate(this.stripAiGeneratedFooter(content), {
      rootFolder: this.plugin.getRoot(),
      directoryLanguage: this.plugin.settings.directoryLanguage
    });
  }

  private extractMemoryWritebackBody(content: string): string {
    return this.stripAiGeneratedFooter(content)
      .replace(/^最终写回预览[：:]\s*(记忆候选|长期记忆|记忆)\s*/u, "")
      .split(/\r?\n/)
      .filter((line) => !/^(分类|重要性|建议路径)[：:]/u.test(line.trim()))
      .join("\n")
      .trim();
  }

  private extractDiaryWritebackBody(content: string): string {
    const cleaned = this.stripAiGeneratedFooter(content)
      .replace(/^最终写回预览[：:]\s*(今日日记|日记)\s*/u, "")
      .trim();
    const headingIndex = cleaned.search(/^#{1,3}\s+/m);
    if (headingIndex >= 0) return cleaned.slice(headingIndex).trim();
    const lines = cleaned
      .split(/\r?\n/)
      .filter((line) => !/^建议路径[：:]/u.test(line.trim()))
      .join("\n")
      .trim();
    return lines;
  }

  private stripAiGeneratedFooter(content: string): string {
    return content.replace(AI_GENERATED_FOOTER_PATTERN, "").trimEnd();
  }

  private startNewConversation(): void {
    this.messages = [];
    this.importedDocuments = [];
    this.lastImportedDocuments = [];
    this.resetContextCompression();
    this.renderAttachmentList();
    this.renderMessages();
    this.inputEl.value = "";
    this.resizeComposer();
    this.inputEl.focus();
  }

  private clearCurrentConversation(): void {
    if (this.messages.length === 0) return;
    if (!window.confirm("清空当前会话？不会删除已保存历史。")) return;
    this.startNewConversation();
    new Notice("当前会话已清空。", 3000);
  }

  private async saveCurrentChatToLifeOS(): Promise<void> {
    if (!this.isLlmWikiEnabled()) {
      this.notifyLlmWikiDisabled();
      return;
    }
    const text = this.currentLlmWikiSaveText();
    if (!text) {
      new Notice("没有可保存的内容。");
      return;
    }
    await this.previewLlmWikiSave(text);
  }

  private async confirmLlmWikiPersonalSave(text: string): Promise<void> {
    if (!this.isLlmWikiEnabled()) {
      this.notifyLlmWikiDisabled();
      return;
    }
    await this.saveLlmWikiText(text, { personalConfirmed: true });
  }

  private async saveLlmWikiDuplicateAnyway(text: string, duplicateDecision: "save-anyway" | "save-as-version"): Promise<void> {
    if (!this.isLlmWikiEnabled()) {
      this.notifyLlmWikiDisabled();
      return;
    }
    await this.saveLlmWikiText(text, { duplicateDecision });
  }

  private async skipLlmWikiDuplicate(text: string): Promise<void> {
    if (!this.isLlmWikiEnabled()) {
      this.notifyLlmWikiDisabled();
      return;
    }
    await this.saveLlmWikiText(text, { duplicateDecision: "skip" });
  }

  private async saveLlmWikiText(text: string, overrides?: Partial<LlmWikiSaveInput>): Promise<void> {
    if (!requireProFeature(this.plugin, "aiWriteback")) return;
    if (!this.isLlmWikiEnabled()) {
      this.notifyLlmWikiDisabled();
      return;
    }
    try {
      const service = new LlmWikiIntakeService(this.app, this.plugin);
      const result = await service.save(this.buildLlmWikiSaveInput(text, overrides));
      this.renderLlmWikiSaveResult(result, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`保存到 Life OS 失败：${message}`);
    }
  }

  private isLlmWikiEnabled(): boolean {
    return this.plugin.settings.enableLlmWiki !== false;
  }

  private notifyLlmWikiDisabled(): void {
    new Notice("LLM Wiki 已在设置中关闭，未执行保存。");
  }

  private buildLlmWikiSaveInput(text: string, overrides?: Partial<LlmWikiSaveInput>): LlmWikiSaveInput {
    const originalUrl = text.match(/https?:\/\/[^\s\]\)"'<>]+/)?.[0];
    const sourceDocuments = this.importedDocuments.length > 0 ? this.importedDocuments : this.lastImportedDocuments;
    const sourceKind = sourceDocuments.length > 0
      ? "local_file"
      : (originalUrl || /^https?:\/\//.test(text) ? "url" : "pasted_text");
    const sourcePath = sourceDocuments.length > 0
      ? sourceDocuments.map((document) => document.name).join(", ")
      : undefined;
    return {
      title: this.inferLlmWikiTitle(text),
      content: text,
      instruction: "保存到 Life OS",
      sourceKind,
      originalUrl,
      sourcePath,
      ...overrides
    };
  }

  private inferLlmWikiTitle(text: string): string {
    const firstLine = text
      .split("\n")
      .find((line) => line.trim())
      ?.trim()
      .replace(/^#+\s*/, "")
      .trim();
    return (firstLine || "未命名资料").slice(0, 60);
  }

  private renderLlmWikiSaveResult(result: LlmWikiSaveResult, text = ""): void {
    if (!this.logEl || typeof this.logEl.createDiv !== "function") {
      new Notice(result.message, 6000);
      return;
    }

    const awaitingPersonalConfirmation = result.requiresPersonalConfirmation && !result.savedSource;
    const awaitingDuplicateDecision = result.requiresDuplicateDecision && !result.savedSource;
    const title = awaitingPersonalConfirmation
      ? "需要确认后保存"
      : awaitingDuplicateDecision
        ? "发现相似资料"
        : "已保存到 Life OS";
    const card = this.logEl.createDiv({ cls: "lifeos-llmwiki-card" });
    card.createDiv({ cls: "lifeos-llmwiki-card-title", text: title });
    const body = card.createDiv({ cls: "lifeos-llmwiki-card-body" });
    body.createEl("p", { text: result.message });
    if (awaitingPersonalConfirmation) {
      body.createEl("p", { text: "确认后会继续使用同一份内容保存，不需要重新复制。" });
    }
    if (awaitingDuplicateDecision) {
      body.createEl("p", { text: "你可以继续保存当前资料，或作为相似资料的新版本保留。" });
    }

    const references = card.createDiv({ cls: "lifeos-llmwiki-card-references" });
    if (result.savedSource?.path) {
      references.createDiv({ cls: "lifeos-llmwiki-reference", text: `资料：${result.savedSource.path}` });
    }
    if (result.draftPath) {
      references.createDiv({ cls: "lifeos-llmwiki-reference", text: `草稿：${result.draftPath}` });
    }
    if (result.duplicate?.existingPath) {
      references.createDiv({ cls: "lifeos-llmwiki-reference", text: `已有：${result.duplicate.existingPath}` });
    }

    const actions = card.createDiv({ cls: "lifeos-llmwiki-card-actions" });
    if (result.savedSource?.file) {
      createButton(actions, "查看资料", () => void this.app.workspace.getLeaf(false).openFile(result.savedSource!.file), { ghost: true, icon: "file-text" });
    }
    if (result.draftPath) {
      createButton(actions, "查看草稿", () => {
        const draftFile = this.app.vault.getAbstractFileByPath(result.draftPath!);
        if (draftFile instanceof TFile) {
          void this.app.workspace.getLeaf(false).openFile(draftFile);
        } else {
          new Notice("暂时找不到草稿文件。", 4000);
        }
      }, { ghost: true, icon: "file-pen" });
    }
    if (awaitingPersonalConfirmation) {
      createButton(actions, "确认保存", () => { this.disableLlmWikiCardActions(actions); void this.confirmLlmWikiPersonalSave(text); }, { primary: true, icon: "check" });
    }
    if (awaitingDuplicateDecision) {
      createButton(actions, "仍然保存", () => { this.disableLlmWikiCardActions(actions); void this.saveLlmWikiDuplicateAnyway(text, "save-anyway"); }, { primary: true, icon: "save" });
      createButton(actions, "作为新版保存", () => { this.disableLlmWikiCardActions(actions); void this.saveLlmWikiDuplicateAnyway(text, "save-as-version"); }, { ghost: true, icon: "copy-plus" });
      createButton(actions, "查看已有", () => {
        const existing = this.app.vault.getAbstractFileByPath(result.duplicate!.existingPath);
        if (existing instanceof TFile) void this.app.workspace.getLeaf(false).openFile(existing);
        else new Notice("暂时找不到已有资料。");
      }, { ghost: true, icon: "external-link" });
      createButton(actions, "跳过", () => { this.disableLlmWikiCardActions(actions); void this.skipLlmWikiDuplicate(text); }, { ghost: true, icon: "ban" });
    }
    if (result.undoTargets.length > 0) {
      createButton(actions, "撤销", () => {
        this.disableLlmWikiCardActions(actions);
        void this.undoLlmWikiSave(result).then((succeeded) => {
          if (!succeeded) this.enableLlmWikiCardActions(actions);
        });
      }, { ghost: true, icon: "undo-2" });
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private async undoLlmWikiSave(result: LlmWikiSaveResult): Promise<boolean> {
    if (!this.isLlmWikiEnabled()) {
      this.notifyLlmWikiDisabled();
      return false;
    }
    if (!result.undoTargets || result.undoTargets.length === 0) {
      new Notice("这次保存没有可撤销文件。");
      return false;
    }
    try {
      const service = new LlmWikiUndoService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);
      const moved = await service.undoFiles(result.undoTargets);
      if (moved.length === 0) {
        new Notice("没有移动任何文件，可能已经撤销或目标不在可撤销范围。");
        return false;
      }
      new Notice(`已移动 ${moved.length} 个文件到 LLM Wiki Trash。`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`撤销失败：${message}`);
      return false;
    }
  }

  private disableLlmWikiCardActions(actions: HTMLElement): void {
    actions.closest(".lifeos-llmwiki-card")?.addClass("lifeos-llmwiki-card-pending");
    actions.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
  }

  private enableLlmWikiCardActions(actions: HTMLElement): void {
    actions.closest(".lifeos-llmwiki-card")?.removeClass("lifeos-llmwiki-card-pending");
    actions.querySelectorAll("button").forEach((button) => {
      button.disabled = false;
    });
  }

  private currentLlmWikiSaveText(): string {
    const input = this.inputEl?.value?.trim();
    const activeImportMarkdown = buildImportedDocumentsMarkdown(this.importedDocuments);
    if (input && activeImportMarkdown) return `${input}\n\n${activeImportMarkdown}`;
    if (input) return input;
    if (activeImportMarkdown) return activeImportMarkdown;
    const lastImportMarkdown = buildImportedDocumentsMarkdown(this.lastImportedDocuments);
    if (lastImportMarkdown) return lastImportMarkdown;
    return this.messages[this.messages.length - 1]?.content.trim() || "";
  }

  private async fetchUrlText(url: string): Promise<string> {
    if (!requireProFeature(this.plugin, "aiContextEngine")) return "此网页上下文能力需要 Pro 授权。";
    return fetchReadableUrl(url, (targetUrl, options) => this.requestWebContext(targetUrl, options), 8000);
  }

  private async searchWebText(query: string): Promise<string> {
    if (!requireProFeature(this.plugin, "aiContextEngine")) return "此联网搜索能力需要 Pro 授权。";
    return searchWebAsMarkdown(query, (targetUrl, options) => this.requestWebContext(targetUrl, options), {
      maxResults: 5,
      fetchTopPages: 2,
      maxPageChars: 5000
    });
  }

  private async requestWebContext(url: string, options: WebContextRequestOptions = {}): Promise<{ text: string; status?: number }> {
    const response = await requestUrl({
      url,
      method: options.method ?? "GET",
      headers: options.headers
    });
    return { text: response.text, status: response.status };
  }

  private service(): ChatService {
    return new ChatService(this.app, new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage), this.plugin.settings.assistantName || "Life OS", this.plugin.settings);
  }

  private contextService(): ChatContextService {
    return new ChatContextService(this.app, this.plugin.settings, this.plugin.ai);
  }

  private resizeComposer(): void {
    if (!this.inputEl) return;
    this.setComposerInputHeight(Math.max(this.inputEl.scrollHeight, this.manualComposerHeight ?? 0));
  }

  private bindComposerResizeHandle(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (event) => {
      if (!this.inputEl) return;
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = this.inputEl.getBoundingClientRect().height || this.composerHeightBounds().min;
      document.body.classList.add("lifeos-chat-composer-is-resizing");

      const onPointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        this.manualComposerHeight = this.setComposerInputHeight(startHeight + startY - moveEvent.clientY);
        this.keepComposerVisible();
      };
      const stopDragging = () => {
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", stopDragging);
        document.removeEventListener("pointercancel", stopDragging);
        document.body.classList.remove("lifeos-chat-composer-is-resizing");
        this.composerResizeDragCleanup = null;
        this.inputEl?.focus();
        this.keepComposerVisible(true);
      };

      this.composerResizeDragCleanup?.();
      this.composerResizeDragCleanup = stopDragging;
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", stopDragging);
      document.addEventListener("pointercancel", stopDragging);
    });
    handle.addEventListener("dblclick", () => {
      this.manualComposerHeight = null;
      this.resizeComposer();
    });
  }

  private setComposerInputHeight(height: number): number {
    if (!this.inputEl) return 0;
    const { min, max } = this.composerHeightBounds();
    const next = Math.round(Math.min(max, Math.max(min, height)));
    this.inputEl.style.setProperty("--lifeos-chat-composer-height", `${next}px`);
    this.inputEl.style.height = `${next}px`;
    return next;
  }

  private composerHeightBounds(): { min: number; max: number } {
    const viewportHeight = Math.max(420, window.visualViewport?.height ?? window.innerHeight ?? 760);
    return {
      min: 64,
      max: Math.round(Math.min(420, Math.max(180, viewportHeight * 0.42)))
    };
  }

  private async previewLlmWikiSave(text: string, overrides?: Partial<LlmWikiSaveInput>): Promise<void> {
    if (!requireProFeature(this.plugin, "aiWriteback")) return;
    if (!this.isLlmWikiEnabled()) {
      this.notifyLlmWikiDisabled();
      return;
    }
    const item: WritebackItem = {
      id: `chat-llmwiki-${Date.now()}`,
      kind: "replace",
      title: "保存到 Life OS 知识库",
      content: text,
      targetPath: new LlmWikiPathService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage)
        .path("Raw", "Inbox", "自动生成文件名.md"),
      checked: true
    };
    const selected = await openWritebackPreview(this.app, {
      title: "保存到 Life OS 前确认",
      description: "确认后会进入 LLM Wiki 的去重、敏感内容和整理流程。",
      confirmText: "确认保存到 Life OS",
      items: [item],
      onConfirm: async (items) => {
        const content = items[0]?.content.trim();
        if (content) await this.saveLlmWikiText(content, overrides);
      }
    });
    if (selected.length === 0) new Notice("已取消保存到 Life OS。", 3000);
  }

  private keepComposerVisible(force = false): void {
    if (!this.inputEl || (!force && document.activeElement !== this.inputEl)) return;
    window.setTimeout(() => {
      if (!this.inputEl || (!force && document.activeElement !== this.inputEl)) return;
      this.inputEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
      this.scrollLogToBottom();
    }, 60);
  }

  private detachMobileViewportListener(): void {
    if (!this.visualViewportHandler) return;
    window.visualViewport?.removeEventListener("resize", this.visualViewportHandler);
    this.visualViewportHandler = null;
  }

  private detachComposerResizeDrag(): void {
    this.composerResizeDragCleanup?.();
    this.composerResizeDragCleanup = null;
    document.body.classList.remove("lifeos-chat-composer-is-resizing");
  }

  private saveOptions(status: ChatRunStatus, contextSources?: string[]) {
    return { mode: this.mode, style: this.style, length: this.length, status, contextSources };
  }

  private normalizeStyle(style: AssistantStyle): UiChatStyle {
    if (style === "concise-executor") return "concise-executor";
    if (style === "strict-coach" || style === "exam-tutor") return "strict-coach";
    return "warm-companion";
  }

  private normalizeContextMode(mode: ChatContextMode): UiChatContextMode {
    if (mode === "semantic" || mode === "global") return mode;
    return "smart";
  }

  private normalizeReasoningEffort(value: AiReasoningEffort | undefined): UiChatReasoningEffort {
    if (value === "low" || value === "medium" || value === "high" || value === "max") return value;
    return "default";
  }

  private formatHistoryTime(title: string): string {
    const match = title.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/);
    if (!match) return title;
    const [, year, month, day, hour, minute] = match;
    const date = `${year}-${month}-${day}`;
    const now = today();
    if (date === now) return `今天 ${hour}:${minute}`;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const y = yesterday.toISOString().slice(0, 10);
    if (date === y) return `昨天 ${hour}:${minute}`;
    return `${Number(month)}月${Number(day)}日 ${hour}:${minute}`;
  }

  private historyTitle(item: ChatHistoryItem): string {
    const first = item.messages.find((message) => message.role === "user")?.content.trim();
    if (!first) return "新对话";
    const normalized = first.replace(/\s+/g, " ");
    return normalized.length > 28 ? `${normalized.slice(0, 28)}...` : normalized;
  }

  private toggle(
    parent: HTMLElement,
    label: string,
    checked: boolean,
    hint?: string,
    stateCopy: { on: string; off: string } = { on: "已开启", off: "已关闭" }
  ): HTMLInputElement {
    const card = parent.createEl("label", { cls: "lifeos-toggle-card lifeos-chat-toggle-card" });
    const input = card.createEl("input", { attr: { type: "checkbox" } });
    input.checked = checked;
    const copy = card.createDiv({ cls: "lifeos-toggle-copy" });
    const title = copy.createDiv({ cls: "lifeos-toggle-title-row" });
    title.createEl("strong", { cls: "lifeos-toggle-label", text: label });
    const state = title.createSpan({ cls: "lifeos-toggle-state" });
    if (hint) copy.createEl("span", { cls: "lifeos-toggle-hint", text: hint });
    const refreshState = () => {
      card.classList.toggle("is-on", input.checked);
      state.setText(input.checked ? stateCopy.on : stateCopy.off);
    };
    input.addEventListener("change", refreshState);
    refreshState();
    return input;
  }
}

interface WritebackTargetChoiceOptions {
  recommendedTarget: WritebackTarget;
  candidates: RecognizedWritebackCandidates;
  project: Pick<LifeOSProject, "id" | "name"> | null;
}

function openWritebackTargetChoice(app: App, options: WritebackTargetChoiceOptions): Promise<WritebackTarget | null> {
  return new Promise((resolve) => {
    new WritebackTargetChoiceModal(app, options, resolve).open();
  });
}

class WritebackTargetChoiceModal extends Modal {
  private hasResolved = false;

  constructor(
    app: App,
    private options: WritebackTargetChoiceOptions,
    private resolveChoice: (target: WritebackTarget | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-writeback-target-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: "选择记入位置",
      subtitle: "AI 已识别到可保存内容。先选日记、知识库、项目文档或记忆，下一步仍会进入确认预览。",
      icon: "file-check-2",
      className: "lifeos-writeback-target-modal"
    });

    const grid = body.createDiv({ cls: "lifeos-writeback-target-grid" });
    this.renderTarget(grid, {
      target: "diary",
      title: "记入日记",
      subtitle: "适合今天发生的事、想法、对话和行动过程。",
      meta: this.options.candidates.diary?.targetPath ?? "追加到今天日记",
      icon: "日"
    });
    this.renderTarget(grid, {
      target: "knowledge",
      title: "记入知识库",
      subtitle: "适合资料、文章、方法、项目参考和可复用知识。",
      meta: this.options.candidates.knowledge?.targetPath ?? "保存到知识库 / LLM Wiki",
      icon: "知"
    });
    this.renderTarget(grid, {
      target: "project-document",
      title: "写入项目文档",
      subtitle: "适合当前项目的专属资料、会议纪要、需求、复盘和参考文档。",
      meta: this.options.project ? `保存到项目：${this.options.project.name}` : "请先在 AI 助手上方选择项目",
      icon: "项",
      disabled: !this.options.project
    });
    this.renderTarget(grid, {
      target: "memory",
      title: "加入记忆",
      subtitle: "适合长期偏好、重要事实和反复出现的模式。",
      meta: this.options.candidates.memory?.targetPath ?? "写入记忆收件箱",
      icon: "忆"
    });

    createButton(footer, "取消", () => this.finish(null), { ghost: true });
  }

  onClose(): void {
    if (!this.hasResolved) this.finish(null);
  }

  private renderTarget(
    parent: HTMLElement,
    option: {
      target: WritebackTarget;
      title: string;
      subtitle: string;
      meta: string;
      icon: string;
      disabled?: boolean;
    }
  ): void {
    const button = parent.createEl("button", {
      cls: `lifeos-writeback-target-card ${option.target === this.options.recommendedTarget ? "is-recommended" : ""}`,
      attr: { type: "button" }
    });
    button.disabled = Boolean(option.disabled);
    if (option.disabled) button.addClass("is-disabled");
    button.onclick = () => this.finish(option.target);
    button.createDiv({ cls: "lifeos-writeback-target-icon", text: option.icon });
    const copy = button.createDiv({ cls: "lifeos-writeback-target-copy" });
    const head = copy.createDiv({ cls: "lifeos-writeback-target-head" });
    head.createEl("strong", { text: option.title });
    if (option.target === this.options.recommendedTarget) {
      head.createSpan({ cls: "lifeos-badge", text: "AI 推荐" });
    }
    copy.createEl("p", { text: option.subtitle });
    copy.createEl("span", { cls: "lifeos-muted", text: option.meta });
  }

  private finish(target: WritebackTarget | null): void {
    if (!this.hasResolved) {
      this.resolveChoice(target);
      this.hasResolved = true;
    }
    this.close();
  }
}

class GitHubSkillInstallModal extends Modal {
  private urlInputEl!: HTMLInputElement;
  private statusEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private installButtonEl!: HTMLButtonElement;
  private pendingRecord: ImportedAiSkillRecord | null = null;

  constructor(
    app: App,
    private plugin: PersonalLifeSystemPlugin,
    private onInstall: (record: ImportedAiSkillRecord) => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("lifeos-github-skill-modal");
    this.contentEl.createEl("h2", { text: "安装 GitHub Skill" });
    this.contentEl.createEl("p", {
      cls: "lifeos-github-skill-help",
      text: "粘贴 GitHub 上的 SKILL.md 或 Markdown 文件链接。Life OS 只下载 Markdown，不安装代码。"
    });

    const form = this.contentEl.createDiv({ cls: "lifeos-github-skill-form" });
    this.urlInputEl = form.createEl("input", {
      cls: "lifeos-input",
      attr: {
        type: "url",
        placeholder: "https://github.com/owner/repo/blob/main/SKILL.md"
      }
    });
    createButton(form, "获取预览", () => void this.previewSkill(), { ghost: true, icon: "search" });

    this.statusEl = this.contentEl.createDiv({ cls: "lifeos-github-skill-status" });
    this.previewEl = this.contentEl.createDiv({ cls: "lifeos-github-skill-preview" });

    const actions = this.contentEl.createDiv({ cls: "lifeos-modal-actions" });
    createButton(actions, "取消", () => this.close(), { ghost: true });
    this.installButtonEl = createButton(actions, "安装并选中", () => void this.installSkill(), { icon: "download" });
    this.installButtonEl.disabled = true;
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async previewSkill(): Promise<void> {
    this.pendingRecord = null;
    this.installButtonEl.disabled = true;
    this.previewEl.empty();
    this.statusEl.setText("正在读取 GitHub Skill...");

    try {
      const normalized = normalizeGitHubSkillUrl(this.urlInputEl.value);
      const response = await requestUrl({ url: normalized.rawUrl, method: "GET" });
      const markdown = response.text.slice(0, 40000);
      const record = buildImportedAiSkillRecord({
        markdown,
        sourceUrl: normalized.sourceUrl,
        installedAt: new Date().toISOString()
      });
      this.pendingRecord = record;
      this.statusEl.setText(`预览已读取：${normalized.fileName}`);
      this.renderPreview(record);
      this.installButtonEl.disabled = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.statusEl.setText(`读取失败：${message}`);
      new Notice(`GitHub Skill 读取失败：${message}`);
    }
  }

  private renderPreview(record: ImportedAiSkillRecord): void {
    this.previewEl.empty();
    const card = this.previewEl.createDiv({ cls: "lifeos-github-skill-preview-card" });
    card.createEl("h3", { text: record.name });
    card.createEl("p", { text: record.description });
    card.createDiv({ cls: "lifeos-github-skill-source", text: record.sourceUrl });
    card.createEl("pre", { text: record.markdown.slice(0, 1200) });
  }

  private async installSkill(): Promise<void> {
    if (!this.pendingRecord) return;
    const record = this.pendingRecord;
    this.installButtonEl.disabled = true;
    this.statusEl.setText("正在安装 Skill...");
    try {
      await this.onInstall(record);
      this.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.statusEl.setText(`安装失败：${message}`);
      this.installButtonEl.disabled = false;
      new Notice(`GitHub Skill 安装失败：${message}`);
    }
  }
}


