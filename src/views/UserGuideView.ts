import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { createButton } from "../components/Button";
import { createCard } from "../components/Card";
import { createHeroHeader } from "../components/HeroHeader";
import { createLifeOSShell } from "../components/LifeOSComponent";
import { USER_GUIDE_VIEW_TYPE } from "../constants";
import type PersonalLifeSystemPlugin from "../main";

const HIGHLIGHTS = [
  { label: "万能入口", value: "丢给 AI", copy: "想法、任务、日记、资料、错题、复盘和问题都可以先发给 AI 助手。" },
  { label: "自动处理", value: "识别 / 拆解 / 归类", copy: "AI 会判断内容该变成任务、日记、知识、记忆还是复盘建议。" },
  { label: "写入权限", value: "你来选择", copy: "默认不写入；可保留预览确认，也可只对当前明确目标启用自动写入。" },
  { label: "本地优先", value: "Markdown", copy: "确认后的内容保存在当前 Vault，便于查看、备份和迁移。" }
];

const FEATURE_GROUPS = [
  {
    title: "先丢给 AI",
    icon: "bot",
    copy: "不用先判断该打开哪个模块，把原始内容直接发给 AI 助手即可。",
    items: [
      { title: "随手输入", icon: "send", copy: "一句话、长文本、资料链接、今天发生的事、计划和困惑都可以直接发给 AI。" },
      { title: "上下文理解", icon: "scan-text", copy: "AI 会检索相关的日记、任务、记忆、知识库和复盘；回答中的 [S1] 等标记可在“上下文来源”中打开原文核对。" },
      { title: "统一快捷设置", icon: "sliders-horizontal", copy: "模式、项目、模型、Skill、联网、推理、上下文、AI 回复、记入、白板、长度和风格在一行集中展示；两个及以上选项统一使用下拉框，添加文件紧挨在发送按钮上方。" },
      { title: "可控联网", icon: "globe-2", copy: "“联网”下拉框默认自动，只在需要最新信息时搜索，也可手动开启或关闭；每个网页都是可单独打开的引用来源。" },
      { title: "划词不打扰", icon: "mouse-pointer-2", copy: "选中文字只显示用途选择，不会自动分析；只有点击 AI 修改或围绕选区提问后才进入完整工具。" },
      { title: "可选中与复制", icon: "copy", copy: "聊天正文可以直接拖选，也可一键复制整条消息；在聊天气泡内选字不会弹出 AI 修改。" },
      { title: "可观察执行过程", icon: "list-checks", copy: "回复时展示理解、检索、生成与受控写入状态，不暴露模型隐藏思维链。" },
      { title: "Skill 资产管理", icon: "package-check", copy: "Skill 以紧凑圆角卡片分类展示，点击高亮选中；支持搜索、重命名、修改说明与分类。本地或 GitHub 导入时可先命名，导入项还能编辑正文或删除。" },
      { title: "分级写入", icon: "file-check-2", copy: "可选不写入、确认后写入或明确指令自动写入；含糊目标和未选项目不会被猜测。" },
      { title: "继续追问", icon: "messages-square", copy: "不确定怎么处理时，可以继续让 AI 拆小、改写、总结或生成下一步。" }
    ]
  },
  {
    title: "AI 帮你分流",
    icon: "route",
    copy: "AI 处理后，内容会进入合适的 Life OS 模块，而不是混成一团聊天记录。",
    items: [
      { title: "任务", icon: "check-square", copy: "可执行事项会被拆成行动清单，完成后自动归档。" },
      { title: "日记", icon: "book-open", copy: "当天发生的事、状态和想法可以沉淀到今日日记。" },
      { title: "知识库", icon: "library", copy: "资料、读书笔记、错题和方法论可以整理成可复用知识。" },
      { title: "记忆", icon: "brain", copy: "长期稳定的信息会进入记忆候选，确认后再沉淀。" }
    ]
  },
  {
    title: "再回到系统",
    icon: "layout-dashboard",
    copy: "处理完成后，用各个模块查看结构化结果，让记录真正变成可复盘的系统。",
    items: [
      { title: "今日行动", icon: "layout-dashboard", copy: "集中查看今天该做什么、已经记录了什么、还缺什么。" },
      { title: "学习打卡", icon: "graduation-cap", copy: "学习、备考和训练进度可以持续记录。" },
      { title: "周期复盘", icon: "bar-chart-3", copy: "按日期确认日报来源，用已确认项目活动、任务和打卡核对事实；用户补充不会被 AI 重生成覆盖。" },
      { title: "待确认草稿", icon: "file-clock", copy: "可选自动复盘只生成待确认稿。来源变化会标记过期，审核后才保存为正式复盘。" },
      { title: "项目上下文", icon: "git-branch", copy: "导入并跟踪多种 AI 会话，在节点画布定位过程，生成带证据的交接 V2，并迁移给不同目标工具。" },
      { title: "外部 AI 协议", icon: "file-key-2", copy: "Codex、Claude、OpenCode、Pi 等工具先读取 Life OS 指南，并通过候选收件箱安全回写。" },
      { title: "微信连接", icon: "message-circle", copy: "在插件内扫码管理多个微信 Bot，无需 OpenClaw；支持图片视觉输入、消息级 Skill、微信纯文本公式、项目上下文与受控写入，会话仍保存为本地 Markdown。" },
      { title: "主题与模型", icon: "sliders-horizontal", copy: "在设置里切换视觉主题、AI 服务商、模型和回复风格。" },
      { title: "Pro 授权", icon: "badge-check", copy: "免费版免费使用，定位为基础手动使用，支持 1 台本地使用；月付、买断、兑换码和授权码都集中在授权中心。" }
    ]
  }
];

