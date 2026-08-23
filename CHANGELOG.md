# Changelog

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
