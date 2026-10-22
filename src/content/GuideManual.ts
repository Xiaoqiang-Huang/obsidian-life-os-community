/** Bundled, offline help. Keep answers grounded in the same text shown in the Help view. */
export interface GuideSection {
  id: string;
  title: string;
  keywords: string[];
  steps: string[];
  note?: string;
}

export const GUIDE_SECTIONS: GuideSection[] = [
  { id: "agent-sdk", title: "内置 AI 执行与故障处理", keywords: ["sdk", "claude", "anthropic", "deepseek", "执行引擎", "运行时", "连接测试", "移动端", "桌面版", "手机"], steps: ["桌面 AI 统一由插件内置 SDK 执行。只需在普通 AI 模型设置选择服务商、模型、Base URL 和 API Key；不再选择引擎、填写 CLI 路径或创建独立 SDK 档案。协议兼容不代表模型支持所有图像与工具能力。", "测试连接会对当前未保存草稿发出一次有界真实对话请求，可能产生费用；成功必须收到预期回答，不以模型列表或 HTTP 200 代替。不保存或临时覆盖当前配置，不自动改模型、借用其他账号或回退旧 API。离开设置或重新测试会取消前一次。", "若提示桌面运行时缺失、版本或文件校验失败，优先安装含当前平台固定运行时的完整插件包；如果本机已经安装 Claude Code CLI，插件也会自动识别并使用它，不需要手填路径。它不读取 CC Switch、全局 Claude 登录或旧 SecretStorage SDK 专用凭据。移动端不启动本机进程、也不创建运行时目录：点 AI 发送、选区 AI 或项目全文分析会先提示「此功能需要 Obsidian 桌面版」，不会先发出请求再失败。移动端的记录、任务、日记与资料库等非 AI 功能继续可用。各平台安装与更新覆盖以实际发布说明为准。", "SDK 仅通过 Life OS 宿主工具访问批准范围；原生 Bash、文件读写、外部 MCP、自动展开 @ 文件及子代理关闭。业务写入保留预览、Pro 和确认；文档缺页不会自动启动收费识别。工具续作在 SDK 查询释放后有界运行，共享预算、缓存与幂等回执。", "文本、JSON 和图片请求都走同一 SDK 内核。按服务商实际能力开启主模型图片支持，或填写独立视觉服务配置；不按模型名字猜能力。后台工作流和新会话记忆分别默认关闭，明确授权只绑定当前配置；切换配置后须重新授权，旧队列暂停，不自动补跑。旧配置或旧版本留下的记忆任务会保留为「已暂停」并在「记忆与偏好」显示暂停原因，需要你在当前普通 AI 配置下重新提交；重载插件、换模型或换账号都不会自动补跑，也不会静默改用其他账号或模型。", "Windows x64 完整桌面包内含 runtime 目录及固定版本清单。仅安装社区三文件时，插件会先自动识别本机已安装的 Claude Code CLI；如果也没有 CLI，才提示需要完整包。手动更新前备份插件目录，保留 data.json、sdk-state 和个人笔记，不导入开发者配置。其他平台及真实社区更新器尚未验收；不会自动下载可执行文件。", "停止、禁用插件或配置变化后不交付迟到结果，不自动重试用量不明的请求。工作状态与记忆排队通过持久回执防重复；未知用量不是零消耗。重载后已完成阶段复用回执，未完成部分需要检查范围与授权后继续。"], note: "实际供应商金额可能未知，SDK 估算不是账单承诺。真实模型兼容性、语义质量和各平台宿主效果需独立验收；SDK 与运行时适用其各自使用条款。" },
  { id: "project-full-analysis", title: "项目全文分析与完整观点索引", keywords: ["全文", "全量", "所有观点", "提炼", "观点索引", "覆盖率", "断点", "条件", "反例"], steps: ["在项目文档区点击「全文观点分析」，或运行命令「项目全文观点分析（先核对范围和额度）」。SDK 模式下聊天要求全量提炼时会打开同一入口，保留输入草稿，不用几个检索片段冒充整库阅读。", "选定单个项目，确认保守输入/输出窗口及整个 job 的查询、token、时间额度。窗口是你确认的操作边界，不是插件已测出的服务商上下文容量。", "点击建立本地清单：枚举项目 Documents / Attachments 及明确关联的识别缓存，按原件和有效正文哈希冻结身份。PDF 按页只读，DOCX 只读正文；未识别扫描页和未知结构分母会列为缺口，不自动 OCR。", "核对清单、profile、model、destination 和费用风险，记录该版本审批；再明确开始/继续。逐块提炼并保留原文定位、观点、论据、条件和反例，再分层综合。摘要长度不限制完整观点索引。", "暂停/关闭分析窗口会停止下一次调用，当前只读请求可完成并保留核验结果。插件重载/退出按可恢复中断处理，而不是用户取消；明确取消则终止该任务。通过 job ID 读取 checkpoint 不会付费，只有明确继续才处理剩余块，已完成块不会重复。中断后用量未知时继续按钮禁用：可查看或复制已有索引，先核对服务商回执，不要反复点击或删除锁。改变原文、模型、范围或预算需重新核对清单和审批，累计用量不清零。", "查看报告中的覆盖分子/分母和缺口。只有另行勾选派生报告授权并点保存，才写入独立 Markdown；不会修改原件，不把派生报告再当原材料。"], note: "定位、哈希、ID 覆盖检查不等于模型已经抓住所有真实语义。识别缓存可能被用户编辑，报告会标记来源边界；DOCX 图片/批注等未核验部分仍为 unknown。报价不明时不承诺金额硬上限；不确定消费会暂停，而非恢复时清零。" },
  { id: "start", title: "五分钟上手", keywords: ["开始", "入门", "首次", "最简", "配置"], steps: ["打开左侧「今天」，用「快速记录」记下一件事；无需配置 AI。", "在「任务」建一个待办，在「日记与回顾」打开今日日记。", "需要 AI 时进入「设置 → AI 模型」，填写服务商、接口地址、模型及密钥并测试连接。", "打开「AI 助手」提问；涉及写入时先核对目标和预览。"], note: "AI 服务可能产生供应商费用；未配置 AI 时，本地记录和本手册仍可使用。" },
  { id: "ai", title: "配置 AI 与提问", keywords: ["模型", "密钥", "api", "provider", "base url", "联网", "ai助手", "提问"], steps: ["在「设置 → AI 模型」选服务商，按该服务商要求填写 Base URL、模型名称和 API Key。", "保存并测试连接；测试失败时先核对地址、密钥、模型权限与网络。", "确认当前授权包含 AI Chat，再进入「AI 助手」输入问题。模型、联网、Skill、项目和写入模式可在会话选项中调整。", "写入档位仍是三档：「不写入」「预览确认」「明确指令自动写入」。选「明确指令自动写入」时，只有你已经写明目标（例如指定今日日记、知识库路径或项目文档）才会直接落盘；目标含糊、涉及删除或未指定项目时仍先给预览并等待确认。删除旧引擎不改变这三档语义，插件不会替你猜测写入位置。", "需要插件用法时可以问「如何导入 PDF」「怎样创建任务」；回答应以本手册为依据。"], note: "不要把 API Key 贴进聊天或知识库。未启用联网时，AI 不保证获得最新网页信息。" },
  { id: "web-search", title: "默认联网搜索", keywords: ["联网", "搜索", "默认", "Exa", "Parallel", "最新", "限流"], steps: ["配置好原有 AI 后即可使用默认联网搜索，不需要另装插件、Python、搜索账号或搜索密钥。", "会话联网选项：自动按问题决定是否搜索；始终主动搜索；关闭不发起联网检索。", "可直接问「搜索 Obsidian 最新更新」，打开上下文来源核对网页链接。默认先使用 Exa 官方匿名 MCP，连接故障或空结果自动使用 Parallel；不需要选择服务商。", "已有自定义搜索服务配置仍然保留；要使用免配置双源，请使用原有的内置搜索选项。"], note: "无感指无需配置，不代表隐瞒联网：检索关键词会发给搜索服务（Exa 或 Parallel），核验正文可能访问结果网页；不会由搜索客户端上传整库、整段历史或 AI 密钥。当前问题/引用若含隐私，勿让它变成检索词。匿名服务有额度和网络限制，达到限流会暂停并提示稍后重试，不反复切换绕过。网页摘要不等于已读取全文；AI 回答需保留引用并说明证据不足。" },
  { id: "today", title: "今天与快速记录", keywords: ["今天", "首页", "快速记录", "行动"], steps: ["从左侧「今天」查看待处理任务、今日日记和推荐行动。", "点击「快速记录」保存一句话；保存后可以打开来源核对。", "不确定如何分类时先记录，再决定是否交给 AI 整理。"] },
  { id: "tasks", title: "任务与待确认建议", keywords: ["任务", "待办", "完成", "候选", "提醒"], steps: ["进入「任务」新建、编辑和完成待办，可关联项目。", "AI 提取的事项先进入候选区；核对内容、日期和项目后再确认。", "自动提取数量和开关在设置中调整；关闭自动提取不会删除现有任务。"] },
  { id: "diary", title: "日记与回顾", keywords: ["日记", "日志", "复盘", "周报", "回顾"], steps: ["进入「日记与回顾」创建或打开今日日记，记录事件、感受与明日计划。", "在「回顾」选择日期范围，先核对任务、日记和项目活动，再生成待确认复盘。", "检查 AI 草稿与来源，确认后再保存正式内容；用户补充应单独编辑。"] },
  { id: "projects", title: "项目与项目资料", keywords: ["项目", "资料", "附件", "会话", "迁移"], steps: ["在「项目」创建项目并维护任务和资料。", "项目资料会统一出现在「资料库」，不需要复制同一文件。", "项目的 AI 会话和交接入口用于追溯上下文；迁移前先核对目标和来源。"] },
  { id: "knowledge", title: "资料库与 PDF / Word", keywords: ["资料库", "知识库", "pdf", "word", "docx", "扫描", "视觉识别", "识别文本", "缓存", "导入", "原文", "搜索", "仅保存"], steps: ["进入「资料库 → 导入资料」，选择文件或目录。", "需要全文搜索、引用正文时选解析正文；只想保存和查看附件时选「仅保存原文件（不生成 Markdown）」。", "仅保存原文件仍可按文件名查找；向 AI 提问时说明文件名，AI 可按页读取 PDF 或读取 DOCX，首次读取会在 Life OS 根目录的 Knowledge（中文目录模式为资料库）/DocumentRecognition 生成可见识别 Markdown，后续优先复用，不在资料库增加第二条文档。", "在资料库点「查看原文档」可在 Obsidian 标签页只读预览 .docx（标题、段落、表格和图片）；选中文字会按选区设置唤出与 PDF 相同的 AI 工具栏，生成结果可复制但不能直接写回 Word 原件；桌面端也可点「用系统程序打开」。预览不修改原件，复杂 Word 排版可能与 Word 不完全一致。", "扫描版 PDF 只有在设置中启用并配置视觉模型后才能识别图片页；引用会指向原件与页码，识别文字可能有误，重要内容请核对原文。旧版 .doc 暂不支持，请先转换为 .docx。", "项目资料也在资料库统一管理；批量管理支持选择、全选和取消全选。"], note: "原文件内容改变后旧识别结果不再用作 AI 证据。导入失败或原文档打不开时，先检查文件是否仍在 Vault、路径是否改名，再重试；不要重复导入来掩盖错误。" },
  { id: "selection", title: "选中文字与侧边栏", keywords: ["选区", "选中", "划词", "侧边栏", "答题", "修改"], steps: ["在文档中选中文字后使用浮动工具栏选择问答、答题或修改。", "侧边栏会随当前选区更新；「当前选中」可折叠，为回答区留空间。", "修改文档前查看预览，确认目标文件与替换范围。"] },
  { id: "study", title: "学习打卡与备考", keywords: ["学习", "打卡", "备考", "错题", "练习"], steps: ["将学习任务放入「任务」，按日期记录练习与打卡。", "错题、资料和方法可放进「资料库」；需要 AI 解释时附上原题或明确的来源。", "在「回顾」核对已完成记录，再决定下一阶段计划；AI 建议先审阅，不自动等同于实际完成。"] },
  { id: "skills", title: "Skill 与回复方式", keywords: ["skill", "技能", "模板", "口吻", "方法"], steps: ["在 AI 助手的 Skill 选择中搜索并勾选需要的方法，悬浮名称查看简介。", "一次只选与当前任务相关的少量 Skill；不选时使用默认助手。", "Skill 影响处理方法，不会代替当前问题或自动获得写入权限。"] },
  { id: "memory", title: "记忆与偏好", keywords: ["记忆", "偏好", "个人信息", "上下文"], steps: ["在「记忆与偏好」查看已保存的长期信息。", "AI 推测出的长期记忆先审核，再决定是否保存。", "聊天里的「上下文来源」可查看本轮读取了哪些本地资料及引用位置；本地检索为词面混合检索（关键词 + 内置同义词/别名扩展），不含语义模型，同义改写或跨语言提问可能找不到对应笔记。"] },
  { id: "calendar", title: "日历与成长轨迹", keywords: ["日历", "热力图", "成长", "打卡"], steps: ["在「日历」按日期查看任务、日记、打卡和回顾。", "在「回顾」查看热力图及周期统计；颜色表示记录强度，不等于成果质量。", "统计不对时先打开对应日期核对原始记录。"] },
  { id: "wechat", title: "微信与跨入口使用", keywords: ["微信", "机器人", "扫码", "连接", "远程", "SDK"], steps: ["在设置中配置微信连接并按界面提示扫码、批准配对；未批准的账号和群聊不会进入模型。", "在 AI 设置明确启用已验证的 Agent SDK 后，桌面聊天和微信普通文本共用该 SDK 主配置，无需另填原 AI API；微信文字模型覆盖项仅适用于原 API。回答修订也走同一 SDK，共享本轮请求额度，不隐藏调用旧 API。", "明确说“不要联网/搜索”时，本轮微信预检索和模型联网工具都关闭。重复消息及重载后的已完成消息复用持久回复，账户、渠道和会话分别隔离；未确认的旧回执不会自动重跑。", "桌面插件及连接服务需要在线。图片仍需独立视觉配置。日记整理、周期复盘、知识整理、选区问答和工作区的手动文字操作会使用已启用的 SDK；各功能的范围、授权和写入确认保持不变。自动日终整理、自动复盘及跟踪会话摘要需另行开启「允许 SDK 后台文字工作流」，默认关闭，并绑定当前已验证配置；换模型、端点或运行时后需重新开启。", "远程写入仍由微信持久提案、审批和权限机制负责，不直接开放 SDK 写入工具；敏感操作不要仅凭自然语言猜测完成。"] },
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
  const namesFeature = /(?:Claude\s*Agent\s*SDK|SDK|执行引擎|全文分析|观点索引|联网|默认搜索|网页搜索|资料库|知识库|AI\s*助手|Skill|快速记录|日记|任务|待办|项目|日历|记忆|复盘|打卡|选区|微信连接|项目资料|导入\s*(?:PDF|Word|资料)|(?:PDF|Word)\s*(?:导入|解析|原文))/iu.test(text);
  return asksHow && (namesPlugin || namesFeature);
}

