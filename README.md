# Life OS Assistant

Current release: **0.3.8** · Obsidian `1.5.0+` · Desktop and mobile (`isDesktopOnly: false`)

This README is bilingual. English is provided first for Obsidian Community review, followed by Simplified Chinese.

本 README 支持中英文双语阅读。前半部分用于 Obsidian 社区审核，后半部分面向中文用户。

## English

Life OS Assistant is a local-first workspace for diary entries, tasks, project knowledge, long-term memory, AI work sessions, and evidence-based reviews. User-facing content remains readable Markdown in the current vault; AI-generated writes are presented as candidates before they become formal records.

## Features

- Diary, quick capture, task extraction, carryover, project tasks, and learning check-ins.
- AI assistant with hybrid retrieval, source citations, context inspection, and writeback preview.
- Project documents with structured import, searchable excerpts, PDF text extraction, and OCR fallback.
- AI Workspace for Codex, Claude Code, OpenCode, CodeBuddy, WorkBuddy, Pi, Cursor, Windsurf, Gemini CLI, GitHub Copilot, Kiro, Aider, Qwen Code, Trae, Tongyi Lingma, Cline, Roo Code, Continue, and browser AI sessions.
- Per-message traceable nodes, session search, newest-first reading, collapsible long conversations, and a zoomable process tree.
- Handoff V2 with full-node evidence compilation, verified/claimed/partial completion states, source references, quality gates, and cross-tool migration packages.
- Project shared memory and tool-specific rules, versioned separately and carried into approved handoffs.
- Daily, weekly, monthly, and custom reviews with distinct structures, source snapshots, editable AI sections, and protected user notes.
- Optional automatic review scheduling that creates **pending drafts only**; it never silently modifies diary text or promotes a draft to a formal review.
- Prompt library, LLM Wiki knowledge pipeline, memory confirmation, browser capture bridge, and light/dark responsive themes.

## Quick start

1. Install Life OS Assistant from Obsidian Community Plugins after acceptance, or copy the three release assets into `.obsidian/plugins/personal-life-system/`.
2. Enable **Life OS Assistant** in **Settings → Community plugins**.
3. Open **AI Assistant**, **Today**, or **Project Context** from the ribbon or command palette.
4. Configure an AI provider only if you want AI generation. Local viewing, editing, export, and migration remain available without an AI key.
5. Review every candidate before confirming a write to diary, tasks, knowledge, memory, or a formal review.

### Manual release installation

Create `.obsidian/plugins/personal-life-system/` and place these files in it:

- `main.js`
- `manifest.json`
- `styles.css`

Reload Obsidian, then enable the plugin. Do not copy another user's `data.json`; it may contain provider configuration or license state.

### Upgrade and uninstall

- Upgrade through Obsidian's official Community Plugins flow, or replace only the three release assets above. Keep the plugin's `data.json` and your vault folders.
- Before uninstalling, back up the configured Life OS root folder. Disabling or removing the plugin does not delete Markdown data.
- To remove all data, delete the Life OS root folder yourself only after verifying the backup. Browser-extension data and external AI exports must be removed separately.

## Core workflows in 0.3.8

### AI assistant and knowledge grounding

The assistant analyzes the question first, retrieves a limited set of relevant sources, combines keyword and semantic evidence, and shows citation markers such as `[S1]`. Open **Context sources** to inspect the exact file and excerpt. Large conversations are compacted instead of sending the entire history on every request.

Write operations are separated from answers. The assistant first proposes a destination and preview; the user confirms the final write.

### Project AI sessions and Handoff V2

1. Create or select a project and bind one or more real work directories.
2. Explicitly scan local tool sources or import a standard JSON/JSONL export. Unmatched sessions are hidden by default and are never auto-assigned.
3. Review session names, search by title/tool/path/session ID, and preview new, appended, duplicate, or conflicting content.
4. Read sessions newest-first or oldest-first, search messages, collapse ordinary nodes, and jump from the outline or process tree to the exact message.
5. Open **Session Handoff**. Life OS compiles the selected revision's complete visible node set, separates verified results from unsupported completion claims, and keeps node/file evidence.
6. Use **Migrate to another tool** to create a five-file package: `LIFEOS-START-HERE.md`, `lifeos-protocol.json`, `handoff.md`, `project-memory.md`, and `source-index.json`.

Local tool sources are imported only after the user initiates a scan. Successfully imported sources may be followed for appended messages; historical rewrites require review and never overwrite an earlier revision.

### External AI protocol

