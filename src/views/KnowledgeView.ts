import { App, ItemView, Modal, Notice, TFile, TFolder, WorkspaceLeaf, requestUrl, setIcon } from "obsidian";
import { createButton } from "../components/Button";
import { createCard } from "../components/Card";
import { createEmptyState } from "../components/EmptyState";
import { createHeroHeader } from "../components/HeroHeader";
import { createLifeOSShell } from "../components/LifeOSComponent";
import { createModalShell } from "../components/ModalShell";
import { KNOWLEDGE_VIEW_TYPE } from "../constants";
import { requireProFeature } from "../licensing/entitlement";
import { ImportProjectDocumentsModal } from "../modals/ImportProjectDocumentsModal";
import type PersonalLifeSystemPlugin from "../main";
import { DisplayFormatService } from "../services/DisplayFormatService";
import {
  CHAT_IMPORT_ACCEPT,
  formatAttachmentSize,
  readImportedFile,
  saveImportedFileToVault,
  type ImportedDocument,
  type ReadableImportFile
} from "../services/DocumentImportService";
import { FileSystemService } from "../services/FileSystemService";
import { LlmWikiBatchService } from "../services/LlmWikiBatchService";
import { LlmWikiCompilerService, type CompileLlmWikiSourceInput } from "../services/LlmWikiCompilerService";
import { LlmWikiDraftService } from "../services/LlmWikiDraftService";
import { LlmWikiPathService } from "../services/LlmWikiPathService";
import { LlmWikiUndoService } from "../services/LlmWikiUndoService";
import { buildLlmWikiSourceMarkdown, classifyLlmWikiMaterialLength, simpleLlmWikiHash, type LlmWikiCompileDepth, type LlmWikiPrivacyLevel, type LlmWikiSourceKind } from "../services/llm-wiki-logic";
import { buildKeywordLinkedMarkdown, stripKeywordLinksSection } from "../services/KeywordLinkService";
import { PdfOcrService } from "../services/PdfOcrService";
import { ProjectDocumentService } from "../services/ProjectDocumentService";
import { ProjectService } from "../services/ProjectService";
import { fetchReadableUrl, type WebContextRequestOptions } from "../services/WebContextService";
import type { LifeOSProject } from "../types";
import { today } from "../utils/dates";
import { renderMarkdownDisplay } from "../utils/markdown-render";
import { ensureFile, ensureFolder } from "../utils/vault";
import { openWritebackPreview, type WritebackItem } from "../writeback-preview";

type KnowledgeLibraryKind = "raw" | "draft" | "formal" | "manual";
type KnowledgeDestinationKind = "raw" | "formal" | "materials" | "books" | "mistakes" | "project";
type KnowledgeCaptureKind = Exclude<KnowledgeDestinationKind, "formal">;
type KnowledgeCategoryKind = "materials" | "books" | "mistakes";
type KnowledgeFinalDestinationKind = Exclude<KnowledgeDestinationKind, "raw">;
type KnowledgePrivacyChoice = "normal" | "private" | "sensitive";
type KnowledgeWebClipMode = "text" | "text-images";

interface KnowledgeLibraryItem {
  file: TFile;
  kind: KnowledgeLibraryKind;
  title: string;
  subtitle: string;
  badge: string;
  snippet: string;
  requiresReview?: boolean;
  reviewReason?: string;
}

interface KnowledgePipelineSection {
  id: string;
  icon: string;
  title: string;
  description: string;
  items: KnowledgeLibraryItem[];
  emptyTitle: string;
  emptyDescription: string;
}

interface KnowledgeCaptureInput {
  title: string;
  kind: KnowledgeCaptureKind;
  privacy: KnowledgePrivacyChoice;
  content: string;
  projectId?: string;
  sourceKind?: LlmWikiSourceKind;
  originalUrl?: string;
  sourcePath?: string;
}

interface KnowledgeImportHandlers {
  importFiles: (files: File[], privacy: KnowledgePrivacyChoice, destination: KnowledgeCaptureKind, projectId?: string) => Promise<void>;
  importUrl: (
    url: string,
    title: string,
    privacy: KnowledgePrivacyChoice,
    destination: KnowledgeCaptureKind,
    clipMode: KnowledgeWebClipMode,
    projectId?: string
  ) => Promise<void>;
  pasteText: (destination: KnowledgeCaptureKind, projectId?: string) => void;
  importProjectDocuments: (projectId: string) => void;
}

interface WebClipImageCandidate {
  url: string;
  alt: string;
}

interface SavedWebClipImage extends WebClipImageCandidate {
  vaultPath: string;
  fileName: string;
  embed: string;
}

interface DirectoryIndexOptions {
  excludeFolders?: string[];
}

const DIRECTORY_INDEX_START = "<!-- lifeos-directory-index:start -->";
const DIRECTORY_INDEX_END = "<!-- lifeos-directory-index:end -->";
const KNOWLEDGE_PENDING_COLLAPSED_LIMIT = 3;
const KNOWLEDGE_RECENT_COLLAPSED_LIMIT = 4;
const KNOWLEDGE_CATEGORY_META: Record<KnowledgeCategoryKind, {
  folder: string;
  label: string;
  description: string;
  icon: string;
}> = {
  materials: {
    folder: "Materials",
    label: "学习资料",
    description: "保存课程、资料和参考链接。",
    icon: "folder-open"
  },
  books: {
    folder: "Books",
    label: "读书笔记",
    description: "整理书摘、观点和启发。",
    icon: "book-open"
  },
  mistakes: {
    folder: "Mistakes",
    label: "错题知识点",
    description: "沉淀易错点和解题方法。",
    icon: "graduation-cap"
  }
};

const KNOWLEDGE_CAPTURE_DESTINATIONS: Array<{ kind: KnowledgeCaptureKind; label: string }> = [
  { kind: "raw", label: "待整理" },
  { kind: "materials", label: "学习资料" },
  { kind: "books", label: "读书笔记" },
  { kind: "mistakes", label: "错题知识点" },
  { kind: "project", label: "项目文档" }
];

const KNOWLEDGE_FINAL_DESTINATIONS: Array<{ kind: KnowledgeFinalDestinationKind; label: string }> = [
  { kind: "formal", label: "正式 Wiki" },
  { kind: "materials", label: "学习资料" },
  { kind: "books", label: "读书笔记" },
  { kind: "mistakes", label: "错题知识点" },
  { kind: "project", label: "项目文档" }
];

