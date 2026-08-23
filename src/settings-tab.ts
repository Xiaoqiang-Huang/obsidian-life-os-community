import { App, Notice, PluginSettingTab, setIcon } from "obsidian";
import type PersonalLifeSystemPlugin from "./main";
import { Setting } from "obsidian";
import type { AiProviderType, AiReasoningEffort, AssistantStyle, AssistantVerbosity, ChatContextMode, ChatMode, ChatSendBehavior, ChatWritebackMode, DirectoryLanguage, DisplayLanguage, ExamProfileType, HeatmapRange, LlmWikiCompileDepth, LlmWikiLongMaterialMode, LlmWikiSensitiveDefault, PdfOcrEngine, ThemeStyle, WeixinBotPermission, WeixinSenderPolicy } from "./settings";
import { analyzeAiConnectionTestModels, DEFAULT_SETTINGS, EXAM_PROFILE_OPTIONS, getAiProviderPreset, getExamChatModeLabel, getExamProfileLabel, getStoredAiApiKey, getStoredAiProviderConfig, getThemeStyleClasses, normalizeAiApiKeyInput, normalizeBrowserCapturePort, normalizeChatWritebackMode, normalizeThemeStyle, setStoredAiApiKey, setStoredAiProviderConfig, THEME_STYLES, validateAiProviderConfig } from "./settings";
import { requireProFeature, resolveLicenseStatus } from "./licensing/entitlement";
import { createImportedAiSkills, getAiSkillCategories, getAiSkills, getAiSkillsByCategory, normalizeAiSkillIds } from "./services/AiSkillService";
import { getUiThemeFamilies, getUiThemeMeta, getUiThemesByFamily } from "./ui/theme";
import type { UiThemeDensity, UiThemeFamily, UiThemeMaterial, UiThemeMeta } from "./ui/types";
import { installLifeOSResponsiveShell } from "./utils/responsive-shell";
import { normalizeAutoReviewTime } from "./services/AutoReviewService";
import type { WeixinConnectionStatus } from "./services/weixin/WeixinIlinkService";

const PROVIDERS: Array<[AiProviderType, string]> = [
  ["openai", "OpenAI 官方"],
  ["openai-compatible", "OpenAI Compatible / 兼容代理"],
  ["anthropic-compatible", "Anthropic Compatible"],
  ["deepseek", "DeepSeek"],
  ["qwen", "Qwen"],
  ["kimi", "Kimi"],
  ["hunyuan", "Hunyuan"],
  ["doubao", "Doubao"],
  ["glm", "GLM"],
  ["ollama", "Ollama"]
];

type SettingsSectionId =
  | "overview"
  | "theme"
  | "basics"
  | "ai"
  | "review"
  | "chat"
  | "safety"
  | "browser"
  | "weixin"
  | "pro"
  | "wiki"
  | "experience"
  | "heatmap";

interface SettingsSectionDefinition {
  id: Exclude<SettingsSectionId, "overview">;
  title: string;
  shortTitle: string;
  description: string;
  icon: string;
  group: "core" | "connections" | "data" | "more";
}

const SETTINGS_SECTIONS: SettingsSectionDefinition[] = [
  { id: "theme", title: "主题风格", shortTitle: "主题外观", description: "颜色、材质、密度与主题画廊", icon: "palette", group: "core" },
  { id: "ai", title: "AI 模型", shortTitle: "AI 模型", description: "供应商、模型与接口配置", icon: "bot", group: "core" },
  { id: "chat", title: "Chat / AI 助手", shortTitle: "AI 助手", description: "Skill、上下文、回复与写入偏好", icon: "message-circle", group: "core" },
  { id: "review", title: "自动复盘草稿", shortTitle: "自动复盘", description: "生成时间、补生成与运行条件", icon: "calendar-clock", group: "core" },
  { id: "weixin", title: "微信连接", shortTitle: "微信连接", description: "扫码账号、权限与远程工作台", icon: "message-circle", group: "connections" },
  { id: "browser", title: "网页 AI 会话保存", shortTitle: "网页会话", description: "浏览器扩展、本地桥与连接令牌", icon: "globe-2", group: "connections" },
  { id: "basics", title: "基础信息", shortTitle: "目录与名称", description: "数据目录、语言和系统名称", icon: "folder-cog", group: "data" },
  { id: "safety", title: "数据安全", shortTitle: "数据安全", description: "本地保存、写回与记忆边界", icon: "shield-check", group: "data" },
  { id: "wiki", title: "LLM Wiki", shortTitle: "LLM Wiki", description: "资料整理、引用与 Chat 上下文", icon: "library", group: "more" },
  { id: "experience", title: "产品体验", shortTitle: "产品体验", description: "自动分析、备考与使用偏好", icon: "sparkles", group: "more" },
  { id: "heatmap", title: "成长热力图", shortTitle: "成长热力图", description: "统计范围、语言与数据来源", icon: "calendar-range", group: "more" },
  { id: "pro", title: "Pro 授权", shortTitle: "Pro 授权", description: "授权状态、服务与管理入口", icon: "badge-check", group: "more" }
];

const SETTINGS_SECTION_CLASSES: Record<string, string> = Object.fromEntries(
  SETTINGS_SECTIONS.map((section) => [section.title, `lifeos-settings-section-${section.id}`])
);

const SETTINGS_SECTION_BY_TITLE = new Map(SETTINGS_SECTIONS.map((section) => [section.title, section]));

const SETTINGS_GROUP_LABELS: Array<{ id: SettingsSectionDefinition["group"]; label: string }> = [
  { id: "core", label: "核心配置" },
  { id: "connections", label: "连接与同步" },
  { id: "data", label: "数据与目录" },
  { id: "more", label: "扩展能力" }
];

interface SettingsDraft {
  rootFolder: string;
  systemName: string;
  assistantName: string;
  aiProvider: AiProviderType;
  aiApiKey: string;
  aiBaseUrl: string;
  aiModel: string;
  visionAiModel: string;
  aiEndpointPath: string;
  aiAuthHeader: string;
  aiAuthPrefix: string;
  aiReasoningEffort: AiReasoningEffort;
}

export class PersonalLifeSystemSettingTab extends PluginSettingTab {
  private draft!: SettingsDraft;
  private dirty = false;
  private aiProviderStatusEl: HTMLElement | null = null;
  private weixinStatusUnsubscribe: (() => void) | null = null;
  private activeSettingsSection: SettingsSectionId = "overview";
  private settingsNavEl: HTMLElement | null = null;
  private settingsOverviewEl: HTMLElement | null = null;
  private settingsStageTitleEl: HTMLElement | null = null;
  private settingsStageDescriptionEl: HTMLElement | null = null;
  private settingsPanelEl: HTMLElement | null = null;

  constructor(
    app: App,
    private plugin: PersonalLifeSystemPlugin,
    private mode: "launcher" | "full" = "launcher"
  ) {
    super(app, plugin);
    this.resetDraft();
  }

  display(): void {
    const { containerEl } = this;
    this.weixinStatusUnsubscribe?.();
    this.weixinStatusUnsubscribe = null;
    containerEl.empty();
    containerEl.addClass("lifeos-settings");
    containerEl.toggleClass("lifeos-settings-launcher", this.mode === "launcher");
    containerEl.toggleClass("lifeos-settings-full", this.mode === "full");
    installLifeOSResponsiveShell(containerEl);
    containerEl.removeClass(...THEME_STYLES.map((style) => `lifeos-theme-${style}`));
    for (const cls of getThemeStyleClasses(this.plugin.settings.themeStyle ?? "minimal-warm")) {
      containerEl.addClass(cls);
    }

    if (this.mode === "launcher") {
      this.renderLauncher();
      return;
    }

    const header = containerEl.createDiv({ cls: "lifeos-settings-hero lifeos-settings-toolbar" });
    const headerCopy = header.createDiv({ cls: "lifeos-settings-toolbar-copy" });
    headerCopy.createDiv({ cls: "lifeos-kicker", text: "Life OS Settings" });
    const pageHeading = new Setting(headerCopy).setName("设置中心").setHeading();
    pageHeading.settingEl.addClass("lifeos-settings-toolbar-heading");
    headerCopy.createEl("p", { text: "常用配置集中在概览，详细设置按模块切换，不再堆成一张长页面。" });
    const actions = header.createDiv({ cls: "lifeos-settings-actions" });
    this.button(actions, "测试连接", () => void this.testConnection(), true);
    this.button(actions, this.dirty ? "保存设置（有未保存更改）" : "保存设置", () => void this.saveAll(), false, this.dirty ? "lifeos-button-primary" : "");
    this.button(actions, "恢复默认", () => void this.restoreDefaults(), false, "lifeos-button-danger");

    const workspace = containerEl.createDiv({ cls: "lifeos-settings-workspace" });
    this.settingsNavEl = workspace.createEl("nav", { cls: "lifeos-settings-nav", attr: { "aria-label": "设置模块" } });
    this.renderSettingsNavigation(this.settingsNavEl);

    const stage = workspace.createDiv({ cls: "lifeos-settings-stage" });
    const stageHeader = stage.createDiv({ cls: "lifeos-settings-stage-header" });
    const stageCopy = stageHeader.createDiv({ cls: "lifeos-settings-stage-copy" });
    const stageHeading = new Setting(stageCopy).setName("常用配置").setHeading();
    stageHeading.settingEl.addClass("lifeos-settings-stage-heading");
    this.settingsStageTitleEl = stageHeading.nameEl;
    this.settingsStageDescriptionEl = stageCopy.createEl("p");
    const stageHint = stageHeader.createSpan({ cls: "lifeos-settings-stage-hint" });
    setIcon(stageHint.createSpan({ cls: "lifeos-settings-stage-hint-icon" }), "shield-check");
    stageHint.createSpan({ text: "切换模块不会丢失未保存输入" });

    this.settingsPanelEl = stage.createDiv({ cls: "lifeos-settings-panel" });
    this.settingsOverviewEl = this.settingsPanelEl.createDiv({ cls: "lifeos-settings-overview" });
    this.settingsOverviewEl.dataset.settingsSection = "overview";
    this.renderSettingsOverview(this.settingsOverviewEl);

    const grid = this.settingsPanelEl.createDiv({ cls: "lifeos-settings-grid" });
    this.renderThemePreferences(grid);
    this.renderBasics(grid);
    this.renderAi(grid);
    this.renderAutoReview(grid);
    this.renderChatAi(grid);
    this.renderSafety(grid);
    this.renderBrowserCapture(grid);
    this.renderWeixinBot(grid);
    this.renderProLicense(grid);
    this.renderLlmWiki(grid);
    this.renderExperience(grid);
    this.renderHeatmap(grid);
    this.activateSettingsSection(this.activeSettingsSection, false);
  }

  private renderLauncher(): void {
    const hero = this.containerEl.createDiv({ cls: "lifeos-settings-launcher-card" });
    const icon = hero.createSpan({ cls: "lifeos-settings-launcher-icon" });
    setIcon(icon, "settings-2");
    const copy = hero.createDiv({ cls: "lifeos-settings-launcher-copy" });
    copy.createDiv({ cls: "lifeos-kicker", text: "Life OS Settings" });
    new Setting(copy).setName("设置已迁入 Life OS 设置中心").setHeading();
    copy.createEl("p", {
      text: "主题、AI 模型、Skill、微信连接、数据安全、自动复盘和其他全部设置，都在独立页面中统一管理。"
    });
    const facts = copy.createDiv({ cls: "lifeos-settings-launcher-facts" });
    facts.createSpan({ text: "完整页面" });
    facts.createSpan({ text: "支持侧边栏直达" });
    facts.createSpan({ text: "设置不会丢失" });
    const button = copy.createEl("button", {
      cls: "lifeos-button lifeos-button-primary lifeos-settings-launcher-button",
      attr: { type: "button" }
    });
    setIcon(button.createSpan(), "external-link");
    button.createSpan({ text: "打开 Life OS 设置中心" });
    button.onclick = () => {
      const settingsHost = this.app as unknown as { setting?: { close?: () => void } };
      settingsHost.setting?.close?.();
      void this.plugin.activateSettings();
    };
  }

  hide(): void {
    this.weixinStatusUnsubscribe?.();
    this.weixinStatusUnsubscribe = null;
  }

  private renderSettingsNavigation(parent: HTMLElement): void {
    const overview = parent.createDiv({ cls: "lifeos-settings-nav-overview" });
    this.settingsNavButton(overview, "overview", "常用配置", "一页完成高频设置", "layout-dashboard");

    for (const group of SETTINGS_GROUP_LABELS) {
      const block = parent.createDiv({ cls: "lifeos-settings-nav-group" });
      block.createDiv({ cls: "lifeos-settings-nav-group-label", text: group.label });
      const list = block.createDiv({ cls: "lifeos-settings-nav-list" });
      for (const section of SETTINGS_SECTIONS.filter((item) => item.group === group.id)) {
        this.settingsNavButton(list, section.id, section.shortTitle, section.description, section.icon);
      }
    }
  }