const WORKFLOWS = [
  {
    title: "最简单用法",
    icon: "sun",
    steps: ["把原始内容发给 AI 助手", "在执行过程中核对检索和生成状态", "按需预览确认，或对唯一明确目标自动写入", "回到今日行动查看结果"]
  },
  {
    title: "学习 / 备考",
    icon: "graduation-cap",
    steps: ["把资料、错题或复习状态丢给 AI", "让 AI 提炼知识点和下一步", "确认沉淀到知识库或打卡", "用复盘查看长期趋势"]
  },
  {
    title: "周期复盘",
    icon: "bar-chart-3",
    steps: ["在多维复盘页打开日、周或月复盘", "选择日期范围并确认日报与已确认事实", "生成草稿并核对来源、行动项和质量提示", "在独立用户补充区编辑，按需重生成 AI 区", "保存为正式新版本；自动流程只产生待确认草稿"]
  },
  {
    title: "项目 AI 会话",
    icon: "git-branch",
    steps: ["选择项目并绑定工作目录", "主动检查支持工具或导入标准会话文件", "按名称搜索并预览归属、重复和冲突", "在阅读器或过程树追溯每条对话", "核对交接 V2 后迁移当前会话或整个项目到任意目标工具"]
  },
  {
    title: "微信远程使用",
    icon: "message-circle",
    steps: ["在设置中开启微信连接并扫码；需要更多 Bot 时继续点击添加微信账号", "首次私聊获取配对码并回到设置批准", "先配置视觉模型再直接发送图片，或用 /skill <名称> <问题> 调用指定 Skill", "用 /lifeos use <项目名> 绑定项目后开始提问", "回复公式会自动转成微信可读普通算式；写入仍按权限确认"]
  }
];