export class KnowledgeView extends ItemView {
  private expandedKnowledgeSections = new Set<string>();
  private lastKnowledgeFocusPath: string | null = null;
  private removedRecentKnowledgePaths = new Set<string>();

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
        { label: "导入资料", icon: "upload-cloud", primary: true, onClick: () => void this.openKnowledgeImportHub(fs) },
        { label: "新建知识笔记", icon: "plus", onClick: () => void this.createKnowledgeNote(fs) },
        { label: "打开知识库目录", icon: "file-text", onClick: () => void this.openIndex(fs) },
        { label: "AI 批量整理", icon: "sparkles", onClick: () => void this.organizeShortLlmWikiSources() }
      ]
    });

    await this.renderKnowledgeWorkspace(main, fs);
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
    this.llmWikiStat(stats, "Drafts", await this.countPendingLlmWikiDraftFiles(fs));
    this.llmWikiStat(stats, "长资料待整理", this.countLongSources(fs.path("Knowledge", "LLMWiki", "Raw", "Inbox")));
    this.llmWikiStat(stats, "批次记录", this.countFiles(fs.path("Knowledge", "LLMWiki", "Wiki", "Batches")));

    const actions = card.createDiv({ cls: "lifeos-llmwiki-actions" });
    const organizeShortButton = createButton(actions, "整理短资料", () => {
      void this.organizeShortLlmWikiSources();
    }, { primary: true, icon: "sparkles" });
    organizeShortButton.disabled = !this.ensureLlmWikiEnabled(false);
    if (organizeShortButton.disabled) organizeShortButton.title = "LLM Wiki 已在设置中关闭";
    createButton(actions, "打开草稿索引", () => {
      void this.openFolderIndex(fs, ["LLMWiki", "Wiki", "Drafts"], "LLM Wiki Drafts");
    }, { icon: "file-text" });
    createButton(actions, "打开 Raw Inbox 索引", () => {
      void this.openFolderIndex(fs, ["LLMWiki", "Raw", "Inbox"], "LLM Wiki Raw Inbox");
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
    const files = await this.collectPendingLlmWikiDraftFiles(fs, 8);
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
      const fs = new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);
      const service = new LlmWikiDraftService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);
      const recommendation = await service.recommendAcceptance(path);
      const previewActionLabel = recommendation.action === "merge-existing" ? "合并到已有页面" : "发布为新页面";
      const draft = this.app.vault.getAbstractFileByPath(path);
      const draftMarkdown = draft instanceof TFile ? await this.app.vault.read(draft) : "";
      const draftBody = this.stripLlmWikiFrontmatter(draftMarkdown).trim();
      const projects = await new ProjectService(this.app, fs).loadProjects();
      const destination = await openKnowledgeFinalDestinationModal(this.app, projects, previewActionLabel);
      if (!destination) return;
      const targetPath = this.draftAcceptancePreviewTargetPath(fs, destination, recommendation.targetPath, draftMarkdown);
      const item: WritebackItem = {
        id: `llmwiki-draft-${Date.now()}`,
        kind: destination.kind === "formal" && recommendation.action === "merge-existing" ? "append" : "replace",
        title: `Draft 确认：${this.finalDestinationLabel(destination.kind)}`,
        targetPath,
        content: draftBody,
        checked: true
      };
      const selected = await openWritebackPreview(this.app, {
        title: "写入正式知识库前确认",
        description: `推荐操作：${previewActionLabel}。最终分类：${this.finalDestinationLabel(destination.kind)}。原因：${recommendation.reason}`,
        confirmText: "确认写入知识库",
        items: [item],
        onConfirm: async (items) => {
          const body = items[0]?.content?.trim();
          const acceptedAt = new Date().toISOString();
          const result = destination.kind === "formal"
            ? await service.executeAcceptance(path, recommendation, acceptedAt, body)
            : await this.executeCategorizedDraftAcceptance(fs, service, path, destination, draftMarkdown, body || draftBody, acceptedAt);
          if (!result.ok) {
            new Notice(result.warning ? `${result.message}\n${result.warning}` : result.message);
            return;
          }
          new Notice(`Draft 已确认并写入${this.finalDestinationLabel(destination.kind)}。`);
          this.lastKnowledgeFocusPath = null;
          await this.render();
        }
      });
      if (selected.length === 0) return;
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Draft 接受流程失败：${message}`);
    }
  }

  private draftAcceptancePreviewTargetPath(
    fs: FileSystemService,
    destination: KnowledgeFinalDestinationSelection,
    recommendedTargetPath: string,
    draftMarkdown: string
  ): string {
    const title = this.inferKnowledgeTitleFromMarkdown(draftMarkdown, "LLM Wiki Draft");
    if (destination.kind === "formal") return recommendedTargetPath;
    if (destination.kind === "project") {
      const project = destination.projectId || "未选择项目";
      return `${fs.path("Projects")}/${project}/Documents/${this.sanitizeKnowledgeTitle(title)}.md`;
    }
    return this.uniqueKnowledgePath(fs, [KNOWLEDGE_CATEGORY_META[destination.kind].folder], `${today()}-${this.sanitizeKnowledgeTitle(title)}.md`);
  }

  private async executeCategorizedDraftAcceptance(
    fs: FileSystemService,
    service: LlmWikiDraftService,
    draftPath: string,
    destination: KnowledgeFinalDestinationSelection,
    draftMarkdown: string,
    body: string,
    acceptedAt: string
  ): Promise<{ ok: boolean; targetPath?: string; message: string; warning?: string }> {
    const title = this.inferKnowledgeTitleFromMarkdown(draftMarkdown, "LLM Wiki Draft");
    let targetPath = "";
    if (destination.kind === "formal") {
      return {
        ok: false,
        message: "正式 Wiki 入库应走原始接受流程，未执行分类写入。"
      };
    }
    if (destination.kind === "project") {
      const project = await this.requireProjectForDestination(fs, destination.projectId);
      const projectDocuments = new ProjectDocumentService(this.app, fs);
      const document = await projectDocuments.createDocument(project, {
        title,
        kind: "reference",
        content: body
      });
      targetPath = document.path;
    } else {
      const content = this.buildCategorizedKnowledgeMarkdown(destination.kind, title, body, acceptedAt, draftPath);
      const folder = KNOWLEDGE_CATEGORY_META[destination.kind].folder;
      targetPath = this.uniqueKnowledgePath(fs, [folder], `${today()}-${this.sanitizeKnowledgeTitle(title)}.md`);
      await ensureFolder(this.app, targetPath.split("/").slice(0, -1).join("/"));
      await this.app.vault.create(targetPath, content);
    }

    const marked = await service.markDraftAccepted(draftPath, targetPath, acceptedAt);
    if (!marked) {
      return {
        ok: false,
        targetPath,
        message: "内容已写入，但 Draft 状态标记失败，请手动检查待复核队列。"
      };
    }
    return {
      ok: true,
      targetPath,
      message: `Draft 已接受并写入${this.finalDestinationLabel(destination.kind)}。`
    };
  }

  private buildCategorizedKnowledgeMarkdown(
    kind: KnowledgeCategoryKind,
    title: string,
    body: string,
    createdAt: string,
    sourcePath: string
  ): string {
    const meta = KNOWLEDGE_CATEGORY_META[kind];
    return buildKeywordLinkedMarkdown([
      "---",
      "type: knowledge-note",
      `category: ${this.escapeYamlValue(meta.label)}`,
      "privacy_level: normal",
      "ai_processing_allowed: true",
      `source_draft: ${this.escapeYamlValue(sourcePath)}`,
      `created_at: ${createdAt}`,
      "---",
      "",
      body.trim().startsWith("#") ? body.trim() : `# ${title}\n\n${body.trim()}`,
      ""
    ].join("\n"), { title });
  }

  private inferKnowledgeTitleFromMarkdown(markdown: string, fallback: string): string {
    const body = this.stripLlmWikiFrontmatter(markdown);
    return body.match(/^#\s+(.+)$/m)?.[1]?.trim()
      || this.parseLlmWikiFrontmatter(markdown).title
      || fallback;
  }

  private async skipLlmWikiDraft(path: string): Promise<void> {
    if (!this.ensureLlmWikiEnabled()) return;
    if (!requireProFeature(this.plugin, "knowledgeManagement")) return;
    if (!window.confirm("确认这条 Draft 暂不进入正式知识库吗？它会保留在 Drafts 中，但不再显示在待复核队列里。")) return;
    try {
      const service = new LlmWikiDraftService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);
      const skipped = await service.markDraftSkipped(path, new Date().toISOString(), "User chose to keep the Draft out of formal Wiki from Knowledge view.");
      if (!skipped) {
        new Notice("暂不入库失败：这条 Draft 可能已经变化、已入库或不在 Drafts 目录。");
        return;
      }
      this.lastKnowledgeFocusPath = null;
      await this.render();
      new Notice("已标记为暂不入库，正式知识库未写入。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`暂不入库失败：${message}`);
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
    const sourceFiles = new Map<string, TFile>();
    const skipped: string[] = [];
    const errors: string[] = [];
    const movedRawFiles: string[] = [];
    const fs = new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);

    for (const file of this.rawInboxMarkdownFiles()) {
      try {
        const source = await this.readLlmWikiSourceForCompile(file, batchId, this.plugin.settings.llmWikiShortCompileDepth || "standard");
        if (classifyLlmWikiMaterialLength(source.rawContent) !== "short") {
          skipped.push(source.sourceId);
          continue;
        }
        sources.push(source);
        sourceFiles.set(source.sourceId, file);
      } catch (error) {
        errors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const result = await batch.processShortSources(sources);
    for (const sourceId of result.processedSourceIds) {
      const sourceFile = sourceFiles.get(sourceId);
      if (!sourceFile) continue;
      const movedPath = await this.moveRawInboxSourceToSources(sourceFile, fs);
      if (movedPath) movedRawFiles.push(movedPath);
    }
    const allSkipped = skipped.concat(result.skipped);
    const allErrors = errors.concat(result.errors);
    const manifestPath = await batch.writeBatchManifest({
      id: batchId,
      createdAt: new Date().toISOString(),
      operation: "compile",
      sourceIds: sources.map((source) => source.sourceId).concat(allSkipped),
      createdFiles: result.createdFiles,
      modifiedFiles: movedRawFiles,
      skippedFiles: allSkipped,
      errors: allErrors
    });
    if (result.createdFiles[0]) {
      this.lastKnowledgeFocusPath = result.createdFiles[0];
      this.expandedKnowledgeSections.add("pipeline-draft");
      await this.render();
      this.focusKnowledgeItem(result.createdFiles[0]);
    }
    new Notice(`短资料整理完成：生成 ${result.createdFiles.length}，归档 Raw ${movedRawFiles.length}，跳过 ${allSkipped.length}，错误 ${allErrors.length}。Manifest：${manifestPath}`, 7000);
  }

  private async organizeSingleLlmWikiSource(file: TFile, depth: "light" | "deep"): Promise<void> {
    if (!this.ensureLlmWikiEnabled()) return;
    if (!requireProFeature(this.plugin, "aiWriteback")) return;
    const batchId = this.buildLlmWikiBatchId(depth);
    const batch = new LlmWikiBatchService(this.app, this.plugin.getRoot(), undefined, this.plugin.settings.directoryLanguage);
    const createdFiles: string[] = [];
    const skippedFiles: string[] = [];
    const movedRawFiles: string[] = [];
    const errors: string[] = [];
    let sourceId = file.basename;
    const fs = new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);

    try {
      const source = await this.readLlmWikiSourceForCompile(file, batchId, depth);
      sourceId = source.sourceId;
      const compiler = new LlmWikiCompilerService(this.app, this.plugin.settings, this.plugin.ai);
      const draft = await compiler.compileSourceToDraft(source);
      createdFiles.push(draft.path);
      const movedPath = await this.moveRawInboxSourceToSources(file, fs);
      if (movedPath) movedRawFiles.push(movedPath);
      this.lastKnowledgeFocusPath = draft.path;
      this.expandedKnowledgeSections.add("pipeline-draft");
      new Notice(`${depth === "deep" ? "深度" : "快速"}整理完成，已进入待复核：${draft.path}`, 7000);
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
        modifiedFiles: movedRawFiles,
        skippedFiles,
        errors
      });
    }
    if (createdFiles[0]) {
      await this.render();
      this.focusKnowledgeItem(createdFiles[0]);
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

  private async moveRawInboxSourceToSources(file: TFile, fs: FileSystemService): Promise<string | null> {
    const normalizedPath = this.normalizeLlmWikiPath(file.path);
    const inboxPrefix = this.normalizeLlmWikiPath(fs.path("Knowledge", "LLMWiki", "Raw", "Inbox")).replace(/\/+$/g, "");
    if (!normalizedPath.startsWith(`${inboxPrefix}/`)) return null;

    const targetFolder = fs.path("Knowledge", "LLMWiki", "Raw", "Sources");
    await ensureFolder(this.app, targetFolder);
    const targetPath = this.uniqueSiblingPath(targetFolder, file.name);
    await this.app.vault.rename(file, targetPath);
    return targetPath;
  }

  private uniqueSiblingPath(folderPath: string, filename: string): string {
    const normalizedFolder = folderPath.replace(/\\/g, "/").replace(/\/+$/g, "");
    const dotIndex = filename.lastIndexOf(".");
    const base = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
    const extension = dotIndex > 0 ? filename.slice(dotIndex) : "";
    for (let index = 0; index < 1000; index += 1) {
      const suffix = index === 0 ? "" : `-${index + 1}`;
      const candidate = `${normalizedFolder}/${base}${suffix}${extension}`;
      if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
    }
    return `${normalizedFolder}/${base}-${Date.now()}${extension}`;
  }

  private focusKnowledgeItem(path: string): void {
    const selector = `[data-lifeos-knowledge-path="${this.escapeCssAttribute(path)}"]`;
    window.setTimeout(() => {
      const target = this.containerEl.querySelector(selector) as HTMLElement | null;
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("is-lifeos-knowledge-focus");
      window.setTimeout(() => target.classList.remove("is-lifeos-knowledge-focus"), 2400);
    }, 120);
  }

  private escapeCssAttribute(value: string): string {
    return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  }

  private async readLlmWikiSourceForCompile(file: TFile, batchId: string, depth: LlmWikiCompileDepth): Promise<CompileLlmWikiSourceInput> {
    const markdown = await this.app.vault.read(file);
    const frontmatter = this.parseLlmWikiFrontmatter(markdown);
    const rawContent = stripKeywordLinksSection(this.stripLlmWikiFrontmatter(markdown)).trim();
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
      aiProcessingAllowed: true
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

  private async countPendingLlmWikiDraftFiles(fs: FileSystemService): Promise<number> {
    return (await this.collectPendingLlmWikiDraftFiles(fs)).length;
  }

  private async collectPendingLlmWikiDraftFiles(fs: FileSystemService, limit?: number): Promise<TFile[]> {
    const prefix = `${fs.path("Knowledge", "LLMWiki", "Wiki", "Drafts").replace(/\\/g, "/").replace(/\/+$/g, "")}/`;
    const files = this.app.vault.getMarkdownFiles()
      .filter((file) => {
        const path = file.path.replace(/\\/g, "/");
        return path.startsWith(prefix) && path.endsWith(".md") && file.basename !== "index";
      })
      .sort((a, b) => b.stat.mtime - a.stat.mtime);

    const pending: TFile[] = [];
    for (const file of files) {
      try {
        const markdown = await this.app.vault.read(file);
        if (this.isPendingLlmWikiDraftMarkdown(markdown)) {
          pending.push(file);
        }
      } catch {
        // Ignore unreadable files in the pending queue instead of blocking the view.
      }
      if (typeof limit === "number" && pending.length >= limit) break;
    }
    return pending;
  }

  private isPendingLlmWikiDraftMarkdown(markdown: string): boolean {
    const frontmatter = this.parseLlmWikiFrontmatter(markdown);
    const status = this.normalizeLlmWikiScalar(frontmatter.status || "draft");
    return frontmatter.type === "llm-wiki-draft" && status === "draft";
  }

  private async renderKnowledgeWorkspace(parent: HTMLElement, fs: FileSystemService): Promise<void> {
    const workspace = parent.createDiv({ cls: "lifeos-knowledge-workspace" });
    const primary = workspace.createDiv({ cls: "lifeos-knowledge-primary" });
    const side = workspace.createDiv({ cls: "lifeos-knowledge-side-stack" });

    await this.renderKnowledgeLibrary(primary, fs);
    await this.renderRecent(primary, fs);

    this.renderKnowledgeImportPanel(side, fs);
    this.renderKnowledgeMapPanel(side, fs);
    this.renderKnowledgeReusePanel(side, fs);
    await this.renderKnowledgeOverview(side, fs);
  }

  private renderKnowledgeCategoryGrid(parent: HTMLElement, fs: FileSystemService): void {
    const entries = parent.createDiv({ cls: "lifeos-knowledge-entry-grid lifeos-knowledge-category-grid" });
    this.entryCard(entries, fs, "materials");
    this.entryCard(entries, fs, "books");
    this.entryCard(entries, fs, "mistakes");
  }

  private async renderKnowledgeOverview(parent: HTMLElement, fs: FileSystemService): Promise<void> {
    const card = createCard(parent, "lifeos-panel lifeos-knowledge-overview");
    const head = card.createDiv({ cls: "lifeos-card-title" });
    setIcon(head.createSpan(), "layout-dashboard");
    head.createSpan({ text: "整理队列" });
    card.createEl("p", {
      text: "这里集中显示需要你处理的内容。已经确认写入的正式知识不会再回到待处理列表。"
    });

    const stats = card.createDiv({ cls: "lifeos-llmwiki-stats lifeos-knowledge-overview-stats" });
    this.llmWikiStat(stats, "Draft 待确认", await this.countPendingLlmWikiDraftFiles(fs));
    this.llmWikiStat(stats, "Raw 待整理", this.countFiles(fs.path("Knowledge", "LLMWiki", "Raw", "Inbox")));
    this.llmWikiStat(stats, "长资料", this.countLongSources(fs.path("Knowledge", "LLMWiki", "Raw", "Inbox")));
    this.llmWikiStat(stats, "正式知识", this.countFormalWikiFiles(fs));

  }

  private async renderKnowledgeSidePanel(parent: HTMLElement, fs: FileSystemService): Promise<void> {
    const side = parent.createDiv({ cls: "lifeos-knowledge-side-stack" });
    this.renderKnowledgeImportPanel(side, fs);
    this.renderKnowledgeMapPanel(side, fs);
    this.renderKnowledgeReusePanel(side, fs);
  }

  private renderKnowledgeImportPanel(parent: HTMLElement, fs: FileSystemService): void {
    const card = createCard(parent, "lifeos-panel lifeos-knowledge-import-panel");
    const head = card.createDiv({ cls: "lifeos-card-title" });
    setIcon(head.createSpan(), "upload-cloud");
    head.createSpan({ text: "导入工作台" });
    card.createEl("p", {
      text: "PDF、Word、Web Clipper 和项目文档都从这里进入。网页剪藏先进入收件箱，不会绕过整理和复核。"
    });
    const grid = card.createDiv({ cls: "lifeos-knowledge-import-grid" });
    this.importTile(grid, "PDF / Word", "保存原文件并解析正文", "file-text", () => void this.openKnowledgeImportHub(fs));
    this.importTile(grid, "Web Clipper 收件箱", "抓取网页正文和图片，先进收件箱", "link", () => void this.openKnowledgeImportHub(fs));
    this.importTile(grid, "粘贴文本", "保存片段或读书摘录", "clipboard", () => void this.openNewKnowledgeSourceModal(fs));
    this.importTile(grid, "项目文档", "归入指定项目资料库", "folder-input", () => void this.openKnowledgeImportHub(fs));
  }

  private importTile(parent: HTMLElement, title: string, description: string, icon: string, onClick: () => void): void {
    const tile = parent.createEl("button", { cls: "lifeos-knowledge-import-tile", attr: { type: "button" } });
    tile.onclick = onClick;
    setIcon(tile.createSpan({ cls: "lifeos-status-icon" }), icon);
    const copy = tile.createDiv();
    copy.createEl("strong", { text: title });
    copy.createSpan({ text: description });
  }

  private renderKnowledgeMapPanel(parent: HTMLElement, fs: FileSystemService): void {
    const card = createCard(parent, "lifeos-panel lifeos-knowledge-map-panel");
    const head = card.createDiv({ cls: "lifeos-card-title" });
    setIcon(head.createSpan(), "map");
    head.createSpan({ text: "知识地图" });
    const list = card.createDiv({ cls: "lifeos-knowledge-map-list" });
    this.mapRow(list, "正式知识", String(this.countFormalWikiFiles(fs)), () => void this.openFolderIndex(fs, ["LLMWiki", "Wiki"], "LLM Wiki Wiki", {
      excludeFolders: ["Drafts", "Batches", "Raw", "Trash"]
    }));
    this.mapRow(list, "学习资料", String(this.countFiles(fs.path("Knowledge", "Materials"))), () => void this.openFolderIndex(fs, "Materials", "学习资料"));
    this.mapRow(list, "读书笔记", String(this.countFiles(fs.path("Knowledge", "Books"))), () => void this.openFolderIndex(fs, "Books", "读书笔记"));
    this.mapRow(list, "错题知识点", String(this.countFiles(fs.path("Knowledge", "Mistakes"))), () => void this.openFolderIndex(fs, "Mistakes", "错题知识点"));
  }

  private mapRow(parent: HTMLElement, label: string, count: string, onClick: () => void): void {
    const row = parent.createEl("button", { cls: "lifeos-knowledge-map-row", attr: { type: "button" } });
    row.onclick = onClick;
    row.createSpan({ text: label });
    row.createSpan({ cls: "lifeos-badge", text: count });
  }

  private renderKnowledgeReusePanel(parent: HTMLElement, fs: FileSystemService): void {
    const card = createCard(parent, "lifeos-panel lifeos-knowledge-reuse-panel");
    const head = card.createDiv({ cls: "lifeos-card-title" });
    setIcon(head.createSpan(), "sparkles");
    head.createSpan({ text: "AI 可复用状态" });
    const stats = card.createDiv({ cls: "lifeos-knowledge-reuse-grid" });
    this.llmWikiStat(stats, "正式知识", this.countFormalWikiFiles(fs));
    this.llmWikiStat(stats, "待确认", this.countFiles(fs.path("Knowledge", "LLMWiki", "Wiki", "Drafts")));
    this.llmWikiStat(stats, "Raw", this.countFiles(fs.path("Knowledge", "LLMWiki", "Raw", "Inbox")));
    this.llmWikiStat(stats, "批次", this.countFiles(fs.path("Knowledge", "LLMWiki", "Wiki", "Batches")));
  }

  private async renderKnowledgeLibrary(parent: HTMLElement, fs: FileSystemService): Promise<void> {
    const card = createCard(parent, "lifeos-panel lifeos-knowledge-library");
    const head = card.createDiv({ cls: "lifeos-knowledge-library-head" });
    const copy = head.createDiv();
    const title = copy.createDiv({ cls: "lifeos-card-title" });
    setIcon(title.createSpan(), "list-tree");
    title.createSpan({ text: "资料流水线" });
    copy.createEl("p", {
      text: "资料会按真实状态流转：待整理生成 Draft，待复核确认入库，已入库内容进入知识地图和 AI 检索，不再堆回队列。"
    });
    const actions = head.createDiv({ cls: "lifeos-knowledge-library-actions" });
    createButton(actions, "导入资料", () => void this.openKnowledgeImportHub(fs), { primary: true, icon: "upload-cloud" });
    createButton(actions, "打开目录", () => void this.openIndex(fs), { icon: "folder-open" });

    const sections = await this.collectKnowledgePipelineSections(fs);
    const totalPending = sections.reduce((sum, section) => sum + section.items.length, 0);
    if (totalPending === 0) {
      createEmptyState(card, {
        icon: "check-circle-2",
        title: "资料流水线已清空",
        description: "当前没有待整理、待复核或需复核的资料。新的 PDF、网页、项目文档或 AI 写回会先进入这里。",
        actions: [
          { label: "导入资料", icon: "upload-cloud", primary: true, onClick: () => void this.openKnowledgeImportHub(fs) },
          { label: "打开知识库目录", icon: "folder-open", onClick: () => void this.openIndex(fs) }
        ],
        compact: true
      });
      return;
    }

    const flow = card.createDiv({ cls: "lifeos-knowledge-pipeline-flow" });
    for (const section of sections) {
      this.renderKnowledgePipelineSection(flow, fs, section);
    }
  }

  private renderKnowledgePipelineSection(parent: HTMLElement, fs: FileSystemService, section: KnowledgePipelineSection): void {
    if (section.id === "pipeline-review" && section.items.length === 0) return;
    const panel = parent.createDiv({ cls: `lifeos-knowledge-pipeline-section is-${section.id}` });
    const sectionHead = panel.createDiv({ cls: "lifeos-knowledge-pipeline-section-head" });
    const title = sectionHead.createDiv({ cls: "lifeos-card-title" });
    setIcon(title.createSpan(), section.icon);
    title.createSpan({ text: section.title });
    title.createSpan({ cls: "lifeos-badge", text: String(section.items.length) });
    const sectionActions = sectionHead.createDiv({ cls: "lifeos-knowledge-section-actions" });
    this.renderKnowledgeSectionToggle(sectionActions, section.id, section.items.length, KNOWLEDGE_PENDING_COLLAPSED_LIMIT);
    panel.createEl("p", { cls: "lifeos-knowledge-pipeline-description", text: section.description });

    if (section.items.length === 0) {
      createEmptyState(panel, {
        icon: "check-circle-2",
        title: section.emptyTitle,
        description: section.emptyDescription,
        actions: section.id === "pipeline-raw"
          ? [{ label: "导入资料", icon: "upload-cloud", primary: true, onClick: () => void this.openKnowledgeImportHub(fs) }]
          : [{ label: "打开知识库目录", icon: "folder-open", onClick: () => void this.openIndex(fs) }],
        compact: true
      });
      return;
    }

    const list = panel.createDiv({ cls: "lifeos-knowledge-pipeline-items" });
    const visibleItems = this.knowledgeVisibleItems(section.id, section.items, KNOWLEDGE_PENDING_COLLAPSED_LIMIT);
    for (const item of visibleItems) {
      this.renderKnowledgePipelineItem(list, item);
    }
    this.renderKnowledgeCollapsedHint(panel, section.items.length - visibleItems.length, "条资料");
  }

  private renderKnowledgePipelineItem(parent: HTMLElement, item: KnowledgeLibraryItem): void {
    const row = parent.createDiv({
      cls: `lifeos-knowledge-library-item lifeos-knowledge-pipeline-item is-${item.kind}${item.requiresReview ? " needs-review" : ""}`,
      attr: { "data-lifeos-knowledge-path": item.file.path }
    });
    if (this.lastKnowledgeFocusPath === item.file.path) {
      row.classList.add("is-lifeos-knowledge-focus");
    }
    const top = row.createDiv({ cls: "lifeos-knowledge-library-item-top" });
    top.createSpan({ cls: "lifeos-badge lifeos-knowledge-library-kind", text: item.badge });
    top.createSpan({ cls: "lifeos-knowledge-library-meta", text: new Date(item.file.stat.mtime).toLocaleString() });
    row.createDiv({ cls: "lifeos-history-title", text: item.title });
    row.createDiv({ cls: "lifeos-history-subtitle", text: item.subtitle });
    if (item.reviewReason) {
      row.createDiv({ cls: "lifeos-knowledge-review-reason", text: item.reviewReason });
    }
    row.createDiv({ cls: "lifeos-knowledge-snippet", text: item.snippet || "暂无摘要，可打开查看。" });
    const rowActions = row.createDiv({ cls: "lifeos-knowledge-item-actions" });
    if (item.kind === "draft") {
      createButton(rowActions, "确认入库", () => void this.acceptLlmWikiDraft(item.file.path), { primary: true, icon: "git-merge" });
      createButton(rowActions, "暂不入库", () => void this.skipLlmWikiDraft(item.file.path), { icon: "archive-x" });
    } else if (item.kind === "raw" && !item.requiresReview) {
      const isLong = item.file.stat.size > 4000;
      createButton(rowActions, isLong ? "深度整理" : "整理成草稿", () => void this.organizeSingleLlmWikiSource(item.file, isLong ? "deep" : "light"), { primary: true, icon: isLong ? "brain-circuit" : "sparkles" });
    }
    createButton(rowActions, "打开", () => void this.app.workspace.getLeaf(false).openFile(item.file), { icon: "file-text" });
  }

  private async collectKnowledgePipelineSections(fs: FileSystemService): Promise<KnowledgePipelineSection[]> {
    const rawItems = await this.collectFilesFromKnowledgeSection(fs, ["Knowledge", "LLMWiki", "Raw", "Inbox"], "raw", "待整理", "资料收件箱，刚保存但还没有整理成草稿。", 20);
    const draftItems = await this.collectPendingDraftKnowledgeItems(fs, 20);
    const readyRaw = rawItems;
    const reviewItems: KnowledgeLibraryItem[] = [];
    const readyDrafts = draftItems;

    return [
      {
        id: "pipeline-raw",
        icon: "inbox",
        title: "待整理",
        description: "这里是真正还没有进入 AI 整理的资料。整理成功后会生成 Draft，并从这里移走。",
        items: readyRaw,
        emptyTitle: readyDrafts.length > 0 ? "待整理已清空" : "还没有待整理资料",
        emptyDescription: readyDrafts.length > 0 ? "下一步是复核已生成的 Draft。" : "导入 PDF、Word、网页或文本后，会先进入这里。"
      },
      {
        id: "pipeline-draft",
        icon: "file-check-2",
        title: "待复核",
        description: "AI 已经整理成 Draft，但还不会自动进入正式知识库。确认后才会写入并进入 AI 检索。",
        items: readyDrafts,
        emptyTitle: readyRaw.length > 0 ? "还没有 Draft" : "待复核已清空",
        emptyDescription: readyRaw.length > 0 ? "先整理左侧资料，系统会把新 Draft 放到这里。" : "当前没有需要确认入库的 Draft。"
      },
      {
        id: "pipeline-review",
        icon: "shield-alert",
        title: "需复核",
        description: "需要人工判断的资料会停在这里。敏感标签只作为提示，不再阻止整理或入库。",
        items: reviewItems,
        emptyTitle: "没有需要特别复核的资料",
        emptyDescription: "这里会显示需要人工判断的内容；普通敏感标签不会再拦截入库。"
      }
    ];
  }

  private async collectPendingDraftKnowledgeItems(fs: FileSystemService, limit?: number): Promise<KnowledgeLibraryItem[]> {
    const formatter = new DisplayFormatService();
    const items: KnowledgeLibraryItem[] = [];
    for (const file of await this.collectPendingLlmWikiDraftFiles(fs, limit)) {
      const content = await this.app.vault.read(file);
      const blocks = await formatter.formatKnowledgeSnippetForDisplay(content, file.path);
      items.push({
        file,
        kind: "draft",
        title: file.basename,
        subtitle: `AI 已整理，等待你确认发布或合并。 · ${file.path}`,
        badge: "待复核 Draft",
        snippet: blocks[0]?.text || this.stripLlmWikiFrontmatter(content).split(/\r?\n/).find((line) => line.trim()) || "",
        requiresReview: false
      });
    }
    return items;
  }

  private async collectFilesFromKnowledgeSection(
    fs: FileSystemService,
    parts: string[],
    kind: KnowledgeLibraryKind,
    badge: string,
    subtitle: string,
    limit?: number
  ): Promise<KnowledgeLibraryItem[]> {
    const prefix = `${fs.path(...parts).replace(/\\/g, "/").replace(/\/+$/g, "")}/`;
    const formalSeedFiles = new Set([
      this.normalizeLlmWikiPath(fs.path("Knowledge", "LLMWiki", "Wiki", "hot.md")),
      this.normalizeLlmWikiPath(fs.path("Knowledge", "LLMWiki", "Wiki", "log.md"))
    ]);
    const formalExcludedPrefixes = this.normalizedPathPrefixes([
      fs.path("Knowledge", "LLMWiki", "Wiki", "Drafts"),
      fs.path("Knowledge", "LLMWiki", "Wiki", "Batches"),
      fs.path("Knowledge", "LLMWiki", "Raw"),
      fs.path("Knowledge", "LLMWiki", "Trash")
    ]);
    const manualExcludedPrefixes = this.normalizedPathPrefixes([
      fs.path("Knowledge", "LLMWiki")
    ]);
    const files = this.app.vault.getMarkdownFiles()
      .filter((file) => {
        const path = file.path.replace(/\\/g, "/");
        if (!path.startsWith(prefix) || !path.endsWith(".md") || file.basename === "index") return false;
        const normalizedPath = this.normalizeLlmWikiPath(path);
        if (kind === "formal" && formalSeedFiles.has(normalizedPath)) return false;
        if (kind === "formal" && this.isUnderAnyNormalizedPrefix(normalizedPath, formalExcludedPrefixes)) return false;
        if (kind === "manual" && this.isUnderAnyNormalizedPrefix(normalizedPath, manualExcludedPrefixes)) return false;
        return true;
      })
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, limit ?? (kind === "manual" ? 8 : 6));

    const formatter = new DisplayFormatService();
    const items: KnowledgeLibraryItem[] = [];
    for (const file of files) {
      const content = await this.app.vault.read(file);
      const requiresReview = false;
      const blocks = await formatter.formatKnowledgeSnippetForDisplay(content, file.path);
      items.push({
        file,
        kind,
        title: file.basename,
        subtitle: `${subtitle} · ${file.path}`,
        badge,
        snippet: blocks[0]?.text || this.stripLlmWikiFrontmatter(content).split(/\r?\n/).find((line) => line.trim()) || "",
        requiresReview
      });
    }
    return items;
  }

  private countVisibleKnowledgeFiles(fs: FileSystemService): number {
    const prefix = `${fs.path("Knowledge").replace(/\\/g, "/").replace(/\/+$/g, "")}/`;
    const excludedPrefixes = this.normalizedPathPrefixes([
      fs.path("Knowledge", "LLMWiki", "Wiki", "Batches"),
      fs.path("Knowledge", "LLMWiki", "Trash"),
      fs.path("Knowledge", "LLMWiki", "Reports"),
      fs.path("Knowledge", "LLMWiki", "Schema")
    ]);
    return this.app.vault.getMarkdownFiles()
      .filter((file) => {
        const path = file.path.replace(/\\/g, "/");
        return path.startsWith(prefix)
          && path.endsWith(".md")
          && file.basename !== "index"
          && !this.isUnderAnyNormalizedPrefix(this.normalizeLlmWikiPath(path), excludedPrefixes);
      })
      .length;
  }

  private countFormalWikiFiles(fs: FileSystemService): number {
    const prefix = `${fs.path("Knowledge", "LLMWiki", "Wiki").replace(/\\/g, "/").replace(/\/+$/g, "")}/`;
    const excludedPrefixes = this.normalizedPathPrefixes([
      fs.path("Knowledge", "LLMWiki", "Wiki", "Drafts"),
      fs.path("Knowledge", "LLMWiki", "Wiki", "Batches"),
      fs.path("Knowledge", "LLMWiki", "Trash")
    ]);
    return this.app.vault.getMarkdownFiles()
      .filter((file) => {
        const path = file.path.replace(/\\/g, "/");
        return path.startsWith(prefix)
          && path.endsWith(".md")
          && file.basename !== "index"
          && !this.isUnderAnyNormalizedPrefix(this.normalizeLlmWikiPath(path), excludedPrefixes);
      })
      .length;
  }

  private normalizedPathPrefixes(paths: string[]): string[] {
    return paths.map((path) => this.normalizeLlmWikiPath(path).replace(/\/+$/g, ""));
  }

  private isUnderAnyNormalizedPrefix(path: string, prefixes: string[]): boolean {
    return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  }

  private entryCard(parent: HTMLElement, fs: FileSystemService, kind: KnowledgeCategoryKind): void {
    const meta = KNOWLEDGE_CATEGORY_META[kind];
    const folderPath = fs.path("Knowledge", meta.folder);
    const recent = this.latestKnowledgeFileInFolder(folderPath);
    const count = this.countFiles(folderPath);
    const card = createCard(parent, "lifeos-feature-card lifeos-knowledge-entry");
    const head = card.createDiv({ cls: "lifeos-card-title" });
    setIcon(head.createSpan(), meta.icon);
    head.createSpan({ text: meta.label });
    card.createEl("p", { text: meta.description });
    const metaGrid = card.createDiv({ cls: "lifeos-knowledge-category-meta" });
    const countCell = metaGrid.createDiv({ cls: "lifeos-knowledge-category-stat" });
    countCell.createSpan({ cls: "lifeos-knowledge-category-value", text: String(count) });
    countCell.createSpan({ text: "条资料" });
    const recentCell = metaGrid.createDiv({ cls: "lifeos-knowledge-category-recent" });
    recentCell.createSpan({ cls: "lifeos-muted-text", text: "最近" });
    recentCell.createSpan({ text: recent?.basename ?? "暂无资料" });
    const actions = card.createDiv({ cls: "lifeos-knowledge-category-actions" });
    createButton(actions, "管理", () => void this.openFolderIndex(fs, meta.folder, meta.label), { primary: true, icon: "folder-open" });
    createButton(actions, "新建", () => void this.openNewKnowledgeSourceModal(fs, { defaultKind: kind, mode: "note" }), { icon: "plus" });
  }

  private latestKnowledgeFileInFolder(folderPath: string): TFile | null {
    const prefix = `${folderPath.replace(/\\/g, "/").replace(/\/+$/g, "")}/`;
    return this.app.vault.getMarkdownFiles()
      .filter((file) => {
        const path = file.path.replace(/\\/g, "/");
        return path.startsWith(prefix) && path.endsWith(".md") && file.basename !== "index";
      })
      .sort((a, b) => b.stat.mtime - a.stat.mtime)[0] ?? null;
  }

  private async renderRecent(parent: HTMLElement, fs: FileSystemService): Promise<void> {
    const card = createCard(parent, "lifeos-panel lifeos-knowledge-recent lifeos-knowledge-recent-full");
    const sectionHead = card.createDiv({ cls: "lifeos-knowledge-section-head" });
    const head = sectionHead.createDiv({ cls: "lifeos-card-title" });
    setIcon(head.createSpan(), "clock");
    head.createSpan({ text: "最近整理" });
    const sectionActions = sectionHead.createDiv({ cls: "lifeos-knowledge-section-actions" });
    card.createEl("p", { text: "最近创建或修改的知识内容会显示在这里。" });
    const prefix = fs.path("Knowledge").replace(/\\/g, "/").replace(/\/+$/g, "") + "/";
    const excludedPrefixes = this.normalizedPathPrefixes([
      fs.path("Knowledge", "LLMWiki", "Raw"),
      fs.path("Knowledge", "LLMWiki", "Wiki", "Drafts"),
      fs.path("Knowledge", "LLMWiki", "Wiki", "Batches"),
      fs.path("Knowledge", "LLMWiki", "Trash")
    ]);
    const files = this.app.vault.getMarkdownFiles()
      .filter((file) => {
        const path = file.path.replace(/\\/g, "/");
        return path.startsWith(prefix)
          && file.basename !== "index"
          && !this.removedRecentKnowledgePaths.has(path)
          && !this.isUnderAnyNormalizedPrefix(this.normalizeLlmWikiPath(path), excludedPrefixes);
      })
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
      const row = card.createDiv({ cls: "lifeos-history-item lifeos-knowledge-row lifeos-knowledge-managed-row" });
      row.setAttr("role", "button");
      row.setAttr("tabindex", "0");
      row.setAttr("data-lifeos-knowledge-path", file.path);
      const category = this.categoryLabel(file.path);
      row.createSpan({ cls: "lifeos-history-title", text: file.basename });
      row.createSpan({ cls: "lifeos-history-subtitle", text: `${category} · ${new Date(file.stat.mtime).toLocaleString()}` });
      renderMarkdownDisplay(this.app, this, row.createDiv({ cls: "lifeos-knowledge-snippet" }), blocks[0]?.text || "暂无摘要，可打开查看。", file.path);
      const actions = row.createDiv({ cls: "lifeos-knowledge-row-actions" });
      createButton(actions, "打开", () => void this.openManagedKnowledgeFile(file), { ghost: true, icon: "external-link" })
        .setAttr("aria-label", `打开 ${file.basename}`);
      createButton(actions, "重命名", () => void this.renameManagedKnowledgeFile(file), { ghost: true, icon: "pencil" })
        .setAttr("aria-label", `重命名 ${file.basename}`);
      createButton(actions, "移除", () => void this.trashManagedKnowledgeFile(file), { ghost: true, icon: "trash-2" })
        .setAttr("aria-label", `移除 ${file.basename}`);
      row.onclick = (event) => {
        if (this.isKnowledgeRowActionEvent(event)) return;
        void this.openManagedKnowledgeFile(file);
      };
      row.onkeydown = (event) => {
        if (this.isKnowledgeRowActionEvent(event)) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        void this.openManagedKnowledgeFile(file);
      };
    }
    this.renderKnowledgeCollapsedHint(card, files.length - visibleFiles.length, "条最近内容");
  }

  private isKnowledgeRowActionEvent(event: Event): boolean {
    const target = event.target;
    return target instanceof HTMLElement && Boolean(target.closest("button, a, input, textarea, select"));
  }

  private async openManagedKnowledgeFile(file: TFile): Promise<void> {
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private async renameManagedKnowledgeFile(file: TFile): Promise<void> {
    if (!requireProFeature(this.plugin, "knowledgeManagement")) return;
    const nextTitle = window.prompt("新的资料标题", file.basename);
    const trimmed = nextTitle?.trim();
    if (!trimmed || trimmed === file.basename) return;
    try {
      const nextPath = this.uniqueManagedKnowledgeRenamePath(file, trimmed);
      await this.app.fileManager.renameFile(file, nextPath);
      new Notice("资料已重命名。", 4000);
      await this.render();
      this.focusKnowledgeItem(nextPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`重命名资料失败：${message}`, 7000);
    }
  }

  private uniqueManagedKnowledgeRenamePath(file: TFile, title: string): string {
    const parentPath = file.parent?.path.replace(/\\/g, "/").replace(/\/+$/g, "") ?? "";
    const base = this.sanitizeKnowledgeTitle(title);
    for (let index = 0; index < 100; index += 1) {
      const suffix = index === 0 ? "" : `-${index + 1}`;
      const candidate = parentPath ? `${parentPath}/${base}${suffix}.md` : `${base}${suffix}.md`;
      const existing = this.app.vault.getAbstractFileByPath(candidate);
      if (!existing || existing === file) return candidate;
    }
    return parentPath ? `${parentPath}/${base}-${Date.now()}.md` : `${base}-${Date.now()}.md`;
  }

  private async trashManagedKnowledgeFile(file: TFile): Promise<void> {
    if (!requireProFeature(this.plugin, "knowledgeManagement")) return;
    if (!window.confirm(`确认将「${file.basename}」移到 Obsidian 回收站吗？`)) return;
    try {
      this.removedRecentKnowledgePaths.add(file.path.replace(/\\/g, "/"));
      await this.app.vault.trash(file, true);
      new Notice("资料已移到 Obsidian 回收站。", 4000);
      await this.render();
    } catch (error) {
      this.removedRecentKnowledgePaths.delete(file.path.replace(/\\/g, "/"));
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`移除资料失败：${message}`, 7000);
    }
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
    if (path.includes("/Materials/")) return KNOWLEDGE_CATEGORY_META.materials.label;
    if (path.includes("/Books/")) return KNOWLEDGE_CATEGORY_META.books.label;
    if (path.includes("/Mistakes/")) return KNOWLEDGE_CATEGORY_META.mistakes.label;
    return "知识笔记";
  }

  private async openKnowledgeImportHub(fs: FileSystemService): Promise<void> {
    if (!requireProFeature(this.plugin, "knowledgeImport")) return;
    const projects = await new ProjectService(this.app, fs).loadProjects();
    new KnowledgeImportHubModal(this.app, projects, {
      importFiles: async (files, privacy, destination, projectId) => {
        if (destination === "project") {
          const imported = await this.importKnowledgeFilesToProject(fs, files, projectId);
          new Notice(`已导入 ${imported.length} 个项目文档。`, 6000);
          const firstPath = imported[0]?.document.path;
          const first = firstPath ? this.app.vault.getAbstractFileByPath(firstPath) : null;
          if (first instanceof TFile) await this.app.workspace.getLeaf(false).openFile(first);
          await this.render();
          return;
        }
        const imported = await this.importKnowledgeFiles(fs, files, privacy, destination);
        const destinationLabel = this.captureDestinationLabel(destination);
        new Notice(`已导入 ${imported.length} 个资料文件到「${destinationLabel}」。`, 6000);
        const first = imported[0];
        if (first) await this.app.workspace.getLeaf(false).openFile(first);
        await this.render();
      },
      importUrl: async (url, title, privacy, destination, clipMode, _projectId) => {
        if (destination !== "raw") {
          new Notice(`Web Clipper 会先进入资料收件箱，不会直接写入「${this.captureDestinationLabel(destination)}」。整理成 Draft 后再选择最终分类或项目。`, 7000);
        }
        const file = await this.importKnowledgeUrl(fs, url, title, privacy, clipMode);
        new Notice(`网页剪藏已进入 Web Clipper 收件箱：${file.path}`, 6000);
        await this.render();
        this.focusKnowledgeItem(file.path);
      },
      pasteText: (destination, projectId) => void this.openNewKnowledgeSourceModal(fs, { defaultKind: destination, defaultProjectId: projectId }),
      importProjectDocuments: (projectId) => void this.openProjectDocumentImportFromKnowledge(fs, projectId)
    }).open();
  }

  private async openProjectDocumentImportFromKnowledge(fs: FileSystemService, projectId?: string): Promise<void> {
    if (!requireProFeature(this.plugin, "projectDocuments")) return;
    const projects = await new ProjectService(this.app, fs).loadProjects();
    const selected = projectId
      ? projects.find((project) => project.id === projectId) ?? null
      : projects[0] ?? null;
    if (!selected) {
      new Notice("还没有项目。请先到任务页新增项目，再导入项目文档。", 6000);
      return;
    }
    const service = new ProjectDocumentService(this.app, fs);
    new ImportProjectDocumentsModal(this.app, selected, service, async (documents) => {
      new Notice(`已导入 ${documents.length} 个项目文档到「${selected.name}」。`, 6000);
      const first = documents[0]?.document;
      if (!first) return;
      const file = this.app.vault.getAbstractFileByPath(first.path);
      if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
      await this.render();
    }).open();
  }

  private async importKnowledgeFiles(
    fs: FileSystemService,
    files: File[],
    privacy: KnowledgePrivacyChoice,
    destination: Exclude<KnowledgeCaptureKind, "project"> = "raw"
  ): Promise<TFile[]> {
    if (!requireProFeature(this.plugin, "knowledgeImport")) throw new Error("此功能需要 Pro 授权。");
    if (files.length === 0) throw new Error("请先选择要导入的文件。");
    const importedFiles: TFile[] = [];
    const pdfOcr = new PdfOcrService(this.app);
    for (const sourceFile of files) {
      const saved = await saveImportedFileToVault(this.app, sourceFile, {
        folderPath: fs.path("Knowledge", "Attachments", "Imports")
      });
      const document = await readImportedFile(sourceFile, {
        maxBytes: 50 * 1024 * 1024,
        allowImageVision: false,
        maxTextChars: null,
        enablePdfOcr: true,
        pdfOcr
      });
      document.vaultPath = saved.vaultPath;
      document.obsidianLink = saved.obsidianLink;
      const title = sourceFile.name.replace(/\.[^.]+$/u, "") || sourceFile.name;
      const content = this.importedKnowledgeDocumentMarkdown(document);
      importedFiles.push(destination === "raw"
        ? await this.createRawLlmWikiSource(fs, {
          title,
          content,
          privacy,
          sourceKind: "local_file",
          sourcePath: saved.vaultPath
        })
        : await this.createKnowledgeSourceFromModal(fs, {
          title,
          content,
          privacy,
          kind: destination,
          sourceKind: "local_file",
          sourcePath: saved.vaultPath
        }));
    }
    return importedFiles;
  }

  private async importKnowledgeFilesToProject(fs: FileSystemService, files: File[], projectId?: string) {
    if (!requireProFeature(this.plugin, "projectDocuments")) throw new Error("此功能需要 Pro 授权。");
    if (files.length === 0) throw new Error("请先选择要导入的文件。");
    const project = await this.requireProjectForDestination(fs, projectId);
    const service = new ProjectDocumentService(this.app, fs);
    return service.importDocuments(project, files);
  }

  private async importKnowledgeUrl(
    fs: FileSystemService,
    url: string,
    title: string,
    privacy: KnowledgePrivacyChoice,
    clipMode: KnowledgeWebClipMode = "text"
  ): Promise<TFile> {
    if (!requireProFeature(this.plugin, clipMode === "text-images" ? "webClipper" : "knowledgeImport")) {
      throw new Error("此功能需要 Pro 授权。");
    }
    let content = await fetchReadableUrl(url, (targetUrl, options) => this.requestWebContext(targetUrl, options), 20000);
    const inferredTitle = title.trim() || this.inferImportedUrlTitle(content, url);
    if (clipMode === "text-images") {
      content = await this.buildWebClipContentWithImages(fs, url, inferredTitle, content);
    }
    return this.createRawLlmWikiSource(fs, {
      title: inferredTitle,
      content: this.buildWebClipInboxMarkdown(url, inferredTitle, content, clipMode),
      privacy,
      sourceKind: "web_clipper",
      originalUrl: url
    });
  }

  private buildWebClipInboxMarkdown(url: string, title: string, content: string, clipMode: KnowledgeWebClipMode): string {
    return [
      `# ${title}`,
      "",
      "## Web Clipper 收件箱",
      "",
      "- 状态：已进入资料流水线 Raw Inbox。",
      "- 下一步：在知识库页面执行 AI 批量整理，生成 Draft 后再复核写入正式知识、学习资料、读书笔记、错题知识点或项目文档。",
      `- 原始链接：${url}`,
      `- 剪藏模式：${clipMode === "text-images" ? "图文剪藏（正文 + 本地图片附件）" : "纯文本剪藏"}`,
      "",
      "## 可检索正文",
      "",
      content.trim() || "当前没有抓取到可检索正文。",
      ""
    ].join("\n");
  }

  private async buildWebClipContentWithImages(
    fs: FileSystemService,
    url: string,
    title: string,
    content: string
  ): Promise<string> {
    let html = "";
    try {
      html = (await this.requestWebContext(url, {
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.7",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      })).text;
    } catch (error) {
      return this.appendWebClipNotice(content, [`网页正文已保存，但原始 HTML 获取失败，未能下载图片：${this.errorMessage(error)}`]);
    }

    const candidates = this.extractWebClipImageCandidates(html, url).slice(0, 30);
    if (candidates.length === 0) return this.appendWebClipNotice(content, ["没有在网页 HTML 中找到可下载图片。"]);

    const savedImages: SavedWebClipImage[] = [];
    const failures: string[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      try {
        const saved = await this.downloadWebClipImage(fs, candidate, url, title, index);
        if (saved) savedImages.push(saved);
      } catch (error) {
        failures.push(`${candidate.url}：${this.errorMessage(error)}`);
      }
    }

    if (savedImages.length === 0) {
      return this.appendWebClipNotice(content, failures.length > 0
        ? failures.slice(0, 5).map((item) => `图片下载失败：${item}`)
        : ["没有成功保存网页图片。"]);
    }
    return this.rewriteWebClipContent(content, savedImages, failures);
  }

  private extractWebClipImageCandidates(html: string, baseUrl: string): WebClipImageCandidate[] {
    const candidates: WebClipImageCandidate[] = [];
    const seen = new Set<string>();
    const tagRe = /<img\b[^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = tagRe.exec(html)) !== null) {
      const tag = match[0];
      const alt = this.decodeHtmlAttribute(this.htmlAttribute(tag, "alt") || "");
      const urls = this.webClipImageUrlsFromTag(tag, baseUrl);
      for (const imageUrl of urls) {
        if (seen.has(imageUrl)) continue;
        seen.add(imageUrl);
        candidates.push({ url: imageUrl, alt });
      }
    }

    const markdownImageRe = /!\[[^\]]*]\((https?:\/\/[^)\s]+)(?:\s+["'][^)]*["'])?\)/gi;
    while ((match = markdownImageRe.exec(html)) !== null) {
      const imageUrl = this.normalizeWebClipImageUrl(match[1], baseUrl);
      if (!imageUrl || seen.has(imageUrl)) continue;
      seen.add(imageUrl);
      candidates.push({ url: imageUrl, alt: "" });
    }
    return candidates;
  }

  private webClipImageUrlsFromTag(tag: string, baseUrl: string): string[] {
    const rawUrls: string[] = [];
    for (const attribute of ["src", "data-src", "data-original", "data-lazy-src", "data-actualsrc"]) {
      const value = this.htmlAttribute(tag, attribute);
      if (value) rawUrls.push(value);
    }
    for (const attribute of ["srcset", "data-srcset"]) {
      const value = this.htmlAttribute(tag, attribute);
      const best = value ? this.bestSrcsetImageUrl(value) : "";
      if (best) rawUrls.push(best);
    }
    return rawUrls
      .map((rawUrl) => this.normalizeWebClipImageUrl(rawUrl, baseUrl))
      .filter((imageUrl): imageUrl is string => Boolean(imageUrl));
  }

  private async downloadWebClipImage(
    fs: FileSystemService,
    candidate: WebClipImageCandidate,
    pageUrl: string,
    title: string,
    index: number
  ): Promise<SavedWebClipImage | null> {
    const response = await requestUrl({
      url: candidate.url,
      method: "GET",
      headers: {
        "Accept": "image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif,image/*,*/*;q=0.8",
        "Referer": pageUrl,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`图片请求失败，HTTP ${response.status}`);
    }
    const contentType = this.headerValue(response.headers, "content-type").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) throw new Error(`响应不是图片：${contentType || "unknown"}`);
    if (contentType === "image/svg+xml") throw new Error("为安全起见，暂不保存 SVG 图片。");
    if (!response.arrayBuffer || response.arrayBuffer.byteLength === 0) throw new Error("图片为空。");
    if (response.arrayBuffer.byteLength > 15 * 1024 * 1024) throw new Error("图片超过 15MB，已跳过。");

    const folderPath = fs.path("Knowledge", "Attachments", "WebClips", today(), this.sanitizeKnowledgeTitle(title));
    const fileName = this.webClipImageFileName(candidate.url, contentType, index);
    const saved = await saveImportedFileToVault(this.app, {
      name: fileName,
      type: contentType,
      size: response.arrayBuffer.byteLength,
      arrayBuffer: async () => response.arrayBuffer
    }, { folderPath });
    const actualFileName = saved.vaultPath.split("/").pop() || fileName;
    return {
      ...candidate,
      vaultPath: saved.vaultPath,
      fileName: actualFileName,
      embed: `![[${actualFileName}]]`
    };
  }

  private rewriteWebClipContent(content: string, savedImages: SavedWebClipImage[], failures: string[]): string {
    let nextContent = content.trim();
    for (const image of savedImages) {
      const imageUrl = this.escapeRegExp(image.url);
      nextContent = nextContent.replace(
        new RegExp(`!\\[[^\\]]*\\]\\(${imageUrl}(?:\\s+["'][^)]*["'])?\\)`, "g"),
        image.embed
      );
    }

    const missingImages = savedImages.filter((image) => !nextContent.includes(image.embed));
    if (missingImages.length > 0) {
      nextContent = [
        nextContent,
        "",
        "## Web Clipper 本地图片",
        "",
        ...missingImages.flatMap((image, index) => [
          `${index + 1}. ${image.alt ? `${image.alt} ` : ""}${image.embed}`,
          `   - 原图：${image.url}`
        ])
      ].join("\n").trim();
    }

    if (failures.length > 0) {
      nextContent = this.appendWebClipNotice(nextContent, [
        `已保存 ${savedImages.length} 张图片，另有 ${failures.length} 张下载失败。`,
        ...failures.slice(0, 5).map((item) => `图片下载失败：${item}`)
      ]);
    }
    return nextContent;
  }

  private appendWebClipNotice(content: string, notes: string[]): string {
    return [
      content.trim(),
      "",
      "## Web Clipper 收件箱说明",
      "",
      ...notes.map((note) => `- ${note}`),
      ""
    ].join("\n").trim();
  }

  private htmlAttribute(tag: string, name: string): string | null {
    const escapedName = this.escapeRegExp(name);
    const match = tag.match(new RegExp(`\\s${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
  }

  private bestSrcsetImageUrl(srcset: string): string {
    const entries = srcset
      .split(",")
      .map((entry) => entry.trim().split(/\s+/u)[0])
      .filter(Boolean);
    return entries[entries.length - 1] || "";
  }

  private normalizeWebClipImageUrl(rawUrl: string, baseUrl: string): string | null {
    const cleaned = this.decodeHtmlAttribute(rawUrl).trim().replace(/^["']|["']$/g, "");
    if (!cleaned || /^(data|blob|javascript|about):/iu.test(cleaned)) return null;
    try {
      const parsed = new URL(cleaned, baseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      if (this.isPrivateOrLocalWebClipHostname(parsed.hostname)) return null;
      parsed.hash = "";
      return parsed.href;
    } catch {
      return null;
    }
  }

  private webClipImageFileName(url: string, contentType: string, index: number): string {
    const extension = this.webClipImageExtension(url, contentType);
    let baseName = "";
    try {
      const parsed = new URL(url);
      baseName = decodeURIComponent(parsed.pathname.split("/").pop() || "");
    } catch {
      baseName = "";
    }
    baseName = baseName.replace(/\.[a-z0-9]{2,5}$/iu, "");
    const safeBase = this.sanitizeKnowledgeTitle(baseName || `web-image-${index + 1}`);
    return `${String(index + 1).padStart(2, "0")}-${safeBase}.${extension}`;
  }

  private webClipImageExtension(url: string, contentType: string): string {
    const mime = contentType.toLowerCase();
    if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
    if (mime.includes("png")) return "png";
    if (mime.includes("webp")) return "webp";
    if (mime.includes("gif")) return "gif";
    if (mime.includes("avif")) return "avif";
    try {
      const extension = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/iu)?.[1]?.toLowerCase();
      if (extension && ["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(extension)) {
        return extension === "jpeg" ? "jpg" : extension;
      }
    } catch {
      // ignore and use a safe default below
    }
    return "png";
  }

  private headerValue(headers: Record<string, string>, name: string): string {
    const lowerName = name.toLowerCase();
    const key = Object.keys(headers || {}).find((item) => item.toLowerCase() === lowerName);
    return key ? headers[key] : "";
  }

  private decodeHtmlAttribute(text: string): string {
    return String(text || "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&#x([0-9a-f]+);/giu, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }

  private isPrivateOrLocalWebClipHostname(hostname: string): boolean {
    const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!clean || clean === "localhost" || clean.endsWith(".localhost") || clean.endsWith(".local")) return true;
    if (clean === "::1" || clean.startsWith("fe80:") || clean.startsWith("fc") || clean.startsWith("fd")) return true;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(clean)) return this.isPrivateWebClipIpv4(clean);
    return false;
  }

  private isPrivateWebClipIpv4(ip: string): boolean {
    const parts = ip.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = parts;
    return a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async requestWebContext(url: string, options: WebContextRequestOptions = {}): Promise<{ text: string; status?: number }> {
    const response = await requestUrl({
      url,
      method: options.method ?? "GET",
      headers: options.headers
    });
    return { text: response.text, status: response.status };
  }

  private async createRawLlmWikiSource(
    fs: FileSystemService,
    input: {
      title: string;
      content: string;
      privacy: KnowledgePrivacyChoice;
      sourceKind: LlmWikiSourceKind;
      originalUrl?: string;
      sourcePath?: string;
    }
  ): Promise<TFile> {
    const title = input.title.trim() || "未命名资料";
    const createdAt = new Date().toISOString();
    const batchId = `knowledge_import_${createdAt.replace(/\D/g, "").slice(0, 12)}`;
    const id = `src_${createdAt.replace(/\D/g, "").slice(0, 12)}_${simpleLlmWikiHash(`${title}${input.content}`)}`;
    const path = this.uniqueKnowledgePath(fs, ["LLMWiki", "Raw", "Inbox"], `${createdAt.slice(0, 10)}-${this.sanitizeKnowledgeTitle(title)}-${id}.md`);
    return ensureFile(this.app, path, buildLlmWikiSourceMarkdown({
      id,
      title,
      sourceKind: input.sourceKind,
      content: input.content.trim() || "这条资料还没有可检索正文。",
      originalUrl: input.originalUrl,
      sourcePath: input.sourcePath,
      capturedAt: createdAt,
      privacyLevel: input.privacy,
      aiProcessingAllowed: true,
      batchId,
      status: "inbox"
    }));
  }

  private importedKnowledgeDocumentMarkdown(document: ImportedDocument): string {
    const lines = [
      `# ${document.name}`,
      "",
      "## 导入文件",
      "",
      `- 文件名：${document.name}`,
      `- 类型：${document.kind}`,
      `- 大小：${formatAttachmentSize(document.size)}`,
      document.obsidianLink ? `- 附件：${document.obsidianLink}` : "",
      document.vaultPath ? `- 附件路径：${document.vaultPath}` : "",
      ""
    ].filter(Boolean);
    if (document.warnings.length > 0) {
      lines.push("## 导入说明", "", ...document.warnings.map((warning) => `- ${warning}`), "");
    }
    lines.push("## 可检索正文", "", document.text.trim() || "当前没有提取到可检索正文。", "");
    return lines.join("\n");
  }

  private importedUrlKnowledgeMarkdown(url: string, content: string): string {
    return [
      "## 来源",
      "",
      `- 网页链接：${url}`,
      "",
      "## 可检索正文",
      "",
      content.trim() || "当前没有抓取到可检索正文。",
      ""
    ].join("\n");
  }

  private inferImportedUrlTitle(content: string, url: string): string {
    const title = content.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
    if (title) return title.slice(0, 80);
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "网页资料";
    }
  }

  private async openNewKnowledgeSourceModal(
    fs: FileSystemService,
    options: NewKnowledgeSourceModalOptions = {}
  ): Promise<void> {
    if (!requireProFeature(this.plugin, "knowledgeManagement")) return;
    const projects = await new ProjectService(this.app, fs).loadProjects();
    const input = await openNewKnowledgeSourceModal(this.app, projects, options);
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
    if (!requireProFeature(this.plugin, input.kind === "project" ? "projectDocuments" : "knowledgeManagement")) {
      throw new Error("此功能需要 Pro 授权。");
    }
    const title = input.title.trim() || "未命名资料";
    const slug = this.sanitizeKnowledgeTitle(title);
    const createdAt = new Date().toISOString();
    const privacy = input.privacy || "normal";
    const aiProcessingAllowed = "true";

    if (input.kind === "raw") {
      return this.createRawLlmWikiSource(fs, {
        title,
        content: input.content.trim() || "在这里补充资料正文。",
        privacy,
        sourceKind: input.sourceKind || "manual_markdown",
        originalUrl: input.originalUrl,
        sourcePath: input.sourcePath
      });
    }

    if (input.kind === "project") {
      const project = await this.requireProjectForDestination(fs, input.projectId);
      const service = new ProjectDocumentService(this.app, fs);
      const document = await service.createDocument(project, {
        title,
        kind: "note",
        content: input.content.trim() || "在这里补充项目资料正文。"
      });
      const file = this.app.vault.getAbstractFileByPath(document.path);
      if (file instanceof TFile) return file;
      throw new Error(`项目文档已创建但无法打开：${document.path}`);
    }

    const meta = KNOWLEDGE_CATEGORY_META[input.kind];
    const folder = meta.folder;
    const category = meta.label;
    const path = this.uniqueKnowledgePath(fs, [folder], `${today()}-${slug}.md`);
    const body = buildKeywordLinkedMarkdown([
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
    ].join("\n"), { title });
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
    if (!requireProFeature(this.plugin, "knowledgeManagement")) return;
    await this.openNewKnowledgeSourceModal(fs, {
      mode: "note",
      defaultKind: "materials",
      title: "新建知识笔记",
      subtitle: "先选择分类，再创建知识笔记。不会再默认放到知识库根目录。",
      submitLabel: "创建知识笔记",
      contentPlaceholder: "可以先写正文，也可以留空，创建后继续编辑。"
    });
  }

  private async requireProjectForDestination(fs: FileSystemService, projectId?: string): Promise<LifeOSProject> {
    const projects = await new ProjectService(this.app, fs).loadProjects();
    const project = projectId
      ? projects.find((item) => item.id === projectId)
      : projects[0];
    if (!project) throw new Error("还没有项目。请先到任务页新增项目，再保存到项目文档。");
    return project;
  }

  private captureDestinationLabel(destination: KnowledgeCaptureKind): string {
    if (destination === "raw") return "待整理";
    if (destination === "project") return "项目文档";
    return KNOWLEDGE_CATEGORY_META[destination].label;
  }

  private finalDestinationLabel(destination: KnowledgeFinalDestinationKind): string {
    if (destination === "formal") return "正式 Wiki";
    if (destination === "project") return "项目文档";
    return KNOWLEDGE_CATEGORY_META[destination].label;
  }

  private async openIndex(fs: FileSystemService): Promise<void> {
    const file = await this.refreshDirectoryIndex(fs, ["Knowledge"], "知识库目录");
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private async openFolderIndex(fs: FileSystemService, folder: string | string[], title: string, options: DirectoryIndexOptions = {}): Promise<void> {
    const folderParts = Array.isArray(folder) ? folder : folder.split("/").filter(Boolean);
    const file = await this.refreshDirectoryIndex(fs, ["Knowledge", ...folderParts], `${title} 目录`, options);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
  }

  private async refreshDirectoryIndex(fs: FileSystemService, parts: string[], title: string, options: DirectoryIndexOptions = {}): Promise<TFile> {
    const directoryPath = fs.path(...parts);
    const indexPath = `${directoryPath}/index.md`;
    const indexOptions = this.localizeDirectoryIndexOptions(fs, parts, options);
    const nextBlock = this.buildDirectoryIndexBlock(directoryPath, indexPath, indexOptions);
    const initialContent = `# ${title}\n\n${nextBlock}\n`;
    const file = await ensureFile(this.app, indexPath, initialContent);
    const current = await this.app.vault.read(file);
    const next = this.mergeDirectoryIndexBlock(current, title, nextBlock);
    if (next !== current) await this.app.vault.modify(file, next);
    return file;
  }

  private localizeDirectoryIndexOptions(fs: FileSystemService, parts: string[], options: DirectoryIndexOptions): DirectoryIndexOptions {
    const excludeFolders = new Set<string>();
    for (const folder of options.excludeFolders ?? []) {
      const normalizedFolder = folder.replace(/^\/+|\/+$/g, "");
      if (!normalizedFolder) continue;
      excludeFolders.add(normalizedFolder);
      const localizedFolderPath = fs.path(...parts, ...normalizedFolder.split("/").filter(Boolean));
      const localizedName = localizedFolderPath.replace(/\\/g, "/").split("/").pop();
      if (localizedName) excludeFolders.add(localizedName);
    }
    return { ...options, excludeFolders: Array.from(excludeFolders) };
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

interface NewKnowledgeSourceModalOptions {
  mode?: "source" | "note";
  title?: string;
  subtitle?: string;
  submitLabel?: string;
  defaultKind?: KnowledgeCaptureKind;
  defaultProjectId?: string;
  contentPlaceholder?: string;
}

interface KnowledgeFinalDestinationSelection {
  kind: KnowledgeFinalDestinationKind;
  projectId?: string;
}

function openNewKnowledgeSourceModal(
  app: App,
  projects: LifeOSProject[],
  options: NewKnowledgeSourceModalOptions = {}
): Promise<KnowledgeCaptureInput | null> {
  return new Promise((resolve) => {
    new NewKnowledgeSourceModal(app, projects, options, resolve).open();
  });
}

function openKnowledgeFinalDestinationModal(
  app: App,
  projects: LifeOSProject[],
  recommendationLabel: string
): Promise<KnowledgeFinalDestinationSelection | null> {
  return new Promise((resolve) => {
    new KnowledgeFinalDestinationModal(app, projects, recommendationLabel, resolve).open();
  });
}

class KnowledgeFinalDestinationModal extends Modal {
  private destinationSelect!: HTMLSelectElement;
  private projectSelect: HTMLSelectElement | null = null;
  private projectField: HTMLElement | null = null;
  private hasResolved = false;

  constructor(
    app: App,
    private projects: LifeOSProject[],
    private recommendationLabel: string,
    private resolveSelection: (selection: KnowledgeFinalDestinationSelection | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-knowledge-destination-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: "选择入库分类",
      subtitle: `AI 推荐：${this.recommendationLabel}。你可以改成学习资料、读书笔记、错题知识点或项目文档。`,
      icon: "folder-check",
      className: "lifeos-knowledge-destination-modal"
    });

    const form = body.createDiv({ cls: "lifeos-knowledge-capture-form" });
    const destinationField = form.createDiv({ cls: "lifeos-knowledge-capture-field is-wide" });
    destinationField.createEl("label", { text: "最终分类" });
    this.destinationSelect = destinationField.createEl("select", { cls: "lifeos-knowledge-capture-select" });
    for (const option of KNOWLEDGE_FINAL_DESTINATIONS) {
      this.destinationSelect.createEl("option", { value: option.kind, text: option.label });
    }
    this.destinationSelect.value = "formal";
    this.destinationSelect.addEventListener("change", () => this.syncProjectField());

    this.projectField = form.createDiv({ cls: "lifeos-knowledge-capture-field is-wide" });
    this.projectField.createEl("label", { text: "项目" });
    if (this.projects.length > 0) {
      this.projectSelect = this.projectField.createEl("select", { cls: "lifeos-knowledge-capture-select" });
      for (const project of this.projects) {
        this.projectSelect.createEl("option", { value: project.id, text: project.name });
      }
    } else {
      this.projectField.createDiv({ cls: "lifeos-muted-text", text: "还没有项目。请先到任务页新增项目。" });
    }
    this.syncProjectField();

    createButton(footer, "取消", () => this.finish(null), { ghost: true });
    createButton(footer, "继续预览", () => this.submit(), { primary: true, icon: "arrow-right" });
  }

  onClose(): void {
    if (!this.hasResolved) this.finish(null);
  }

  private selectedDestination(): KnowledgeFinalDestinationSelection {
    const kind = this.destinationSelect.value as KnowledgeFinalDestinationKind;
    const projectId = this.projectSelect?.value || undefined;
    return { kind, projectId };
  }

  private syncProjectField(): void {
    if (!this.projectField) return;
    this.projectField.toggleClass("is-hidden", this.destinationSelect.value !== "project");
  }

  private submit(): void {
    const selection = this.selectedDestination();
    if (selection.kind === "project" && !selection.projectId) {
      new Notice("请先选择项目。还没有项目时，需要先到任务页新增项目。", 5000);
      return;
    }
    this.finish(selection);
  }

  private finish(selection: KnowledgeFinalDestinationSelection | null): void {
    if (!this.hasResolved) {
      this.resolveSelection(selection);
      this.hasResolved = true;
    }
    this.close();
  }
}

class KnowledgeImportHubModal extends Modal {
  private files: File[] = [];
  private fileListEl!: HTMLElement;
  private fileImportButton!: HTMLButtonElement;
  private privacySelect!: HTMLSelectElement;
  private destinationSelect!: HTMLSelectElement;
  private urlInput!: HTMLInputElement;
  private urlTitleInput!: HTMLInputElement;
  private clipModeSelect!: HTMLSelectElement;
  private projectSelect: HTMLSelectElement | null = null;
  private projectField: HTMLElement | null = null;

  constructor(
    app: App,
    private projects: LifeOSProject[],
    private handlers: KnowledgeImportHandlers
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-knowledge-import-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: "导入资料",
      subtitle: "导入后的内容会先进入待处理资料。确认写入之后，才会成为 AI 可复用的正式知识。",
      icon: "upload-cloud",
      className: "lifeos-knowledge-import-modal"
    });

    const form = body.createDiv({ cls: "lifeos-knowledge-import-form" });
    const privacyWrap = form.createDiv({ cls: "lifeos-knowledge-capture-field is-wide" });
    privacyWrap.createEl("label", { text: "隐私级别" });
    this.privacySelect = privacyWrap.createEl("select", { cls: "lifeos-knowledge-capture-select" });
    for (const [value, text] of [
      ["normal", "普通：可用于后续整理和上下文"],
      ["private", "私密：保留在本地，谨慎进入上下文"],
      ["sensitive", "敏感资料：不自动调用 AI"]
    ] as Array<[KnowledgePrivacyChoice, string]>) {
      this.privacySelect.createEl("option", { value, text });
    }

    const destinationWrap = form.createDiv({ cls: "lifeos-knowledge-capture-field is-wide" });
    destinationWrap.createEl("label", { text: "保存到" });
    this.destinationSelect = destinationWrap.createEl("select", { cls: "lifeos-knowledge-capture-select" });
    for (const option of KNOWLEDGE_CAPTURE_DESTINATIONS) {
      this.destinationSelect.createEl("option", { value: option.kind, text: option.label });
    }
    this.destinationSelect.addEventListener("change", () => this.syncProjectField());

    this.projectField = form.createDiv({ cls: "lifeos-knowledge-capture-field is-wide" });
    this.projectField.createEl("label", { text: "项目" });
    if (this.projects.length > 0) {
      this.projectSelect = this.projectField.createEl("select", { cls: "lifeos-knowledge-capture-select" });
      for (const project of this.projects) {
        this.projectSelect.createEl("option", { value: project.id, text: project.name });
      }
    } else {
      this.projectField.createDiv({ cls: "lifeos-muted-text", text: "还没有项目。选择“项目文档”前，请先到任务页新增项目。" });
    }
    this.syncProjectField();

    this.renderFileImport(form);
    this.renderUrlImport(form);
    this.renderProjectImport(form);

    createButton(footer, "关闭", () => this.close(), { ghost: true });
    createButton(footer, "粘贴文本资料", () => {
      const destination = this.selectedDestination();
      const projectId = this.selectedProjectId();
      if (!this.ensureProjectDestinationReady(destination, projectId)) return;
      this.close();
      this.handlers.pasteText(destination, projectId);
    }, { primary: true, icon: "clipboard" });
  }

  private renderFileImport(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "lifeos-knowledge-import-card is-wide" });
    const head = card.createDiv({ cls: "lifeos-card-title" });
    setIcon(head.createSpan(), "files");
    head.createSpan({ text: "PDF / Word / Markdown / 文本" });
    card.createEl("p", { text: "保存原文件，提取可检索正文，再按“保存到”进入待整理、分类资料或项目文档。" });
    const input = card.createEl("input", {
      attr: {
        type: "file",
        multiple: "true",
        accept: CHAT_IMPORT_ACCEPT
      }
    });
    input.addClass("lifeos-hidden-file-input");
    input.addEventListener("change", () => {
      this.addFiles(input.files);
      input.value = "";
    });
    const actions = card.createDiv({ cls: "lifeos-llmwiki-actions" });
    createButton(actions, "选择文件", () => input.click(), { icon: "paperclip" });
    this.fileImportButton = createButton(actions, "导入文件", () => void this.submitFiles(), { primary: true, icon: "upload" });
    this.fileListEl = card.createDiv({ cls: "lifeos-knowledge-import-file-list" });
    this.renderFileList();
  }

  private renderUrlImport(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "lifeos-knowledge-import-card" });
    const head = card.createDiv({ cls: "lifeos-card-title" });
    setIcon(head.createSpan(), "link");
    head.createSpan({ text: "Web Clipper 收件箱" });
    card.createEl("p", { text: "抓取网页正文和来源，统一先进入 Raw Inbox。AI 整理成 Draft 后，再由你复核写入分类或项目。" });
    card.createDiv({ cls: "lifeos-muted-text", text: "即使上方选择了学习资料、读书笔记或项目文档，网页剪藏也会先走收件箱处理流程。" });
    this.urlInput = card.createEl("input", {
      cls: "lifeos-knowledge-capture-input",
      attr: { type: "url", placeholder: "https://..." }
    });
    this.urlTitleInput = card.createEl("input", {
      cls: "lifeos-knowledge-capture-input",
      attr: { type: "text", placeholder: "标题可选" }
    });
    const modeField = card.createDiv({ cls: "lifeos-knowledge-capture-field is-wide" });
    modeField.createEl("label", { text: "剪藏模式" });
    this.clipModeSelect = modeField.createEl("select", { cls: "lifeos-knowledge-capture-select" });
    this.clipModeSelect.createEl("option", { value: "text", text: "纯文本剪藏：只保存可检索正文" });
    this.clipModeSelect.createEl("option", { value: "text-images", text: "图文剪藏：下载网页图片到本地附件" });
    createButton(card, "送入 Web Clipper 收件箱", () => void this.submitUrl(), { primary: true, icon: "download" });
  }

  private renderProjectImport(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "lifeos-knowledge-import-card" });
    const head = card.createDiv({ cls: "lifeos-card-title" });
    setIcon(head.createSpan(), "folder-input");
    head.createSpan({ text: "项目文档" });
    card.createEl("p", { text: "归入指定项目，AI 助手选择该项目后会优先读取。" });
    if (this.projects.length === 0) {
      card.createDiv({ cls: "lifeos-muted-text", text: "还没有项目。请先到任务页新增项目。" });
      return;
    }
    createButton(card, "导入到项目", () => {
      const projectId = this.projectSelect?.value || "";
      if (!projectId) {
        new Notice("请先选择项目。还没有项目时，需要先到任务页新增项目。", 5000);
        return;
      }
      this.close();
      this.handlers.importProjectDocuments(projectId);
    }, { primary: true, icon: "upload" });
  }

  private addFiles(fileList: FileList | null): void {
    const nextFiles = Array.from(fileList ?? []);
    const seen = new Set(this.files.map((file) => this.fileKey(file)));
    for (const file of nextFiles) {
      const key = this.fileKey(file);
      if (seen.has(key)) continue;
      this.files.push(file);
      seen.add(key);
    }
    this.renderFileList();
  }

  private renderFileList(): void {
    if (!this.fileListEl) return;
    this.fileListEl.empty();
    this.fileImportButton.disabled = this.files.length === 0;
    if (this.files.length === 0) {
      this.fileListEl.createDiv({ cls: "lifeos-muted-text", text: "还没有选择文件。" });
      return;
    }
    for (const file of this.files) {
      const row = this.fileListEl.createDiv({ cls: "lifeos-knowledge-import-file-row" });
      row.createSpan({ text: file.name });
      row.createSpan({ cls: "lifeos-muted-text", text: formatAttachmentSize(file.size) });
      createButton(row, "移除", () => {
        this.files = this.files.filter((item) => this.fileKey(item) !== this.fileKey(file));
        this.renderFileList();
      }, { ghost: true, icon: "x" });
    }
  }

  private async submitFiles(): Promise<void> {
    if (this.files.length === 0) {
      new Notice("请先选择要导入的文件。");
      return;
    }
    const destination = this.selectedDestination();
    const projectId = this.selectedProjectId();
    if (!this.ensureProjectDestinationReady(destination, projectId)) return;
    this.fileImportButton.disabled = true;
    try {
      await this.handlers.importFiles(this.files, this.selectedPrivacy(), destination, projectId);
      this.close();
    } catch (error) {
      this.fileImportButton.disabled = false;
      new Notice(error instanceof Error ? error.message : "资料导入失败。", 7000);
    }
  }

  private async submitUrl(): Promise<void> {
    const url = this.urlInput.value.trim();
    if (!url) {
      new Notice("请先填写网页链接。");
      return;
    }
    const destination = this.selectedDestination();
    const projectId = this.selectedProjectId();
    try {
      await this.handlers.importUrl(url, this.urlTitleInput.value.trim(), this.selectedPrivacy(), destination, this.selectedWebClipMode(), projectId);
      this.close();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "网页导入失败。", 7000);
    }
  }

  private selectedPrivacy(): KnowledgePrivacyChoice {
    return this.privacySelect.value as KnowledgePrivacyChoice;
  }

  private selectedDestination(): KnowledgeCaptureKind {
    return this.destinationSelect.value as KnowledgeCaptureKind;
  }

  private selectedProjectId(): string | undefined {
    return this.projectSelect?.value || undefined;
  }

  private selectedWebClipMode(): KnowledgeWebClipMode {
    return (this.clipModeSelect?.value || "text") as KnowledgeWebClipMode;
  }

  private syncProjectField(): void {
    if (!this.projectField) return;
    this.projectField.toggleClass("is-hidden", this.selectedDestination() !== "project");
  }

  private ensureProjectDestinationReady(destination: KnowledgeCaptureKind, projectId: string | undefined): boolean {
    if (destination !== "project") return true;
    if (projectId) return true;
    new Notice("请先选择项目。还没有项目时，需要先到任务页新增项目。", 5000);
    return false;
  }

  private fileKey(file: File): string {
    return `${file.name}:${file.size}:${file.lastModified}`;
  }
}