  private settingsNavButton(parent: HTMLElement, id: SettingsSectionId, title: string, description: string, icon: string): void {
    const button = parent.createEl("button", {
      cls: "lifeos-settings-nav-button",
      attr: { type: "button", "data-settings-target": id, "aria-pressed": "false", title: description }
    });
    const iconEl = button.createSpan({ cls: "lifeos-settings-nav-icon" });
    setIcon(iconEl, icon);
    const copy = button.createSpan({ cls: "lifeos-settings-nav-copy" });
    copy.createSpan({ cls: "lifeos-settings-nav-title", text: title });
    copy.createSpan({ cls: "lifeos-settings-nav-description", text: description });
    button.onclick = () => this.activateSettingsSection(id, true);
  }

  private renderSettingsOverview(parent: HTMLElement): void {
    const grid = parent.createDiv({ cls: "lifeos-settings-overview-grid" });

    const appearance = this.settingsOverviewCard(grid, "外观与名称", "主题与产品显示名称", "palette", "theme");
    this.settingsOverviewSelect<ThemeStyle>(
      appearance,
      "主题",
      this.plugin.settings.themeStyle ?? "minimal-warm",
      THEME_STYLES.map((value): [ThemeStyle, string] => [value, this.themeStyleLabel(value)]),
      async (value) => {
        this.plugin.settings.themeStyle = value;
        await this.saveImmediate(this.themeStyleNotice(value));
        this.display();
      }
    );
    this.settingsOverviewInput(appearance, "系统名称", this.draft.systemName, "Life OS", (value) => this.setDraft("systemName", value || "Life OS"));

    const ai = this.settingsOverviewCard(grid, "AI 模型", "供应商、模型与连接状态", "bot", "ai");
    this.settingsOverviewSelect<AiProviderType>(ai, "供应商", this.draft.aiProvider, PROVIDERS, async (value) => {
      this.applyProvider(value);
      this.display();
    });
    this.settingsOverviewInput(ai, "模型", this.draft.aiModel, "输入模型名称", (value) => this.setDraft("aiModel", value));

    const chat = this.settingsOverviewCard(grid, "AI 助手", "默认对话和上下文方式", "message-circle", "chat");
    this.settingsOverviewSelect<ChatMode>(
      chat,
      "对话模式",
      this.plugin.settings.defaultChatMode,
      [["chat", "日常对话"], ["exam", getExamChatModeLabel(this.plugin.settings)], ["diary", "日记复盘"], ["review", "复盘总结"]],
      async (value) => {
        this.plugin.settings.defaultChatMode = value;
        await this.saveImmediate("默认 Chat 模式已保存。");
        this.display();
      }
    );
    this.settingsOverviewSelect<ChatContextMode>(
      chat,
      "上下文",
      this.plugin.settings.defaultChatContextMode ?? "smart",
      [["smart", "智能上下文"], ["semantic", "语义增强"], ["global", "全局分析"]],
      async (value) => {
        this.plugin.settings.defaultChatContextMode = value;
        await this.saveImmediate("默认上下文模式已保存。");
        this.display();
      }
    );

    const automation = this.settingsOverviewCard(grid, "写入与自动化", "写入权限和每日复盘", "wand-sparkles", "review");
    this.settingsOverviewSelect<ChatWritebackMode>(
      automation,
      "记入方式",
      this.plugin.settings.chatWritebackMode ?? (this.plugin.settings.autoApplyChatToDaily ? "confirm" : "off"),
      [["off", "不写入"], ["confirm", "预览确认"], ["explicit-auto", "明确目标时自动写入"]],
      async (value) => {
        this.plugin.settings.chatWritebackMode = value;
        this.plugin.settings.autoApplyChatToDaily = value !== "off";
        await this.saveImmediate("默认记入方式已保存。");
        this.display();
      }
    );
    this.settingsOverviewToggle(automation, "自动复盘", this.plugin.settings.autoReviewEnabled === true, async (value) => {
      this.plugin.settings.autoReviewEnabled = value;
      await this.saveImmediate(value ? "自动复盘已开启，只会生成待确认草稿。" : "自动复盘已关闭。");
      this.display();
    });

    const connections = this.settingsOverviewCard(grid, "连接状态", "网页会话和微信工作台", "radio-tower", "weixin");
    this.settingsOverviewToggle(connections, "网页保存桥", this.plugin.settings.browserCaptureEnabled, async (value) => {
      this.plugin.settings.browserCaptureEnabled = value;
      await this.plugin.saveSettings();
      const status = await this.plugin.refreshBrowserCaptureBridge();
      new Notice(value ? status.message : "网页 AI 本地保存桥已关闭。", 5000);
      this.display();
    });
    this.settingsOverviewToggle(connections, "微信连接", this.plugin.settings.weixinBotEnabled, async (value) => {
      this.plugin.settings.weixinBotEnabled = value;
      await this.plugin.saveSettings();
      const status = await this.plugin.refreshWeixinConnection();
      new Notice(value ? status.message : "微信消息接收已暂停。", 5000);
      this.display();
    });

    const data = this.settingsOverviewCard(grid, "数据与目录", "Vault 目录和文件树语言", "folder-cog", "basics");
    this.settingsOverviewInput(data, "数据目录", this.draft.rootFolder, "PersonalLifeSystem", (value) => this.setDraft("rootFolder", value || "PersonalLifeSystem"));
    this.settingsOverviewSelect<DirectoryLanguage>(
      data,
      "目录语言",
      this.plugin.settings.directoryLanguage ?? "en",
      [["en", "English"], ["zh", "中文"]],
      async (value) => {
        this.plugin.settings.directoryLanguage = value;
        await this.plugin.saveSettings();
        await this.plugin.ensureBaseStructure();
        new Notice(value === "zh" ? "目录语言已切换为中文。" : "Folder language switched to English.");
        this.display();
      }
    );
  }

  private settingsOverviewCard(
    parent: HTMLElement,
    title: string,
    description: string,
    icon: string,
    target: SettingsSectionId
  ): HTMLElement {
    const card = parent.createDiv({ cls: "lifeos-settings-overview-card" });
    const head = card.createDiv({ cls: "lifeos-settings-overview-card-head" });
    const iconEl = head.createSpan({ cls: "lifeos-settings-overview-card-icon" });
    setIcon(iconEl, icon);
    const copy = head.createDiv({ cls: "lifeos-settings-overview-card-copy" });
    copy.createEl("strong", { text: title });
    copy.createSpan({ text: description });
    const open = head.createEl("button", { cls: "lifeos-settings-overview-open", attr: { type: "button", title: `打开${title}详细设置`, "aria-label": `打开${title}详细设置` } });
    setIcon(open, "arrow-up-right");
    open.onclick = () => this.activateSettingsSection(target, true);
    return card;
  }

  private settingsOverviewField(parent: HTMLElement, label: string): HTMLElement {
    const field = parent.createDiv({ cls: "lifeos-settings-overview-field" });
    field.createSpan({ cls: "lifeos-settings-overview-field-label", text: label });
    return field;
  }

  private settingsOverviewInput(
    parent: HTMLElement,
    label: string,
    value: string,
    placeholder: string,
    onChange: (value: string) => void
  ): HTMLInputElement {
    const field = this.settingsOverviewField(parent, label);
    const input = field.createEl("input", { cls: "lifeos-input", attr: { type: "text", placeholder, "aria-label": label } });
    input.value = value;
    input.oninput = () => {
      onChange(input.value);
      this.syncOverviewDraftFields();
    };
    return input;
  }

  private settingsOverviewSelect<T extends string>(
    parent: HTMLElement,
    label: string,
    value: T,
    options: Array<[T, string]>,
    onChange: (value: T) => Promise<void>
  ): HTMLSelectElement {
    const field = this.settingsOverviewField(parent, label);
    const select = field.createEl("select", { cls: "lifeos-input", attr: { "aria-label": label } });
    for (const [optionValue, optionLabel] of options) select.createEl("option", { value: optionValue, text: optionLabel });
    select.value = value;
    select.onchange = () => void onChange(select.value as T);
    return select;
  }

  private settingsOverviewToggle(
    parent: HTMLElement,
    label: string,
    value: boolean,
    onChange: (value: boolean) => Promise<void>
  ): void {
    const field = this.settingsOverviewField(parent, label);
    const control = field.createEl("label", { cls: "lifeos-settings-overview-toggle" });
    const input = control.createEl("input", { attr: { type: "checkbox", "aria-label": label } });
    input.checked = value;
    const status = control.createSpan({ text: value ? "开启" : "关闭" });
    input.onchange = () => {
      status.setText(input.checked ? "开启" : "关闭");
      void onChange(input.checked);
    };
  }

  private syncOverviewDraftFields(): void {
    const sync = (label: string, value: string): void => {
      this.containerEl.querySelectorAll<HTMLElement>(".lifeos-settings-card .lifeos-setting-row").forEach((row) => {
        if (row.querySelector<HTMLElement>(".lifeos-setting-label")?.textContent?.trim() !== label) return;
        const control = row.querySelector<HTMLInputElement>("input:not([type='checkbox'])");
        if (control && control.value !== value) control.value = value;
      });
    };
    sync("数据目录", this.draft.rootFolder);
    sync("系统名称", this.draft.systemName);
    sync("Model", this.draft.aiModel);
  }

  private activateSettingsSection(id: SettingsSectionId, moveFocus: boolean): void {
    const target = id === "overview" || SETTINGS_SECTIONS.some((section) => section.id === id) ? id : "overview";
    this.activeSettingsSection = target;
    this.settingsNavEl?.querySelectorAll<HTMLButtonElement>(".lifeos-settings-nav-button").forEach((button) => {
      const active = button.dataset.settingsTarget === target;
      button.toggleClass("is-active", active);
      button.setAttr("aria-pressed", active ? "true" : "false");
      if (active) button.setAttr("aria-current", "page");
      else button.removeAttribute("aria-current");
    });

    const definition = SETTINGS_SECTIONS.find((section) => section.id === target);
    this.settingsStageTitleEl?.setText(definition?.title ?? "常用配置");
    this.settingsStageDescriptionEl?.setText(definition?.description ?? "高频配置集中展示，修改后可立即使用。");

    const overviewActive = target === "overview";
    this.settingsOverviewEl?.toggleClass("is-settings-section-hidden", !overviewActive);
    const grid = this.settingsPanelEl?.querySelector<HTMLElement>(".lifeos-settings-grid") ?? null;
    grid?.toggleClass("is-settings-section-hidden", overviewActive);
    grid?.querySelectorAll<HTMLElement>(".lifeos-settings-card[data-settings-section]").forEach((card) => {
      const active = card.dataset.settingsSection === target;
      card.toggleClass("is-settings-section-hidden", !active);
      card.setAttr("aria-hidden", active ? "false" : "true");
      if (active) card.scrollTop = 0;
    });
    if (this.settingsPanelEl) this.settingsPanelEl.scrollTop = 0;

    if (moveFocus) {
      const activeSurface = overviewActive
        ? this.settingsOverviewEl
        : grid?.querySelector<HTMLElement>(`.lifeos-settings-card[data-settings-section="${target}"]`) ?? null;
      activeSurface?.setAttr("tabindex", "-1");
      requestAnimationFrame(() => activeSurface?.focus({ preventScroll: true }));
    }
  }

  private renderThemePreferences(parent: HTMLElement): void {
    const card = this.section(parent, "主题风格", "优先放在设置顶部，方便随时切换 Life OS 的颜色、材质和密度。", "palette");
    card.addClass("lifeos-settings-theme-card");
    const themeDescription = (value: ThemeStyle) => `当前：${this.themeStyleLabel(value)}。切换后立即生效。`;
    this.select<ThemeStyle>(
      card,
      "主题风格",
      themeDescription(this.plugin.settings.themeStyle ?? "minimal-warm"),
      this.plugin.settings.themeStyle ?? "minimal-warm",
      THEME_STYLES.map((value): [ThemeStyle, string] => [value, this.themeStyleLabel(value)]),
      async (value) => {
        const scrollSnapshot = this.captureScrollPositions();
        this.plugin.settings.themeStyle = value;
        await this.saveImmediate(this.themeStyleNotice(value));
        this.refreshThemeSelectionControls(value);
        this.restoreScrollPositions(scrollSnapshot);
        this.keepElementVisible(this.containerEl.querySelector<HTMLElement>(".lifeos-theme-style-row") ?? card);
      },
      "lifeos-theme-style-select"
    );
    this.renderThemeQuickSwitch(card);
    this.renderThemeGallery(card);
  }

  private renderThemeQuickSwitch(parent: HTMLElement): void {
    const current = normalizeThemeStyle(this.plugin.settings.themeStyle);
    const row = parent.createDiv({ cls: "lifeos-theme-quick-row" });
    row.createDiv({ cls: "lifeos-theme-quick-label", text: "快捷主题" });
    const actions = row.createDiv({ cls: "lifeos-theme-quick-actions" });
    for (const value of ["codex-light", "codex-dark"] as const) {
      const button = actions.createEl("button", {
        cls: ["lifeos-theme-quick-button", current === value ? "is-active" : ""].filter(Boolean).join(" "),
        attr: {
          type: "button",
          "aria-pressed": current === value ? "true" : "false"
        }
      });
      button.dataset.themeStyle = value;
      button.createSpan({ cls: "lifeos-theme-quick-title", text: this.themeStyleLabel(value).split(" / ")[0] });
      button.createSpan({ cls: "lifeos-theme-quick-subtitle", text: this.themePreviewDescription(value) });
      button.onclick = async () => {
        const scrollSnapshot = this.captureScrollPositions();
        this.plugin.settings.themeStyle = value;
        await this.saveImmediate(this.themeStyleNotice(value));
        this.refreshThemeSelectionControls(value);
        this.restoreScrollPositions(scrollSnapshot);
        this.keepElementVisible(parent);
      };
    }
  }

