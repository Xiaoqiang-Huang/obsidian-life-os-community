import { MarkdownView, Notice, Plugin, TFile, type Editor, type WorkspaceLeaf } from "obsidian";
import {
  AI_EDIT_PANEL_VIEW_TYPE,
  AI_WORKSPACE_VIEW_TYPE,
  CALENDAR_VIEW_TYPE,
  CHECKIN_VIEW_TYPE,
  CHAT_VIEW_TYPE,
  DASHBOARD_VIEW_TYPE,
  DAILY_VIEW_TYPE,
  KNOWLEDGE_VIEW_TYPE,
  MEMORY_VIEW_TYPE,
  PRO_COMPARE_VIEW_TYPE,
  PRO_LICENSE_VIEW_TYPE,
  REVIEW_VIEW_TYPE,
  SETTINGS_VIEW_TYPE,
  TASKS_VIEW_TYPE,
  USER_GUIDE_VIEW_TYPE,
} from "./constants";
import { AiClient, buildSystemPrompt } from "./ai";
import {
  DEFAULT_SETTINGS,
  MEMORY_CATEGORIES,
  createBrowserCaptureToken,
  getThemeStyleClasses,
  type PersonalLifeSystemSettings,
  getCurrentAiProviderConfig,
  getStoredAiApiKey,
  getExamProfileLabel,
  getCivilServiceInterviewThinkingModelPrompt,
  normalizeExamProfileType,
  normalizeDirectoryLanguage,
  normalizeBrowserCapturePort,
  normalizeWebSearchProvider,
  normalizeWeixinApprovedSenders,
  normalizeWeixinConversationRoutes,
  normalizeWeixinReminderRoutes,
  normalizeWeixinPendingPairings,
  normalizeWeixinPermission,
  normalizeWeixinSenderPolicy,
  normalizeChatWritebackMode,
  normalizePaddleOcrEndpoint,
  normalizePdfOcrEngine,
  normalizeTaskFormDraft,
  normalizeThemeStyle,
  normalizeUiFrameworkSettings,
  setStoredAiApiKey,
  setStoredAiProviderConfig,
  THEME_STYLES,
  type ThemeStyle
} from "./settings";
import { normalizeInstallationId } from "./licensing/installation-id";
import { hasProAccess, requireProFeature } from "./licensing/entitlement";
import { verifyLicenseEntitlementToken } from "./licensing/entitlement-token";
import { normalizeAiSkillOverrides, normalizeCustomAiSkillCategories, normalizeImportedAiSkillRecords } from "./services/AiSkillService";
import { PersonalLifeSystemSettingTab } from "./settings-tab";
import {
  ensureFile,
  ensureFolder,
  extractJsonArray,
  formatDate,
  joinPath,
  makeId,
  renderTemplate,
  sanitizeFolderPath,
  stripCodeFences
} from "./utils";
import { LifeOSDashboardView } from "./views/DashboardView";
import { LifeOSChatView } from "./views/ChatView";
import { AiEditPanelView } from "./views/AiEditPanelView";
import { TaskManagerView } from "./views/TaskManagerView";
import { ReviewView } from "./views/ReviewView";
import { DailyView } from "./views/DailyView";
import { KnowledgeView } from "./views/KnowledgeView";
import { CheckinView } from "./views/CheckinView";
import { UserGuideView } from "./views/UserGuideView";
import { AiWorkspaceView } from "./views/AiWorkspaceView";
import { ProCompareView } from "./views/ProCompareView";
import { ProLicenseView } from "./views/ProLicenseView";
import { LifeOSSettingsView } from "./views/SettingsView";
import { CalendarView } from "./calendar-view";
import { MemoryView } from "./memory-view";
import { showXingceStats } from "./exam/xingce-stats";
import { showGoalsList } from "./exam/goals";
import { showTodayTasks } from "./exam/tasks";
import { showTrainingPlan } from "./exam/training-plan";
import { showUploadMaterial } from "./exam/materials";
import { showInterviewTrends } from "./exam/interview";
import { destroyLifeOSLiquidGlassRuntime, refreshLifeOSLiquidGlassRuntime } from "./ui/liquid-glass-runtime";
import { AiEditPopoverController, cloneEditorPosition, type AiEditAnchor, type AiEditTarget } from "./ui/AiEditPopover";
import { showEmotionTracking, showDiarySearch } from "./reports";
import { QuickCaptureModal } from "./modals/QuickCaptureModal";
import { PeriodReviewModal } from "./modals/PeriodReviewModal";
import { FirstRunModal as LifeOSFirstRunModal } from "./modals/FirstRunModal";
import {
  InterviewPracticeModal,
  sanitizeFileName,
  XingceQuestionModal
} from "./modals";
import { FileSystemService } from "./services/FileSystemService";
import { ProjectService } from "./services/ProjectService";
import { AiWorkspaceService } from "./services/AiWorkspaceService";
import { AutoReviewService, normalizeAutoReviewTime, type AutoReviewTrigger } from "./services/AutoReviewService";
import {
  AiWorkspaceBrowserCaptureServer,
  type BrowserCaptureServerStatus
} from "./services/ai-workspace/BrowserCaptureServer";
import { WeixinAssistantService } from "./services/weixin/WeixinAssistantService";
import { evaluateWeixinAccess } from "./services/weixin/WeixinBotLogic";
import { WeixinReminderService } from "./services/weixin/WeixinReminderService";
import {
  WeixinIlinkService,
  type WeixinConnectionStatus
} from "./services/weixin/WeixinIlinkService";
import { DailyNoteService } from "./services/DailyNoteService";
import { formatMemoryCandidate } from "./services/lifeos-logic";
import {
  applyWritebackItems,
  appendWritebackItems,
  openWritebackPreview,
  type WritebackItem
} from "./writeback-preview";
import { dedupTaskLines, parseOpenTasks, parseTaskLine } from "./tasks/task-actions";
import type {
  IPlugin,
  InterviewPracticeData,
  XingceQuestionData
} from "./plugin-api";
import type { ChatMessage } from "./types";

export interface ActiveChatRuntimeState {
  messages: ChatMessage[];
  draftInput: string;
  updatedAt: number;
}

interface AiEditRuntimeDiagnostics {
  captureMouseUp: number;
  bubbleMouseUp: number;
  selectionChange: number;
  opened: number;
  mounted: number;
  snapshotCaptured: number;
  lastEvent: string;
  lastTarget: string;
  lastReason: string;
  lastSelectionLength: number;
  lastFilePath: string;
  lastAt: number;
  lastMeaningfulEvent: string;
  lastMeaningfulTarget: string;
  lastMeaningfulReason: string;
  lastMeaningfulSelectionLength: number;
  lastMeaningfulFilePath: string;
  lastMeaningfulAt: number;
}

interface AiEditDomSelectionSnapshot {
  text: string;
  file: TFile;
  target: HTMLElement;
  source: string;
  key: string;
  createdAt: number;
  anchor: AiEditAnchor;
}

export default class PersonalLifeSystemPlugin extends Plugin implements IPlugin {
  settings: PersonalLifeSystemSettings;
  ai: AiClient;
  activeChatState: ActiveChatRuntimeState = { messages: [], draftInput: "", updatedAt: 0 };
  private dailyMaintenancePromise: Promise<void> | null = null;
  private dailyMaintenanceRunDate = "";
  private midnightTimer: number | null = null;
  private modalTextareaObserver: MutationObserver | null = null;
  private liquidGlassObserver: MutationObserver | null = null;
  private liquidGlassRefreshTimer: number | null = null;
  private aiEditPopover: AiEditPopoverController | null = null;
  private aiEditPointerDown: { x: number; y: number } | null = null;
  private aiEditSelectionTimer: number | null = null;
  private pendingAiEditDomSelectionSnapshot: AiEditDomSelectionSnapshot | null = null;
  private readonly aiEditDiagnostics: AiEditRuntimeDiagnostics = {
    captureMouseUp: 0,
    bubbleMouseUp: 0,
    selectionChange: 0,
    opened: 0,
    mounted: 0,
    snapshotCaptured: 0,
    lastEvent: "not-started",
    lastTarget: "",
    lastReason: "插件已加载，尚未捕获选区事件",
    lastSelectionLength: 0,
    lastFilePath: "",
    lastAt: 0,
    lastMeaningfulEvent: "not-started",
    lastMeaningfulTarget: "",
    lastMeaningfulReason: "尚未捕获到有效选区事件",
    lastMeaningfulSelectionLength: 0,
    lastMeaningfulFilePath: "",
    lastMeaningfulAt: 0
  };
  private lastAiEditSelectionKey = "";
  private lastAiEditSelectionAt = 0;
  private pendingChatPrompt = "";
  private aiWorkspaceSyncRunning = false;
  private autoReviewService: AutoReviewService | null = null;
  private readonly browserCaptureServer = new AiWorkspaceBrowserCaptureServer();
  private weixinIlinkService: WeixinIlinkService | null = null;
  private weixinAssistantService: WeixinAssistantService | null = null;
  private weixinReminderDeliveryRunning = false;
  private weixinDailyDigestRunning = false;
  private readonly lifeOsViewTypes = [
    CHAT_VIEW_TYPE,
    DASHBOARD_VIEW_TYPE,
    TASKS_VIEW_TYPE,
    DAILY_VIEW_TYPE,
    KNOWLEDGE_VIEW_TYPE,
    MEMORY_VIEW_TYPE,
    REVIEW_VIEW_TYPE,
    CHECKIN_VIEW_TYPE,
    USER_GUIDE_VIEW_TYPE,
    PRO_COMPARE_VIEW_TYPE,
    PRO_LICENSE_VIEW_TYPE,
    CALENDAR_VIEW_TYPE,
    AI_WORKSPACE_VIEW_TYPE,
    SETTINGS_VIEW_TYPE
  ];

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.verifyStoredLicenseEntitlement();
    this.applyTheme();
    this.installMobileViewportVariables();
    this.registerModalTextareaEnhancer();
    this.ai = new AiClient(() => this.settings);
    this.autoReviewService = new AutoReviewService(
      this.app,
      this.fileSystem(),
      this.settings,
      this.ai,
      {
        hasEntitlement: () => hasProAccess(
          this.settings.licenseSnapshot,
          new Date(),
          this.settings.licenseEntitlementToken
        ),
        onDraftCreated: (draft) => new Notice(`已生成待确认的今日复盘草稿：${draft.window.start}`, 7000)
      }
    );
    if (this.settings.debugMode) {
      await this.writeDebugLoadMarker();
    }
    try {
      await this.ensureBaseStructure();
    } catch (error) {
      console.error("[Life OS] Failed to initialize base structure during plugin load", error);
    }
    await this.refreshBrowserCaptureBridge();
    await this.refreshWeixinConnection();
    void this.deliverWeixinReminders();

    this.addSettingTab(new PersonalLifeSystemSettingTab(this.app, this));
    this.aiEditPopover = new AiEditPopoverController(this.app, this);

    this.registerView(
      DASHBOARD_VIEW_TYPE,
      (leaf) => new LifeOSDashboardView(leaf, this)
    );
    this.registerView(CHAT_VIEW_TYPE, (leaf) => new LifeOSChatView(leaf, this));
    this.registerView(AI_EDIT_PANEL_VIEW_TYPE, (leaf) => new AiEditPanelView(leaf, this));
    this.registerView(TASKS_VIEW_TYPE, (leaf) => new TaskManagerView(leaf, this));
    this.registerView(DAILY_VIEW_TYPE, (leaf) => new DailyView(leaf, this));
    this.registerView(KNOWLEDGE_VIEW_TYPE, (leaf) => new KnowledgeView(leaf, this));
    this.registerView(MEMORY_VIEW_TYPE, (leaf) => new MemoryView(leaf, this));
    this.registerView(REVIEW_VIEW_TYPE, (leaf) => new ReviewView(leaf, this));
    this.registerView(CHECKIN_VIEW_TYPE, (leaf) => new CheckinView(leaf, this));
    this.registerView(USER_GUIDE_VIEW_TYPE, (leaf) => new UserGuideView(leaf, this));
    this.registerView(AI_WORKSPACE_VIEW_TYPE, (leaf) => new AiWorkspaceView(leaf, this));
    this.registerView(PRO_COMPARE_VIEW_TYPE, (leaf) => new ProCompareView(leaf, this));
    this.registerView(PRO_LICENSE_VIEW_TYPE, (leaf) => new ProLicenseView(leaf, this));
    this.registerView(SETTINGS_VIEW_TYPE, (leaf) => new LifeOSSettingsView(leaf, this));
    this.registerView(
      CALENDAR_VIEW_TYPE,
      (leaf) => new CalendarView(leaf, this)
    );
    this.registerLifeOsFileStyling();
    this.registerAiEditPopover();

    this.addRibbonIcon("layout-dashboard", "Life OS Dashboard", () => {
      void this.activateDashboard();
    });
    this.addRibbonIcon("plus-circle", "Quick Capture", () => {
      new QuickCaptureModal(this.app, this).open();
    });
    this.addRibbonIcon("badge-check", "Pro 授权中心", () => {
      void this.activateProLicense();
    });

    this.addRibbonIcon("sparkles", "打开个人人生系统", () => {
      void this.activateDashboard();
    });
    this.addRibbonIcon("pencil-line", "快速记录", () => {
      new QuickCaptureModal(this.app, this).open();
    });

    // ── 基础命令 ──
    this.addCommand({
      id: "open-dashboard",
      name: "打开 Dashboard",
      callback: () => void this.activateDashboard()
    });

    this.addCommand({
      id: "open-chat",
      name: "打开 Chat 面板",
      callback: () => void this.activateChat()
    });

    this.addCommand({
      id: "open-pro-license-center",
      name: "打开 Pro 授权中心",
      callback: () => void this.activateProLicense()
    });

    this.addCommand({
      id: "open-user-guide",
      name: "打开使用手册",
      callback: () => void this.activateUserGuide()
    });

    this.addCommand({
      id: "open-settings-center",
      name: "打开 Life OS 设置中心",
      callback: () => void this.activateSettings()
    });

    this.addCommand({
      id: "open-ai-workspace",
      name: "打开项目上下文",
      callback: () => void this.activateAiWorkspace()
    });

    this.addCommand({
      id: "sync-ai-workspace-sessions",
      name: "检查已跟踪会话更新",
      callback: () => void this.refreshTrackedAiWorkspaceSessions(true)
    });

    this.addCommand({
      id: "open-pro-compare",
      name: "打开免费版 / 完整体验 Pro / 短期 Pro 使用 / 长期 Pro 使用对比",
      callback: () => void this.activateProCompare()
    });

    this.addCommand({
      id: "open-task-manager",
      name: "打开任务管理",
      callback: () => void this.activateTasks()
    });

    this.addCommand({
      id: "open-memory-system",
      name: "打开记忆系统",
      callback: () => void this.activateMemory()
    });

    this.addCommand({
      id: "open-calendar",
      name: "打开日历",
      callback: () => void this.activateCalendar()
    });

    this.addCommand({
      id: "quick-capture",
      name: "快速记录",
      callback: () => new QuickCaptureModal(this.app, this).open()
    });

    this.addCommand({
      id: "quick-capture-selection",
      name: "快速记录选中文本",
      editorCallback: (editor) => {
        const selected = editor.getSelection();
        new QuickCaptureModal(this.app, this, selected).open();
      }
    });

    this.addCommand({
      id: "create-today-note",
      name: "创建/打开今日记录",
      callback: () => void this.activateDaily()
    });

