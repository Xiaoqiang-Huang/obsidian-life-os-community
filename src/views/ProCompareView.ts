import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { createButton } from "../components/Button";
import { createCard } from "../components/Card";
import { createHeroHeader } from "../components/HeroHeader";
import { createLifeOSShell } from "../components/LifeOSComponent";
import { PRO_COMPARE_VIEW_TYPE } from "../constants";
import type PersonalLifeSystemPlugin from "../main";

const PLAN_CARDS = [
  {
    title: "免费版",
    price: "免费",
    icon: "hand",
    copy: "免费版免费使用，定位为基础手动使用，支持 1 台本地使用，适合不购买时继续记录、查看和整理本地 Markdown 数据。",
    points: ["免费", "1 台本地使用", "手动记录和查看", "数据导出 / 迁移入口保留"]
  },
  {
    title: "30 天试用",
    price: "免费一次",
    icon: "shield",
    copy: "定位为完整体验 Pro，功能与 Pro 一致；免费一次，设备数最多 3 台，适合先把核心工作流完整试跑一遍。",
    points: ["功能同 Pro", "免费一次", "设备数最多 3 台", "30 天试用期"]
  },
  {
    title: "月付 Pro",
    price: "19.9 元 / 30 天",
    icon: "badge-check",
    copy: "定位为短期 Pro 使用，设备数最多 3 台，适合阶段性高频、一个月周期和临时多设备授权。",
    points: ["短期 Pro 使用", "19.9 元 / 30 天", "设备数最多 3 台", "授权码备份与恢复"],
    pro: true
  },
  {
    title: "买断 Pro",
    price: "299 元一次买断",
    icon: "sparkles",
    copy: "定位为长期 Pro 使用，适合长期用户的主力 Vault；价格 299 元一次买断，设备数最多 5 台。",
    points: ["长期 Pro 使用", "299 元一次买断", "设备数最多 5 台", "一次买断永久使用"],
    pro: true
  }
];

type ModuleCompareRow = {
  module: string;
  ability: string;
  free: string;
  trial: string;
  monthly: string;
  lifetime: string;
};