  private renderBasics(parent: HTMLElement): void {
    const card = this.section(parent, "基础信息", "这些设置决定 Life OS 在 Vault 中如何呈现。", "folder-cog");
    this.text(card, "数据目录", "所有 Life OS 文件会创建在这个目录下。", this.draft.rootFolder, (value) => this.setDraft("rootFolder", value || "PersonalLifeSystem"));
    this.select<DirectoryLanguage>(
      card,
      "Obsidian 目录语言",
      "控制 Life OS 在文件树里的功能目录名称。切换后会保守迁移已有目录，不覆盖同名目标目录。",
      this.plugin.settings.directoryLanguage ?? "en",
      [["en", "English：Chat / Daily / Tasks"], ["zh", "中文：聊天 / 日记 / 任务"]],
      async (value) => {
        this.plugin.settings.directoryLanguage = value;
        await this.plugin.saveSettings();
        await this.plugin.ensureBaseStructure();
        new Notice(value === "zh" ? "目录语言已切换为中文。" : "Folder language switched to English.");
        this.display();
      }
    );
    this.text(card, "系统名称", "显示在侧边栏和工作台顶部。", this.draft.systemName, (value) => this.setDraft("systemName", value || "Life OS"));
    this.text(card, "助手名称", "AI 助手在聊天页使用的名字。", this.draft.assistantName, (value) => this.setDraft("assistantName", value || "Life OS"));
  }

