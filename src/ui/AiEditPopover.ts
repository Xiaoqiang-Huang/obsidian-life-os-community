import { App, Editor, Notice, TFile, normalizePath, setIcon, type EditorPosition } from "obsidian";
import { requireProFeature } from "../licensing/entitlement";
import type PersonalLifeSystemPlugin from "../main";
import {
  composeAiSkillPrompt,
  createImportedAiSkills,
  getAiSkillCategories,
  getAiSkills,
  getAiSkillsByCategory,
  normalizeAiSkillIds,
  type AiSkill
} from "../services/AiSkillService";
import { renderMarkdownDisplay } from "../utils/markdown-render";
import { stripCodeFences } from "../utils";

export type AiEditTarget =
  | {
      kind: "selection";
      file: TFile;
      editor: Editor;
      from: EditorPosition;
      to: EditorPosition;
      text: string;
    }
  | {
      kind: "readonly-selection";
      file: TFile;
      text: string;
    }
  | {
      kind: "markdown-file";
      file: TFile;
      text: string;
    }
  | {
      kind: "canvas";
      file: TFile;
      text: string;
      nodeHint?: string;
    };

export interface AiEditAnchor {
  x: number;
  y: number;
  avoidRect?: AiEditAvoidRect;
  selectionRects?: AiEditAvoidRect[];
  softAvoidRects?: AiEditAvoidRect[];
  placement?: "text-selection" | "canvas";
}

export interface AiEditAvoidRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface CanvasDocumentLike {
  nodes: unknown[];
  edges: unknown[];
}

type AiEditResultKind = "edit" | "answer";
type AiAnswerDepth = "concise" | "balanced" | "detailed";
type AiAnswerContextMode = "fast" | "deep";

interface AiEditSelectionHistoryItem {
  id: string;
  target: AiEditTarget;
  anchor: AiEditAnchor;
  previewText: string;
  answerHistory: Array<{ role: "user" | "assistant"; content: string }>;
  createdAt: number;
}

const AI_ANSWER_DEPTHS: Array<{ id: AiAnswerDepth; label: string; instruction: string }> = [
  { id: "concise", label: "简洁", instruction: "用 3-5 个要点直接回答，只保留最关键结论。" },
  { id: "balanced", label: "适中", instruction: "先给结论，再给必要解释和步骤，控制在中等长度。" },
  { id: "detailed", label: "详细", instruction: "系统展开背景、推理过程、关键细节和可执行建议。" }
];

const INLINE_AI_PREVIEW_EDIT_TIMEOUT_MS = 180_000;
const INLINE_AI_PREVIEW_ANSWER_TIMEOUT_MS = 180_000;
const INLINE_AI_PREVIEW_CANVAS_TIMEOUT_MS = 120_000;
const INLINE_AI_PREVIEW_HEARTBEAT_MS = 1_000;
const INLINE_AI_PREVIEW_SLOW_MS = 8_000;

export class AiEditPopoverController {
  private popoverEl: HTMLElement | null = null;
  private target: AiEditTarget | null = null;
  private anchor: AiEditAnchor = { x: 0, y: 0 };
  private previewText = "";
  private previewEl: HTMLElement | null = null;
  private cancelButton: HTMLButtonElement | null = null;
  private applyButton: HTMLButtonElement | null = null;
  private generateButton: HTMLButtonElement | null = null;
  private askButton: HTMLButtonElement | null = null;
  private dockButton: HTMLButtonElement | null = null;
  private commandInput: HTMLTextAreaElement | null = null;
  private skillPickerEl: HTMLElement | null = null;
  private answerToolbarEl: HTMLElement | null = null;
  private selectedSkillIds: string[] = ["lifeos-general"];
  private importedAiSkills: AiSkill[] = [];
  private activeTab: "answer" | "edit" = "answer";
  private resultKind: AiEditResultKind = "edit";
  private answerDepth: AiAnswerDepth = "balanced";
  private answerContextMode: AiAnswerContextMode = "fast";
  private answerHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
  private currentAnswerQuestion = "";
  private editInstructions: string[] = [];
  private editPreviewSnapshots: string[] = [];
  private selectionHistory: AiEditSelectionHistoryItem[] = [];
  private pendingTarget: { target: AiEditTarget; anchor: AiEditAnchor } | null = null;
  private pendingSelectionEl: HTMLElement | null = null;
  private panelContainerEl: HTMLElement | null = null;
  private stickyPanel = false;
  private activeGenerationKind: AiEditResultKind | null = null;
  private selectionHighlightEls: HTMLElement[] = [];
  private outsidePointerHandler: ((event: MouseEvent) => void) | null = null;
  private keyHandler: ((event: KeyboardEvent) => void) | null = null;
  private viewportHandler: (() => void) | null = null;
  private abortController: AbortController | null = null;
  private heartbeatTimer: number | null = null;
  private timeoutTimer: number | null = null;
  private generationId = 0;
  private streamPreviewText = "";
  private streamRenderTimer: number | null = null;
  private streamStartedAt = 0;
  private generating = false;
  private selectionPromptPending = false;

  constructor(
    private app: App,
    private plugin: PersonalLifeSystemPlugin
  ) {}

  openOrQueue(target: AiEditTarget, anchor: AiEditAnchor): boolean {
    if (this.generating) {
      this.queuePendingTarget(target, anchor);
      return false;
    }
    this.open(target, anchor);
    return true;
  }

  open(target: AiEditTarget, anchor: AiEditAnchor): void {
    const shouldOpenInPanel = this.shouldFollowSelectionInPanel();
    this.rememberCurrentSelection();
    this.close({ preservePanelPreference: true });
    this.target = target;
    this.anchor = anchor;
    this.previewText = "";
    this.streamPreviewText = "";
    this.activeTab = "answer";
    this.resultKind = "edit";
    this.answerDepth = "balanced";
    this.answerContextMode = "fast";
    this.answerHistory = [];
    this.currentAnswerQuestion = "";
    this.editInstructions = [];
    this.editPreviewSnapshots = [];
    this.activeGenerationKind = null;
    this.selectionPromptPending = target.kind === "selection" || target.kind === "readonly-selection";
    this.clearStreamRenderTimer();
    this.importedAiSkills = createImportedAiSkills(this.plugin.settings.importedAiSkills);
    this.selectedSkillIds = normalizeAiSkillIds(
      this.plugin.settings.inlineAiSkillIds,
      undefined,
      this.importedAiSkills,
      this.plugin.settings.aiSkillOverrides
    );

    const popoverParent = shouldOpenInPanel ? this.panelContainerEl! : document.body;
    if (shouldOpenInPanel) {
      popoverParent.empty();
    }
    this.renderCurrentPopover(popoverParent);
    const popover = this.popoverEl;
    if (popover) popover.toggleClass("is-panel", Boolean(shouldOpenInPanel));

    this.renderSelectionHighlight();
    this.placePopover();
    this.registerDismissHandlers();
    if (target.kind !== "selection" && target.kind !== "readonly-selection") {
      window.setTimeout(() => this.commandInput?.focus(), 30);
    }
  }

  close(options: { preservePanelPreference?: boolean } = {}): void {
    this.stopPreviewRequest();
    this.unregisterDismissHandlers();
    this.clearSelectionHighlight();
    this.popoverEl?.remove();
    this.popoverEl = null;
    this.target = null;
    this.previewEl = null;
    this.cancelButton = null;
    this.applyButton = null;
    this.generateButton = null;
    this.askButton = null;
    this.dockButton = null;
    this.commandInput = null;
    this.skillPickerEl = null;
    this.answerToolbarEl = null;
    this.pendingSelectionEl = null;
    this.selectedSkillIds = ["lifeos-general"];
    this.importedAiSkills = [];
    this.previewText = "";
    this.activeTab = "answer";
    this.resultKind = "edit";
    this.answerDepth = "balanced";
    this.answerContextMode = "fast";
    this.answerHistory = [];
    this.currentAnswerQuestion = "";
    this.editInstructions = [];
    this.editPreviewSnapshots = [];
    this.pendingTarget = null;
    this.selectionPromptPending = false;
    if (!options.preservePanelPreference) {
      this.stickyPanel = false;
      this.panelContainerEl = null;
    }
    this.activeGenerationKind = null;
    this.generating = false;
    this.viewportHandler = null;
  }

  private setActiveTab(tab: "answer" | "edit"): void {
    if (this.activeTab === tab || this.generating || !this.target || !this.popoverEl) return;
    this.selectionPromptPending = false;
    this.activeTab = tab;
    const container = this.popoverEl.parentElement ?? (this.isMountedInPanel() ? this.panelContainerEl : document.body) ?? document.body;
    this.popoverEl.remove();
    this.renderCurrentPopover(container);
    if (this.previewText) {
      if (this.activeTab === "answer" || this.resultKind === "answer") {
        this.renderMarkdownPreview(this.previewText, false, true);
      } else {
        this.renderPreview(this.target, this.previewText);
        this.applyButton?.removeAttribute("disabled");
      }
    }
    this.placePopover();
  }

  private undoEditToRound(round: number): void {
    this.editInstructions = this.editInstructions.slice(0, round);
    this.editPreviewSnapshots = this.editPreviewSnapshots.slice(0, round);
    this.previewText = round > 0 ? this.editPreviewSnapshots[round - 1] : "";
    this.resultKind = this.previewText ? "edit" : this.resultKind;
    if (this.target && this.popoverEl) {
      const container = this.popoverEl.parentElement ?? (this.isMountedInPanel() ? this.panelContainerEl : document.body) ?? document.body;
      this.popoverEl.remove();
      this.renderCurrentPopover(container);
      if (this.previewText) {
        this.renderPreview(this.target, this.previewText);
        this.applyButton?.removeAttribute("disabled");
      }
      this.placePopover();
    }
  }

  private queuePendingTarget(target: AiEditTarget, anchor: AiEditAnchor): void {
    this.pendingTarget = { target, anchor };
    this.renderPendingSelectionNotice();
  }

