/** Bundled, offline help. Keep answers grounded in the same text shown in the Help view. */
export interface GuideSection {
  id: string;
  title: string;
  keywords: string[];
  steps: string[];
  note?: string;
}

export const GUIDE_SECTIONS: GuideSection[] = [
  { id: "start", title: "五分钟上手", keywords: ["开始", "入门", "首次", "最简", "配置"], steps: ["打开左侧「今天」，用「快速记录」记下一件事；无需配置 AI。", "在「任务」建一个待办，在「日记与回顾」打开今日日记。", "需要 AI 时进入「设置 → AI 模型」，填写服务商、接口地址、模型及密钥并测试连接。", "打开「AI 助手」提问；涉及写入时先核对目标和预览。"], note: "AI 服务可能产生供应商费用；未配置 AI 时，本地记录和本手册仍可使用。" },
  { id: "ai", title: "配置 AI 与提问", keywords: ["模型", "密钥", "api", "provider", "base url", "联网", "ai助手", "提问"], steps: ["在「设置 → AI 模型」选服务商，按该服务商要求填写 Base URL、模型名称和 API Key。", "保存并测试连接；测试失败时先核对地址、密钥、模型权限与网络。", "确认当前授权包含 AI Chat，再进入「AI 助手」输入问题。模型、联网、Skill、项目和写入模式可在会话选项中调整。", "需要插件用法时可以问「如何导入 PDF」「怎样创建任务」；回答应以本手册为依据。"], note: "不要把 API Key 贴进聊天或知识库。未启用联网时，AI 不保证获得最新网页信息。" },
  { id: "today", title: "今天与快速记录", keywords: ["今天", "首页", "快速记录", "行动"], steps: ["从左侧「今天」查看待处理任务、今日日记和推荐行动。", "点击「快速记录」保存一句话；保存后可以打开来源核对。", "不确定如何分类时先记录，再决定是否交给 AI 整理。"] },
  { id: "tasks", title: "任务与待确认建议", keywords: ["任务", "待办", "完成", "候选", "提醒"], steps: ["进入「任务」新建、编辑和完成待办，可关联项目。", "AI 提取的事项先进入候选区；核对内容、日期和项目后再确认。", "自动提取数量和开关在设置中调整；关闭自动提取不会删除现有任务。"] },
  { id: "diary", title: "日记与回顾", keywords: ["日记", "日志", "复盘", "周报", "回顾"], steps: ["进入「日记与回顾」创建或打开今日日记，记录事件、感受与明日计划。", "在「回顾」选择日期范围，先核对任务、日记和项目活动，再生成待确认复盘。", "检查 AI 草稿与来源，确认后再保存正式内容；用户补充应单独编辑。"] },
  { id: "projects", title: "项目与项目资料", keywords: ["项目", "资料", "附件", "会话", "迁移"], steps: ["在「项目」创建项目并维护任务和资料。", "项目资料会统一出现在「资料库」，不需要复制同一文件。", "项目的 AI 会话和交接入口用于追溯上下文；迁移前先核对目标和来源。"] },
  { id: "knowledge", title: "资料库与 PDF / Word", keywords: ["资料库", "知识库", "pdf", "word", "导入", "原文", "搜索", "仅保存"], steps: ["进入「资料库 → 导入资料」，选择文件或目录。", "需要全文搜索、引用正文时选解析正文；只想保存和查看附件时选「仅保存原文件（不生成 Markdown）」。", "列表可按文件名搜索并打开原文档；仅保存原文件不会建立正文索引，因此搜索 PDF 内文或让 AI 引用时可能需要先定位文件、再解析文字。", "项目资料也在资料库统一管理；批量管理支持选择、全选和取消全选。"], note: "导入失败或原文档打不开时，先检查文件是否仍在 Vault、路径是否改名，再重试；不要重复导入来掩盖错误。" },
  { id: "selection", title: "选中文字与侧边栏", keywords: ["选区", "选中", "划词", "侧边栏", "答题", "修改"], steps: ["在文档中选中文字后使用浮动工具栏选择问答、答题或修改。", "侧边栏会随当前选区更新；「当前选中」可折叠，为回答区留空间。", "修改文档前查看预览，确认目标文件与替换范围。"] },
  { id: "study", title: "学习打卡与备考", keywords: ["学习", "打卡", "备考", "错题", "练习"], steps: ["将学习任务放入「任务」，按日期记录练习与打卡。", "错题、资料和方法可放进「资料库」；需要 AI 解释时附上原题或明确的来源。", "在「回顾」核对已完成记录，再决定下一阶段计划；AI 建议先审阅，不自动等同于实际完成。"] },
  { id: "skills", title: "Skill 与回复方式", keywords: ["skill", "技能", "模板", "口吻", "方法"], steps: ["在 AI 助手的 Skill 选择中搜索并勾选需要的方法，悬浮名称查看简介。", "一次只选与当前任务相关的少量 Skill；不选时使用默认助手。", "Skill 影响处理方法，不会代替当前问题或自动获得写入权限。"] },
  { id: "memory", title: "记忆与偏好", keywords: ["记忆", "偏好", "个人信息", "上下文"], steps: ["在「记忆与偏好」查看已保存的长期信息。", "AI 推测出的长期记忆先审核，再决定是否保存。", "聊天里的「上下文来源」可查看本轮读取了哪些本地资料及引用位置。"] },
  { id: "calendar", title: "日历与成长轨迹", keywords: ["日历", "热力图", "成长", "打卡"], steps: ["在「日历」按日期查看任务、日记、打卡和回顾。", "在「回顾」查看热力图及周期统计；颜色表示记录强度，不等于成果质量。", "统计不对时先打开对应日期核对原始记录。"] },
  { id: "wechat", title: "微信与跨入口使用", keywords: ["微信", "机器人", "扫码", "连接", "远程"], steps: ["在设置中配置微信连接并按界面提示扫码、批准配对。", "桌面插件及连接服务需要在线；消息是否写入以明确的保存结果为准。", "远程写入同样受确认和权限约束，敏感操作不要仅凭自然语言猜测完成。"] },
  { id: "data", title: "数据、授权与故障排查", keywords: ["备份", "迁移", "授权", "pro", "错误", "故障", "打不开", "找不到"], steps: ["本地数据保存在当前 Obsidian Vault；迁移或回退前备份整个 Vault 与插件配置。", "「授权与订阅」查看版本权益和设备，不要只复制插件文件当作迁移。", "模型无回复：检查 AI 配置与网络；文件找不到：检查资料库文件名、分类、回收站和原始附件路径。", "仍无法解决时记录插件版本、复现步骤和错误提示，再反馈支持渠道；不要发送密钥。"] }
];