  private renderAi(parent: HTMLElement): void {
    const card = this.section(parent, "AI 模型", "新手只需要选择供应商并填写 API Key，其余高级设置可以保持默认。", "bot");
    this.aiProviderStatusEl = card.createDiv({ cls: "lifeos-provider-status" });
    this.refreshAiProviderStatus();

    const presets = card.createDiv({ cls: "lifeos-provider-grid" });
    for (const [provider, label] of PROVIDERS) {
      const button = presets.createEl("button", { cls: provider === this.draft.aiProvider ? "is-active" : "", attr: { type: "button" } });
      button.createSpan({ text: label });
      button.onclick = () => {
        this.applyProvider(provider);
        new Notice(`已选择 ${label}，点击“保存设置”后生效。`);
        this.display();
      };
    }

    this.passwordText(card, "API Key", "只保存在当前 Vault 的插件数据中。Ollama 可以留空。", this.draft.aiApiKey, (value) => this.setDraft("aiApiKey", value));
    const current = getAiProviderPreset(this.draft.aiProvider);
    if (current?.note) card.createDiv({ cls: "lifeos-settings-help", text: current.note });

    const advanced = card.createEl("details", { cls: "lifeos-settings-advanced" });
    advanced.createEl("summary", { text: "高级设置" });
    this.text(advanced, "Base URL", "兼容 OpenAI 风格接口的服务地址。", this.draft.aiBaseUrl, (value) => this.setDraft("aiBaseUrl", value));
    this.text(advanced, "Model", "用于聊天、总结和复盘的模型名称。", this.draft.aiModel, (value) => this.setDraft("aiModel", value));
    this.text(advanced, "Endpoint Path", "接口路径，通常保持供应商预设即可。", this.draft.aiEndpointPath, (value) => this.setDraft("aiEndpointPath", value));
    this.text(advanced, "Auth Header", "鉴权请求头名称，常见值为 Authorization。", this.draft.aiAuthHeader, (value) => this.setDraft("aiAuthHeader", value));
    this.text(advanced, "Auth Prefix", "鉴权前缀，常见值为 Bearer，Ollama 可留空。", this.draft.aiAuthPrefix, (value) => this.setDraft("aiAuthPrefix", value));
    this.select<AiReasoningEffort>(
      advanced,
      "Reasoning Effort",
      "用于支持 reasoning/effort 的模型。默认不发送该参数；不支持时会自动回退。",
      this.draft.aiReasoningEffort ?? "default",
      [["default", "默认"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["max", "max"]],
      async (value) => {
        if (value !== "default" && !requireProFeature(this.plugin, "aiReasoningEffort")) {
          this.draft.aiReasoningEffort = "default";
          this.display();
          return;
        }
        this.setDraft("aiReasoningEffort", value);
      }
    );
  }

  private renderChatAi(parent: HTMLElement): void {
    const card = this.section(parent, "Chat / AI 助手", "选择默认名人 Skill 组合、回复偏好和发送方式。仅内置精选公开方法论；不含在世中国公众人物、刚去世中国人物、万能角色生成器和猎奇 Skill。", "message-circle");
    const importedSkills = createImportedAiSkills(this.plugin.settings.importedAiSkills);
    const selectedIds = normalizeAiSkillIds(this.plugin.settings.defaultAiSkillIds, this.plugin.settings.defaultAiSkillId, importedSkills, this.plugin.settings.aiSkillOverrides);
    this.plugin.settings.defaultAiSkillIds = selectedIds;
    this.plugin.settings.defaultAiSkillId = selectedIds[0] ?? "lifeos-general";

    const skillBlock = card.createDiv({ cls: "lifeos-setting-row lifeos-setting-row-vertical" });
    skillBlock.createDiv({ cls: "lifeos-setting-label", text: "默认名人 Skill（可多选）" });
    skillBlock.createDiv({ cls: "lifeos-setting-description", text: `当前组合：${getAiSkills(selectedIds, importedSkills, this.plugin.settings.aiSkillOverrides).map((skill) => skill.name).join(" + ")}。重命名、分类和删除请在 AI 助手的 Skill 管理中完成。` });
    const skillDetails = skillBlock.createEl("details", { cls: "lifeos-settings-skill-details" });
    skillDetails.createEl("summary", { text: "展开选择名人 Skill" });
    for (const category of getAiSkillCategories(this.plugin.settings.customAiSkillCategories)) {
      const skills = getAiSkillsByCategory(category.id, importedSkills, this.plugin.settings.aiSkillOverrides);
      if (skills.length === 0) continue;
      const categoryBlock = skillDetails.createEl("details", { cls: "lifeos-settings-skill-category" });
      if (category.id === "system" || selectedIds.some((id) => skills.some((skill) => skill.id === id))) categoryBlock.open = true;
      const summary = categoryBlock.createEl("summary");
      summary.createSpan({ text: category.label });
      summary.createSpan({ cls: "lifeos-skill-category-count", text: `${skills.length}` });
      categoryBlock.createDiv({ cls: "lifeos-settings-skill-category-desc", text: category.description });
      const skillList = categoryBlock.createDiv({ cls: "lifeos-settings-skill-list" });
      for (const item of skills) {
        const label = skillList.createEl("label", { cls: selectedIds.includes(item.id) ? "lifeos-settings-skill-option is-active" : "lifeos-settings-skill-option" });
        const checkbox = label.createEl("input", { type: "checkbox" });
        checkbox.checked = selectedIds.includes(item.id);
        label.createSpan({ cls: "lifeos-settings-skill-name", text: item.name });
        label.createSpan({ cls: "lifeos-settings-skill-desc", text: item.description });
        checkbox.onchange = async () => {
          const next = new Set(normalizeAiSkillIds(this.plugin.settings.defaultAiSkillIds, this.plugin.settings.defaultAiSkillId, importedSkills, this.plugin.settings.aiSkillOverrides));
          if (checkbox.checked) next.add(item.id);
          else next.delete(item.id);
          this.plugin.settings.defaultAiSkillIds = normalizeAiSkillIds(Array.from(next), undefined, importedSkills, this.plugin.settings.aiSkillOverrides);
          this.plugin.settings.defaultAiSkillId = this.plugin.settings.defaultAiSkillIds[0] ?? "lifeos-general";
          await this.saveImmediate("默认名人 Skill 组合已保存。");
          this.display();
        };
      }
    }

    this.select<ChatMode>(card, "默认 Chat 模式", "打开 AI 助手时默认使用的对话模式。", this.plugin.settings.defaultChatMode, [["chat", "日常对话"], ["exam", getExamChatModeLabel(this.plugin.settings)], ["diary", "日记复盘"], ["review", "复盘总结"]], async (value) => {
      this.plugin.settings.defaultChatMode = value;
      await this.saveImmediate("默认 Chat 模式已保存。");
    });
    this.select<ChatContextMode>(card, "默认上下文模式", "控制 Chat 默认如何组织本地上下文，Chat 页仍可临时切换。", this.plugin.settings.defaultChatContextMode ?? "smart", [["smart", "智能上下文"], ["semantic", "语义增强"], ["global", "全局分析"]], async (value) => {
      this.plugin.settings.defaultChatContextMode = value;
      await this.saveImmediate("默认上下文模式已保存。");
    });
    this.select<AssistantStyle>(card, "默认回复风格", "控制 AI 的语气，Chat 页仍可临时切换。", this.plugin.settings.assistantStyle, [["warm-companion", "温和"], ["concise-executor", "简洁"], ["strict-coach", "严格"]], async (value) => {
      this.plugin.settings.assistantStyle = value;
      await this.saveImmediate("默认回复风格已保存。");
    });
    this.select<AssistantVerbosity>(card, "默认回复长度", "控制 AI 默认回答的详细程度。", this.plugin.settings.assistantVerbosity, [["brief", "简短"], ["normal", "标准"], ["detailed", "详细"]], async (value) => {
      this.plugin.settings.assistantVerbosity = value;
      await this.saveImmediate("默认回复长度已保存。");
    });
    this.select<ChatSendBehavior>(card, "发送方式", "Enter 发送适合短问答；Ctrl/Cmd + Enter 适合长文本输入。", this.plugin.settings.chatSendBehavior ?? "enterToSend", [["enterToSend", "Enter 发送"], ["modEnterToSend", "Ctrl/Cmd + Enter 发送"]], async (value) => {
      this.plugin.settings.chatSendBehavior = value;
      await this.saveImmediate("发送方式已保存。");
    });

    this.toggle(card, "默认开启 AI 回复", "关闭后，Chat 默认只保存用户记录，不调用 AI。", this.plugin.settings.chatDefaultAiReply !== false, async (value) => {
      this.plugin.settings.chatDefaultAiReply = value;
      await this.saveImmediate("默认 AI 回复设置已保存。");
    });
    this.select<ChatWritebackMode>(
      card,
      "默认记入方式",
      "不写入最稳妥；确认模式会先预览；自动模式仅在你明确指定日记、知识库、项目文档、记忆或目标文档时写入，含糊请求仍会询问。",
      this.plugin.settings.chatWritebackMode ?? (this.plugin.settings.autoApplyChatToDaily ? "confirm" : "off"),
      [["off", "不写入"], ["confirm", "预览确认后写入"], ["explicit-auto", "明确指定目标时自动写入"]],
      async (value) => {
        this.plugin.settings.chatWritebackMode = value;
        this.plugin.settings.autoApplyChatToDaily = value !== "off";
        await this.saveImmediate("默认记入方式已保存。");
      }
    );
    this.toggle(card, "启用图片视觉分析", "开启后，AI 助手可把图片附件发送给支持视觉的模型；未开启时图片只作为附件记录，不做识别。", this.plugin.settings.enableVisionFileAnalysis === true, async (value) => {
      this.plugin.settings.enableVisionFileAnalysis = value;
      await this.saveImmediate("图片视觉分析设置已保存。");
    });
    const visionInput = this.text(card, "视觉模型", "用于图片识别的模型名。未填写时图片识别不可用；请确认你的 API 和模型支持视觉输入。", this.draft.visionAiModel, (value) => this.setDraft("visionAiModel", value));
    visionInput.onblur = async () => {
      this.plugin.settings.visionAiModel = visionInput.value.trim();
      await this.saveImmediate("视觉模型设置已保存。");
    };
    this.select<PdfOcrEngine>(
      card,
      "PDF OCR 引擎",
      "自动模式会在配置 PP-StructureV3 地址后优先使用 PaddleOCR 结构化识别，不可用时回退到内置本地 OCR。",
      this.plugin.settings.pdfOcrEngine ?? "auto",
      [
        ["auto", "自动（结构化优先，失败回退）"],
        ["tesseract", "内置本地 OCR（轻量）"],
        ["paddle", "PaddleOCR PP-StructureV3（复杂版面）"]
      ],
      async (value) => {
        this.plugin.settings.pdfOcrEngine = value;
        await this.saveImmediate("PDF OCR 引擎设置已保存。");
      }
    );
    const paddleEndpoint = this.text(
      card,
      "PaddleOCR 服务地址",
      "填写自托管 PP-StructureV3 的 /layout-parsing 地址；留空时不会发起外部请求。",
      this.plugin.settings.paddleOcrEndpoint ?? "",
      () => undefined
    );
    paddleEndpoint.placeholder = "http://127.0.0.1:8080/layout-parsing";
    paddleEndpoint.onblur = async () => {
      this.plugin.settings.paddleOcrEndpoint = paddleEndpoint.value.trim();
      await this.saveImmediate("PaddleOCR 服务地址已保存。");
    };
  }

  private renderAutoReview(parent: HTMLElement): void {
    const card = this.section(parent, "自动复盘草稿", "到点后只生成待确认草稿，不修改日记正文，也不会自动保存为正式复盘。", "calendar-clock");
    this.toggle(card, "启用自动复盘", "默认关闭。开启后仅在 AI 已配置且当前授权可用时运行。", this.plugin.settings.autoReviewEnabled === true, async (value) => {
      this.plugin.settings.autoReviewEnabled = value;
      await this.saveImmediate(value ? "自动复盘已开启，只会生成待确认草稿。" : "自动复盘已关闭。");
      this.display();
    });
    const timeRow = this.row(card, "每日生成时间", "到达该时间后生成当天草稿；同一天同一来源只调用一次 AI。");
    const time = timeRow.createEl("input", { cls: "lifeos-input", attr: { type: "time", "aria-label": "自动复盘生成时间" } });
    time.value = normalizeAutoReviewTime(this.plugin.settings.autoReviewTime);
    time.disabled = !this.plugin.settings.autoReviewEnabled;
    time.onchange = async () => {
      this.plugin.settings.autoReviewTime = normalizeAutoReviewTime(time.value);
      time.value = this.plugin.settings.autoReviewTime;
      await this.saveImmediate("自动复盘时间已保存。");
    };
    this.toggle(card, "启动时补生成昨日遗漏", "默认开启；每天最多检查一次，仍然只创建待确认草稿。", this.plugin.settings.autoReviewCatchUp !== false, async (value) => {
      this.plugin.settings.autoReviewCatchUp = value;
      await this.saveImmediate("自动复盘补生成设置已保存。");
    });

    const license = resolveLicenseStatus(
      this.plugin.settings.licenseSnapshot,
      new Date(),
      this.plugin.settings.licenseEntitlementToken
    );
    const blockers = [
      this.plugin.ai.isConfigured() ? "" : "AI 尚未配置",
      license === "free" ? "当前授权不包含 AI 复盘" : ""
    ].filter(Boolean);
    this.info(
      card,
      blockers.length > 0 ? "当前不会自动生成" : "运行条件已满足",
      blockers.length > 0
        ? `${blockers.join("；")}。设置会保留，条件满足后再运行。`
        : `每天 ${normalizeAutoReviewTime(this.plugin.settings.autoReviewTime)} 检查；结果在复盘页“待确认草稿”中处理。`
    );
    this.button(card, "打开复盘草稿", () => void this.plugin.activateReview(), false);
  }

  private renderSafety(parent: HTMLElement): void {
    const card = this.section(parent, "数据安全", "这里展示当前写入边界和长期数据保护状态。", "shield-check");
    this.info(card, "本地保存", `已启用：所有内容都保存在你的 Vault：${this.plugin.getRoot()}`);
    const writebackMode = normalizeChatWritebackMode(
      this.plugin.settings.chatWritebackMode,
      this.plugin.settings.autoApplyChatToDaily === true
    );
    this.info(
      card,
      "AI 写回权限",
      writebackMode === "explicit-auto"
        ? "当前：明确指定目标时自动写入；含糊请求、未选项目和不确定路径仍会停止或进入预览。"
        : writebackMode === "confirm"
          ? "当前：所有 Chat 写入先预览，确认后才落盘。"
          : "当前：Chat 只问答，不写入 Vault。"
    );
    this.info(card, "长期记忆需确认", "已启用：候选记忆必须人工确认后才进入正式分类记忆。" );
  }

  private renderBrowserCapture(parent: HTMLElement): void {
    const card = this.section(parent, "网页 AI 会话保存", "连接 Life OS 浏览器扩展，把当前网页对话保存到所选项目。", "globe-2");
    const status = this.plugin.getBrowserCaptureStatus();
    this.info(
      card,
      "本地桥状态",
      this.plugin.settings.browserCaptureEnabled
        ? status.message
        : "未启用。扩展仍可下载标准 JSON，再从项目上下文手动导入。"
    );
    this.toggle(
      card,
      "启用本地保存桥",
      "仅监听 127.0.0.1，项目列表和保存请求都必须携带连接令牌。",
      this.plugin.settings.browserCaptureEnabled,
      async (value) => {
        this.plugin.settings.browserCaptureEnabled = value;
        await this.plugin.saveSettings();
        const next = await this.plugin.refreshBrowserCaptureBridge();
        new Notice(value ? next.message : "网页 AI 本地保存桥已关闭。", 6000);
        this.display();
      }
    );
    const portRow = this.row(card, "本地端口", "默认 27183；只有端口被其他程序占用时才需要修改。");
    const port = portRow.createEl("input", {
      cls: "lifeos-input lifeos-browser-capture-port",
      attr: { type: "number", min: "1024", max: "65535", step: "1" }
    });
    port.value = String(this.plugin.settings.browserCapturePort);
    port.onblur = async () => {
      this.plugin.settings.browserCapturePort = normalizeBrowserCapturePort(port.value);
      await this.plugin.saveSettings();
      const next = await this.plugin.refreshBrowserCaptureBridge();
      new Notice(next.message, 6000);
      this.display();
    };
    const tokenRow = this.row(card, "连接令牌", "令牌只保存在本机，用于阻止其他网页向 Life OS 写入内容。");
    const token = tokenRow.createEl("input", {
      cls: "lifeos-input lifeos-browser-capture-token",
      attr: { type: "password", readonly: "true", "aria-label": "浏览器扩展连接令牌" }
    });
    token.value = this.plugin.settings.browserCaptureToken;
    const actions = card.createDiv({ cls: "lifeos-settings-actions lifeos-browser-capture-actions" });
    this.button(actions, "复制连接信息", () => void (async () => {
      const connection = this.plugin.getBrowserCaptureConnection();
      await navigator.clipboard.writeText(JSON.stringify(connection, null, 2));
      new Notice("浏览器扩展连接信息已复制。", 4000);
    })(), true);
    this.button(actions, "重新启动", () => void (async () => {
      const next = await this.plugin.refreshBrowserCaptureBridge();
      new Notice(next.message, 6000);
      this.display();
    })());
    this.button(actions, "更换令牌", () => void (async () => {
      if (!window.confirm("更换令牌后，浏览器扩展里的旧连接信息会立即失效。确认继续吗？")) return;
      await this.plugin.regenerateBrowserCaptureToken();
      new Notice("连接令牌已更换，请重新粘贴到浏览器扩展。", 7000);
      this.display();
    })());
  }

  private renderWeixinBot(parent: HTMLElement): void {
    const card = this.section(
      parent,
      "微信连接",
      "Life OS 内置微信 iLink Bot 连接层：直接扫码，不需要安装 OpenClaw，也不需要运行额外 Gateway。",
      "message-circle"
    );
    card.addClass("lifeos-weixin-card");

    this.toggle(
      card,
      "启用微信连接",
      "启用后由桌面 Obsidian 同时接收所有已连接微信 Bot 的消息；关闭时停止轮询，但保留各账号的本地登录。",
      this.plugin.settings.weixinBotEnabled,
      async (value) => {
        this.plugin.settings.weixinBotEnabled = value;
        await this.plugin.saveSettings();
        const next = await this.plugin.refreshWeixinConnection();
        new Notice(value ? next.message : "微信消息接收已暂停。", 5000);
        this.display();
      }
    );

    const visionReady = this.plugin.settings.enableVisionFileAnalysis === true
      && Boolean(this.plugin.settings.visionAiModel?.trim());
    const visionHint = card.createDiv({ cls: `lifeos-weixin-vision-hint${visionReady ? " is-ready" : " is-warning"}` });
    setIcon(visionHint.createSpan({ cls: "lifeos-weixin-vision-icon" }), visionReady ? "scan-eye" : "image-off");
    visionHint.createSpan({
      text: visionReady
        ? `图片识别已启用：${this.plugin.settings.visionAiModel.trim()}`
        : "图片识别尚未启用：请先在“AI 模型”中开启图片视觉分析并填写视觉模型。"
    });

    const connectionPanel = card.createDiv({ cls: "lifeos-weixin-connection" });
    const renderConnection = (status: WeixinConnectionStatus): void => {
      if (!connectionPanel.isConnected) return;
      connectionPanel.empty();
      const head = connectionPanel.createDiv({ cls: "lifeos-weixin-connection-head" });
      const copy = head.createDiv({ cls: "lifeos-weixin-connection-copy" });
      copy.createDiv({ cls: "lifeos-setting-label", text: "微信扫码连接" });
      copy.createDiv({ cls: "lifeos-setting-description", text: status.message });
      const badge = head.createSpan({ cls: `lifeos-weixin-status lifeos-weixin-status-${status.phase}`, text: this.weixinStatusLabel(status) });
      badge.setAttr("aria-live", "polite");

      if (status.qrDataUrl) {
        const qrWrap = connectionPanel.createDiv({ cls: "lifeos-weixin-qr-wrap" });
        const qr = qrWrap.createEl("img", {
          cls: "lifeos-weixin-qr",
          attr: { src: status.qrDataUrl, alt: "微信登录二维码" }
        });
        qr.setAttr("draggable", "false");
        const qrCopy = qrWrap.createDiv({ cls: "lifeos-weixin-qr-copy" });
        qrCopy.createEl("strong", { text: status.phase === "scanned" ? "已扫码，请在手机确认" : "使用手机微信扫码" });
        qrCopy.createEl("p", { text: "二维码只用于创建微信 Bot 身份，不会读取你的个人聊天记录。" });
        if (status.qrExpiresAt > 0) {
          qrCopy.createEl("span", { text: `有效至 ${new Date(status.qrExpiresAt).toLocaleTimeString("zh-CN")}` });
        }
      }

      if (status.phase === "verification-required") {
        const verify = connectionPanel.createDiv({ cls: "lifeos-weixin-verify" });
        const input = verify.createEl("input", {
          cls: "lifeos-input",
          attr: { type: "text", inputmode: "numeric", autocomplete: "one-time-code", placeholder: "输入微信显示的验证码", "aria-label": "微信验证码" }
        });
        this.button(verify, "提交验证码", () => {
          try {
            this.plugin.submitWeixinVerificationCode(input.value);
            input.value = "";
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error), 5000);
          }
        }, true);
      }

      const actions = connectionPanel.createDiv({ cls: "lifeos-settings-actions lifeos-weixin-actions" });
      const loginInProgress = ["requesting-qr", "waiting-scan", "scanned", "verification-required"].includes(status.phase);
      if (!loginInProgress) {
        this.button(
          actions,
          status.accountCount > 0 ? "添加微信账号" : (status.phase === "expired" || status.phase === "error" ? "重新生成二维码" : "生成二维码"),
          () => void this.startWeixinLogin(),
          true
        );
        if (status.accountCount > 1) {
          this.button(actions, "退出全部账号", () => void (async () => {
            if (!window.confirm(`确认移除全部 ${status.accountCount} 个微信 Bot？本地登录令牌会被删除。`)) return;
            await this.plugin.disconnectWeixin();
            new Notice("全部微信连接已退出，本地令牌已删除。", 5000);
          })(), false, "lifeos-button-danger");
        }
      } else if (status.phase === "requesting-qr") {
        const waiting = actions.createEl("button", { cls: "lifeos-button", text: "正在生成…", attr: { type: "button", disabled: "true" } });
        waiting.setAttr("aria-busy", "true");
      }

      if (status.accounts.length > 0) {
        const accountSection = connectionPanel.createDiv({ cls: "lifeos-weixin-account-section" });
        const accountHead = accountSection.createDiv({ cls: "lifeos-weixin-account-head" });
        accountHead.createEl("strong", { text: `已保存账号（${status.accounts.length}）` });
        accountHead.createSpan({ text: "每个账号独立保存会话、游标和回复上下文" });
        const accountList = accountSection.createDiv({ cls: "lifeos-weixin-account-list" });
        status.accounts.forEach((account, index) => {
          const item = accountList.createDiv({ cls: "lifeos-weixin-account-item" });
          const accountCopy = item.createDiv({ cls: "lifeos-weixin-account-copy" });
          const title = accountCopy.createDiv({ cls: "lifeos-weixin-account-title" });
          title.createEl("strong", { text: `微信 Bot ${index + 1}` });
          title.createSpan({ cls: `lifeos-weixin-status lifeos-weixin-status-${account.phase}`, text: account.connected ? "运行中" : this.weixinAccountStatusLabel(account.phase) });
          accountCopy.createSpan({ text: `Bot ${this.shortConnectionId(account.accountId)} · 微信 ${this.shortConnectionId(account.userId || "未知")}` });
          const recent = [
            account.lastInboundAt ? `收 ${new Date(account.lastInboundAt).toLocaleTimeString("zh-CN")}` : "",
            account.lastReplyAt ? `发 ${new Date(account.lastReplyAt).toLocaleTimeString("zh-CN")}` : ""
          ].filter(Boolean).join(" · ");
          accountCopy.createSpan({ text: recent || account.message });
          const accountActions = item.createDiv({ cls: "lifeos-weixin-account-actions" });
          this.button(accountActions, "移除", () => void (async () => {
            if (!window.confirm(`只移除微信 Bot ${index + 1}？其他微信账号会继续运行。`)) return;
            await this.plugin.disconnectWeixin(account.accountId);
            new Notice("该微信 Bot 已移除。", 5000);
          })(), false, "lifeos-button-danger");
          if (account.lastError) {
            const error = accountCopy.createEl("details", { cls: "lifeos-weixin-error" });
            error.createEl("summary", { text: "查看账号错误" });
            error.createEl("code", { text: account.lastError });
          }
        });
      }

      if (status.accountId || status.lastPollAt || status.lastInboundAt || status.lastReplyAt) {
        const facts = connectionPanel.createDiv({ cls: "lifeos-weixin-facts" });
        if (status.accountCount) facts.createSpan({ text: `${status.accountCount} 个微信 Bot` });
        if (status.lastPollAt) facts.createSpan({ text: `最近检查 ${new Date(status.lastPollAt).toLocaleTimeString("zh-CN")}` });
        if (status.lastInboundAt) facts.createSpan({ text: `收到消息 ${new Date(status.lastInboundAt).toLocaleTimeString("zh-CN")}` });
        if (status.lastReplyAt) facts.createSpan({ text: `发送回复 ${new Date(status.lastReplyAt).toLocaleTimeString("zh-CN")}` });
      }
      if (status.lastError) {
        const error = connectionPanel.createEl("details", { cls: "lifeos-weixin-error" });
        error.createEl("summary", { text: "查看最近错误" });
        error.createEl("code", { text: status.lastError });
      }
    };
    renderConnection(this.plugin.getWeixinConnectionStatus());
    this.weixinStatusUnsubscribe = this.plugin.subscribeWeixinConnectionStatus(renderConnection);