    this.addCommand({
      id: "lifeos-open-dashboard",
      name: "Open Life OS Dashboard",
      callback: () => void this.activateDashboard()
    });
    this.addCommand({
      id: "lifeos-quick-capture",
      name: "Quick Capture",
      callback: () => new QuickCaptureModal(this.app, this).open()
    });
    this.addCommand({
      id: "lifeos-open-task-manager",
      name: "Open Task Manager",
      callback: () => void this.activateTasks()
    });
    this.addCommand({
      id: "lifeos-open-memory-manager",
      name: "Open Memory Manager",
      callback: () => void this.activateMemory()
    });
    this.addCommand({
      id: "lifeos-open-review",
      name: "Open Review",
      callback: () => void this.activateReview()
    });
    this.addCommand({
      id: "lifeos-open-chat",
      name: "Open Chat",
      callback: () => void this.activateChat()
    });
    this.addCommand({
      id: "lifeos-open-pro-license",
      name: "Open Pro License Center",
      callback: () => void this.activateProLicense()
    });
    this.addCommand({
      id: "lifeos-open-user-guide",
      name: "Open Life OS User Guide",
      callback: () => void this.activateUserGuide()
    });
    this.addCommand({
      id: "lifeos-open-pro-compare",
      name: "Open Free / Pro Compare",
      callback: () => void this.activateProCompare()
    });
    this.addCommand({
      id: "lifeos-create-today-note",
      name: "Create Today Note",
      callback: () => void this.openTodayNote(false)
    });
    this.addCommand({
      id: "lifeos-open-daily",
      name: "Open Daily",
      callback: () => void this.activateDaily()
    });
    this.addCommand({
      id: "lifeos-open-knowledge",
      name: "Open Knowledge",
      callback: () => void this.activateKnowledge()
    });

    this.addCommand({
      id: "create-full-today-note",
      name: "创建/打开今日记录（完整版模板）",
      callback: () => void this.openTodayNote(true)
    });

    this.addCommand({
      id: "finish-today-note",
      name: "结束今日记录并分析",
      callback: () => void this.finishTodayNote()
    });

    this.addCommand({
      id: "summarize-current-note",
      name: "总结当前笔记",
      editorCallback: (_editor, view) => void this.summarizeFile(view.file)
    });

    this.addCommand({
      id: "extract-tasks-current-note",
      name: "从当前笔记提取待办",
      editorCallback: (_editor, view) => void this.extractTasksFromFile(view.file)
    });

    this.addCommand({
      id: "four-sages-selection",
      name: "四圣谏言分析选中文本",
      editorCallback: (editor) => {
        const selected = editor.getSelection();
        if (!selected.trim()) {
          new Notice("请先选中一段需要分析的文本。");
          return;
        }
        void this.analyzeFourSages(selected).then((result) => {
          if (result) {
            editor.replaceSelection(`${selected}\n\n${result}\n`);
          }
        });
      }
    });

    // ── 备考命令 ──
    this.addCommand({
      id: "new-xingce-question",
      name: "新增备考错题",
      callback: () => new XingceQuestionModal(this.app, this).open()
    });

    this.addCommand({
      id: "new-interview-practice",
      name: "打开备考练习",
      callback: () => new InterviewPracticeModal(this.app, this).open()
    });

    this.addCommand({
      id: "xingce-stats",
      name: "备考练习统计",
      callback: () => void this.showXingceStats()
    });

    this.addCommand({
      id: "exam-checkin",
      name: "学习打卡",
      callback: () => void this.showCheckinModal()
    });

    this.addCommand({
      id: "exam-goals",
      name: "学习目标管理",
      callback: () => void this.showGoalsList()
    });

    this.addCommand({
      id: "exam-today-tasks",
      name: "今日学习任务",
      callback: () => void this.showTodayTasks()
    });

    this.addCommand({
      id: "exam-interview-trends",
      name: "备考练习趋势",
      callback: () => void this.showInterviewTrends()
    });

    this.addCommand({
      id: "exam-upload-material",
      name: "上传学习资料",
      callback: () => void this.showUploadMaterial()
    });

    this.addCommand({
      id: "exam-training-plan",
      name: "今日训练计划",
      callback: () => void this.showTrainingPlan()
    });

    // ── 报告命令 ──
    this.addCommand({
      id: "generate-daily-report",
      name: "生成日报",
      callback: () => void this.generateReport("daily")
    });

    this.addCommand({
      id: "generate-weekly-report",
      name: "生成周报",
      callback: () => void this.generateReport("weekly")
    });

    this.addCommand({
      id: "generate-monthly-report",
      name: "生成月报",
      callback: () => void this.generateReport("monthly")
    });

    this.addCommand({
      id: "emotion-tracking",
      name: "情绪追踪",
      callback: () => void this.showEmotionTracking()
    });

    this.addCommand({
      id: "diary-search",
      name: "日记检索",
      callback: () => void this.showDiarySearch()
    });

    this.addCommand({
      id: "memory-manager",
      name: "记忆管理",
      callback: () => void this.activateMemory()
    });

    if (!this.settings.hasCompletedFirstRun) {
      new LifeOSFirstRunModal(this.app, this).open();
    }

