# Changelog

## 0.3.17 - 2026-08-29

### Added

- Expanded the shared Life OS Agent to 38 built-in tools spanning tasks, diary, reviews, knowledge, memory, projects, reminders, web research, RAG, Skills, vision/OCR, and safe Vault file operations.
- Added capability discovery and persistent declarative tool recipes. When no one-to-one tool exists, the Agent can compose approved primitives into a reusable tool without generating or executing JavaScript, Shell, `eval`, or arbitrary code.
- Added durable Agent events, task memory, context compaction, scoped attachment lifecycles, and Skill routing so desktop and Weixin conversations can continue work without letting an old image or unrelated Skill dominate later turns.
- Added a prompt Studio for optimizing an existing prompt or generating a new one with optional Life OS context, selected documents, clarification questions, preview-before-apply, version creation, and undo.
- Added directory import for project and knowledge documents, plus compact knowledge document management, search, category navigation, source handling, and project writeback.

### Changed

- Agent execution now reveals observable steps only as they actually start and finish, while preserving private model reasoning. Missing capabilities are checked against the tool catalog before the Agent reports that an operation is unavailable.
- The task page now supports single-task editing/deletion, select-all, batch edit/complete/restore/delete, a persistent “show completed” preference, and stable in-place refresh instead of rebuilding the visible page from the top.
- Sidebar modules can be shown or hidden independently. The exam/check-in module is opt-in and supports civil-service, postgraduate, law, teacher, or custom study profiles instead of assuming every user is preparing for the civil-service exam.
- Knowledge, project-document, modal, and narrow-window layouts were compacted and aligned for clearer document scanning and consistent controls.

### Fixed

- Fixed task-page blank loading, scroll jumps after task mutations, visible flashing, misaligned action buttons, blocked batch editing, and overlapping multi-column task lists.
- Fixed “hide completed tasks” being mistaken for destructive file deletion. The Agent now changes only the task-view preference and leaves `done.md` and archived task history intact.
- Fixed stale knowledge-pending counts, directory-import gaps, overly sticky image references, modal close-button offsets, and several button-label contrast and overflow regressions across sibling pages.
- Hardened Agent writes so custom tools still obey read-only/full-access modes, confirmation policy, Pro gates, Life OS path boundaries, backups, and tamper validation across restarts.

### Validation

- Passed 656 plugin service and workflow tests, TypeScript checks, UI class/behavior/overflow guards, writeback-destination checks, Pro compatibility checks, and the production build.
- Passed an isolated Obsidian runtime smoke covering desktop/mobile views, task and project-document writes, knowledge, review, chat persistence, Markdown/LaTeX rendering, and button contrast.
- Verified community source export, privacy exclusions, forbidden-path/content scanning, and release artifact consistency before publication.

## 0.3.16 - 2026-08-26

### Added

- Added a shared Life OS Agent runtime for the desktop AI assistant and Weixin Bot, so both entry points use the same intent planning, installed Skills, project resolution, local RAG, web evidence checks, observable execution stages, and writeback tools.
- Added general multi-source web research with built-in search plus optional Tavily, Brave Search, and SearXNG backends. Search queries can be planned and recovered without vendor-specific answer patches, while unreadable or off-topic pages cannot support factual claims.
- Added automatic low-cost Life OS knowledge probing for substantive questions, Chinese/English project-directory support, project-memory resolution, richer task mutation, custom-range review, and durable multi-turn Weixin state.
- Added a non-mutating production Pro authorization-center matrix covering health, the public 299-yuan lifetime catalog, account/admin surfaces, authentication boundaries, missing-order isolation, validation failures, and CORS.

### Changed

- Weixin greetings and deterministic actions avoid unnecessary model calls; ordinary questions normally use one model call, while evidence, Skill, vision, or explicit constraint conflicts permit at most one bounded repair.
- Installed Skills can be selected naturally by name or alias without inheriting an unrelated desktop default. Project context is inferred only when the user actually refers to personal/project data instead of requiring an exact project name for ordinary questions.
- The current public lifetime plan remains `pro_299` at CNY 299 for five devices. `pro_198`, `pro_49`, and earlier monthly SKUs remain accepted only for historical purchaser compatibility.

### Fixed