    this.select<WeixinSenderPolicy>(
      card,
      "私聊访问策略",
      "推荐“配对确认”：陌生微信账号先收到一次性配对码，经你批准后才可使用 Life OS。",
      this.plugin.settings.weixinSenderPolicy,
      [["pairing", "配对确认（推荐）"], ["allowlist", "仅允许列表"], ["open", "所有私聊账号"]],
      async (value) => {
        this.plugin.settings.weixinSenderPolicy = value;
        await this.plugin.saveSettings();
      }
    );
    this.select<WeixinBotPermission>(
      card,
      "远程写入权限",
      "推荐使用自然语言授权：明确要求会直接执行，AI 推断出的写入会先用自然语言向你确认。群聊始终受到额外限制。",
      this.plugin.settings.weixinPermissionMode,
      [["confirm", "自然语言授权（推荐）"], ["explicit-auto", "明确意图直接执行"], ["read-only", "只读，不允许写入"]],
      async (value) => {
        this.plugin.settings.weixinPermissionMode = value;
        await this.plugin.saveSettings();
      }
    );
    this.toggle(
      card,
      "微信对话进入今日日记",
      "将已授权私聊中的普通用户输入自动追加到当日日记，作为日记与复盘证据。AI 回复不会被当成已完成事实；待办、收藏等结构化操作不会重复写入。只读模式下不写入。",
      this.plugin.settings.weixinCaptureToDailyEnabled,
      async (value) => {
        this.plugin.settings.weixinCaptureToDailyEnabled = value;
        await this.plugin.saveSettings();
      }
    );
    this.toggle(
      card,
      "每日 00:00 整理并发送日终总结",
      "在次日 00:00 汇总刚结束一天的微信输入、日记正文、任务、打卡和已确认项目事实，更新日记中的托管区块，并主动发送给所有仍获授权且曾私聊过的微信会话。",
      this.plugin.settings.weixinDailyDigestEnabled,
      async (value) => {
        this.plugin.settings.weixinDailyDigestEnabled = value;
        await this.plugin.saveSettings();
      }
    );
    this.toggle(
      card,
      "启动后补发错过的日终总结",
      "如果 00:00 时 Obsidian 未运行，下次启动后补做前一天总结。发送采用幂等记录，不会因重启重复推送。",
      this.plugin.settings.weixinDailyDigestCatchUp,
      async (value) => {
        this.plugin.settings.weixinDailyDigestCatchUp = value;
        await this.plugin.saveSettings();
      }
    );

    const projectSelect = this.select<string>(
      card,
      "默认项目",
      "尚未在微信中指定项目时读取该项目；也可以保持未指定，并在对话中用自然语言切换。",
      this.plugin.settings.weixinDefaultProjectId,
      [["", "未指定项目"]],
      async (value) => {
        this.plugin.settings.weixinDefaultProjectId = value;
        await this.plugin.saveSettings();
      },
      "lifeos-weixin-project-select"
    );
    void this.plugin.listWeixinProjects().then((projects) => {
      if (!projectSelect.isConnected) return;
      projects.forEach((project) => projectSelect.createEl("option", { value: project.id, text: project.name }));
      projectSelect.value = this.plugin.settings.weixinDefaultProjectId;
    }).catch((error) => console.warn("[Life OS] Failed to load Weixin projects", error));

    this.renderWeixinPairings(card);
    this.renderWeixinApprovedSenders(card);