class NewKnowledgeSourceModal extends Modal {
  private hasResolved = false;
  private titleInput!: HTMLInputElement;
  private kindSelect!: HTMLSelectElement;
  private privacySelect!: HTMLSelectElement;
  private contentInput!: HTMLTextAreaElement;
  private projectSelect: HTMLSelectElement | null = null;
  private projectField: HTMLElement | null = null;

  constructor(
    app: App,
    private projects: LifeOSProject[],
    private options: NewKnowledgeSourceModalOptions,
    private resolveInput: (input: KnowledgeCaptureInput | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-knowledge-capture-modal-host");
    const { body, footer } = createModalShell(this.contentEl, {
      title: this.options.title ?? "新增资料",
      subtitle: this.options.subtitle ?? "把文章摘录、课程资料、读书笔记、错题方法或临时素材先放进知识库。敏感资料可以标记为敏感，后续不会自动交给 AI 整理。",
      icon: "file-plus-2",
      className: "lifeos-knowledge-capture-modal"
    });

    const form = body.createDiv({ cls: "lifeos-knowledge-capture-form" });
    this.titleInput = this.renderInputField(form, "标题", "例如：申论小而美文旅模型");
    this.kindSelect = this.renderSelectField(form, "保存位置", [
      ["raw", "资料收件箱（Raw 原始资料，后续可整理）"],
      ["materials", "学习资料"],
      ["books", "读书笔记"],
      ["mistakes", "错题知识点"],
      ["project", "项目文档"]
    ]);
    this.kindSelect.value = this.options.defaultKind ?? "raw";
    this.kindSelect.addEventListener("change", () => this.syncProjectField());
    this.privacySelect = this.renderSelectField(form, "隐私级别", [
      ["normal", "普通：可用于后续整理和上下文"],
      ["private", "私密：保留在本地，谨慎进入上下文"],
      ["sensitive", "敏感资料：不自动调用 AI"]
    ]);
    this.projectField = form.createDiv({ cls: "lifeos-knowledge-capture-field is-wide" });
    this.projectField.createEl("label", { text: "项目" });
    if (this.projects.length > 0) {
      this.projectSelect = this.projectField.createEl("select", { cls: "lifeos-knowledge-capture-select" });
      for (const project of this.projects) {
        this.projectSelect.createEl("option", { value: project.id, text: project.name });
      }
      if (this.options.defaultProjectId) this.projectSelect.value = this.options.defaultProjectId;
    } else {
      this.projectField.createDiv({ cls: "lifeos-muted-text", text: "还没有项目。请先到任务页新增项目。" });
    }
    this.syncProjectField();
    const contentWrap = form.createDiv({ cls: "lifeos-knowledge-capture-field is-wide" });
    contentWrap.createEl("label", { text: "资料内容" });
    this.contentInput = contentWrap.createEl("textarea", {
      cls: "lifeos-knowledge-capture-textarea",
      attr: { rows: "10", placeholder: this.options.contentPlaceholder ?? "粘贴资料正文、链接、读书摘录、错题方法，或先写一个简短说明。" }
    });

    createButton(footer, "取消", () => this.finish(null), { ghost: true });
    createButton(footer, this.options.submitLabel ?? "加入知识库", () => this.submit(), { primary: true, icon: "file-plus-2" });
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
    const kind = this.kindSelect.value as KnowledgeCaptureKind;
    const projectId = this.projectSelect?.value || this.options.defaultProjectId;
    if (kind === "project" && !projectId) {
      new Notice("请先选择项目。还没有项目时，需要先到任务页新增项目。", 5000);
      return;
    }
    this.finish({
      title: title || content.slice(0, 36) || "未命名资料",
      kind,
      privacy: this.privacySelect.value as KnowledgePrivacyChoice,
      content,
      projectId
    });
  }

  private syncProjectField(): void {
    if (!this.projectField) return;
    this.projectField.toggleClass("is-hidden", this.kindSelect.value !== "project");
  }

  private finish(input: KnowledgeCaptureInput | null): void {
    if (!this.hasResolved) {
      this.resolveInput(input);
      this.hasResolved = true;
    }
    this.close();
  }
}