- Fixed Pro purchase double-clicks and active pending orders creating duplicate payment orders.
- Fixed unfinished orders not resuming polling after the Pro authorization center or Obsidian was reopened. Pending order state is now validated before use, claim tokens cannot be reused for another order, and status updates are persisted after every successful poll.
- Fixed one transient authorization-service failure permanently stopping payment recovery. Automatic polling now retries a bounded number of times and malformed gateway responses produce an actionable error instead of a raw or ambiguous failure.
- Fixed general Weixin questions being polluted by an unrelated default project, follow-up web queries losing their subject, installed teacher Skills not being recognized, local evidence from Chinese project directories being skipped, and answers failing closed despite relevant project memory.
- Fixed the AI assistant history drawer, compact controls, button labels, and settings layout overflowing or becoming unreadable at narrower desktop widths.

### Validation

- Passed the complete plugin service/workflow suite, TypeScript checks, UI class/behavior/overflow guards, Pro purchaser-state compatibility guard, production build, payment-worker tests and type checking.
- Passed the 14-item non-mutating production authorization-center matrix against `https://license.lifeoskit.com`; no valid order, email code, redeem, activation, personal license, or purchaser data was used.
- Verified community source/release export, privacy exclusions, delivery synchronization, and Obsidian runtime opening of the Pro authorization center before publishing the release.

## 0.3.15 - 2026-08-24

### Fixed

- Fixed new payment orders failing with `Unknown product SKU` when the installed plugin and the authorization service published different Life OS product generations.
- The Pro authorization page now loads the service catalog before showing purchasable plans and revalidates the selected SKU, amount, duration, and device allowance immediately before order creation.
- If the service catalog changes while the page is open, Life OS refreshes the displayed plan and asks the user to confirm the new amount instead of silently creating a different order.
- Payment-service connection and catalog errors now have an explicit status and retry action instead of leaving a purchase button that is guaranteed to fail.

### Changed

- New lifetime Pro purchases use the `pro_299` SKU at CNY 299. The briefly published `pro_198` SKU and older `pro_49` SKU remain compatible for pending orders, licenses, redemption codes, and support workflows.
- The authorization service is now the single source of truth for purchasable Life OS products. Both deployed legacy catalogs and current catalogs are supported without hard-coded client prices.
- The version comparison page follows the same live catalog. The built-in guide no longer promises a stale fixed amount and directs users to the synchronized authorization center.
- Existing pending-order recovery, order polling, activation, entitlement verification, license backups, and purchaser state remain unchanged.

### Validation

- Reproduced the production mismatch, verified the live health and catalog endpoints, and confirmed that the new resolver selects the exact SKUs currently advertised by the service without creating another payment.
- Added regression coverage for legacy and current catalogs, unrelated-product filtering, invalid catalog data, service URL normalization, just-in-time product revalidation, and removal of hard-coded purchase prices.
- Passed 545 plugin service/workflow tests, UI class/behavior/overflow guards, Pro purchaser-state compatibility checks, production build, 66 payment-worker tests, and worker type checking.

## 0.3.14 - 2026-08-23

### Added

- Added durable per-conversation Weixin state for standalone follow-up queries, selected Skills, pending link-collection operations, and reusable local image references.
- Added a redacted inbound task queue with separate pending, processing, responded, delivered, and failed states. Interrupted work and generated-but-undelivered replies now recover after reconnect or plugin restart.
- Added an optional Weixin text-model setting. When the global default is a Vision/VL model, Life OS can select the exact corresponding text model from the configured provider while keeping image requests on the vision model.

### Changed

- Context-dependent requests such as “check the official site” are rewritten with the preceding user question before retrieval. Link collection can also continue across turns when the URL and destination are provided separately.
- Weixin images are stored as local Vault attachments and can be reused by a later Skill request or after restart. Durable state stores only Vault-relative references; signed CDN URLs, Data URLs, and embedded bytes are excluded.
- Natural Skill routing now recognizes spaced nicknames and follow-up wording, remembers the current conversation's explicit choice, and never inherits the desktop default Skill. Project context is included only when the current query is actually project-related.
- Reduced Weixin history and retrieval budgets, separated text and vision routing, and added answer checks for source support, selected-Skill adherence, cross-Skill leakage, and the user's latest constraints.

### Fixed

- Fixed web follow-ups that searched only the latest fragment and could turn “check the official site” into an unrelated dictionary query.
- Blocked factual claims based on sources marked unreadable, unavailable, body-missing, or pending content extraction; citation verification now covers both local and web evidence.
- Fixed authorized Weixin input failing to enter the daily journal when adapter writes to the former hidden digest-state file failed. Diary capture is now isolated from route-state errors, and the visible state file supports one-time legacy migration.
- Fixed natural references such as “how would Xiao P solve this?” falling back to large desktop Skills and mixing methods from different teachers.
- Fixed “read today's diary” and two-turn “save this link / save it under …” flows falling back to unrelated knowledge retrieval.
- Fixed inbound messages being acknowledged by the channel before they were durably recoverable, which could lose unfinished work after Obsidian restarted.