    const advanced = card.createEl("details", { cls: "lifeos-weixin-advanced" });
    advanced.createEl("summary", { text: "高级访问控制与使用说明" });
    const groupsRow = this.row(
      advanced,
      "允许的群聊",
      "微信 iLink Bot 目前以私聊最稳定，普通微信群可能不可用。若收到群聊拒绝提示，可按提示每行加入一个完整会话标识。"
    );
    const groups = groupsRow.createEl("textarea", {
      cls: "lifeos-input lifeos-weixin-groups",
      attr: { rows: "3", placeholder: "weixin:BOT_ID:group:GROUP_ID" }
    });
    groups.value = this.plugin.settings.weixinAllowedGroups.join("\n");
    groups.onblur = async () => {
      this.plugin.settings.weixinAllowedGroups = Array.from(new Set(
        groups.value.split(/[\n,]+/u).map((item) => item.trim()).filter((item) => item.startsWith("weixin:"))
      )).slice(0, 500);
      await this.plugin.saveSettings();
    };
    const guide = advanced.createEl("ol", { cls: "lifeos-weixin-guide" });
    [
      "点击“生成二维码”，用手机微信扫码并在手机端确认；连接后可继续点“添加微信账号”。无需安装 OpenClaw。",
      "用微信向新创建的 Bot 发送消息；首次私聊默认返回配对码，在本页批准。",
      "在上方选择默认项目。每个微信会话会独立保存上下文，不会混入其他微信账号的对话。",
      "先在“AI 模型”中启用图片视觉分析并填写视觉模型。微信无法同时发送图片和文字时，先发最多 4 张图片，再发问题；图片只在内存中等待 15 分钟。",
      "直接说“用花生十三回答……”“小P，帮我解这题”或“陈怀安分析这份资料”，即可临时调用已安装 Skill；同名系列会结合题目自动选择具体模块，不改变电脑端选择。",
      "直接说“联网查一下……”即可搜索网页；粘贴链接可读取正文，明确说“把这个链接存入知识库”时会抓取可读内容后保存，而不是只存网址。",
      "微信对话就是 Life OS 的一个完整输入端：普通对话可进入当日日记证据；也可用自然语言记日记、管理待办、生成复盘或总结、收藏网页、存入知识库并设置提醒。",
      "直接说“根据今天的微信对话生成今日日记”可随时整理；启用日终总结后，次日 00:00 自动更新日记并发回微信。AI 只整理证据，不会把自己的回复冒充为你的完成事实。",
      "桌面 Obsidian 必须保持运行；关闭插件或电脑后，实时回复、到期提醒和 00:00 推送都会暂停。启用补发后，下次启动会自动补做前一天总结。"
    ].forEach((text) => guide.createEl("li", { text }));
    advanced.createEl("p", { text: "兼容命令（非必需）：仍保留 /lifeos 与 /skill 供调试和精确控制；日常使用直接说自然语言即可。" });
    advanced.createEl("p", { cls: "lifeos-setting-description", text: `各账号登录令牌仅保存在当前 Vault 的插件目录，不写入 Markdown；提醒和日终推送只使用不透明路由引用。目前保存了 ${this.plugin.settings.weixinReminderRoutes.length} 条私聊投递路由。微信回复会自动把 LaTeX 公式降级为普通算式。` });
  }

  private async startWeixinLogin(): Promise<void> {
    try {
      await this.plugin.startWeixinLogin();
    } catch (error) {
      new Notice(`微信二维码生成失败：${error instanceof Error ? error.message : String(error)}`, 7000);
    }
  }

  private renderWeixinPairings(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "lifeos-weixin-access-section" });
    section.createDiv({ cls: "lifeos-setting-label", text: `待确认配对（${this.plugin.settings.weixinPendingPairings.length}）` });
    if (this.plugin.settings.weixinPendingPairings.length === 0) {
      section.createDiv({ cls: "lifeos-setting-description", text: "暂无。陌生微信账号发送第一条消息后，会在这里出现。" });
      return;
    }
    const list = section.createDiv({ cls: "lifeos-weixin-access-list" });
    this.plugin.settings.weixinPendingPairings.forEach((pairing) => {
      const row = list.createDiv({ cls: "lifeos-weixin-access-item" });
      const copy = row.createDiv({ cls: "lifeos-weixin-access-copy" });
      copy.createEl("strong", { text: ["微信", pairing.senderName || pairing.senderId].filter(Boolean).join(" · ") });
      copy.createSpan({ text: `配对码 ${pairing.code} · ${new Date(pairing.expiresAt).toLocaleTimeString("zh-CN")} 过期` });
      const actions = row.createDiv({ cls: "lifeos-weixin-access-actions" });
      this.button(actions, "批准", () => void (async () => {
        const ok = await this.plugin.approveWeixinPairing(pairing.code);
        new Notice(ok ? "已批准该微信账号。" : "配对码已过期，请让对方重新发送消息。", 5000);
        this.display();
      })(), true);
      this.button(actions, "拒绝", () => void (async () => {
        await this.plugin.rejectWeixinPairing(pairing.code);
        this.display();
      })());
    });
  }

  private renderWeixinApprovedSenders(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "lifeos-weixin-access-section" });
    section.createDiv({ cls: "lifeos-setting-label", text: `已授权微信账号（${this.plugin.settings.weixinApprovedSenders.length}）` });
    if (this.plugin.settings.weixinApprovedSenders.length === 0) {
      section.createDiv({ cls: "lifeos-setting-description", text: "暂无已授权账号。" });
      return;
    }
    const list = section.createDiv({ cls: "lifeos-weixin-access-list" });
    this.plugin.settings.weixinApprovedSenders.forEach((sender) => {
      const row = list.createDiv({ cls: "lifeos-weixin-access-item" });
      const copy = row.createDiv({ cls: "lifeos-weixin-access-copy" });
      copy.createEl("strong", { text: `微信 · ${sender.label || sender.senderId}` });
      copy.createSpan({ text: sender.key });
      this.button(row, "撤销", () => void (async () => {
        if (!window.confirm(`撤销 ${sender.label || sender.senderId} 的 Life OS 访问权限？`)) return;
        await this.plugin.revokeWeixinSender(sender.key);
        this.display();
      })(), false, "lifeos-button-danger");
    });
  }

  private weixinStatusLabel(status: WeixinConnectionStatus): string {
    if (status.phase === "connected") return "已连接";
    if (status.phase === "requesting-qr") return "生成中";
    if (status.phase === "waiting-scan") return "待扫码";
    if (status.phase === "scanned") return "待确认";
    if (status.phase === "verification-required") return "需验证码";
    if (status.phase === "reconnecting") return "重连中";
    if (status.phase === "expired") return "已失效";
    if (status.phase === "error") return "连接异常";
    if (status.phase === "unavailable") return "桌面端可用";
    return "未连接";
  }

  private weixinAccountStatusLabel(phase: WeixinConnectionStatus["accounts"][number]["phase"]): string {
    if (phase === "reconnecting") return "重连中";
    if (phase === "expired") return "已失效";
    if (phase === "error") return "异常";
    if (phase === "connected") return "运行中";
    return "已暂停";
  }

  private shortConnectionId(value: string): string {
    const source = value.trim();
    return source.length > 16 ? `${source.slice(0, 6)}…${source.slice(-6)}` : source;
  }

  private renderProLicense(parent: HTMLElement): void {
    const snapshot = this.plugin.settings.licenseSnapshot;
    const license = snapshot?.license ?? null;
    const resolved = resolveLicenseStatus(snapshot, new Date(), this.plugin.settings.licenseEntitlementToken);
    const status = resolved === "trial"
      ? "试用"
      : resolved === "monthly-pro"
        ? "月付 Pro"
        : resolved === "lifetime-pro"
          ? "买断 Pro"
          : "免费";
    const expiresAt = license?.expiresAt
      ? new Date(license.expiresAt).toLocaleString("zh-CN")
      : license
        ? "永久"
        : "无";
    const card = this.section(parent, "Pro 授权", "购买、兑换、激活和备份授权码。数据查看、导出和迁移入口不会被 Pro 锁死。", "badge-check");
    this.info(card, "当前授权状态", `${status}；到期时间：${expiresAt}`);
    this.info(card, "当前设备安装 ID", this.plugin.settings.licenseInstallationId);
    const server = this.text(card, "授权服务地址", "用于购买、轮询订单、兑换和激活。", this.plugin.settings.licenseApiBaseUrl, (value) => {
      this.plugin.settings.licenseApiBaseUrl = value.trim();
    });
    server.onblur = async () => {
      await this.saveImmediate("授权服务地址已保存。");
    };
    const actions = card.createDiv({ cls: "lifeos-settings-actions" });
    this.button(actions, "打开 Pro 授权中心", () => void this.plugin.activateProLicense(), true);
  }

  private renderLlmWiki(parent: HTMLElement): void {
    const card = this.section(
      parent,
      "LLM Wiki",
      "把文章、URL、笔记和资料保存成可追溯、可整理、可用于 Chat 的知识草稿。只在你主动保存时工作，不会自动扫描整个 Vault。",
      "library"
    );
    this.toggle(card, "启用 LLM Wiki", "开启后，只有你主动保存资料时才会工作；不会自动扫描整个 Vault。", this.plugin.settings.enableLlmWiki, async (value) => {
      this.plugin.settings.enableLlmWiki = value;
      await this.saveImmediate("LLM Wiki 设置已保存。");
    });
    this.select<LlmWikiCompileDepth>(card, "短资料编译深度", "短资料默认自动整理，标准模式会生成摘要、概念、问题和行动启发。", this.plugin.settings.llmWikiShortCompileDepth, [["light", "轻量"], ["standard", "标准"], ["deep", "深度"]], async (value) => {
      this.plugin.settings.llmWikiShortCompileDepth = value;
      await this.saveImmediate("短资料编译深度已保存。");
    });
    this.select<LlmWikiLongMaterialMode>(card, "长资料整理默认方式", "长资料默认先保存，再让你选择快速整理、深度整理或仅保存。", this.plugin.settings.llmWikiLongMaterialMode, [["ask", "每次询问"], ["quick", "快速整理"], ["deep", "深度整理"], ["save-only", "仅保存"]], async (value) => {
      this.plugin.settings.llmWikiLongMaterialMode = value;
      await this.saveImmediate("长资料整理默认方式已保存。");
    });
    this.select<LlmWikiSensitiveDefault>(card, "敏感资料默认处理", "敏感资料默认仅本地保存，不进入未来 Chat 上下文。", this.plugin.settings.llmWikiSensitiveDefault, [["local-only", "仅本地保存"], ["ask", "每次询问"], ["allow", "允许整理"]], async (value) => {
      this.plugin.settings.llmWikiSensitiveDefault = value;
      await this.saveImmediate("敏感资料默认处理已保存。");
    });
    this.toggle(card, "Chat 参考 Draft", "开启后，最近 Draft 会以草稿标记进入 Chat 上下文。", this.plugin.settings.llmWikiIncludeDraftsInChat, async (value) => {
      this.plugin.settings.llmWikiIncludeDraftsInChat = value;
      await this.saveImmediate("Chat 参考 Draft 设置已保存。");
    });
    this.toggle(card, "显示来源引用", "Chat 回答会显示参考了哪个 LLM Wiki 文件。", this.plugin.settings.llmWikiShowSourceReferences, async (value) => {
      this.plugin.settings.llmWikiShowSourceReferences = value;
      await this.saveImmediate("来源引用设置已保存。");
    });
    this.toggle(card, "Dashboard 待整理提醒", "首页只显示轻量提醒，不展开管理细节。", this.plugin.settings.llmWikiDashboardReminder, async (value) => {
      this.plugin.settings.llmWikiDashboardReminder = value;
      await this.saveImmediate("Dashboard 待整理提醒已保存。");
    });
  }

  private renderExperience(parent: HTMLElement): void {
    const card = this.section(parent, "产品体验", "控制自动分析、备考模块和整体视觉风格。", "sparkles");
    this.toggle(card, "启用自动分析", "结束日记后整理任务、记忆和复盘候选。", this.plugin.settings.enableAutoAnalysis, async (value) => {
      this.plugin.settings.enableAutoAnalysis = value;
      await this.saveImmediate("自动分析设置已保存。");
    });
    this.toggle(card, "启用备考模块", "显示学习打卡、目标、任务和资料等备考入口。", this.plugin.settings.enableExamModule, async (value) => {
      this.plugin.settings.enableExamModule = value;
      await this.saveImmediate("备考模块设置已保存。");
    });
    this.select<ExamProfileType>(
      card,
      "备考类型 Profile",
      `当前：${getExamProfileLabel(this.plugin.settings)}。切换后会更新聊天辅导语境、打卡指标和学习任务类型。`,
      this.plugin.settings.examProfileType ?? "civil-service",
      EXAM_PROFILE_OPTIONS,
      async (value) => {
        this.plugin.settings.examProfileType = value;
        await this.saveImmediate("备考类型 Profile 已保存。");
        this.display();
      }
    );
    if (this.plugin.settings.examProfileType === "custom") {
      const row = this.row(card, "自定义考试名称", "例如：考 CPA、考雅思、考编。保存后会用于 Chat 辅导标签和 AI 提示。");
      const input = row.createEl("input", { cls: "lifeos-input", attr: { type: "text", placeholder: "例如：考 CPA" } });
      input.value = this.plugin.settings.customExamProfileName ?? "";
      input.onblur = async () => {
        this.plugin.settings.customExamProfileName = input.value.trim();
        await this.saveImmediate("自定义备考名称已保存。");
        this.display();
      };
    }
    this.info(card, "当前备考语境", `${getExamChatModeLabel(this.plugin.settings)}会用于 AI 助手，底层文件仍保存在稳定的 Exam / 备考目录下。`);
  }

  private renderThemeGallery(parent: HTMLElement): void {
    const current = normalizeThemeStyle(this.plugin.settings.themeStyle);
    const currentMeta = getUiThemeMeta(current);
    const currentFamily = currentMeta.family;
    const details = parent.createEl("details", {
      cls: "lifeos-setting-row lifeos-setting-row-vertical lifeos-theme-swatch-row lifeos-theme-swatch-details lifeos-theme-gallery-details"
    });
    details.open = false;
    const summary = details.createEl("summary", { cls: "lifeos-theme-swatch-summary" });
    const copy = summary.createSpan({ cls: "lifeos-theme-swatch-summary-copy" });
    copy.createSpan({ cls: "lifeos-setting-label", text: "主题画廊" });
    copy.createSpan({ cls: "lifeos-setting-description", text: "按家族查看主题，让布局、材质、间距和对比度差异一眼可见。" });
    const badges = summary.createSpan({ cls: "lifeos-theme-gallery-summary-badges" });
    badges.createSpan({ cls: "lifeos-badge lifeos-theme-swatch-current", attr: { "data-lifeos-theme-current": "true" }, text: this.themeShortLabel(current) });
    badges.createSpan({ cls: "lifeos-badge tone-blue lifeos-theme-family-current", attr: { "data-lifeos-theme-family-current": "true" }, text: this.themeFamilyLabel(currentFamily) });

    const panel = details.createDiv({ cls: "lifeos-theme-gallery-panel" });
    const familyTabs = panel.createDiv({ cls: "lifeos-theme-family-tabs", attr: { role: "tablist", "aria-label": "主题家族" } });
    const grid = panel.createDiv({ cls: "lifeos-theme-swatch-grid lifeos-theme-preview-grid" });

    for (const family of getUiThemeFamilies()) {
      const familyThemes = getUiThemesByFamily(family);
      const tab = familyTabs.createEl("button", {
        cls: ["lifeos-theme-family-tab", family === currentFamily ? "is-active" : ""].filter(Boolean).join(" "),
        attr: { type: "button", role: "tab", "aria-selected": family === currentFamily ? "true" : "false" }
      });
      tab.dataset.themeFamily = family;
      tab.createSpan({ cls: "lifeos-theme-family-tab-label", text: this.themeFamilyLabel(family) });
      tab.createSpan({ cls: "lifeos-theme-family-tab-count", text: `${familyThemes.length}` });
      tab.onclick = () => this.applyThemeFamilyFilter(family);

      for (const meta of familyThemes) {
        const button = grid.createEl("button", {
          cls: [
            "lifeos-theme-swatch",
            "lifeos-theme-preview-card",
            `is-${meta.id}`,
            current === meta.id ? "is-active" : "",
            family === currentFamily ? "" : "is-hidden"
          ].filter(Boolean).join(" "),
          attr: {
            type: "button",
            title: `${this.themeShortLabel(meta.id)} · ${this.themeFamilyLabel(meta.family)} · ${this.themeMaterialLabel(meta.material)}`
          }
        });
        button.hidden = family !== currentFamily;
        button.dataset.themeStyle = meta.id;
        button.dataset.themeFamily = meta.family;
        button.dataset.themeMaterial = meta.material;
        button.dataset.themeDensity = meta.density;
        this.applyThemePreviewVars(button, meta);

        const preview = button.createSpan({ cls: "lifeos-theme-swatch-preview lifeos-theme-preview-scene" });
        preview.createSpan({ cls: "lifeos-theme-preview-backdrop" });
        const shell = preview.createSpan({ cls: "lifeos-theme-preview-shell" });
        shell.createSpan({ cls: "lifeos-theme-preview-sidebar" });
        const stage = shell.createSpan({ cls: "lifeos-theme-preview-stage" });
        stage.createSpan({ cls: "lifeos-theme-preview-kicker" });
        stage.createSpan({ cls: "lifeos-theme-preview-card-surface" });
        stage.createSpan({ cls: "lifeos-theme-preview-button" });

        const content = button.createSpan({ cls: "lifeos-theme-swatch-copy lifeos-theme-preview-copy" });
        const titleRow = content.createSpan({ cls: "lifeos-theme-preview-title-row" });
        titleRow.createSpan({ cls: "lifeos-theme-swatch-title lifeos-theme-preview-title", text: this.themeShortLabel(meta.id) });
        if (meta.recommended) titleRow.createSpan({ cls: "lifeos-theme-preview-recommended", text: "推荐" });
        titleRow.createSpan({
          cls: meta.id === current ? "lifeos-theme-preview-selected is-visible" : "lifeos-theme-preview-selected",
          attr: { "data-lifeos-theme-selected": meta.id },
          text: meta.id === current ? "当前" : ""
        });
        content.createSpan({ cls: "lifeos-theme-swatch-desc lifeos-theme-preview-description", text: this.themePreviewDescription(meta.id) });

        const metaRow = content.createSpan({ cls: "lifeos-theme-preview-meta" });
        metaRow.createSpan({ cls: "lifeos-theme-preview-chip is-material", text: this.themeMaterialLabel(meta.material) });
        metaRow.createSpan({ cls: "lifeos-theme-preview-chip is-density", text: this.themeDensityLabel(meta.density) });

        const tokenRow = content.createSpan({ cls: "lifeos-theme-preview-token-row" });
        for (const [label, value] of [["A", meta.tokens.accent], ["S", meta.tokens.surfaceRaised], ["T", meta.tokens.text]] as const) {
          const swatch = tokenRow.createSpan({ cls: "lifeos-theme-preview-token", attr: { "aria-label": `${label} ${value}` } });
          swatch.dataset.themeTokenLabel = label;
          swatch.style.setProperty("--lifeos-preview-token-color", value);
        }

        button.onclick = async () => {
          const scrollSnapshot = this.captureScrollPositions();
          this.plugin.settings.themeStyle = meta.id;
          await this.saveImmediate(this.themeStyleNotice(meta.id));
          this.refreshThemeSelectionControls(meta.id);
          this.restoreScrollPositions(scrollSnapshot);
          this.keepElementVisible(parent);
        };
      }
    }

    this.applyThemeFamilyFilter(currentFamily);
  }

  private refreshThemeSelectionControls(value: ThemeStyle): void {
    const currentMeta = getUiThemeMeta(value);
    this.applyThemeFamilyFilter(currentMeta.family);
    this.containerEl.querySelectorAll<HTMLButtonElement>(".lifeos-theme-swatch, .lifeos-theme-preview-card, .lifeos-theme-quick-button").forEach((button) => {
      const isActive = button.dataset.themeStyle === value;
      button.toggleClass("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
    const themeSelect = this.containerEl.querySelector<HTMLSelectElement>("select.lifeos-theme-style-select");
    if (themeSelect) themeSelect.value = value;
    const themeDescription = this.containerEl.querySelector<HTMLElement>("[data-lifeos-setting-description='themeStyle']");
    if (themeDescription) themeDescription.setText(`当前：${this.themeStyleLabel(value)}。切换后立即生效。`);
    const themeCurrent = this.containerEl.querySelector<HTMLElement>("[data-lifeos-theme-current='true']");
    if (themeCurrent) themeCurrent.setText(this.themeShortLabel(value));
    const familyCurrent = this.containerEl.querySelector<HTMLElement>("[data-lifeos-theme-family-current='true']");
    if (familyCurrent) familyCurrent.setText(this.themeFamilyLabel(currentMeta.family));
    this.containerEl.querySelectorAll<HTMLElement>("[data-lifeos-theme-selected]").forEach((badge) => {
      const active = badge.dataset.lifeosThemeSelected === value;
      badge.toggleClass("is-visible", active);
      badge.setText(active ? "当前" : "");
    });
  }

  private applyThemePreviewVars(element: HTMLElement, meta: UiThemeMeta): void {
    element.style.setProperty("--lifeos-preview-accent", meta.tokens.accent);
    element.style.setProperty("--lifeos-preview-accent-2", meta.tokens.accent2);
    element.style.setProperty("--lifeos-preview-canvas", meta.tokens.canvas);
    element.style.setProperty("--lifeos-preview-surface", meta.tokens.surface);
    element.style.setProperty("--lifeos-preview-surface-raised", meta.tokens.surfaceRaised);
    element.style.setProperty("--lifeos-preview-border", meta.tokens.border);
    element.style.setProperty("--lifeos-preview-text", meta.tokens.text);
    element.style.setProperty("--lifeos-preview-muted", meta.tokens.muted);
    element.style.setProperty("--lifeos-preview-shadow", meta.tokens.shadow);
    element.style.setProperty("--lifeos-preview-radius", `${meta.tokens.radius}px`);
  }

  private applyThemeFamilyFilter(family: UiThemeFamily): void {
    this.containerEl.querySelectorAll<HTMLButtonElement>(".lifeos-theme-family-tab").forEach((button) => {
      const active = button.dataset.themeFamily === family;
      button.toggleClass("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    this.containerEl.querySelectorAll<HTMLElement>(".lifeos-theme-preview-card").forEach((card) => {
      const visible = card.dataset.themeFamily === family;
      card.hidden = !visible;
      card.toggleClass("is-hidden", !visible);
    });
  }

  private captureScrollPositions(): Array<{ element: HTMLElement; top: number; left: number }> {
    const positions: Array<{ element: HTMLElement; top: number; left: number }> = [];
    const seen = new Set<HTMLElement>();
    const candidates: HTMLElement[] = [];
    let element: HTMLElement | null = this.containerEl;
    while (element) {
      candidates.push(element);
      element = element.parentElement;
    }
    document
      .querySelectorAll<HTMLElement>(
        ".modal, .modal-content, .vertical-tab-content, .vertical-tab-content-container, .settings-container, .mod-settings"
      )
      .forEach((candidate) => candidates.push(candidate));

    for (const element of candidates) {
      if (seen.has(element)) continue;
      seen.add(element);
      if (
        element.scrollTop > 0 ||
        element.scrollLeft > 0 ||
        element.scrollHeight > element.clientHeight ||
        element.scrollWidth > element.clientWidth
      ) {
        positions.push({ element, top: element.scrollTop, left: element.scrollLeft });
      }
    }
    return positions;
  }

  private restoreScrollPositions(positions: Array<{ element: HTMLElement; top: number; left: number }>): void {
    const restore = () => {
      for (const { element, top, left } of positions) {
        element.scrollTop = top;
        element.scrollLeft = left;
      }
    };
    restore();
    requestAnimationFrame(restore);
    window.setTimeout(restore, 80);
    window.setTimeout(restore, 240);
  }

  private keepElementVisible(element: HTMLElement): void {
    const reveal = () => {
      const rect = element.getBoundingClientRect();
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const outsideVertically = rect.top < 72 || rect.bottom > viewportHeight - 72;
      const outsideHorizontally = rect.left < 12 || rect.right > viewportWidth - 12;
      if (outsideVertically || outsideHorizontally) {
        element.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    };
    requestAnimationFrame(reveal);
    window.setTimeout(reveal, 120);
  }

  private renderHeatmap(parent: HTMLElement): void {
    const card = this.section(parent, "成长热力图", "控制复盘页贡献日历的显示范围、语言和统计来源。", "calendar-range");
    this.select<HeatmapRange>(card, "显示范围", "复盘页热力图按周排列，方块不会被拉伸。", this.plugin.settings.heatmapRange ?? "1y", [["30d", "最近 30 天 / Last 30 days"], ["90d", "最近 90 天 / Last 90 days"], ["1y", "最近一年 / Last year"]], async (value) => {
      this.plugin.settings.heatmapRange = value;
      await this.saveImmediate(this.plugin.settings.language === "en" ? "Contribution settings saved." : "热力图设置已保存。");
    });
    this.select<DisplayLanguage>(card, "显示语言 / Display Language", "影响热力图标题、月份、星期、图例和提示文案。", this.plugin.settings.language ?? "zh", [["zh", "中文"], ["en", "English"]], async (value) => {
      this.plugin.settings.language = value;
      await this.saveImmediate(value === "en" ? "Display language updated." : "显示语言已更新。");
      this.display();
    });
    this.toggle(card, "统计日记记录", "日记会影响热力图活跃度。", this.plugin.settings.heatmapIncludeDaily, async (value) => {
      this.plugin.settings.heatmapIncludeDaily = value;
      await this.saveImmediate("热力图统计项已保存。");
    });
    this.toggle(card, "统计完成任务", "已完成任务会按完成日期计入。", this.plugin.settings.heatmapIncludeTasks, async (value) => {
      this.plugin.settings.heatmapIncludeTasks = value;
      await this.saveImmediate("热力图统计项已保存。");
    });
    this.toggle(card, "统计学习打卡", "学习打卡会计入当天活跃度。", this.plugin.settings.heatmapIncludeCheckins, async (value) => {
      this.plugin.settings.heatmapIncludeCheckins = value;
      await this.saveImmediate("热力图统计项已保存。");
    });
    this.toggle(card, "统计今日复盘", "每日复盘会计入当天活跃度。", this.plugin.settings.heatmapIncludeSummaries, async (value) => {
      this.plugin.settings.heatmapIncludeSummaries = value;
      await this.saveImmediate("热力图统计项已保存。");
    });
  }

  private validateAiDraft(): string {
    return validateAiProviderConfig(this.draft);
  }

  private providerStatusText(): string {
    const provider = PROVIDERS.find(([id]) => id === this.draft.aiProvider)?.[1] ?? this.draft.aiProvider;
    const error = this.validateAiDraft();
    return error ? `当前 Provider：${provider}，${error}` : `当前 Provider：${provider}，配置完整`;
  }

  private refreshAiProviderStatus(): void {
    if (!this.aiProviderStatusEl) return;
    const error = this.validateAiDraft();
    this.aiProviderStatusEl.setText(this.providerStatusText());
    this.aiProviderStatusEl.classList.toggle("is-warning", Boolean(error));
    this.aiProviderStatusEl.classList.toggle("is-ready", !error);
  }

  private normalizedAiDraft(): SettingsDraft {
    const aiApiKey = normalizeAiApiKeyInput(this.draft.aiApiKey);
    if (aiApiKey !== this.draft.aiApiKey) {
      this.draft.aiApiKey = aiApiKey;
    }
    const aiReasoningEffort =
      this.draft.aiReasoningEffort === "default" || requireProFeature(this.plugin, "aiReasoningEffort")
        ? this.draft.aiReasoningEffort
        : "default";
    if (aiReasoningEffort !== this.draft.aiReasoningEffort) {
      this.draft.aiReasoningEffort = aiReasoningEffort;
    }
    return { ...this.draft, aiApiKey, aiReasoningEffort };
  }

  private async testConnection(): Promise<void> {
    const error = this.validateAiDraft();
    if (error) {
      new Notice(`AI 连接测试失败：${error}`);
      return;
    }

    const snapshot = {
      aiProvider: this.plugin.settings.aiProvider,
      aiBaseUrl: this.plugin.settings.aiBaseUrl,
      aiModel: this.plugin.settings.aiModel,
      aiApiKey: this.plugin.settings.aiApiKey,
      aiEndpointPath: this.plugin.settings.aiEndpointPath,
      aiAuthHeader: this.plugin.settings.aiAuthHeader,
      aiAuthPrefix: this.plugin.settings.aiAuthPrefix,
      aiReasoningEffort: this.plugin.settings.aiReasoningEffort,
      aiApiKeys: { ...(this.plugin.settings.aiApiKeys ?? {}) }
    };

    try {
      const draft = this.normalizedAiDraft();
      const requestedModel = draft.aiModel.trim();
      Object.assign(this.plugin.settings, draft);
      setStoredAiApiKey(this.plugin.settings, draft.aiProvider, draft.aiApiKey);
      const models = await this.plugin.ai.listModels();
      if (models.length > 0) {
        const analysis = analyzeAiConnectionTestModels({ ...this.plugin.settings, ...draft }, models);
        if (analysis.shouldAutoApply && analysis.suggestedModel && analysis.suggestedModel !== requestedModel) {
          this.draft.aiModel = analysis.suggestedModel;
          this.dirty = true;
          new Notice(`AI 连接测试成功：已自动选择可用模型 ${analysis.suggestedModel}。点击“保存设置”后生效。`, 7000);
          this.display();
          return;
        }
        if (analysis.matchedModel) {
          new Notice(`AI 连接测试成功：已找到当前模型 ${analysis.matchedModel}`);
          return;
        }

        const suggestion = analysis.suggestedModel ? `模型列表当前更像支持 ${analysis.suggestedModel}` : "模型列表暂时没有返回可确认的候选模型";
        const currentModelHint = requestedModel ? `当前高级设置里的模型 ${requestedModel} 会原样保留，不会自动改写你的高级设置。` : "当前没有填写模型名称，请按返回列表补一个可用模型。";
        new Notice(`AI 连接测试成功：已连通，但模型列表未找到当前模型。${suggestion}。${currentModelHint}`, 9000);
        return;
      }

      const probe = await this.plugin.ai.complete({
        messages: [
          { role: "system", content: "You are a connectivity probe. Reply with OK only." },
          { role: "user", content: "Reply with OK." }
        ],
        temperature: 0
      });
      if (probe.ok) {
        new Notice("AI 连接测试成功：模型列表未返回，但实际对话请求已通过。");
        return;
      }

      new Notice(`AI 连接测试失败：${probe.error ?? "未通过模型列表或对话握手测试。"}`);
    } catch (connectionError) {
      const message = connectionError instanceof Error ? connectionError.message : String(connectionError);
      new Notice(`AI 连接测试失败：${message}`);
    } finally {
      this.plugin.settings.aiProvider = snapshot.aiProvider;
      this.plugin.settings.aiBaseUrl = snapshot.aiBaseUrl;
      this.plugin.settings.aiModel = snapshot.aiModel;
      this.plugin.settings.aiApiKey = snapshot.aiApiKey;
      this.plugin.settings.aiEndpointPath = snapshot.aiEndpointPath;
      this.plugin.settings.aiAuthHeader = snapshot.aiAuthHeader;
      this.plugin.settings.aiAuthPrefix = snapshot.aiAuthPrefix;
      this.plugin.settings.aiReasoningEffort = snapshot.aiReasoningEffort;
      this.plugin.settings.aiApiKeys = snapshot.aiApiKeys;
    }
  }

  private async saveAll(): Promise<void> {
    const draft = this.normalizedAiDraft();
    setStoredAiApiKey(this.plugin.settings, draft.aiProvider, draft.aiApiKey);
    setStoredAiProviderConfig(this.plugin.settings, draft.aiProvider, {
      baseUrl: draft.aiBaseUrl,
      model: draft.aiModel,
      endpointPath: draft.aiEndpointPath,
      authHeader: draft.aiAuthHeader,
      authPrefix: draft.aiAuthPrefix
    });
    Object.assign(this.plugin.settings, draft);
    await this.plugin.saveSettings();
    // The Weixin assistant owns a FileSystemService created from the configured
    // Life OS root. Recreate it so root/language changes take effect now.
    await this.plugin.refreshWeixinConnection();
    this.dirty = false;
    this.plugin.applyTheme();
    new Notice("Life OS 设置已保存。");
    this.display();
  }

  private async restoreDefaults(): Promise<void> {
    if (!window.confirm("确认恢复默认设置吗？当前 API Key 和目录配置会被重置，授权码和安装 ID 会保留。")) return;
    const preservedLicense = {
      licenseApiBaseUrl: this.plugin.settings.licenseApiBaseUrl,
      licenseInstallationId: this.plugin.settings.licenseInstallationId,
      licenseEmail: this.plugin.settings.licenseEmail,
      licenseKey: this.plugin.settings.licenseKey,
      licenseEntitlementToken: this.plugin.settings.licenseEntitlementToken,
      licenseSnapshot: this.plugin.settings.licenseSnapshot,
      licenseLastOrderId: this.plugin.settings.licenseLastOrderId,
      licenseLastOrderClaimToken: this.plugin.settings.licenseLastOrderClaimToken,
      licenseLastOrderSnapshot: this.plugin.settings.licenseLastOrderSnapshot,
      licenseLastPaymentSnapshot: this.plugin.settings.licenseLastPaymentSnapshot,
      licenseLastCheckedAt: this.plugin.settings.licenseLastCheckedAt
    };
    const preservedBrowserCapture = { browserCaptureToken: this.plugin.settings.browserCaptureToken };
    this.plugin.settings = {
      ...DEFAULT_SETTINGS,
      ...preservedLicense,
      ...preservedBrowserCapture,
      aiApiKeys: { ...DEFAULT_SETTINGS.aiApiKeys },
      aiProviderConfigs: { ...DEFAULT_SETTINGS.aiProviderConfigs },
      reportTopics: [...DEFAULT_SETTINGS.reportTopics],
      weixinApprovedSenders: [],
      weixinAllowedGroups: [],
      weixinPendingPairings: [],
      weixinConversationRoutes: [],
      weixinReminderRoutes: []
    };
    await this.plugin.saveSettings();
    this.resetDraft();
    this.plugin.applyTheme();
    await this.plugin.refreshBrowserCaptureBridge();
    await this.plugin.refreshWeixinConnection();
    new Notice("已恢复默认设置。");
    this.display();
  }

  private resetDraft(): void {
    this.draft = {
      rootFolder: this.plugin.settings.rootFolder,
      systemName: this.plugin.settings.systemName,
      assistantName: this.plugin.settings.assistantName,
      aiProvider: this.plugin.settings.aiProvider,
      aiApiKey: getStoredAiApiKey(this.plugin.settings, this.plugin.settings.aiProvider),
      aiBaseUrl: this.plugin.settings.aiBaseUrl,
      aiModel: this.plugin.settings.aiModel,
      visionAiModel: this.plugin.settings.visionAiModel ?? "",
      aiEndpointPath: this.plugin.settings.aiEndpointPath,
      aiAuthHeader: this.plugin.settings.aiAuthHeader,
      aiAuthPrefix: this.plugin.settings.aiAuthPrefix,
      aiReasoningEffort: this.plugin.settings.aiReasoningEffort ?? "default"
    };
    this.dirty = false;
  }

  private getDraftAiProviderConfig() {
    return {
      baseUrl: this.draft.aiBaseUrl,
      model: this.draft.aiModel,
      endpointPath: this.draft.aiEndpointPath,
      authHeader: this.draft.aiAuthHeader,
      authPrefix: this.draft.aiAuthPrefix
    };
  }

  private applyProvider(provider: AiProviderType): void {
    setStoredAiApiKey(this.plugin.settings, this.draft.aiProvider, this.draft.aiApiKey);
    setStoredAiProviderConfig(this.plugin.settings, this.draft.aiProvider, this.getDraftAiProviderConfig());
    this.draft.aiProvider = provider;
    this.draft.aiApiKey = getStoredAiApiKey(this.plugin.settings, provider);
    const providerConfig = getStoredAiProviderConfig(this.plugin.settings, provider);
    if (providerConfig) {
      this.draft.aiBaseUrl = providerConfig.baseUrl;
      this.draft.aiEndpointPath = providerConfig.endpointPath;
      this.draft.aiAuthHeader = providerConfig.authHeader;
      this.draft.aiAuthPrefix = providerConfig.authPrefix;
      this.draft.aiModel = providerConfig.model;
    }
    this.dirty = true;
  }

  private setDraft(key: keyof SettingsDraft, value: string): void {
    this.draft[key] = value as never;
    this.dirty = true;
    if (key.startsWith("ai")) {
      this.refreshAiProviderStatus();
    }
  }

  private async saveImmediate(message: string): Promise<void> {
    await this.plugin.saveSettings();
    this.plugin.applyTheme();
    new Notice(message);
  }

  private section(parent: HTMLElement, title: string, description: string, icon: string): HTMLElement {
    const card = parent.createDiv({ cls: "lifeos-settings-card" });
    const sectionClass = SETTINGS_SECTION_CLASSES[title];
    if (sectionClass) card.addClass(sectionClass);
    const definition = SETTINGS_SECTION_BY_TITLE.get(title);
    if (definition) card.dataset.settingsSection = definition.id;
    const head = card.createDiv({ cls: "lifeos-settings-card-header" });
    const iconEl = head.createSpan({ cls: "lifeos-settings-card-icon" });
    setIcon(iconEl, icon);
    const copy = head.createDiv();
    new Setting(copy).setName(title).setHeading();
    copy.createEl("p", { text: description });
    return card;
  }

  private row(parent: HTMLElement, label: string, description: string): HTMLElement {
    const row = parent.createDiv({ cls: "lifeos-setting-row lifeos-setting-row-vertical" });
    row.createDiv({ cls: "lifeos-setting-label", text: label });
    row.createDiv({ cls: "lifeos-setting-description", text: description });
    return row;
  }

  private text(parent: HTMLElement, label: string, description: string, value: string, onChange: (value: string) => void, password = false): HTMLInputElement {
    const row = this.row(parent, label, description);
    const input = row.createEl("input", { cls: "lifeos-input", attr: { type: password ? "password" : "text" } });
    input.value = value;
    input.oninput = () => onChange(input.value);
    return input;
  }

  private passwordText(parent: HTMLElement, label: string, description: string, value: string, onChange: (value: string) => void): void {
    const row = this.row(parent, label, description);
    const wrap = row.createDiv({ cls: "lifeos-password-row" });
    const input = wrap.createEl("input", { cls: "lifeos-input", attr: { type: "password" } });
    input.value = value;
    input.oninput = () => onChange(input.value);
    input.onblur = () => {
      const normalized = normalizeAiApiKeyInput(input.value);
      if (normalized !== input.value) {
        input.value = normalized;
        onChange(normalized);
      }
    };
    const toggle = wrap.createEl("button", { cls: "lifeos-button lifeos-button-ghost", text: "显示", attr: { type: "button" } });
    toggle.onclick = () => {
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      toggle.setText(showing ? "显示" : "隐藏");
    };
  }

  private select<T extends string>(
    parent: HTMLElement,
    label: string,
    description: string,
    value: T,
    options: Array<[T, string]>,
    onChange: (value: T) => Promise<void>,
    className = ""
  ): HTMLSelectElement {
    const row = this.row(parent, label, description);
    if (className === "lifeos-theme-style-select") {
      row.addClass("lifeos-theme-style-row");
      row.querySelector<HTMLElement>(".lifeos-setting-description")?.setAttr("data-lifeos-setting-description", "themeStyle");
    }
    const select = row.createEl("select", { cls: ["lifeos-input", className].filter(Boolean).join(" ") });
    for (const [optionValue, optionLabel] of options) select.createEl("option", { value: optionValue, text: optionLabel });
    select.value = value;
    select.onchange = () => void onChange(select.value as T);
    return select;
  }

  private toggle(parent: HTMLElement, label: string, description: string, value: boolean, onChange: (value: boolean) => Promise<void>): void {
    const row = this.row(parent, label, description);
    const toggle = row.createEl("label", { cls: "lifeos-toggle-card" });
    const input = toggle.createEl("input", { attr: { type: "checkbox" } });
    input.checked = value;
    const status = toggle.createSpan({ text: value ? "开启" : "关闭" });
    input.onchange = () => {
      status.setText(input.checked ? "开启" : "关闭");
      void onChange(input.checked);
    };
  }

  private info(parent: HTMLElement, label: string, description: string): void {
    const row = parent.createDiv({ cls: "lifeos-setting-row lifeos-setting-row-vertical lifeos-setting-status-row" });
    row.createDiv({ cls: "lifeos-setting-label", text: label });
    row.createDiv({ cls: "lifeos-setting-description", text: description });
    row.createSpan({ cls: "lifeos-badge tone-blue lifeos-status-badge", text: "已启用" });
  }

  private button(parent: HTMLElement, text: string, onClick: () => void, primary = false, className = ""): HTMLButtonElement {
    const button = parent.createEl("button", { cls: ["lifeos-button", primary ? "lifeos-button-primary" : "lifeos-button-ghost", className].filter(Boolean).join(" "), attr: { type: "button" }, text });
    button.onclick = onClick;
    return button;
  }

  private themeShortLabel(value: ThemeStyle): string {
    return this.themeStyleLabel(value).split(" / ")[0];
  }

  private themePreviewDescription(value: ThemeStyle): string {
    if (this.plugin.settings.language === "en") return getUiThemeMeta(value).description;
    if (value === "minimal-warm") return "默认舒适";
    if (value === "soft-saas") return "清爽工具";
    if (value === "obsidian") return "融入原生";
    if (value === "compact") return "高密浏览";
    if (value === "codex-light") return "白底黑字";
    if (value === "codex-dark") return "黑底浅字";
    if (value === "liquid-glass") return "通透现代";
    if (value === "refractive-glass") return "折射高光";
    if (value === "mesh-sunset") return "橙粉日落";
    if (value === "mesh-aurora") return "蓝紫极光";
    if (value === "mesh-mint") return "青绿透亮";
    if (value === "mesh-deep-blue") return "蓝白清冷";
    if (value === "blue-white-gradient") return "白底蓝调";
    if (value === "mesh-dreamy") return "粉紫柔光";
    if (value === "mesh-sea-mist") return "海盐雾感";
    if (value === "focus-ink") return "写作深读";
    if (value === "exam-green") return "学习刷题";
    if (value === "research-cobalt") return "知识论文";
    if (value === "creator-coral") return "灵感输出";
    if (value === "finance-graphite") return "记账统计";
    if (value === "family-orchard") return "生活记录";
    if (value === "night-owl") return "夜间护眼";
    if (value === "midnight-terminal") return "终端夜色";
    if (value === "mood-lavender") return "复盘陪伴";
    if (value === "field-notes") return "移动快记";
    if (value === "studio-mono") return "清晰利落";
    if (value === "anime-sakura") return "轻柔动漫";
    if (value === "anime-cyber-pop") return "霓虹活力";
    if (value === "anime-moonlit") return "低光沉浸";
    if (value === "anime-sunrise") return "明亮热情";
    if (value === "anime-shonen-flame") return "冲刺行动";
    if (value === "business-navy") return "会议汇报";
    if (value === "business-slate") return "稳重管理";
    if (value === "brutalist-signal") return "工业指令";
    if (value === "academic-paper") return "读书论文";
    if (value === "academic-ink") return "研究写作";
    if (value === "editorial-sand") return "纸刊编辑";
    if (value === "apple-frosted") return "轻盈半透";
    return getUiThemeMeta(value).description;
  }

  private themeFamilyLabel(value: UiThemeFamily): string {
    if (value === "glass") return "玻璃";
    if (value === "warm") return "温暖";
    if (value === "dark") return "深色";
    if (value === "business") return "商务";
    if (value === "notes") return "纸面";
    if (value === "playful") return "个性";
    return "专注";
  }

  private themeMaterialLabel(value: UiThemeMaterial): string {
    if (value === "glass") return "玻璃";
    if (value === "mesh") return "Mesh";
    if (value === "matte") return "哑光";
    if (value === "paper") return "纸面";
    if (value === "solid") return "实体";
    return "墨色";
  }

  private themeDensityLabel(value: UiThemeDensity): string {
    if (value === "compact") return "紧凑";
    if (value === "airy") return "舒展";
    return "标准";
  }

  private themeStyleLabel(value: ThemeStyle): string {
    if (value === "minimal-warm") return "简约温馨";
    if (value === "compact") return "紧凑模式";
    if (value === "obsidian") return "Obsidian 原生";
    if (value === "codex-light") return "白昼 / Light";
    if (value === "codex-dark") return "夜幕 / Dark";
    if (value === "liquid-glass") return "液态玻璃 / Liquid Glass";
    if (value === "refractive-glass") return "折射玻璃 / Refractive Glass";
    if (value === "mesh-sunset") return "暖日霞 / Mesh Sunset";
    if (value === "mesh-aurora") return "极光紫 / Mesh Aurora";
    if (value === "mesh-mint") return "薄荷光 / Mesh Mint";
    if (value === "mesh-deep-blue") return "深空蓝 / Mesh Deep Blue";
    if (value === "blue-white-gradient") return "蓝白渐变 / Blue White Gradient";
    if (value === "mesh-dreamy") return "梦境粉紫 / Mesh Dreamy";
    if (value === "mesh-sea-mist") return "海雾青 / Mesh Sea Mist";
    if (value === "focus-ink") return "专注墨色 / Focus Ink";
    if (value === "exam-green") return "备考松绿 / Exam Green";
    if (value === "research-cobalt") return "研究钴蓝 / Research Cobalt";
    if (value === "creator-coral") return "创作珊瑚 / Creator Coral";
    if (value === "finance-graphite") return "数据石墨 / Finance Graphite";
    if (value === "family-orchard") return "家庭果园 / Family Orchard";
    if (value === "night-owl") return "夜航低光 / Night Owl";
    if (value === "midnight-terminal") return "终端夜幕 / Midnight Terminal";
    if (value === "mood-lavender") return "情绪柔雾 / Mood Lavender";
    if (value === "field-notes") return "外勤手账 / Field Notes";
    if (value === "studio-mono") return "高对比工坊 / Studio Mono";
    if (value === "anime-sakura") return "樱花晨光 / Anime Sakura";
    if (value === "anime-cyber-pop") return "赛博电光 / Anime Cyber Pop";
    if (value === "anime-moonlit") return "月夜物语 / Anime Moonlit";
    if (value === "anime-sunrise") return "动漫朝阳 / Anime Sunrise";
    if (value === "anime-shonen-flame") return "少年热血 / Anime Shonen Flame";
    if (value === "business-navy") return "商务海军蓝 / Business Navy";
    if (value === "business-slate") return "商务石板灰 / Business Slate";
    if (value === "brutalist-signal") return "工业信号 / Brutalist Signal";
    if (value === "academic-paper") return "学术纸页 / Academic Paper";
    if (value === "academic-ink") return "学术墨色 / Academic Ink";
    if (value === "editorial-sand") return "编辑沙页 / Editorial Sand";
    if (value === "apple-frosted") return "苹果毛玻璃 / Apple Frosted";
    return "浅紫 SaaS";
  }

  private themeStyleNotice(value: ThemeStyle): string {
    if (this.plugin.settings.language === "en") {
      return `Switched to ${this.themeStyleEnglishLabel(value)} theme`;
    }
    return `已切换为${this.themeStyleLabel(value).split(" / ")[0]}主题`;
  }

  private themeStyleEnglishLabel(value: ThemeStyle): string {
    const label = this.themeStyleLabel(value);
    return label.includes(" / ") ? label.split(" / ")[1] : label;
  }
}
