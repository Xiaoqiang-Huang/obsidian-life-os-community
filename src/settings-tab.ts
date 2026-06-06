import { App, Notice, PluginSettingTab, setIcon } from "obsidian";
import PersonalLifeSystemPlugin from "./main";
import type { AiProviderType, AssistantStyle, AssistantVerbosity, ChatContextMode, ChatMode, ChatSendBehavior, DirectoryLanguage, DisplayLanguage, ExamProfileType, HeatmapRange, LlmWikiCompileDepth, LlmWikiLongMaterialMode, LlmWikiSensitiveDefault, ThemeStyle } from "./settings";
import { analyzeAiConnectionTestModels, DEFAULT_SETTINGS, EXAM_PROFILE_OPTIONS, getAiProviderPreset, getExamChatModeLabel, getExamProfileLabel, getStoredAiApiKey, getStoredAiProviderConfig, getThemeStyleClasses, normalizeAiApiKeyInput, normalizeThemeStyle, setStoredAiApiKey, setStoredAiProviderConfig, THEME_STYLES, validateAiProviderConfig } from "./settings";
import { resolveLicenseStatus } from "./licensing/entitlement";
import { AI_SKILL_CATEGORIES, createImportedAiSkills, getAiSkills, getAiSkillsByCategory, normalizeAiSkillIds } from "./services/AiSkillService";
import { getUiThemeFamilies, getUiThemeMeta, getUiThemesByFamily } from "./ui/theme";
import type { UiThemeDensity, UiThemeFamily, UiThemeMaterial, UiThemeMeta } from "./ui/types";
import { installLifeOSResponsiveShell } from "./utils/responsive-shell";

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
}

export class PersonalLifeSystemSettingTab extends PluginSettingTab {
  private draft!: SettingsDraft;
  private dirty = false;
  private aiProviderStatusEl: HTMLElement | null = null;

  constructor(app: App, private plugin: PersonalLifeSystemPlugin) {
    super(app, plugin);
    this.resetDraft();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("lifeos-settings");
    installLifeOSResponsiveShell(containerEl);
    containerEl.removeClass(...THEME_STYLES.map((style) => `lifeos-theme-${style}`));
    for (const cls of getThemeStyleClasses(this.plugin.settings.themeStyle ?? "minimal-warm")) {
      containerEl.addClass(cls);
    }

    const header = containerEl.createDiv({ cls: "lifeos-settings-hero" });
    header.createDiv({ cls: "lifeos-kicker", text: "Life OS Settings" });
    header.createEl("h1", { text: "设置中心" });
    header.createEl("p", { text: "管理本地数据、AI 模型、Chat 人格 Skill、写入确认和复盘热力图。" });
    const actions = header.createDiv({ cls: "lifeos-settings-actions" });
    this.button(actions, "测试连接", () => void this.testConnection(), true);
    this.button(actions, this.dirty ? "保存设置（有未保存更改）" : "保存设置", () => void this.saveAll(), false, this.dirty ? "lifeos-button-primary" : "");
    this.button(actions, "恢复默认", () => void this.restoreDefaults(), false, "lifeos-button-danger");

    const grid = containerEl.createDiv({ cls: "lifeos-settings-grid" });
    this.renderBasics(grid);
    this.renderAi(grid);
    this.renderChatAi(grid);
    this.renderSafety(grid);
    this.renderProLicense(grid);
    this.renderLlmWiki(grid);
    this.renderExperience(grid);
    this.renderHeatmap(grid);
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
  }

