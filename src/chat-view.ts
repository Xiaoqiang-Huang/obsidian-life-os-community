// Legacy chat view, kept for reference; active implementation is src/views/ChatView.ts.
import {
  ItemView,
  MarkdownRenderer,
  Notice,
  requestUrl,
  TAbstractFile,
  TFile,
  WorkspaceLeaf
} from "obsidian";
import { CHAT_VIEW_TYPE } from "./constants";
import type { IPlugin } from "./plugin-api";
import { buildSystemPrompt, type AiStreamCallbacks } from "./ai";
import { getExamAssistantPrompt, getExamChatModeLabel, getExamProfileLabel, type AssistantStyle, type AssistantVerbosity, type ChatMode } from "./settings";
import { ensureFile, formatDate, formatRelativeTime, makeId, stripCodeFences } from "./utils";
import { openWritebackPreview, type WritebackItem } from "./writeback-preview";
import { buildNoteLinkContext, formatLinkContextForPrompt } from "./link-context";
import { createLifeOsShell } from "./lifeos-shell";

export class ChatView extends ItemView {
  private logEl: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private messages: { role: "user" | "assistant"; content: string; time?: string }[] = [];
  private readonly chatSessionId = makeId("chat");
  private readonly chatSessionDate = formatDate();
  private saveStatusEl: HTMLElement;
  private progressEl: HTMLElement;
  private modeSelect: HTMLSelectElement;
  private styleSelect: HTMLSelectElement;
  private verbositySelect: HTMLSelectElement;
  private lastAssistantContent = "";
  private abortController: AbortController | null = null;
  private isStreaming = false;
  private aiToggleEl: HTMLInputElement;
  private diaryRecordEl: HTMLInputElement;
  private sendBtn: HTMLButtonElement;
  private writebackBtn: HTMLButtonElement;
  private hasAiReplied = false;

  constructor(leaf: WorkspaceLeaf, private plugin: IPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return `${this.plugin.settings.assistantName} Chat`;
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    const shell = container.createDiv({ cls: "pls-chat pls-layout-main" });
    const content = createLifeOsShell(this.app, this.plugin, shell, {
      active: "chat",
      title: `${this.plugin.settings.assistantName} AI 助手`,
      subtitle: "基于你的日记、任务、记忆与复盘内容给出回应",
      showDirectory: true,
      onRefresh: () => this.onOpen()
    });
    const root = content.createDiv({ cls: "pls-chat-panel" });
    const controlsToggle = root.createEl("details", { attr: { open: "open" } });
    controlsToggle.createEl("summary", { text: "对话设置" });
    const controls = controlsToggle.createDiv({ cls: "pls-chat-controls" });
    this.modeSelect = this.createSelect(
      controls,
      "模式",
      [
        ["chat", "对话"],
        ["exam", getExamChatModeLabel(this.plugin.settings)]
      ],
      this.plugin.settings.defaultChatMode === "exam" ? "exam" : "chat"
    ) as HTMLSelectElement;
    this.styleSelect = this.createSelect(
      controls,
      "风格",
      [
        ["warm-companion", "温柔"],
        ["concise-executor", "高效"],
        ["strict-coach", "严格"],
        ["exam-tutor", getExamProfileLabel(this.plugin.settings)],
        ["four-sages", "四圣"],
        ["custom", "自定义"]
      ],
      this.plugin.settings.assistantStyle
    ) as HTMLSelectElement;
    this.verbositySelect = this.createSelect(
      controls,
      "长度",
      [
        ["brief", "简短"],
        ["normal", "标准"],
        ["detailed", "详细"]
      ],
      this.plugin.settings.assistantVerbosity
    ) as HTMLSelectElement;
    this.modeSelect.onchange = () => { void this.saveChatPreference("mode"); this.updateTextareaPlaceholder(); };
    this.styleSelect.onchange = () => void this.saveChatPreference("style");
    this.verbositySelect.onchange = () => void this.saveChatPreference("verbosity");
    this.logEl = root.createDiv({ cls: "pls-chat-log" });
    this.textarea = root.createEl("textarea");
    this.updateTextareaPlaceholder();

    // AI toggle + diary record toggle + button row
    const actionRow = root.createDiv({ cls: "pls-chat-action-row" });

    const aiToggleWrap = actionRow.createDiv({ cls: "pls-chat-toggle" });
    this.aiToggleEl = aiToggleWrap.createEl("input", {
      attr: { type: "checkbox", id: "pls-ai-toggle" }
    }) as HTMLInputElement;
    this.aiToggleEl.onchange = () => this.updateSendButtonAppearance();
    aiToggleWrap.createEl("label", {
      text: "AI 回复",
      attr: { for: "pls-ai-toggle" }
    });

    const diaryToggleWrap = actionRow.createDiv({ cls: "pls-chat-toggle" });
    this.diaryRecordEl = diaryToggleWrap.createEl("input", {
      attr: { type: "checkbox", id: "pls-diary-toggle" }
    }) as HTMLInputElement;
    diaryToggleWrap.createEl("label", {
      text: "记入日记",
      attr: { for: "pls-diary-toggle" }
    });

    const btnRow = actionRow.createDiv({ cls: "pls-button-row" });
    this.sendBtn = btnRow.createEl("button", {
      text: "记录",
      cls: "pls-btn-primary"
    }) as HTMLButtonElement;
    this.sendBtn.onclick = () => {
      if (this.isStreaming) {
        void this.stopGeneration();
      } else {
        void this.send();
      }
    };
    this.writebackBtn = btnRow.createEl("button", {
      text: "应用到今日记录"
    }) as HTMLButtonElement;
    this.writebackBtn.onclick = () => void this.applyLastAssistantToDaily();
    this.updateWritebackButton();
    btnRow.createEl("button", { text: "保存对话" }).onclick = () => void this.saveChat();
    this.saveStatusEl = root.createDiv({ cls: "pls-save-status", text: "" });
    this.progressEl = root.createDiv({ cls: "pls-progress-status", text: "" });
    await this.renderMessages();
    await this.loadExistingChat();
  }