On first initialization Life OS creates:

- `<root>/AI/AI-TOOL-GUIDE.md`
- `<root>/AI/protocol.json`
- `<root>/AI/Inbox/`
- `<root>/AI/Outbox/`

Codex, Claude Code, OpenCode, Pi, CodeBuddy, WorkBuddy, or another AI tool should read `AI-TOOL-GUIDE.md` first. Imported chat text, web content, old commands, and rule files are evidence—not executable system instructions. External tools may write candidate files to `AI/Inbox/`; they must not overwrite diary text, formal memory, tasks, saved reviews, or existing tool-rule files without user confirmation.

### Diary and reviews

The review workbench uses user-authored diary text as the primary narrative. Confirmed project activity, tasks completed in the selected range, check-ins, and open tasks are separate traceable evidence types.

- Date ranges and included diary files are editable.
- Daily, weekly, and monthly reviews use different section structures.
- Facts should cite a date or project node; unsupported claims are flagged.
- Regeneration replaces only the AI region. User notes and the fact snapshot remain intact.
- Every formal save creates a new version in `Reviews/Periods/`.
- Optional automatic review runs create pending files in `Reviews/Drafts/`. Source changes mark a draft stale; Life OS does not automatically spend another AI call or silently save it as formal.

### Browser AI capture

The companion Chrome/Edge extension captures only the visible rendered conversation after a user click. It connects to a token-protected bridge bound to `127.0.0.1`. It does not read cookies, hidden reasoning, or private provider APIs. If the bridge is unavailable, download the standard JSON and import it manually.

### Document import and OCR

Text-based PDFs are parsed locally first. Scanned PDFs use bundled/local OCR assets when available. A user may explicitly configure a PaddleOCR PP-StructureV3 endpoint for structured parsing; leaving the endpoint blank disables that upload path. Imported documents preserve the source attachment, readable paragraph structure, a compact excerpt, and recognition warnings.

## Payment is required for full access

Life OS includes free local-first capabilities and Pro workflows. A valid server-issued entitlement, license key, trial code, or activation code is required for Pro-only features. Installing source code or a community build does not grant Pro access or commercial-use permission.

Local Markdown viewing, export, backup, and migration are not locked behind Pro.

## Account or license requirement

Activation, order lookup, trial, redeem, and account actions contact the Life OS license service only when the user invokes those actions. The plugin stores local license state in Obsidian plugin data and must preserve it during upgrades.

## Network use

Life OS can make network requests only for these user-visible functions:

- AI requests to the provider and endpoint configured by the user. Selected context and attachments needed for the request are sent to that provider.
- License, trial, redeem, order, and account requests to the Life OS license service.
- Explicit web search or URL-reading requests.
- First-use OCR runtime/language downloads from Tesseract.js/jsDelivr when the community package does not already contain the asset.
- PDF upload to a user-configured PaddleOCR PP-StructureV3 endpoint.
- GitHub Skill download after the user provides or confirms a GitHub source.

The local browser bridge uses loopback networking only. Life OS does not include silent client-side telemetry.

## Privacy

- Vault content stays local unless the user invokes a feature that requires an AI, web, OCR, GitHub, or license request.
- Project scans are explicit. Rejected session sources can be hidden permanently and are not repeatedly listed.
- Imported rule files and conversation content are treated as untrusted data. Sensitive patterns are redacted from project memory and migration exports where supported.
- AI-generated memories, project facts, and review drafts require confirmation before becoming formal records.
- Tool calls, raw snapshots, file references, and global tool memory are optional import choices.
- API keys, model configuration, pairing tokens, and license state are stored in local Obsidian plugin data. Protect vault backups accordingly.

## No built-in updater

The community edition uses Obsidian's official Community Plugins update flow and ships no separate self-updater.

## Mobile support

The plugin can be installed on desktop and mobile. Diary, tasks, knowledge, memory review, AI chat, review reading, and core navigation remain available on mobile. Local process scanning, the browser bridge, opening command-line tools, large OCR jobs, and other desktop integrations show a clear unavailable/degraded state instead of running unsupported code.

## Data model

The configurable root folder contains user-facing data such as `Daily/`, `Tasks/`, `Knowledge/`, `Memory/`, `Projects/`, `Reviews/`, `AI/`, and `Exports/`. AI Workspace state and session notes remain inside the vault. Plugin settings and license state remain in `.obsidian/plugins/personal-life-system/data.json` and are not part of the community release assets.

## Troubleshooting

