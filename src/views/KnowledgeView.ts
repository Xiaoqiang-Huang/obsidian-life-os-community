import { App, ItemView, Modal, Notice, TFile, TFolder, WorkspaceLeaf, setIcon } from "obsidian";
import { createButton } from "../components/Button";
import { createCard } from "../components/Card";
import { createEmptyState } from "../components/EmptyState";
import { createHeroHeader } from "../components/HeroHeader";
import { createLifeOSShell } from "../components/LifeOSComponent";
import { createModalShell } from "../components/ModalShell";
import { KNOWLEDGE_VIEW_TYPE } from "../constants";
import { requireProFeature } from "../licensing/entitlement";
import type PersonalLifeSystemPlugin from "../main";
import { DisplayFormatService } from "../services/DisplayFormatService";
import { FileSystemService } from "../services/FileSystemService";
import { LlmWikiBatchService } from "../services/LlmWikiBatchService";
import { LlmWikiCompilerService, type CompileLlmWikiSourceInput } from "../services/LlmWikiCompilerService";
import { LlmWikiDraftService } from "../services/LlmWikiDraftService";
import { LlmWikiPathService } from "../services/LlmWikiPathService";
import { LlmWikiUndoService } from "../services/LlmWikiUndoService";
import { classifyLlmWikiMaterialLength, type LlmWikiCompileDepth, type LlmWikiPrivacyLevel } from "../services/llm-wiki-logic";
import { today } from "../utils/dates";
import { renderMarkdownDisplay } from "../utils/markdown-render";
import { ensureFile } from "../utils/vault";
import { openWritebackPreview, type WritebackItem } from "../writeback-preview";

type KnowledgeLibraryKind = "raw" | "draft" | "formal" | "manual";
type KnowledgeCaptureKind = "raw" | "materials" | "books" | "mistakes";
type KnowledgePrivacyChoice = "normal" | "private" | "sensitive";

interface KnowledgeLibraryItem {
  file: TFile;
  kind: KnowledgeLibraryKind;
  title: string;
  subtitle: string;
  badge: string;
  snippet: string;
}

interface KnowledgeCaptureInput {
  title: string;
  kind: KnowledgeCaptureKind;
  privacy: KnowledgePrivacyChoice;
  content: string;
}

interface DirectoryIndexOptions {
  excludeFolders?: string[];
}

const DIRECTORY_INDEX_START = "<!-- lifeos-directory-index:start -->";
const DIRECTORY_INDEX_END = "<!-- lifeos-directory-index:end -->";
const KNOWLEDGE_LIBRARY_COLLAPSED_LIMIT = 6;
const KNOWLEDGE_PENDING_COLLAPSED_LIMIT = 3;
const KNOWLEDGE_RECENT_COLLAPSED_LIMIT = 4;

export class KnowledgeView extends ItemView {
  private expandedKnowledgeSections = new Set<string>();

  constructor(leaf: WorkspaceLeaf, private plugin: PersonalLifeSystemPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return KNOWLEDGE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "知识库";
  }

  async onOpen(): Promise<void> {
    await this.render();
    this.registerEvent(this.app.vault.on("create", () => void this.render()));
    this.registerEvent(this.app.vault.on("modify", () => void this.render()));
  }

  private async render(): Promise<void> {
    await this.plugin.ensureBaseStructure();
    const container = this.containerEl.children[1];
    container.empty();
    const main = createLifeOSShell(container as HTMLElement, this.plugin, "knowledge");
    main.addClass("lifeos-knowledge-main");
    const fs = new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);

    createHeroHeader(main, {
      kicker: "知识库",
      title: "把资料整理成可复用的知识",
      description: "学习资料、读书笔记和错题知识点都可以先放在这里，再逐步连接到任务和复盘。",
      icon: "library",
      actions: [
        { label: "新增资料", icon: "file-plus-2", primary: true, onClick: () => void this.openNewKnowledgeSourceModal(fs) },
        { label: "新建知识笔记", icon: "plus", onClick: () => void this.createKnowledgeNote(fs) },
        { label: "打开知识库目录", icon: "file-text", onClick: () => void this.openIndex(fs) }
      ]
    });

    await this.renderKnowledgeWorkspace(main, fs);
    await this.renderLlmWikiPanel(main, fs);