  private createSelect(
    parent: HTMLElement,
    label: string,
    options: Array<[string, string]>,
    value: string
  ): HTMLSelectElement {
    const wrap = parent.createDiv({ cls: "pls-chat-control" });
    wrap.createEl("span", { text: label });
    const select = wrap.createEl("select");
    for (const [optionValue, text] of options) {
      select.createEl("option", { value: optionValue, text });
    }
    select.value = value;
    return select;
  }

  private async saveChatPreference(kind: "mode" | "style" | "verbosity"): Promise<void> {
    if (kind === "mode") {
      this.plugin.settings.defaultChatMode = this.getSelectedMode();
    } else if (kind === "style") {
      this.plugin.settings.assistantStyle = this.getSelectedStyle();
    } else {
      this.plugin.settings.assistantVerbosity = this.getSelectedVerbosity();
    }
    await this.plugin.saveSettings();
  }

  private updateTextareaPlaceholder(): void {
    const mode = this.getSelectedMode();
    this.textarea.placeholder = mode === "exam"
      ? `输入${getExamProfileLabel(this.plugin.settings)}相关问题...`
      : "输入你想讨论的内容...";
  }

  private async stopGeneration(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  private updateSendButtonAppearance(): void {
    if (!this.sendBtn) return;
    if (this.isStreaming) {
      this.sendBtn.textContent = "停止";
      this.sendBtn.removeClass("pls-btn-primary");
      this.sendBtn.addClass("pls-btn-danger");
    } else if (this.aiToggleEl?.checked) {
      this.sendBtn.textContent = "记录并回复";
      this.sendBtn.removeClass("pls-btn-danger");
      this.sendBtn.addClass("pls-btn-primary");
    } else {
      this.sendBtn.textContent = "记录";
      this.sendBtn.removeClass("pls-btn-danger");
      this.sendBtn.addClass("pls-btn-primary");
    }
  }

  private updateWritebackButton(): void {
    if (!this.writebackBtn) return;
    if (this.hasAiReplied) {
      this.writebackBtn.disabled = false;
      this.writebackBtn.style.opacity = "";
    } else {
      this.writebackBtn.disabled = true;
      this.writebackBtn.style.opacity = "0.4";
    }
  }

  private getChatFilePath(): string {
    const time = new Date().toTimeString().slice(0, 5).replace(":", "");
    return this.plugin.path("Chat", `${this.chatSessionDate}-${time}.md`);
  }

  private async loadExistingChat(): Promise<void> {
    if (this.messages.length > 0) {
      return;
    }
    const chatFolder = this.plugin.path("Chat");
    const prefix = chatFolder.endsWith("/") ? chatFolder : chatFolder + "/";
    const chatFiles = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(prefix));
    if (chatFiles.length > 0) {
      const todayFiles = chatFiles.filter(f => f.path.includes(this.chatSessionDate));
      if (todayFiles.length > 0) {
        const latestFile = todayFiles.sort((a, b) => b.path.localeCompare(a.path))[0];
        try {
          const content = await this.app.vault.read(latestFile);
          const lines = content.split("\n");
          let currentRole: "user" | "assistant" | null = null;
          let currentContent: string[] = [];

          for (const line of lines) {
            if (line.startsWith("## 我")) {
              if (currentRole && currentContent.length > 0) {
                this.messages.push({ role: currentRole, content: currentContent.join("\n").trim() });
              }
              currentRole = "user";
              currentContent = [];
            } else if (line.startsWith(`## ${this.plugin.settings.assistantName}`)) {
              if (currentRole && currentContent.length > 0) {
                this.messages.push({ role: currentRole, content: currentContent.join("\n").trim() });
              }
              currentRole = "assistant";
              currentContent = [];
            } else if (currentRole && !line.startsWith("---") && !line.startsWith("# ") && line.trim()) {
              currentContent.push(line);
            }
          }
          if (currentRole && currentContent.length > 0) {
            this.messages.push({ role: currentRole, content: currentContent.join("\n").trim() });
          }
          await this.renderMessages();
        } catch {
          // If loading fails, just start fresh
        }
      }
    }
  }