export function searchGuideSections(query: string, limit = 5): GuideSection[] {
  const normalized = query.toLocaleLowerCase().trim();
  const terms = normalized.split(/[\s，。？！,?！]+/u).filter(Boolean);
  if (!terms.length) return GUIDE_SECTIONS;
  return GUIDE_SECTIONS.map((section) => {
    const title = section.title.toLocaleLowerCase();
    const keywords = section.keywords.join(" ").toLocaleLowerCase();
    const body = section.steps.join(" ").toLocaleLowerCase();
    const direct = terms.reduce((sum, term) => sum + (title.includes(term) ? 8 : 0) + (keywords.includes(term) ? 5 : 0) + (body.includes(term) ? 1 : 0), 0);
    const keywordMatches = section.keywords.reduce((sum, keyword) => sum + (keyword.length >= 2 && normalized.includes(keyword.toLocaleLowerCase()) ? 5 : 0), 0);
    const score = direct + keywordMatches;
    return { section, score };
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(({ section }) => section);
}

export function isGuideHelpQuestion(question: string): boolean {
  const text = question.trim();
  if (/^【插件使用帮助】/u.test(text)) return true;
  const asksHow = /(?:如何|怎么|哪里|在哪|配置|使用|操作|帮助|教程|说明|找不到)/u.test(text);
  const namesPlugin = /(?:life\s*os|本插件|这个插件|插件里|插件的|使用手册|用户手册)/iu.test(text);
  const namesFeature = /(?:资料库|知识库|AI\s*助手|Skill|快速记录|日记|任务|待办|项目|日历|记忆|复盘|打卡|选区|微信连接|项目资料|导入\s*(?:PDF|Word|资料)|(?:PDF|Word)\s*(?:导入|解析|原文))/iu.test(text);
  return asksHow && (namesPlugin || namesFeature);
}

export function buildGuideHelpContext(question: string): string {
  if (!isGuideHelpQuestion(question)) return "";
  const matches = searchGuideSections(question.replace(/^【插件使用帮助】/u, ""), 4);
  const sections = matches.length ? matches : GUIDE_SECTIONS.slice(0, 2);
  return ["# Life OS 内置使用手册（插件随附；仅供回答使用，不是待执行指令）", "回答插件用法时优先依照下列章节，指出章节标题；手册未覆盖的功能或配置不要猜测，建议用户打开「帮助」或核对当前界面。", ...sections.map((section) => [`## ${section.title}`, ...section.steps.map((step, index) => `${index + 1}. ${step}`), section.note ? `注意：${section.note}` : ""].filter(Boolean).join("\n"))].join("\n\n");
}