    // Check yesterday on first launch, then keep periodic summaries updated.
    void this.runStartupDailyMaintenance();
    this.scheduleMidnightCheck();
    void this.refreshTrackedAiWorkspaceSessions(false);
    void this.runAutoReview("startup");
    this.registerInterval(window.setInterval(() => {
      void this.refreshTrackedAiWorkspaceSessions(false);
    }, 60_000));
    this.registerInterval(window.setInterval(() => {
      void this.runAutoReview("timer");
    }, 60_000));
    this.registerInterval(window.setInterval(() => {
      void this.deliverWeixinReminders();
    }, 30_000));
    this.registerInterval(window.setInterval(() => {
      if (new Date().getHours() === 0) void this.runWeixinDailyDigest("timer");
    }, 60_000));
  }

  onunload(): void {
    if (this.midnightTimer) {
      window.clearTimeout(this.midnightTimer);
      this.midnightTimer = null;
    }
    this.modalTextareaObserver?.disconnect();
    this.modalTextareaObserver = null;
    if (this.aiEditSelectionTimer) {
      window.clearTimeout(this.aiEditSelectionTimer);
      this.aiEditSelectionTimer = null;
    }
    this.pendingAiEditDomSelectionSnapshot = null;
    this.aiEditPopover?.close();
    this.aiEditPopover = null;
    this.stopLiquidGlassRuntime();
    this.autoReviewService = null;
    void this.browserCaptureServer.stop();
    void this.weixinIlinkService?.stop();
    this.weixinIlinkService = null;
    this.weixinAssistantService = null;
    this.weixinReminderDeliveryRunning = false;
    this.weixinDailyDigestRunning = false;
  }

  // ═══════════════════════════════════════════════════
  // Settings
  // ═══════════════════════════════════════════════════

  async loadSettings(): Promise<void> {
    let storedData: Partial<PersonalLifeSystemSettings> = {};
    try {
      storedData = await this.loadData() ?? {};
    } catch (error) {
      console.error("[Life OS] Failed to read plugin settings, using defaults", error);
      new Notice("Life OS 设置文件读取失败，已使用默认设置启动。");
    }
    const needsInitialLicenseSave = !storedData.licenseInstallationId;
    const needsBrowserCaptureTokenSave = typeof storedData.browserCaptureToken !== "string"
      || storedData.browserCaptureToken.trim().length < 24;
    const needsBrowserCaptureSetupMigration = Number(storedData.browserCaptureSetupVersion || 0) < 1;
    const legacyBotData = storedData as Record<string, unknown>;
    const hasLegacyOpenClawSettings = Object.keys(legacyBotData).some((key) => key.startsWith("openClaw"));
    const storedWeixinSetupVersion = Number(legacyBotData.weixinBotSetupVersion || 0);
    const needsWeixinSetupMigration = storedWeixinSetupVersion < 3 || hasLegacyOpenClawSettings;
    const storedImportedAiSkills = (storedData as Record<string, unknown>).importedAiSkills;
    const storedAiSkillOverrides = (storedData as Record<string, unknown>).aiSkillOverrides;
    const storedChatWritebackMode = (storedData as Record<string, unknown>).chatWritebackMode;
    const needsChatWritebackModeMigration = storedChatWritebackMode !== "off"
      && storedChatWritebackMode !== "confirm"
      && storedChatWritebackMode !== "explicit-auto";
    this.settings = Object.assign({}, DEFAULT_SETTINGS, storedData);
    this.settings.themeStyle = normalizeThemeStyle(this.settings.themeStyle);
    this.settings.uiFramework = normalizeUiFrameworkSettings(
      (storedData as Record<string, unknown>).uiFramework ?? (storedData as Record<string, unknown>).uiFrameworkVersion
    );
    this.settings.directoryLanguage = normalizeDirectoryLanguage(this.settings.directoryLanguage);
    this.settings.examProfileType = normalizeExamProfileType(this.settings.examProfileType);
    this.settings.customExamProfileName = this.settings.customExamProfileName ?? "";
    this.settings.lastTaskDraft = normalizeTaskFormDraft((storedData as Record<string, unknown>).lastTaskDraft);
    this.settings.customAiSkillCategories = normalizeCustomAiSkillCategories((storedData as Record<string, unknown>).customAiSkillCategories);
    this.settings.importedAiSkills = normalizeImportedAiSkillRecords(storedImportedAiSkills);
    this.settings.aiSkillOverrides = normalizeAiSkillOverrides(storedAiSkillOverrides);
    this.settings.chatWritebackMode = normalizeChatWritebackMode(
      storedChatWritebackMode,
      storedData.autoApplyChatToDaily === true
    );
    this.settings.autoApplyChatToDaily = this.settings.chatWritebackMode !== "off";
    this.settings.browserCaptureEnabled = needsBrowserCaptureSetupMigration
      ? true
      : storedData.browserCaptureEnabled !== false;
    this.settings.browserCaptureSetupVersion = 1;
    this.settings.browserCapturePort = normalizeBrowserCapturePort(storedData.browserCapturePort);
    this.settings.webSearchProvider = normalizeWebSearchProvider(legacyBotData.webSearchProvider);
    this.settings.webSearchApiKey = String(legacyBotData.webSearchApiKey || "").trim();
    this.settings.webSearchEndpoint = String(legacyBotData.webSearchEndpoint || "").trim();
    this.settings.pdfOcrEngine = normalizePdfOcrEngine(storedData.pdfOcrEngine);
    this.settings.paddleOcrEndpoint = normalizePaddleOcrEndpoint(storedData.paddleOcrEndpoint);
    this.settings.autoReviewEnabled = storedData.autoReviewEnabled === true;
    this.settings.autoReviewTime = normalizeAutoReviewTime(storedData.autoReviewTime);
    this.settings.autoReviewCatchUp = storedData.autoReviewCatchUp !== false;
    this.settings.browserCaptureToken = needsBrowserCaptureTokenSave
      ? createBrowserCaptureToken()
      : String(storedData.browserCaptureToken).trim();
    this.settings.weixinBotEnabled = legacyBotData.weixinBotEnabled === true;
    this.settings.weixinBotSetupVersion = 3;
    this.settings.weixinSenderPolicy = normalizeWeixinSenderPolicy(
      legacyBotData.weixinSenderPolicy ?? legacyBotData.openClawSenderPolicy
    );
    const storedWeixinPermission = legacyBotData.weixinPermissionMode ?? legacyBotData.openClawPermissionMode;
    this.settings.weixinPermissionMode = storedWeixinSetupVersion < 2
      && (storedWeixinPermission === undefined || storedWeixinPermission === "read-only")
      ? "confirm"
      : normalizeWeixinPermission(storedWeixinPermission);
    this.settings.weixinCaptureToDailyEnabled = legacyBotData.weixinCaptureToDailyEnabled !== false;
    this.settings.weixinDailyDigestEnabled = legacyBotData.weixinDailyDigestEnabled !== false;
    this.settings.weixinDailyDigestCatchUp = legacyBotData.weixinDailyDigestCatchUp !== false;
    this.settings.weixinDefaultProjectId = String(
      legacyBotData.weixinDefaultProjectId ?? legacyBotData.openClawDefaultProjectId ?? ""
    ).trim();
    this.settings.weixinTextAiModel = String(legacyBotData.weixinTextAiModel ?? "").trim();
    this.settings.weixinApprovedSenders = normalizeWeixinApprovedSenders(
      legacyBotData.weixinApprovedSenders ?? legacyBotData.openClawApprovedSenders
    );
    const legacyAllowedGroups = legacyBotData.weixinAllowedGroups ?? legacyBotData.openClawAllowedGroups;
    this.settings.weixinAllowedGroups = Array.from(new Set(
      Array.isArray(legacyAllowedGroups)
        ? legacyAllowedGroups
          .map((item) => String(item || "").trim())
          .filter((item) => item && !item.toLowerCase().startsWith("qqbot:"))
        : []
    )).slice(0, 500);
    this.settings.weixinPendingPairings = normalizeWeixinPendingPairings(
      legacyBotData.weixinPendingPairings ?? legacyBotData.openClawPendingPairings
    );
    this.settings.weixinConversationRoutes = normalizeWeixinConversationRoutes(
      legacyBotData.weixinConversationRoutes ?? legacyBotData.openClawConversationRoutes
    );
    this.settings.weixinReminderRoutes = normalizeWeixinReminderRoutes(legacyBotData.weixinReminderRoutes);
    if (hasLegacyOpenClawSettings) {
      const writableSettings = this.settings as unknown as Record<string, unknown>;
      Object.keys(writableSettings).filter((key) => key.startsWith("openClaw")).forEach((key) => delete writableSettings[key]);
    }
    const needsImportedAiSkillMigration = Array.isArray(storedImportedAiSkills)
      && this.settings.importedAiSkills.length !== storedImportedAiSkills.length;
    const needsAiSkillOverrideMigration = Array.isArray(storedAiSkillOverrides)
      && this.settings.aiSkillOverrides.length !== storedAiSkillOverrides.length;
    this.settings.licenseInstallationId = normalizeInstallationId(this.settings.licenseInstallationId);
    this.settings.licenseApiBaseUrl = this.settings.licenseApiBaseUrl?.trim() || DEFAULT_SETTINGS.licenseApiBaseUrl;
    this.settings.licenseEmail = this.settings.licenseEmail ?? "";
    this.settings.licenseKey = this.settings.licenseKey ?? "";
    this.settings.licenseEntitlementToken = this.settings.licenseEntitlementToken ?? "";
    this.settings.licenseSnapshot = this.settings.licenseSnapshot ?? null;
    this.settings.licenseLastOrderId = this.settings.licenseLastOrderId ?? "";
    this.settings.licenseLastOrderClaimToken = this.settings.licenseLastOrderClaimToken ?? "";
    this.settings.licenseLastOrderSnapshot = this.settings.licenseLastOrderSnapshot ?? "";
    this.settings.licenseLastPaymentSnapshot = this.settings.licenseLastPaymentSnapshot ?? "";
    this.settings.licenseLastCheckedAt = this.settings.licenseLastCheckedAt ?? "";
    if (!this.settings.aiApiKeys) {
      this.settings.aiApiKeys = {};
    }
    if (!this.settings.aiProviderConfigs) {
      this.settings.aiProviderConfigs = {};
    }
    const storedKey = getStoredAiApiKey(this.settings, this.settings.aiProvider);
    if (storedKey) {
      this.settings.aiApiKey = storedKey;
    } else if (this.settings.aiApiKey.trim()) {
      setStoredAiApiKey(this.settings, this.settings.aiProvider, this.settings.aiApiKey);
    }
    setStoredAiProviderConfig(this.settings, this.settings.aiProvider, getCurrentAiProviderConfig(this.settings));
    if (needsInitialLicenseSave || needsImportedAiSkillMigration || needsAiSkillOverrideMigration || needsBrowserCaptureTokenSave || needsBrowserCaptureSetupMigration || needsWeixinSetupMigration || needsChatWritebackModeMigration) {
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    this.settings.autoReviewTime = normalizeAutoReviewTime(this.settings.autoReviewTime);
    await this.saveData(this.settings);
  }

  private async runAutoReview(trigger: AutoReviewTrigger): Promise<void> {
    try {
      const result = await this.autoReviewService?.runDue(trigger);
      if (result?.status === "stale" && trigger === "startup") {
        new Notice("自动复盘草稿的来源已变化，请到复盘页手动刷新。", 7000);
      }
    } catch (error) {
      console.error("[Life OS] Auto review draft failed", error);
    }
  }

  getBrowserCaptureStatus(): BrowserCaptureServerStatus {
    return this.browserCaptureServer.getStatus();
  }

  getBrowserCaptureConnection(): { endpoint: string; token: string } {
    const port = normalizeBrowserCapturePort(this.settings.browserCapturePort);
    return {
      endpoint: `http://127.0.0.1:${port}`,
      token: this.settings.browserCaptureToken
    };
  }

  async regenerateBrowserCaptureToken(): Promise<void> {
    this.settings.browserCaptureToken = createBrowserCaptureToken();
    await this.saveSettings();
    await this.refreshBrowserCaptureBridge();
  }

  async refreshBrowserCaptureBridge(): Promise<BrowserCaptureServerStatus> {
    await this.browserCaptureServer.stop();
    if (!this.settings.browserCaptureEnabled) return this.browserCaptureServer.getStatus();
    const port = normalizeBrowserCapturePort(this.settings.browserCapturePort);
    this.settings.browserCapturePort = port;
    return this.browserCaptureServer.start({
      port,
      token: this.settings.browserCaptureToken,
      listProjects: async () => {
        const projects = await this.createProjectService().loadProjects();
        return projects.map((project) => ({ id: project.id, name: project.name }));
      },
      createProject: async (input) => {
        const project = await this.createProjectService().createProject({
          name: input.name,
          goal: input.goal,
          type: "general",
          status: "active"
        });
        return { id: project.id, name: project.name };
      },
      capture: async (request, options, onProgress) => {
        const projects = await this.createProjectService().loadProjects();
        if (!projects.some((project) => project.id === request.projectId)) {
          throw new Error("目标项目不存在，请在浏览器扩展中刷新项目列表。");
        }
        return this.createAiWorkspaceService().captureBrowserConversation(
          request.projectId,
          request.conversation,
          options,
          onProgress
        );
      }
    });
  }

  getWeixinConnectionStatus(): WeixinConnectionStatus {
    return this.getWeixinIlinkService().getStatus();
  }

  subscribeWeixinConnectionStatus(listener: (status: WeixinConnectionStatus) => void): () => void {
    return this.getWeixinIlinkService().subscribe(listener);
  }

  async refreshWeixinConnection(): Promise<WeixinConnectionStatus> {
    await this.weixinIlinkService?.stop();
    this.weixinAssistantService = this.createWeixinAssistantService();
    this.weixinIlinkService = new WeixinIlinkService(this.app, {
      pluginId: this.manifest.id,
      isEnabled: () => this.settings.weixinBotEnabled,
      canHydrateMedia: (request) => evaluateWeixinAccess({
        senderPolicy: this.settings.weixinSenderPolicy,
        approvedSenders: this.settings.weixinApprovedSenders,
        allowedGroups: this.settings.weixinAllowedGroups
      }, request).allowed,
      canAnalyzeImages: () => this.settings.enableVisionFileAnalysis === true && Boolean(this.settings.visionAiModel?.trim()),
      stageInboundMessage: (request) => this.getWeixinAssistantService().stageInboundMessage(request),
      handleMessage: (request) => this.getWeixinAssistantService().handleMessage(request),
      recoverPendingMessages: (accountId) => this.getWeixinAssistantService().recoverPendingMessages(accountId),
      markMessageDelivered: (request) => this.getWeixinAssistantService().markMessageDelivered(request),
      markMessageDeliveryFailed: (request, error) => this.getWeixinAssistantService().markMessageDeliveryFailed(request, error)
    });
    return this.weixinIlinkService.initialize();
  }

  async startWeixinLogin(): Promise<WeixinConnectionStatus> {
    if (!this.settings.weixinBotEnabled) {
      this.settings.weixinBotEnabled = true;
      await this.saveSettings();
    }
    return this.getWeixinIlinkService().startLogin();
  }

  submitWeixinVerificationCode(code: string): void {
    this.getWeixinIlinkService().submitVerificationCode(code);
  }

  async disconnectWeixin(accountId = ""): Promise<void> {
    this.weixinAssistantService?.clearPendingImages(accountId);
    await this.getWeixinIlinkService().disconnect(accountId);
  }

  private async deliverWeixinReminders(): Promise<void> {
    if (this.weixinReminderDeliveryRunning || !this.settings.weixinBotEnabled) return;
    this.weixinReminderDeliveryRunning = true;
    const service = new WeixinReminderService(this.app, this.fileSystem());
    try {
      const due = await service.claimDue();
      for (const reminder of due) {
        const route = this.settings.weixinReminderRoutes.find((item) => item.ref === reminder.routeRef);
        try {
          if (!route || route.conversationId.startsWith("group:")) {
            throw new Error("提醒的微信私聊路由已不存在。");
          }
          const allowed = evaluateWeixinAccess({
            senderPolicy: this.settings.weixinSenderPolicy,
            approvedSenders: this.settings.weixinApprovedSenders,
            allowedGroups: this.settings.weixinAllowedGroups
          }, {
            version: 1,
            channel: "weixin",
            messageId: reminder.clientId,
            accountId: route.accountId,
            conversationId: route.conversationId,
            threadId: route.threadId,
            senderId: route.senderId,
            senderName: route.senderName,
            isGroup: false,
            wasMentioned: false,
            content: "",
            timestamp: new Date().toISOString(),
            media: []
          }).allowed;
          if (!allowed) throw new Error("该微信账号已被取消授权，提醒暂不发送。");
          await this.getWeixinIlinkService().sendProactiveText(
            route.accountId,
            route.senderId,
            route.conversationId,
            `Life OS 提醒\n${reminder.content}\n计划时间：${new Date(reminder.dueAt).toLocaleString("zh-CN", { hour12: false })}\n编号：${reminder.id}`,
            reminder.clientId
          );
          await service.markDelivered(reminder.id);
        } catch (error) {
          console.warn(`[Life OS] Weixin reminder ${reminder.id} delivery failed`, error);
          await service.markFailed(reminder.id, error);
        }
      }
    } catch (error) {
      console.error("[Life OS] Weixin reminder scheduler failed", error);
    } finally {
      this.weixinReminderDeliveryRunning = false;
    }
  }

  private async runWeixinDailyDigest(trigger: "startup" | "midnight" | "timer"): Promise<void> {
    if (
      this.weixinDailyDigestRunning
      || !this.settings.weixinBotEnabled
      || !this.settings.weixinDailyDigestEnabled
      || (trigger === "startup" && !this.settings.weixinDailyDigestCatchUp)
      || (trigger === "timer" && new Date().getHours() !== 0)
    ) return;
    this.weixinDailyDigestRunning = true;
    const date = this.getRelativeDate(-1);
    try {
      const result = await this.getWeixinAssistantService().runAutomaticDailyDigest(date);
      if (result.failedRoutes > 0) {
        console.warn(`[Life OS] Weixin daily digest ${date}: ${result.failedRoutes} route(s) will retry.`);
      } else if (result.status === "delivered") {
        console.log(`[Life OS] Weixin daily digest ${date} delivered to ${result.deliveredRoutes} route(s).`);
      }
    } catch (error) {
      console.error(`[Life OS] Weixin daily digest ${date} failed`, error);
    } finally {
      this.weixinDailyDigestRunning = false;
    }
  }

  async listWeixinProjects(): Promise<Array<{ id: string; name: string }>> {
    return (await this.createProjectService().loadProjects()).map((project) => ({
      id: project.id,
      name: project.name
    }));
  }

  async approveWeixinPairing(code: string): Promise<boolean> {
    return Boolean(await this.getWeixinAssistantService().approvePairing(code));
  }

  async rejectWeixinPairing(code: string): Promise<boolean> {
    return this.getWeixinAssistantService().rejectPairing(code);
  }

  async revokeWeixinSender(key: string): Promise<boolean> {
    return this.getWeixinAssistantService().revokeSender(key);
  }

  private createWeixinAssistantService(): WeixinAssistantService {
    return new WeixinAssistantService(this.app, this.settings, this.ai, {
      saveSettings: () => this.saveSettings(),
      sendProactiveText: (accountId, senderId, conversationId, text, clientId) => this.getWeixinIlinkService()
        .sendProactiveText(accountId, senderId, conversationId, text, clientId)
    });
  }

  private getWeixinAssistantService(): WeixinAssistantService {
    if (!this.weixinAssistantService) this.weixinAssistantService = this.createWeixinAssistantService();
    return this.weixinAssistantService;
  }

  private getWeixinIlinkService(): WeixinIlinkService {
    if (!this.weixinIlinkService) {
      this.weixinIlinkService = new WeixinIlinkService(this.app, {
        pluginId: this.manifest.id,
        isEnabled: () => this.settings.weixinBotEnabled,
        canHydrateMedia: (request) => evaluateWeixinAccess({
          senderPolicy: this.settings.weixinSenderPolicy,
          approvedSenders: this.settings.weixinApprovedSenders,
          allowedGroups: this.settings.weixinAllowedGroups
        }, request).allowed,
        canAnalyzeImages: () => this.settings.enableVisionFileAnalysis === true && Boolean(this.settings.visionAiModel?.trim()),
        stageInboundMessage: (request) => this.getWeixinAssistantService().stageInboundMessage(request),
        handleMessage: (request) => this.getWeixinAssistantService().handleMessage(request),
        recoverPendingMessages: (accountId) => this.getWeixinAssistantService().recoverPendingMessages(accountId),
        markMessageDelivered: (request) => this.getWeixinAssistantService().markMessageDelivered(request),
        markMessageDeliveryFailed: (request, error) => this.getWeixinAssistantService().markMessageDeliveryFailed(request, error)
      });
    }
    return this.weixinIlinkService;
  }

  private createProjectService(): ProjectService {
    return new ProjectService(
      this.app,
      new FileSystemService(this.app, this.getRoot(), this.settings.directoryLanguage)
    );
  }

  private createAiWorkspaceService(): AiWorkspaceService {
    return new AiWorkspaceService(
      this.app,
      new FileSystemService(this.app, this.getRoot(), this.settings.directoryLanguage),
      this.settings,
      this.ai
    );
  }

  async refreshTrackedAiWorkspaceSessions(showNotice = false): Promise<void> {
    if (this.aiWorkspaceSyncRunning) {
      if (showNotice) new Notice("正在检查已跟踪会话，请稍候。", 3000);
      return;
    }
    this.aiWorkspaceSyncRunning = true;
    try {
      const report = await this.createAiWorkspaceService().syncTrackedSessions();
      if (report.updated > 0 || report.needsReview > 0 || report.errors > 0) {
        for (const leaf of this.app.workspace.getLeavesOfType(AI_WORKSPACE_VIEW_TYPE)) {
          const view = leaf.view as AiWorkspaceView;
          await view.refreshFromAutoSync();
        }
      }
      if (showNotice) {
        const detail = report.updated > 0
          ? `已更新 ${report.updated} 个会话，新增 ${report.appendedMessages} 条对话。`
          : report.needsReview > 0
            ? `${report.needsReview} 个会话检测到历史变化，需要手动检查。`
            : `已检查 ${report.checked} 个会话，当前都是最新。`;
        new Notice(detail, 5000);
      }
    } catch (error) {
      console.error("[Life OS] Failed to sync tracked AI Workspace sessions.", error);
      if (showNotice) {
        new Notice(error instanceof Error ? error.message : "自动检查会话失败。", 6000);
      }
    } finally {
      this.aiWorkspaceSyncRunning = false;
    }
  }

  private async verifyStoredLicenseEntitlement(): Promise<void> {
    const token = this.settings.licenseEntitlementToken;
    if (!token || !this.settings.licenseSnapshot) return;
    try {
      await verifyLicenseEntitlementToken(token, this.settings.licenseInstallationId);
    } catch (error) {
      console.warn("[Life OS] Stored entitlement token could not be verified.", error);
    }
  }

  applyTheme(): void {
    const themes = ["pls-theme-cool", "pls-theme-dark-tech", "pls-theme-wabi", "pls-theme-pastel"];
    for (const cls of themes) {
      document.body.removeClass(cls);
    }
    for (const cls of THEME_STYLES.map((style) => `lifeos-theme-${style}`)) {
      document.body.removeClass(cls);
    }
    const themeStyle = normalizeThemeStyle(this.settings.themeStyle);
    this.settings.themeStyle = themeStyle;
    document.body.addClass(`pls-theme-${this.settings.theme}`);
    for (const cls of getThemeStyleClasses(themeStyle)) {
      document.body.addClass(cls);
    }
    this.syncThemeTargets(themeStyle);
    this.configureLiquidGlassRuntime(themeStyle);
    this.refreshVisibleNames();
    this.queueLifeOsFileStyling();
    document.body.removeClass("pls-has-custom-bg");
    document.body.style.removeProperty("--pls-custom-bg");
    const backgroundUrl = this.getBackgroundResourceUrl();
    if (backgroundUrl) {
      document.body.addClass("pls-has-custom-bg");
      document.body.style.setProperty("--pls-custom-bg", `url("${backgroundUrl.replace(/"/g, "%22")}")`);
    }
  }

  private syncThemeTargets(themeStyle: ThemeStyle): void {
    const themeClasses = THEME_STYLES.map((style) => `lifeos-theme-${style}`);
    document.querySelectorAll<HTMLElement>(".lifeos-root, .lifeos-settings, .lifeos-file-leaf").forEach((element) => {
      element.removeClass(...themeClasses);
      for (const cls of getThemeStyleClasses(themeStyle)) {
        element.addClass(cls);
      }
    });
  }

  private configureLiquidGlassRuntime(themeStyle: ThemeStyle): void {
    if (themeStyle !== "liquid-glass") {
      this.stopLiquidGlassRuntime();
      return;
    }
    if (!this.liquidGlassObserver) {
      this.liquidGlassObserver = new MutationObserver(() => this.queueLiquidGlassRefresh());
      this.liquidGlassObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
    }
    this.queueLiquidGlassRefresh();
  }

  private queueLiquidGlassRefresh(): void {
    if (this.settings.themeStyle !== "liquid-glass") return;
    if (this.liquidGlassRefreshTimer) {
      window.clearTimeout(this.liquidGlassRefreshTimer);
    }
    this.liquidGlassRefreshTimer = window.setTimeout(() => {
      this.liquidGlassRefreshTimer = null;
      void refreshLifeOSLiquidGlassRuntime();
    }, 180);
  }

  private stopLiquidGlassRuntime(): void {
    if (this.liquidGlassRefreshTimer) {
      window.clearTimeout(this.liquidGlassRefreshTimer);
      this.liquidGlassRefreshTimer = null;
    }
    this.liquidGlassObserver?.disconnect();
    this.liquidGlassObserver = null;
    destroyLifeOSLiquidGlassRuntime();
  }

  private refreshVisibleNames(): void {
    const systemName = this.settings.systemName?.trim() || "Life OS";
    const assistantName = this.settings.assistantName?.trim() || "Life OS";
    document.querySelectorAll<HTMLElement>(".lifeos-brand-title, .pls-sidebar-title").forEach((element) => {
      element.setText(systemName);
    });
    document.querySelectorAll<HTMLElement>(".lifeos-chat-top-copy h1").forEach((element) => {
      element.setText(assistantName);
    });
    document.querySelectorAll<HTMLElement>(".lifeos-chat-welcome-assistant-name").forEach((element) => {
      element.setText(assistantName);
    });
    document.querySelectorAll<HTMLElement>(".lifeos-chat-bubble-ai .lifeos-chat-bubble-label").forEach((element) => {
      element.setText(assistantName);
    });
  }

  getBackgroundResourceUrl(): string | null {
    const imagePath = this.settings.backgroundImagePath?.trim();
    const resourcePath = imagePath || `${this.app.vault.configDir}/plugins/${this.manifest.id}/assets/default-background.png`;
    const abstract = this.app.vault.getAbstractFileByPath(resourcePath);
    if (!(abstract instanceof TFile)) return null;
    const adapter = this.app.vault.adapter as unknown as {
      getResourcePath?: (normalizedPath: string) => string;
    };
    return adapter.getResourcePath?.(abstract.path) ?? null;
  }

  private registerModalTextareaEnhancer(): void {
    const keepModalFieldVisible = (field: HTMLElement) => {
      window.setTimeout(() => {
        if (document.activeElement !== field || !field.isConnected) return;

        const viewport = window.visualViewport;
        const viewportTop = viewport?.offsetTop ?? 0;
        const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight ?? document.documentElement.clientHeight);
        const safeTop = viewportTop + 16;
        const safeBottom = Math.max(safeTop + 80, viewportBottom - 24);
        const rect = field.getBoundingClientRect();
        const scrollContainer = field.closest<HTMLElement>(
          ".lifeos-modal-body, .lifeos-v2-modal-body, .lifeos-github-skill-body, .modal-content"
        );

        if (scrollContainer && scrollContainer.scrollHeight > scrollContainer.clientHeight + 1) {
          const containerRect = scrollContainer.getBoundingClientRect();
          const containerTop = Math.max(containerRect.top, safeTop);
          const containerBottom = Math.min(containerRect.bottom, safeBottom);
          const topDelta = rect.top - containerTop;
          const bottomDelta = rect.bottom - containerBottom;

          if (bottomDelta > 0) {
            scrollContainer.scrollTop += bottomDelta + 12;
            return;
          }

          if (topDelta < 0) {
            scrollContainer.scrollTop += topDelta - 12;
            return;
          }
        }

        if (rect.top < safeTop || rect.bottom > safeBottom) {
          field.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      }, 120);
    };

    const enhanceTextarea = (textarea: HTMLTextAreaElement) => {
      if (textarea.dataset.plsMarkdownEnhanced === "true") return;
      textarea.dataset.plsMarkdownEnhanced = "true";
      textarea.classList.add("pls-markdown-field");
      textarea.wrap = "soft";
      textarea.spellcheck = true;
      textarea.setAttribute("autocapitalize", "sentences");
      textarea.setAttribute("autocomplete", "on");
      textarea.setAttribute("aria-multiline", "true");
      textarea.setAttribute("data-pls-markdown", "true");
      textarea.addEventListener("focus", () => keepModalFieldVisible(textarea));
    };

    const enhanceModalField = (field: HTMLInputElement | HTMLSelectElement) => {
      if (field.dataset.plsMobileEnhanced === "true") return;
      field.dataset.plsMobileEnhanced = "true";
      field.addEventListener("focus", () => keepModalFieldVisible(field));
    };

    const enhanceWithin = (root: ParentNode) => {
      if (root instanceof HTMLTextAreaElement && root.closest(".pls-modal, .pls-chat, .pls-settings, .lifeos-modal-host")) {
        enhanceTextarea(root);
      }
      if ((root instanceof HTMLInputElement || root instanceof HTMLSelectElement) && root.closest(".lifeos-modal-host")) {
        enhanceModalField(root);
      }
      if (root instanceof Element) {
        root.querySelectorAll<HTMLTextAreaElement>(".pls-modal textarea, .pls-chat textarea, .pls-settings textarea, .lifeos-modal-host textarea")
          .forEach(enhanceTextarea);
        root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".lifeos-modal-host input, .lifeos-modal-host select")
          .forEach(enhanceModalField);
      }
    };

    enhanceWithin(document.body);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node instanceof Element) {
            enhanceWithin(node);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    this.modalTextareaObserver = observer;
    this.register(() => observer.disconnect());
  }

  private installMobileViewportVariables(): void {
    const root = document.documentElement;
    const update = () => {
      const viewport = window.visualViewport;
      const height = Math.max(320, Math.round(viewport?.height ?? window.innerHeight));
      const keyboardInset = viewport
        ? Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop))
        : 0;
      root.style.setProperty("--lifeos-visual-viewport-height", `${height}px`);
      root.style.setProperty("--lifeos-keyboard-inset", `${keyboardInset}px`);
      root.classList.toggle("lifeos-soft-keyboard-active", keyboardInset > 80);
      document.body?.classList.toggle("lifeos-soft-keyboard-active", keyboardInset > 80);
    };

    update();
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    this.registerDomEvent(window, "resize", update);
    this.register(() => {
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      root.style.removeProperty("--lifeos-visual-viewport-height");
      root.style.removeProperty("--lifeos-keyboard-inset");
      root.classList.remove("lifeos-soft-keyboard-active");
      document.body?.classList.remove("lifeos-soft-keyboard-active");
    });
  }

  async setTheme(theme: string): Promise<void> {
    this.settings.theme = theme as typeof this.settings.theme;
    await this.saveSettings();
    this.applyTheme();
  }

  // ═══════════════════════════════════════════════════
  // Path & structure
  // ═══════════════════════════════════════════════════

  getRoot(): string {
    return sanitizeFolderPath(this.settings.rootFolder || DEFAULT_SETTINGS.rootFolder);
  }

  async writeDebugLoadMarker(): Promise<void> {
    const pluginDir = `${this.app.vault.configDir}/plugins/personal-life-system`;
    const markerPath = `${pluginDir}/loaded.txt`;
    const content = `loaded ${new Date().toISOString()}\n`;
    try {
      const existing = this.app.vault.getAbstractFileByPath(markerPath);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        await ensureFile(this.app, markerPath, content);
      }
    } catch {
      // Debug marker is best-effort and should never block plugin startup.
    }
  }

  path(...parts: string[]): string {
    return this.fileSystem().path(...parts);
  }

  fileSystem(): FileSystemService {
    return new FileSystemService(this.app, this.getRoot(), this.settings.directoryLanguage);
  }

  async ensureBaseStructure(): Promise<void> {
    await this.fileSystem().ensureBaseStructure();
    return;
    const root = this.getRoot();
    const folders = [
      root,
      this.path("Daily"),
      this.path("Inbox"),
      this.path("Tasks"),
      this.path("Memory"),
      this.path("Memory", "Core"),
      this.path("Memory", "Inbox"),
      this.path("Memory", "Episodes"),
      this.path("Memory", "Summaries", "Daily"),
      this.path("Memory", "Summaries", "Weekly"),
      this.path("Memory", "Summaries", "Monthly"),
      this.path("Memory", "Summaries", "Yearly"),
      this.path("Reviews", "Daily"),
      this.path("Reviews", "Weekly"),
      this.path("Reviews", "Monthly"),
      this.path("Exam", "Xingce"),
      this.path("Exam", "Interview"),
      this.path("Exam", "QuestionBank"),
      this.path("Exam", "Goals"),
      this.path("Exam", "Tasks"),
      this.path("Exam", "Checkins"),
      this.path("Exam", "Materials"),
      this.path("Chat"),
      this.path("Reports"),
      this.path("Templates")
    ];

    for (const folder of folders) {
      await ensureFolder(this.app, folder);
    }

    await ensureFile(
      this.app,
      this.path("Tasks", "open.md"),
      "# 未完成待办\n\n"
    );
    await ensureFile(this.app, this.path("Tasks", "done.md"), "# 已完成待办\n\n");

    for (const category of MEMORY_CATEGORIES) {
      await ensureFile(
        this.app,
        this.path("Memory", `${category}.md`),
        `---\ntype: memory-category\ncategory: ${category}\nupdated: ${formatDate()}\n---\n\n# ${category}记忆\n\n`
      );
    }

    await ensureFile(
      this.app,
      this.path("Memory", "Inbox", "pending-memories.md"),
      `---\ntype: memory-inbox\nupdated: ${formatDate()}\n---\n\n# 待确认记忆\n\n`
    );

    await ensureFile(
      this.app,
      this.path("Memory", "Core", "profile.md"),
      `---\ntype: core-memory\ncategory: profile\nupdated: ${formatDate()}\n---\n\n# 用户画像\n\n- 用户称呼：${this.settings.userName || "未设置"}\n- 助手名称：${this.settings.assistantName}\n\n## 稳定偏好\n\n- 偏好本地优先、Markdown 透明、可控的 AI 写回。\n`
    );

    await ensureFile(
      this.app,
      this.path("Memory", "Core", "current-projects.md"),
      `---\ntype: core-memory\ncategory: current-projects\nupdated: ${formatDate()}\n---\n\n# 当前项目\n\n## 个人人生系统 Obsidian 插件\n\n- 当前重点：AI 写回预览、Memory OS、Dashboard 今日工作台、Quick Capture。\n`
    );
  }

  getTodayNotePath(date = formatDate()): string {
    return this.dailyNotes().getTodayNotePath(date);
  }

  getDailyNotesFolder(): string | null {
    const config = (this.app as unknown as {
      internalPlugins?: {
        plugins?: Record<string, { instance?: { options?: { folder?: string } } }>;
      };
    }).internalPlugins?.plugins?.["daily-notes"]?.instance?.options;
    const folder = sanitizeFolderPath(config?.folder ?? "");
    return folder || null;
  }

  // ═══════════════════════════════════════════════════
  // Daily note
  // ═══════════════════════════════════════════════════

  async openTodayNote(fullTemplate: boolean): Promise<TFile> {
    await this.ensureBaseStructure();
    await this.runStartupDailyMaintenance();
    const date = formatDate();
    const file = await this.dailyNotes().ensureTodayNote(date, fullTemplate);
    await this.app.workspace.getLeaf(false).openFile(file);
    return file;
  }

  async ensureTodayNote(fullTemplate = false): Promise<TFile> {
    await this.ensureBaseStructure();
    return this.dailyNotes().ensureTodayNote(formatDate(), fullTemplate);
  }

  listDailyNotes(): TFile[] {
    return this.dailyNotes().listDailyNotes();
  }

  private async ensureDailyNoteForDate(date: string, fullTemplate = false): Promise<TFile> {
    return this.dailyNotes().ensureTodayNote(date, fullTemplate);
  }

  private dailyNotes(): DailyNoteService {
    return new DailyNoteService(this.app, this.fileSystem(), this.settings);
  }

  async finishTodayNote(): Promise<void> {
    const file = await this.openTodayNote(false);
    if (!this.settings.enableAutoAnalysis) {
      new Notice("已打开今日记录。自动分析已关闭，可手动触发总结或待办提取。");
      return;
    }
    if (!requireProFeature(this, "aiDiarySummary")) return;
    const archive = await this.generateDailyArchive(file, formatDate());
    const content = await this.app.vault.read(file);
    const items: WritebackItem[] = [
      {
        id: makeId("daily-archive"),
        kind: "replace",
        title: "写入日终总结",
        content: this.buildDailyArchiveNoteContent(content, archive),
        targetPath: file.path,
        sourcePath: file.path,
        checked: true
      },
      ...this.buildMemoryArtifactWritebackItems(file, archive.summary, archive.nextSteps),
      ...await this.buildTaskWritebackItems(file, false),
      ...await this.buildMemoryWritebackItems(file)
    ];

    if (this.settings.enableFourSages) {
      if (content.includes("## 四圣谏言")) {
        new Notice("四圣谏言已存在，跳过重复生成。");
      } else {
        const result = await this.analyzeFourSages(content);
        if (result) {
          items.push({
            id: makeId("four-sages"),
            kind: "append",
            title: "写入四圣谏言",
            content: `\n\n${result}\n`,
            targetPath: file.path,
            sourcePath: file.path,
            checked: true
          });
        }
      }
    }

    const written = await openWritebackPreview(this.app, {
      title: "确认写入今日分析",
      description: "AI 生成的日终总结、待办和候选记忆会先进入预览。只有确认后才会写入 Markdown 文件。",
      items,
      onConfirm: async (confirmed) => {
        await applyWritebackItems(this.app, confirmed);
      }
    });
    if (written.length > 0) {
      await this.checkAndGeneratePeriodicSummaries();
      new Notice("今日记录分析已确认写入。");
    } else {
      new Notice("已取消写入，AI 内容没有保存到文件。");
    }
  }

  // ═══════════════════════════════════════════════════
  // AI operations
  // ═══════════════════════════════════════════════════

  async summarizeFile(file: TFile | null): Promise<void> {
    if (!file) {
      new Notice("没有当前文件。");
      return;
    }
    if (!requireProFeature(this, "aiDiarySummary")) return;
    const content = await this.app.vault.read(file);
    const response = await this.ai.complete({
      messages: [
        { role: "system", content: buildSystemPrompt(this.settings) },
        {
          role: "user",
          content: `请总结下面这篇日记，输出 Markdown，包含：完成了什么、卡点、明天最重要的一件事。\n\n${content}`
        }
      ]
    });
    if (!response.ok || !response.text) {
      new Notice(response.error ?? "总结失败。");
      return;
    }
    const item: WritebackItem = {
      id: makeId("summary"),
      kind: "append",
      title: `${this.settings.assistantName}总结`,
      content: `\n\n## ${this.settings.assistantName}总结\n\n${response.text}\n`,
      targetPath: file.path,
      sourcePath: file.path,
      checked: true
    };
    const written = await openWritebackPreview(this.app, {
      title: "确认写入总结",
      description: "AI 已生成总结。确认后会追加到当前笔记末尾。",
      items: [item],
      onConfirm: async (items) => {
        await appendWritebackItems(this.app, items);
      }
    });
    if (written.length > 0) {
      new Notice("总结已写入。");
    }
  }

  private async buildTaskWritebackItems(file: TFile, showNotice: boolean): Promise<WritebackItem[]> {
    const notify = (message: string) => {
      if (showNotice) {
        new Notice(message);
      }
    };

    const content = await this.app.vault.read(file);
    const plainContent = content
      .replace(/^---[\s\S]*?---\s*/m, "")
      .replace(/[#>\-\[\]\s_：:0-9/]+/g, "")
      .trim();
    if (!plainContent) {
      notify("今日日记还没有可提取内容。先写几句记录，再提取待办。");
      return [];
    }
    if (!this.ai.isConfigured()) {
      notify("AI 未配置，已使用规则提取。你也可以先在设置里配置 AI。");
      return this.buildRuleTaskWritebackItems(file, content, notify);
    }
    const response = await this.ai.complete({
      responseFormat: "json",
      messages: [
        { role: "system", content: buildSystemPrompt(this.settings) },
        {
          role: "user",
          content:
            "从下面内容提取需要记录的待办。只返回 JSON 数组，每项包含 title、due_date、category。没有待办则返回 []。\n\n" +
            content
        }
      ]
    });
    if (!response.ok || !response.text) {
      notify(response.error ?? "待办提取失败。");
      return [];
    }

    const parsed = extractJsonArray(response.text);
    if (!parsed || parsed.length === 0) {
      notify("没有识别到新的待办。");
      return [];
    }

    const taskLines = parsed
      .map((item, index) => {
        const obj = item as Record<string, unknown>;
        const title = String(obj.title ?? "").trim();
        if (!title) {
          return "";
        }
        const due = String(obj.due_date ?? "").trim();
        const category = String(obj.category ?? "task").trim() || "task";
        const dueText = due ? ` 📅 ${due}` : "";
        return `- [ ] ${title} #pls/task #pls/${category}${dueText} ^${makeId(`pls-task-${index + 1}`)}`;
      })
      .filter(Boolean);

    const openPath = this.path("Tasks", "open.md");
    const openAbstract = this.app.vault.getAbstractFileByPath(openPath);
    let existingTasks = [] as ReturnType<typeof parseOpenTasks>;
    if (openAbstract instanceof TFile) {
      const openContent = await this.app.vault.read(openAbstract);
      existingTasks = parseOpenTasks(openContent);
    }
    const newLines = dedupTaskLines(taskLines, existingTasks);
    const dupCount = taskLines.length - newLines.length;

    if (newLines.length === 0) {
      notify(dupCount > 0 ? `全部 ${dupCount} 条待办已存在，跳过。` : "没有识别到新的待办。");
      return [];
    }

    const lines = newLines.join("\n");
    if (!lines) {
      notify("待办结果为空。");
      return [];
    }

    return [
      {
        id: makeId("tasks-open"),
        kind: "task",
        title: "写入未完成待办",
        content: `\n${lines}\n`,
        targetPath: openPath,
        sourcePath: file.path,
        checked: true
      },
      {
        id: makeId("tasks-source"),
        kind: "append",
        title: "在来源笔记记录提取结果",
        content: `\n\n## 提取待办\n\n${lines}\n`,
        targetPath: file.path,
        sourcePath: file.path,
        checked: true
      }
    ];
  }

  async extractTasksFromFile(file: TFile | null): Promise<void> {
    if (!file) {
      new Notice("没有当前文件。");
      return;
    }
    if (!requireProFeature(this, "aiTaskExtract")) return;
    const items = await this.buildTaskWritebackItems(file, true);
    if (items.length === 0) return;

    const written = await openWritebackPreview(this.app, {
      title: "确认写入待办",
      description: "AI 已提取待办。你可以编辑、取消某个写入目标，确认后再写入文件。",
      items,
      onConfirm: async (confirmed) => {
        await appendWritebackItems(this.app, confirmed);
      }
    });
    if (written.length > 0) {
      new Notice("待办已写入。");
    }
  }

  private async buildMemoryWritebackItems(file: TFile): Promise<WritebackItem[]> {
    const content = await this.app.vault.read(file);
    const response = await this.ai.complete({
      responseFormat: "json",
      messages: [
        { role: "system", content: buildSystemPrompt(this.settings) },
        {
          role: "user",
          content:
            "请从下面日记中提取值得长期记住的信息。只返回 JSON 数组，每项包含 category 和 memory。category 从 学业、项目、备考、人际、健康、偏好、其他 中选择。\n\n" +
            content
        }
      ]
    });
    if (!response.ok || !response.text) {
      return [];
    }
    const parsed = extractJsonArray(response.text);
    if (!parsed || parsed.length === 0) {
      return [];
    }
    const writebackItems: WritebackItem[] = [];
    for (const item of parsed) {
      const obj = item as Record<string, unknown>;
      const memory = String(obj.memory ?? "").trim();
      if (!memory) {
        continue;
      }
      const rawCategory = String(obj.category ?? "其他").trim();
      const category = MEMORY_CATEGORIES.includes(rawCategory) ? rawCategory : "其他";
      writebackItems.push({
        id: makeId("memory"),
        kind: "memory",
        title: `候选记忆：${category}`,
        content: `\n${formatMemoryCandidate({
          id: `mem_${makeId("memory").replace(/-/g, "_")}`,
          content: memory,
          category,
          source: file.path,
          created: `${formatDate()} ${new Date().toTimeString().slice(0, 5)}`,
          status: "pending",
          importance: "normal"
        })}`,
        targetPath: this.path("Memory", "Inbox", "pending-memories.md"),
        sourcePath: file.path,
        checked: true
      });
    }

    return writebackItems;
  }

  async updateMemoryFromFile(file: TFile): Promise<void> {
    if (!requireProFeature(this, "aiMemoryExtract")) return;
    const writebackItems = await this.buildMemoryWritebackItems(file);
    if (writebackItems.length === 0) {
      return;
    }

    const written = await openWritebackPreview(this.app, {
      title: "确认写入候选记忆",
      description: "AI 提取的长期记忆会先进入 Memory Inbox，后续再确认、编辑或归档到正式记忆库。",
      items: writebackItems,
      onConfirm: async (items) => {
        await appendWritebackItems(this.app, items);
      }
    });
    if (written.length > 0) {
      new Notice("候选记忆已写入 Memory Inbox。");
    }
  }

  async analyzeFourSages(text: string): Promise<string | null> {
    if (!requireProFeature(this, "aiDiarySummary")) return null;
    const response = await this.ai.complete({
      messages: [
        { role: "system", content: buildSystemPrompt(this.settings) },
        {
          role: "user",
          content:
            "请用四圣谏言分析下面内容。输出 Markdown，结构为：曾国藩、芒格、巴菲特、Karpathy、综合建议。每部分简洁可执行。\n\n" +
            text
        }
      ]
    });
    if (!response.ok || !response.text) {
      new Notice(response.error ?? "四圣谏言生成失败。");
      return null;
    }
    return `## 四圣谏言\n\n${response.text}`;
  }

  private buildMemoryArtifactWritebackItems(
    file: TFile,
    dailySummary: string,
    nextSteps: string[]
  ): WritebackItem[] {
    const date = file.basename.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? formatDate();
    const [year, month] = date.split("-");
    const items: WritebackItem[] = [];

    if (dailySummary) {
      const summaryPath = this.path("Memory", "Summaries", "Daily", `${date}.md`);
      const summaryContent = `---\ntype: daily-summary\ndate: ${date}\nsource: ${file.path}\nupdated: ${formatDate()}\n---\n\n# ${date} 摘要\n\n${dailySummary}\n`;
      items.push({
        id: makeId("daily-summary"),
        kind: "replace",
        title: "写入今日复盘",
        targetPath: summaryPath,
        sourcePath: file.path,
        checked: true,
        content: summaryContent
      });
    }

    const episodePath = this.path("Memory", "Episodes", year, month, `${date}.md`);
    const episodeContent = `---\ntype: episode\ndate: ${date}\nsource: ${file.path}\nimportance: 3\nstatus: active\n---\n\n# ${date} 事件卡\n\n## 事件\n\n${dailySummary || "（自动归档，待补充）"}\n\n## 结果\n\n${dailySummary || "（自动归档，待补充）"}\n\n## 后续\n\n${nextSteps.length > 0 ? nextSteps.map((step) => `- ${step}`).join("\n") : "- （暂无）"}\n`;
    items.push({
      id: makeId("episode"),
      kind: "replace",
      title: "写入事件卡",
      targetPath: episodePath,
      sourcePath: file.path,
      checked: true,
      content: episodeContent
    });

    return items;
  }

  private getRelativeDate(offsetDays: number): string {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    return formatDate(date);
  }

  private extractOpenTaskLines(content: string): string[] {
    const lines = content.split(/\r?\n/);
    const tasks: string[] = [];
    for (const line of lines) {
      const parsed = parseTaskLine(line);
      if (parsed?.isOpen && this.isCarryableTaskTitle(parsed.title)) {
        tasks.push(parsed.line);
      }
    }
    return tasks;
  }

  private isCarryableTaskTitle(title: string): boolean {
    const normalized = title.replace(/[_\s:：]+/g, "").trim();
    if (!normalized) return false;
    if (/^来自昨天的$/.test(normalized)) return false;
    if (/^明日要做$/.test(normalized)) return false;
    if (/^TODO$/i.test(normalized)) return false;
    return true;
  }

  private makeCarriedTaskLine(taskLine: string, fromDate: string): string {
    const parsed = parseTaskLine(taskLine);
    const title = parsed?.title ?? taskLine.replace(/^-\s*\[ \]\s*/, "").trim();
    const tags = parsed?.tags ?? [];
    const hasTaskTag = tags.includes("pls/task");
    const tagText = [
      hasTaskTag ? "" : "#pls/task",
      "#pls/carryover"
    ].filter(Boolean).join(" ");
    const dueText = parsed?.dueDate ? ` 📅 ${parsed.dueDate}` : "";
    return `- [ ] ${title} ${tagText} 📌 ${fromDate}${dueText} ^${makeId("pls-carry")}`;
  }

  private async carryOpenTasksToDate(
    sourceFile: TFile,
    sourceDate: string,
    targetDate: string
  ): Promise<number> {
    const sourceContent = await this.app.vault.read(sourceFile);
    const openTaskLines = this.extractOpenTaskLines(sourceContent);
    if (openTaskLines.length === 0) return 0;

    const targetFile = await this.ensureDailyNoteForDate(targetDate, false);
    const targetContent = await this.app.vault.read(targetFile);
    const openPath = this.path("Tasks", "open.md");
    const openFile = await ensureFile(this.app, openPath, "# 未完成待办\n\n");
    const openContent = await this.app.vault.read(openFile);
    const candidateLines = openTaskLines.map((line) => this.makeCarriedTaskLine(line, sourceDate));
    const dailyLines = dedupTaskLines(candidateLines, parseOpenTasks(targetContent));
    const openLines = dedupTaskLines(candidateLines, parseOpenTasks(openContent));

    if (dailyLines.length > 0) {
      const carryBlock = `\n\n## 待办延续\n\n> 来自 ${sourceDate} 未完成事项\n\n${dailyLines.join("\n")}\n`;
      await this.app.vault.append(targetFile, carryBlock);
    }

    if (openLines.length > 0) {
      await this.app.vault.append(openFile, `\n## ${targetDate} 继承自 ${sourceDate}\n\n${openLines.join("\n")}\n`);
    }

    return dailyLines.length;
  }

  private parseDailyArchiveJson(text: string): { summary: string; nextSteps: string[] } | null {
    try {
      const parsed = JSON.parse(stripCodeFences(text)) as Record<string, unknown>;
      const summary = String(parsed.summary ?? parsed.daily_summary ?? "").trim();
      const rawNextSteps = parsed.next_steps ?? parsed.nextSteps ?? [];
      const nextSteps = Array.isArray(rawNextSteps)
        ? rawNextSteps.map((item) => String(item).trim()).filter(Boolean)
        : [];
      return summary || nextSteps.length > 0 ? { summary, nextSteps } : null;
    } catch {
      return null;
    }
  }

  private async generateDailyArchive(file: TFile, date: string): Promise<{ summary: string; nextSteps: string[] }> {
    const content = await this.app.vault.read(file);
    if (!this.settings.enableAutoAnalysis || !this.ai.isConfigured() || !hasProAccess(this.settings.licenseSnapshot, new Date(), this.settings.licenseEntitlementToken)) {
      return {
        summary: "自动归档：AI 未启用或未配置，已保留原始日记内容与未完成待办。",
        nextSteps: this.extractOpenTaskLines(content).map((line) => parseTaskLine(line)?.title ?? line)
      };
    }

    const response = await this.ai.complete({
      responseFormat: "json",
      temperature: 0.25,
      messages: [
        { role: "system", content: buildSystemPrompt(this.settings) },
        {
          role: "user",
          content:
            "请把下面这篇日记做日终归档。只返回 JSON 对象，不要代码围栏。格式：{\"summary\":\"...\",\"next_steps\":[\"...\"]}。summary 需要概括今日完成、卡点、状态和明日重点；next_steps 只放仍需延续的行动。\n\n" +
            content
        }
      ]
    });

    if (!response.ok || !response.text) {
      return {
        summary: "自动归档：AI 总结失败，已保留原始日记内容与未完成待办。",
        nextSteps: this.extractOpenTaskLines(content).map((line) => parseTaskLine(line)?.title ?? line)
      };
    }

    return this.parseDailyArchiveJson(response.text) ?? {
      summary: response.text.trim(),
      nextSteps: []
    };
  }

  private buildDailyArchiveBlock(archive: { summary: string; nextSteps: string[] }): string {
    const steps = archive.nextSteps.length > 0
      ? archive.nextSteps.map((step) => `- [ ] ${step}`).join("\n")
      : "- 暂无";
    return [
      "<!-- pls-daily-archive:start -->",
      "## 日终总结",
      "",
      archive.summary,
      "",
      "## 延续行动",
      "",
      steps,
      "<!-- pls-daily-archive:end -->"
    ].join("\n");
  }

  private buildDailyArchiveNoteContent(content: string, archive: { summary: string; nextSteps: string[] }): string {
    const block = this.buildDailyArchiveBlock(archive);
    const markerPattern = /\n?<!-- pls-daily-archive:start -->[\s\S]*?<!-- pls-daily-archive:end -->/;
    return markerPattern.test(content)
      ? content.replace(markerPattern, `\n\n${block}`)
      : `${content.trimEnd()}\n\n${block}\n`;
  }

  private async archiveDailyNoteIfNeeded(date: string, carryToDate: string): Promise<void> {
    const summaryPath = this.path("Memory", "Summaries", "Daily", `${date}.md`);
    const summaryExists = this.app.vault.getAbstractFileByPath(summaryPath) instanceof TFile;
    const dailyAbstract = this.app.vault.getAbstractFileByPath(this.getTodayNotePath(date));
    if (!(dailyAbstract instanceof TFile)) return;

    const canAutoCarryover = hasProAccess(
      this.settings.licenseSnapshot,
      new Date(),
      this.settings.licenseEntitlementToken
    );
    const carriedCount = canAutoCarryover ? await this.carryOpenTasksToDate(dailyAbstract, date, carryToDate) : 0;
    if (!canAutoCarryover) {
      console.log(`[personal-life-system] skipped automatic task carryover for ${date}; Pro is required`);
    }
    if (!summaryExists) {
      console.log(`[personal-life-system] skipped automatic AI archive for ${date}; user confirmation is required for AI writeback`);
    }
    console.log(`[personal-life-system] checked ${date}; carried ${carriedCount} tasks to ${carryToDate}`);
  }

  private async runStartupDailyMaintenance(): Promise<void> {
    const today = formatDate();
    if (this.dailyMaintenanceRunDate === today) return;
    if (this.dailyMaintenancePromise) return this.dailyMaintenancePromise;

    this.dailyMaintenancePromise = (async () => {
      await this.ensureBaseStructure();
      const yesterday = this.getRelativeDate(-1);
      await this.runWeixinDailyDigest("startup");
      await this.archiveDailyNoteIfNeeded(yesterday, today);
      await this.checkAndGeneratePeriodicSummaries();
      this.dailyMaintenanceRunDate = today;
    })().finally(() => {
      this.dailyMaintenancePromise = null;
    });

    return this.dailyMaintenancePromise;
  }

  private async runMidnightDailyMaintenance(): Promise<void> {
    const yesterday = this.getRelativeDate(-1);
    const today = formatDate();
    await this.runWeixinDailyDigest("midnight");
    await this.archiveDailyNoteIfNeeded(yesterday, today);
    await this.checkAndGeneratePeriodicSummaries();
    this.dailyMaintenanceRunDate = today;
  }

  async generateMemoryArtifactsFromDaily(file: TFile): Promise<void> {
    if (!hasProAccess(this.settings.licenseSnapshot, new Date(), this.settings.licenseEntitlementToken)) return;
    const content = await this.app.vault.read(file);
    const date = file.basename.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? formatDate();
    const [year, month] = date.split("-");
    const response = await this.ai.complete({
      responseFormat: "json",
      temperature: 0.25,
      messages: [
        { role: "system", content: buildSystemPrompt(this.settings) },
        {
          role: "user",
          content:
            "请把下面这篇日记压缩成长期记忆系统需要的两个产物。只返回 JSON 对象，不要代码围栏。格式：{\"daily_summary\":\"...\",\"episode\":{\"event\":\"...\",\"result\":\"...\",\"next_steps\":[\"...\"]}}。\n\n" +
            content
        }
      ]
    });

    if (!response.ok || !response.text) {
      return;
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(response.text.replace(/```json\s*|\s*```/g, "").trim()) as Record<string, unknown>;
    } catch {
      return;
    }

    const dailySummary = String(data.daily_summary ?? "").trim();
    const episode = data.episode && typeof data.episode === "object"
      ? data.episode as Record<string, unknown>
      : {};
    const event = String(episode.event ?? "").trim();
    const result = String(episode.result ?? "").trim();
    const nextStepsRaw = Array.isArray(episode.next_steps) ? episode.next_steps : [];
    const nextSteps = nextStepsRaw.map((item) => String(item).trim()).filter(Boolean);

    const items: WritebackItem[] = [];
    if (dailySummary) {
      items.push({
        id: makeId("daily-summary"),
        kind: "replace",
        title: "Daily Summary",
        targetPath: this.path("Memory", "Summaries", "Daily", `${date}.md`),
        sourcePath: file.path,
        checked: true,
        content: `---\ntype: daily-summary\ndate: ${date}\nsource: ${file.path}\nupdated: ${formatDate()}\n---\n\n# ${date} 摘要\n\n${dailySummary}\n`
      });
    }

    if (event || result || nextSteps.length > 0) {
      items.push({
        id: makeId("episode"),
        kind: "replace",
        title: "Episode 事件卡",
        targetPath: this.path("Memory", "Episodes", year, month, `${date}.md`),
        sourcePath: file.path,
        checked: true,
        content: `---\ntype: episode\ndate: ${date}\nsource: ${file.path}\nimportance: 3\nstatus: active\n---\n\n# ${date} 事件卡\n\n## 事件\n\n${event || "（待补充）"}\n\n## 结果\n\n${result || "（待补充）"}\n\n## 后续\n\n${nextSteps.length > 0 ? nextSteps.map((step) => `- ${step}`).join("\n") : "- （待补充）"}\n`
      });
    }

    if (items.length === 0) {
      return;
    }

    const written = await openWritebackPreview(this.app, {
      title: "确认写入长期记忆产物",
      description: "这些内容会作为日后检索和长期记忆的基础，可先编辑再确认。",
      items,
      onConfirm: async (confirmed) => {
        await applyWritebackItems(this.app, confirmed);
      }
    });

    if (written.length > 0) {
      new Notice("长期记忆产物已写入。");
    }
  }

  // ═══════════════════════════════════════════════════
  // Periodic summary auto-generation
  // ═══════════════════════════════════════════════════

  /**
   * ISO week string like "2026-W20"
   */
  private getIsoWeek(date: Date): string {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
  }

  /** Parse an ISO week string like "2026-W20" back to the Monday Date */
  private dateFromIsoWeek(isoWeek: string): Date | null {
    const match = isoWeek.match(/^(\d{4})-W(\d{2})$/);
    if (!match) return null;
    const year = parseInt(match[1]);
    const week = parseInt(match[2]);
    const jan4 = new Date(year, 0, 4);
    const dayNum = jan4.getDay() || 7;
    const week1Monday = new Date(jan4);
    week1Monday.setDate(jan4.getDate() - dayNum + 1);
    const result = new Date(week1Monday);
    result.setDate(week1Monday.getDate() + (week - 1) * 7);
    result.setHours(0, 0, 0, 0);
    return result;
  }

  /** Generate weekly summary for the PREVIOUS complete ISO week */
  private async generatePreviousWeekSummary(): Promise<void> {
    const today = new Date();
    const prevWeekStart = new Date(today);
    const dayOfWeek = today.getDay() || 7; // 1=Mon ... 7=Sun
    prevWeekStart.setDate(today.getDate() - 7 - (dayOfWeek - 1));
    const isoWeek = this.getIsoWeek(prevWeekStart);
    const summaryPath = this.path("Memory", "Summaries", "Weekly", `${isoWeek}.md`);

    if (this.app.vault.getAbstractFileByPath(summaryPath) instanceof TFile) return;

    // Collect daily summaries for Mon-Sun of that week
    const summaryLines: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(prevWeekStart);
      d.setDate(prevWeekStart.getDate() + i);
      const dateStr = formatDate(d);
      const sf = this.app.vault.getAbstractFileByPath(this.path("Memory", "Summaries", "Daily", `${dateStr}.md`));
      if (sf instanceof TFile) {
        const content = await this.app.vault.read(sf);
        const body = content.replace(/^---[\s\S]*?---\n*/, "").trim();
        if (body) summaryLines.push(`## ${dateStr}\n\n${body}`);
      }
    }

    if (summaryLines.length < 2) return;

    const response = await this.ai.complete({
      temperature: 0.3,
      messages: [
        { role: "system", content: buildSystemPrompt(this.settings) },
        {
          role: "user",
          content:
            "下面是一周的每日摘要，请生成一份周报总结。要求：\n" +
            "- Markdown 格式\n" +
            "- 包含：本周主要进展、关键事件、遇到的问题、下周重点\n" +
            "- 简明扼要，不超过 500 字\n\n" +
            summaryLines.join("\n\n")
        }
      ]
    });

    if (!response.ok || !response.text) return;

    await ensureFile(
      this.app,
      summaryPath,
      `---\ntype: weekly-summary\nweek: ${isoWeek}\nupdated: ${formatDate()}\n---\n\n# ${isoWeek} 周报\n\n${response.text}\n`
    );
  }

  /** Generate monthly summary for the PREVIOUS calendar month */
  private async generatePreviousMonthSummary(): Promise<void> {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth(); // 0-indexed

    // Previous month
    let prevMonth = month - 1;
    let prevYear = year;
    if (prevMonth < 0) { prevMonth = 11; prevYear--; }

    const monthStr = `${prevYear}-${String(prevMonth + 1).padStart(2, "0")}`;
    const summaryPath = this.path("Memory", "Summaries", "Monthly", `${monthStr}.md`);
    if (this.app.vault.getAbstractFileByPath(summaryPath) instanceof TFile) return;

    // Collect all weekly summaries from this month
    const weeklyFolderPath = this.path("Memory", "Summaries", "Weekly");
    const weeklyFolder = this.app.vault.getAbstractFileByPath(weeklyFolderPath);
    const monthlySummaryLines: string[] = [];

    if (weeklyFolder) {
      const folder = weeklyFolder as unknown as { children: import("obsidian").TAbstractFile[] };
      if (folder.children) {
        for (const child of folder.children) {
          if (!(child instanceof TFile)) continue;
          const isoWeek = child.basename;
          const monday = this.dateFromIsoWeek(isoWeek);
          if (!monday) continue;
          const monYear = monday.getFullYear();
          const monMonth = monday.getMonth() + 1;
          if (monYear === prevYear && monMonth === prevMonth + 1) {
            const content = await this.app.vault.read(child);
            monthlySummaryLines.push(`## ${isoWeek}\n\n${content.replace(/^---[\s\S]*?---\n*/, "").trim()}`);
          }
        }
      }
    }

    // Also scan daily summaries for this month
    const startDate = new Date(prevYear, prevMonth, 1);
    const endDate = new Date(prevYear, prevMonth + 1, 0);
    const dayCount = 0;
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = formatDate(d);
      const sf = this.app.vault.getAbstractFileByPath(this.path("Memory", "Summaries", "Daily", `${dateStr}.md`));
      if (sf instanceof TFile) {
        // Count days with data (used for stats)
        const content = await this.app.vault.read(sf);
        if (content.replace(/^---[\s\S]*?---\n*/, "").trim()) {
          // Don't add individual daily to avoid overwhelming AI
        }
      }
    }

    if (monthlySummaryLines.length === 0) return;

    const response = await this.ai.complete({
      temperature: 0.35,
      messages: [
        { role: "system", content: buildSystemPrompt(this.settings) },
        {
          role: "user",
          content:
            "下面是一个月的周报总结，请生成一份详细的月报。要求：\n" +
            "- Markdown 格式\n" +
            "- 包含以下板块：\n" +
            "  ## 本月概览（总体评价、核心关键词）\n" +
            "  ## 主要进展（分领域梳理，如学习、工作、健康等）\n" +
            "  ## 关键事件与转折点\n" +
            "  ## 存在问题与卡点\n" +
            "  ## 情绪与状态趋势\n" +
            "  ## 下月重点计划\n" +
            "- 尽可能详细，基于实际数据做分析\n" +
            "- 不少于 800 字\n\n" +
            monthlySummaryLines.join("\n\n")
        }
      ]
    });

    if (!response.ok || !response.text) return;

    await ensureFile(
      this.app,
      summaryPath,
      `---\ntype: monthly-summary\nmonth: ${monthStr}\nupdated: ${formatDate()}\n---\n\n# ${monthStr} 月报\n\n${response.text}\n`
    );
  }

  /** Generate yearly summary for the PREVIOUS calendar year */
  private async generatePreviousYearSummary(): Promise<void> {
    const today = new Date();
    const prevYear = today.getFullYear() - 1;
    const summaryPath = this.path("Memory", "Summaries", "Yearly", `${prevYear}.md`);
    if (this.app.vault.getAbstractFileByPath(summaryPath) instanceof TFile) return;

    // Collect all monthly summaries from this year
    const monthlyFolderPath = this.path("Memory", "Summaries", "Monthly");
    const monthlyFolder = this.app.vault.getAbstractFileByPath(monthlyFolderPath);
    const yearlySummaryLines: string[] = [];

    if (monthlyFolder) {
      const folder = monthlyFolder as unknown as { children: import("obsidian").TAbstractFile[] };
      if (folder.children) {
        for (const child of folder.children) {
          if (!(child instanceof TFile)) continue;
          const fileYear = child.basename.slice(0, 4);
          if (fileYear === String(prevYear)) {
            const content = await this.app.vault.read(child);
            yearlySummaryLines.push(`## ${child.basename}\n\n${content.replace(/^---[\s\S]*?---\n*/, "").trim()}`);
          }
        }
      }
    }

    if (yearlySummaryLines.length === 0) return;

    const response = await this.ai.complete({
      temperature: 0.4,
      messages: [
        { role: "system", content: buildSystemPrompt(this.settings) },
        {
          role: "user",
          content:
            "下面是一年的月报总结，请生成一份详细的年报。要求：\n" +
            "- Markdown 格式\n" +
            "- 包含以下板块：\n" +
            "  ## 年度概览（年度关键词、总体评价）\n" +
            "  ## 月度大事记（每月一两句话）\n" +
            "  ## 分领域总结（学习成长、事业发展、身心健康、人际关系等）\n" +
            "  ## 高光时刻与低谷时刻\n" +
            "  ## 年度数据（出勤天数、情绪分布等，基于已有数据估算）\n" +
            "  ## 认知升级与关键收获\n" +
            "  ## 新年展望\n" +
            "- 尽可能详细，有深度的分析和总结\n" +
            "- 不少于 1500 字\n\n" +
            yearlySummaryLines.join("\n\n")
        }
      ]
    });

    if (!response.ok || !response.text) return;

    await ensureFile(
      this.app,
      summaryPath,
      `---\ntype: yearly-summary\nyear: ${prevYear}\nupdated: ${formatDate()}\n---\n\n# ${prevYear} 年报\n\n${response.text}\n`
    );
  }

  /** Check all period boundaries and generate summaries for completed periods */
  async checkAndGeneratePeriodicSummaries(): Promise<void> {
    console.log("[personal-life-system] skipped automatic periodic AI summaries; user confirmation is required for AI writeback");
  }

  /** Schedule a midnight check for auto-generation of period summaries */
  private scheduleMidnightCheck(): void {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setDate(midnight.getDate() + 1);
    midnight.setHours(0, 0, 0, 0);
    const msUntilMidnight = midnight.getTime() - now.getTime();

    if (this.midnightTimer) {
      window.clearTimeout(this.midnightTimer);
    }
    this.midnightTimer = window.setTimeout(() => {
      void this.runMidnightDailyMaintenance();
      // Re-schedule for next midnight
      this.scheduleMidnightCheck();
    }, msUntilMidnight);
  }

  // ═══════════════════════════════════════════════════
  // 备考 — 错题 & 练习
  // ═══════════════════════════════════════════════════

  async createXingceQuestion(data: XingceQuestionData): Promise<TFile> {
    await this.ensureBaseStructure();
    const date = formatDate();
    const examLabel = getExamProfileLabel(this.settings);
    const [year, month] = date.split("-");
    const id = makeId("xq");
    const typeName = data.questionType || "general";
    const fileName = sanitizeFileName(`${date}-${typeName}-${id.slice(-4)}.md`);
    const filePath = this.path("Exam", "Xingce", year, month, fileName);
    const content = `---\ntype: xingce-question\nid: ${id}\ncreated: ${date}\nquestion_type: ${data.questionType}\nstatus: wrong\ndifficulty: ${data.difficulty}\nsource: manual\nreview_count: 0\ntags:\n  - ${examLabel}\n  - 备考\n  - ${data.questionType}\n---\n\n# ${data.title || `${examLabel}错题`}\n\n## 题目\n\n${data.question}\n\n## 我的答案\n\n${data.myAnswer}\n\n## 正确答案\n\n${data.correctAnswer}\n\n## 错因分析\n\n${data.reason}\n\n## 知识点\n\n${data.knowledge}\n\n## 复习记录\n\n- [ ] 第一次复习 #pls/review\n`;
    const file = await ensureFile(this.app, filePath, content);
    new Notice(`${examLabel}错题已创建。`);
    return file;
  }

  async createInterviewPractice(data: InterviewPracticeData): Promise<TFile> {
    await this.ensureBaseStructure();
    const date = formatDate();
    const examLabel = getExamProfileLabel(this.settings);
    const [year, month] = date.split("-");
    const id = makeId("interview");
    const fileName = sanitizeFileName(`${date}-${data.category || `${examLabel}练习`}-${id.slice(-4)}.md`);
    const filePath = this.path("Exam", "Interview", year, month, fileName);
    const scoresFrontmatter = data.scores && Object.keys(data.scores).length > 0
      ? JSON.stringify(data.scores)
      : "";
    const totalScoreFrontmatter = typeof data.totalScore === "number" ? String(data.totalScore) : "";
    const nextDrillFrontmatter = data.nextDrill ? JSON.stringify(data.nextDrill) : "";
    const thinkingModelSection = normalizeExamProfileType(this.settings.examProfileType) === "civil-service"
      ? `\n## 软工拆题复盘\n\n${getCivilServiceInterviewThinkingModelPrompt()}\n\n### 本题复盘\n\n- 输入问题（现实问题/政策背景/群众需求）：\n- 处理实操（运行机制/资源约束/长效运营）：\n- 输出闭环（群众获得什么/基层留下什么/风险如何降低）：\n`
      : "";
    const content = `---\ntype: interview-practice\nid: ${id}\ncreated: ${date}\ncategory: ${data.category}\nscore: ${totalScoreFrontmatter}\nscores: ${scoresFrontmatter}\ntotalScore: ${totalScoreFrontmatter}\nnextDrill: ${nextDrillFrontmatter}\ntags:\n  - ${examLabel}\n  - 备考\n---\n\n# ${data.category || `${examLabel}练习`}\n\n## 题目\n\n${data.question}\n\n## 我的回答\n\n${data.answer}\n${thinkingModelSection}\n## AI 评价\n\n${data.evaluation || ""}\n\n## 下次练习\n\n${data.nextDrill ? `- [ ] ${data.nextDrill}` : "- [ ]"}\n`;
    const file = await ensureFile(this.app, filePath, content);
    new Notice(`${examLabel}练习记录已创建。`);
    return file;
  }

  // ═══════════════════════════════════════════════════
  // 备考 — 统计 / 打卡 / 目标 / 任务 / 资料 (stubs)
  // ═══════════════════════════════════════════════════

  showXingceStats(): void {
    showXingceStats(this.app, this);
  }

  async showInterviewTrends(): Promise<void> {
    await showInterviewTrends(this.app, this);
  }

  async showCheckinModal(): Promise<void> {
    await this.activateCheckins();
  }

  async showGoalsList(): Promise<void> {
    await showGoalsList(this.app, this);
  }

  async showTodayTasks(): Promise<void> {
    await showTodayTasks(this.app, this);
  }

  async showUploadMaterial(): Promise<void> {
    await showUploadMaterial(this.app, this);
  }

  async showTrainingPlan(): Promise<void> {
    await showTrainingPlan(this.app, this);
  }

  // ═══════════════════════════════════════════════════
  // 报告 (stubs)
  // ═══════════════════════════════════════════════════

  async generateReport(period: string): Promise<void> {
    if (!requireProFeature(this, "aiReviewGenerate")) return;
    const kind = period === "daily" || period === "weekly" || period === "monthly" ? period : "custom";
    if (kind === "daily") {
      const date = formatDate();
      const pending = (await this.autoReviewService?.listDrafts())
        ?.find((item) => item.window.start === date && item.window.end === date);
      if (pending) {
        new PeriodReviewModal(this.app, this, kind, { draftPath: pending.path }).open();
        return;
      }
    }
    new PeriodReviewModal(this.app, this, kind).open();
  }

  async showEmotionTracking(): Promise<void> {
    if (!requireProFeature(this, "aiEmotionTrend")) return;
    await showEmotionTracking(this.app, this);
  }

  async showDiarySearch(): Promise<void> {
    await showDiarySearch(this.app, this);
  }

  private registerAiEditPopover(): void {
    this.addCommand({
      id: "lifeos-open-ai-edit-sidebar",
      name: "打开 AI 修改侧边栏",
      callback: () => void this.openAiEditSidebarResident()
    });

    this.addCommand({
      id: "lifeos-ai-edit-diagnostics",
      name: "AI 修改诊断",
      callback: () => void this.showAiEditDiagnostics()
    });

    this.addCommand({
      id: "lifeos-ai-edit-selection",
      name: "AI 修改选中文本",
      editorCallback: (editor, view) => {
        void this.openAiEditForEditorSelection(editor, view.file, this.defaultAiEditAnchor());
      }
    });

    this.addCommand({
      id: "lifeos-ai-edit-current-whiteboard",
      name: "AI 修改当前白板",
      callback: () => void this.openAiEditForActiveCanvas(this.defaultAiEditAnchor())
    });

    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, view) => {
      if (!(view.file instanceof TFile)) return;
      if (!editor.getSelection().trim()) return;
      menu.addItem((item) => {
        item
          .setTitle("AI 修改选中文本")
          .setIcon("sparkles")
          .onClick(() => void this.openAiEditForEditorSelection(editor, view.file, this.defaultAiEditAnchor()));
      });
    }));

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile)) return;
      if (!this.isAiEditableFile(file)) return;
      menu.addItem((item) => {
        item
          .setTitle(file.extension === "canvas" ? "AI 调整白板" : "AI 修改文档")
          .setIcon(file.extension === "canvas" ? "layout-dashboard" : "sparkles")
          .onClick(() => void this.openAiEditForFile(file, this.defaultAiEditAnchor()));
      });
    }));

    const capturePointerDown = (event: MouseEvent) => {
      if (event.button === 0) this.aiEditPointerDown = { x: event.clientX, y: event.clientY };
    };
    const captureMouseUp = (event: MouseEvent) => {
      window.setTimeout(() => void this.handleAiEditMouseUp(event, "capture"), 0);
    };
    document.addEventListener("mousedown", capturePointerDown, true);
    document.addEventListener("mouseup", captureMouseUp, true);
    this.register(() => {
      document.removeEventListener("mousedown", capturePointerDown, true);
      document.removeEventListener("mouseup", captureMouseUp, true);
    });
    this.registerDomEvent(document, "selectionchange", () => this.handleAiEditSelectionChange());
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.aiEditPopover?.clearSelectionHighlight();
    }));
  }

  private async handleAiEditMouseUp(event: MouseEvent, phase: "capture" | "bubble" = "bubble"): Promise<void> {
    if (event.button !== 0) return;
    if (phase === "capture") this.aiEditDiagnostics.captureMouseUp += 1;
    if (phase === "bubble") this.aiEditDiagnostics.bubbleMouseUp += 1;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const selectionText = window.getSelection()?.toString() ?? "";
    this.recordAiEditDiagnostic(`mouseup-${phase}`, target, selectionText, "received");
    if (!target) {
      this.recordAiEditDiagnostic(`mouseup-${phase}`, null, selectionText, "no HTMLElement target");
      return;
    }
    if (this.shouldIgnoreAiEditPopoverTarget(target)) {
      this.recordAiEditDiagnostic(`mouseup-${phase}`, target, selectionText, "ignored UI target");
      return;
    }

    const markdownView = this.findMarkdownViewForAiEditTarget(target);
    if (markdownView?.file instanceof TFile && this.isMarkdownSelectionSurface(target)) {
      const editor = markdownView.editor;
      const selected = editor.getSelection();
      if (selected.trim().length >= 2) {
        this.recordAiEditDiagnostic(`mouseup-${phase}`, target, selected, "opening editable markdown selection", markdownView.file.path);
        this.scheduleAiEditForEditorSelection(editor, markdownView.file, {
          x: event.clientX,
          y: event.clientY,
          avoidRect: this.selectionAvoidRect(target),
          selectionRects: this.selectionRects(target)
        });
        return;
      }
      const readonlySelected = this.readonlySelectionTextForAiEditTarget(markdownView, target);
      if (readonlySelected.trim().length >= 2) {
        const readonlyKey = `${markdownView.file.path}:${readonlySelected.trim()}`;
        if (this.shouldSuppressAiEditSelectionOpen(readonlyKey, 900)) {
          this.recordAiEditDiagnostic(`mouseup-${phase}`, target, readonlySelected, "duplicate readonly selection suppressed", markdownView.file.path);
          return;
        }
        this.recordAiEditDiagnostic(`mouseup-${phase}`, target, readonlySelected, "opening readonly markdown selection", markdownView.file.path);
        await this.openAiEditTarget({
          kind: "readonly-selection",
          file: markdownView.file,
          text: readonlySelected
        }, {
          x: event.clientX,
          y: event.clientY,
          avoidRect: this.selectionAvoidRect(target),
          selectionRects: this.selectionRects(target)
        });
        return;
      }
    }

    const domSnapshot = this.captureAiEditDomSelectionSnapshot(`mouseup-${phase}`, target);
    if (domSnapshot) {
      this.pendingAiEditDomSelectionSnapshot = domSnapshot;
      this.aiEditDiagnostics.snapshotCaptured += 1;
      await this.openCurrentDomSelectionInAiEditSidebar(domSnapshot);
      return;
    }

    if (selectionText.trim().length >= 2 && this.isMarkdownSelectionSurface(target)) {
      const activeFile = this.app.workspace.getActiveFile();
      const fallbackFile = markdownView?.file instanceof TFile
        ? markdownView.file
        : activeFile instanceof TFile && activeFile.extension === "md"
          ? activeFile
          : null;
      if (fallbackFile) {
        const fallbackKey = `${fallbackFile.path}:${selectionText.trim()}`;
        if (this.shouldSuppressAiEditSelectionOpen(fallbackKey, 900)) {
          this.recordAiEditDiagnostic(`mouseup-${phase}`, target, selectionText, "duplicate fallback selection suppressed", fallbackFile.path);
          return;
        }
        this.recordAiEditDiagnostic(`mouseup-${phase}`, target, selectionText, "opening fallback DOM markdown selection", fallbackFile.path);
        await this.openAiEditTarget({
          kind: "readonly-selection",
          file: fallbackFile,
          text: selectionText
        }, {
          x: event.clientX,
          y: event.clientY,
          avoidRect: this.selectionAvoidRect(target),
          selectionRects: this.selectionRects(target)
        });
        return;
      }
    }

    const activeFile = this.app.workspace.getActiveFile();
    if (
      activeFile instanceof TFile &&
      this.isCanvasFile(activeFile) &&
      this.shouldOpenAiEditForCanvasClick(event, target)
    ) {
      this.recordAiEditDiagnostic(`mouseup-${phase}`, target, selectionText, "opening canvas", activeFile.path);
      void this.openAiEditForFile(activeFile, this.canvasAiEditAnchor(event, target), this.canvasNodeHint(target));
      return;
    }
    this.recordAiEditDiagnostic(`mouseup-${phase}`, target, selectionText, "no supported selection/canvas target", markdownView?.file?.path ?? "");
  }

  private handleAiEditSelectionChange(): void {
    this.aiEditDiagnostics.selectionChange += 1;
    const snapshot = this.captureAiEditDomSelectionSnapshot("selectionchange");
    if (snapshot) {
      this.pendingAiEditDomSelectionSnapshot = snapshot;
      this.aiEditDiagnostics.snapshotCaptured += 1;
      this.recordAiEditDiagnostic("selectionchange", snapshot.target, snapshot.text, "captured selection snapshot", snapshot.file.path);
    } else {
      const selectionText = window.getSelection()?.toString() ?? "";
      this.recordAiEditDiagnostic("selectionchange", this.currentSelectionElement(), selectionText, "received empty/collapsed selection");
    }
  }

  private async openCurrentDomSelectionInAiEditSidebar(snapshot?: AiEditDomSelectionSnapshot | null): Promise<void> {
    const resolvedSnapshot = snapshot ?? this.captureAiEditDomSelectionSnapshot("selectionchange-open");
    if (!resolvedSnapshot) {
      const selection = window.getSelection();
      const text = selection?.toString() ?? "";
      this.recordAiEditDiagnostic("selectionchange-open", this.currentSelectionElement(), text, "empty or collapsed selection");
      return;
    }
    if (Date.now() - resolvedSnapshot.createdAt > 4_000) {
      this.recordAiEditDiagnostic("selectionchange-open", resolvedSnapshot.target, resolvedSnapshot.text, "stale selection snapshot ignored", resolvedSnapshot.file.path);
      return;
    }
    if (this.shouldSuppressAiEditSelectionOpen(resolvedSnapshot.key, 900)) {
      this.recordAiEditDiagnostic("selectionchange-open", resolvedSnapshot.target, resolvedSnapshot.text, "duplicate selection suppressed", resolvedSnapshot.file.path);
      return;
    }
    this.pendingAiEditDomSelectionSnapshot = null;
    this.recordAiEditDiagnostic("selectionchange-open", resolvedSnapshot.target, resolvedSnapshot.text, `opening DOM selection snapshot from ${resolvedSnapshot.source}`, resolvedSnapshot.file.path);
    await this.openAiEditTarget({
      kind: "readonly-selection",
      file: resolvedSnapshot.file,
      text: resolvedSnapshot.text
    }, resolvedSnapshot.anchor);
  }

  private captureAiEditDomSelectionSnapshot(source: string, fallbackTarget?: HTMLElement | null): AiEditDomSelectionSnapshot | null {
    const selection = window.getSelection();
    const text = selection?.toString() ?? "";
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || text.trim().length < 2) return null;
    const range = selection.getRangeAt(0);
    const target = this.currentSelectionElement(range) ?? fallbackTarget ?? null;
    if (!target || this.shouldIgnoreAiEditPopoverTarget(target) || !this.isMarkdownSelectionSurface(target)) return null;

    const markdownView = this.findMarkdownViewForAiEditTarget(target);
    const activeFile = this.app.workspace.getActiveFile();
    const file = markdownView?.file instanceof TFile
      ? markdownView.file
      : activeFile instanceof TFile && activeFile.extension === "md"
        ? activeFile
        : null;
    if (!(file instanceof TFile)) return null;

    const selectionRects = this.selectionRectsFromRange(range).slice(0, 80);
    const rect = range.getBoundingClientRect();
    const anchor: AiEditAnchor = {
      x: Math.round((rect.left + rect.right) / 2) || this.defaultAiEditAnchor().x,
      y: Math.round(rect.bottom) || this.defaultAiEditAnchor().y,
      avoidRect: this.selectionAvoidRectFromRects(selectionRects),
      selectionRects
    };
    return {
      text,
      file,
      target,
      source,
      key: `${file.path}:${text.trim()}`,
      createdAt: Date.now(),
      anchor
    };
  }

  private selectionRectsFromRange(range: Range): NonNullable<AiEditAnchor["selectionRects"]> {
    return Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      }));
  }

  private selectionAvoidRectFromRects(rects: NonNullable<AiEditAnchor["selectionRects"]>): AiEditAnchor["avoidRect"] {
    if (rects.length === 0) return undefined;
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) return undefined;
    return { left, top, right, bottom, width, height };
  }

  private shouldSuppressAiEditSelectionOpen(key: string, windowMs: number): boolean {
    const now = Date.now();
    if (key === this.lastAiEditSelectionKey && now - this.lastAiEditSelectionAt < windowMs) return true;
    this.lastAiEditSelectionKey = key;
    this.lastAiEditSelectionAt = now;
    return false;
  }

  private currentSelectionElement(range?: Range | null): HTMLElement | null {
    const selection = window.getSelection();
    const resolvedRange = range ?? (selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null);
    const common = resolvedRange?.commonAncestorContainer;
    return common instanceof HTMLElement ? common : common?.parentElement ?? null;
  }

  private recordAiEditDiagnostic(
    event: string,
    target: HTMLElement | null,
    text: string,
    reason: string,
    filePath = ""
  ): void {
    const targetDescription = this.describeAiEditTargetElement(target);
    const selectionLength = text.trim().length;
    const now = Date.now();
    this.aiEditDiagnostics.lastEvent = event;
    this.aiEditDiagnostics.lastTarget = targetDescription;
    this.aiEditDiagnostics.lastReason = reason;
    this.aiEditDiagnostics.lastSelectionLength = selectionLength;
    this.aiEditDiagnostics.lastFilePath = filePath;
    this.aiEditDiagnostics.lastAt = now;

    const isUiNoise = reason === "ignored UI target" || event.startsWith("panel-");
    const isMeaningful = !isUiNoise && (
      selectionLength > 0 ||
      reason.startsWith("opening")
    );
    if (isMeaningful) {
      this.aiEditDiagnostics.lastMeaningfulEvent = event;
      this.aiEditDiagnostics.lastMeaningfulTarget = targetDescription;
      this.aiEditDiagnostics.lastMeaningfulReason = reason;
      this.aiEditDiagnostics.lastMeaningfulSelectionLength = selectionLength;
      this.aiEditDiagnostics.lastMeaningfulFilePath = filePath;
      this.aiEditDiagnostics.lastMeaningfulAt = now;
    }
  }

  private describeAiEditTargetElement(target: HTMLElement | null): string {
    if (!target) return "none";
    const classes = Array.from(target.classList).slice(0, 5).join(".");
    const leafContent = target.closest<HTMLElement>(".workspace-leaf-content");
    const leafType = leafContent?.getAttribute("data-type") ?? "";
    const tag = target.tagName.toLowerCase();
    return `${tag}${classes ? `.${classes}` : ""}${leafType ? ` in ${leafType}` : ""}`;
  }

  private showAiEditDiagnostics(): void {
    const selection = window.getSelection();
    const text = selection?.toString() ?? "";
    const target = this.currentSelectionElement();
    const leaves = this.app.workspace.getLeavesOfType(AI_EDIT_PANEL_VIEW_TYPE);
    const connectedLeaves = leaves.filter((leaf) => {
      const contentEl = (leaf.view as { contentEl?: HTMLElement }).contentEl;
      return Boolean(contentEl?.isConnected);
    }).length;
    const activeViewType = this.app.workspace.activeLeaf?.view.getViewType() ?? "none";
    const activeFile = this.app.workspace.getActiveFile();
    const data = {
      loaded: true,
      version: this.manifest.version,
      activeViewType,
      activeFile: activeFile instanceof TFile ? activeFile.path : "none",
      selectionLength: text.trim().length,
      selectionTarget: this.describeAiEditTargetElement(target),
      markdownSurface: target ? this.isMarkdownSelectionSurface(target) : false,
      panelLeaves: leaves.length,
      connectedLeaves,
      mountedInPanel: this.aiEditPopover?.isMountedInPanel() ?? false,
      diagnostics: { ...this.aiEditDiagnostics }
    };
    const message = [
      `AI 修改诊断：已加载 v${this.manifest.version}`,
      `当前选区 ${data.selectionLength} 字 / markdown=${data.markdownSurface ? "是" : "否"}`,
      `侧边栏 leaf ${leaves.length} 个 / 已连接 ${connectedLeaves} 个 / 活跃会话 ${data.mountedInPanel ? "是" : "否"}`,
      `最后有效事件：${this.aiEditDiagnostics.lastMeaningfulEvent}，${this.aiEditDiagnostics.lastMeaningfulSelectionLength} 字，原因：${this.aiEditDiagnostics.lastMeaningfulReason}`,
      `最后原始事件：${this.aiEditDiagnostics.lastEvent}，原因：${this.aiEditDiagnostics.lastReason}`
    ].join("\n");
    new Notice(message, 12000);
    console.info("[Life OS] AI edit diagnostics", data);
    void this.openAiEditSidebarResident();
  }

  private findMarkdownViewForAiEditTarget(target: HTMLElement): MarkdownView | null {
    const targetLeaf = target.closest<HTMLElement>(".workspace-leaf");
    let matched: MarkdownView | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (matched) return;
      const view = leaf.view;
      const containerEl = (view as { containerEl?: HTMLElement }).containerEl;
      if (view instanceof MarkdownView && containerEl?.contains(target)) {
        matched = view;
      } else if (view instanceof MarkdownView && targetLeaf && containerEl?.closest(".workspace-leaf") === targetLeaf) {
        matched = view;
      }
    });
    return matched ?? this.app.workspace.getActiveViewOfType(MarkdownView);
  }

  private readonlySelectionTextForAiEditTarget(markdownView: MarkdownView, target: HTMLElement): string {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
    const containerEl = (markdownView as { containerEl?: HTMLElement }).containerEl;
    if (!containerEl?.contains(target)) return "";
    const common = selection.getRangeAt(0).commonAncestorContainer;
    const commonEl = common instanceof HTMLElement ? common : common.parentElement;
    if (commonEl && !containerEl.contains(commonEl)) return "";
    return selection.toString();
  }

  private selectionAvoidRect(target: HTMLElement): AiEditAnchor["avoidRect"] {
    return this.selectionAvoidRectFromRects(this.selectionRects(target));
  }

  private selectionRects(target: HTMLElement): NonNullable<AiEditAnchor["selectionRects"]> {
    if (!this.isMarkdownSelectionSurface(target)) return [];
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return [];
    return Array.from(selection.getRangeAt(0).getClientRects())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      }));
  }

  private canvasAiEditAnchor(event: MouseEvent, target: HTMLElement): AiEditAnchor {
    const canvasRects = this.canvasAvoidRects(target);
    return {
      x: event.clientX,
      y: event.clientY,
      avoidRect: canvasRects.primary,
      softAvoidRects: canvasRects.soft,
      placement: "canvas"
    };
  }

  private canvasAvoidRects(target: HTMLElement): { primary?: AiEditAnchor["avoidRect"]; soft: NonNullable<AiEditAnchor["softAvoidRects"]> } {
    const canvasRoot = target.closest<HTMLElement>(".canvas-wrapper, .canvas, .canvas-viewport, .workspace-leaf-content") ?? document.body;
    const targetNode = target.closest<HTMLElement>(".canvas-node");
    const selectedNodes = Array.from(canvasRoot.querySelectorAll<HTMLElement>(
      ".canvas-node.is-selected, .canvas-node.mod-selected, .canvas-node.is-focused, .canvas-node.is-highlighted"
    )).filter((node) => node.offsetParent !== null);
    const primaryElements = selectedNodes.length > 0 ? selectedNodes : targetNode ? [targetNode] : [];
    const primary = this.unionElementRects(primaryElements, 28);
    const soft = Array.from(canvasRoot.querySelectorAll<HTMLElement>(".canvas-node"))
      .filter((node) => node.offsetParent !== null)
      .map((node) => this.elementAvoidRect(node, 14))
      .filter((rect): rect is NonNullable<AiEditAnchor["avoidRect"]> => Boolean(rect));
    return { primary, soft };
  }

  private unionElementRects(elements: HTMLElement[], padding: number): AiEditAnchor["avoidRect"] {
    const rects = elements
      .map((element) => this.elementAvoidRect(element, padding))
      .filter((rect): rect is NonNullable<AiEditAnchor["avoidRect"]> => Boolean(rect));
    if (rects.length === 0) return undefined;
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  private elementAvoidRect(element: HTMLElement, padding: number): AiEditAnchor["avoidRect"] {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    const left = rect.left - padding;
    const top = rect.top - padding;
    const right = rect.right + padding;
    const bottom = rect.bottom + padding;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  async dockAiEditToSidebar(): Promise<void> {
    const leaf = await this.ensureAiEditSidebarResident();
    this.app.workspace.rightSplit?.expand?.();
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    this.aiEditPopover?.mountToPanel((leaf.view as { contentEl?: HTMLElement }).contentEl ?? document.body, { pin: true });
    this.aiEditPopover?.clearSelectionHighlight();
  }

  private async ensureAiEditSidebarResident(): Promise<WorkspaceLeaf> {
    if (!this.aiEditPopover) {
      this.aiEditPopover = new AiEditPopoverController(this.app, this);
    }
    const existing = this.app.workspace.getLeavesOfType(AI_EDIT_PANEL_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getRightLeaf(true) ?? this.app.workspace.getLeaf(true);
    if (leaf.view.getViewType() !== AI_EDIT_PANEL_VIEW_TYPE) {
      await leaf.setViewState({ type: AI_EDIT_PANEL_VIEW_TYPE, active: true });
    }
    this.app.workspace.rightSplit?.expand?.();
    return leaf;
  }

  private async openAiEditTargetInResidentPanel(
    target: AiEditTarget,
    anchor: AiEditAnchor
  ): Promise<void> {
    try {
      const leaf = await this.ensureAiEditSidebarResident();
      const containerEl = (leaf.view as { contentEl?: HTMLElement }).contentEl;
      if (!containerEl?.isConnected) throw new Error("AI edit sidebar container is not connected");
      this.aiEditPopover?.mountToPanel(containerEl, { pin: true });
      this.aiEditPopover?.openOrQueue(target, anchor);
      this.aiEditDiagnostics.opened += 1;
      this.app.workspace.rightSplit?.expand?.();
      this.app.workspace.setActiveLeaf(leaf, { focus: false });
    } catch (error) {
      console.warn("[Life OS] AI edit sidebar unavailable; falling back to floating popover", error);
      if (!this.aiEditPopover) this.aiEditPopover = new AiEditPopoverController(this.app, this);
      this.aiEditPopover.unmountFromPanel({ closeActive: false });
      this.aiEditPopover.openOrQueue(target, anchor);
    }
  }

  private async openAiEditTarget(target: AiEditTarget, anchor: AiEditAnchor): Promise<void> {
    if (!this.aiEditPopover) this.aiEditPopover = new AiEditPopoverController(this.app, this);
    if (this.aiEditPopover.shouldFollowSelectionInPanel()) {
      await this.openAiEditTargetInResidentPanel(target, anchor);
      return;
    }
    this.aiEditPopover.openOrQueue(target, anchor);
    this.aiEditDiagnostics.opened += 1;
  }

  async openAiEditSidebarResident(): Promise<void> {
    const leaf = await this.ensureAiEditSidebarResident();
    await leaf.setViewState({ type: AI_EDIT_PANEL_VIEW_TYPE, active: true });
    this.app.workspace.rightSplit?.expand?.();
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    this.aiEditPopover?.mountToPanel((leaf.view as { contentEl?: HTMLElement }).contentEl ?? document.body, { pin: true });
  }

  undockAiEditFromSidebar(): void {
    const leaves = this.app.workspace.getLeavesOfType(AI_EDIT_PANEL_VIEW_TYPE);
    for (const leaf of leaves) {
      leaf.detach();
    }
    this.aiEditPopover?.unmountFromPanel({ closeActive: true });
  }

  mountAiEditPanel(containerEl: HTMLElement): void {
    if (!this.aiEditPopover) {
      this.aiEditPopover = new AiEditPopoverController(this.app, this);
    }
    try {
      this.aiEditPopover?.mountToPanel(containerEl);
      this.aiEditDiagnostics.mounted += 1;
      this.recordAiEditDiagnostic("panel-mount", containerEl, "", "panel mounted");
    } catch (error) {
      console.error("[Life OS] Failed to mount AI edit panel", error);
      containerEl.empty();
      containerEl.addClass("lifeos-ai-edit-panel-view");
      const fallback = containerEl.createDiv({ cls: "lifeos-ai-edit-panel-empty is-error" });
      fallback.createEl("strong", { text: "AI 修改侧边栏加载失败" });
      fallback.createEl("span", { text: error instanceof Error ? error.message : "未知错误，请重新加载 Obsidian 后再试。" });
      this.recordAiEditDiagnostic("panel-mount", containerEl, "", "panel mount failed");
    }
  }

  unmountAiEditPanel(): void {
    this.aiEditPopover?.unmountFromPanel({ closeActive: true });
  }

  private scheduleAiEditForEditorSelection(editor: Editor, file: TFile, anchor: AiEditAnchor): void {
    const selected = editor.getSelection();
    const from = cloneEditorPosition(editor.getCursor("from"));
    const to = cloneEditorPosition(editor.getCursor("to"));
    const key = `${file.path}:${from.line}:${from.ch}:${to.line}:${to.ch}:${selected}`;
    const now = Date.now();
    if (key === this.lastAiEditSelectionKey && now - this.lastAiEditSelectionAt < 1200) return;
    this.lastAiEditSelectionKey = key;
    this.lastAiEditSelectionAt = now;
    if (this.aiEditSelectionTimer) window.clearTimeout(this.aiEditSelectionTimer);
    this.aiEditSelectionTimer = window.setTimeout(() => {
      void this.openAiEditForEditorSelection(editor, file, anchor);
      this.aiEditSelectionTimer = null;
    }, 110);
  }

  private async openAiEditForEditorSelection(editor: Editor, file: TFile | null, anchor: AiEditAnchor): Promise<void> {
    if (!(file instanceof TFile)) {
      new Notice("当前没有可修改的 Markdown 文件。");
      return;
    }
    const selected = editor.getSelection();
    if (!selected.trim()) {
      new Notice("先选中一段文字，再让 AI 修改。");
      return;
    }
    await this.openAiEditTarget({
      kind: "selection",
      file,
      editor,
      from: cloneEditorPosition(editor.getCursor("from")),
      to: cloneEditorPosition(editor.getCursor("to")),
      text: selected
    }, anchor);
  }

  private async openAiEditForActiveCanvas(anchor: AiEditAnchor): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || !this.isCanvasFile(file)) {
      new Notice("请先打开一个白板 Canvas。");
      return;
    }
    await this.openAiEditForFile(file, anchor);
  }

  private async openAiEditForFile(file: TFile, anchor: AiEditAnchor, nodeHint?: string): Promise<void> {
    if (!this.isAiEditableFile(file)) {
      new Notice("目前支持修改 Markdown 文档和 Obsidian Canvas 白板。");
      return;
    }
    const content = await this.app.vault.read(file);
    await this.openAiEditTarget(this.isCanvasFile(file)
      ? { kind: "canvas", file, text: content, nodeHint }
      : { kind: "markdown-file", file, text: content }, anchor);
  }

  private shouldIgnoreAiEditPopoverTarget(target: HTMLElement): boolean {
    return Boolean(target.closest([
      ".lifeos-ai-edit-popover",
      ".lifeos-chat-bubble",
      ".modal-container",
      ".menu",
      ".suggestion-container",
      ".view-header",
      ".workspace-tab-header",
      ".status-bar",
      "button",
      "input",
      "textarea",
      "select",
      "a"
    ].join(",")));
  }

  private isMarkdownSelectionSurface(target: HTMLElement): boolean {
    const ignoredLeaf = target.closest<HTMLElement>([
      ".workspace-leaf-content[data-type='file-explorer']",
      ".workspace-leaf-content[data-type='search']",
      ".workspace-leaf-content[data-type='backlink']",
      ".workspace-leaf-content[data-type='outgoing-link']",
      ".workspace-leaf-content[data-type='tag']",
      ".workspace-leaf-content[data-type='all-properties']",
      ".workspace-leaf-content[data-type='outline']"
    ].join(","));
    if (ignoredLeaf) return false;
    return Boolean(target.closest([
      ".markdown-source-view",
      ".markdown-reading-view",
      ".markdown-preview-view",
      ".markdown-rendered",
      ".markdown-preview-section",
      ".cm-editor",
      ".cm-content",
      ".cm-line",
      ".workspace-leaf-content[data-type='markdown']",
      ".pls-life-file-leaf .view-content",
      ".lifeos-file-leaf .view-content"
    ].join(",")));
  }

  private shouldOpenAiEditForCanvasClick(event: MouseEvent, target: HTMLElement): boolean {
    if (this.aiEditPointerDown) {
      const dx = Math.abs(event.clientX - this.aiEditPointerDown.x);
      const dy = Math.abs(event.clientY - this.aiEditPointerDown.y);
      if (dx > 8 || dy > 8) return false;
    }
    if (target.closest(".canvas-control-item, .canvas-menu, .canvas-node-content.is-editing, .canvas-card-menu")) {
      return false;
    }
    if (target.closest(".canvas-node")) return true;
    return event.detail >= 2 && Boolean(target.closest(".canvas-wrapper, .canvas, .canvas-viewport"));
  }

  private canvasNodeHint(target: HTMLElement): string | undefined {
    const node = target.closest(".canvas-node");
    const text = node?.textContent?.replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 260) : undefined;
  }

  private isAiEditableFile(file: TFile): boolean {
    return file.extension === "md" || this.isCanvasFile(file);
  }

  private isCanvasFile(file: TFile): boolean {
    return file.extension === "canvas" || file.path.toLowerCase().endsWith(".canvas");
  }

  private defaultAiEditAnchor(): AiEditAnchor {
    return {
      x: Math.round(window.innerWidth / 2),
      y: Math.round(Math.min(window.innerHeight - 180, Math.max(120, window.innerHeight * 0.42)))
    };
  }

  private registerLifeOsFileStyling(): void {
    this.registerEvent(this.app.workspace.on("file-open", () => this.queueLifeOsFileStyling()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.queueLifeOsFileStyling()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.queueLifeOsFileStyling()));
    this.queueLifeOsFileStyling();
  }

  private queueLifeOsFileStyling(): void {
    window.setTimeout(() => this.decorateLifeOsFileLeaves(), 0);
  }

  private decorateLifeOsFileLeaves(): void {
    const root = this.getRoot().replace(/\/+$/, "");
    const themeStyle = normalizeThemeStyle(this.settings.themeStyle);
    const themeClasses = THEME_STYLES.map((style) => `lifeos-theme-${style}`);
    const activeThemeClasses = getThemeStyleClasses(themeStyle);
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as typeof leaf.view & { file?: TFile; containerEl?: HTMLElement };
      const file = view.file;
      const isLifeOsFile = file instanceof TFile && (file.path === root || file.path.startsWith(`${root}/`));
      const containers = [view.containerEl].filter((element): element is HTMLElement => element instanceof HTMLElement);
      for (const container of containers) {
        container.removeClass(...themeClasses);
        if (isLifeOsFile) {
          container.addClass("pls-life-file-leaf", "lifeos-file-leaf");
          container.addClass(...activeThemeClasses);
        } else {
          container.removeClass("pls-life-file-leaf", "lifeos-file-leaf");
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════
  // View activation
  // ═══════════════════════════════════════════════════

  private getLifeOsLeaf(): WorkspaceLeaf {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (activeLeaf && this.lifeOsViewTypes.includes(activeLeaf.view.getViewType())) {
      return activeLeaf;
    }

    for (const viewType of this.lifeOsViewTypes) {
      const [existingLeaf] = this.app.workspace.getLeavesOfType(viewType);
      if (existingLeaf) {
        return existingLeaf;
      }
    }

    return this.settings.viewLayout === "main"
      ? this.app.workspace.getLeaf(false)
      : (this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true));
  }

  async activateDashboard(mode?: string): Promise<void> {
    const leaf = this.getLifeOsLeaf();
    await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    if (mode === "interview") {
      new Notice(`已打开 Dashboard，可从${getExamProfileLabel(this.settings)}模块进入练习。`);
    }
  }

  private async buildRuleTaskWritebackItems(file: TFile, content: string, notify: (message: string) => void): Promise<WritebackItem[]> {
    const candidates = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.replace(/^[-*]\s*(\[[ xX]\]\s*)?/, "").replace(/^\d+[.、]\s*/, "").trim())
      .filter((line) => /待办|明天|需要|要做|计划|完成|整理|复盘|学习|阅读|练习/.test(line))
      .slice(0, 8);

    const taskLines = candidates.map((line, index) => `- [ ] ${line} #pls/task #pls/rule ^${makeId(`rule-task-${index + 1}`)}`);
    if (taskLines.length === 0) {
      notify("没有识别到可提取的待办。可以在日记里写“明天要做……”或“需要完成……”。");
      return [];
    }
    const openPath = this.path("Tasks", "open.md");
    return [
      {
        id: makeId("tasks-rule-open"),
        kind: "task",
        title: "写入待办任务",
        content: `\n${taskLines.join("\n")}\n`,
        targetPath: openPath,
        sourcePath: file.path,
        checked: true
      }
    ];
  }

  async activateTasks(): Promise<void> {
    const leaf = this.getLifeOsLeaf();
    await leaf.setViewState({ type: TASKS_VIEW_TYPE, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async activateDaily(): Promise<void> {
    const leaf = this.getLifeOsLeaf();
    await leaf.setViewState({ type: DAILY_VIEW_TYPE, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async activateKnowledge(): Promise<void> {
    const leaf = this.getLifeOsLeaf();
    await leaf.setViewState({ type: KNOWLEDGE_VIEW_TYPE, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async activateMemory(): Promise<void> {
    const leaf = this.getLifeOsLeaf();
    await leaf.setViewState({ type: MEMORY_VIEW_TYPE, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async activateChat(initialPrompt = ""): Promise<void> {
    if (initialPrompt.trim()) this.pendingChatPrompt = initialPrompt.trim();
    const leaf = this.getLifeOsLeaf();
    await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async activateUserGuide(): Promise<void> {
    const leaf = this.getLifeOsLeaf();
    await leaf.setViewState({ type: USER_GUIDE_VIEW_TYPE, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async activateSettings(): Promise<void> {
    const leaf = this.getLifeOsLeaf();
    await leaf.setViewState({ type: SETTINGS_VIEW_TYPE, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async activateAiWorkspace(): Promise<void> {
    const leaf = this.getLifeOsLeaf();
    await leaf.setViewState({ type: AI_WORKSPACE_VIEW_TYPE, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async activateProLicense(): Promise<void> {
    const leaf = this.getLifeOsLeaf();
    await leaf.setViewState({ type: PRO_LICENSE_VIEW_TYPE, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async activateProCompare(): Promise<void> {
    const leaf = this.getLifeOsLeaf();
    await leaf.setViewState({ type: PRO_COMPARE_VIEW_TYPE, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  consumePendingChatPrompt(): string {
    const prompt = this.pendingChatPrompt;
    this.pendingChatPrompt = "";
    return prompt;
  }

  async activateReview(): Promise<void> {
    const leaf = this.getLifeOsLeaf();
    await leaf.setViewState({ type: REVIEW_VIEW_TYPE, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async activateCheckins(): Promise<void> {
    const leaf = this.getLifeOsLeaf();
    await leaf.setViewState({ type: CHECKIN_VIEW_TYPE, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async activateCalendar(): Promise<void> {
    const leaf = this.getLifeOsLeaf();
    await leaf.setViewState({ type: CALENDAR_VIEW_TYPE, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }
}
