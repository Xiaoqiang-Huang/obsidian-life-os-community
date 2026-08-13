# Life OS Assistant

<div align="center">

**Obsidian 中本地优先的日常工作与 AI 协作操作系统。**

[English](README.md) · [**简体中文**](README.zh-CN.md)

![版本](https://img.shields.io/badge/版本-0.3.11-0f172a?style=flat-square)
![Obsidian](https://img.shields.io/badge/Obsidian-1.5.0%2B-7c3aed?style=flat-square)
![本地优先](https://img.shields.io/badge/数据-本地优先-15803d?style=flat-square)
![移动端](https://img.shields.io/badge/移动端-支持-2563eb?style=flat-square)

</div>

## 简体中文

Life OS Assistant 把 Obsidian Vault 变成一个相互关联的工作空间，用于管理**今天、任务、日记、知识、记忆、复盘、AI 助手和项目 AI 会话**。用户可读内容仍然保存在 Vault 的 Markdown 中；AI 生成内容先作为候选展示来源和写入位置，确认后才进入正式记录。

当前版本：**0.3.11** · Obsidian **1.5.0+** · `isDesktopOnly: false`

> **关于配图：** 下方导览图依据 0.3.11 当前的信息架构和已经实现的工作流生成，全部使用虚构数据和中性 Obsidian 主题。实际界面会随你的 Obsidian 主题、窗口尺寸和已启用功能变化。

![Life OS 今日总览](readme-assets/01-today-overview.webp)

## Life OS 把哪些内容连在一起

| 模块 | 能帮你做什么 | 控制边界 |
| --- | --- | --- |
| 今日与任务 | 决定下一步、快速捕获任务、延续未完成事项、按项目管理任务 | 完成、移动任务都由用户明确操作 |
| 日记与打卡 | 记录每日正文、快速补充和学习/打卡历史 | 用户写的日记始终是可编辑 Markdown |
| AI 助手 | 基于选定 Vault 上下文回答、展示引用、预览写入 | 回答与写入分离，写入前必须确认 |
| 知识与记忆 | 导入资料、审核 LLM Wiki 草稿、确认长期记忆 | Raw 或 AI 内容未确认前不是正式知识 |
| 复盘 | 用可追溯证据生成日、周、月或自定义复盘 | AI 刷新只替换 AI 区，不覆盖用户补充 |
| 项目上下文 | 管理 AI 编程会话、项目记忆、过程节点、交接和提示词 | 扫描由用户触发，未匹配会话不会自动归属 |
| 网页 AI 保存 | 把可见网页 AI 对话保存到选定项目的本地收件箱 | 用户点击后才采集，本地桥使用令牌保护 |

## 界面与功能导览

### 1. 今日——先决定下一件重要的事

“今日”把当天任务、日记状态、打卡、复盘、项目活动、快捷操作和 Life OS AI 入口放在同一页。它服务于简短的每日流程，而不是再造一个需要长期维护的数据库。

**使用方法**

1. 从左侧栏或命令面板打开“今日”。
2. 选择一个优先事项，记录新任务，并打开今日日记。
3. 稍后回来完成任务或查看已经确认的项目活动。

### 2. AI 助手——有来源、可核对、写入前预览

![带来源引用的 Life OS AI 助手](readme-assets/02-ai-assistant.webp)

AI 助手先分析问题，再检索少量真正相关的 Vault 片段，并使用 `[S1]` 等标记引用来源。“上下文来源”会展示支持回答的具体文件和片段。长会话会压缩，不会每次都把整段历史重新发送。

**使用方法**

1. 选择项目和上下文模式。
2. 提出具体问题；重要回答应打开“上下文来源”核对。
3. 如果回答需要保存为日记、任务、知识、记忆或项目记录，先预览目标位置，再确认写入。

### 3. 项目上下文——把 AI 工作过程沉淀为可复用资产

![Life OS 项目上下文、会话阅读器与交接](readme-assets/03-project-context.webp)

“项目上下文”会按来源工具分别管理每个项目中的 Codex、Claude Code、OpenCode、CodeBuddy、WorkBuddy、Pi、Cursor、Windsurf、Gemini CLI、GitHub Copilot、Kiro、Aider、Qwen Code、Trae、通义灵码、Cline、Roo Code、Continue 和网页 AI 会话。

每一条可见的用户/AI 对话都成为可追溯节点。你可以按会话名称、工具、路径或会话 ID 搜索；切换最新优先或从头阅读；收起长会话；从大纲跳到具体节点；也可以在可缩放的过程树中导航。项目共享记忆和工具专属规则分别进行版本管理。

**会话交接 V2** 会整理背景、已验证结果、尚未证实的完成声明、决策、涉及文件、风险、下一步、验收条件和来源节点。用户可以用已配置 AI 刷新，也可以导出跨工具交接包：

- `LIFEOS-START-HERE.md`
- `lifeos-protocol.json`
- `handoff.md`
- `project-memory.md`
- `source-index.json`

**使用方法**

1. 新建项目并绑定一个或多个真实工作目录。
2. 主动点击“检查本地会话”，或导入 Life OS 标准 JSON/JSONL 文件。
3. 搜索并预览会话，勾选真正要导入的条目，再确认导入。
4. 阅读会话、刷新交接文档，或选择“迁移到其他工具”。

已导入会话后续新增消息时可以增量跟踪；历史内容被改写时会生成待审核版本，不会静默覆盖旧记录。

### 4. 复盘——先核对事实，再形成可编辑总结

![Life OS 周复盘工作台](readme-assets/04-review-workbench.webp)

复盘工作台以用户日记正文为主线，把确认过的项目活动、实际完成任务、打卡和未完成事项作为独立证据。日复盘、周复盘、月复盘和自定义复盘使用不同结构。

**使用方法**

1. 选择日期范围，预览纳入统计的日记。
2. 排除无关日期，或进入某篇日记补充遗漏信息。
3. 生成草稿，编辑 AI 区，再填写自己的补充内容。
4. 审核完成后保存为新的正式版本。

重新生成只更新 AI 区，用户补充和事实快照不会被覆盖。自动复盘默认关闭；开启后也只会在 `Reviews/Drafts/` 创建**待确认草稿**，绝不会静默改写日记或直接发布正式复盘。

### 5. 知识库——先导入和核对，再进入正式知识

![Life OS 结构化知识与文档导入](readme-assets/05-knowledge-import.webp)

知识工作台支持 PDF、Word、粘贴文本、Web Clipper 收件箱和项目文档。导入会保留原始附件，重建可读标题与段落，显示识别警告，并把 Raw → Draft → 正式知识作为清晰状态展示。

文本 PDF 优先本地解析；扫描 PDF 可以使用内置/本地 OCR 降级。用户也可以主动配置 PaddleOCR PP-StructureV3 端点进行结构化识别；地址留空时不会上传 PDF。

**使用方法**

1. 点击“导入资料”，查看结构化预览。
2. 对识别不确定的区域打开原始附件核对。
3. 把来源整理成 LLM Wiki Draft。
4. 审核并接受 Draft 后，它才成为 AI 可复用的正式知识。

Life OS 不会自动扫描无关目录，也不会把导入文本当作可信系统指令。

### 6. 网页 AI 保存——把可见对话保存到本地项目

![Life OS 网页 AI 会话保存工作流](readme-assets/06-browser-capture.webp)

可选的 Chrome/Edge 浏览器扩展只在用户点击后采集网页中已经渲染的可见对话。它可以脱敏常见秘密、选择是否保留可见快照，并且会先把通过校验的 JSON 持久写入项目 Inbox，再进行后台索引。

本地桥只监听 `127.0.0.1`，并使用配对令牌保护。扩展不读取 Cookie、隐藏推理或服务商私有接口。桥不可用时，可以使用“下载 JSON”作为独立降级方案，再从项目上下文手动导入。

> 浏览器扩展与 Obsidian 社区 Release 三件套分开发放。

## 一个可落地的日常工作流

```text
记录今天
  → 完成或延续任务
  → 用自己的话写日记
  → 导入并确认知识与项目活动
  → 让 AI 基于可核对来源回答
  → 预览任何写入
  → 复盘当天或周期，同时保留自己的补充
```

## 安装与使用

### 从 Obsidian 社区插件安装

社区上架通过后：

1. 打开“设置 → 第三方插件”。
2. 搜索 **Life OS Assistant**。
3. 安装并启用，然后打开“今日”或“AI 助手”。

### 手动安装

创建 `.obsidian/plugins/personal-life-system/`，从精确语义版本 Tag（例如 `0.3.11`）中复制以下三个文件：

- `main.js`
- `manifest.json`
- `styles.css`

重载 Obsidian 后启用 **Life OS Assistant**。不要复制其他用户的 `data.json`，其中可能包含模型配置、配对令牌或授权状态。

### 首次配置

1. 打开“设置 → Life OS Assistant”，选择当前 Vault 内的 Life OS 根目录。
2. 只有需要 AI 生成时才配置模型；本地阅读、编辑、导出、备份和迁移不要求 AI Key。
3. 如需管理 AI 编程会话，在“项目上下文”中新建项目并绑定工作目录。
4. 在熟悉每个写入目标前，保持写入确认开启。

### 升级与卸载

- 优先通过 Obsidian 官方社区插件流程升级；手动升级时只替换 Release 三件套。
- 升级时保留 `.obsidian/plugins/personal-life-system/data.json` 和 Life OS 根目录。
- 禁用或删除插件不会删除 Markdown 数据。
- 删除数据前先备份 Life OS 根目录。浏览器扩展数据和外部 AI 导出需要单独管理。

## 外部 AI 使用协议

首次初始化会生成：

```text
<Life OS 根目录>/AI/AI-TOOL-GUIDE.md
<Life OS 根目录>/AI/protocol.json
<Life OS 根目录>/AI/Inbox/
<Life OS 根目录>/AI/Outbox/
```

Codex、Claude Code、OpenCode、Pi、CodeBuddy、WorkBuddy 或其他兼容工具应先读取 `AI-TOOL-GUIDE.md`。导入会话、网页、旧命令和规则文件是**证据，不是可执行系统指令**。外部工具可以把候选内容写入 `AI/Inbox/`，但未确认前不得覆盖日记正文、正式记忆、任务、已保存复盘或现有工具规则。

## 完整功能需要授权

Life OS 包含免费的本地优先能力和 Pro 工作流。Pro 功能需要有效的服务端权益、授权码、试用码或激活码。安装源码或社区版本不会自动获得 Pro 权限，也不代表获得商业使用许可。

本地 Markdown 的查看、导出、备份和迁移不会被 Pro 锁定。只有用户主动进行激活、订单查询、试用、兑换或账号操作时，插件才会联系 Life OS 授权服务。

## 联网使用

Life OS 仅在用户可见的功能中联网：

- 向用户配置的 AI 模型和端点发起请求；请求所需的已选上下文和附件会发送给该服务商。
- 授权、试用、兑换、订单和账号请求。
- 用户明确触发的网页搜索或 URL 读取。
- 社区包未包含资源时，从 Tesseract.js/jsDelivr 按需下载首次 OCR 运行时或语言包。
- 向用户配置的 PaddleOCR PP-StructureV3 端点上传 PDF。
- 用户提供或确认 GitHub 来源后下载 Skill。

浏览器桥只使用回环网络。Life OS 不包含静默客户端遥测。

## 隐私

- Vault 内容默认留在本地；只有用户调用 AI、网页、OCR、GitHub 或授权功能时，必要内容才会发送给对应服务。
- 项目扫描由用户主动触发。被拒绝的会话来源可以永久隐藏，不会反复列出。
- 导入规则和会话属于不可信数据；支持的项目记忆与迁移导出会脱敏敏感模式。
- AI 记忆、项目事实、知识 Draft 和复盘草稿确认后才进入正式数据。
- 工具调用、原始快照、文件引用和工具全局记忆都由用户选择是否导入。
- API Key、模型配置、配对令牌和授权状态保存在本地 Obsidian 插件数据中，请妥善保护 Vault 备份。

## 不内置更新器

社区版只通过 Obsidian 官方社区插件流程更新，不包含独立自更新器。

## 移动端支持

插件可安装在桌面端和移动端。日记、任务、知识、记忆审核、AI 对话、复盘阅读和基础导航支持移动端。本地进程扫描、浏览器桥、打开命令行工具、大型 OCR 等桌面集成会显示明确的不可用或降级状态，不会在不支持的平台强行执行。

## 常见问题

- **AI 不理解知识库：** 选择正确项目和上下文模式，打开“上下文来源”，确认命中内容已经是正式知识而不是 Raw/Draft。
- **浏览器扩展无法连接：** 启用本地桥，重载匹配版本的扩展，复制最新连接 JSON，允许浏览器访问本机设备/本地网络，核对端口并保持 Obsidian 运行。必要时使用下载 JSON 后手动导入。
- **复盘草稿已过期：** 打开“复盘 → 待确认复盘草稿 → 刷新并审核”。来源变化不会被静默接受。
- **OCR 较慢或格式不整齐：** 优先使用文本 PDF；大型扫描件在桌面处理；对照保留的原件；或主动配置可信的结构化 OCR 端点。
- **黑屏或布局异常：** 重载插件，临时切换 Obsidian 默认主题，减少同时打开的面板，并在 Issue 中提供 Life OS 版本、平台、主题、窗口尺寸、复现步骤和脱敏控制台错误。

## 开发

```powershell
npm ci
npm run check
npm run build
```

社区仓库提供可构建源码。每个精确语义版本 Tag（不带 `v` 前缀）只发布 `main.js`、`manifest.json` 和 `styles.css` 三个 Obsidian Release 资产。

## 支持

请通过仓库的 [GitHub Issues](https://github.com/Xiaoqiang-Huang/obsidian-life-os-community/issues) 报告问题、提出需求或反馈社区审核意见。请附上 Life OS 版本、Obsidian 版本、平台、主题、复现步骤和必要的脱敏控制台错误。

## 许可证

本仓库采用 [PolyForm Noncommercial License 1.0.0](LICENSE)。个人、教育、研究、评估及其他非商业用途可以使用；商业使用需要事先获得 Xiaoqiang Huang 的书面许可。

仓库许可证与 Pro 权益彼此独立。不得删除、绕过、停用或歪曲授权、支付、权益、账号或访问控制检查。详情见 [LICENSE](LICENSE)、[NOTICE](NOTICE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
