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
      kind: "reading-selection";
      file: TFile;
      text: string;
      startOffset: number | null;
      endOffset: number | null;
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

export interface AiEditAvoidRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface AiEditAnchor {
  x: number;
  y: number;
  avoidRect?: AiEditAvoidRect;
  placement?: "text-selection" | "canvas";
}

type AiEditTab = "answer" | "edit";
type AnswerDepth = "concise" | "balanced" | "detailed";

const ANSWER_DEPTHS: Array<{ id: AnswerDepth; label: string; instruction: string }> = [
  { id: "concise", label: "简洁", instruction: "用 3-5 个要点直接回答，只保留关键结论。" },
  { id: "balanced", label: "适中", instruction: "先给结论，再给必要解释和可执行步骤。" },
  { id: "detailed", label: "详细", instruction: "系统展开背景、推理、关键细节和行动建议。" }
];

const TEXT_TIMEOUT_MS = 45_000;
const CANVAS_TIMEOUT_MS = 120_000;

export class AiEditPopoverController {
  private popoverEl: HTMLElement | null = null;
  private target: AiEditTarget | null = null;
  private anchor: AiEditAnchor = { x: 0, y: 0 };
  private activeTab: AiEditTab = "answer";
  private answerDepth: AnswerDepth = "balanced";
  private commandInput: HTMLTextAreaElement | null = null;
  private previewEl: HTMLElement | null = null;
  private primaryButton: HTMLButtonElement | null = null;
  private applyButton: HTMLButtonElement | null = null;
  private cancelButton: HTMLButtonElement | null = null;
  private previewText = "";
  private streamText = "";
  private generating = false;
  private panelMode = false;
  private abortController: AbortController | null = null;
  private timeoutTimer: number | null = null;
  private renderFrame: number | null = null;
  private generationId = 0;
  private importedAiSkills: AiSkill[] = [];
  private selectedSkillIds: string[] = ["lifeos-general"];
  private answerHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
  private editHistory: Array<{ instruction: string; preview: string }> = [];
  private outsidePointerHandler: ((event: MouseEvent) => void) | null = null;
  private keyHandler: ((event: KeyboardEvent) => void) | null = null;
  private viewportHandler: (() => void) | null = null;

  constructor(
    private app: App,
    private plugin: PersonalLifeSystemPlugin
  ) {}

  open(target: AiEditTarget, anchor: AiEditAnchor): void {
    this.removeUi(true);
    this.target = target;
    this.anchor = anchor;
    this.activeTab = "answer";
    this.answerDepth = "balanced";
    this.previewText = "";
    this.streamText = "";
    this.answerHistory = [];
    this.editHistory = [];
    this.panelMode = false;
    this.importedAiSkills = createImportedAiSkills(this.plugin.settings.importedAiSkills);
    this.selectedSkillIds = normalizeAiSkillIds(
      this.plugin.settings.defaultAiSkillIds,
      this.plugin.settings.defaultAiSkillId,
      this.importedAiSkills
    );
    this.render(document.body, false);
  }

  close(): void {
    this.removeUi(true);
  }

  mountToPanel(containerEl: HTMLElement): void {
    const currentTarget = this.target;
    this.removeUi(false);
    this.panelMode = true;
    containerEl.empty();
    if (!currentTarget) {
      containerEl.createDiv({
        cls: "lifeos-ai-edit-panel-empty",
        text: "在 Markdown 中选中一段文字，或从文件菜单选择 AI 修改文档。"
      });
      return;
    }
    this.target = currentTarget;
    this.render(containerEl, true);
  }

  unmountFromPanel(): void {
    this.removeUi(true);
  }

