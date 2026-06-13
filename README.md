# Life OS Assistant

This README is bilingual. English is provided first for Obsidian Community review, followed by Simplified Chinese for Chinese-speaking users.

本 README 支持中英文双语阅读。前半部分为英文，方便 Obsidian 社区审核；后半部分为简体中文，方便中文用户安装和理解授权、隐私与联网边界。

## English

Life OS Assistant organizes diary entries, tasks, knowledge, memory, and AI-assisted reviews inside your Obsidian vault.

It is designed as a local-first personal operating system: you keep the markdown files, you choose the AI provider, and the plugin helps connect daily records, unfinished tasks, project progress, knowledge notes, and long-term memory.

## Features

- Diary and quick capture workflows for daily records.
- Task extraction, task carryover, and project-aware task views.
- Project overview cards with progress rings and unfinished task lists.
- Knowledge base workflows for source material, drafts, and reusable notes.
- Memory review workflows where AI suggestions wait for user confirmation.
- AI assistant that can use selected vault context, task context, project context, knowledge context, and explicit web context.
- Daily, weekly, monthly, and growth review dashboards.
- Multiple visual themes for light and dark Obsidian appearances.

## Payment is required for full access

Life OS includes free local-first features and Pro features. Pro activation is handled by the Life OS license service. The plugin stores license state locally in Obsidian plugin data and verifies server-issued entitlement tokens before unlocking Pro-only workflows.

The client-side source can be inspected, but paid access is not granted by local settings alone. A valid server-issued entitlement is required for normal Pro access.

Installing this community plugin from GitHub or Obsidian Community Plugins does not grant commercial-use permission and does not grant access to Pro-only features. Pro access requires a valid Life OS license key, trial code, activation code, or server-issued entitlement token.

## Account or license requirement

Some Pro workflows require a license key, email-based order lookup, trial code, or activation code. These checks contact the Life OS license service only when you use activation, order lookup, trial, redeem, or account-related Pro actions.

## Network use

Life OS can use remote services in these cases:

- AI requests are sent to the AI provider and endpoint configured by the user.
- License and payment status requests are sent to the Life OS license service.
- Web search or webpage reading runs only when the user explicitly asks Life OS to search the web or read a web URL.
- Scanned PDF OCR uses local OCR assets when they are available in the manual package. Official community installs may fetch Tesseract.js worker, core, and language data from the Tesseract.js/jsDelivr CDN the first time OCR is used.

Life OS does not include silent client-side telemetry.

## Privacy

Life OS is local-first. Vault content remains in your Obsidian vault unless you explicitly use an AI, web, or license feature that needs remote access.

When AI features are used, the selected context is sent to the AI provider configured by the user. When web features are used, the requested URL or search query is sent to the corresponding network service. When license features are used, license and account information needed for activation or order lookup is sent to the Life OS license service.

The plugin does not silently upload your vault.

## No built-in updater

The community edition is updated through Obsidian's official Community Plugins update flow. It does not ship a separate self-updater.

## Mobile support

The community edition can be installed on both Obsidian desktop and mobile (`isDesktopOnly: false`). Core local-first workflows such as diary, tasks, knowledge notes, memory review, and AI chat remain available on mobile.

Heavier workflows such as scanned PDF OCR, large attachment parsing, and multi-step batch organization may degrade with a clear notice on constrained devices. For the best experience with large files, finish those operations on desktop.

## Data model

Life OS stores user-facing content as markdown files inside the vault. Typical folders include diary entries, task lists, knowledge notes, memory candidates, reports, and review documents. The exact root folder can be configured in the plugin settings.

Plugin settings, model configuration, and license state are stored in Obsidian plugin data and should not be overwritten during upgrades.

## Installation for community review

1. Install the plugin from Obsidian Community Plugins after it is accepted.
2. Enable "Life OS Assistant" in Obsidian settings.
3. Open the Life OS Assistant view from the ribbon or command palette.
4. Configure your AI provider if you want to use AI workflows.
5. Activate Pro only if you need Pro-only workflows.

## Development

```powershell
npm install
npm run check
npm run build
```

Community readiness checks for this repository are run from the private source workspace:

```powershell
npm run export:community
npm run test:community-ready
```

## Release assets

Each Obsidian release should attach:

- `main.js`
- `manifest.json`
- `styles.css`

The release tag should match `manifest.json.version`.

## Support

For issues, feature requests, and community-plugin review feedback, use the GitHub issue tracker for the public community repository.

## License

This repository is distributed under the PolyForm Noncommercial License 1.0.0 (`PolyForm-Noncommercial-1.0.0`). Personal, educational, research, evaluation, and other noncommercial use is allowed under the license.

Commercial use is not allowed unless Xiaoqiang Huang gives prior written permission. Commercial use includes resale, sublicensing, paid redistribution, SaaS wrapping, consulting delivery, agency delivery, company-internal commercial deployment, or bundling Life OS into any paid product, service, course, template, or workflow.

The repository license is separate from Pro feature access. You may inspect the client-side source, but you may not remove, bypass, disable, or misrepresent Life OS license checks, payment checks, entitlement checks, account checks, or access-control mechanisms.

See [`LICENSE`](LICENSE) for the license text, [`NOTICE`](NOTICE) for Life OS-specific copyright, commercial-permission, and Pro-access notices, and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for bundled AI skill and runtime dependency notices.