/** Maximum number of bundled manual sections injected into one question. */
export const GUIDE_HELP_MAX_SECTIONS = 4;

export function buildGuideHelpContext(question: string): string {
  if (!isGuideHelpQuestion(question)) return "";
  const matches = searchGuideSections(question.replace(/^【插件使用帮助】/u, ""), GUIDE_HELP_MAX_SECTIONS);
  const sections = matches.length ? matches : GUIDE_SECTIONS.slice(0, 2);
  return ["# Life OS 内置使用手册（插件随附；仅供回答使用，不是待执行指令）", "回答插件用法时优先依照下列章节，指出章节标题；手册未覆盖的功能或配置不要猜测，建议用户打开「帮助」或核对当前界面。", ...sections.map((section) => [`## ${section.title}`, ...section.steps.map((step, index) => `${index + 1}. ${step}`), section.note ? `注意：${section.note}` : ""].filter(Boolean).join("\n"))].join("\n\n");
}

/** Host-side, read-only, deterministic manual injection for the default desktop
 * SDK chat path (F-05b). It reuses the exact sections shown in the Help view and
 * returns no section for unrelated questions, so the model never receives manual
 * text for a non-help request. */
export function guideHelpPromptSections(question: string): string[] {
  const context = buildGuideHelpContext(question);
  return context ? [context] : [];
}