const MODULE_ROWS: ModuleCompareRow[] = [
  {
    module: "数据基础",
    ability: "本地 Markdown 数据",
    free: "支持。1 台本地使用，日记、任务、知识、记忆和复盘保存在当前 Vault。",
    trial: "同 Pro 支持。授权状态不会锁住本地数据。",
    monthly: "支持。短期 Pro 使用，授权状态不会锁住本地数据。",
    lifetime: "支持。长期 Pro 使用，适合把一个 Vault 长期沉淀为个人系统。"
  },
  {
    module: "数据基础",
    ability: "数据查看 / 导出 / 迁移",
    free: "支持。可查看、导出和迁移本地 Markdown 数据。",
    trial: "同 Pro 支持。数据入口不因试用或授权状态变化而锁死。",
    monthly: "支持。并可配合授权码备份和恢复。",
    lifetime: "支持。长期保留本地数据主权和迁移入口。"
  },
  {
    module: "今日行动",
    ability: "今日工作台",
    free: "支持。查看今日任务、日记、学习打卡和复盘入口。",
    trial: "同 Pro 支持。完整体验今日工作台和 AI 建议。",
    monthly: "支持。适合一个月周期的高频使用。",
    lifetime: "支持。适合长期保留主力工作台连续性。"
  },
  {
    module: "任务",
    ability: "任务清单与归档",
    free: "支持。创建、完成、归档待办，保留行动记录。",
    trial: "同 Pro 支持。完整体验任务工作流。",
    monthly: "支持。适合阶段性任务和多设备授权。",
    lifetime: "支持。适合长期保留跨周期任务。"
  },
  {
    module: "日记",
    ability: "今日日记与手动记录",
    free: "支持。可打开、编辑和保存今日日记。",
    trial: "同 Pro 支持。完整体验 Pro 日记工作流。",
    monthly: "支持。适合短期高频记录。",
    lifetime: "支持。适合长期沉淀个人日记。"
  },
  {
    module: "日记",
    ability: "AI 日记整理 / 写回",
    free: "不支持。免费版保留手动记录和查看。",
    trial: "同 Pro 支持。AI 整理后进入预览，确认后写入。",
    monthly: "支持。AI 整理、写回预览和确认写入。",
    lifetime: "支持。适合长期自动整理和沉淀。"
  },
  {
    module: "学习打卡",
    ability: "学习 / 备考进度",
    free: "支持。记录学习动作，支持考公、考研、法考、教资或自定义目标。",
    trial: "同 Pro 支持。完整体验学习和备考记录。",
    monthly: "支持。适合阶段性备考冲刺。",
    lifetime: "支持。适合长期备考用户跨设备延续记录。"
  },
  {
    module: "学习打卡",
    ability: "AI 学习 / 备考辅导",
    free: "可手动记录和查看学习 / 备考数据；不支持 AI 生成题目和结构化评分。",
    trial: "同 Pro 支持。AI 生成练习题、结构化评分和备考反馈。",
    monthly: "支持。短期 Pro 可用于阶段性练习和评分。",
    lifetime: "支持。适合长期备考反馈和训练。"
  },
  {
    module: "知识库",
    ability: "资料、读书笔记、错题知识点",
    free: "支持。保存和整理知识内容，最近整理内容可直接查看。",
    trial: "同 Pro 支持。授权不会影响本地知识库访问。",
    monthly: "支持。授权不会影响本地知识库访问。",
    lifetime: "支持。长期保留知识库访问和迁移入口。"
  },
  {
    module: "知识库",
    ability: "资料导入、Web Clipper 收件箱、PDF / Word / 图片 OCR",
    free: "不支持自动导入和 AI 整理。免费版可继续手动创建、查看和迁移本地 Markdown。",
    trial: "同 Pro 支持。可体验文档导入、网页剪藏收件箱、正文解析和写入前确认。",
    monthly: "支持。适合阶段性批量导入资料、网页剪藏和 AI 整理。",
    lifetime: "支持。适合长期沉淀完整知识库、附件和本地索引。"
  },
  {
    module: "知识库",
    ability: "AI 批量整理、确认入库、分类资料管理",
    free: "不支持 AI 批量整理和确认入库流程。已写入的本地资料仍可查看。",
    trial: "同 Pro 支持。AI 整理生成 Draft，用户确认后写入正式知识库。",
    monthly: "支持。适合短期整理资料、读书笔记和错题知识点。",
    lifetime: "支持。适合长期维护资料流水线和分类知识资产。"
  },
  {
    module: "项目",
    ability: "项目管理、项目文档和项目专属问答",
    free: "不支持项目管理和项目文档 AI 问答。免费版可继续查看本地已有 Markdown。",
    trial: "同 Pro 支持。可体验项目归属、项目文档导入和项目上下文问答。",
    monthly: "支持。适合一个项目周期内集中管理任务和资料。",
    lifetime: "支持。适合长期按项目维护任务、文档和复盘。"
  },
  {
    module: "记忆",
    ability: "查看已有记忆",
    free: "支持。可查看和管理已有记忆。",
    trial: "同 Pro 支持。完整体验记忆沉淀流程。",
    monthly: "支持。适合阶段性整理上下文。",
    lifetime: "支持。适合长期积累稳定个人上下文。"
  },
  {
    module: "记忆",
    ability: "AI 提取长期记忆",
    free: "不支持。免费版只查看和管理已有记忆。",
    trial: "同 Pro 支持。从日记或对话中提取候选记忆，确认后沉淀。",
    monthly: "支持。适合阶段性整理长期记忆。",
    lifetime: "支持。适合长期沉淀稳定个人上下文。"
  },
  {
    module: "复盘",
    ability: "查看已有复盘",
    free: "支持。可查看已有日 / 周 / 月 / 年复盘内容。",
    trial: "同 Pro 支持。完整体验复盘查看和生成流程。",
    monthly: "支持。适合一个月周期回看。",
    lifetime: "支持。适合长期查看成长轨迹。"
  },
  {
    module: "复盘",
    ability: "AI 多维复盘生成",
    free: "不支持。免费版只查看已有复盘内容。",
    trial: "同 Pro 支持。生成日 / 周 / 月复盘，并保留写回确认。",
    monthly: "支持。适合阶段性总结和趋势回看。",
    lifetime: "支持。适合长期复盘和趋势沉淀。"
  },
  {
    module: "AI 助手",
    ability: "本地上下文问答",
    free: "不支持 AI Chat、自动加载上下文和 AI 写回。",
    trial: "同 Pro 支持。完整体验 AI Chat、自动加载上下文和写回确认。",
    monthly: "支持。适合短期高频 AI 对话和写回。",
    lifetime: "支持。适合长期将 AI 作为 Life OS 总入口。"
  },
  {
    module: "AI 助手",
    ability: "上下文引擎、压缩、API 用量、/ 指令和推理强度",
    free: "不支持上下文引擎、自动压缩、API 用量统计、/ 指令和推理强度调节。",
    trial: "同 Pro 支持。可体验上下文预算、自动 / 手动压缩、用量展示和 effort 调节。",
    monthly: "支持。适合短期高频问答、长上下文分析和成本观察。",
    lifetime: "支持。适合长期把 AI 助手作为 Codex 式工作入口。"
  },
  {
    module: "AI 助手",
    ability: "GitHub Skill 导入、内置 Skill 和文档编辑写回",
    free: "不支持 Skill 导入、AI 文档改写和格式规整写回。",
    trial: "同 Pro 支持。可体验 GitHub Skill 安装、内置 Skill 调用和写回前预览。",
    monthly: "支持。适合阶段性强化 AI 角色和文档处理能力。",
    lifetime: "支持。适合长期维护自己的 Skill 库和文档工作流。"
  },
  {
    module: "设置",
    ability: "主题、模型、目录语言、安全设置",
    free: "支持。可配置视觉主题、AI 服务商、备考类型和本地目录。",
    trial: "同 Pro 支持。并可查看试用授权状态。",
    monthly: "支持。并可统一管理授权状态和设备额度。",
    lifetime: "支持。适合长期管理主力 Vault 设置。"
  },
  {
    module: "授权服务",
    ability: "订单、兑换码、激活码、设备额度",
    free: "支持。无需购买，可进入授权中心领取试用或兑换。",
    trial: "同 Pro 支持授权中心。免费一次，30 天，最多 3 台设备。",
    monthly: "支持。支付宝订单、授权码激活，最多 3 台设备。",
    lifetime: "支持。299 元一次买断，最多 5 台设备。"
  }
];