## 简体中文

Life OS Assistant 是一个本地优先的个人生活系统插件，用来整理日记、任务、知识库、长期记忆和 AI 辅助复盘。

它的定位不是把你的资料搬到另一个平台，而是在你的 Obsidian 仓库里，把日常记录、未完成任务、项目进度、知识资料和长期记忆连接起来。

### 主要功能

- 日记与快速记录工作流。
- 任务提取、任务延续和按项目查看任务。
- 项目总览卡片，支持进度圆环和未完成任务列表。
- 知识库工作流，用来保存资料、草稿和可复用笔记。
- 记忆审核工作流，AI 提出的记忆候选需要用户确认后才会沉淀。
- AI 助手可以结合用户选择的仓库上下文、任务上下文、项目上下文、知识库上下文和明确请求的网页上下文。
- 日复盘、周复盘、月复盘和成长看板。
- 多套视觉主题，兼容明亮和夜间外观。

### 完整功能需要授权

Life OS 包含免费的本地优先功能，也包含 Pro 功能。Pro 激活由 Life OS 授权服务处理。插件会把授权状态保存在本地插件数据中，并验证授权服务签发的权益令牌后再解锁 Pro 功能。

前端源码可以被查看，但正常情况下不能只靠修改本地设置获得 Pro 权限。Pro 权限需要有效的 Life OS 授权码、试用码、激活码或服务端签发的权益令牌。

从 GitHub 或 Obsidian 社区插件市场安装本插件，并不代表获得商业使用许可，也不代表获得 Pro 功能权限。Pro 功能仍需要有效的 Life OS 授权。

### 账号或授权要求

部分 Pro 工作流需要授权码、邮箱订单查询、试用码或兑换码。只有当你主动进行激活、订单查询、试用、兑换或账号相关操作时，插件才会连接 Life OS 授权服务。

### 联网使用说明

Life OS 只会在这些场景联网：

- 用户使用 AI 功能时，请求会发送到用户配置的 AI 服务商和接口地址。
- 用户激活、查询订单、试用或兑换授权时，请求会发送到 Life OS 授权服务。
- 用户明确要求搜索网页或读取网页链接时，插件才会访问对应网页或搜索服务。
- 扫描版 PDF OCR 会优先使用手动交付包内置的本地 OCR 资产；通过官方社区市场三件套安装时，首次使用 OCR 可能会从 Tesseract.js/jsDelivr CDN 获取 worker、core 和语言数据。

Life OS 不包含静默的客户端遥测。

### 隐私说明

Life OS 是本地优先插件。仓库内容默认留在你的本地仓库中。

当你使用 AI 功能时，用户选择的上下文会发送给你配置的 AI 服务商。当你使用网页功能时，请求的链接或搜索词会发送到对应网络服务。当你使用授权功能时，激活或订单查询所需的信息会发送到 Life OS 授权服务。

插件不会静默上传你的整个仓库。

### 不内置更新器

社区版通过 Obsidian 官方社区插件更新流程更新，不内置单独的一键自更新器。

### 移动端支持

社区版可在 Obsidian 桌面端和移动端安装（`isDesktopOnly: false`）。日记、任务、知识笔记、记忆复核和 AI 对话等本地优先核心流程会在移动端保留。

扫描版 PDF OCR、大附件解析、多步骤批量整理等重型流程可能会在设备资源不足时给出明确降级提示。处理大文件时，建议在桌面端完成。

### 数据模型

Life OS 面向用户的内容会保存为仓库中的 Markdown 文件，包括日记、任务、知识笔记、记忆候选、复盘报告等。具体根目录可以在插件设置里配置。

插件设置、模型配置和授权状态保存在本地插件数据中，升级插件代码时不应该覆盖这些用户状态。

### 安装与使用

1. 插件通过 Obsidian 社区插件市场审核后，在社区插件中安装。
2. 在设置中启用 Life OS Assistant。
3. 通过左侧图标或命令面板打开 Life OS Assistant。
4. 如需 AI 功能，在设置中配置你的 AI 服务商。
5. 如需 Pro 功能，再进行授权激活。

### 开发命令

```powershell
npm install
npm run check
npm run build
```

社区发布前，在私有源码工作区运行：

```powershell
npm run export:community
npm run test:community-ready
```

### Release 文件

每次插件发布需要上传：

- `main.js`
- `manifest.json`
- `styles.css`

发布 tag 应与 `manifest.json.version` 一致。

### 许可证

本仓库使用 PolyForm Noncommercial License 1.0.0（`PolyForm-Noncommercial-1.0.0`）。个人、教育、研究、评估和其他非商业用途允许使用。

未获得 Xiaoqiang Huang 的事先书面许可，不允许商业使用。商业使用包括但不限于转售、再授权、付费再分发、SaaS 包装、咨询交付、代理交付、公司内部商业部署，或把 Life OS 打包进任何付费产品、服务、课程、模板或工作流。

仓库许可证和 Pro 功能权限是两件事。你可以查看客户端源码，但不得移除、绕过、禁用或误导 Life OS 的授权检查、支付检查、权益检查、账号检查或访问控制机制。

完整许可证见 [`LICENSE`](LICENSE)，Life OS 相关版权、商业许可和 Pro 访问说明见 [`NOTICE`](NOTICE)。