### Validation

- Added regression coverage for contextual query rewriting, source-availability guards, project relevance gating, spaced Skill aliases, durable image reuse, latest-image batching, two-turn link collection, visible daily state, idempotent inbound staging, restart replay, and staged-before-next-poll ordering.

## 0.3.13 - 2026-08-23

### Fixed

- Replaced manually created settings-page HTML headings with Obsidian's `Setting.setHeading()` API so the plugin follows the current community UI review rule.
- Preserved the compact settings-center hierarchy, spacing, theme colors, and dynamic module title after adopting the native heading structure.

### Validation

- Added a regression guard that rejects direct `h1`-`h6` creation in the settings tab and verifies both required native headings.

## 0.3.12 - 2026-08-23

### Added

- Added a plugin-native Weixin remote workbench with QR pairing, multiple isolated accounts, image understanding, per-message Skill routing, natural-language authorization, proactive replies, reminders, and remote access to diary, task, review, knowledge, link-collection, and daily-summary workflows. It connects directly to Weixin iLink and does not require a separate OpenClaw installation.
- Added controlled web grounding to the AI assistant. Users can choose automatic, search, URL-reading, or offline behavior, and every retrieved result remains independently inspectable and citable.
- Added local Skill file import plus compact Skill management: name on import, rename, edit, categorize, select, hide/restore bundled Skills, and remove imported Skills.
- Added a standalone Life OS settings center with a compact overview and module navigation instead of rendering the full configuration stack inside Obsidian's native settings modal.

### Changed

- Reorganized the AI assistant composer into one compact control row. Multi-option controls now use dropdowns, file attachment sits next to the send action, Chinese IME Enter is protected, and messages remain selectable and copyable.
- Replaced hidden chain-of-thought expectations with an observable execution trace that reports retrieval, tool, generation, and writeback stages without exposing private model reasoning.
- Made selection-based AI editing opt-in: selecting text no longer starts analysis automatically, and the user chooses whether to answer, explain, or edit.
- Expanded shared Markdown rendering so dynamic assistant and product text consistently supports tables, callouts, wiki links, code, and common LaTeX delimiters.
- Weixin conversations can contribute authorized natural-language input to the daily journal while preserving handwritten diary text and replacing only Life OS-managed summary blocks.

### Fixed

- Stabilized Weixin connectivity with upstream presence start/stop reconciliation, periodic presence refresh, bounded request timeouts, fast long-poll renewal, exponential reconnect, and idempotent outbound retries.
- AI reply generation no longer blocks the next Weixin `getupdates` request, preventing long responses from making the bot appear offline.
- Normal `UND_ERR_HEADERS_TIMEOUT` long-poll boundaries no longer enter the previous 30-second outage window.
- Fixed the AI assistant blank row that could appear while streaming, compact-toolbar overflow, settings-card misalignment, and several narrow-window layout regressions.
- Plugin and delivery upgrades continue to preserve both `data.json` and `weixin-state.json`; release packages never include purchaser data or saved Weixin credentials.

### Validation

- Passed 540 service and workflow tests, UI class/behavior/overflow guards, writeback and Pro-compatibility checks, a production build, isolated Obsidian runtime smoke tests, and upgrade-state preservation tests.

## 0.3.11 - 2026-08-12

### Fixed

- Fixed web AI capture requests that could remain on “Writing to local Life OS” indefinitely while automatic tracking parsed very large Codex, Claude Code, or other session files.
- Browser captures now validate and durably write the redacted JSON into the selected project Inbox before revision indexing, project-memory refresh, or daily activity analysis. The extension displays the exact saved path as soon as that write succeeds.
- Added bounded bridge and extension timeouts. A slow background index now returns an explicit queued receipt; a missing durable write returns a retry/download error instead of an endless spinner.
- Updated ChatGPT extraction for current `conversation-turn` pages, including a guarded ordered-turn fallback when role attributes are no longer exposed. One-sided captures are blocked from direct save to prevent incomplete sessions.
- Reduced repeated work on actively growing local session files and moved multi-gigabyte source parsing outside the shared mutation queue, so it cannot starve a browser capture's durable Inbox write.

### Delivery