  private render(container: HTMLElement, panelMode: boolean): void {
    const target = this.target;
    if (!target) return;
    this.panelMode = panelMode;

    const popover = container.createDiv({ cls: "lifeos-ai-edit-popover" });
    if (panelMode) popover.addClass("is-panel");
    popover.setAttr("role", "dialog");
    popover.setAttr("aria-label", "Life OS AI 编辑");
    this.popoverEl = popover;

    const header = popover.createDiv({ cls: "lifeos-ai-edit-popover-header" });
    const icon = header.createSpan({ cls: "lifeos-ai-edit-popover-icon" });
    setIcon(icon, target.kind === "canvas" ? "layout-dashboard" : "sparkles");
    const heading = header.createDiv({ cls: "lifeos-ai-edit-popover-heading" });
    heading.createEl("strong", { text: target.kind === "canvas" ? "AI 调整白板" : "AI 编辑" });
    heading.createSpan({ text: this.describeTarget(target) });

    if (!panelMode) {
      const dock = header.createEl("button", {
        cls: "lifeos-ai-edit-popover-close lifeos-ai-edit-popover-dock",
        attr: { type: "button", "aria-label": "固定到右侧边栏" }
      });
      setIcon(dock, "panel-right");
      dock.onclick = () => void this.plugin.dockAiEditToSidebar();
    }

    const close = header.createEl("button", {
      cls: "lifeos-ai-edit-popover-close",
      attr: { type: "button", "aria-label": panelMode ? "关闭侧边栏" : "关闭" }
    });
    setIcon(close, "x");
    close.onclick = () => {
      if (panelMode) void this.plugin.undockAiEditFromSidebar();
      else this.close();
    };

    const tabs = popover.createDiv({ cls: "lifeos-ai-edit-tab-bar" });
    this.createTab(tabs, "answer", "问答");
    this.createTab(tabs, "edit", "编辑");

    const body = popover.createDiv({ cls: "lifeos-ai-edit-popover-body" });
    body.createDiv({ cls: "lifeos-ai-edit-context", text: this.contextLine(target) });
    this.renderSkillPicker(body);
    if (this.activeTab === "answer") this.renderAnswerDepth(body);

    this.commandInput = body.createEl("textarea", {
      cls: "lifeos-ai-edit-command",
      attr: {
        placeholder: this.activeTab === "answer"
          ? "输入关于选区的问题；留空则直接解释选区"
          : "输入修改要求，例如：润色、精简、改成更专业的表达"
      }
    });
    this.commandInput.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void this.runActiveAction();
      }
    });

    if (this.activeTab === "edit" && this.editHistory.length > 0) {
      const history = body.createDiv({ cls: "lifeos-ai-edit-history" });
      this.editHistory.forEach((entry, index) => {
        const row = history.createDiv({ cls: "lifeos-ai-edit-history-item" });
        row.createSpan({ cls: "lifeos-ai-edit-history-num", text: String(index + 1) });
        row.createSpan({ cls: "lifeos-ai-edit-history-text", text: entry.instruction });
      });
      const undo = history.createEl("button", {
        cls: "lifeos-ai-edit-history-undo",
        text: "回退上一轮",
        attr: { type: "button" }
      });
      undo.onclick = () => this.undoLastEdit();
    }

    this.previewEl = body.createDiv({ cls: "lifeos-ai-edit-preview is-empty" });
    if (this.previewText) {
      this.renderPreview(this.previewText, this.activeTab === "answer");
    } else {
      this.previewEl.setText(this.activeTab === "answer"
        ? "浮窗已就绪。点击“回答选区”开始分析。"
        : "输入修改要求后生成预览，确认后才会写回文件。"
      );
    }

    const actions = popover.createDiv({ cls: "lifeos-ai-edit-actions" });
    this.cancelButton = actions.createEl("button", {
      cls: "lifeos-ai-edit-action lifeos-ai-edit-action-ghost",
      text: "取消",
      attr: { type: "button" }
    });
    this.cancelButton.onclick = () => {
      if (this.generating) this.stopGeneration("已停止生成。");
      else if (panelMode) void this.plugin.undockAiEditFromSidebar();
      else this.close();
    };

    this.primaryButton = actions.createEl("button", {
      cls: "lifeos-ai-edit-action",
      text: this.activeTab === "answer" ? "回答选区" : this.editHistory.length ? "继续修改" : "生成预览",
      attr: { type: "button" }
    });
    this.primaryButton.onclick = () => void this.runActiveAction();

    if (this.activeTab === "edit") {
      this.applyButton = actions.createEl("button", {
        cls: "lifeos-ai-edit-action lifeos-ai-edit-action-primary",
        text: "应用修改",
        attr: { type: "button" }
      });
      this.applyButton.onclick = () => void this.applyPreview();
      this.applyButton.toggleAttribute("disabled", !this.previewText);
    } else {
      this.applyButton = null;
    }

    if (!panelMode) {
      this.placePopover();
      this.registerDismissHandlers();
    }
    window.setTimeout(() => this.commandInput?.focus(), 30);
  }

  private createTab(parent: HTMLElement, tab: AiEditTab, label: string): void {
    const button = parent.createEl("button", {
      cls: this.activeTab === tab ? "lifeos-ai-edit-tab is-active" : "lifeos-ai-edit-tab",
      text: label,
      attr: { type: "button" }
    });
    button.onclick = () => {
      if (this.generating || this.activeTab === tab || !this.popoverEl) return;
      this.activeTab = tab;
      this.previewText = "";
      const container = this.popoverEl.parentElement ?? document.body;
      this.popoverEl.remove();
      this.render(container, this.panelMode);
    };
  }

  private renderAnswerDepth(parent: HTMLElement): void {
    const toolbar = parent.createDiv({ cls: "lifeos-ai-edit-answer-toolbar" });
    toolbar.createSpan({ cls: "lifeos-ai-edit-answer-copy", text: "回答深度" });
    const modes = toolbar.createDiv({ cls: "lifeos-ai-edit-answer-modes" });
    for (const mode of ANSWER_DEPTHS) {
      const button = modes.createEl("button", {
        cls: this.answerDepth === mode.id ? "lifeos-ai-edit-answer-mode is-active" : "lifeos-ai-edit-answer-mode",
        text: mode.label,
        attr: { type: "button" }
      });
      button.onclick = () => {
        if (this.generating) return;
        this.answerDepth = mode.id;
        modes.querySelectorAll("button").forEach((item) => item.removeClass("is-active"));
        button.addClass("is-active");
      };
    }
  }

  private renderSkillPicker(parent: HTMLElement): void {
    const selected = getAiSkills(this.selectedSkillIds, this.importedAiSkills);
    const details = parent.createEl("details", { cls: "lifeos-ai-edit-skill-panel" });
    const summary = details.createEl("summary", { cls: "lifeos-ai-edit-skill-summary" });
    summary.createSpan({ cls: "lifeos-ai-edit-skill-label", text: "Skill" });
    summary.createSpan({
      cls: "lifeos-ai-edit-skill-current",
      text: selected.map((skill) => skill.name).slice(0, 3).join(" + ") || "Life OS 总管"
    });
    const groups = details.createDiv({ cls: "lifeos-ai-edit-skill-groups" });
    for (const category of getAiSkillCategories(this.plugin.settings.customAiSkillCategories)) {
      const skills = getAiSkillsByCategory(category.id, this.importedAiSkills);
      if (!skills.length) continue;
      const group = groups.createDiv({ cls: "lifeos-ai-edit-skill-category" });
      group.createDiv({ cls: "lifeos-ai-edit-skill-category-head", text: category.label });
      const list = group.createDiv({ cls: "lifeos-ai-edit-skill-list" });
      for (const skill of skills) {
        const chip = list.createEl("button", {
          cls: this.selectedSkillIds.includes(skill.id)
            ? "lifeos-ai-edit-skill-chip is-active"
            : "lifeos-ai-edit-skill-chip",
          text: skill.name,
          attr: { type: "button", title: skill.description }
        });
        chip.onclick = () => {
          const next = new Set(this.selectedSkillIds);
          if (next.has(skill.id)) next.delete(skill.id);
          else next.add(skill.id);
          this.selectedSkillIds = normalizeAiSkillIds(Array.from(next), undefined, this.importedAiSkills);
          const container = this.popoverEl?.parentElement;
          if (container && this.popoverEl) {
            this.popoverEl.remove();
            this.render(container, this.panelMode);
          }
        };
      }
    }
  }

  private async runActiveAction(): Promise<void> {
    if (this.activeTab === "answer") await this.generateAnswer();
    else await this.generateEdit();
  }

  private async generateAnswer(): Promise<void> {
    const target = this.target;
    if (!target || this.generating || !this.previewEl) return;
    if (!requireProFeature(this.plugin, "aiDocumentEdit")) return;
    const question = this.commandInput?.value.trim() || "请解释当前选区的核心含义，并给出必要的判断和建议。";
    const depth = ANSWER_DEPTHS.find((item) => item.id === this.answerDepth) ?? ANSWER_DEPTHS[1];
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      {
        role: "system",
        content: [
          "你是 Life OS 的选区问答助手。严格围绕用户当前选中的内容回答。",
          "先给直接答案，再展开必要论证，最后给可执行建议。",
          depth.instruction,
          "使用 Markdown。不要声称已经修改文件；写回必须切换到编辑模式并由用户确认。",
          this.selectedSkillPrompt()
        ].join("\n\n")
      },
      ...this.answerHistory.slice(-8),
      { role: "user", content: this.targetPrompt(target, question) }
    ];
    await this.runGeneration("answer", messages, "text", (text) => {
      this.answerHistory.push({ role: "user", content: question });
      this.answerHistory.push({ role: "assistant", content: text });
      this.answerHistory = this.answerHistory.slice(-10);
      if (this.commandInput) this.commandInput.value = "";
    });
  }

  private async generateEdit(): Promise<void> {
    const target = this.target;
    if (!target || this.generating || !this.previewEl || !this.commandInput) return;
    const instruction = this.commandInput.value.trim();
    if (!instruction) {
      new Notice("请先输入修改要求。");
      this.commandInput.focus();
      return;
    }
    if (!requireProFeature(this.plugin, "aiDocumentEdit")) return;
    const sourceText = this.editHistory.length
      ? this.editHistory[this.editHistory.length - 1].preview
      : target.text;
    const responseFormat = target.kind === "canvas" ? "json" : "text";
    const system = target.kind === "canvas"
      ? "你是 Obsidian Canvas 编辑助手。只输出完整合法的 .canvas JSON，必须包含 nodes 和 edges 数组，不要解释或代码围栏。"
      : isTextSelectionTarget(target)
        ? "你是文本编辑助手。只输出修改后的选中文本，不要解释、标题、代码围栏或 AI 署名。"
        : "你是 Markdown 文档编辑助手。只输出完整修改后的 Markdown，不要解释、代码围栏或 AI 署名。";
    const messages = [
      {
        role: "system" as const,
        content: [system, this.selectedSkillPrompt(), "Skill 只决定思考角度和表达取舍，不能改变输出格式。"].join("\n\n")
      },
      {
        role: "user" as const,
        content: [
          `修改要求：${instruction}`,
          `目标文件：${normalizePath(target.file.path)}`,
          target.kind === "canvas" && target.nodeHint ? `当前节点提示：${target.nodeHint}` : "",
          "当前内容：",
          limitText(sourceText, target.kind === "canvas" ? 120_000 : 40_000)
        ].filter(Boolean).join("\n\n")
      }
    ];
    await this.runGeneration("edit", messages, responseFormat, (text) => {
      const normalized = target.kind === "canvas" ? normalizeCanvasJson(text) : cleanAiText(text);
      this.previewText = normalized;
      this.editHistory.push({ instruction, preview: normalized });
      this.editHistory = this.editHistory.slice(-10);
      if (this.commandInput) this.commandInput.value = "";
      this.renderPreview(normalized, false);
      this.applyButton?.removeAttribute("disabled");
    });
  }

  private async runGeneration(
    kind: AiEditTab,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    responseFormat: "text" | "json",
    onComplete: (text: string) => void
  ): Promise<void> {
    if (!this.previewEl) return;
    this.generating = true;
    this.streamText = "";
    this.previewText = "";
    const requestId = ++this.generationId;
    const controller = new AbortController();
    this.abortController = controller;
    this.syncButtons(kind === "answer" ? "回答中..." : "生成中...");
    this.previewEl.empty();
    this.previewEl.removeClass("is-empty", "is-error");
    this.previewEl.addClass("is-streaming");
    this.previewEl.setText("正在连接模型...");
    const timeoutMs = this.target?.kind === "canvas" ? CANVAS_TIMEOUT_MS : TEXT_TIMEOUT_MS;
    this.timeoutTimer = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      let completed = "";
      const result = await this.plugin.ai.completeStream({
        messages,
        responseFormat,
        temperature: 0.2,
        reasoningEffort: "default"
      }, {
        onToken: (token) => {
          if (!this.isCurrent(requestId, controller)) return;
          this.streamText += token;
          this.scheduleStreamRender(kind === "answer");
        },
        onDone: (text) => { completed = text; },
        onError: (error) => this.setError(error || "AI 请求失败。"),
        onAbort: () => this.setError("生成已停止。")
      }, controller.signal);
      if (!this.isCurrent(requestId, controller)) return;
      const text = (result.text || completed || this.streamText).trim();
      if (!result.ok || !text) throw new Error(result.error || "AI 没有返回可用内容。");
      if (kind === "answer") {
        const cleaned = cleanAiText(text);
        this.previewText = cleaned;
        this.renderPreview(cleaned, true);
        onComplete(cleaned);
      } else {
        onComplete(text);
      }
    } catch (error) {
      if (controller.signal.aborted) this.setError("生成已停止或超时，请缩短要求后重试。");
      else this.setError(error instanceof Error ? error.message : "生成失败。");
    } finally {
      if (this.generationId === requestId) {
        this.clearGenerationState();
        this.syncButtons(kind === "answer" ? "回答选区" : this.editHistory.length ? "继续修改" : "生成预览");
        this.placePopover();
      }
    }
  }

  private async applyPreview(): Promise<void> {
    const target = this.target;
    if (!target || !this.previewText) return;
    if (!requireProFeature(this.plugin, "aiWriteback")) return;
    try {
      if (target.kind === "selection") {
        const current = target.editor.getRange(target.from, target.to);
        if (current !== target.text) {
          new Notice("选区内容已经变化，请重新选择后再应用。");
          return;
        }
        target.editor.replaceRange(this.previewText, target.from, target.to);
      } else if (target.kind === "reading-selection") {
        if (target.startOffset === null || target.endOffset === null) {
          new Notice("阅读模式中的这段文字无法唯一定位。请切换到编辑模式后重新选择再写回。");
          return;
        }
        const currentDocument = await this.app.vault.read(target.file);
        if (currentDocument.slice(target.startOffset, target.endOffset) !== target.text) {
          new Notice("原文内容已经变化，请重新选择后再应用。");
          return;
        }
        const nextDocument = currentDocument.slice(0, target.startOffset)
          + this.previewText
          + currentDocument.slice(target.endOffset);
        await this.app.vault.modify(target.file, nextDocument);
      } else {
        await this.app.vault.modify(target.file, this.previewText);
      }
      new Notice(target.kind === "canvas" ? "Canvas 已更新" : "内容已按预览更新");
      this.close();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "应用修改失败。");
    }
  }

  private undoLastEdit(): void {
    if (!this.editHistory.length) return;
    this.editHistory.pop();
    this.previewText = this.editHistory.at(-1)?.preview ?? "";
    const container = this.popoverEl?.parentElement;
    if (container && this.popoverEl) {
      this.popoverEl.remove();
      this.render(container, this.panelMode);
    }
  }

  private selectedSkillPrompt(): string {
    return composeAiSkillPrompt(
      this.selectedSkillIds,
      this.plugin.settings.defaultAiSkillId,
      this.importedAiSkills,
      this.plugin.settings.customAiSkillCategories
    );
  }

  private targetPrompt(target: AiEditTarget, question: string): string {
    return [
      `用户问题：${question}`,
      `目标文件：${normalizePath(target.file.path)}`,
      target.kind === "canvas" && target.nodeHint ? `当前节点提示：${target.nodeHint}` : "",
      isTextSelectionTarget(target) ? "当前选区：" : target.kind === "canvas" ? "当前 Canvas JSON：" : "当前文档：",
      limitText(target.text, target.kind === "canvas" ? 120_000 : 40_000)
    ].filter(Boolean).join("\n\n");
  }

  private renderPreview(text: string, answer: boolean): void {
    if (!this.previewEl) return;
    this.previewEl.empty();
    this.previewEl.removeClass("is-empty", "is-error", "is-streaming", "is-answer");
    if (answer) this.previewEl.addClass("is-answer");
    if (this.target?.kind === "canvas" && !answer) {
      try {
        const canvas = JSON.parse(text) as { nodes?: unknown[]; edges?: unknown[] };
        this.previewEl.createEl("strong", {
          text: `可写回 Canvas：${canvas.nodes?.length ?? 0} 个节点 / ${canvas.edges?.length ?? 0} 条连接`
        });
        this.previewEl.createEl("pre", { text: text.slice(0, 2400) });
      } catch {
        this.previewEl.setText(text);
      }
    } else {
      renderMarkdownDisplay(this.app, this.plugin, this.previewEl, text, this.target?.file.path ?? "");
    }
  }

  private scheduleStreamRender(answer: boolean): void {
    if (this.renderFrame !== null) return;
    this.renderFrame = window.requestAnimationFrame(() => {
      this.renderFrame = null;
      if (!this.previewEl || !this.streamText.trim()) return;
      this.renderPreview(limitText(this.streamText, 16_000), answer);
      this.previewEl.addClass("is-streaming");
      this.previewEl.scrollTop = this.previewEl.scrollHeight;
      this.placePopover();
    });
  }

  private setError(message: string): void {
    if (!this.previewEl) return;
    this.previewEl.empty();
    this.previewEl.removeClass("is-empty", "is-streaming", "is-answer");
    this.previewEl.addClass("is-error");
    this.previewEl.setText(message);
  }

  private stopGeneration(message: string): void {
    this.abortController?.abort();
    this.generationId += 1;
    this.clearGenerationState();
    this.setError(message);
    this.syncButtons(this.activeTab === "answer" ? "回答选区" : "重新生成");
  }

  private clearGenerationState(): void {
    this.generating = false;
    if (this.timeoutTimer !== null) window.clearTimeout(this.timeoutTimer);
    if (this.renderFrame !== null) window.cancelAnimationFrame(this.renderFrame);
    this.timeoutTimer = null;
    this.renderFrame = null;
    this.abortController = null;
    this.streamText = "";
  }

  private syncButtons(primaryLabel: string): void {
    this.primaryButton?.setText(primaryLabel);
    this.primaryButton?.toggleAttribute("disabled", this.generating);
    this.applyButton?.toggleAttribute("disabled", this.generating || !this.previewText);
    this.cancelButton?.setText(this.generating ? "停止生成" : "取消");
  }

  private isCurrent(requestId: number, controller: AbortController): boolean {
    return this.generationId === requestId && this.abortController === controller && !controller.signal.aborted;
  }

  private describeTarget(target: AiEditTarget): string {
    if (isTextSelectionTarget(target)) return `${target.file.basename} · 选中文本`;
    if (target.kind === "canvas") return `${target.file.basename} · Canvas`;
    return `${target.file.basename} · Markdown`;
  }

  private contextLine(target: AiEditTarget): string {
    if (target.kind === "selection") return `当前选区 ${target.text.trim().length} 个字符；确认后只替换这段文字。`;
    if (target.kind === "reading-selection") {
      return target.startOffset === null
        ? `阅读模式选区 ${target.text.trim().length} 个字符；可以问答，写回前需切换编辑模式重新选择。`
        : `阅读模式选区 ${target.text.trim().length} 个字符；已唯一定位，确认后只替换这段文字。`;
    }
    if (target.kind === "canvas") return "生成完整 Canvas JSON 预览；确认后才覆盖白板文件。";
    return "生成完整 Markdown 预览；确认后才覆盖当前文档。";
  }

  private placePopover(): void {
    if (!this.popoverEl || this.panelMode) return;
    const element = this.popoverEl;
    window.requestAnimationFrame(() => {
      if (!this.popoverEl) return;
      const viewport = window.visualViewport;
      const leftEdge = viewport?.offsetLeft ?? 0;
      const topEdge = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const margin = 14;
      const gap = 10;
      element.style.maxHeight = `${Math.max(280, height - margin * 2)}px`;
      const rect = element.getBoundingClientRect();
      const avoid = this.anchor.avoidRect;
      const candidates = avoid
        ? [
            { left: avoid.right + gap, top: avoid.top },
            { left: avoid.left, top: avoid.bottom + gap },
            { left: avoid.left - rect.width - gap, top: avoid.top }
          ]
        : [
            { left: this.anchor.x + gap, top: this.anchor.y + gap },
            { left: this.anchor.x - rect.width - gap, top: this.anchor.y + gap }
          ];
      const maxLeft = leftEdge + width - rect.width - margin;
      const maxTop = topEdge + height - rect.height - margin;
      const chosen = candidates.find((item) => item.left >= leftEdge + margin && item.left <= maxLeft) ?? candidates[0];
      const left = Math.max(leftEdge + margin, Math.min(chosen.left, Math.max(leftEdge + margin, maxLeft)));
      const top = Math.max(topEdge + margin, Math.min(chosen.top, Math.max(topEdge + margin, maxTop)));
      element.style.left = `${Math.round(left)}px`;
      element.style.top = `${Math.round(top)}px`;
      element.addClass("is-positioned");
    });
  }

  private registerDismissHandlers(): void {
    this.unregisterDismissHandlers();
    this.outsidePointerHandler = (event) => {
      const node = event.target;
      if (this.popoverEl && node instanceof Node && !this.popoverEl.contains(node)) this.close();
    };
    this.keyHandler = (event) => {
      if (event.key === "Escape") this.close();
    };
    this.viewportHandler = () => this.placePopover();
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
    if (this.outsidePointerHandler) document.removeEventListener("mousedown", this.outsidePointerHandler, true);
    if (this.keyHandler) document.removeEventListener("keydown", this.keyHandler, true);
    if (this.viewportHandler) {
      window.removeEventListener("resize", this.viewportHandler);
      window.visualViewport?.removeEventListener("resize", this.viewportHandler);
      window.visualViewport?.removeEventListener("scroll", this.viewportHandler);
    }
    this.outsidePointerHandler = null;
    this.keyHandler = null;
    this.viewportHandler = null;
  }

  private removeUi(clearTarget: boolean): void {
    this.abortController?.abort();
    this.clearGenerationState();
    this.unregisterDismissHandlers();
    this.popoverEl?.remove();
    this.popoverEl = null;
    this.commandInput = null;
    this.previewEl = null;
    this.primaryButton = null;
    this.applyButton = null;
    this.cancelButton = null;
    if (clearTarget) {
      this.target = null;
      this.previewText = "";
      this.answerHistory = [];
      this.editHistory = [];
      this.importedAiSkills = [];
      this.panelMode = false;
    }
  }
}

export function cloneEditorPosition(position: EditorPosition): EditorPosition {
  return { line: position.line, ch: position.ch };
}

export function normalizeCanvasJson(raw: string): string {
  const text = cleanAiText(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? text.slice(start, end + 1) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("AI 返回的内容不是合法 Canvas JSON。");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Canvas JSON 必须是对象。");
  const canvas = parsed as { nodes?: unknown[]; edges?: unknown[] };
  if (!Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) {
    throw new Error("Canvas JSON 必须包含 nodes 和 edges 数组。");
  }
  return JSON.stringify(parsed, null, 2);
}

function isTextSelectionTarget(target: AiEditTarget): target is Extract<AiEditTarget, { kind: "selection" | "reading-selection" }> {
  return target.kind === "selection" || target.kind === "reading-selection";
}

function cleanAiText(raw: string): string {
  return stripCodeFences(raw.replace(/(?:^|\n)\s*AI生成\s*$/u, "").trim()).trim();
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.55);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n\n…中间内容已截断…\n\n${text.slice(-tail)}`;
}
