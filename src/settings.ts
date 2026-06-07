import type { LicenseStateSnapshot } from "./licensing/license-types";
import type { ImportedAiSkillRecord } from "./services/AiSkillService";

export type AiProviderType =
  | "auto"
  | "openai"
  | "openai-compatible"
  | "anthropic-compatible"
  | "ollama"
  | "deepseek"
  | "glm"
  | "qwen"
  | "kimi"
  | "hunyuan"
  | "doubao";

export interface AiProviderPreset {
  label: string;
  baseUrl: string;
  endpointPath: string;
  model: string;
  authHeader: string;
  authPrefix: string;
  modelSuggestions: string[];
  note: string;
}

export interface AiProviderValidationInput {
  aiProvider: AiProviderType;
  aiApiKey: string;
  aiBaseUrl: string;
  aiModel: string;
}

export interface AiProviderOption {
  id: AiProviderType;
  label: string;
  model: string;
  configured: boolean;
  active: boolean;
}

export interface AiProviderStoredConfig {
  baseUrl: string;
  model: string;
  endpointPath: string;
  authHeader: string;
  authPrefix: string;
}

export const AI_PROVIDER_OPTIONS: Array<[AiProviderType, string]> = [
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

export type ChatSaveMode = "none" | "summary" | "full";
export type AssistantStyle =
  | "warm-companion"
  | "concise-executor"
  | "strict-coach"
  | "exam-tutor"
  | "four-sages"
  | "custom";
export type AssistantVerbosity = "brief" | "normal" | "detailed";
export type ChatMode = "chat" | "diary" | "review" | "exam";
export type ChatContextMode = "smart" | "semantic" | "global";
export type ChatSendBehavior = "enterToSend" | "modEnterToSend";
export type ThemePreset = "cool" | "dark-tech" | "wabi" | "pastel";
export const THEME_STYLES = [
  "minimal-warm",
  "soft-saas",
  "obsidian",
  "compact",
  "liquid-glass",
  "mesh-sunset",
  "mesh-aurora",
  "mesh-mint",
  "mesh-deep-blue",
  "mesh-dreamy",
  "mesh-sea-mist",
  "focus-ink",
  "exam-green",
  "research-cobalt",
  "creator-coral",
  "finance-graphite",
  "family-orchard",
  "night-owl",
  "midnight-terminal",
  "mood-lavender",
  "field-notes",
  "studio-mono",
  "anime-sakura",
  "anime-cyber-pop",
  "anime-moonlit",
  "anime-sunrise",
  "anime-shonen-flame",
  "business-navy",
  "business-slate",
  "brutalist-signal",
  "academic-paper",
  "academic-ink",
  "editorial-sand",
  "apple-frosted"
] as const;

export type ThemeStyle = typeof THEME_STYLES[number];
const LIQUID_GLASS_DERIVED_THEME_STYLES = new Set<ThemeStyle>([
  "liquid-glass",
  "mesh-sunset",
  "mesh-aurora",
  "mesh-mint",
  "mesh-deep-blue",
  "mesh-dreamy",
  "mesh-sea-mist",
  "focus-ink",
  "exam-green",
  "research-cobalt",
  "creator-coral",
  "finance-graphite",
  "family-orchard",
  "night-owl",
  "mood-lavender",
  "field-notes",
  "studio-mono",
  "anime-sakura",
  "anime-cyber-pop",
  "anime-moonlit",
  "anime-sunrise",
  "anime-shonen-flame",
  "business-navy",
  "business-slate",
  "academic-paper",
  "academic-ink"
]);
export type ViewLayout = "main" | "sidebar";
export type UiFrameworkVersion = "legacy" | "v2";
export type UiPageFrameworkOverride = "legacy" | "v2";
export const UI_PAGE_KEYS = [
  "shell",
  "sidebar",
  "settings",
  "dashboard",
  "tasks",
  "daily",
  "review",
  "checkin",
  "knowledge",
  "chat",
  "proLicense",
  "proCompare",
  "userGuide",
  "writebackModal"
] as const;
export type UiPageKey = typeof UI_PAGE_KEYS[number];

export interface UiFrameworkSettings {
  version: UiFrameworkVersion;
  pageOverrides: Partial<Record<UiPageKey, UiPageFrameworkOverride>>;
}

export interface UiMigrationStateRule {
  page: UiPageKey;
  requires?: UiPageKey[];
  reason: string;
}

export type HeatmapRange = "30d" | "90d" | "1y";
export type DisplayLanguage = "zh" | "en";
export type LlmWikiCompileDepth = "light" | "standard" | "deep";
export type LlmWikiLongMaterialMode = "ask" | "quick" | "deep" | "save-only";
export type LlmWikiSensitiveDefault = "local-only" | "ask" | "allow";
export type DirectoryLanguage = "zh" | "en";
export type ExamProfileType = "civil-service" | "postgraduate" | "law" | "teacher" | "custom";

export interface ExamMetricProfile {
  field: "xingce_questions" | "interview_practice";
  label: string;
  unit: string;
}

export interface ExamProfilePreset {
  type: ExamProfileType;
  label: string;
  moduleLabel: string;
  chatModeLabel: string;
  assistantPrompt: string;
  metrics: ExamMetricProfile[];
  taskTypeOptions: Array<[string, string]>;
}

export const EXAM_PROFILE_OPTIONS: Array<[ExamProfileType, string]> = [
  ["civil-service", "考公"],
  ["postgraduate", "考研"],
  ["law", "法考"],
  ["teacher", "教资"],
  ["custom", "自定义备考"]
];

export const CIVIL_SERVICE_INTERVIEW_THINKING_MODEL_PROMPT = [
  "考公面试使用“输入问题-处理实操-输出闭环”的软工拆题模型。",
  "输入问题：政策不会凭空出现，先拆现实矛盾、政策背景、群众需求、资源约束和风险变化。遇到“小而美”这类题，先说明它在回应同质化、大拆大建、消费逻辑变化等真实问题。",
  "处理实操：不要只喊口号，要讲清楚这个模式怎么跑起来。先识别本地特色和真实场景，再用轻开发、微更新、低成本改造形成可执行动作，最后设计长运营机制，例如内容更新、数字传播、主体协同和复盘改进。",
  "输出闭环：不要只说促进发展，要说清群众获得什么、基层留下什么、风险如何降低。文旅题可落到游客获得情绪体验、村民获得持续收入、乡村保留文化生命力、年轻人愿意返乡。",
  "评价答案时，重点看是否形成“问题来源 → 运转机制 → 多方收益”的闭环，而不是堆金句。"
].join("\n");

export function getCivilServiceInterviewThinkingModelPrompt(): string {
  return CIVIL_SERVICE_INTERVIEW_THINKING_MODEL_PROMPT;
}

const EXAM_PROFILE_PRESETS: Record<ExamProfileType, ExamProfilePreset> = {
  "civil-service": {
    type: "civil-service",
    label: "考公",
    moduleLabel: "备考模块",
    chatModeLabel: "考公辅导",
    assistantPrompt: `围绕公务员考试、申论素材、行测训练和面试表达给反馈，强调框架、素材和可练习动作。
${CIVIL_SERVICE_INTERVIEW_THINKING_MODEL_PROMPT}`,
    metrics: [
      { field: "xingce_questions", label: "行测题目", unit: "题" },
      { field: "interview_practice", label: "面试练习", unit: "次" }
    ],
    taskTypeOptions: [["xingce", "行测"], ["interview", "面试"], ["shenlun", "申论"], ["other", "其他"]]
  },
  postgraduate: {
    type: "postgraduate",
    label: "考研",
    moduleLabel: "备考模块",
    chatModeLabel: "考研辅导",
    assistantPrompt: "围绕考研复习节奏、真题训练、背诵复盘和专业课推进给反馈，强调可执行计划和复盘闭环。",
    metrics: [
      { field: "xingce_questions", label: "真题练习", unit: "题" },
      { field: "interview_practice", label: "背诵复盘", unit: "次" }
    ],
    taskTypeOptions: [["english", "英语"], ["politics", "政治"], ["math", "数学"], ["major", "专业课"], ["other", "其他"]]
  },
  law: {
    type: "law",
    label: "法考",
    moduleLabel: "备考模块",
    chatModeLabel: "法考辅导",
    assistantPrompt: "围绕法考客观题、主观题、法条理解和案例分析给反馈，强调概念辨析、法条定位和错题复盘。",
    metrics: [
      { field: "xingce_questions", label: "真题练习", unit: "题" },
      { field: "interview_practice", label: "法条背诵", unit: "次" }
    ],
    taskTypeOptions: [["objective", "客观题"], ["subjective", "主观题"], ["law-article", "法条"], ["other", "其他"]]
  },
  teacher: {
    type: "teacher",
    label: "教资",
    moduleLabel: "备考模块",
    chatModeLabel: "教资辅导",
    assistantPrompt: "围绕教师资格考试、教育知识、综合素质和面试试讲给反馈，强调知识点、表达结构和练习安排。",
    metrics: [
      { field: "xingce_questions", label: "真题练习", unit: "题" },
      { field: "interview_practice", label: "面试练习", unit: "次" }
    ],
    taskTypeOptions: [["comprehensive", "综合素质"], ["knowledge", "教育知识"], ["interview", "面试"], ["other", "其他"]]
  },
  custom: {
    type: "custom",
    label: "自定义备考",
    moduleLabel: "备考模块",
    chatModeLabel: "备考辅导",
    assistantPrompt: "围绕用户当前备考目标给反馈，强调计划拆解、练习记录、错题复盘和下一步行动。",
    metrics: [
      { field: "xingce_questions", label: "练习数量", unit: "项" },
      { field: "interview_practice", label: "复盘次数", unit: "次" }
    ],
    taskTypeOptions: [["study", "学习"], ["practice", "练习"], ["review", "复盘"], ["other", "其他"]]
  }
};

const LIFEOS_DIRECTORY_NAMES: Record<string, { en: string; zh: string }> = {
  Chat: { en: "Chat", zh: "聊天" },
  Daily: { en: "Daily", zh: "日记" },
  Exam: { en: "Exam", zh: "备考" },
  Inbox: { en: "Inbox", zh: "收件箱" },
  Knowledge: { en: "Knowledge", zh: "知识库" },
  Memory: { en: "Memory", zh: "记忆" },
  Projects: { en: "Projects", zh: "项目" },
  Reports: { en: "Reports", zh: "报告" },
  Reviews: { en: "Reviews", zh: "复盘" },
  Tasks: { en: "Tasks", zh: "任务" },
  Templates: { en: "Templates", zh: "模板" },
  Exports: { en: "Exports", zh: "导出" },
  Attachments: { en: "Attachments", zh: "附件" },
  Books: { en: "Books", zh: "书籍" },
  Raw: { en: "Raw", zh: "原始资料" },
  Sources: { en: "Sources", zh: "来源" },
  Versions: { en: "Versions", zh: "版本" },
  Wiki: { en: "Wiki", zh: "正式知识" },
  Drafts: { en: "Drafts", zh: "草稿" },
  Concepts: { en: "Concepts", zh: "概念" },
  Entities: { en: "Entities", zh: "实体" },
  Questions: { en: "Questions", zh: "问题" },
  Syntheses: { en: "Syntheses", zh: "综合" },
  Contradictions: { en: "Contradictions", zh: "矛盾" },
  Batches: { en: "Batches", zh: "批次" },
  Schema: { en: "Schema", zh: "规则" },
  Trash: { en: "Trash", zh: "回收站" },
  Checkins: { en: "Checkins", zh: "打卡" },
  Core: { en: "Core", zh: "核心" },
  Episodes: { en: "Episodes", zh: "片段" },
  Goals: { en: "Goals", zh: "目标" },
  Interview: { en: "Interview", zh: "面试" },
  Materials: { en: "Materials", zh: "资料" },
  Mistakes: { en: "Mistakes", zh: "错题" },
  Monthly: { en: "Monthly", zh: "月复盘" },
  QuestionBank: { en: "QuestionBank", zh: "题库" },
  Summaries: { en: "Summaries", zh: "总结" },
  Weekly: { en: "Weekly", zh: "周复盘" },
  Xingce: { en: "Xingce", zh: "行测" },
  Yearly: { en: "Yearly", zh: "年复盘" }
};

export function normalizeDirectoryLanguage(value: string | undefined | null): DirectoryLanguage {
  return value === "zh" ? "zh" : "en";
}

export function localizeLifeOsPathParts(parts: string[], language: DirectoryLanguage): string[] {
  const normalizedLanguage = normalizeDirectoryLanguage(language);
  return parts.map((part) => LIFEOS_DIRECTORY_NAMES[part]?.[normalizedLanguage] ?? part);
}

export function normalizeExamProfileType(value: string | undefined | null): ExamProfileType {
  return EXAM_PROFILE_OPTIONS.some(([type]) => type === value) ? (value as ExamProfileType) : "civil-service";
}

export function getExamProfilePreset(
  settings: Partial<Pick<PersonalLifeSystemSettings, "examProfileType" | "customExamProfileName">> = {}
): ExamProfilePreset {
  const type = normalizeExamProfileType(settings.examProfileType);
  const preset = EXAM_PROFILE_PRESETS[type];
  if (type !== "custom") return preset;

  const label = settings.customExamProfileName?.trim() || preset.label;
  return {
    ...preset,
    label,
    chatModeLabel: `${label} 辅导`,
    assistantPrompt: `围绕${label}的备考目标给反馈，强调计划拆解、练习记录、错题复盘和下一步行动。`
  };
}

export function getExamProfileLabel(
  settings: Partial<Pick<PersonalLifeSystemSettings, "examProfileType" | "customExamProfileName">> = {}
): string {
  return getExamProfilePreset(settings).label;
}

export function getExamChatModeLabel(
  settings: Partial<Pick<PersonalLifeSystemSettings, "examProfileType" | "customExamProfileName">> = {}
): string {
  return getExamProfilePreset(settings).chatModeLabel;
}

export function getExamMetricProfiles(
  settings: Partial<Pick<PersonalLifeSystemSettings, "examProfileType" | "customExamProfileName">> = {}
): ExamMetricProfile[] {
  return getExamProfilePreset(settings).metrics;
}

export function getExamTaskTypeOptions(
  settings: Partial<Pick<PersonalLifeSystemSettings, "examProfileType" | "customExamProfileName">> = {}
): Array<[string, string]> {
  return getExamProfilePreset(settings).taskTypeOptions;
}

export function getExamAssistantPrompt(
  settings: Partial<Pick<PersonalLifeSystemSettings, "examProfileType" | "customExamProfileName">> = {}
): string {
  return getExamProfilePreset(settings).assistantPrompt;
}

export interface PersonalLifeSystemSettings {
  rootFolder: string;
  hasCompletedFirstRun: boolean;
  useDailyNotesPlugin: boolean;
  systemName: string;
  assistantName: string;
  userName: string;
  aiProvider: AiProviderType;
  aiBaseUrl: string;
  aiModel: string;
  aiApiKey: string;
  aiApiKeys: Partial<Record<AiProviderType, string>>;
  aiProviderConfigs: Partial<Record<AiProviderType, AiProviderStoredConfig>>;
  aiEndpointPath: string;
  aiAuthHeader: string;
  aiAuthPrefix: string;
  aiExtraHeadersJson: string;
  aiApiVersion: string;
  enableVisionFileAnalysis: boolean;
  visionAiModel: string;
  maxChatAttachmentBytes: number;
  maxChatAttachmentCount: number;
  enableAutoAnalysis: boolean;
  enableFourSages: boolean;
  theme: ThemePreset;
  themeStyle: ThemeStyle;
  uiFramework: UiFrameworkSettings;
  heatmapRange: HeatmapRange;
  language: DisplayLanguage;
  directoryLanguage: DirectoryLanguage;
  heatmapIncludeDaily: boolean;
  heatmapIncludeTasks: boolean;
  heatmapIncludeCheckins: boolean;
  heatmapIncludeSummaries: boolean;
  enableExamModule: boolean;
  enableLlmWiki: boolean;
  llmWikiShortCompileDepth: LlmWikiCompileDepth;
  llmWikiLongMaterialMode: LlmWikiLongMaterialMode;
  llmWikiSensitiveDefault: LlmWikiSensitiveDefault;
  llmWikiIncludeDraftsInChat: boolean;
  llmWikiShowSourceReferences: boolean;
  llmWikiDashboardReminder: boolean;
  examProfileType: ExamProfileType;
  customExamProfileName: string;
  chatSaveMode: ChatSaveMode;
  recentDaysForChat: number;
  assistantStyle: AssistantStyle;
  assistantVerbosity: AssistantVerbosity;
  assistantCustomPrompt: string;
  defaultChatMode: ChatMode;
  defaultChatContextMode: ChatContextMode;
  defaultAiSkillIds: string[];
  importedAiSkills: ImportedAiSkillRecord[];
  /** @deprecated use defaultAiSkillIds */
  defaultAiSkillId: string;
  chatSendBehavior: ChatSendBehavior;
  chatDefaultAiReply: boolean;
  autoApplyChatToDaily: boolean;
  checkModelBeforeRequest: boolean;
  debugMode: boolean;
  reportTopics: string[];
  viewLayout: ViewLayout;
  sidebarCollapsed: boolean;
  sidebarDirectoryCollapsed: boolean;
  backgroundImagePath: string;
  licenseApiBaseUrl: string;
  licenseInstallationId: string;
  licenseEmail: string;
  licenseKey: string;
  licenseEntitlementToken: string;
  licenseSnapshot: LicenseStateSnapshot | null;
  licenseLastOrderId: string;
  licenseLastOrderClaimToken: string;
  licenseLastOrderSnapshot: string;
  licenseLastPaymentSnapshot: string;
  licenseLastCheckedAt: string;
}

export function normalizeThemeStyle(value: string | undefined | null): ThemeStyle {
  return THEME_STYLES.includes(value as ThemeStyle) ? (value as ThemeStyle) : "minimal-warm";
}

export function normalizeUiFrameworkVersion(value: unknown): UiFrameworkVersion {
  return value === "v2" ? "v2" : "legacy";
}

export function isUiPageKey(value: string): value is UiPageKey {
  return (UI_PAGE_KEYS as readonly string[]).includes(value);
}

export function normalizeUiPageFrameworkOverride(value: unknown): UiPageFrameworkOverride | null {
  if (value === "legacy" || value === "v2") return value;
  return null;
}

export function normalizeUiFrameworkSettings(value: unknown): UiFrameworkSettings {
  if (typeof value === "string") {
    return { version: normalizeUiFrameworkVersion(value), pageOverrides: {} };
  }

  const input = value && typeof value === "object"
    ? value as { version?: unknown; pageOverrides?: unknown }
    : {};
  const pageOverrides: Partial<Record<UiPageKey, UiPageFrameworkOverride>> = {};

  if (input.pageOverrides && typeof input.pageOverrides === "object") {
    for (const [page, override] of Object.entries(input.pageOverrides as Record<string, unknown>)) {
      if (!isUiPageKey(page)) continue;
      const normalized = normalizeUiPageFrameworkOverride(override);
      if (normalized) pageOverrides[page] = normalized;
    }
  }

  return {
    version: normalizeUiFrameworkVersion(input.version),
    pageOverrides
  };
}

export const UI_MIGRATION_STATE_RULES: UiMigrationStateRule[] = [
  {
    page: "chat",
    requires: ["writebackModal"],
    reason: "AI Chat 的写回入口和确认弹窗必须同批迁移，避免出现旧弹窗压框或目的地不一致。"
  },
  {
    page: "knowledge",
    requires: ["writebackModal"],
    reason: "知识库的新增资料、Draft 接受和写回确认共享同一套确认弹窗。"
  }
];

export function isUiV2Enabled(
  settings: Partial<Pick<PersonalLifeSystemSettings, "uiFramework">>,
  page: UiPageKey
): boolean {
  const normalized = normalizeUiFrameworkSettings(settings.uiFramework);
  return (normalized.pageOverrides[page] ?? normalized.version) === "v2";
}

export function isAllowedUiMigrationState(
  settings: UiFrameworkSettings | unknown
): boolean {
  const normalized = normalizeUiFrameworkSettings(settings);
  for (const rule of UI_MIGRATION_STATE_RULES) {
    if ((normalized.pageOverrides[rule.page] ?? normalized.version) !== "v2") continue;
    for (const requiredPage of rule.requires ?? []) {
      if ((normalized.pageOverrides[requiredPage] ?? normalized.version) !== "v2") return false;
    }
  }
  return true;
}

export function isLiquidGlassDerivedThemeStyle(value: ThemeStyle): boolean {
  return LIQUID_GLASS_DERIVED_THEME_STYLES.has(value);
}

export function getThemeStyleClasses(value: ThemeStyle): string[] {
  const primaryClass = `lifeos-theme-${value}`;
  if (!isLiquidGlassDerivedThemeStyle(value) || value === "liquid-glass") return [primaryClass];
  return [primaryClass, "lifeos-theme-liquid-glass"];
}

const AI_PROVIDER_PRESETS: Partial<Record<AiProviderType, AiProviderPreset>> = {
  openai: {
    label: "OpenAI 官方",
    baseUrl: "https://api.openai.com/v1",
    endpointPath: "chat/completions",
    model: "gpt-4.1-mini",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    modelSuggestions: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"],
    note: "OpenAI 官方接口，适合直接连接 OpenAI API。"
  },
  "openai-compatible": {
    label: "OpenAI Compatible",
    baseUrl: "https://api.openai.com/v1",
    endpointPath: "chat/completions",
    model: "gpt-4.1-mini",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    modelSuggestions: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"],
    note: "OpenAI 兼容接口，适合代理、聚合网关或其他兼容 OpenAI 协议的服务。"
  },
  "anthropic-compatible": {
    label: "Anthropic Compatible",
    baseUrl: "https://api.anthropic.com",
    endpointPath: "v1/messages",
    model: "claude-3-5-sonnet-latest",
    authHeader: "x-api-key",
    authPrefix: "",
    modelSuggestions: [
      "claude-3-5-sonnet-latest",
      "claude-3-7-sonnet-latest",
      "claude-sonnet-4-0",
      "claude-opus-4-0"
    ],
    note: "Anthropic 兼容接口会默认使用 x-api-key 和 anthropic-version 请求头。"
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    endpointPath: "chat/completions",
    model: "deepseek-v4-flash",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    modelSuggestions: [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner"
    ],
    note: "DeepSeek 使用 OpenAI 兼容接口；旧模型名仍可兼容，但官方已提示将逐步弃用。"
  },
  glm: {
    label: "GLM / Z.AI",
    baseUrl: "https://api.z.ai/api/paas/v4",
    endpointPath: "chat/completions",
    model: "glm-5.1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    modelSuggestions: ["glm-5.1", "glm-5-turbo", "glm-4.7", "glm-4.7-flash"],
    note: "GLM 标准接口使用 https://api.z.ai/api/paas/v4；如果你用的是 Coding Plan，可按需替换 Base URL。"
  },
  qwen: {
    label: "Qwen / 百炼",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    endpointPath: "chat/completions",
    model: "qwen-plus",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    modelSuggestions: ["qwen-plus", "qwen-max", "qwen-turbo", "qwen-doc-turbo"],
    note: "通义千问的 OpenAI 兼容接口，适合阿里云百炼用户。"
  },
  kimi: {
    label: "Kimi / Moonshot",
    baseUrl: "https://api.moonshot.cn/v1",
    endpointPath: "chat/completions",
    model: "kimi-k2.6",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    modelSuggestions: ["kimi-k2.6", "kimi-k2.5", "moonshot-v1-32k", "moonshot-v1-8k"],
    note: "Kimi 官方 API 直接兼容 OpenAI，常见接法就是 Base URL + Bearer Key。"
  },
  hunyuan: {
    label: "Hunyuan / 腾讯",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    endpointPath: "chat/completions",
    model: "hunyuan-turbos-latest",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    modelSuggestions: ["hunyuan-turbos-latest", "hunyuan-lite", "hunyuan-pro"],
    note: "腾讯混元走 OpenAI 兼容接口，默认使用 /v1/chat/completions。"
  },
  doubao: {
    label: "Doubao / 火山",
    baseUrl: "https://operator.las.cn-beijing.volces.com/api/v1",
    endpointPath: "chat/completions",
    model: "doubao-seed-1-6-251015",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    modelSuggestions: [
      "doubao-seed-1-6-251015",
      "doubao-1-5-pro-32k-250115",
      "doubao-1-5-lite-32k-250115"
    ],
    note: "火山方舟接口通常按地域区分，北京地域可先从这个 Base URL 开始。"
  },
  ollama: {
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    endpointPath: "chat/completions",
    model: "llama3.1",
    authHeader: "",
    authPrefix: "",
    modelSuggestions: ["llama3.1", "qwen2.5", "deepseek-r1", "mistral"],
    note: "Ollama 通常使用本地 OpenAI 兼容接口；如果你改了端口或路径，直接覆盖 Base URL 即可。"
  }
};

export function getAiProviderPreset(provider: AiProviderType): AiProviderPreset | null {
  return AI_PROVIDER_PRESETS[provider] ?? null;
}

export function validateAiProviderConfig(input: AiProviderValidationInput): string {
  if (!input.aiProvider) return "未选择供应商";
  if (input.aiProvider !== "ollama" && !normalizeAiApiKeyInput(input.aiApiKey)) return "未填写 API Key";
  if (!input.aiBaseUrl.trim()) return "Base URL 缺失";
  if (!/^https?:\/\/.+/i.test(input.aiBaseUrl.trim())) return "Base URL 格式不正确";
  if (!input.aiModel.trim()) return "Model 缺失";
  return "";
}

export function normalizeAiApiKeyInput(apiKey: string): string {
  let value = apiKey.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  value = value.replace(/^authorization\s*:\s*/i, "").trim();
  value = value.replace(/^bearer\s+/i, "").trim();
  return value;
}

export function getStoredAiApiKey(
  settings: PersonalLifeSystemSettings,
  provider: AiProviderType
): string {
  return normalizeAiApiKeyInput(settings.aiApiKeys?.[provider] ?? "");
}

export function setStoredAiApiKey(
  settings: PersonalLifeSystemSettings,
  provider: AiProviderType,
  apiKey: string
): void {
  if (!settings.aiApiKeys) {
    settings.aiApiKeys = {};
  }

  const trimmed = normalizeAiApiKeyInput(apiKey);
  if (trimmed) {
    settings.aiApiKeys[provider] = trimmed;
    return;
  }

  delete settings.aiApiKeys[provider];
}

export function getCurrentAiProviderConfig(settings: Pick<PersonalLifeSystemSettings, "aiBaseUrl" | "aiModel" | "aiEndpointPath" | "aiAuthHeader" | "aiAuthPrefix">): AiProviderStoredConfig {
  return {
    baseUrl: settings.aiBaseUrl ?? "",
    model: settings.aiModel ?? "",
    endpointPath: settings.aiEndpointPath ?? "",
    authHeader: settings.aiAuthHeader ?? "",
    authPrefix: settings.aiAuthPrefix ?? ""
  };
}

export function getStoredAiProviderConfig(
  settings: Pick<PersonalLifeSystemSettings, "aiProviderConfigs">,
  provider: AiProviderType
): AiProviderStoredConfig | null {
  const preset = getAiProviderPreset(provider);
  const stored = settings.aiProviderConfigs?.[provider];
  if (!stored && !preset) return null;
  return {
    baseUrl: stored?.baseUrl ?? preset?.baseUrl ?? "",
    model: stored?.model ?? preset?.model ?? "",
    endpointPath: stored?.endpointPath ?? preset?.endpointPath ?? "",
    authHeader: stored?.authHeader ?? preset?.authHeader ?? "",
    authPrefix: stored?.authPrefix ?? preset?.authPrefix ?? ""
  };
}

export function setStoredAiProviderConfig(
  settings: PersonalLifeSystemSettings,
  provider: AiProviderType,
  config: AiProviderStoredConfig
): void {
  if (!settings.aiProviderConfigs) {
    settings.aiProviderConfigs = {};
  }
  settings.aiProviderConfigs[provider] = {
    baseUrl: config.baseUrl ?? "",
    model: config.model ?? "",
    endpointPath: config.endpointPath ?? "",
    authHeader: config.authHeader ?? "",
    authPrefix: config.authPrefix ?? ""
  };
}

export function getAvailableAiProviderOptions(settings: PersonalLifeSystemSettings): AiProviderOption[] {
  return AI_PROVIDER_OPTIONS.map(([id, label]) => {
    const active = id === settings.aiProvider;
    const storedKey = getStoredAiApiKey(settings, id);
    const activeKey = active ? (settings.aiApiKey.trim() || storedKey) : storedKey;
    const configured = id === "ollama" || activeKey.length > 0;
    const providerConfig = getStoredAiProviderConfig(settings, id);
    return {
      id,
      label,
      model: active ? settings.aiModel : (providerConfig?.model ?? ""),
      configured,
      active
    };
  }).filter((option) => option.configured || option.active);
}

export function applyAiProviderSelection(
  settings: PersonalLifeSystemSettings,
  provider: AiProviderType
): void {
  setStoredAiApiKey(settings, settings.aiProvider, settings.aiApiKey);
  setStoredAiProviderConfig(settings, settings.aiProvider, getCurrentAiProviderConfig(settings));
  const providerConfig = getStoredAiProviderConfig(settings, provider);
  settings.aiProvider = provider;
  settings.aiApiKey = getStoredAiApiKey(settings, provider);

  if (!providerConfig) return;
  settings.aiBaseUrl = providerConfig.baseUrl;
  settings.aiEndpointPath = providerConfig.endpointPath;
  settings.aiAuthHeader = providerConfig.authHeader;
  settings.aiAuthPrefix = providerConfig.authPrefix;
  settings.aiModel = providerConfig.model;
}

function normalizeAiModelName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function aiModelNamesMatch(available: string, requested: string): boolean {
  return normalizeAiModelName(available) === normalizeAiModelName(requested);
}

export function findMatchingAiModel(
  availableModels: string[],
  requestedModel: string
): string | null {
  const requested = requestedModel.trim();
  if (!requested) return null;
  const models = Array.from(new Set(availableModels.map((model) => model.trim()).filter(Boolean)));
  return models.find((model) => aiModelNamesMatch(model, requested)) ?? null;
}

export function pickBestAiModel(
  settings: PersonalLifeSystemSettings,
  availableModels: string[]
): string | null {
  const models = Array.from(new Set(availableModels.map((model) => model.trim()).filter(Boolean)));
  if (models.length === 0) return null;

  const current = findMatchingAiModel(models, settings.aiModel);
  if (current) return current;

  const preset = getAiProviderPreset(settings.aiProvider);
  for (const suggestion of preset?.modelSuggestions ?? []) {
    const match = models.find((model) => aiModelNamesMatch(model, suggestion));
    if (match) return match;
  }

  return models[0];
}

export function analyzeAiConnectionTestModels(
  settings: PersonalLifeSystemSettings,
  availableModels: string[]
): {
  matchedModel: string | null,
  suggestedModel: string | null,
  shouldAutoApply: boolean
} {
  const models = Array.from(new Set(availableModels.map((model) => model.trim()).filter(Boolean)));
  if (models.length === 0) {
    return {
      matchedModel: null,
      suggestedModel: null,
      shouldAutoApply: false
    };
  }

  const matchedModel = findMatchingAiModel(models, settings.aiModel);
  if (matchedModel) {
    return {
      matchedModel,
      suggestedModel: matchedModel,
      shouldAutoApply: false
    };
  }

  const suggestedModel = pickBestAiModel(settings, models);
  return {
    matchedModel: null,
    suggestedModel,
    shouldAutoApply: !settings.aiModel.trim() && Boolean(suggestedModel)
  };
}

export const DEFAULT_SETTINGS: PersonalLifeSystemSettings = {
  rootFolder: "PersonalLifeSystem",
  hasCompletedFirstRun: false,
  useDailyNotesPlugin: false,
  systemName: "Life OS",
  assistantName: "Life OS",
  userName: "",
  aiProvider: "openai",
  aiBaseUrl: "https://api.openai.com/v1",
  aiModel: "gpt-4.1-mini",
  aiApiKey: "",
  aiApiKeys: {},
  aiProviderConfigs: {},
  aiEndpointPath: "",
  aiAuthHeader: "",
  aiAuthPrefix: "",
  aiExtraHeadersJson: "",
  aiApiVersion: "",
  enableVisionFileAnalysis: false,
  visionAiModel: "",
  maxChatAttachmentBytes: 6 * 1024 * 1024,
  maxChatAttachmentCount: 5,
  enableAutoAnalysis: true,
  enableFourSages: true,
  theme: "cool",
  themeStyle: "minimal-warm",
  uiFramework: {
    version: "legacy",
    pageOverrides: {}
  },
  heatmapRange: "1y",
  language: "zh",
  directoryLanguage: "en",
  heatmapIncludeDaily: true,
  heatmapIncludeTasks: true,
  heatmapIncludeCheckins: true,
  heatmapIncludeSummaries: true,
  enableExamModule: true,
  enableLlmWiki: true,
  llmWikiShortCompileDepth: "standard",
  llmWikiLongMaterialMode: "ask",
  llmWikiSensitiveDefault: "local-only",
  llmWikiIncludeDraftsInChat: true,
  llmWikiShowSourceReferences: true,
  llmWikiDashboardReminder: true,
  examProfileType: "civil-service",
  customExamProfileName: "",
  chatSaveMode: "summary",
  recentDaysForChat: 7,
  assistantStyle: "warm-companion",
  assistantVerbosity: "normal",
  assistantCustomPrompt: "",
  defaultChatMode: "chat",
  defaultChatContextMode: "smart",
  defaultAiSkillIds: ["lifeos-general"],
  importedAiSkills: [],
  defaultAiSkillId: "lifeos-general",
  chatSendBehavior: "enterToSend",
  chatDefaultAiReply: true,
  autoApplyChatToDaily: false,
  checkModelBeforeRequest: false,
  debugMode: false,
  viewLayout: "main",
  sidebarCollapsed: false,
  sidebarDirectoryCollapsed: false,
  backgroundImagePath: "",
  licenseApiBaseUrl: "https://license.lifeoskit.com",
  licenseInstallationId: "",
  licenseEmail: "",
  licenseKey: "",
  licenseEntitlementToken: "",
  licenseSnapshot: null,
  licenseLastOrderId: "",
  licenseLastOrderClaimToken: "",
  licenseLastOrderSnapshot: "",
  licenseLastPaymentSnapshot: "",
  licenseLastCheckedAt: "",
  reportTopics: [
    "官方时政与政策资讯",
    "备考资料、真题复盘与面试表达",
    "AI 热点与工具动态",
    "今天天气与提醒",
    "个人成长建议",
    "健康生活提示"
  ]
};

export const MEMORY_CATEGORIES = [
  "学业",
  "项目",
  "备考",
  "人际",
  "健康",
  "偏好",
  "其他"
];