- Updated the browser-extension manual and troubleshooting flow for “saved to Inbox, indexing in background”, single-sided capture detection, extension reload, and page refresh requirements.
- Synchronized plugin, optional browser extension, manuals, delivery vaults, and release metadata to 0.3.11.

## 0.3.10 - 2026-08-11

### Fixed

- Restored downloaded browser-conversation JSON import on current Obsidian/Electron versions by reading the selected `File` contents and staging them in the selected project's AI Workspace inbox instead of depending on the removed `File.path` field.
- Added clear validation for empty, oversized, malformed, and non-Life-OS web conversation exports before import preview.
- Updated the Chrome/Edge bridge request flow to declare the current `loopback` target address space and added compatible private-network preflight responses on the loopback server.
- Added a one-time bridge setup migration so existing installations no longer remain silently disabled by the earlier settings-normalization bug; users can still turn the bridge off afterwards.
- Improved bridge connection errors so users are told to allow the browser's local-device/local-network prompt rather than being left with a generic connection failure.

### Delivery

- Synchronized the optional browser extension version with the plugin. Product-distribution releases may provide its versioned `LifeOS-Web-AI-Capture` ZIP separately; the public Obsidian community repository and its releases remain limited to reviewable plugin source plus `main.js`, `manifest.json`, and `styles.css`.

## 0.3.9 - 2026-08-11

### Fixed

- Kept Obsidian `1.5.0` compatibility by replacing the newer `Workspace.revealLeaf` calls with the existing right-sidebar expansion and leaf activation flow.
- Moved AI edit popover positioning, selection highlights, and chat composer sizing from direct style assignments to CSS classes and runtime CSS custom properties without changing interaction behavior.
- Scoped Life OS modal sizing to plugin-owned modals so Obsidian's native settings page no longer gains blank right and bottom regions.
- Added community-review regression coverage for the declared minimum Obsidian version and DOM styling boundary.

## 0.3.8 - 2026-08-11

- Security: upgrade the PDF.js runtime to a release that fixes malicious-PDF script execution (GHSA-hq66-cqwq-w95j).

### Added

- AI Workspace support for additional coding tools and standard JSON/JSONL fallback imports.
- Browser AI capture through a token-protected local bridge with JSON fallback.
- Per-message traceable nodes, newest-first session reading, search, collapse, and a zoomable process-tree canvas.
- Handoff V2 with complete-node evidence compilation, verified/claimed/partial completion states, source citations, quality gates, local/embedded AI refresh, and cross-tool five-file migration packages.
- Versioned project shared memory and tool-specific rule snapshots.
- External AI interoperability files: `AI-TOOL-GUIDE.md`, `protocol.json`, `AI/Inbox/`, and `AI/Outbox/`.
- Evidence-based daily, weekly, monthly, and custom review structures.
- Optional scheduled review generation that creates pending drafts only.
- Hybrid knowledge retrieval, citation verification, adaptive context selection, and RAG evaluation support.
- Compact project-document list, structured PDF import, OCR fallbacks, and import warnings.

### Changed

- All review entry points now open the same source-selection and draft workflow.
- Diary text is the primary review narrative; confirmed project facts, completed tasks, check-ins, and open tasks remain separate evidence.
- Review regeneration replaces only the AI region and preserves user notes and fact snapshots.
- AI Workspace handoffs and project migration use read-only evidence packages instead of assuming the original tool can be resumed.
- The AI assistant layout, composer controls, context controls, citations, and long-conversation handling were simplified and made more responsive.

### Fixed

- Repeated quick capture headings and unsafe diary-region replacement.
- Duplicate automatic review calls, stale-source handling, and startup catch-up recovery after transient failures.
- Session import naming/search, unmatched selection, preview contrast, browser-bridge status, and long-list performance.
- Project document rendering, oversized rows, independent scrolling, and OCR paragraph collapse.
- Multiple narrow-window, dark-theme, modal overflow, button-label, and black-screen regressions.

### Safety and compatibility

- Automatic review remains off by default and never silently writes a formal review.
- External AI tools can only produce candidates unless the user confirms a formal destination.
- Community source builds remain mobile-installable; desktop-only integrations degrade with a clear message.
- Plugin upgrades preserve existing `data.json` and all user Markdown.

## 0.3.7

- Improved mobile modal behavior, AI editing, provider configuration, and community-release compatibility.

## 0.3.6

- Added the first community-ready Life OS workflow set and expanded local-first task, knowledge, memory, and review views.