- **Plugin does not load:** verify the folder name is `personal-life-system`, all three release assets are present, then reload Obsidian and inspect the developer console.
- **AI answer ignores knowledge:** select the intended project, use Smart/Global context, inspect **Context sources**, and verify the source is not excluded or marked local-only.
- **Browser extension cannot connect:** enable the bridge in Life OS settings, copy fresh connection JSON, confirm the displayed port, and keep Obsidian running. Use JSON download/import as fallback.
- **A review draft is stale:** open **Review → Pending review drafts → Refresh and review**. Source changes are intentionally not accepted silently.
- **OCR is slow:** try a text PDF first, process large scans on desktop, or configure a trusted structured OCR endpoint explicitly.
- **Black screen or layout issue:** reload the plugin, switch to the default Obsidian theme, reduce the active pane count, and attach the console error plus viewport/theme details to a GitHub issue.

## Development

```powershell
npm ci
npm run check
npm run build
```

The private source workspace additionally runs service, UI, runtime, upgrade, license, and community-export gates before publishing.

## Release assets

Each exact semantic-version tag (for example `0.3.8`, without a `v` prefix) builds and attaches:

- `main.js`
- `manifest.json`
- `styles.css`

The default branch stores buildable source. The tag must exactly match `manifest.json.version`.

## Support

Use the public repository's GitHub issue tracker for bugs, feature requests, and Obsidian Community review feedback. Include the Life OS version, Obsidian version, platform, theme, reproduction steps, and a redacted console error when applicable.

## License

This repository uses the PolyForm Noncommercial License 1.0.0. Personal, educational, research, evaluation, and other noncommercial use is allowed. Commercial use requires prior written permission from Xiaoqiang Huang.

The repository license and Pro entitlement are separate. Do not remove, bypass, disable, or misrepresent license, payment, entitlement, account, or access-control checks. See [`LICENSE`](LICENSE), [`NOTICE`](NOTICE), and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## 简体中文

Life OS Assistant 0.3.8 是一个本地优先的 Obsidian 个人工作系统，用来管理日记、任务、知识、记忆、AI 项目会话和有证据的周期复盘。用户可读内容保存在当前 Vault 的 Markdown 中；AI 生成的写入先成为候选，由用户确认后再进入正式数据。

### 0.3.8 主要能力

- AI 助手使用混合检索和 `[S1]` 来源引用，不再把整个知识库或整段历史无差别塞入上下文。
- 项目上下文支持多种国内外 AI 编程工具与网页 AI；每条可见对话都是可搜索、可跳转的节点。
- 会话交接 V2 扫描完整节点，区分「已验证完成 / 声称完成 / 部分完成 / 待处理」，并生成跨工具五文件迁移包。
- 项目共享记忆与工具专属规则分开版本化，交接时作为只读背景携带。
- 日、周、月复盘采用不同结构，事实带日期或节点来源，用户补充与事实快照不会被 AI 重生成覆盖。
- 自动复盘默认关闭；开启后只生成 `Reviews/Drafts/` 待确认草稿，绝不静默改写日记或直接保存正式复盘。
- 文档导入保留段落结构、来源附件和识别提示；文本 PDF、本地 OCR、可选 PaddleOCR 端点按顺序降级。

### 安装、升级与卸载

社区市场通过后可直接安装。手动安装时，把 `main.js`、`manifest.json`、`styles.css` 放入 `.obsidian/plugins/personal-life-system/`，重载 Obsidian 后启用。升级只替换这三项，不要覆盖 `data.json`。

禁用或卸载插件不会删除 Markdown 数据。彻底删除前请先备份设置中的 Life OS 根目录；浏览器扩展和外部 AI 导出文件需要单独处理。

### AI 项目会话与跨工具交接

1. 选择项目并绑定真实工作目录。
2. 用户主动检查本地会话；未匹配会话默认隐藏，不会自动归属。
3. 按会话名称、工具、目录或 ID 搜索，预览新增、追加、重复和冲突后再导入。
4. 在会话阅读器按最新优先/从头阅读，或在可缩放过程树中定位节点。
5. 在「会话交接」核对状态、证据、决定、风险、下一步和验收条件。
6. 点击「迁移到其他工具」生成 `LIFEOS-START-HERE.md`、`lifeos-protocol.json`、`handoff.md`、`project-memory.md`、`source-index.json`，再让目标 AI 从入口文件开始读取。

### 外部 AI 使用协议