  private renderChatAi(parent: HTMLElement): void {
    const card = this.section(parent, "Chat / AI 助手", "选择默认名人 Skill 组合、回复偏好和发送方式。仅内置精选公开方法论；不含在世中国公众人物、刚去世中国人物、万能角色生成器和猎奇 Skill。", "message-circle");
    const importedSkills = createImportedAiSkills(this.plugin.settings.importedAiSkills);
    const selectedIds = normalizeAiSkillIds(this.plugin.settings.defaultAiSkillIds, this.plugin.settings.defaultAiSkillId, importedSkills);
    this.plugin.settings.defaultAiSkillIds = selectedIds;
    this.plugin.settings.defaultAiSkillId = selectedIds[0] ?? "lifeos-general";

    const skillBlock = card.createDiv({ cls: "lifeos-setting-row lifeos-setting-row-vertical" });
    skillBlock.createDiv({ cls: "lifeos-setting-label", text: "默认名人 Skill（可多选）" });
    skillBlock.createDiv({ cls: "lifeos-setting-description", text: `当前组合：${getAiSkills(selectedIds, importedSkills).map((skill) => skill.name).join(" + ")}` });
    const skillDetails = skillBlock.createEl("details", { cls: "lifeos-settings-skill-details" });
    skillDetails.createEl("summary", { text: "展开选择名人 Skill" });
    for (const category of AI_SKILL_CATEGORIES) {
      const skills = getAiSkillsByCategory(category.id, importedSkills);
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
          const next = new Set(normalizeAiSkillIds(this.plugin.settings.defaultAiSkillIds, this.plugin.settings.defaultAiSkillId, importedSkills));
          if (checkbox.checked) next.add(item.id);
          else next.delete(item.id);
          this.plugin.settings.defaultAiSkillIds = normalizeAiSkillIds(Array.from(next), undefined, importedSkills);
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
    this.toggle(card, "默认开启记入", "开启后，AI 整理结果会先进入预览，确认后才写入日记、知识库或记忆。", this.plugin.settings.autoApplyChatToDaily, async (value) => {
      this.plugin.settings.autoApplyChatToDaily = value;
      await this.saveImmediate("默认记入设置已保存。");
    });
    this.toggle(card, "启用图片视觉分析", "开启后，AI 助手可把图片附件发送给支持视觉的模型；未开启时图片只作为附件记录，不做识别。", this.plugin.settings.enableVisionFileAnalysis === true, async (value) => {
      this.plugin.settings.enableVisionFileAnalysis = value;
      await this.saveImmediate("图片视觉分析设置已保存。");
    });
    const visionInput = this.text(card, "视觉模型", "用于图片识别的模型名。未填写时图片识别不可用；请确认你的 API 和模型支持视觉输入。", this.draft.visionAiModel, (value) => this.setDraft("visionAiModel", value));
    visionInput.onblur = async () => {
      this.plugin.settings.visionAiModel = visionInput.value.trim();
      await this.saveImmediate("视觉模型设置已保存。");
    };
  }

  private renderSafety(parent: HTMLElement): void {
    const card = this.section(parent, "数据安全", "这些能力是 Life OS 的默认写入确认和数据保护提示，因此以状态展示。", "shield-check");
    this.info(card, "本地保存", `已启用：所有内容都保存在你的 Vault：${this.plugin.getRoot()}`);
    this.info(card, "AI 写回确认", "已启用：AI 内容会先进入预览，确认后才写入日记、知识库或记忆。" );
    this.info(card, "长期记忆需确认", "已启用：候选记忆必须人工确认后才进入正式分类记忆。" );
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
    this.renderThemeGallery(card);
  }

  private renderThemeGallery(parent: HTMLElement): void {
    const current = normalizeThemeStyle(this.plugin.settings.themeStyle);
    const currentMeta = getUiThemeMeta(current);
    const currentFamily = currentMeta.family;
    const details = parent.createEl("details", {
      cls: "lifeos-setting-row lifeos-setting-row-vertical lifeos-theme-swatch-row lifeos-theme-swatch-details lifeos-theme-gallery-details"
    });
    details.open = true;
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
    this.containerEl.querySelectorAll<HTMLButtonElement>(".lifeos-theme-swatch, .lifeos-theme-preview-card").forEach((button) => {
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
    return { ...this.draft, aiApiKey };
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
    this.plugin.settings = {
      ...DEFAULT_SETTINGS,
      ...preservedLicense,
      aiApiKeys: { ...DEFAULT_SETTINGS.aiApiKeys },
      aiProviderConfigs: { ...DEFAULT_SETTINGS.aiProviderConfigs },
      reportTopics: [...DEFAULT_SETTINGS.reportTopics]
    };
    await this.plugin.saveSettings();
    this.resetDraft();
    this.plugin.applyTheme();
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
      aiAuthPrefix: this.plugin.settings.aiAuthPrefix
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
    const head = card.createDiv({ cls: "lifeos-settings-card-header" });
    const iconEl = head.createSpan({ cls: "lifeos-settings-card-icon" });
    setIcon(iconEl, icon);
    const copy = head.createDiv();
    copy.createEl("h2", { text: title });
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
    if (value === "liquid-glass") return "通透现代";
    if (value === "mesh-sunset") return "橙粉日落";
    if (value === "mesh-aurora") return "蓝紫极光";
    if (value === "mesh-mint") return "青绿透亮";
    if (value === "mesh-deep-blue") return "蓝白清冷";
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
    if (value === "liquid-glass") return "液态玻璃 / Liquid Glass";
    if (value === "mesh-sunset") return "暖日霞 / Mesh Sunset";
    if (value === "mesh-aurora") return "极光紫 / Mesh Aurora";
    if (value === "mesh-mint") return "薄荷光 / Mesh Mint";
    if (value === "mesh-deep-blue") return "深空蓝 / Mesh Deep Blue";
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