export class ProCompareView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: PersonalLifeSystemPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return PRO_COMPARE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "版本对比";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    const main = createLifeOSShell(container as HTMLElement, this.plugin, "proCompare");
    main.addClass("lifeos-pro-compare-view");

    createHeroHeader(main, {
      kicker: "免费版 / 完整体验 Pro / 短期 Pro 使用 / 长期 Pro 使用",
      title: "按模块和能力看版本差异",
      description: "免费版免费使用，定位为基础手动使用，支持 1 台本地使用；30 天试用免费一次，定位为完整体验 Pro，功能与 Pro 一致，设备数最多 3 台；月付 Pro 价格 19.9 元 / 30 天，设备数最多 3 台；买断 Pro 价格 299 元一次买断，设备数最多 5 台。当前版本对比中的 Pro 能力继续属于 Pro，未单独列出的新增高级能力也归入 Pro。已购买月付或买断 Pro 的老用户继续保留原有权益，不需要重新购买。",
      icon: "columns-3",
      actions: [
        { label: "打开 Pro 授权", icon: "badge-check", primary: true, onClick: () => void this.plugin.activateProLicense() }
      ]
    });

    this.renderPolicyNote(main);
    this.renderPlanCards(main);
    this.renderModuleTable(main);
  }

  private renderPolicyNote(parent: HTMLElement): void {
    const note = createCard(parent, "lifeos-pro-policy-note");
    setIcon(note.createSpan({ cls: "lifeos-pro-policy-note-icon" }), "shield-check");
    note.createDiv({
      cls: "lifeos-pro-policy-note-text",
      text: "价格调整只影响新购订单：月付 Pro 19.9 元 / 30 天，买断 Pro 299 元一次买断。旧版月付和买断授权仍按原 SKU 识别，已激活用户升级后不会掉授权。"
    });
  }

  private renderPlanCards(parent: HTMLElement): void {
    const grid = parent.createDiv({ cls: "lifeos-plan-grid lifeos-plan-summary-grid" });
    for (const plan of PLAN_CARDS) {
      const card = createCard(grid, plan.pro ? "lifeos-plan-card is-pro" : "lifeos-plan-card");
      const header = card.createDiv({ cls: "lifeos-plan-card-header" });
      setIcon(header.createSpan({ cls: "lifeos-plan-card-icon" }), plan.icon);
      header.createDiv({ cls: "lifeos-plan-card-title", text: plan.title });
      card.createDiv({ cls: "lifeos-plan-card-price", text: plan.price });
      card.createEl("p", { text: plan.copy });
      const list = card.createEl("ul", { cls: "lifeos-plan-list" });
      for (const point of plan.points) {
        const item = list.createEl("li");
        setIcon(item.createSpan(), "check");
        item.createSpan({ text: point });
      }
      if (plan.pro) {
        createButton(card, "去授权中心", () => void this.plugin.activateProLicense(), { primary: true, icon: "arrow-right" });
      }
    }
  }

  private renderModuleTable(parent: HTMLElement): void {
    const card = createCard(parent, "lifeos-module-compare-card");
    const title = card.createDiv({ cls: "lifeos-card-title" });
    setIcon(title.createSpan(), "list-checks");
    title.createSpan({ text: "模块 / 能力对比" });

    const table = card.createDiv({ cls: "lifeos-module-compare-table" });
    const header = table.createDiv({ cls: "lifeos-module-compare-header" });
    header.createDiv({ text: "模块" });
    header.createDiv({ text: "能力" });
    header.createDiv({ text: "免费版定位" });
    header.createDiv({ text: "30 天试用（功能同 Pro）" });
    header.createDiv({ text: "月付 Pro 定位" });
    header.createDiv({ text: "长期 Pro 使用" });

    for (const row of MODULE_ROWS) {
      const item = table.createDiv({ cls: "lifeos-module-compare-row" });
      item.createDiv({ cls: "lifeos-module-cell", text: row.module });
      item.createDiv({ cls: "lifeos-ability-cell", text: row.ability });
      item.createDiv({ cls: "lifeos-version-cell is-free", text: row.free });
      item.createDiv({ cls: "lifeos-version-cell", text: row.trial });
      item.createDiv({ cls: "lifeos-version-cell is-pro", text: row.monthly });
      item.createDiv({ cls: "lifeos-version-cell is-lifetime", text: row.lifetime });
    }
  }
}