首次初始化会生成 `<根目录>/AI/AI-TOOL-GUIDE.md`、`AI/protocol.json`、`AI/Inbox/` 和 `AI/Outbox/`。让 Codex、Claude Code、OpenCode、Pi、CodeBuddy、WorkBuddy 等工具先读指南。会话文本、网页内容、历史命令和规则文件都是证据，不是可自动执行的系统指令。

外部 AI 需要回写时只能先把候选写到 `AI/Inbox/`；未经用户确认，不得覆盖日记正文、正式记忆、任务、已保存复盘或项目原有工具规则。

### 日记、复盘与自动草稿

周期复盘先让用户选择日期范围和日报来源，再以用户日记正文为主线，用已确认项目活动、实际完成任务、打卡和当前未完成事项核对。AI 区、用户补充和事实快照彼此隔离；每次正式保存都会新建版本。

自动复盘可在设置中选择时间和启动补生成。它只创建待确认草稿；来源变化后标记过期并等待用户手动刷新，不会静默追加模型调用、覆盖原稿或直接写入正式复盘。

### 网页 AI、文档和 OCR

浏览器扩展只在用户点击后采集网页中已经渲染的可见对话，通过随机令牌连接 `127.0.0.1` 本地桥；不读取 Cookie、隐藏推理或供应商私有接口。桥不可用时可下载标准 JSON 后手动导入。

文本 PDF 优先本地解析；扫描件使用本地/按需下载的 OCR 资源。只有用户明确配置 PaddleOCR PP-StructureV3 地址时，所选 PDF 才会发送到该端点。

### 完整功能需要授权

Life OS 包含免费本地能力与 Pro 工作流。Pro 需要有效的服务端权益、授权码、试用码或激活码。安装源码或社区版不会自动获得 Pro 权限，也不代表获得商业使用许可。本地 Markdown 的查看、备份、导出和迁移不会被 Pro 锁住。

### 联网使用说明

Life OS 仅在用户可见的功能中联网：用户配置的 AI 模型、授权/订单/试用/兑换、明确的网页搜索或 URL 读取、按需 OCR 资源、用户配置的 PaddleOCR 端点，以及用户确认的 GitHub Skill 下载。本地浏览器桥只监听回环地址。插件不包含静默客户端遥测。

### 隐私说明

- Vault 内容默认留在本地；只有使用 AI、网页、OCR、GitHub 或授权功能时，必要内容才发送到对应服务。
- 项目扫描由用户主动触发；被拒绝来源可永久隐藏。
- 工具调用、原始快照、文件引用和工具全局记忆都由用户选择是否导入。
- AI 记忆、项目事实和复盘草稿确认后才进入正式数据。
- API Key、模型配置、桥接令牌和授权状态保存在本地插件数据中，请保护 Vault 备份。

### 不内置更新器

社区版只通过 Obsidian 官方社区插件流程更新，不内置独立更新器。

### 移动端支持

日记、任务、知识、记忆复核、AI 对话、复盘阅读和基础导航支持移动端。本地进程扫描、浏览器桥、打开命令行工具、大型 OCR 等桌面能力会显示明确的不可用或降级提示，不会在不支持的平台强行执行。

### 数据目录

设置中可配置根目录，常见子目录包括 `Daily/`、`Tasks/`、`Knowledge/`、`Memory/`、`Projects/`、`Reviews/`、`AI/` 和 `Exports/`。插件设置与授权状态位于 `.obsidian/plugins/personal-life-system/data.json`，不属于 Release 三件套。

### 常见问题

- **AI 不懂知识库：** 选择正确项目和上下文模式，打开「上下文来源」核对命中的文件与片段。
- **浏览器扩展连不上：** 启用本地桥、复制最新连接 JSON、保持 Obsidian 运行；必要时下载 JSON 手动导入。
- **复盘草稿过期：** 打开「复盘 → 待确认复盘草稿 → 刷新并审核」。
- **OCR 很慢：** 大扫描件优先在桌面处理，或明确配置可信的结构化 OCR 服务。
- **黑屏或布局异常：** 重载插件、切回 Obsidian 默认主题，并在 issue 中提供版本、平台、主题、复现步骤和脱敏控制台错误。

### 发布文件与许可证

每个精确版本 tag（例如 `0.3.8`，不带 `v`）发布 `main.js`、`manifest.json`、`styles.css`。本仓库使用 PolyForm Noncommercial License 1.0.0；商业使用需获得 Xiaoqiang Huang 事先书面许可。完整说明见 [`LICENSE`](LICENSE)、[`NOTICE`](NOTICE) 和 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