    const entries = main.createDiv({ cls: "lifeos-knowledge-entry-grid" });
    this.entryCard(entries, "学习资料", "保存课程、资料和参考链接。", "folder-open", () => void this.openFolderIndex(fs, "Materials", "学习资料"));
    this.entryCard(entries, "读书笔记", "整理书摘、观点和启发。", "book-open", () => void this.openFolderIndex(fs, "Books", "读书笔记"));
    this.entryCard(entries, "错题知识点", "沉淀易错点和解题方法。", "graduation-cap", () => void this.openFolderIndex(fs, "Mistakes", "错题知识点"));
    await this.renderRecent(main, fs);
  }

  private async renderLlmWikiPanel(parent: HTMLElement, fs: FileSystemService): Promise<void> {
    const layout = parent.createDiv({ cls: "lifeos-llmwiki-layout" });
    const summaryColumn = layout.createDiv({ cls: "lifeos-llmwiki-summary-stack" });
    const reviewColumn = layout.createDiv({ cls: "lifeos-llmwiki-review-stack" });

    const card = createCard(summaryColumn, "lifeos-panel lifeos-llmwiki-panel");
    const head = card.createDiv({ cls: "lifeos-card-title" });
    setIcon(head.createSpan(), "brain-circuit");
    head.createSpan({ text: "LLM Wiki 待整理" });
    card.createEl("p", {
      text: "这里汇总主动保存到 LLM Wiki 的资料，短资料可批量整理，长资料先暂存等待你选择整理方式。"
    });
    if (!this.ensureLlmWikiEnabled(false)) {
      card.createEl("p", {
        cls: "lifeos-pro-warning",
        text: "LLM Wiki 已在设置中关闭。资料查看仍可用，AI 整理、草稿合并和写入需要先到设置中开启。"
      });
    }

    const stats = card.createDiv({ cls: "lifeos-llmwiki-stats" });
    this.llmWikiStat(stats, "Raw Inbox", this.countFiles(fs.path("Knowledge", "LLMWiki", "Raw", "Inbox")));
    this.llmWikiStat(stats, "Drafts", this.countFiles(fs.path("Knowledge", "LLMWiki", "Wiki", "Drafts")));
    this.llmWikiStat(stats, "长资料待整理", this.countLongSources(fs.path("Knowledge", "LLMWiki", "Raw", "Inbox")));
    this.llmWikiStat(stats, "批次记录", this.countFiles(fs.path("Knowledge", "LLMWiki", "Wiki", "Batches")));

    const actions = card.createDiv({ cls: "lifeos-llmwiki-actions" });
    const organizeShortButton = createButton(actions, "整理短资料", () => {
      void this.organizeShortLlmWikiSources();
    }, { primary: true, icon: "sparkles" });
    organizeShortButton.disabled = !this.ensureLlmWikiEnabled(false);
    if (organizeShortButton.disabled) organizeShortButton.title = "LLM Wiki 已在设置中关闭";
    createButton(actions, "打开草稿索引", () => {
      void this.openFolderIndex(fs, "LLMWiki/Wiki/Drafts", "LLM Wiki Drafts");
    }, { icon: "file-text" });
    createButton(actions, "打开 Raw Inbox 索引", () => {
      void this.openFolderIndex(fs, "LLMWiki/Raw/Inbox", "LLM Wiki Raw Inbox");
    }, { icon: "archive" });

    this.renderLlmWikiDuplicateReviewCard(reviewColumn);
    await this.renderLlmWikiDraftCards(reviewColumn, fs);
    await this.renderLlmWikiLongSourceCards(reviewColumn, fs);
  }

  private renderLlmWikiDuplicateReviewCard(parent: HTMLElement): void {
    const card = createCard(parent, "lifeos-panel lifeos-llmwiki-duplicates");
    const head = card.createDiv({ cls: "lifeos-card-title" });
    setIcon(head.createSpan(), "copy-check");
    head.createSpan({ text: "重复资料待决策" });
    card.createEl("p", {
      cls: "lifeos-llmwiki-review-description",
      text: "发现相似资料时，可以选择跳过、仍然保存、作为新版保存，或先查看已有资料。"
    });
    card.createEl("p", {
      cls: "lifeos-llmwiki-review-description",
      text: "重复资料会询问：跳过、仍然保存、作为新版保存或查看已有。"
    });

    const options = card.createDiv({ cls: "lifeos-llmwiki-card-actions" });
    for (const label of ["跳过", "仍然保存", "作为新版保存", "查看已有"]) {
      options.createDiv({ cls: "lifeos-badge", text: label });
    }
  }

  private async renderLlmWikiDraftCards(parent: HTMLElement, fs: FileSystemService): Promise<void> {
    const prefix = fs.path("Knowledge", "LLMWiki", "Wiki", "Drafts").replace(/\\/g, "/").replace(/\/+$/g, "") + "/";
    const files = this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.replace(/\\/g, "/").startsWith(prefix) && file.path.endsWith(".md"))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, 8);
    if (files.length === 0) return;

    const card = createCard(parent, "lifeos-panel lifeos-llmwiki-drafts");
    const sectionHead = card.createDiv({ cls: "lifeos-knowledge-section-head" });
    const head = sectionHead.createDiv({ cls: "lifeos-card-title" });
    setIcon(head.createSpan(), "file-check-2");
    head.createSpan({ text: "Draft 待确认" });
    const sectionActions = sectionHead.createDiv({ cls: "lifeos-knowledge-section-actions" });
    this.renderKnowledgeSectionToggle(sectionActions, "drafts", files.length, KNOWLEDGE_PENDING_COLLAPSED_LIMIT);

    const visibleFiles = this.knowledgeVisibleItems("drafts", files, KNOWLEDGE_PENDING_COLLAPSED_LIMIT);
    for (const file of visibleFiles) {
      const row = card.createDiv({ cls: "lifeos-llmwiki-review-row" });
      row.createDiv({ cls: "lifeos-history-title", text: file.basename });
      row.createDiv({ cls: "lifeos-history-subtitle", text: file.path });
      const actions = row.createDiv({ cls: "lifeos-llmwiki-card-actions" });
      createButton(actions, "合并建议", () => {
        void this.acceptLlmWikiDraft(file.path);
      }, { primary: true, icon: "git-merge" });
      createButton(actions, "打开", () => {
        void this.app.workspace.getLeaf(false).openFile(file);
      }, { icon: "file-text" });
    }
    this.renderKnowledgeCollapsedHint(card, files.length - visibleFiles.length, "条 Draft");
  }

  private async renderLlmWikiLongSourceCards(parent: HTMLElement, fs: FileSystemService): Promise<void> {
    const prefix = fs.path("Knowledge", "LLMWiki", "Raw", "Inbox").replace(/\\/g, "/").replace(/\/+$/g, "") + "/";
    const files = this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.replace(/\\/g, "/").startsWith(prefix) && file.path.endsWith(".md") && file.stat.size > 4000)
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, 8);
    if (files.length === 0) return;

    const card = createCard(parent, "lifeos-panel lifeos-llmwiki-long-sources");
    const sectionHead = card.createDiv({ cls: "lifeos-knowledge-section-head" });
    const head = sectionHead.createDiv({ cls: "lifeos-card-title" });
    setIcon(head.createSpan(), "archive");
    head.createSpan({ text: "长资料待整理" });
    const sectionActions = sectionHead.createDiv({ cls: "lifeos-knowledge-section-actions" });
    this.renderKnowledgeSectionToggle(sectionActions, "long-sources", files.length, KNOWLEDGE_PENDING_COLLAPSED_LIMIT);

    const visibleFiles = this.knowledgeVisibleItems("long-sources", files, KNOWLEDGE_PENDING_COLLAPSED_LIMIT);
    for (const file of visibleFiles) {
      const row = card.createDiv({ cls: "lifeos-llmwiki-review-row" });
      row.createDiv({ cls: "lifeos-history-title", text: file.basename });
      row.createDiv({ cls: "lifeos-history-subtitle", text: "已暂存，可选择快速整理或深度整理。" });
      const actions = row.createDiv({ cls: "lifeos-llmwiki-card-actions" });
      const quickButton = createButton(actions, "快速整理", () => {
        void this.organizeSingleLlmWikiSource(file, "light");
      }, { primary: true, icon: "sparkles" });
      quickButton.disabled = !this.ensureLlmWikiEnabled(false);
      const deepButton = createButton(actions, "深度整理", () => {
        void this.organizeSingleLlmWikiSource(file, "deep");
      }, { icon: "brain-circuit" });
      deepButton.disabled = !this.ensureLlmWikiEnabled(false);
      createButton(actions, "打开", () => {
        void this.app.workspace.getLeaf(false).openFile(file);
      }, { icon: "file-text" });
    }
    this.renderKnowledgeCollapsedHint(card, files.length - visibleFiles.length, "条长资料");
  }

  private async acceptLlmWikiDraft(path: string): Promise<void> {
    if (!this.ensureLlmWikiEnabled()) return;
    if (!requireProFeature(this.plugin, "aiWriteback")) return;
    try {
      const service = new LlmWikiDraftService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);
      const recommendation = await service.recommendAcceptance(path);
      const previewActionLabel = recommendation.action === "merge-existing" ? "合并到已有页面" : "发布为新页面";
      const draft = this.app.vault.getAbstractFileByPath(path);
      const draftMarkdown = draft instanceof TFile ? await this.app.vault.read(draft) : "";
      const item: WritebackItem = {
        id: `llmwiki-draft-${Date.now()}`,
        kind: recommendation.action === "merge-existing" ? "append" : "replace",
        title: `Draft 确认：${previewActionLabel}`,
        targetPath: recommendation.targetPath,
        content: this.stripLlmWikiFrontmatter(draftMarkdown).trim(),
        checked: true
      };
      const selected = await openWritebackPreview(this.app, {
        title: "写入正式知识库前确认",
        description: `推荐操作：${previewActionLabel}。原因：${recommendation.reason}`,
        confirmText: "确认写入知识库",
        items: [item],
        onConfirm: async (items) => {
          const body = items[0]?.content?.trim();
          const result = await service.executeAcceptance(path, recommendation, new Date().toISOString(), body);
          if (!result.ok) {
            new Notice(result.warning ? `${result.message}\n${result.warning}` : result.message);
            return;
          }
          new Notice("Draft 已确认并写入正式 Wiki。");
        }
      });
      if (selected.length === 0) return;
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Draft 接受流程失败：${message}`);
    }
  }

  private async organizeShortLlmWikiSources(): Promise<void> {
    if (!this.ensureLlmWikiEnabled()) return;
    if (!requireProFeature(this.plugin, "aiWriteback")) return;
    // The old placeholder said "批量执行将在下一步接入"; this path now executes the batch.
    const compiler = new LlmWikiCompilerService(this.app, this.plugin.settings, this.plugin.ai);
    const batch = new LlmWikiBatchService(this.app, this.plugin.getRoot(), compiler, this.plugin.settings.directoryLanguage);
    const batchId = this.buildLlmWikiBatchId("short");
    const sources: CompileLlmWikiSourceInput[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    for (const file of this.rawInboxMarkdownFiles()) {
      try {
        const source = await this.readLlmWikiSourceForCompile(file, batchId, this.plugin.settings.llmWikiShortCompileDepth || "standard");
        if (!source.aiProcessingAllowed || source.privacyLevel === "sensitive") {
          skipped.push(source.sourceId);
          continue;
        }
        if (classifyLlmWikiMaterialLength(source.rawContent) !== "short") {
          skipped.push(source.sourceId);
          continue;
        }
        sources.push(source);
      } catch (error) {
        errors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const result = await batch.processShortSources(sources);
    const allSkipped = skipped.concat(result.skipped);
    const allErrors = errors.concat(result.errors);
    const manifestPath = await batch.writeBatchManifest({
      id: batchId,
      createdAt: new Date().toISOString(),
      operation: "compile",
      sourceIds: sources.map((source) => source.sourceId).concat(allSkipped),
      createdFiles: result.createdFiles,
      modifiedFiles: [],
      skippedFiles: allSkipped,
      errors: allErrors
    });
    new Notice(`短资料整理完成：生成 ${result.createdFiles.length}，跳过 ${allSkipped.length}，错误 ${allErrors.length}。Manifest：${manifestPath}`, 7000);
  }

  private async organizeSingleLlmWikiSource(file: TFile, depth: "light" | "deep"): Promise<void> {
    if (!this.ensureLlmWikiEnabled()) return;
    if (!requireProFeature(this.plugin, "aiWriteback")) return;
    const batchId = this.buildLlmWikiBatchId(depth);
    const batch = new LlmWikiBatchService(this.app, this.plugin.getRoot(), undefined, this.plugin.settings.directoryLanguage);
    const createdFiles: string[] = [];
    const skippedFiles: string[] = [];
    const errors: string[] = [];
    let sourceId = file.basename;

    try {
      const source = await this.readLlmWikiSourceForCompile(file, batchId, depth);
      sourceId = source.sourceId;
      if (!source.aiProcessingAllowed || source.privacyLevel === "sensitive") {
        skippedFiles.push(source.sourceId);
        new Notice("这条资料是 sensitive/local-only，已保持本地暂存，未调用 AI 编译。", 7000);
      } else {
        const compiler = new LlmWikiCompilerService(this.app, this.plugin.settings, this.plugin.ai);
        const draft = await compiler.compileSourceToDraft(source);
        createdFiles.push(draft.path);
        new Notice(`${depth === "deep" ? "深度" : "快速"}整理完成：${draft.path}`, 7000);
      }
    } catch (error) {
      errors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
      new Notice(`整理失败：${error instanceof Error ? error.message : String(error)}`, 7000);
    } finally {
      await batch.writeBatchManifest({
        id: batchId,
        createdAt: new Date().toISOString(),
        operation: "compile",
        sourceIds: [sourceId],
        createdFiles,
        modifiedFiles: [],
        skippedFiles,
        errors
      });
    }
  }

  private async undoLlmWikiBatch(batchPath: string): Promise<void> {
    if (!this.ensureLlmWikiEnabled()) return;
    try {
      const service = new LlmWikiUndoService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);
      const moved = await service.undoBatch(batchPath);
      new Notice(`已移动 ${moved.length} 个文件到 Trash。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`撤销批次失败：${message}`);
    }
  }

  private ensureLlmWikiEnabled(showNotice = true): boolean {
    const enabled = this.plugin.settings.enableLlmWiki !== false;
    if (!enabled && showNotice) {
      new Notice("LLM Wiki 已在设置中关闭，未执行写入。");
    }
    return enabled;
  }

  private rawInboxMarkdownFiles(): TFile[] {
    const prefix = this.normalizeLlmWikiPath(this.llmWikiPaths().path("Raw", "Inbox") + "/");
    return this.app.vault.getMarkdownFiles()
      .filter((file) => this.normalizeLlmWikiPath(file.path).startsWith(prefix) && file.path.endsWith(".md") && file.basename !== "index")
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
  }

  private async readLlmWikiSourceForCompile(file: TFile, batchId: string, depth: LlmWikiCompileDepth): Promise<CompileLlmWikiSourceInput> {
    const markdown = await this.app.vault.read(file);
    const frontmatter = this.parseLlmWikiFrontmatter(markdown);
    const rawContent = this.stripLlmWikiFrontmatter(markdown).trim();
    const policy = this.normalizeLlmWikiSourcePolicy(frontmatter);
    return {
      sourceId: frontmatter.id || file.basename,
      title: frontmatter.title || file.basename,
      rawContent,
      privacyLevel: policy.privacyLevel,
      capturedAt: frontmatter.captured_at || new Date(file.stat.mtime).toISOString(),
      batchId,
      compileDepth: depth,
      aiProcessingAllowed: policy.aiProcessingAllowed
    };
  }

  private parseLlmWikiFrontmatter(markdown: string): Record<string, string> {
    const match = String(markdown || "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/);
    if (!match) return {};
    const values: Record<string, string> = {};
    for (const line of match[1].split(/\r?\n/)) {
      const pair = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/);
      if (!pair) continue;
      values[pair[1]] = this.parseLlmWikiYamlScalar(pair[2]);
    }
    return values;
  }

  private stripLlmWikiFrontmatter(markdown: string): string {
    return String(markdown || "").replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/, "");
  }

  private normalizeLlmWikiPrivacyLevel(value = ""): LlmWikiPrivacyLevel {
    const normalized = this.normalizeLlmWikiScalar(value);
    return normalized === "sensitive" || normalized === "private" ? normalized : "normal";
  }

  private normalizeLlmWikiSourcePolicy(frontmatter: Record<string, string>): { privacyLevel: LlmWikiPrivacyLevel; aiProcessingAllowed: boolean } {
    const privacyLevel = this.normalizeLlmWikiPrivacyLevel(frontmatter.privacy_level);
    return {
      privacyLevel,
      aiProcessingAllowed: privacyLevel !== "sensitive" && this.normalizeLlmWikiScalar(frontmatter.ai_processing_allowed) !== "false"
    };
  }

  private normalizeLlmWikiScalar(value = ""): string {
    return this.parseLlmWikiYamlScalar(value).toLowerCase();
  }

  private parseLlmWikiYamlScalar(value = ""): string {
    const trimmed = String(value || "").trim();
    const quote = trimmed[0];
    const withoutComment = quote === "'" || quote === "\"" ? trimmed : trimmed.replace(/\s#.*/, "").trimEnd();
    return withoutComment.replace(/^['"]|['"]$/g, "");
  }

  private buildLlmWikiBatchId(label: string): string {
    return `batch_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}_${label}`;
  }

  private normalizeLlmWikiPath(path: string): string {
    return String(path || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+/, "");
  }

  private llmWikiPaths(): LlmWikiPathService {
    return new LlmWikiPathService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);
  }

  private knowledgeVisibleItems<T>(sectionId: string, items: T[], collapsedLimit: number): T[] {
    if (this.expandedKnowledgeSections.has(sectionId)) return items;
    return items.slice(0, collapsedLimit);
  }

  private renderKnowledgeSectionToggle(parent: HTMLElement, sectionId: string, total: number, collapsedLimit: number): HTMLButtonElement | null {
    if (total <= collapsedLimit) return null;
    const expanded = this.expandedKnowledgeSections.has(sectionId);
    const button = createButton(parent, expanded ? "收起" : `展开全部 ${total} 条`, () => {
      if (expanded) {
        this.expandedKnowledgeSections.delete(sectionId);
      } else {
        this.expandedKnowledgeSections.add(sectionId);
      }
      void this.render();
    }, {
      ghost: true,
      icon: expanded ? "chevron-up" : "chevron-down",
      className: "lifeos-knowledge-section-toggle"
    });
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
    return button;
  }

  private renderKnowledgeCollapsedHint(parent: HTMLElement, hiddenCount: number, noun: string): void {
    if (hiddenCount <= 0) return;
    const hint = parent.createDiv({ cls: "lifeos-knowledge-collapsed-hint" });
    setIcon(hint.createSpan(), "chevrons-down");
    hint.createSpan({ text: `已收起 ${hiddenCount} ${noun}，展开后继续查看。` });
  }

  private llmWikiStat(parent: HTMLElement, label: string, value: number): void {
    const stat = parent.createDiv({ cls: "lifeos-llmwiki-stat" });
    stat.createSpan({ cls: "lifeos-llmwiki-stat-value", text: String(value) });
    stat.createSpan({ cls: "lifeos-llmwiki-stat-label", text: label });
  }

  private countFiles(prefix: string): number {
    const normalizedBase = prefix.replace(/\\/g, "/").replace(/\/+$/g, "");
    const normalizedPrefix = normalizedBase.endsWith("/") ? normalizedBase : `${normalizedBase}/`;
    return this.app.vault.getMarkdownFiles()
      .filter((file) => {
        const path = file.path.replace(/\\/g, "/");
        return path.startsWith(normalizedPrefix) && path.endsWith(".md") && file.basename !== "index";
      })
      .length;
  }

  private countLongSources(prefix: string): number {
    const normalizedBase = prefix.replace(/\\/g, "/").replace(/\/+$/g, "");
    const normalizedPrefix = normalizedBase.endsWith("/") ? normalizedBase : `${normalizedBase}/`;
    return this.app.vault.getMarkdownFiles()
      .filter((file) => {
        const path = file.path.replace(/\\/g, "/");
        return path.startsWith(normalizedPrefix) && path.endsWith(".md") && file.basename !== "index" && file.stat.size > 4000;
      })
      .length;
  }

  private async renderKnowledgeWorkspace(parent: HTMLElement, fs: FileSystemService): Promise<void> {
    const workspace = parent.createDiv({ cls: "lifeos-knowledge-workspace" });
    this.renderKnowledgeOverview(workspace, fs);
    await this.renderKnowledgeLibrary(workspace, fs);
  }

  private renderKnowledgeOverview(parent: HTMLElement, fs: FileSystemService): void {
    const card = createCard(parent, "lifeos-panel lifeos-knowledge-overview");
    const head = card.createDiv({ cls: "lifeos-card-title" });
    setIcon(head.createSpan(), "layout-dashboard");
    head.createSpan({ text: "知识库工作台" });
    card.createEl("p", {
      text: "这里不是单纯的文件夹入口。之前保存的资料、草稿、正式知识和普通笔记都会显示在这里，方便继续整理、打开和复用。"
    });

    const stats = card.createDiv({ cls: "lifeos-llmwiki-stats lifeos-knowledge-overview-stats" });
    this.llmWikiStat(stats, "全部可见", this.countVisibleKnowledgeFiles(fs));
    this.llmWikiStat(stats, "Raw 原始资料", this.countFiles(fs.path("Knowledge", "LLMWiki", "Raw", "Inbox")));
    this.llmWikiStat(stats, "Draft 草稿", this.countFiles(fs.path("Knowledge", "LLMWiki", "Wiki", "Drafts")));
    this.llmWikiStat(stats, "正式知识", this.countFormalWikiFiles(fs));

    const actions = card.createDiv({ cls: "lifeos-llmwiki-actions" });
    createButton(actions, "新增资料", () => void this.openNewKnowledgeSourceModal(fs), { primary: true, icon: "file-plus-2" });
    createButton(actions, "打开 Raw Inbox", () => void this.openFolderIndex(fs, "LLMWiki/Raw/Inbox", "LLM Wiki Raw Inbox"), { icon: "archive" });
    createButton(actions, "打开正式 Wiki", () => void this.openFolderIndex(fs, "LLMWiki/Wiki", "LLM Wiki Wiki", {
      excludeFolders: ["Drafts", "Batches", "Raw", "Trash"]
    }), { icon: "library" });
  }

  private async renderKnowledgeLibrary(parent: HTMLElement, fs: FileSystemService): Promise<void> {
    const card = createCard(parent, "lifeos-panel lifeos-knowledge-library");
    const head = card.createDiv({ cls: "lifeos-knowledge-library-head" });
    const copy = head.createDiv();
    const title = copy.createDiv({ cls: "lifeos-card-title" });
    setIcon(title.createSpan(), "list-tree");
    title.createSpan({ text: "知识库内容流" });
    copy.createEl("p", {
      text: "之前保存的资料、草稿、正式知识和普通笔记都会显示在这里。Raw 是刚保存的原始资料，Draft 是 AI 整理草稿，正式知识是确认后的可复用条目。"
    });
    const actions = head.createDiv({ cls: "lifeos-knowledge-library-actions" });
    createButton(actions, "新增资料", () => void this.openNewKnowledgeSourceModal(fs), { primary: true, icon: "file-plus-2" });
    createButton(actions, "打开目录", () => void this.openIndex(fs), { icon: "folder-open" });

    const items = await this.collectKnowledgeLibraryItems(fs);
    this.renderKnowledgeSectionToggle(actions, "library", items.length, KNOWLEDGE_LIBRARY_COLLAPSED_LIMIT);
    if (items.length === 0) {
      createEmptyState(card, {
        icon: "file-plus",
        title: "还没有知识内容",
        description: "可以先新增资料，或从 AI 助手里把一段内容保存到知识库。保存后会出现在这里，而不是藏在 LLM Wiki 子目录里。",
        actions: [
          { label: "新增资料", icon: "file-plus-2", primary: true, onClick: () => void this.openNewKnowledgeSourceModal(fs) },
          { label: "打开知识库目录", icon: "folder-open", onClick: () => void this.openIndex(fs) }
        ],
        compact: true
      });
      return;
    }

    const grid = card.createDiv({ cls: "lifeos-knowledge-library-grid" });
    const visibleItems = this.knowledgeVisibleItems("library", items, KNOWLEDGE_LIBRARY_COLLAPSED_LIMIT);
    for (const item of visibleItems) {
      const row = grid.createDiv({ cls: `lifeos-knowledge-library-item is-${item.kind}`, attr: { role: "button", tabindex: "0" } });
      const openItem = () => void this.app.workspace.getLeaf(false).openFile(item.file);
      row.onclick = openItem;
      row.onkeydown = (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openItem();
      };
      const top = row.createDiv({ cls: "lifeos-knowledge-library-item-top" });
      top.createSpan({ cls: "lifeos-badge lifeos-knowledge-library-kind", text: item.badge });
      top.createSpan({ cls: "lifeos-knowledge-library-meta", text: new Date(item.file.stat.mtime).toLocaleString() });
      row.createDiv({ cls: "lifeos-history-title", text: item.title });
      row.createDiv({ cls: "lifeos-history-subtitle", text: item.subtitle });
      row.createDiv({ cls: "lifeos-knowledge-snippet", text: item.snippet || "暂无摘要，可打开查看。" });
    }
    this.renderKnowledgeCollapsedHint(card, items.length - visibleItems.length, "条知识内容");
  }

  private async collectKnowledgeLibraryItems(fs: FileSystemService): Promise<KnowledgeLibraryItem[]> {
    const groups = [
      await this.collectFilesFromKnowledgeSection(fs, ["Knowledge", "LLMWiki", "Raw", "Inbox"], "raw", "Raw 原始资料", "资料收件箱，刚保存但还没有整理成草稿。"),
      await this.collectFilesFromKnowledgeSection(fs, ["Knowledge", "LLMWiki", "Wiki", "Drafts"], "draft", "Draft 草稿", "AI 已整理，等待你确认发布或合并。"),
      await this.collectFilesFromKnowledgeSection(fs, ["Knowledge", "LLMWiki", "Wiki"], "formal", "正式知识", "已经确认沉淀，可作为后续 Chat 上下文参考。"),
      await this.collectFilesFromKnowledgeSection(fs, ["Knowledge"], "manual", "普通笔记", "你手动创建的学习资料、读书笔记和错题知识点。")
    ];
    return groups
      .flat()
      .sort((a, b) => b.file.stat.mtime - a.file.stat.mtime)
      .slice(0, 18);
  }

  private async collectFilesFromKnowledgeSection(
    fs: FileSystemService,
    parts: string[],
    kind: KnowledgeLibraryKind,
    badge: string,
    subtitle: string
  ): Promise<KnowledgeLibraryItem[]> {
    const prefix = `${fs.path(...parts).replace(/\\/g, "/").replace(/\/+$/g, "")}/`;
    const files = this.app.vault.getMarkdownFiles()
      .filter((file) => {
        const path = file.path.replace(/\\/g, "/");
        if (!path.startsWith(prefix) || !path.endsWith(".md") || file.basename === "index") return false;
        if (kind === "formal" && /\/LLMWiki\/Wiki\/(?:hot|log)\.md$/iu.test(path)) return false;
        if (kind === "formal" && /\/(?:Drafts|Batches|Raw|Trash)\//u.test(path)) return false;
        if (kind === "manual" && /\/LLMWiki\//u.test(path)) return false;
        if (kind === "manual" && /\/(?:Exports|Reports|Schema|Trash)\//u.test(path)) return false;
        return true;
      })
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, kind === "manual" ? 8 : 6);

    const formatter = new DisplayFormatService();
    const items: KnowledgeLibraryItem[] = [];
    for (const file of files) {
      const content = await this.app.vault.read(file);
      const blocks = await formatter.formatKnowledgeSnippetForDisplay(content, file.path);
      items.push({
        file,
        kind,
        title: file.basename,
        subtitle: `${subtitle} · ${file.path}`,
        badge,
        snippet: blocks[0]?.text || this.stripLlmWikiFrontmatter(content).split(/\r?\n/).find((line) => line.trim()) || ""
      });
    }
    return items;
  }

  private countVisibleKnowledgeFiles(fs: FileSystemService): number {
    const prefix = `${fs.path("Knowledge").replace(/\\/g, "/").replace(/\/+$/g, "")}/`;
    return this.app.vault.getMarkdownFiles()
      .filter((file) => {
        const path = file.path.replace(/\\/g, "/");
        return path.startsWith(prefix) && path.endsWith(".md") && file.basename !== "index" && !/\/(?:Batches|Trash|Exports|Reports|Schema)\//u.test(path);
      })
      .length;
  }

  private countFormalWikiFiles(fs: FileSystemService): number {
    const prefix = `${fs.path("Knowledge", "LLMWiki", "Wiki").replace(/\\/g, "/").replace(/\/+$/g, "")}/`;
    return this.app.vault.getMarkdownFiles()
      .filter((file) => {
        const path = file.path.replace(/\\/g, "/");
        return path.startsWith(prefix) && path.endsWith(".md") && file.basename !== "index" && !/\/(?:Drafts|Batches|Trash)\//u.test(path);
      })
      .length;
  }

  private entryCard(parent: HTMLElement, title: string, description: string, icon: string, onClick: () => void): void {
    const card = createCard(parent, "lifeos-feature-card lifeos-knowledge-entry");
    const head = card.createDiv({ cls: "lifeos-card-title" });
    setIcon(head.createSpan(), icon);
    head.createSpan({ text: title });
    card.createEl("p", { text: description });
    createButton(card, "打开入口", onClick, { primary: true, icon: "arrow-right" });
  }

  private async renderRecent(parent: HTMLElement, fs: FileSystemService): Promise<void> {
    const card = createCard(parent, "lifeos-panel lifeos-knowledge-recent lifeos-knowledge-recent-full");
    const sectionHead = card.createDiv({ cls: "lifeos-knowledge-section-head" });
    const head = sectionHead.createDiv({ cls: "lifeos-card-title" });
    setIcon(head.createSpan(), "clock");
    head.createSpan({ text: "最近整理" });
    const sectionActions = sectionHead.createDiv({ cls: "lifeos-knowledge-section-actions" });
    card.createEl("p", { text: "最近创建或修改的知识内容会显示在这里。" });
    const prefix = fs.path("Knowledge") + "/";
    const files = this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(prefix) && file.basename !== "index")
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, 6);
    if (files.length === 0) {
      createEmptyState(card, {
        icon: "file-plus",
        title: "还没有知识笔记",
        description: "可以先创建一条读书笔记，或者把今天的学习资料放进知识库。",
        actions: [
          { label: "新建知识笔记", icon: "plus", primary: true, onClick: () => void this.createKnowledgeNote(fs) },
          { label: "打开知识库目录", icon: "folder-open", onClick: () => void this.openIndex(fs) }
        ],
        compact: true
      });
      this.renderExamples(card);
      return;
    }
    this.renderKnowledgeSectionToggle(sectionActions, "recent", files.length, KNOWLEDGE_RECENT_COLLAPSED_LIMIT);
    const visibleFiles = this.knowledgeVisibleItems("recent", files, KNOWLEDGE_RECENT_COLLAPSED_LIMIT);
    for (const file of visibleFiles) {
      const content = await this.app.vault.read(file);
      const blocks = await new DisplayFormatService().formatKnowledgeSnippetForDisplay(content, file.path);
      const row = card.createEl("button", { cls: "lifeos-history-item lifeos-knowledge-row", attr: { type: "button" } });
      const category = this.categoryLabel(file.path);
      row.createSpan({ cls: "lifeos-history-title", text: file.basename });
      row.createSpan({ cls: "lifeos-history-subtitle", text: `${category} · ${new Date(file.stat.mtime).toLocaleString()}` });
      renderMarkdownDisplay(this.app, this, row.createDiv({ cls: "lifeos-knowledge-snippet" }), blocks[0]?.text || "暂无摘要，可打开查看。", file.path);
      row.onclick = () => void this.app.workspace.getLeaf(false).openFile(file);
    }
    this.renderKnowledgeCollapsedHint(card, files.length - visibleFiles.length, "条最近内容");
  }

  private renderExamples(parent: HTMLElement): void {
    const examples = parent.createDiv({ cls: "lifeos-example-tasks" });
    examples.createDiv({ cls: "lifeos-example-title", text: "示例，不会写入文件" });
    ["《一本书》读书摘录", "行测资料：数量关系公式", "错题知识点：资料分析速算"].forEach((text) => {
      const row = examples.createDiv({ cls: "lifeos-example-task-row" });
      setIcon(row.createSpan(), "file-text");
      row.createSpan({ text });
      row.createSpan({ cls: "lifeos-badge", text: "示例" });
    });
  }

  private categoryLabel(path: string): string {
    if (path.includes("/Materials/")) return "学习资料";
    if (path.includes("/Books/")) return "读书笔记";
    if (path.includes("/Mistakes/")) return "错题知识点";
    return "知识笔记";
  }

  private async openNewKnowledgeSourceModal(fs: FileSystemService): Promise<void> {
    const input = await openNewKnowledgeSourceModal(this.app);
    if (!input) return;
    try {
      const file = await this.createKnowledgeSourceFromModal(fs, input);
      new Notice(`资料已加入知识库：${file.path}`, 5000);
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`新增资料失败：${message}`, 7000);
    }
  }

  private async createKnowledgeSourceFromModal(fs: FileSystemService, input: KnowledgeCaptureInput): Promise<TFile> {
    const title = input.title.trim() || "未命名资料";
    const slug = this.sanitizeKnowledgeTitle(title);
    const createdAt = new Date().toISOString();
    const privacy = input.privacy || "normal";
    const aiProcessingAllowed = privacy === "sensitive" ? "false" : "true";

    if (input.kind === "raw") {
      const id = `${createdAt.replace(/\D/g, "").slice(0, 14)}-${slug}`;
      const path = this.uniqueKnowledgePath(fs, ["LLMWiki", "Raw", "Inbox"], `${id}.md`);
      const body = [
        "---",
        "type: llm-wiki-source",
        `id: ${this.escapeYamlValue(id)}`,
        `title: ${this.escapeYamlValue(title)}`,
        "source_kind: manual",
        `privacy_level: ${privacy}`,
        `ai_processing_allowed: ${aiProcessingAllowed}`,
        `captured_at: ${createdAt}`,
        "---",
        "",
        `# ${title}`,
        "",
        input.content.trim() || "在这里补充资料正文。",
        ""
      ].join("\n");
      return ensureFile(this.app, path, body);
    }

    const folder = input.kind === "books" ? "Books" : input.kind === "mistakes" ? "Mistakes" : "Materials";
    const category = input.kind === "books" ? "读书笔记" : input.kind === "mistakes" ? "错题知识点" : "学习资料";
    const path = this.uniqueKnowledgePath(fs, [folder], `${today()}-${slug}.md`);
    const body = [
      "---",
      "type: knowledge-note",
      `category: ${this.escapeYamlValue(category)}`,
      `privacy_level: ${privacy}`,
      `ai_processing_allowed: ${aiProcessingAllowed}`,
      `created_at: ${createdAt}`,
      "---",
      "",
      `# ${title}`,
      "",
      "## 摘要",
      "",
      "## 正文",
      "",
      input.content.trim() || "在这里补充资料正文。",
      "",
      "## 关联行动",
      "",
      "- [ ] 后续整理这条资料",
      ""
    ].join("\n");
    return ensureFile(this.app, path, body);
  }

  private uniqueKnowledgePath(fs: FileSystemService, folderParts: string[], fileName: string): string {
    const cleanName = fileName.replace(/[\\/:*?"<>|#^[\]]+/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 96);
    const dot = cleanName.toLowerCase().endsWith(".md") ? cleanName.slice(0, -3) : cleanName;
    const base = this.sanitizeKnowledgeTitle(dot);
    for (let index = 0; index < 100; index += 1) {
      const suffix = index === 0 ? "" : `-${index + 1}`;
      const path = fs.path("Knowledge", ...folderParts, `${base}${suffix}.md`);
      if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFile)) return path;
    }
    throw new Error("无法生成唯一的知识库文件名。");
  }

  private sanitizeKnowledgeTitle(title: string): string {
    return String(title || "未命名资料")
      .trim()
      .replace(/[\\/:*?"<>|#^[\]]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 56) || "未命名资料";
  }

  private escapeYamlValue(value: string): string {
    const escaped = String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    return `"${escaped}"`;
  }

  private async createKnowledgeNote(fs: FileSystemService): Promise<void> {
    const path = fs.path("Knowledge", `${today()}-知识笔记.md`);
    const file = await ensureFile(this.app, path, `# ${today()} 知识笔记\n\n## 主题\n\n## 关键内容\n\n## 后续行动\n\n`);
    new Notice("知识笔记已创建。", 5000);
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private async openIndex(fs: FileSystemService): Promise<void> {
    const file = await this.refreshDirectoryIndex(fs, ["Knowledge"], "知识库目录");
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private async openFolderIndex(fs: FileSystemService, folder: string, title: string, options: DirectoryIndexOptions = {}): Promise<void> {
    const file = await this.refreshDirectoryIndex(fs, ["Knowledge", ...folder.split("/").filter(Boolean)], `${title} 目录`, options);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
  }

  private async refreshDirectoryIndex(fs: FileSystemService, parts: string[], title: string, options: DirectoryIndexOptions = {}): Promise<TFile> {
    const directoryPath = fs.path(...parts);
    const indexPath = `${directoryPath}/index.md`;
    const nextBlock = this.buildDirectoryIndexBlock(directoryPath, indexPath, options);
    const initialContent = `# ${title}\n\n${nextBlock}\n`;
    const file = await ensureFile(this.app, indexPath, initialContent);
    const current = await this.app.vault.read(file);
    const next = this.mergeDirectoryIndexBlock(current, title, nextBlock);
    if (next !== current) await this.app.vault.modify(file, next);
    return file;
  }

  private mergeDirectoryIndexBlock(current: string, title: string, block: string): string {
    const normalized = current.trim();
    if (!normalized || /^# .+\s*$/u.test(normalized)) {
      return `# ${title}\n\n${block}\n`;
    }
    const start = current.indexOf(DIRECTORY_INDEX_START);
    const end = current.indexOf(DIRECTORY_INDEX_END);
    if (start >= 0 && end > start) {
      return `${current.slice(0, start)}${block}${current.slice(end + DIRECTORY_INDEX_END.length)}`.trimEnd() + "\n";
    }
    return `${current.trimEnd()}\n\n${block}\n`;
  }

  private buildDirectoryIndexBlock(directoryPath: string, indexPath: string, options: DirectoryIndexOptions = {}): string {
    const normalizedDirectory = directoryPath.replace(/\\/g, "/").replace(/\/+$/g, "");
    const prefix = `${normalizedDirectory}/`;
    const indexNormalized = indexPath.replace(/\\/g, "/");
    const excludedFolders = new Set((options.excludeFolders ?? []).map((folder) => folder.replace(/^\/+|\/+$/g, "")));
    const files = this.app.vault.getMarkdownFiles()
      .filter((file) => {
        const path = file.path.replace(/\\/g, "/");
        const relative = path.slice(prefix.length);
        const firstSegment = relative.split("/")[0];
        return path.startsWith(prefix)
          && path !== indexNormalized
          && path.endsWith(".md")
          && file.basename !== "index"
          && !excludedFolders.has(firstSegment);
      })
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
    const directory = this.app.vault.getAbstractFileByPath(normalizedDirectory);
    const directFolders = directory instanceof TFolder
      ? directory.children
        .filter((child): child is TFolder => child instanceof TFolder)
        .map((child) => child.name)
        .filter((name) => !excludedFolders.has(name))
      : [];
    const folders = Array.from(new Set(directFolders.concat(files
      .map((file) => file.path.replace(/\\/g, "/").slice(prefix.length).split("/"))
      .filter((segments) => segments.length > 1)
      .map((segments) => segments[0])
      .filter(Boolean))))
      .sort((a, b) => a.localeCompare(b, "zh-CN"));

    const lines = [
      DIRECTORY_INDEX_START,
      "",
      "> 这个目录页由 Life OS 在你点击“打开目录”时刷新，用来快速查看当前目录下已经保存的内容。",
      "",
      `当前目录：\`${normalizedDirectory}\``,
      "",
      "## 子目录"
    ];

    if (folders.length > 0) {
      for (const folderName of folders) lines.push(`- \`${folderName}/\``);
    } else {
      lines.push("- 暂无子目录。");
    }

    lines.push("", "## 文件");
    if (files.length > 0) {
      lines.push("| 文件 | 位置 | 更新时间 |", "| --- | --- | --- |");
      for (const file of files.slice(0, 80)) {
        const relativePath = file.path.replace(/\\/g, "/").slice(prefix.length).replace(/\.md$/iu, "");
        lines.push(`| ${this.formatDirectoryIndexLink(file)} | \`${relativePath}\` | ${new Date(file.stat.mtime).toLocaleString()} |`);
      }
      if (files.length > 80) lines.push(`| 还有 ${files.length - 80} 个文件 | 为避免目录过长，请在文件树中继续查看 |  |`);
    } else {
      lines.push("这个目录目前还没有可见的 Markdown 文件。");
    }

    lines.push("", DIRECTORY_INDEX_END);
    return lines.join("\n");
  }

  private formatDirectoryIndexLink(file: TFile): string {
    const target = file.path.replace(/\.md$/iu, "").replace(/\|/g, "-");
    const alias = file.basename.replace(/\|/g, "-");
    return `[[${target}|${alias}]]`;
  }
}

function openNewKnowledgeSourceModal(app: App): Promise<KnowledgeCaptureInput | null> {
  return new Promise((resolve) => {
    new NewKnowledgeSourceModal(app, resolve).open();
  });
}

class NewKnowledgeSourceModal extends Modal {
  private hasResolved = false;
  private titleInput!: HTMLInputElement;
  private kindSelect!: HTMLSelectElement;
  private privacySelect!: HTMLSelectElement;
  private contentInput!: HTMLTextAreaElement;

  constructor(app: App, private resolveInput: (input: KnowledgeCaptureInput | null) => void) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-knowledge-capture-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: "新增资料",
      subtitle: "把文章摘录、课程资料、读书笔记、错题方法或临时素材先放进知识库。敏感资料可以标记为敏感，后续不会自动交给 AI 整理。",
      icon: "file-plus-2",
      className: "lifeos-knowledge-capture-modal"
    });

    const form = body.createDiv({ cls: "lifeos-knowledge-capture-form" });
    this.titleInput = this.renderInputField(form, "标题", "例如：申论小而美文旅模型");
    this.kindSelect = this.renderSelectField(form, "保存位置", [
      ["raw", "资料收件箱（Raw 原始资料，后续可整理）"],
      ["materials", "学习资料"],
      ["books", "读书笔记"],
      ["mistakes", "错题知识点"]
    ]);
    this.privacySelect = this.renderSelectField(form, "隐私级别", [
      ["normal", "普通：可用于后续整理和上下文"],
      ["private", "私密：保留在本地，谨慎进入上下文"],
      ["sensitive", "敏感资料：不自动调用 AI"]
    ]);
    const contentWrap = form.createDiv({ cls: "lifeos-knowledge-capture-field is-wide" });
    contentWrap.createEl("label", { text: "资料内容" });
    this.contentInput = contentWrap.createEl("textarea", {
      cls: "lifeos-knowledge-capture-textarea",
      attr: { rows: "10", placeholder: "粘贴资料正文、链接、读书摘录、错题方法，或先写一个简短说明。" }
    });

    createButton(footer, "取消", () => this.finish(null), { ghost: true });
    createButton(footer, "加入知识库", () => this.submit(), { primary: true, icon: "file-plus-2" });
    this.titleInput.focus();
  }

  onClose(): void {
    if (!this.hasResolved) this.finish(null);
  }

  private renderInputField(parent: HTMLElement, label: string, placeholder: string): HTMLInputElement {
    const wrap = parent.createDiv({ cls: "lifeos-knowledge-capture-field" });
    wrap.createEl("label", { text: label });
    return wrap.createEl("input", {
      cls: "lifeos-knowledge-capture-input",
      attr: { type: "text", placeholder }
    });
  }

  private renderSelectField(parent: HTMLElement, label: string, options: Array<[KnowledgeCaptureKind | KnowledgePrivacyChoice, string]>): HTMLSelectElement {
    const wrap = parent.createDiv({ cls: "lifeos-knowledge-capture-field" });
    wrap.createEl("label", { text: label });
    const select = wrap.createEl("select", { cls: "lifeos-knowledge-capture-select" });
    for (const [value, text] of options) {
      select.createEl("option", { text, value });
    }
    return select;
  }

  private submit(): void {
    const title = this.titleInput.value.trim();
    const content = this.contentInput.value.trim();
    if (!title && !content) {
      new Notice("请至少填写标题或资料内容。", 4000);
      return;
    }
    this.finish({
      title: title || content.slice(0, 36) || "未命名资料",
      kind: this.kindSelect.value as KnowledgeCaptureKind,
      privacy: this.privacySelect.value as KnowledgePrivacyChoice,
      content
    });
  }

  private finish(input: KnowledgeCaptureInput | null): void {
    if (!this.hasResolved) {
      this.resolveInput(input);
      this.hasResolved = true;
    }
    this.close();
  }
}