  private renderPendingSelectionNotice(): void {
    this.pendingSelectionEl?.remove();
    this.pendingSelectionEl = null;
    if (!this.pendingTarget || !this.popoverEl) return;
    const body = this.popoverEl.querySelector<HTMLElement>(".lifeos-ai-edit-popover-body");
    if (!body) return;

    const notice = document.createElement("div");
    notice.className = "lifeos-ai-edit-pending-selection";
    const copy = document.createElement("span");
    copy.setText(this.generating
      ? "当前生成会继续，新选区已准备好。"
      : "已记录新选区。选择下一步，不会覆盖当前回答。");
    notice.appendChild(copy);
    if (!this.generating) {
      const useNext = document.createElement("button");
      useNext.type = "button";
      useNext.setText("处理新选区");
      useNext.onclick = () => this.openPendingTarget();
      notice.appendChild(useNext);
      const keepCurrent = document.createElement("button");
      keepCurrent.type = "button";
      keepCurrent.setText("保留当前回答");
      keepCurrent.onclick = () => {
        this.pendingTarget = null;
        this.renderPendingSelectionNotice();
      };
      notice.appendChild(keepCurrent);
    }
    body.insertBefore(notice, body.firstChild);
    this.pendingSelectionEl = notice;
  }

  private openPendingTarget(): void {
    const pending = this.pendingTarget;
    if (!pending || this.generating) return;
    this.pendingTarget = null;
    this.open(pending.target, pending.anchor);
  }