export class UserGuideView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: PersonalLifeSystemPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return USER_GUIDE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "使用手册";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    const main = createLifeOSShell(container as HTMLElement, this.plugin, "guide");
    main.addClass("lifeos-guide-view");

    createHeroHeader(main, {
      kicker: "使用手册",
      title: "把任何内容丢给 AI 助手",
      description: "Life OS 的核心用法是先把想法、任务、日记、资料、错题、复盘和问题交给 AI 助手处理。AI 会帮你识别、拆解和归类；写入默认关闭，你可以选择预览确认，或只对当前唯一明确目标自动写入。",
      icon: "book-open-check",
      actions: [
        { label: "问 Life OS", icon: "send", primary: true, onClick: () => void this.plugin.activateChat("我有一段内容想让你帮我处理。") },
        { label: "打开今日行动", icon: "layout-dashboard", onClick: () => void this.plugin.activateDashboard() }
      ]
    });

    this.renderHighlights(main);
    this.renderFeatureMap(main);
    this.renderWorkflows(main);
    this.renderDataAndPro(main);
  }

  private renderHighlights(parent: HTMLElement): void {
    const grid = parent.createDiv({ cls: "lifeos-guide-highlight-grid" });
    for (const item of HIGHLIGHTS) {
      const card = createCard(grid, "lifeos-guide-highlight-card");
      card.createDiv({ cls: "lifeos-guide-highlight-label", text: item.label });
      card.createEl("strong", { text: item.value });
      card.createEl("p", { text: item.copy });
    }
  }

  private renderFeatureMap(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "lifeos-guide-section" });
    const title = section.createDiv({ cls: "lifeos-section-heading" });
    title.createEl("h2", { text: "AI 助手是总入口" });
    title.createEl("p", { text: "模块仍然存在，但用户不需要先学习模块。先把内容交给 AI，再由 AI 帮你流向合适的位置。" });

    const grid = section.createDiv({ cls: "lifeos-guide-feature-grid" });
    for (const group of FEATURE_GROUPS) {
      const card = createCard(grid, "lifeos-guide-feature-card");
      const head = card.createDiv({ cls: "lifeos-guide-feature-head" });
      setIcon(head.createSpan({ cls: "lifeos-guide-feature-icon" }), group.icon);
      const copy = head.createDiv();
      copy.createEl("h3", { text: group.title });
      copy.createEl("p", { text: group.copy });

      const list = card.createDiv({ cls: "lifeos-guide-feature-list" });
      for (const feature of group.items) {
        const row = list.createDiv({ cls: "lifeos-guide-feature-row" });
        setIcon(row.createSpan({ cls: "lifeos-guide-row-icon" }), feature.icon);
        const text = row.createDiv();
        text.createEl("h4", { text: feature.title });
        text.createEl("p", { text: feature.copy });
      }
    }
  }

  private renderWorkflows(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "lifeos-guide-section" });
    const title = section.createDiv({ cls: "lifeos-section-heading" });
    title.createEl("h2", { text: "推荐工作流" });
    title.createEl("p", { text: "按你的使用阶段选择入口，不需要一次性把所有模块都用满。" });

    const grid = section.createDiv({ cls: "lifeos-guide-workflow-grid" });
    WORKFLOWS.forEach((workflow) => {
      const card = createCard(grid, "lifeos-guide-workflow-card");
      const head = card.createDiv({ cls: "lifeos-card-title" });
      setIcon(head.createSpan(), workflow.icon);
      head.createSpan({ text: workflow.title });

      const steps = card.createEl("ol", { cls: "lifeos-guide-workflow-steps" });
      for (const step of workflow.steps) {
        steps.createEl("li", { text: step });
      }
    });
  }

  private renderDataAndPro(parent: HTMLElement): void {
    const grid = parent.createDiv({ cls: "lifeos-guide-bottom-grid lifeos-guide-action-grid" });

    const local = createCard(grid, "lifeos-guide-action-card");
    this.cardTitle(local, "数据与迁移", "folder-lock");
    local.createEl("p", { text: "AI 处理后的内容会沉淀到本地 Markdown 文件。日记、任务、知识、记忆、复盘和授权备份都围绕当前 Vault 组织，数据查看、导出和迁移入口不会被 Pro 锁死。" });
    const localActions = local.createDiv({ cls: "lifeos-guide-card-actions" });
    createButton(localActions, "打开知识库", () => void this.plugin.activateKnowledge(), { ghost: true, icon: "library" });
    createButton(localActions, "打开今日日记", () => void this.plugin.openTodayNote(false), { ghost: true, icon: "book-open" });
    createButton(localActions, "打开项目上下文", () => void this.plugin.activateAiWorkspace(), { ghost: true, icon: "git-branch" });

    const pro = createCard(grid, "lifeos-guide-action-card");
    this.cardTitle(pro, "免费版 / 完整体验 Pro / 短期 Pro 使用 / 长期 Pro 使用", "columns-3");
    pro.createEl("p", { text: "免费版免费使用，定位为基础手动使用，支持 1 台本地使用；30 天试用免费一次，定位为完整体验 Pro，功能与 Pro 一致，设备数最多 3 台，适合先跑通核心记录闭环；月付 Pro 适合阶段性高频和临时多设备授权；买断 Pro 适合长期用户的主力 Vault。可购买商品、实时金额和设备额度由 Pro 授权中心从当前授权服务同步。已购买月付或买断 Pro 的老用户继续保留原有权益。" });
    const proActions = pro.createDiv({ cls: "lifeos-guide-card-actions" });
    createButton(proActions, "查看版本对比", () => void this.plugin.activateProCompare(), { primary: true, icon: "arrow-right" });
    createButton(proActions, "授权中心", () => void this.plugin.activateProLicense(), { ghost: true, icon: "badge-check" });
  }

  private cardTitle(parent: HTMLElement, title: string, icon: string): void {
    const head = parent.createDiv({ cls: "lifeos-card-title" });
    setIcon(head.createSpan(), icon);
    head.createSpan({ text: title });
  }
}