  private buildChatContent(): string {
    const dailyNotePath = this.plugin.getTodayNotePath();
    const saveMode = this.plugin.settings.chatSaveMode;

    let body: string;
    if (saveMode === "summary" && this.lastAssistantContent) {
      body = `## ${this.plugin.settings.assistantName} 摘要\n\n${this.normalizeAiMarkdown(this.lastAssistantContent)}`;
    } else {
      body = this.messages
        .map(
          (message) =>
            `## ${message.role === "user" ? "我" : this.plugin.settings.assistantName}\n\n${
              message.role === "assistant" ? this.normalizeAiMarkdown(message.content) : message.content
            }`
        )
        .join("\n\n");
    }
    return `---
type: chat
mode: ${this.plugin.settings.chatSaveMode}
date: ${this.chatSessionDate}
session: ${this.chatSessionId}
provider: ${this.plugin.settings.aiProvider}
model: ${this.plugin.settings.aiModel}
daily_note: ${dailyNotePath}
---

# ${this.plugin.settings.assistantName} Chat

> 对话日期：${this.chatSessionDate}
> 关联日记：[${dailyNotePath}](${dailyNotePath})

---

${body}

---

*保存时间：${new Date().toISOString()}*
*日记版本：v2.0*
`;
  }

  private async persistChat(showNotice = false): Promise<void> {
    if (this.plugin.settings.chatSaveMode === "none") {
      this.updateSaveStatus("聊天历史未保存（设置中已禁用）");
      if (showNotice) {
        new Notice("当前设置为不保存 Chat 历史。");
      }
      return;
    }
    if (this.messages.length === 0) {
      this.updateSaveStatus("暂无对话可保存");
      if (showNotice) {
        new Notice("当前没有可保存的对话。");
      }
      return;
    }

    const filePath = this.getChatFilePath();
    const content = this.buildChatContent();
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await ensureFile(this.app, filePath, content);
    }