  private rememberCurrentSelection(): void {
    if (!this.target || !this.previewText || this.resultKind !== "answer") return;
    const existing = this.selectionHistory.findIndex((item) => (
      item.target.file.path === this.target?.file.path
      && item.target.text === this.target?.text
      && item.previewText === this.previewText
    ));
    if (existing >= 0) this.selectionHistory.splice(existing, 1);
    this.selectionHistory.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      target: this.target,
      anchor: this.anchor,
      previewText: this.previewText,
      answerHistory: this.answerHistory.map((message) => ({ ...message })),
      createdAt: Date.now()
    });
    this.selectionHistory = this.selectionHistory.slice(0, 5);
  }

  private renderSelectionHistory(parent: HTMLElement): void {
    if (!this.shouldFollowSelectionInPanel() || this.selectionHistory.length === 0) return;
    const history = parent.createEl("details", { cls: "lifeos-ai-edit-selection-history" });
    const summary = history.createEl("summary", { text: `最近选区（${this.selectionHistory.length}）` });
    summary.setAttr("aria-label", "最近选区");
    const list = history.createDiv({ cls: "lifeos-ai-edit-selection-history-list" });
    for (const item of this.selectionHistory) {
      const row = list.createEl("button", {
        cls: "lifeos-ai-edit-selection-history-item",
        attr: { type: "button", title: item.target.file.path }
      });
      row.createSpan({ cls: "lifeos-ai-edit-selection-history-file", text: item.target.file.basename || item.target.file.name });
      row.createSpan({ cls: "lifeos-ai-edit-selection-history-text", text: compactText(item.target.text, 54) });
      row.onclick = () => this.restoreSelectionHistory(item.id);
    }
  }

  private restoreSelectionHistory(id: string): void {
    if (this.generating) return;
    const item = this.selectionHistory.find((candidate) => candidate.id === id);
    if (!item) return;
    const shouldOpenInPanel = this.shouldFollowSelectionInPanel();
    this.close({ preservePanelPreference: true });
    this.target = item.target;
    this.anchor = item.anchor;
    this.previewText = item.previewText;
    this.resultKind = "answer";
    this.activeTab = "answer";
    this.answerHistory = item.answerHistory.map((message) => ({ ...message }));
    const parent = shouldOpenInPanel ? this.panelContainerEl! : document.body;
    if (shouldOpenInPanel) parent.empty();
    this.renderCurrentPopover(parent);
    this.popoverEl?.toggleClass("is-panel", shouldOpenInPanel);
    this.renderMarkdownPreview(this.previewText, false, true);
    this.placePopover();
    this.registerDismissHandlers();
  }

  private renderCurrentPopover(popoverParent: HTMLElement): void {
    if (!this.target) return;
    const target = this.target;
    const shouldOpenInPanel = this.shouldFollowSelectionInPanel();
    this.previewEl = null;
    this.commandInput = null;
    this.skillPickerEl = null;
    this.answerToolbarEl = null;
    this.cancelButton = null;
    this.askButton = null;
    this.generateButton = null;
    this.applyButton = null;
    this.dockButton = null;
    if (
      this.selectionPromptPending
      && (target.kind === "selection" || target.kind === "readonly-selection")
    ) {
      this.renderSelectionPrompt(popoverParent, target, shouldOpenInPanel);
      return;
    }
    const popover = popoverParent.createDiv({ cls: "lifeos-ai-edit-popover" });
    popover.toggleClass("is-panel", Boolean(shouldOpenInPanel));
    popover.setAttr("role", "dialog");
    popover.setAttr("aria-label", "AI 修改");
    this.popoverEl = popover;

    const header = popover.createDiv({ cls: "lifeos-ai-edit-popover-header" });
    const icon = header.createSpan({ cls: "lifeos-ai-edit-popover-icon" });
    setIcon(icon, target.kind === "canvas" ? "layout-dashboard" : "sparkles");
    const copy = header.createDiv({ cls: "lifeos-ai-edit-popover-heading" });
    copy.createEl("strong", { text: target.kind === "canvas" ? "AI 调整白板" : "AI 修改内容" });
    copy.createSpan({ text: this.describeTarget(target) });
    this.dockButton = header.createEl("button", {
      cls: "lifeos-ai-edit-popover-close lifeos-ai-edit-popover-dock",
      attr: { type: "button", "aria-label": "在侧边栏展开" }
    });
    setIcon(this.dockButton, "panel-right");
    this.dockButton.onclick = () => this.handleDockButtonClick();
    this.syncDockButtonState();
    const closeButton = header.createEl("button", {
      cls: "lifeos-ai-edit-popover-close",
      attr: { type: "button", "aria-label": "关闭" }
    });
    setIcon(closeButton, "x");
    closeButton.onclick = () => this.close();

    const tabBar = popover.createDiv({ cls: "lifeos-ai-edit-tab-bar" });
    const answerTab = tabBar.createEl("button", {
      cls: this.activeTab === "answer" ? "lifeos-ai-edit-tab is-active" : "lifeos-ai-edit-tab",
      text: "问答",
      attr: { type: "button" }
    });
    answerTab.onclick = () => this.setActiveTab("answer");
    const editTab = tabBar.createEl("button", {
      cls: this.activeTab === "edit" ? "lifeos-ai-edit-tab is-active" : "lifeos-ai-edit-tab",
      text: "编辑",
      attr: { type: "button" }
    });
    editTab.onclick = () => this.setActiveTab("edit");

    const body = popover.createDiv({ cls: "lifeos-ai-edit-popover-body" });
    const context = body.createDiv({ cls: "lifeos-ai-edit-context" });
    context.createSpan({ text: this.contextLine(target) });
    this.renderPendingSelectionNotice();
    this.renderSelectionHistory(body);
    if (this.activeTab === "answer") {
      this.previewEl = body.createDiv({ cls: "lifeos-ai-edit-preview is-empty is-answer" });
      this.previewEl.setText("尚未调用 AI。输入问题后点击“回答 / 解释”，或直接点击按钮使用默认问题。");
    }
    this.renderSkillSelector(body);
    if (this.activeTab === "answer") {
      this.renderAnswerToolbar(body);
    }
    const command = body.createEl("textarea", {
      cls: "lifeos-ai-edit-command",
      attr: {
        placeholder: this.activeTab === "answer"
          ? "输入你想围绕选区提问的内容；留空时将解释选中内容..."
          : target.kind === "canvas"
            ? "例如：整理布局、补充一个下一步区域、把路线改成横向流程..."
            : "输入改写指令，例如：润色这段、翻译成英文、精简到 100 字..."
      }
    });
    this.commandInput = command;
    command.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        if (this.activeTab === "answer") {
          void this.generateAnswer(this.answerDepth, false);
        } else if (this.previewText) {
          void this.applyPreview();
        } else {
          void this.generatePreview();
        }
      }
    });

    if (this.activeTab === "edit" && this.editInstructions.length > 0) {
      const historyEl = body.createDiv({ cls: "lifeos-ai-edit-history" });
      for (let i = 0; i < this.editInstructions.length; i++) {
        const item = historyEl.createDiv({ cls: "lifeos-ai-edit-history-item" });
        item.createSpan({ cls: "lifeos-ai-edit-history-num", text: `${i + 1}` });
        item.createSpan({ cls: "lifeos-ai-edit-history-text", text: this.editInstructions[i] });
        if (i < this.editInstructions.length - 1) {
          const undoBtn = item.createEl("button", {
            cls: "lifeos-ai-edit-history-undo",
            text: "回退",
            attr: { type: "button" }
          });
          undoBtn.onclick = () => this.undoEditToRound(i);
        }
      }
    }

    if (!this.previewEl) {
      this.previewEl = body.createDiv({ cls: "lifeos-ai-edit-preview is-empty" });
      this.previewEl.setText("输入改写指令后点击生成预览。");
    }

    const actions = popover.createDiv({ cls: "lifeos-ai-edit-actions" });
    const cancel = actions.createEl("button", {
      cls: "lifeos-ai-edit-action lifeos-ai-edit-action-ghost",
      text: "取消",
      attr: { type: "button" }
    });
    this.cancelButton = cancel;
    cancel.onclick = () => {
      if (this.generating) {
        this.cancelActivePreview("已停止生成。你可以修改要求后重新生成。");
        return;
      }
      this.close();
    };

    if (this.activeTab === "answer") {
      this.generateButton = null;
      this.applyButton = null;
      this.askButton = actions.createEl("button", {
        cls: "lifeos-ai-edit-action lifeos-ai-edit-answer-action",
        text: this.answerHistory.length > 0 ? "继续追问" : "回答 / 解释",
        attr: { type: "button" }
      });
      this.askButton.onclick = () => void this.generateAnswer(this.answerDepth, false);
    } else {
      this.askButton = null;
      this.generateButton = actions.createEl("button", {
        cls: "lifeos-ai-edit-action",
        text: this.editInstructions.length > 0 ? "继续修改" : "生成预览",
        attr: { type: "button" }
      });
      this.generateButton.onclick = () => void this.generatePreview();
      this.applyButton = actions.createEl("button", {
        cls: "lifeos-ai-edit-action lifeos-ai-edit-action-primary",
        text: "应用修改",
        attr: { type: "button", disabled: "true" }
      });
      this.applyButton.onclick = () => void this.applyPreview();
    }
  }

  private renderSelectionPrompt(
    parent: HTMLElement,
    target: Extract<AiEditTarget, { kind: "selection" | "readonly-selection" }>,
    shouldOpenInPanel: boolean
  ): void {
    const popover = parent.createDiv({ cls: "lifeos-ai-edit-popover is-selection-prompt" });
    popover.toggleClass("is-panel", shouldOpenInPanel);
    popover.setAttr("role", "toolbar");
    popover.setAttr("aria-label", "选区操作");
    this.popoverEl = popover;

    const header = popover.createDiv({ cls: "lifeos-ai-edit-selection-prompt-header" });
    const icon = header.createSpan({ cls: "lifeos-ai-edit-popover-icon" });
    setIcon(icon, "sparkles");
    const copy = header.createDiv({ cls: "lifeos-ai-edit-selection-prompt-copy" });
    copy.createEl("strong", { text: "是否使用 AI？" });
    copy.createSpan({ text: `已选中 ${target.text.trim().length} 个字符，尚未调用 AI。` });
    const closeButton = header.createEl("button", {
      cls: "lifeos-ai-edit-popover-close",
      attr: { type: "button", "aria-label": "关闭选区操作" }
    });
    setIcon(closeButton, "x");
    closeButton.onclick = () => this.close();

    const actions = popover.createDiv({ cls: "lifeos-ai-edit-selection-prompt-actions" });
    const editButton = actions.createEl("button", {
      cls: "lifeos-ai-edit-action lifeos-ai-edit-action-primary",
      text: "AI 修改",
      attr: { type: "button" }
    });
    editButton.onclick = () => this.expandSelectionPrompt("edit");
    const answerButton = actions.createEl("button", {
      cls: "lifeos-ai-edit-action lifeos-ai-edit-action-ghost",
      text: "围绕选区提问",
      attr: { type: "button" }
    });
    answerButton.onclick = () => this.expandSelectionPrompt("answer");
    popover.createSpan({
      cls: "lifeos-ai-edit-selection-prompt-hint",
      text: "复制、手动编辑或调整结构时可直接忽略，不会自动分析。"
    });
  }

  private expandSelectionPrompt(tab: "answer" | "edit"): void {
    if (!this.target || !this.popoverEl || this.generating) return;
    const container = this.popoverEl.parentElement
      ?? (this.isMountedInPanel() ? this.panelContainerEl : document.body)
      ?? document.body;
    this.selectionPromptPending = false;
    this.activeTab = tab;
    this.popoverEl.remove();
    this.renderCurrentPopover(container);
    this.placePopover();
    window.setTimeout(() => this.commandInput?.focus(), 30);
  }

  private async generatePreview(): Promise<void> {
    if (this.generating || !this.target || !this.commandInput || !this.previewEl) return;
    const command = this.commandInput.value.trim();
    if (!command) {
      new Notice("先输入你想让 AI 怎么改。");
      this.commandInput.focus();
      return;
    }
    if (!requireProFeature(this.plugin, "aiDocumentEdit")) return;

    this.generating = true;
    this.activeTab = "edit";
    this.resultKind = "edit";
    this.activeGenerationKind = "edit";
    this.previewText = "";
    this.streamPreviewText = "";
    this.streamStartedAt = Date.now();
    const requestId = ++this.generationId;
    const controller = new AbortController();
    this.abortController = controller;
    this.syncActionState("生成中...");
    this.previewEl.removeClass("is-empty", "is-error");
    this.startPreviewHeartbeat(requestId, controller);

    try {
      let completedText = "";
      const response = await this.plugin.ai.completeStream({
        responseFormat: this.target.kind === "canvas" ? "json" : "text",
        temperature: 0.2,
        reasoningEffort: "default",
        skipModelCheck: true,
        messages: [
          { role: "system", content: this.systemPromptWithSkills(this.target) },
          { role: "user", content: this.userPrompt(this.target, command) }
        ]
      }, {
        onStart: () => this.setPreviewProgress(requestId, "已连接模型，正在等待首段内容..."),
        onToken: (token) => {
          if (!this.isCurrentPreviewRequest(requestId, controller)) return;
          this.streamPreviewText += token;
          this.scheduleStreamingMarkdownRender(requestId);
        },
        onDone: (text) => {
          completedText = text;
        },
        onError: (error) => this.setPreviewProgress(requestId, error || "生成预览失败。", true),
        onAbort: () => this.setPreviewProgress(requestId, "已停止生成。")
      }, controller.signal);

      if (!this.isCurrentPreviewRequest(requestId, controller)) return;

      const responseText = response.text || completedText || this.streamPreviewText;
      if (!response.ok || !responseText) {
        throw new Error(response.error || "AI 没有返回可用内容。");
      }

      this.previewText = this.normalizeAiPreview(this.target, responseText);
      const currentCommand = this.commandInput?.value.trim() ?? "";
      this.editInstructions.push(currentCommand);
      this.editPreviewSnapshots.push(this.previewText);
      if (this.editInstructions.length > 10) {
        this.editInstructions = this.editInstructions.slice(-10);
        this.editPreviewSnapshots = this.editPreviewSnapshots.slice(-10);
      }
      this.renderPreview(this.target, this.previewText);
      this.applyButton?.removeAttribute("disabled");
    } catch (error) {
      if (!this.isCurrentPreviewRequest(requestId, controller)) return;
      this.previewEl.addClass("is-error");
      this.previewEl.setText(error instanceof Error ? error.message : "生成预览失败。");
      this.applyButton?.setAttr("disabled", "true");
    } finally {
      if (this.generationId === requestId && this.abortController === controller) {
        this.clearPreviewTimers();
        this.clearStreamRenderTimer();
        this.abortController = null;
        this.streamPreviewText = "";
        this.generating = false;
        this.activeGenerationKind = null;
        this.syncActionState("生成预览");
        this.renderPendingSelectionNotice();
        this.placePopover();
      }
    }
  }

  private async generateAnswer(depth: AiAnswerDepth, automatic: boolean, modeSwitch = false): Promise<void> {
    if (this.generating || !this.target || !this.commandInput || !this.previewEl) return;
    if (!requireProFeature(this.plugin, "aiDocumentEdit")) return;

    const target = this.target;
    const typedCommand = this.commandInput.value.trim();

    this.generating = true;
    this.activeTab = "answer";
    this.resultKind = "answer";
    this.answerDepth = depth;
    this.activeGenerationKind = "answer";
    this.currentAnswerQuestion = "";
    this.previewText = "";
    this.streamPreviewText = "";
    this.streamStartedAt = Date.now();
    this.applyButton?.setAttr("disabled", "true");
    const requestId = ++this.generationId;
    const controller = new AbortController();
    this.abortController = controller;
    this.syncActionState("生成预览");
    this.renderMarkdownPreview("正在根据选区组织答案...", true);
    this.startPreviewHeartbeat(requestId, controller);

    try {
      const promptTarget = await this.answerPromptTarget(target);
      if (!this.isCurrentPreviewRequest(requestId, controller)) return;
      const question = typedCommand || this.defaultAnswerQuestion(automatic, depth, modeSwitch, promptTarget);
      this.currentAnswerQuestion = question;
      let completedText = "";
      const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
        { role: "system", content: this.answerSystemPrompt(promptTarget, depth) },
        ...this.answerHistoryMessages(),
        { role: "user", content: this.answerUserPrompt(promptTarget, question, depth) }
      ];
      const response = await this.plugin.ai.completeStream({
        responseFormat: "text",
        temperature: 0.2,
        reasoningEffort: "default",
        skipModelCheck: true,
        messages
      }, {
        onStart: () => this.setPreviewProgress(requestId, "正在连接模型，答案会边生成边显示..."),
        onToken: (token) => {
          if (!this.isCurrentPreviewRequest(requestId, controller)) return;
          this.streamPreviewText += token;
          this.scheduleStreamingMarkdownRender(requestId);
        },
        onDone: (text) => {
          completedText = text;
        },
        onError: (error) => this.setPreviewProgress(requestId, error || "生成答案失败。", true),
        onAbort: () => this.setPreviewProgress(requestId, "已停止生成。")
      }, controller.signal);

      if (!this.isCurrentPreviewRequest(requestId, controller)) return;

      const responseText = (response.text || completedText || this.streamPreviewText).trim();
      if (!response.ok || !responseText) {
        throw new Error(response.error || "AI 没有返回可用答案。");
      }

      this.previewText = stripCodeFences(responseText).trim();
      this.answerHistory.push({ role: "user", content: question });
      this.answerHistory.push({ role: "assistant", content: this.previewText });
      if (this.answerHistory.length > 10) {
        this.answerHistory = this.answerHistory.slice(-10);
      }
      this.currentAnswerQuestion = "";
      this.renderMarkdownPreview(this.previewText);
      if (typedCommand) this.commandInput.value = "";
    } catch (error) {
      if (!this.isCurrentPreviewRequest(requestId, controller)) return;
      this.currentAnswerQuestion = "";
      this.previewEl.addClass("is-error");
      this.previewEl.setText(error instanceof Error ? error.message : "生成答案失败。");
    } finally {
      if (this.generationId === requestId && this.abortController === controller) {
        this.clearPreviewTimers();
        this.clearStreamRenderTimer();
        this.abortController = null;
        this.streamPreviewText = "";
        this.generating = false;
        this.activeGenerationKind = null;
        this.syncActionState("生成预览");
        this.renderPendingSelectionNotice();
        this.placePopover();
      }
    }
  }

  private async applyPreview(): Promise<void> {
    if (!this.target || !this.previewText) return;
    if (this.resultKind === "answer") {
      new Notice("答题内容不会直接写回；如需写入，请先复制或改用生成预览。");
      return;
    }
    if (!requireProFeature(this.plugin, "aiWriteback")) return;

    try {
      if (this.target.kind === "readonly-selection") {
        new Notice("阅读模式选区不能直接写回；请切到源码/编辑模式后重新选择，或复制这段预览。");
        return;
      }
      if (this.target.kind === "selection") {
        const current = this.target.editor.getRange(this.target.from, this.target.to);
        if (current !== this.target.text) {
          new Notice("选区内容已经变化，请重新选择后再应用。");
          return;
        }
        this.target.editor.replaceRange(this.previewText, this.target.from, this.target.to);
      } else {
        await this.app.vault.modify(this.target.file, this.previewText);
      }
      new Notice(this.target.kind === "canvas" ? "白板已按预览更新" : "内容已按预览更新");
      this.close();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "应用修改失败。");
    }
  }

  private syncActionState(label: string): void {
    if (this.generateButton) {
      this.generateButton.setText(label);
      this.generateButton.toggleClass("is-loading", this.generating && this.activeGenerationKind === "edit");
      this.generateButton.toggleAttribute("disabled", this.generating);
    }
    if (this.askButton) {
      const answerLabel = this.answerHistory.length > 0 ? "继续追问" : "回答 / 解释";
      this.askButton.setText(this.generating && this.activeGenerationKind === "answer" ? "回答中..." : answerLabel);
      this.askButton.toggleClass("is-loading", this.generating && this.activeGenerationKind === "answer");
      this.askButton.toggleAttribute("disabled", this.generating);
    }
    if (this.cancelButton) {
      this.cancelButton.setText(this.generating ? "停止生成" : "取消");
    }
    if (this.applyButton) {
      if (this.generating || this.resultKind === "answer" || !this.previewText) {
        this.applyButton.setAttr("disabled", "true");
      } else {
        this.applyButton.removeAttribute("disabled");
      }
    }
    this.syncAnswerToolbarState();
  }

  private startPreviewHeartbeat(requestId: number, controller: AbortController): void {
    const startedAt = Date.now();
    const timeoutMs = this.previewTimeoutMs();
    const timeoutSeconds = Math.round(timeoutMs / 1000);
    const render = () => {
      if (!this.isCurrentPreviewRequest(requestId, controller) || !this.previewEl) return;
      const elapsedMs = Date.now() - startedAt;
      const elapsedSeconds = Math.max(1, Math.floor(elapsedMs / 1000));
      const received = this.streamPreviewText.trim().length;
      if (received > 0) {
        this.scheduleStreamingMarkdownRender(requestId);
        this.syncActionState(`${this.activeGenerationKind === "answer" ? "回答中" : "生成中"} ${elapsedSeconds}s`);
        return;
      }
      const headline = received > 0
        ? `正在生成预览... 已收到 ${received} 字 · ${elapsedSeconds}s`
        : `正在生成预览... ${elapsedSeconds}s`;
      const hint = elapsedMs >= INLINE_AI_PREVIEW_SLOW_MS
        ? "模型或网络有点慢，可以继续等待；如果不想等，可以点“停止生成”后重试。"
        : "保持弹窗打开即可，完成后会自动显示预览。";
      this.setPreviewProgress(requestId, `${headline}\n${hint}`);
      this.syncActionState(`生成中 ${elapsedSeconds}s`);
    };

    render();
    this.heartbeatTimer = window.setInterval(render, INLINE_AI_PREVIEW_HEARTBEAT_MS);
    this.timeoutTimer = window.setTimeout(() => {
      if (!this.isCurrentPreviewRequest(requestId, controller)) return;
      controller.abort();
      const timeoutMessage = this.target?.kind === "canvas"
        ? `白板生成超过 ${timeoutSeconds} 秒，已自动停止。当前白板节点较多，建议缩小修改范围或分批调整。`
        : this.activeGenerationKind === "answer"
          ? `回答超过 ${timeoutSeconds} 秒仍未完成，已自动停止。可以继续追问时缩小问题范围，或稍后重试。`
          : `修改预览超过 ${timeoutSeconds} 秒仍未完成，已自动停止。建议缩小修改范围或分段处理。`;
      this.cancelActivePreview(timeoutMessage, true);
    }, timeoutMs);
  }

  private previewTimeoutMs(): number {
    if (this.target?.kind === "canvas") return INLINE_AI_PREVIEW_CANVAS_TIMEOUT_MS;
    return this.activeGenerationKind === "answer"
      ? INLINE_AI_PREVIEW_ANSWER_TIMEOUT_MS
      : INLINE_AI_PREVIEW_EDIT_TIMEOUT_MS;
  }

  private setPreviewProgress(requestId: number, text: string, isError = false): void {
    if (requestId !== this.generationId || !this.previewEl) return;
    this.previewEl.empty();
    this.previewEl.removeClass("is-empty", "is-error", "is-answer", "is-streaming");
    if (isError) this.previewEl.addClass("is-error");
    this.previewEl.setText(text);
    this.placePopover();
  }

  private cancelActivePreview(message: string, isError = false): void {
    if (!this.generating) {
      this.close();
      return;
    }
    this.stopPreviewRequest();
    this.generating = false;
    this.previewText = "";
    if (this.previewEl) {
      this.previewEl.empty();
      this.previewEl.removeClass("is-empty", "is-error", "is-answer", "is-streaming");
      this.previewEl.toggleClass("is-empty", !isError);
      this.previewEl.toggleClass("is-error", isError);
      this.previewEl.setText(message);
    }
    this.applyButton?.setAttr("disabled", "true");
    this.activeGenerationKind = null;
    this.syncActionState("重新生成");
    this.placePopover();
  }

  private stopPreviewRequest(): void {
    this.generationId += 1;
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort();
    }
    this.abortController = null;
    this.streamPreviewText = "";
    this.streamStartedAt = 0;
    this.activeGenerationKind = null;
    this.clearPreviewTimers();
    this.clearStreamRenderTimer();
  }

  private clearPreviewTimers(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.timeoutTimer !== null) {
      window.clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private clearStreamRenderTimer(): void {
    if (this.streamRenderTimer !== null) {
      window.cancelAnimationFrame(this.streamRenderTimer);
      this.streamRenderTimer = null;
    }
  }

  private isCurrentPreviewRequest(requestId: number, controller: AbortController): boolean {
    return this.generationId === requestId && this.abortController === controller && !controller.signal.aborted;
  }

  private renderPreview(target: AiEditTarget, text: string): void {
    if (!this.previewEl) return;
    this.previewEl.empty();
    this.previewEl.removeClass("is-empty", "is-error", "is-answer", "is-streaming");
    if (target.kind === "canvas") {
      const canvas = JSON.parse(text) as CanvasDocumentLike;
      this.previewEl.createEl("strong", { text: `可写回 Canvas：${canvas.nodes.length} 个节点 / ${canvas.edges.length} 条连接` });
      const list = this.previewEl.createEl("ul");
      for (const title of previewCanvasTitles(canvas).slice(0, 5)) {
        list.createEl("li", { text: title });
      }
      if (canvas.nodes.length > 5) {
        list.createEl("li", { text: `还有 ${canvas.nodes.length - 5} 个节点将保留或调整` });
      }
      return;
    }

    renderMarkdownDisplay(this.app, this.plugin, this.previewEl, text, target.file.path);
  }

  private renderMarkdownPreview(text: string, isStreaming = false, isAnswer = true): void {
    if (!this.previewEl) return;
    this.previewEl.empty();
    this.previewEl.removeClass("is-empty", "is-error", "is-streaming");
    this.previewEl.toggleClass("is-answer", isAnswer);
    this.previewEl.toggleClass("is-streaming", isStreaming);
    const normalized = text.trim();
    if (isAnswer) {
      this.renderAnswerConversation(normalized, isStreaming);
      return;
    }
    if (!normalized) {
      this.previewEl.addClass("is-empty");
      this.previewEl.setText("正在等待 AI 回复...");
      return;
    }
    renderMarkdownDisplay(this.app, this.plugin, this.previewEl, normalized, this.target?.file.path ?? "");
  }

  private renderAnswerConversation(currentAssistantText: string, isStreaming: boolean): void {
    if (!this.previewEl) return;
    const messages = this.answerHistory.map((message) => ({ ...message }));
    if (this.currentAnswerQuestion) messages.push({ role: "user", content: this.currentAnswerQuestion });
    const latestAssistant = messages.at(-1);
    if (currentAssistantText && (isStreaming || latestAssistant?.role !== "assistant" || latestAssistant.content !== currentAssistantText)) {
      messages.push({ role: "assistant", content: currentAssistantText });
    }
    if (messages.length === 0) {
      this.previewEl.addClass("is-empty");
      this.previewEl.setText("正在等待 AI 回复...");
      return;
    }
    for (const messageItem of messages) {
      const message = this.previewEl.createDiv({
        cls: messageItem.role === "user"
          ? "lifeos-ai-edit-chat-message is-user"
          : "lifeos-ai-edit-chat-message is-assistant"
      });
      message.createDiv({ cls: "lifeos-ai-edit-chat-role", text: messageItem.role === "user" ? "你" : "AI" });
      const content = message.createDiv({ cls: "lifeos-ai-edit-chat-content" });
      renderMarkdownDisplay(this.app, this.plugin, content, messageItem.content, this.target?.file.path ?? "");
    }
  }

  private scheduleStreamingMarkdownRender(requestId: number): void {
    if (this.streamRenderTimer !== null) return;
    this.streamRenderTimer = window.requestAnimationFrame(() => {
      this.streamRenderTimer = null;
      this.renderStreamingPreview(requestId);
    });
  }

  private renderStreamingPreview(requestId: number): void {
    if (requestId !== this.generationId || !this.previewEl || !this.streamPreviewText.trim()) return;
    const text = limitStreamingPreviewText(this.streamPreviewText);
    if (this.target?.kind === "canvas") {
      this.renderStreamingCanvasPreview(text);
    } else {
      this.renderMarkdownPreview(text, true, this.activeGenerationKind === "answer");
    }
    this.renderStreamingStatus();
    if (!this.popoverEl?.hasClass("is-panel")) this.previewEl.scrollTop = this.previewEl.scrollHeight;
    this.placePopover();
  }

  private renderStreamingCanvasPreview(text: string): void {
    if (!this.previewEl) return;
    this.previewEl.empty();
    this.previewEl.removeClass("is-empty", "is-error", "is-answer");
    this.previewEl.addClass("is-streaming");
    this.previewEl.createEl("strong", { text: "正在接收 Canvas JSON，完成后会自动校验并整理布局" });
    this.previewEl.createEl("pre", { text });
  }

  private renderStreamingStatus(): void {
    if (!this.previewEl) return;
    const elapsedSeconds = this.streamStartedAt > 0
      ? Math.max(1, Math.floor((Date.now() - this.streamStartedAt) / 1000))
      : 1;
    this.previewEl.createDiv({
      cls: "lifeos-ai-edit-stream-status",
      text: `正在接收 · ${this.streamPreviewText.trim().length} 字 · ${elapsedSeconds}s`
    });
  }

  private renderAnswerToolbar(parent: HTMLElement): void {
    this.answerToolbarEl?.remove();
    const toolbar = parent.createDiv({ cls: "lifeos-ai-edit-answer-toolbar" });
    this.answerToolbarEl = toolbar;
    const label = toolbar.createDiv({ cls: "lifeos-ai-edit-answer-copy" });
    label.createEl("strong", { text: "答题模式" });
    label.createSpan({ text: "这里只回答和解释，不会写回；切到“编辑”可生成可应用预览。" });
    const contextModes = toolbar.createDiv({ cls: "lifeos-ai-edit-answer-context-modes" });
    for (const mode of [
      { id: "fast" as const, label: "快速", hint: "当前选区 + Skill 摘要" },
      { id: "deep" as const, label: "深入", hint: "完整选区 + Skill + 对话上下文" }
    ]) {
      const button = contextModes.createEl("button", {
        cls: this.answerContextMode === mode.id ? "lifeos-ai-edit-context-mode is-active" : "lifeos-ai-edit-context-mode",
        text: mode.label,
        attr: { type: "button", title: `${mode.hint}；切换后点击回答 / 解释生效。` }
      });
      button.onclick = () => this.setAnswerContextMode(mode.id);
    }
    contextModes.createSpan({ cls: "lifeos-ai-edit-answer-context-hint", text: this.answerContextHint() });
    const modes = toolbar.createDiv({ cls: "lifeos-ai-edit-answer-modes" });
    for (const depth of AI_ANSWER_DEPTHS) {
      const button = modes.createEl("button", {
        cls: this.answerDepth === depth.id ? "lifeos-ai-edit-answer-mode is-active" : "lifeos-ai-edit-answer-mode",
        text: depth.label,
        attr: { type: "button" }
      });
      button.onclick = () => void this.generateAnswer(depth.id, false, true);
    }
    this.syncAnswerToolbarState();
  }

  private syncAnswerToolbarState(): void {
    if (!this.answerToolbarEl) return;
    for (const button of Array.from(this.answerToolbarEl.querySelectorAll<HTMLButtonElement>(".lifeos-ai-edit-answer-mode"))) {
      const depth = AI_ANSWER_DEPTHS.find((candidate) => candidate.label === button.textContent);
      button.toggleClass("is-active", depth?.id === this.answerDepth);
      button.toggleAttribute("disabled", this.generating);
    }
    for (const button of Array.from(this.answerToolbarEl.querySelectorAll<HTMLButtonElement>(".lifeos-ai-edit-context-mode"))) {
      button.toggleClass("is-active", button.textContent === (this.answerContextMode === "fast" ? "快速" : "深入"));
      button.toggleAttribute("disabled", this.generating);
    }
  }

  private setAnswerContextMode(mode: AiAnswerContextMode): void {
    if (this.answerContextMode === mode || this.generating) return;
    this.answerContextMode = mode;
    if (this.answerToolbarEl?.parentElement) this.renderAnswerToolbar(this.answerToolbarEl.parentElement);
  }

  private answerContextHint(): string {
    if (!this.target) return "";
    const selectionChars = Math.min(this.target.text.trim().length, this.answerContextMode === "fast" ? 12000 : 36000);
    const skillChars = this.selectedSkillPrompt(this.answerContextMode === "fast" ? 4000 : undefined).length;
    const historyChars = this.answerContextMode === "deep"
      ? this.answerHistoryMessages().reduce((total, message) => total + message.content.length, 0)
      : 0;
    return `${this.answerContextMode === "fast" ? "当前选区 + Skill 摘要" : "完整上下文"} · 约 ${selectionChars + skillChars + historyChars} 字`;
  }

  mountToPanel(containerEl: HTMLElement, options: { pin?: boolean } = {}): void {
    const alreadyMounted = this.panelContainerEl === containerEl && this.isMountedInPanel();
    this.panelContainerEl = containerEl;
    if (options.pin) this.stickyPanel = true;
    this.unregisterDismissHandlers();
    if (alreadyMounted) {
      this.syncDockButtonState();
      return;
    }
    containerEl.empty();
    if (!this.popoverEl) {
      const empty = containerEl.createDiv({ cls: "lifeos-ai-edit-panel-empty" });
      empty.createEl("strong", { text: "AI \u4fee\u6539\u4fa7\u8fb9\u680f" });
      empty.createEl("span", { text: "\u9009\u4e2d Markdown \u6587\u672c\u540e\uff0c\u6211\u4f1a\u5728\u8fd9\u91cc\u76f4\u63a5\u56de\u7b54\uff1b\u4e5f\u53ef\u4ee5\u7528\u547d\u4ee4\u9762\u677f\u6253\u5f00\u5e76\u5e38\u9a7b\u3002" });
      return;
    }
    containerEl.appendChild(this.popoverEl);
    this.popoverEl.addClass("is-panel", "is-positioned");
    this.popoverEl.removeClass("is-sidebar");
    this.syncDockButtonState();
  }

  unmountFromPanel(options: { closeActive?: boolean; clearPanelPreference?: boolean } = {}): void {
    const closeActive = options.closeActive ?? true;
    this.panelContainerEl = null;
    if (options.clearPanelPreference ?? true) this.stickyPanel = false;
    if (closeActive) {
      this.close();
      return;
    }
    if (this.popoverEl) {
      document.body.appendChild(this.popoverEl);
      this.popoverEl.removeClass("is-panel");
      this.registerDismissHandlers();
      this.renderSelectionHighlight();
      this.placePopover();
    }
  }

  isMountedInPanel(): boolean {
    return Boolean(this.panelContainerEl && this.popoverEl?.hasClass("is-panel"));
  }

  shouldFollowSelectionInPanel(): boolean {
    return Boolean(this.stickyPanel && this.panelContainerEl?.isConnected);
  }

  private handleDockButtonClick(): void {
    if (this.isMountedInPanel()) {
      this.plugin.undockAiEditFromSidebar();
      return;
    }
    void this.plugin.dockAiEditToSidebar();
  }

  private syncDockButtonState(): void {
    if (!this.dockButton) return;
    const inPanel = this.isMountedInPanel();
    this.dockButton.setAttr("aria-label", inPanel ? "?????" : "? Obsidian ?????");
    this.dockButton.empty();
    setIcon(this.dockButton, inPanel ? "panel-right-close" : "panel-right");
  }

  private answerSystemPrompt(target: AiEditTarget, depth: AiAnswerDepth): string {
    const depthSpec = AI_ANSWER_DEPTHS.find((item) => item.id === depth) ?? AI_ANSWER_DEPTHS[1];
    const scope = target.kind === "canvas"
      ? "用户正在白板里提问，回答要能帮助整理白板结构和后续生成。"
      : target.kind === "selection" || target.kind === "readonly-selection"
        ? "用户选中了文档中的一段文字，回答要严格围绕选区。"
        : "用户正在阅读一篇 Markdown 文档，回答要严格围绕当前文档。";
    return [
      "你是 Life OS 的选区答题助手。你的任务是直接回答用户基于当前选区或白板内容提出的问题。",
      scope,
      this.selectedSkillPrompt(this.answerContextMode === "fast" ? 4000 : undefined),
      this.answerContextMode === "fast"
        ? "快速模式：只基于当前选区和 Skill 摘要直接作答，不携带上轮对话；优先给出结论。"
        : "深入模式：使用完整选区、全部已选 Skill 与最近对话上下文，系统展开推理和建议。",
      this.answerTaskInstruction(target),
      `回答模式：${depthSpec.label}。${depthSpec.instruction}`,
      "输出必须使用 Markdown。可以使用标题、列表、表格和引用，但不要使用代码围栏包住整段答案。",
      "不要声称已经修改文件；如果用户需要写回，请提醒可以改用“生成预览”。"
    ].filter(Boolean).join("\n\n");
  }

  private answerUserPrompt(target: AiEditTarget, question: string, depth: AiAnswerDepth): string {
    const depthSpec = AI_ANSWER_DEPTHS.find((item) => item.id === depth) ?? AI_ANSWER_DEPTHS[1];
    const lines = [
      `用户问题：${question}`,
      `回答模式：${depthSpec.label}`,
      `目标文件：${normalizePath(target.file.path)}`,
      ""
    ];
    if (target.kind === "canvas" && target.nodeHint) {
      lines.push(`用户点击的白板节点或区域：${target.nodeHint}`, "");
    }
    lines.push(target.kind === "canvas" ? "当前 Canvas JSON：" : target.kind === "selection" || target.kind === "readonly-selection" ? "当前选区：" : "当前文档：");
    const maxChars = target.kind === "canvas"
      ? 120000
      : this.answerContextMode === "fast"
        ? 12000
        : 36000;
    lines.push(limitPromptText(target.text, maxChars));
    return lines.join("\n");
  }

  private answerHistoryMessages(): Array<{ role: "user" | "assistant"; content: string }> {
    if (this.answerContextMode === "fast") return [];
    return this.answerHistory.slice(-8);
  }

  private answerTaskInstruction(target: AiEditTarget): string {
    if (!hasCompleteMultipleChoiceQuestion(target.text)) return "";
    return [
      "当前选区已包含一题完整的选择题题干和 A、B、C、D 选项。",
      "必须正面作答：第一行固定输出“答案：<选项字母>”，随后用材料主旨和选项对比说明理由。",
      "不得把它改答成材料摘要、申论概括或复盘建议；不得声称题干或选项缺失。"
    ].join("\n");
  }

  private async answerPromptTarget(target: AiEditTarget): Promise<AiEditTarget> {
    if (
      (target.kind !== "selection" && target.kind !== "readonly-selection")
      || hasCompleteMultipleChoiceQuestion(target.text)
      || !mayContainMultipleChoiceQuestion(target.text)
    ) return target;

    try {
      const documentText = await this.app.vault.read(target.file);
      const completedQuestion = findCompleteMultipleChoiceQuestion(target.text, documentText);
      if (!completedQuestion) return target;
      return {
        ...target,
        text: `${target.text.trim()}\n\n【从当前文档补全的同一道题题干与选项】\n${completedQuestion}`
      };
    } catch {
      return target;
    }
  }

  private defaultAnswerQuestion(
    automatic: boolean,
    depth: AiAnswerDepth = this.answerDepth,
    modeSwitch = false,
    target: AiEditTarget | null = this.target
  ): string {
    const depthSpec = AI_ANSWER_DEPTHS.find((item) => item.id === depth) ?? AI_ANSWER_DEPTHS[1];
    if (automatic && target && hasCompleteMultipleChoiceQuestion(target.text)) {
      return "请直接作答当前选区中的完整选择题。第一行必须写“答案：<选项字母>”，再简要说明材料主旨及其他选项不当之处。";
    }
    if (automatic) return "请直接回答、解释或归纳当前选区的核心内容。";
    if (modeSwitch && this.answerHistory.length > 0) return `请用${depthSpec.label}模式重新回答当前选区。`;
    if (this.answerHistory.length > 0) return "请基于上一次回答继续补充，给出更清楚的解释。";
    return "请直接回答当前选区最可能对应的问题，并给出可读的解释。";
  }

  private normalizeAiPreview(target: AiEditTarget, raw: string): string {
    const withoutFooter = raw.replace(/(?:^|\n)\s*AI生成\s*$/u, "").trim();
    const stripped = stripCodeFences(withoutFooter).trim();
    if (target.kind !== "canvas") {
      if (!stripped) throw new Error("AI 返回内容为空。");
      return stripped;
    }
    return normalizeCanvasJson(stripped);
  }

  private systemPrompt(target: AiEditTarget): string {
    if (target.kind === "canvas") {
      return [
        "你是 Life OS 的 Obsidian Canvas 白板修改助手。",
        "只输出完整、合法的 Obsidian .canvas JSON，不要解释，不要 Markdown 代码围栏。",
        "必须保留 nodes 和 edges 数组。除非用户明确要求删除，否则保留原有节点和连接。",
        "可以根据用户命令优化节点文本、补充节点、调整 x/y/width/height，让白板更清晰可读。",
        "新增节点要短标题、短正文，避免一张卡片塞入大段文字。",
        "布局必须使用语义泳道：中心主题、资料摘要、阶段/模块、证据、问题/行动、统计/模板分列摆放。",
        "节点之间至少保留 80px 呼吸间距；不要重叠，不要把大量节点堆成圆环或单点辐射。",
        "连线应尽量从左到右或从上到下，避免交叉；如果只是整理布局，也要输出完整 Canvas JSON。"
      ].join("\n");
    }

    if (target.kind === "selection" || target.kind === "readonly-selection") {
      return [
        "你是 Life OS 的轻量文本修改助手。",
        "只输出改好的选中文本，不要解释，不要代码围栏，不要加 AI 署名。",
        "保持原意和事实，按用户命令调整表达、结构或语气。"
      ].join("\n");
    }

    return [
      "你是 Life OS 的 Markdown 文档修改助手。",
      "只输出完整修改后的 Markdown 文档，不要解释，不要代码围栏，不要加 AI 署名。",
      "保持原文事实和标题层级，按用户命令整理、补充或润色。"
    ].join("\n");
  }

  private systemPromptWithSkills(target: AiEditTarget): string {
    return [
      this.systemPrompt(target),
      this.selectedSkillPrompt(),
      this.inlineEditSkillModeInstruction(target)
    ].filter(Boolean).join("\n\n");
  }

  private selectedSkillPrompt(maxChars?: number): string {
    const prompt = composeAiSkillPrompt(
      this.selectedSkillIds,
      this.plugin.settings.defaultAiSkillId,
      this.importedAiSkills,
      this.plugin.settings.customAiSkillCategories,
      this.plugin.settings.aiSkillOverrides
    );
    return typeof maxChars === "number" ? limitPromptText(prompt, maxChars) : prompt;
  }

  private inlineEditSkillModeInstruction(target: AiEditTarget): string {
    const selectedSkills = getAiSkills(this.selectedSkillIds, this.importedAiSkills, this.plugin.settings.aiSkillOverrides);
    const names = selectedSkills.map((skill) => skill.name).join(" + ");
    const outputRule = target.kind === "canvas"
      ? "最终输出只能是完整 Obsidian Canvas JSON，不要解释，不要按 Skill 分段，不要添加 Markdown 代码围栏。"
      : target.kind === "selection" || target.kind === "readonly-selection"
        ? "最终输出只能是改写后的选中文本，不要解释，不要按 Skill 分段，不要添加标题或 AI 署名。"
        : "最终输出只能是完整修改后的 Markdown 文档，不要解释，不要按 Skill 分段，不要添加 AI 署名。";
    return [
      `本次 AI 修改弹窗选中的 Skill：${names || "Life OS 总管"}。`,
      "Skill 只决定思考角度、方法论和语气取舍；它不是新的写回格式。",
      outputRule
    ].join("\n");
  }

  private renderSkillSelector(parent: HTMLElement): void {
    const existing = this.skillPickerEl;
    if (existing) existing.remove();

    const selectedSkills = getAiSkills(this.selectedSkillIds, this.importedAiSkills, this.plugin.settings.aiSkillOverrides);
    const skillCategories = getAiSkillCategories(this.plugin.settings.customAiSkillCategories);
    const panel = parent.createEl("details", { cls: "lifeos-ai-edit-skill-panel" });
    this.skillPickerEl = panel;

    const summary = panel.createEl("summary", { cls: "lifeos-ai-edit-skill-summary" });
    summary.createSpan({ cls: "lifeos-ai-edit-skill-label", text: "回复 Skill" });
    const current = summary.createSpan({ cls: "lifeos-ai-edit-skill-current" });
    for (const skill of selectedSkills.slice(0, 2)) {
      current.createSpan({ cls: "lifeos-ai-edit-skill-current-chip", text: skill.name });
    }
    if (selectedSkills.length > 2) {
      current.createSpan({ cls: "lifeos-ai-edit-skill-more", text: `+${selectedSkills.length - 2}` });
    }

    const groups = panel.createDiv({ cls: "lifeos-ai-edit-skill-groups" });
    groups.createDiv({
      cls: "lifeos-ai-edit-skill-hint",
      text: "选择这次修改要使用的 Skill。它会影响回复方法和语气，但仍只写回当前选区、文档或白板。"
    });

    for (const category of skillCategories) {
      const skills = getAiSkillsByCategory(category.id, this.importedAiSkills, this.plugin.settings.aiSkillOverrides);
      if (skills.length === 0) continue;
      const group = groups.createDiv({ cls: "lifeos-ai-edit-skill-category" });
      const head = group.createDiv({ cls: "lifeos-ai-edit-skill-category-head" });
      head.createSpan({ cls: "lifeos-ai-edit-skill-category-title", text: category.label });
      head.createSpan({ cls: "lifeos-ai-edit-skill-category-count", text: `${skills.length}` });
      const list = group.createDiv({ cls: "lifeos-ai-edit-skill-list" });
      for (const skill of skills) {
        const chip = list.createEl("button", {
          cls: this.selectedSkillIds.includes(skill.id) ? "lifeos-ai-edit-skill-chip is-active" : "lifeos-ai-edit-skill-chip",
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
    this.selectedSkillIds = normalizeAiSkillIds(Array.from(next), undefined, this.importedAiSkills, this.plugin.settings.aiSkillOverrides);
    this.plugin.settings.inlineAiSkillIds = this.selectedSkillIds;
    void this.plugin.saveSettings();
    if (this.skillPickerEl?.parentElement) this.renderSkillSelector(this.skillPickerEl.parentElement);
    this.placePopover();
    window.setTimeout(() => this.commandInput?.focus(), 0);
    if (this.activeTab === "answer" && this.target && !this.generating) {
      this.answerHistory = [];
      this.currentAnswerQuestion = "";
      this.previewText = "";
      this.previewEl?.addClass("is-empty");
      this.previewEl?.setText("Skill 已更新，尚未调用 AI。点击“回答 / 解释”后再分析。");
    }
  }

  private userPrompt(target: AiEditTarget, command: string): string {
    const lines = [
      `修改要求：${command}`,
      `目标文件：${normalizePath(target.file.path)}`,
      ""
    ];
    if (target.kind === "canvas" && target.nodeHint) {
      lines.push(`用户点击的白板节点或区域：${target.nodeHint}`, "");
    }
    lines.push(target.kind === "canvas" ? "当前 Canvas JSON：" : "当前内容：");
    lines.push(limitPromptText(target.text, target.kind === "canvas" ? 120000 : 36000));
    return lines.join("\n");
  }

  private describeTarget(target: AiEditTarget): string {
    if (target.kind === "selection" || target.kind === "readonly-selection") return `${target.file.basename || target.file.name} · 选中文本`;
    if (target.kind === "canvas") return `${target.file.basename || target.file.name} · 白板`;
    return `${target.file.basename || target.file.name} · 文档`;
  }

  private contextLine(target: AiEditTarget): string {
    if (target.kind === "selection" || target.kind === "readonly-selection") {
      if (this.activeTab === "answer") {
        return `将围绕 ${target.text.trim().length} 个字符回答；问答不会写回当前文档。`;
      }
      return target.kind === "readonly-selection"
        ? `将围绕 ${target.text.trim().length} 个字符回答；阅读模式选区不会直接写回。`
        : `将改写 ${target.text.trim().length} 个字符，只替换当前选区。`;
    }
    if (target.kind === "canvas") {
      if (this.activeTab === "answer") return "将围绕当前白板回答；问答不会写回白板。";
      return "将生成一份完整 Canvas JSON 预览，确认后覆盖当前白板文件。";
    }
    if (this.activeTab === "answer") return "将围绕当前 Markdown 文档回答；问答不会写回文档。";
    return "将生成完整 Markdown 预览，确认后覆盖当前文档。";
  }

  private renderSelectionHighlight(): void {
    this.clearSelectionHighlight();
    if (this.target?.kind !== "selection" && this.target?.kind !== "readonly-selection") return;
    if (this.app.workspace.getActiveFile()?.path !== this.target.file.path) return;
    const rects = (this.anchor.selectionRects?.length ? this.anchor.selectionRects : this.anchor.avoidRect ? [this.anchor.avoidRect] : [])
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .slice(0, 80);
    for (const rect of rects) {
      const highlight = document.body.createDiv({ cls: "lifeos-ai-edit-selection-highlight" });
      highlight.setCssProps({
        "--lifeos-ai-edit-highlight-left": `${Math.round(rect.left)}px`,
        "--lifeos-ai-edit-highlight-top": `${Math.round(rect.top)}px`,
        "--lifeos-ai-edit-highlight-width": `${Math.max(2, Math.round(rect.width))}px`,
        "--lifeos-ai-edit-highlight-height": `${Math.max(2, Math.round(rect.height))}px`
      });
      this.selectionHighlightEls.push(highlight);
    }
  }

  clearSelectionHighlight(): void {
    for (const highlight of this.selectionHighlightEls) highlight.remove();
    this.selectionHighlightEls = [];
  }

  private isEditorSelectionSurface(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && Boolean(
      target.closest(".markdown-source-view, .markdown-reading-view, .markdown-preview-view, .cm-editor, .cm-content")
    );
  }

  private measureRectOverlap(
    rect: { left: number; top: number; right: number; bottom: number },
    avoidRect: AiEditAvoidRect
  ): number {
    const width = Math.max(0, Math.min(rect.right, avoidRect.right) - Math.max(rect.left, avoidRect.left));
    const height = Math.max(0, Math.min(rect.bottom, avoidRect.bottom) - Math.max(rect.top, avoidRect.top));
    return width * height;
  }

  private placePopover(): void {
    if (!this.popoverEl) return;
    const popover = this.popoverEl;
    if (popover.hasClass("is-panel")) {
      popover.addClass("is-positioned");
      return;
    }
    requestAnimationFrame(() => {
      if (!this.popoverEl) return;
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const margin = viewportWidth <= 560 || viewportHeight <= 520 ? 16 : 22;
      const gap = 12;
      const rect = this.popoverEl.getBoundingClientRect();
      const minLeft = viewportLeft + margin;
      const minTop = viewportTop + margin;
      const maxLeft = viewportLeft + viewportWidth - rect.width - margin;
      const maxTop = viewportTop + viewportHeight - rect.height - margin;
      const clampLeft = (value: number) => Math.max(minLeft, Math.min(value, Math.max(minLeft, maxLeft)));
      const clampTop = (value: number) => Math.max(minTop, Math.min(value, Math.max(minTop, maxTop)));
      const candidates: Array<{ left: number; top: number; weight: number }> = [];
      const avoidRect = this.anchor.avoidRect;
      const isCanvasPlacement = this.anchor.placement === "canvas";
      const softAvoidRects = isCanvasPlacement ? [] : (this.anchor.softAvoidRects ?? [])
        .filter((softRect) => !avoidRect || this.measureRectOverlap(softRect, avoidRect) < softRect.width * softRect.height * 0.92)
        .slice(0, 80);

      if (isCanvasPlacement) {
        candidates.push(
          { left: this.anchor.x + gap, top: this.anchor.y + gap, weight: 0 },
          { left: this.anchor.x + gap, top: this.anchor.y - rect.height - gap, weight: 4 },
          { left: this.anchor.x - rect.width - gap, top: this.anchor.y + gap, weight: 8 },
          { left: this.anchor.x - rect.width - gap, top: this.anchor.y - rect.height - gap, weight: 12 }
        );
      }

      if (avoidRect) {
        const anchoredTop = this.anchor.y - Math.min(rect.height * 0.32, 120);
        candidates.push(
          { left: avoidRect.right + gap, top: anchoredTop, weight: isCanvasPlacement ? 16 : 0 },
          { left: avoidRect.right + gap, top: avoidRect.bottom + gap, weight: isCanvasPlacement ? 20 : 8 },
          { left: avoidRect.right + gap, top: avoidRect.top - rect.height - gap, weight: isCanvasPlacement ? 24 : 16 },
          { left: avoidRect.left - rect.width - gap, top: anchoredTop, weight: isCanvasPlacement ? 28 : 32 },
          { left: avoidRect.left, top: avoidRect.bottom + gap, weight: isCanvasPlacement ? 32 : 40 },
          { left: avoidRect.left - rect.width - gap, top: avoidRect.bottom + gap, weight: isCanvasPlacement ? 36 : 48 }
        );
      }

      if (isCanvasPlacement) {
        candidates.push(
          { left: maxLeft, top: clampTop(this.anchor.y - rect.height * 0.28), weight: 260 },
          { left: maxLeft, top: minTop, weight: 320 },
          { left: maxLeft, top: maxTop, weight: 340 },
          { left: clampLeft(viewportLeft + viewportWidth * 0.5), top: minTop, weight: 360 },
          { left: clampLeft(viewportLeft + viewportWidth * 0.5), top: maxTop, weight: 380 }
        );
      } else {
        candidates.push(
          { left: this.anchor.x + gap, top: this.anchor.y + gap, weight: 40 },
          { left: this.anchor.x + gap, top: this.anchor.y - rect.height - gap, weight: 48 },
          { left: this.anchor.x - rect.width - gap, top: this.anchor.y + gap, weight: 64 },
          { left: this.anchor.x - rect.width - gap, top: this.anchor.y - rect.height - gap, weight: 72 }
        );
      }

      const preferRightOfAvoid = Boolean(
        !isCanvasPlacement &&
        avoidRect &&
        avoidRect.right + gap + rect.width <= viewportLeft + viewportWidth - margin
      );
      const ranked = candidates.map((candidate) => {
        const left = clampLeft(candidate.left);
        const top = clampTop(candidate.top);
        const placed = { left, top, right: left + rect.width, bottom: top + rect.height };
        const overlap = avoidRect ? this.measureRectOverlap(placed, avoidRect) : 0;
        const softOverlap = softAvoidRects.reduce((total, softRect) => {
          return total + this.measureRectOverlap(placed, softRect);
        }, 0);
        const displacement = Math.abs(left - candidate.left) + Math.abs(top - candidate.top);
        const hardOverlapWeight = isCanvasPlacement ? 48 : 24;
        const softOverlapWeight = isCanvasPlacement ? 0 : 10;
        const displacementWeight = isCanvasPlacement ? 0.5 : 1.5;
        const selectionSidePenalty = !isCanvasPlacement && preferRightOfAvoid && avoidRect && left < avoidRect.right + gap ? 100000 : 0;
        return {
          left,
          top,
          score: candidate.weight + displacement * displacementWeight + overlap * hardOverlapWeight + softOverlap * softOverlapWeight + selectionSidePenalty
        };
      }).sort((a, b) => a.score - b.score);

      const { left, top } = ranked[0] ?? { left: clampLeft(this.anchor.x + gap), top: clampTop(this.anchor.y + gap) };
      this.popoverEl.setCssProps({
        "--lifeos-ai-edit-left": `${Math.round(left)}px`,
        "--lifeos-ai-edit-top": `${Math.round(top)}px`
      });
      this.popoverEl.addClass("is-positioned");
    });
  }

  private registerDismissHandlers(): void {
    this.outsidePointerHandler = (event) => {
      const target = event.target;
      if (this.popoverEl && target instanceof Node && !this.popoverEl.contains(target)) {
        if (this.generating) return;
        if (this.popoverEl?.hasClass("is-panel")) return;
        if (this.isEditorSelectionSurface(target)) return;
        this.close();
      }
    };
    this.keyHandler = (event) => {
      if (event.key === "Escape") this.close();
    };
    this.viewportHandler = () => {
      this.renderSelectionHighlight();
      this.placePopover();
    };
    window.setTimeout(() => {
      if (this.outsidePointerHandler) document.addEventListener("mousedown", this.outsidePointerHandler, true);
      if (this.keyHandler) document.addEventListener("keydown", this.keyHandler, true);
      if (this.viewportHandler) {
        window.addEventListener("resize", this.viewportHandler);
        window.visualViewport?.addEventListener("resize", this.viewportHandler);
        window.visualViewport?.addEventListener("scroll", this.viewportHandler);
      }
    }, 0);
  }

  private unregisterDismissHandlers(): void {
    if (this.outsidePointerHandler) {
      document.removeEventListener("mousedown", this.outsidePointerHandler, true);
      this.outsidePointerHandler = null;
    }
    if (this.keyHandler) {
      document.removeEventListener("keydown", this.keyHandler, true);
      this.keyHandler = null;
    }
    if (this.viewportHandler) {
      window.removeEventListener("resize", this.viewportHandler);
      window.visualViewport?.removeEventListener("resize", this.viewportHandler);
      window.visualViewport?.removeEventListener("scroll", this.viewportHandler);
    }
  }
}

export function cloneEditorPosition(position: EditorPosition): EditorPosition {
  return { line: position.line, ch: position.ch };
}

export function normalizeCanvasJson(text: string): string {
  const direct = tryParseCanvas(text);
  if (direct) return JSON.stringify(normalizeCanvasLayout(direct), null, 2);

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = tryParseCanvas(text.slice(start, end + 1));
    if (sliced) return JSON.stringify(normalizeCanvasLayout(sliced), null, 2);
  }
  throw new Error("AI 返回的内容不是合法 Canvas JSON。");
}

function tryParseCanvas(text: string): CanvasDocumentLike | null {
  try {
    const parsed = JSON.parse(text) as Partial<CanvasDocumentLike> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return { nodes: parsed.nodes, edges: parsed.edges };
  } catch {
    return null;
  }
}

function normalizeCanvasLayout(canvas: CanvasDocumentLike): CanvasDocumentLike {
  const nodes = canvas.nodes
    .map((node, index) => normalizeCanvasNode(node, index))
    .filter((node): node is Record<string, unknown> => Boolean(node));
  const nodeIds = new Set(nodes.map((node) => String(node.id)));
  const edges = canvas.edges
    .map((edge, index) => normalizeCanvasEdge(edge, index))
    .filter((edge): edge is Record<string, unknown> => {
      return edge !== null && nodeIds.has(String(edge.fromNode)) && nodeIds.has(String(edge.toNode));
    });

  const hub = nodes.find((node) => String(node.id) === "project-hub")
    ?? nodes.find((node) => inferCanvasNodeGroup(node) === "hub")
    ?? nodes[0];
  const columns = new Map<number, Array<Record<string, unknown>>>();
  for (const node of nodes) {
    const column = canvasLayoutColumn(node);
    const list = columns.get(column) ?? [];
    list.push(node);
    columns.set(column, list);
  }

  const laneGap = 740;
  const verticalGap = 84;
  for (const [column, columnNodes] of columns.entries()) {
    columnNodes.sort((left, right) => {
      const order = canvasGroupOrder(inferCanvasNodeGroup(left)) - canvasGroupOrder(inferCanvasNodeGroup(right));
      if (order !== 0) return order;
      return numberValue(left.y) - numberValue(right.y) || numberValue(left.x) - numberValue(right.x);
    });
    const x = column * laneGap;
    if (column === 0 && hub && columnNodes.includes(hub)) {
      hub.x = 0;
      hub.y = 0;
      let cursorY = numberValue(hub.y) + numberValue(hub.height) + 140;
      for (const node of columnNodes) {
        if (String(node.id) === String(hub.id)) continue;
        node.x = x;
        node.y = cursorY;
        cursorY += numberValue(node.height) + verticalGap;
      }
      continue;
    }

    const totalHeight = columnNodes.reduce((sum, node) => sum + numberValue(node.height), 0) + Math.max(0, columnNodes.length - 1) * verticalGap;
    let cursorY = Math.round(-totalHeight / 2);
    for (const node of columnNodes) {
      node.x = x;
      node.y = cursorY;
      cursorY += numberValue(node.height) + verticalGap;
    }
  }

  return normalizeCanvasEdgeSides(resolveCanvasNodeOverlaps({ nodes, edges }));
}

function normalizeCanvasNode(node: unknown, index: number): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  const data = node as Record<string, unknown>;
  const type = data.type === "file" ? "file" : "text";
  const id = typeof data.id === "string" && data.id.trim() ? data.id : `ai-node-${index + 1}`;
  const width = Math.max(type === "file" ? 340 : 300, Math.min(720, numberValue(data.width) || (type === "file" ? 360 : 360)));
  const height = Math.max(type === "file" ? 240 : 150, Math.min(640, numberValue(data.height) || (type === "file" ? 260 : 180)));
  return {
    ...data,
    id,
    type,
    x: numberValue(data.x),
    y: numberValue(data.y),
    width,
    height
  };
}

function normalizeCanvasEdge(edge: unknown, index: number): Record<string, unknown> | null {
  if (!edge || typeof edge !== "object") return null;
  const data = edge as Record<string, unknown>;
  if (typeof data.fromNode !== "string" || typeof data.toNode !== "string") return null;
  return {
    ...data,
    id: typeof data.id === "string" && data.id.trim() ? data.id : `ai-edge-${index + 1}`,
    fromNode: data.fromNode,
    toNode: data.toNode
  };
}

function resolveCanvasNodeOverlaps(canvas: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> }): CanvasDocumentLike {
  const ordered = [...canvas.nodes].sort((left, right) => numberValue(left.x) - numberValue(right.x) || numberValue(left.y) - numberValue(right.y));
  const gap = 44;
  for (let pass = 0; pass < 6; pass += 1) {
    let moved = false;
    for (let index = 0; index < ordered.length; index += 1) {
      const node = ordered[index];
      for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
        const previous = ordered[previousIndex];
        if (!canvasRectsOverlap(node, previous, gap)) continue;
        node.y = numberValue(previous.y) + numberValue(previous.height) + gap;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return canvas;
}

function normalizeCanvasEdgeSides(canvas: CanvasDocumentLike): CanvasDocumentLike {
  const nodes = canvas.nodes.filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === "object");
  const nodeById = new Map(nodes.map((node) => [String(node.id), node]));
  const edges = canvas.edges
    .filter((edge): edge is Record<string, unknown> => Boolean(edge) && typeof edge === "object")
    .map((edge) => {
      const from = nodeById.get(String(edge.fromNode));
      const to = nodeById.get(String(edge.toNode));
      if (!from || !to) return edge;
      const dx = numberValue(to.x) + numberValue(to.width) / 2 - numberValue(from.x) - numberValue(from.width) / 2;
      const dy = numberValue(to.y) + numberValue(to.height) / 2 - numberValue(from.y) - numberValue(from.height) / 2;
      if (Math.abs(dx) >= Math.abs(dy)) {
        return {
          ...edge,
          fromSide: dx >= 0 ? "right" : "left",
          toSide: dx >= 0 ? "left" : "right"
        };
      }
      return {
        ...edge,
        fromSide: dy >= 0 ? "bottom" : "top",
        toSide: dy >= 0 ? "top" : "bottom"
      };
    });
  return { nodes, edges };
}

function canvasRectsOverlap(left: Record<string, unknown>, right: Record<string, unknown>, gap: number): boolean {
  return numberValue(left.x) < numberValue(right.x) + numberValue(right.width) + gap
    && numberValue(left.x) + numberValue(left.width) + gap > numberValue(right.x)
    && numberValue(left.y) < numberValue(right.y) + numberValue(right.height) + gap
    && numberValue(left.y) + numberValue(left.height) + gap > numberValue(right.y);
}

function canvasLayoutColumn(node: Record<string, unknown>): number {
  const group = inferCanvasNodeGroup(node);
  const columns: Record<string, number> = {
    hub: 0,
    task: -1,
    done: -1,
    related: -1,
    data: -1,
    source: 1,
    document: 1,
    section: 2,
    concept: 2,
    evidence: 3,
    question: 4,
    action: 4,
    template: 5
  };
  return columns[group] ?? 5;
}

function inferCanvasNodeGroup(node: Record<string, unknown>): string {
  const id = String(node.id ?? "");
  const color = String(node.color ?? "");
  const text = canvasNodeText(node);
  if (id === "project-hub" || /^chat-adjustment-(?!.*-(?:actions|questions|context)$)/.test(id)) return "hub";
  if (node.type === "file") return "source";
  if (/task|open|todo|任务/.test(id + text)) return "task";
  if (/done|complete|已完成/.test(id + text)) return "done";
  if (/related|关联/.test(id + text)) return "related";
  if (/data|progress|heatmap|统计|进度|看板|热力/.test(id + text)) return "data";
  if (/template|starter|模板|占位/.test(id + text)) return "template";
  if (/document-summary|summary|摘要|资料/.test(id + text)) return "document";
  if (/section|chapter|stage|phase|阶段|章节|模块|流程/.test(id + text)) return "section";
  if (/concept|keyword|topic|概念|主题|关键词/.test(id + text)) return "concept";
  if (/evidence|quote|证据|依据|摘录/.test(id + text)) return "evidence";
  if (/question|risk|blocker|问题|风险|阻塞|待核验/.test(id + text)) return "question";
  if (/action|next|step|行动|下一步/.test(id + text)) return "action";
  const colorGroups: Record<string, string> = {
    "1": "hub",
    "2": "document",
    "3": "action",
    "4": "evidence",
    "5": "concept",
    "6": "question"
  };
  return colorGroups[color] ?? "template";
}

function canvasGroupOrder(group: string): number {
  const order: Record<string, number> = {
    hub: 0,
    document: 1,
    source: 2,
    section: 3,
    concept: 4,
    evidence: 5,
    question: 6,
    action: 7,
    task: 8,
    related: 9,
    done: 10,
    data: 11,
    template: 12
  };
  return order[group] ?? 99;
}

function canvasNodeText(node: Record<string, unknown>): string {
  if (typeof node.text === "string") return node.text;
  if (typeof node.file === "string") return node.file;
  return "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function compactText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}…`;
}

function hasCompleteMultipleChoiceQuestion(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ");
  const hasQuestionStem = mayContainMultipleChoiceQuestion(normalized);
  const optionMarkers = normalized.match(/[A-D]\s*[.．、:：]/gu) ?? [];
  return hasQuestionStem && optionMarkers.length >= 3;
}

function mayContainMultipleChoiceQuestion(text: string): boolean {
  return /这段文字(?:主要|意在|旨在)|下列(?:说法|选项|判断|理解)|根据(?:上述|这段|给定)材料|【\s*练习题\s*】/u.test(text);
}

function findCompleteMultipleChoiceQuestion(selectionText: string, documentText: string): string {
  const stemPattern = /这段文字(?:主要|意在|旨在)|下列(?:说法|选项|判断|理解)|根据(?:上述|这段|给定)材料/u;
  const stemMatch = selectionText.match(stemPattern);
  let stemIndex = stemMatch ? documentText.indexOf(stemMatch[0]) : -1;
  if (stemIndex < 0 && /【\s*练习题\s*】/u.test(selectionText)) {
    const selectionStart = selectionText.trim().slice(0, 48);
    const selectionIndex = selectionStart ? documentText.indexOf(selectionStart) : -1;
    const nearbyQuestion = selectionIndex >= 0
      ? stemPattern.exec(documentText.slice(selectionIndex, selectionIndex + 4_800))
      : null;
    if (nearbyQuestion && selectionIndex >= 0) stemIndex = selectionIndex + nearbyQuestion.index;
  }
  if (stemIndex < 0) return "";
  const sourceAfterStem = documentText.slice(stemIndex);
  const lastOptionMatch = /D\s*[.．、:：]/u.exec(sourceAfterStem);
  if (!lastOptionMatch) return "";
  const nextQuestionMatch = /\s+\d{1,3}\s*[.．、]/u.exec(sourceAfterStem.slice(lastOptionMatch.index + lastOptionMatch[0].length));
  const end = nextQuestionMatch
    ? stemIndex + lastOptionMatch.index + lastOptionMatch[0].length + nextQuestionMatch.index
    : Math.min(documentText.length, stemIndex + 3_600);
  const start = Math.max(0, stemIndex - 1_800);
  const completed = documentText.slice(start, end).trim();
  return hasCompleteMultipleChoiceQuestion(completed) ? completed : "";
}

function limitPromptText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n<!-- Life OS: 内容过长，已截断给 AI；请优先保留已有结构并做局部调整。 -->`;
}

function limitStreamingPreviewText(text: string): string {
  const maxChars = 16000;
  const headChars = 6000;
  const tailChars = 9000;
  if (text.length <= maxChars) return text;
  return [
    text.slice(0, headChars),
    "",
    "…中间内容仍在接收，已临时折叠以保持预览流畅…",
    "",
    text.slice(-tailChars)
  ].join("\n");
}

function previewCanvasTitles(canvas: CanvasDocumentLike): string[] {
  return canvas.nodes
    .map((node) => {
      if (!node || typeof node !== "object") return "";
      const data = node as Record<string, unknown>;
      const text = typeof data.text === "string" ? data.text : typeof data.file === "string" ? data.file : String(data.id ?? "");
      return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
    })
    .filter(Boolean);
}
