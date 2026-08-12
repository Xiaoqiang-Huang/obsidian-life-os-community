# Changelog

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