    this.updateSaveStatus("✓ 已保存到 " + filePath.split("/").pop());
    if (showNotice) {
      new Notice("Chat 已保存。");
    }
  }

  private updateSaveStatus(text: string): void {
    if (this.saveStatusEl) {
      this.saveStatusEl.textContent = text;
      setTimeout(() => {
        if (this.saveStatusEl && this.saveStatusEl.textContent === text) {
          this.saveStatusEl.textContent = "";
        }
      }, 3000);
    }
  }

  private updateProgress(text: string): void {
    if (this.progressEl) {
      this.progressEl.textContent = text;
    }
  }

  private normalizeAiMarkdown(text: string): string {
    const trimmed = text.trim();
    const markdownFence = trimmed.match(/```(?:markdown|md)\s*([\s\S]*?)\s*```/i);
    if (markdownFence) {
      return markdownFence[1].trim();
    }
    const anyFence = trimmed.match(/^```\w*\s*([\s\S]*?)\s*```$/i);
    if (anyFence) {
      return anyFence[1].trim();
    }
    return stripCodeFences(trimmed);
  }

  private async appendToDailyNote(title: string, content: string, source?: string): Promise<void> {
    const file = await this.getWritableDailyFile();
    const timestamp = new Date().toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit"
    });
    const sourceLine = source ? `\n> 来源：${source}` : "";
    const block = `\n\n---\n\n## ${timestamp} ${title}${sourceLine}\n\n${content.trim()}\n`;
    await this.app.vault.append(file, block);
  }

  private async getWritableDailyFile(): Promise<TFile> {
    return this.plugin.ensureTodayNote(false);
  }

  private getHeadingInfo(line: string): { level: number; title: string } | null {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) {
      return null;
    }
    return { level: match[1].length, title: match[2].trim() };
  }

  private sectionTitleMatches(title: string, aliases: string[]): boolean {
    return aliases.some((alias) => title.includes(alias) || alias.includes(title));
  }

  private extractMarkdownSection(markdown: string, aliases: string[]): string {
    const lines = markdown.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const heading = this.getHeadingInfo(lines[index]);
      if (!heading || !this.sectionTitleMatches(heading.title, aliases)) {
        continue;
      }

      let end = lines.length;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const next = this.getHeadingInfo(lines[cursor]);
        if (next && next.level <= heading.level) {
          end = cursor;
          break;
        }
      }
      return lines.slice(index + 1, end).join("\n").trim();
    }
    return "";
  }

  private appendToMarkdownSection(
    markdown: string,
    aliases: string[],
    content: string,
    fallbackTitle: string
  ): string {
    const cleanContent = content.trim();
    if (!cleanContent) {
      return markdown;
    }

    const lines = markdown.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const heading = this.getHeadingInfo(lines[index]);
      if (!heading || !this.sectionTitleMatches(heading.title, aliases)) {
        continue;
      }

      let end = lines.length;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const next = this.getHeadingInfo(lines[cursor]);
        if (next && next.level <= heading.level) {
          end = cursor;
          break;
        }
      }

      // Append new content after existing content, before next heading
      const nextLines = [
        ...lines.slice(0, end),
        "",
        cleanContent,
        "",
        ...lines.slice(end)
      ];
      return nextLines.join("\n").replace(/\n{4,}/g, "\n\n\n");
    }

    // Section not found — create at end
    return `${markdown.trimEnd()}\n\n## ${fallbackTitle}\n\n${cleanContent}\n`;
  }

  private async applyDailyNoteSections(markdown: string, file: TFile): Promise<boolean> {
    const cleanMarkdown = markdown.trim();
    if (!cleanMarkdown) {
      return false;
    }

    const sections = [
      {
        aliases: ["今日要事"],
        fallbackTitle: "今日要事",
        content: this.extractMarkdownSection(markdown, ["今日要事"])
      },
      {
        aliases: ["一句话总结"],
        fallbackTitle: "一句话总结",
        content: this.extractMarkdownSection(markdown, ["一句话总结"])
      },
      {
        aliases: ["待办", "待办延续"],
        fallbackTitle: "待办",
        content:
          this.extractMarkdownSection(markdown, ["待办延续"]) ||
          this.extractMarkdownSection(markdown, ["待办"])
      },
      {
        aliases: ["深度思考"],
        fallbackTitle: "深度思考",
        content: this.extractMarkdownSection(markdown, ["深度思考"])
      },
      {
        aliases: ["AI 分析", "AI分析"],
        fallbackTitle: "AI 分析",
        content:
          this.extractMarkdownSection(markdown, ["AI 分析"]) ||
          this.extractMarkdownSection(markdown, ["AI分析"])
      },
      {
        aliases: ["明日计划"],
        fallbackTitle: "明日计划",
        content: this.extractMarkdownSection(markdown, ["明日计划"])
      }
    ];

    let content = await this.app.vault.read(file);
    if (!sections.some((section) => section.content.trim())) {
      const nextContent = this.appendToMarkdownSection(content, ["AI 分析", "AI分析"], cleanMarkdown, "AI 分析");
      await this.app.vault.modify(file, nextContent);
      return true;
    }

    for (const section of sections) {
      content = this.appendToMarkdownSection(
        content,
        section.aliases,
        section.content,
        section.fallbackTitle
      );
    }
    await this.app.vault.modify(file, content);
    return true;
  }

  private async renderMessages(): Promise<void> {
    this.logEl.empty();
    if (this.messages.length === 0) {
      this.logEl.createEl("p", {
        cls: "pls-muted",
        text: "可以基于当前笔记、最近日记和记忆库与小星对话。"
      });
      return;
    }
    for (const message of this.messages) {
      const el = this.logEl.createDiv({
        cls: `pls-message ${message.role === "user" ? "pls-message-user" : ""}`
      });
      const label = message.role === "user" ? "我" : this.plugin.settings.assistantName;
      const timeStr = message.time ? formatRelativeTime(message.time) : "";
      el.createEl("strong", { text: timeStr ? `${label} · ${timeStr}` : label });
      const body = el.createDiv({ cls: "pls-message-body" });
      await MarkdownRenderer.renderMarkdown(
        message.role === "assistant" ? this.normalizeAiMarkdown(message.content) : message.content,
        body,
        this.getChatFilePath(),
        this
      );
    }
  }

  private async send(): Promise<void> {
    const content = this.textarea.value.trim();
    if (!content) return;

    const mode = this.getSelectedMode();
    const wantAi = this.aiToggleEl?.checked ?? false;
    const recordToDiary = this.diaryRecordEl?.checked ?? false;
    this.textarea.value = "";

    // 1. Always record user message in chat log
    this.messages.push({ role: "user", content, time: new Date().toISOString() });
    await this.renderMessages();
    this.logEl.scrollTop = this.logEl.scrollHeight;

    // 2. Record to daily diary if checkbox is checked
    if (recordToDiary) {
      await this.appendUserRecordToDaily(content);
      this.updateSaveStatus("已记录到今日日记");
    } else {
      this.updateSaveStatus("已记录");
    }

    // 3. If AI not requested, stop here
    if (!wantAi) {
      this.hasAiReplied = false;
      this.updateWritebackButton();
      await this.persistChat();
      return;
    }

    // 4. AI is requested — start streaming
    const assistantIndex = this.messages.length;
    this.messages.push({ role: "assistant", content: "", time: new Date().toISOString() });
    await this.renderMessages();

    this.updateProgress("正在整理上下文...");
    let context = await this.buildCleanContext();
    const urlContent = await this.fetchUrlsFromMessage(content);
    if (urlContent) {
      context += "\n\n" + urlContent;
    }
    this.updateProgress("正在请求模型...");

    this.isStreaming = true;
    this.abortController = new AbortController();
    this.updateSendButtonAppearance();

    const lastMsgEl = this.logEl.querySelector(".pls-message:last-child .pls-message-body") as HTMLElement;
    let streamedText = "";

    const response = await this.plugin.ai.completeStream(
      {
        temperature: this.getTemperatureForMode(mode),
        messages: this.buildMessagesForAi(mode, context, content)
      },
      {
        onStart: () => {
          this.updateProgress("正在生成回复...");
          if (lastMsgEl) lastMsgEl.setText("▊");
        },
        onToken: (token) => {
          streamedText += token;
          this.messages[assistantIndex].content = streamedText;
          if (lastMsgEl) lastMsgEl.setText(streamedText + "▊");
          this.logEl.scrollTop = this.logEl.scrollHeight;
        },
        onDone: (text) => {
          streamedText = text;
          this.messages[assistantIndex].content = text;
          this.updateProgress("");
        },
        onError: (error) => {
          this.messages[assistantIndex].content = `AI 请求失败：${error}`;
          this.updateProgress("请求失败");
          this.finishStream();
        },
        onAbort: () => {
          this.messages[assistantIndex].content = streamedText || "（已停止生成）";
          this.updateProgress("已停止");
          this.finishStream();
        }
      },
      this.abortController.signal
    );

    if (response.ok && streamedText) {
      const assistantContent = this.normalizeAiMarkdown(streamedText);
      this.messages[assistantIndex].content = assistantContent;
      this.lastAssistantContent = assistantContent;
      this.hasAiReplied = true;
      await this.renderMessages();
      this.logEl.scrollTop = this.logEl.scrollHeight;

      this.updateSaveStatus("可点击「应用到今日记录」确认写入");
    } else if (!response.ok) {
      this.hasAiReplied = false;
      await this.renderMessages();
    }

    this.finishStream();
    await this.persistChat();
  }

  private finishStream(): void {
    this.isStreaming = false;
    this.abortController = null;
    this.updateSendButtonAppearance();
    this.updateWritebackButton();
    this.updateProgress("");
  }

  private getSelectedMode(): ChatMode {
    return (this.modeSelect?.value || this.plugin.settings.defaultChatMode) as ChatMode;
  }

  private getSelectedStyle(): AssistantStyle {
    return (this.styleSelect?.value || this.plugin.settings.assistantStyle) as AssistantStyle;
  }

  private getSelectedVerbosity(): AssistantVerbosity {
    return (this.verbositySelect?.value || this.plugin.settings.assistantVerbosity) as AssistantVerbosity;
  }

  private buildRuntimeSystemPrompt(): string {
    return buildSystemPrompt({
      ...this.plugin.settings,
      assistantStyle: this.getSelectedStyle(),
      assistantVerbosity: this.getSelectedVerbosity()
    });
  }

  private getTemperatureForMode(mode: ChatMode): number {
    return mode === "exam" ? 0.25 : 0.5;
  }

  private buildUserPrompt(mode: ChatMode, context: string, content: string): string {
    const shared = [
      "请严格输出 Markdown，不要用代码围栏包住整段结果。",
      `上下文：\n${context}`,
      `用户输入：\n${content}`
    ];

    if (mode === "chat") {
      return [
        "你是一个日常对话助手。自然地回应用户，不要强制输出固定结构。",
        "如果用户说到日记/复盘等内容，可以主动问「需要我帮你整理成今日要事/待办吗？」",
        "用户同意后再输出结构化内容。",
        ...shared
      ].join("\n\n");
    }

    // exam mode
    return [
      `你正在做${getExamProfileLabel(this.plugin.settings)}辅导。${getExamAssistantPrompt(this.plugin.settings)}`,
      "输出结构：## 判断、## 问题、## 改进动作、## 下一次练习。",
      ...shared
    ].join("\n\n");
  }

  /**
   * Build the messages array sent to the AI.
   * Includes system prompt, recent conversation history (multi-turn), and the current
   * user message with context. Applies a token budget to keep total length under model limits.
   */
  private buildMessagesForAi(
    mode: ChatMode,
    context: string,
    content: string
  ): { role: "system" | "user" | "assistant"; content: string }[] {
    const systemPrompt = this.buildRuntimeSystemPrompt();
    const userPrompt = this.buildUserPrompt(mode, context, content);

    // Estimate tokens (rough: 1 Chinese char ≈ 1.5 tokens, 1 English word ≈ 1 token)
    const estimateTokens = (text: string): number => Math.ceil(text.length * 0.6);

    const systemTokens = estimateTokens(systemPrompt);
    const currentTokens = estimateTokens(userPrompt);
    const MAX_TOKENS = 14000; // Safe for most models; leave room for response

    const available = Math.max(0, MAX_TOKENS - systemTokens - currentTokens - 800);

    // Collect recent history that fits within budget
    // Exclude the placeholder "正在..." assistant message (last 2 entries in this.messages)
    const historyMessages: { role: "user" | "assistant"; content: string }[] = [];
    let usedTokens = 0;
    const candidatePool = this.messages.slice(0, -2); // Exclude current turn placeholders

    for (let i = candidatePool.length - 1; i >= 0; i -= 1) {
      const msg = candidatePool[i];
      const tokens = estimateTokens(msg.content);
      if (usedTokens + tokens > available) break;
      historyMessages.unshift(msg);
      usedTokens += tokens;
    }

    // Build final messages array
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: systemPrompt }
    ];

    // If there's a clear gap (old history from a different session), add a note
    if (historyMessages.length > 0 && historyMessages.length < candidatePool.length) {
      const skipped = candidatePool.length - historyMessages.length;
      messages.push({
        role: "user",
        content: `（之前有 ${skipped} 条较早的对话因长度限制未纳入本次上下文。）`
      });
    }

    for (const msg of historyMessages) {
      messages.push(msg);
    }

    messages.push({ role: "user", content: userPrompt });

    return messages;
  }

  private async appendUserRecordToDaily(content: string): Promise<void> {
    const file = await this.getWritableDailyFile();
    const timestamp = new Date().toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit"
    });
    const block = `\n\n## ${timestamp} ${this.getUserRecordTitle(content)}\n\n${content.trim()}\n`;
    await this.app.vault.append(file, block);
  }

  private getUserRecordTitle(content: string): string {
    const words = content.slice(0, 20).split(/\s+/).slice(0, 5).join(" ");
    return words.length < content.length ? `${words}...` : content;
  }

  private async buildCleanContext(): Promise<string> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      return "当前没有打开的笔记。";
    }
    const content = await this.app.vault.read(file);

    const lines = content.split("\n");
    const summaryLines: string[] = [];
    const userRecordLines: string[] = [];
    let inUserRecords = false;
    let currentUserRecord: string[] = [];

    for (const line of lines) {
      if (/^##\s*\d{1,2}:\d{2}/.test(line)) {
        inUserRecords = true;
        if (currentUserRecord.length > 0) {
          userRecordLines.push(...currentUserRecord);
        }
        currentUserRecord = [line];
        continue;
      }

      if (inUserRecords) {
        if (line.trim() !== "" || currentUserRecord.length > 1) {
          currentUserRecord.push(line);
        }
      } else {
        summaryLines.push(line);
      }
    }

    if (currentUserRecord.length > 0) {
      userRecordLines.push(...currentUserRecord);
    }

    const summary = summaryLines.join("\n").trim();

    const recordBlocks: string[] = [];
    const records = userRecordLines.join("\n").split(/\n##\s*\d{1,2}:\d{2}/).filter(Boolean);
    const recentRecords = records.slice(-3);

    for (const record of recentRecords) {
      const trimmed = record.trim();
      if (trimmed) {
        const short = trimmed.slice(0, 200);
        recordBlocks.push(short + (trimmed.length > 200 ? "..." : ""));
      }
    }

    const recordsText = recordBlocks.length > 0 ? "\n\n最近记录：\n" + recordBlocks.join("\n\n") : "";
    const summaryText = summary.slice(0, 3000);

    // ── Memory-aware context ──
    const memoryContext = await this.buildMemoryContext();
    const linkContext = await this.buildActiveNoteLinkContext(file, content);

    return `当前笔记：${file.path}\n\n${summaryText}${recordsText}${linkContext}${memoryContext}`;
  }

  private async buildActiveNoteLinkContext(file: TFile, focusText: string): Promise<string> {
    try {
      const linkContext = await buildNoteLinkContext(this.app, file, {
        maxNotes: 8,
        maxCharsPerNote: 450,
        focusText
      });
      return formatLinkContextForPrompt(linkContext);
    } catch {
      return "";
    }
  }

  private async buildMemoryContext(): Promise<string> {
    const parts: string[] = [];

    // Core memory should be small and stable, so it gets first priority.
    try {
      const coreFiles = [
        this.plugin.path("Memory", "Core", "profile.md"),
        this.plugin.path("Memory", "Core", "current-projects.md")
      ];
      const coreParts: string[] = [];
      for (const path of coreFiles) {
        const abstract = this.app.vault.getAbstractFileByPath(path);
        if (abstract instanceof TFile) {
          const content = await this.app.vault.read(abstract);
          coreParts.push(`### ${abstract.basename}\n${content.slice(0, 1200)}`);
        }
      }
      if (coreParts.length > 0) {
        parts.push("核心记忆：\n" + coreParts.join("\n\n"));
      }
    } catch { /* best effort */ }

    // Daily summary is the compressed long-term context for today.
    try {
      const today = formatDate();
      const summaryPath = this.plugin.path("Memory", "Summaries", "Daily", `${today}.md`);
      const summaryAbstract = this.app.vault.getAbstractFileByPath(summaryPath);
      if (summaryAbstract instanceof TFile) {
        const summaryContent = await this.app.vault.read(summaryAbstract);
        parts.push("今日长期摘要：\n" + summaryContent.slice(0, 1000));
      }
    } catch { /* best effort */ }

    // Open todos from Tasks/open.md
    try {
      const tasksPath = this.plugin.path("Tasks", "open.md");
      const tasksAbstract = this.app.vault.getAbstractFileByPath(tasksPath);
      if (tasksAbstract instanceof TFile) {
        const tasksContent = await this.app.vault.read(tasksAbstract);
        const openTasks = tasksContent
          .split("\n")
          .filter((line) => line.trim().startsWith("- [ ]"))
          .slice(0, 10);
        if (openTasks.length > 0) {
          parts.push("未完成待办：\n" + openTasks.join("\n"));
        }
      }
    } catch { /* best effort */ }

    // Recently completed todos
    try {
      const donePath = this.plugin.path("Tasks", "done.md");
      const doneAbstract = this.app.vault.getAbstractFileByPath(donePath);
      if (doneAbstract instanceof TFile) {
        const doneContent = await this.app.vault.read(doneAbstract);
        const recentDone = doneContent
          .split("\n")
          .filter((line) => line.trim().startsWith("- [x]"))
          .slice(-5);
        if (recentDone.length > 0) {
          parts.push("最近完成：\n" + recentDone.join("\n"));
        }
      }
    } catch { /* best effort */ }

    // Today's checkin + streak
    try {
      const today = formatDate();
      const checkinPath = this.plugin.path("Exam", "Checkins", `${today}.md`);
      const checkinAbstract = this.app.vault.getAbstractFileByPath(checkinPath);
      if (checkinAbstract instanceof TFile) {
        const checkinContent = await this.app.vault.read(checkinAbstract);
        parts.push("今日打卡：" + checkinContent.slice(0, 300));
      }
    } catch { /* best effort */ }

    // Active study goals
    try {
      const goalsPath = this.plugin.path("Exam", "Goals");
      const goalsAbstract = this.app.vault.getAbstractFileByPath(goalsPath);
      if (goalsAbstract) {
        const goalsFolder = goalsAbstract as unknown as { children: TAbstractFile[] };
        if (goalsFolder.children) {
          const activeGoals: string[] = [];
          for (const child of goalsFolder.children.slice(0, 5)) {
            if (child instanceof TFile) {
              const goalContent = await this.app.vault.read(child);
              const statusMatch = goalContent.match(/status:\s*(\w+)/);
              if (statusMatch && statusMatch[1] === "active") {
                const titleMatch = goalContent.match(/title:\s*(.+)/);
                const progressMatch = goalContent.match(/current_progress:\s*(\d+)/);
                const targetMatch = goalContent.match(/target:\s*(\d+)/);
                if (titleMatch) {
                  const progress = progressMatch ? parseInt(progressMatch[1]) : 0;
                  const target = targetMatch ? parseInt(targetMatch[1]) : 0;
                  const pct = target > 0 ? Math.round(progress / target * 100) : 0;
                  activeGoals.push(`- ${titleMatch[1]}（进度 ${pct}%，${progress}/${target}）`);
                }
              }
            }
          }
          if (activeGoals.length > 0) {
            parts.push("学习目标：\n" + activeGoals.join("\n"));
          }
        }
      }
    } catch { /* best effort */ }

    // Recent memory items
    try {
      const memoryPath = this.plugin.path("Memory");
      const memoryAbstract = this.app.vault.getAbstractFileByPath(memoryPath);
      if (memoryAbstract) {
        const memoryFolder = memoryAbstract as unknown as { children: TAbstractFile[] };
        if (memoryFolder.children) {
          for (const child of memoryFolder.children.slice(0, 3)) {
            if (child instanceof TFile) {
              const memContent = await this.app.vault.read(child);
              parts.push(`记忆 [${child.basename}]：${memContent.slice(0, 200)}`);
            }
          }
        }
      }
    } catch { /* best effort */ }

    // Recent daily one-liners (last 7 days)
    try {
      const daysBack = this.plugin.settings.recentDaysForChat ?? 7;
      const dailyFiles = this.plugin.listDailyNotes()
        .sort((a, b) => b.name.localeCompare(a.name))
        .slice(0, daysBack);
      for (const df of dailyFiles) {
        const dContent = await this.app.vault.read(df);
        const summaryMatch = dContent.match(/一句话总结\s*\n\s*(今天[：:].+)/);
        if (summaryMatch) {
          parts.push(`${df.basename.slice(0, 10)}：${summaryMatch[1].trim()}`);
        }
      }
    } catch { /* best effort */ }

    // ── Weekly summaries (within last month, older than 7 days) ──
    try {
      const weeklyPath = this.plugin.path("Memory", "Summaries", "Weekly");
      const weeklyAbstract = this.app.vault.getAbstractFileByPath(weeklyPath);
      if (weeklyAbstract) {
        const weeklyFolder = weeklyAbstract as unknown as { children: TAbstractFile[] };
        if (weeklyFolder.children) {
          const oneMonthAgo = new Date();
          oneMonthAgo.setDate(oneMonthAgo.getDate() - 30);
          const weekParts: string[] = [];
          const weeklyFiles = weeklyFolder.children
            .filter((c): c is TFile => c instanceof TFile)
            .sort((a, b) => b.name.localeCompare(a.name));
          for (const wf of weeklyFiles) {
            const wContent = await this.app.vault.read(wf);
            const weekDate = wf.basename.match(/\d{4}-\d{2}-\d{2}/);
            if (weekDate) {
              const d = new Date(weekDate[0]);
              if (d < oneMonthAgo) break; // weekly is sorted descending, older entries are beyond range
            }
            const body = wContent.replace(/^---[\s\S]*?---\n*/, "").trim().slice(0, 500);
            if (body) weekParts.push(`[${wf.basename}] ${body}`);
          }
          if (weekParts.length > 0) {
            parts.push("近一月各周：\n" + weekParts.join("\n\n"));
          }
        }
      }
    } catch { /* best effort */ }

    // ── Monthly summaries (within last year, older than 1 month) ──
    try {
      const monthlyPath = this.plugin.path("Memory", "Summaries", "Monthly");
      const monthlyAbstract = this.app.vault.getAbstractFileByPath(monthlyPath);
      if (monthlyAbstract) {
        const monthlyFolder = monthlyAbstract as unknown as { children: TAbstractFile[] };
        if (monthlyFolder.children) {
          const oneYearAgo = new Date();
          oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
          const monthParts: string[] = [];
          const monthlyFiles = monthlyFolder.children
            .filter((c): c is TFile => c instanceof TFile)
            .sort((a, b) => b.name.localeCompare(a.name));
          for (const mf of monthlyFiles) {
            const mContent = await this.app.vault.read(mf);
            const fileDate = mf.basename.match(/(\d{4})-(\d{2})/);
            if (fileDate) {
              const d = new Date(parseInt(fileDate[1]), parseInt(fileDate[2]) - 1, 1);
              if (d < oneYearAgo) break;
            }
            const body = mContent.replace(/^---[\s\S]*?---\n*/, "").trim().slice(0, 800);
            if (body) monthParts.push(`[${mf.basename}] ${body}`);
          }
          if (monthParts.length > 0) {
            parts.push("近一年各月：\n" + monthParts.join("\n\n"));
          }
        }
      }
    } catch { /* best effort */ }

    // ── Yearly summaries (older than 1 year) ──
    try {
      const yearlyPath = this.plugin.path("Memory", "Summaries", "Yearly");
      const yearlyAbstract = this.app.vault.getAbstractFileByPath(yearlyPath);
      if (yearlyAbstract) {
        const yearlyFolder = yearlyAbstract as unknown as { children: TAbstractFile[] };
        if (yearlyFolder.children) {
          const thisYear = String(new Date().getFullYear());
          const yearParts: string[] = [];
          const yearlyFiles = yearlyFolder.children
            .filter((c): c is TFile => c instanceof TFile)
            .sort((a, b) => b.name.localeCompare(a.name));
          for (const yf of yearlyFiles) {
            const yearName = yf.basename;
            if (yearName === thisYear) continue;
            const yContent = await this.app.vault.read(yf);
            const body = yContent.replace(/^---[\s\S]*?---\n*/, "").trim().slice(0, 1200);
            if (body) yearParts.push(`${yearName}年报\n\n${body}`);
          }
          if (yearParts.length > 0) {
            parts.push("往年总览：\n" + yearParts.join("\n\n"));
          }
        }
      }
    } catch { /* best effort */ }

    return parts.length > 0 ? "\n\n记忆与待办：\n" + parts.join("\n\n") : "";
  }


  /** Extract URLs from user message, fetch their content, return as context string */
  private async fetchUrlsFromMessage(message: string): Promise<string | null> {
    const urlRegex = /https?:\/\/[^\s\]\)"'<>]+/g;
    const urls = message.match(urlRegex);
    if (!urls || urls.length === 0) return null;

    const MAX_URLS = 3;
    const MAX_CHARS_PER_URL = 4000;
    const fetched: string[] = [];

    for (const url of urls.slice(0, MAX_URLS)) {
      try {
        const response = await requestUrl({
          url,
          method: "GET",
          headers: { "User-Agent": "Mozilla/5.0" }
        });
        const text = response.text.slice(0, MAX_CHARS_PER_URL);
        fetched.push(`[${url}]
${text}`);
      } catch {
        fetched.push(`[${url}]
（无法读取此链接）`);
      }
    }

    if (fetched.length === 0) return null;
    return "## 链接内容\n\n" + fetched.join("\n\n");
  }


  private showTypingIndicator(): void {
    this.hideTypingIndicator();
    const indicator = this.logEl.createDiv({ cls: "pls-typing-indicator" });
    const dots = indicator.createDiv({ cls: "pls-typing" });
    dots.createEl("span");
    dots.createEl("span");
    dots.createEl("span");
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private hideTypingIndicator(): void {
    const existing = this.logEl.querySelector(".pls-typing-indicator");
    if (existing) existing.remove();
  }

  private async streamRender(messageIndex: number, fullContent: string): Promise<void> {
    // Split into paragraphs (by double newline)
    const paragraphs = fullContent.split(/\n\n+/);
    const targetMsg = this.messages[messageIndex];
    if (!targetMsg) {
      return;
    }

    for (let i = 0; i < paragraphs.length; i++) {
      // Update the message content incrementally
      targetMsg.content = paragraphs.slice(0, i + 1).join("\n\n");
      await this.renderMessages();
      // Scroll to bottom
      this.logEl.scrollTop = this.logEl.scrollHeight;
      // Short delay for streaming effect (skip delay for last paragraph)
      if (i < paragraphs.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }
  }

  private async saveChat(): Promise<void> {
    await this.persistChat(true);
  }

  private async applyLastAssistantToDaily(): Promise<void> {
    if (!this.hasAiReplied || !this.lastAssistantContent.trim()) {
      new Notice("还没有 AI 回复可写回。请开启「需要 AI 回复」并发送后再试。");
      return;
    }
    const file = await this.getWritableDailyFile();
    const item: WritebackItem = {
      id: makeId("chat-daily"),
      kind: "daily-section",
      title: "应用到今日记录",
      content: this.lastAssistantContent,
      targetPath: file.path,
      sourcePath: this.getChatFilePath(),
      checked: true
    };
    const written = await openWritebackPreview(this.app, {
      title: "确认应用到今日记录",
      description: "确认后会把 AI 回复中的对应章节写入今日记录。你可以先编辑内容。",
      items: [item],
      onConfirm: async (items) => {
        const confirmed = items[0];
        if (confirmed) {
          await this.applyDailyNoteSections(confirmed.content, file);
        }
      }
    });
    if (written.length > 0) {
      this.updateSaveStatus("已应用到今日记录");
      new Notice("已应用到今日记录。");
    }
  }
}
