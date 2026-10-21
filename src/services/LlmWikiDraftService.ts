import { App, TFile, normalizePath } from "obsidian";
import type { DirectoryLanguage } from "../settings";
import { LlmWikiPathService } from "./LlmWikiPathService";
import { LlmWikiChangeService, type WikiChangeSet } from "./LlmWikiChangeService";
import { appendFile, ensureFolder } from "../utils/vault";
import { buildKeywordLinkedMarkdown } from "./KeywordLinkService";
import {
  detectLlmWikiPrivacyLevel,
  normalizedLlmWikiSimilarity,
  replaceLlmWikiFrontmatterValue,
  simpleLlmWikiHash,
  slugifyLlmWikiTitle
} from "./llm-wiki-logic";

const FORMAL_WIKI_DIRS = [
  "Concepts",
  "Entities",
  "Questions",
  "Syntheses",
  "Sources",
  "Contradictions"
] as const;
const ACCEPTANCE_MERGE_THRESHOLD = 0.55;
const PUBLISH_FILENAME_SLUG_MAX_LENGTH = 96;

const FORMAL_SOURCE_SECTION_START = "<!-- lifeos-wiki-sources:start -->";
const FORMAL_SOURCE_SECTION_END = "<!-- lifeos-wiki-sources:end -->";
const FORMAL_SOURCE_HEADING = "## 来源（系统生成）";

interface LlmWikiFormalSource {
  id: string;
  title: string;
  path?: string;
  sourceKind?: string;
  originalUrl?: string;
  attachmentPath?: string;
  unresolved?: boolean;
}

export interface LlmWikiAcceptanceRecommendation {
  action: "publish-new" | "merge-existing";
  targetPath: string;
  reason: string;
}

export interface LlmWikiAcceptanceExecutionResult {
  ok: boolean;
  action?: "publish-new" | "merge-existing";
  targetPath?: string;
  message: string;
  warning?: string;
}

interface LlmWikiDraftFile {
  path: string;
  basename?: string;
}

interface LlmWikiDraftVault {
  getMarkdownFiles?: () => LlmWikiDraftFile[];
  read(file: LlmWikiDraftFile): Promise<string>;
}

export class LlmWikiDraftService {
  private paths: LlmWikiPathService;

  constructor(private app: App, private rootFolder: string, private directoryLanguage: DirectoryLanguage = "en") {
    this.paths = new LlmWikiPathService(app, rootFolder, directoryLanguage);
  }

  /** Explicit review entry point; the durable service owns CAS and restart reconciliation. */
  async applyKnowledgeUpdate(receiptPath: string, approvedVersion: string): Promise<WikiChangeSet> {
    return new LlmWikiChangeService(this.app, { rootFolder: this.rootFolder, directoryLanguage: this.directoryLanguage }).apply(receiptPath, approvedVersion);
  }

  async recommendAcceptance(draftPath: string): Promise<LlmWikiAcceptanceRecommendation> {
    const draftFile = this.app.vault.getAbstractFileByPath(draftPath);
    const draftMarkdown = draftFile instanceof TFile ? await this.safeReadFile(draftFile) : "";
    const title = this.inferDraftTitle(draftMarkdown, draftFile instanceof TFile ? draftFile.basename : "");
    let best: { file: LlmWikiDraftFile; score: number } | null = null;

    for (const file of this.formalFiles()) {
      let content: string;
      try {
        content = await this.vault().read(file);
      } catch {
        continue;
      }

      const score = Math.max(
        normalizedLlmWikiSimilarity(title, file.basename || ""),
        normalizedLlmWikiSimilarity(draftMarkdown.slice(0, 1200), content.slice(0, 1200))
      );
      if (!best || score > best.score) {
        best = { file, score };
      }
    }

    if (best && best.score >= ACCEPTANCE_MERGE_THRESHOLD) {
      return {
        action: "merge-existing",
        targetPath: best.file.path,
        reason: "已有正式页与 Draft 主题高度相似，建议合并。"
      };
    }

    return {
      action: "publish-new",
      targetPath: this.publishTargetPath(title),
      reason: "没有找到足够相似的正式页，建议发布为新页面。"
    };
  }

  async markDraftAccepted(draftPath: string, targetPath: string, acceptedAt: string): Promise<boolean> {
    if (!this.isDraftPath(draftPath)) return false;

    const draftFile = this.app.vault.getAbstractFileByPath(draftPath);
    if (!(draftFile instanceof TFile)) return false;
    if (!this.isCurrentDraftFile(draftPath, draftFile)) return false;

    const current = await this.app.vault.read(draftFile);
    const markdown = [
      ["status", "accepted"],
      ["accepted_at", acceptedAt],
      ["formal_target", targetPath]
    ].reduce(
      (nextMarkdown, [key, value]) => replaceLlmWikiFrontmatterValue(nextMarkdown, key, value),
      current
    );
    if (!this.isCurrentDraftFile(draftPath, draftFile)) return false;
    await this.app.vault.modify(draftFile, markdown);
    return true;
  }

  async markDraftSkipped(draftPath: string, skippedAt: string, reason = "User chose not to add this Draft to formal Wiki."): Promise<boolean> {
    if (!this.isDraftPath(draftPath)) return false;

    const draftFile = this.app.vault.getAbstractFileByPath(draftPath);
    if (!(draftFile instanceof TFile)) return false;
    if (!this.isCurrentDraftFile(draftPath, draftFile)) return false;

    const current = await this.app.vault.read(draftFile);
    if (!this.isPendingLlmWikiDraft(current)) return false;
    const markdown = [
      ["status", "skipped"],
      ["skipped_at", skippedAt],
      ["skipped_reason", reason]
    ].reduce(
      (nextMarkdown, [key, value]) => replaceLlmWikiFrontmatterValue(nextMarkdown, key, value),
      current
    );
    if (!this.isCurrentDraftFile(draftPath, draftFile)) return false;
    await this.app.vault.modify(draftFile, markdown);
    try {
      await this.appendSkippedLog(draftPath, skippedAt, reason);
    } catch {
      // Skipping should still remove the draft from the review queue even if the audit log cannot be appended.
    }
    return true;
  }

  async executeAcceptance(
    draftPath: string,
    recommendation: LlmWikiAcceptanceRecommendation,
    acceptedAt: string,
    bodyOverride?: string
  ): Promise<LlmWikiAcceptanceExecutionResult> {
    const draftFile = this.app.vault.getAbstractFileByPath(draftPath);
    if (!(draftFile instanceof TFile)) {
      return this.rejectedAcceptance("Draft 不存在，未执行写入。");
    }
    if (!this.isCurrentDraftFile(draftPath, draftFile)) {
      return this.rejectedAcceptance("只能接受当前 Wiki/Drafts 下的 Draft。");
    }

    const action = recommendation.action;
    const targetPath = this.normalizedPath(recommendation.targetPath);
    if (action !== "merge-existing" && action !== "publish-new") {
      return this.rejectedAcceptance("未知 Draft 接受动作，未执行写入。");
    }
    if (!this.isFormalWikiPath(targetPath)) {
      return this.rejectedAcceptance("目标路径不在正式 Wiki 目录，未执行写入。", action, targetPath);
    }

    let mergeTargetFile: TFile | null = null;
    if (action === "merge-existing") {
      const targetFile = this.app.vault.getAbstractFileByPath(targetPath);
      if (!(targetFile instanceof TFile)) {
        return this.rejectedAcceptance("合并目标页面不存在，未执行写入。", action, targetPath);
      }
      mergeTargetFile = targetFile;
    } else if (this.app.vault.getAbstractFileByPath(targetPath)) {
      return this.rejectedAcceptance("目标页面已存在，未执行写入。", action, targetPath);
    }

    const current = await this.app.vault.read(draftFile);
    const body = (bodyOverride ?? this.stripFrontmatter(current)).trim();
    const mergeBlockMarkers = action === "merge-existing" ? this.acceptedDraftBlockMarkers(draftPath, targetPath, body) : null;
    let mergeAlreadyContainsAcceptedDraft = false;
    if (action === "merge-existing") {
      if (!mergeTargetFile || !this.isCurrentFormalTargetFile(targetPath, mergeTargetFile)) {
        return this.rejectedAcceptance("目标页面已不存在，未执行合并。", action, targetPath);
      }
      const targetMarkdown = await this.app.vault.read(mergeTargetFile);
      mergeAlreadyContainsAcceptedDraft = !!mergeBlockMarkers && this.targetContainsAcceptedDraftBlock(targetMarkdown, mergeBlockMarkers, body);
    }

    const canRetryAcceptedMerge =
      action === "merge-existing" &&
      mergeAlreadyContainsAcceptedDraft &&
      this.isAcceptedLlmWikiDraftForTarget(current, targetPath);
    if (!this.isPendingLlmWikiDraft(current) && !canRetryAcceptedMerge) {
      return this.rejectedAcceptance("这不是待接受的 LLM Wiki Draft。", action, targetPath);
    }

    if (this.isUnsafeDraftForAcceptance(current, body, draftFile.basename)) {
      return this.rejectedAcceptance("敏感或本地限定 Draft 不允许写入正式 Wiki，已保持暂存。", action, targetPath);
    }

    if (!this.isCurrentDraftFile(draftPath, draftFile)) {
      return this.rejectedAcceptance("Draft 已变化或不再是当前 Draft，未执行写入。", action, targetPath);
    }

    if (action === "merge-existing") {
      if (!mergeTargetFile || !this.isCurrentFormalTargetFile(targetPath, mergeTargetFile)) {
        return this.rejectedAcceptance("目标页面已不存在，未执行合并。", action, targetPath);
      }
      if (!mergeBlockMarkers) {
        return this.rejectedAcceptance("合并标记生成失败，未执行合并。", action, targetPath);
      }
      const targetMarkdown = await this.app.vault.read(mergeTargetFile);
      if (!this.targetContainsAcceptedDraftBlock(targetMarkdown, mergeBlockMarkers, body)) {
        const block = `${mergeBlockMarkers.start}\n\n## Accepted Draft ${acceptedAt}\n\n${body}\n\n${mergeBlockMarkers.end}`;
        await this.app.vault.append(mergeTargetFile, `\n\n${block}`);
      }
      await this.refreshFormalKeywordLinks(mergeTargetFile);
    } else {
      try {
        // The first formal page inherits provenance from the draft. Resolve the IDs before
        // building so the system section can point at the actual Raw/attachment/web sources,
        // regardless of whether the model body wrote any links.
        const sources = await this.resolveDraftSources(current);
        if (!this.isCurrentDraftFile(draftPath, draftFile) || (await this.app.vault.read(draftFile)) !== current) {
          return this.rejectedAcceptance("Draft 已变化或不再是当前 Draft，未执行写入。", action, targetPath);
        }
        await this.createFormalWikiPage(targetPath, this.buildFormalWikiMarkdown(current, body, undefined, {
          sources,
          draftPath
        }));
      } catch (error) {
        if (this.isCreateConflictError(error)) {
          return this.rejectedAcceptance("目标页面已存在，未执行写入。", action, targetPath);
        }
        throw error;
      }
    }

    try {
      const marked = await this.markDraftAccepted(draftPath, targetPath, acceptedAt);
      if (!marked) throw new Error("Draft was not marked accepted.");
      await this.appendAcceptanceLog(draftPath, targetPath, acceptedAt);
    } catch (error) {
      const warning = error instanceof Error ? error.message : String(error);
      await this.tryAppendAcceptanceFailureLog(draftPath, targetPath, acceptedAt, warning);
      return {
        ok: false,
        action,
        targetPath,
        message: "正式页已写入，但后续标记或日志失败，请手动检查。",
        warning
      };
    }

    return {
      ok: true,
      action,
      targetPath,
      message: "Draft 已接受并写入正式 Wiki。"
    };
  }

  private formalFiles(): LlmWikiDraftFile[] {
    const getMarkdownFiles = this.vault().getMarkdownFiles;
    if (!getMarkdownFiles) return [];

    const formalPrefixes = FORMAL_WIKI_DIRS.map((dir) => this.normalizedPath(this.paths.path("Wiki", dir)));
    const files: LlmWikiDraftFile[] = getMarkdownFiles.call(this.vault());
    return files.filter((file: LlmWikiDraftFile) => {
      const path = this.normalizedPath(file.path);
      return formalPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    });
  }

  private async safeReadFile(file: TFile): Promise<string> {
    try {
      return await this.app.vault.read(file);
    } catch {
      return "";
    }
  }

  private inferDraftTitle(markdown: string, basename = ""): string {
    const body = this.stripFrontmatter(markdown).trimStart();
    const firstLine = body.split(/\r?\n/, 1)[0] || "";
    const heading = firstLine.match(/^#\s+(.+)$/)?.[1]?.trim();
    return heading || String(basename || "").trim() || "LLM Wiki Draft";
  }

  private publishTargetPath(title: string): string {
    const slug = slugifyLlmWikiTitle(title).slice(0, PUBLISH_FILENAME_SLUG_MAX_LENGTH);
    return this.paths.path("Wiki", "Concepts", `${slug}.md`);
  }

  private normalizedPath(path: string): string {
    return normalizePath(String(path || ""));
  }

  private isDraftPath(path: string): boolean {
    const normalized = this.normalizedPath(path);
    const draftsPrefix = this.normalizedPath(this.paths.path("Wiki", "Drafts"));
    return !this.hasUnsafePathSegments(normalized) && normalized.startsWith(`${draftsPrefix}/`);
  }

  private isFormalWikiPath(path: string): boolean {
    const normalized = this.normalizedPath(path);
    if (this.hasUnsafePathSegments(normalized) || !normalized.endsWith(".md")) return false;

    return FORMAL_WIKI_DIRS.some((dir) => {
      const prefix = this.normalizedPath(this.paths.path("Wiki", dir));
      return normalized.startsWith(`${prefix}/`);
    });
  }

  private stripFrontmatter(markdown: string): string {
    return String(markdown || "").replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/, "");
  }

  private buildFormalWikiMarkdown(
    draftMarkdown: string,
    body: string,
    privacyOverride?: "normal" | "private",
    sourceContext: { sources?: LlmWikiFormalSource[]; draftPath?: string } = {}
  ): string {
    const frontmatter = this.parseDraftFrontmatter(draftMarkdown) ?? {};
    const privacyLevel = privacyOverride ?? this.normalizeDraftPrivacyLevel(frontmatter.privacy_level);
    const aiProcessingAllowed = this.isDraftAiProcessingAllowed(frontmatter.ai_processing_allowed) ? "true" : "false";
    const title = this.inferDraftTitle(draftMarkdown, "");
    const sourceIds = this.parseDraftSourceIds(draftMarkdown);
    const sources = sourceContext.sources ?? this.syncFormalSources(sourceIds);
    // Inherit a recorded source_draft when present; otherwise the accepted draft itself is
    // the traceable intermediate. An empty value is written explicitly rather than invented.
    const sourceDraft = String(frontmatter.source_draft || sourceContext.draftPath || "").trim();
    const page = buildKeywordLinkedMarkdown([
      "---",
      "type: llm-wiki-formal",
      `privacy_level: ${privacyLevel}`,
      `ai_processing_allowed: ${aiProcessingAllowed}`,
      ...(frontmatter.lifeos_evidence === "user-saved-conversation-v1" ? ["lifeos_evidence: user-saved-conversation-v1"] : []),
      ...(sourceIds.length ? ["source_ids:", ...sourceIds.map((id) => `  - ${this.yamlScalar(id)}`)] : []),
      `source_draft: ${this.yamlScalar(sourceDraft)}`,
      "---",
      "",
      body,
      ""
    ].join("\n"), { title });
    return this.upsertFormalSourceSection(page, sources);
  }

  /**
   * Resolve a draft's structured source IDs against the Vault before the first formal write.
   * Raw pages keep their original URL/attachment metadata in frontmatter; the source section
   * is built from that metadata, never from links the model may or may not have written.
   */
  private async resolveDraftSources(draftMarkdown: string): Promise<LlmWikiFormalSource[]> {
    const frontmatter = this.parseDraftFrontmatter(draftMarkdown) ?? {};
    const sourceIds = this.parseDraftSourceIds(draftMarkdown);
    const sources: LlmWikiFormalSource[] = [];
    const seen = new Set<string>();

    for (const id of sourceIds) {
      const file = await this.findSourceFile(id);
      if (!file) {
        sources.push({ id, title: id, unresolved: true });
        continue;
      }
      sources.push(await this.readFormalSource(file, id));
      seen.add(id);
    }

    const inheritedDraft = String(frontmatter.source_draft || "").trim();
    if (inheritedDraft && !seen.has(inheritedDraft)) {
      const normalized = this.normalizedPath(inheritedDraft);
      if (this.isRawSourcePath(normalized)) {
        const file = this.app.vault.getAbstractFileByPath(normalized);
        if (file instanceof TFile) {
          sources.push(await this.readFormalSource(file, inheritedDraft));
          seen.add(inheritedDraft);
        }
      } else if (/^src_[A-Za-z0-9_.-]+$/u.test(inheritedDraft)) {
        const file = await this.findSourceFile(inheritedDraft);
        if (file) {
          sources.push(await this.readFormalSource(file, inheritedDraft));
          seen.add(inheritedDraft);
        }
      }
    }

    return sources;
  }

  /** Synchronous fallback for direct builders/tests without a Vault: paths come from names only. */
  private syncFormalSources(sourceIds: string[]): LlmWikiFormalSource[] {
    return sourceIds.map((id) => {
      const file = this.findSourceFileSync(id);
      return file
        ? { id, title: this.fileBasename(file) || id, path: file.path }
        : { id, title: id, unresolved: true };
    });
  }

  private async findSourceFile(id: string): Promise<LlmWikiDraftFile | undefined> {
    const files = this.vault().getMarkdownFiles?.() ?? [];
    const metadataMatches = files.filter((file) => this.sourceIdFromMetadata(file) === id);
    const matches = metadataMatches.length ? metadataMatches : files.filter((file) => this.sourceFileMatchesId(file, id));
    return matches.sort((left, right) =>
      this.sourceFileRank(left.path) - this.sourceFileRank(right.path) || left.path.localeCompare(right.path)
    )[0];
  }

  private findSourceFileSync(id: string): LlmWikiDraftFile | undefined {
    if (!this.app?.vault?.getMarkdownFiles) return undefined;
    const files = this.vault().getMarkdownFiles?.() ?? [];
    const metadataMatches = files.filter((file) => this.sourceIdFromMetadata(file) === id);
    const matches = metadataMatches.length ? metadataMatches : files.filter((file) => this.sourceFileMatchesId(file, id));
    return matches.sort((left, right) =>
      this.sourceFileRank(left.path) - this.sourceFileRank(right.path) || left.path.localeCompare(right.path)
    )[0];
  }

  private sourceIdFromMetadata(file: LlmWikiDraftFile): string {
    try {
      const frontmatter = this.app.metadataCache?.getFileCache?.(file as TFile)?.frontmatter;
      const value = frontmatter?.id;
      return value === undefined || value === null ? "" : String(value).trim();
    } catch {
      return "";
    }
  }

  private sourceFileMatchesId(file: LlmWikiDraftFile, id: string): boolean {
    const basename = this.fileBasename(file);
    return (
      basename === id ||
      basename.endsWith(`-${id}`) ||
      basename.endsWith(`_${id}`) ||
      basename.includes(`-${id}-`)
    );
  }

  private sourceFileRank(path: string): number {
    const normalized = this.normalizedPath(path);
    const prefixes = [
      this.paths?.path("Raw", "Sources") ?? "",
      this.paths?.path("Raw", "Inbox") ?? "",
      this.paths?.path("Raw", "Versions") ?? ""
    ];
    const index = prefixes.findIndex((prefix) => !!prefix && normalized.startsWith(`${prefix}/`));
    return index < 0 ? prefixes.length : index;
  }

  private fileBasename(file: LlmWikiDraftFile): string {
    const basename = String(file.basename || file.path.split("/").pop() || "");
    return basename.replace(/\.md$/iu, "");
  }

  private isRawSourcePath(path: string): boolean {
    const rawPrefix = this.paths?.path("Raw") ?? "";
    return !!rawPrefix && this.normalizedPath(path).startsWith(`${rawPrefix}/`);
  }

  private async readFormalSource(file: LlmWikiDraftFile, fallbackId: string): Promise<LlmWikiFormalSource> {
    let markdown = "";
    try {
      markdown = await this.vault().read(file);
    } catch {
      return {
        id: fallbackId,
        title: this.fileBasename(file) || fallbackId,
        path: file.path,
        unresolved: true
      };
    }

    const frontmatter = this.parseDraftFrontmatter(markdown) ?? {};
    const id = String(frontmatter.id || fallbackId || "").trim();
    const title = String(frontmatter.title || this.fileBasename(file) || id).replace(/\r?\n/gu, " ").trim();
    const sourcePath = String(frontmatter.source_path || "").trim();
    const originalUrl = this.safeSourceUrl(frontmatter.original_url) || this.safeSourceUrl(sourcePath);
    return {
      id,
      title: title || id,
      path: file.path,
      sourceKind: String(frontmatter.source_kind || "").trim() || undefined,
      originalUrl: originalUrl || undefined,
      attachmentPath: originalUrl ? undefined : sourcePath || undefined
    };
  }

  private safeSourceUrl(value: string | undefined): string {
    const text = String(value || "").trim();
    if (!/^https?:\/\//iu.test(text)) return "";
    try {
      const url = new URL(text);
      return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
    } catch {
      return "";
    }
  }

  private upsertFormalSourceSection(markdown: string, sources: LlmWikiFormalSource[]): string {
    const base = this.stripFormalSourceSection(markdown);
    return `${base}\n\n${this.buildFormalSourceSection(sources)}\n`;
  }

  private stripFormalSourceSection(markdown: string): string {
    const pattern = new RegExp(
      `${this.escapeRegExp(FORMAL_SOURCE_SECTION_START)}[\\s\\S]*?${this.escapeRegExp(FORMAL_SOURCE_SECTION_END)}\\s*`,
      "g"
    );
    return String(markdown || "").replace(pattern, "").replace(/\n{3,}/gu, "\n\n").trimEnd();
  }

  private buildFormalSourceSection(sources: LlmWikiFormalSource[]): string {
    const lines = [FORMAL_SOURCE_SECTION_START, FORMAL_SOURCE_HEADING, ""];
    if (sources.length === 0) {
      lines.push("- 无可追溯来源（草稿未记录可定位的 source_ids 或 source_draft）。");
    } else {
      for (const source of sources) {
        const id = String(source.id || "").trim();
        const title = String(source.title || id || "未命名来源").replace(/\r?\n/gu, " ").trim();
        const linkTarget = source.path ? this.wikiLinkTarget(source.path) : "";
        const link = linkTarget
          ? `[[${linkTarget}|${this.escapeWikiAlias(title || id)}]]`
          : "未定位到 Raw 文件";
        const idPart = id ? `，来源 ID：\`${this.escapeInlineCode(id)}\`` : "";
        lines.push(`- ${link}${idPart}${id ? ` <!-- lifeos-wiki-source-id:${encodeURIComponent(id)} -->` : ""}`);
        if (source.sourceKind) lines.push(`  - 类型：${this.escapeInlineCode(source.sourceKind)}`);
        if (source.originalUrl) lines.push(`  - 原始网页：${source.originalUrl}`);
        if (source.attachmentPath) {
          const attachmentLink = this.linkExistingVaultFile(source.attachmentPath);
          lines.push(`  - 原始文件：${attachmentLink ?? `\`${this.escapeInlineCode(source.attachmentPath)}\``}`);
        }
        if (source.unresolved) lines.push("  - 未找到对应 Raw 文件；ID 已保留，未生成链接。");
      }
    }
    lines.push(FORMAL_SOURCE_SECTION_END);
    return lines.join("\n");
  }

  /** Bare-basename wiki links resolve after the Raw folder moves; IDs remain in hidden comments. */
  private wikiLinkTarget(path: string): string {
    const file = this.normalizedPath(path).split("/").pop() || "";
    return file.replace(/\.md$/iu, "").replace(/[|#\[\]]/gu, " ").replace(/\s+/gu, " ").trim();
  }

  private linkExistingVaultFile(path: string): string | null {
    const normalized = this.normalizedPath(path);
    if (!normalized || !this.app?.vault) return null;
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) return null;
    const target = this.wikiLinkTarget(file.path);
    if (!target) return null;
    const label = String(file.name || normalized.split("/").pop() || target).replace(/\r?\n/gu, " ").trim();
    return `[[${target}|${this.escapeWikiAlias(label || target)}]]`;
  }

  private escapeWikiAlias(value: string): string {
    return String(value || "").replace(/[|\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
  }

  private escapeInlineCode(value: string): string {
    return String(value || "").replace(/`/gu, "'").replace(/\r?\n/gu, " ").trim();
  }

  private yamlScalar(value: string): string {
    const clean = String(value || "").replace(/\r?\n/gu, " ");
    if (!clean) return "\"\"";
    const trimmed = clean.trim();
    const needsQuoting =
      clean !== trimmed ||
      /:\s|#|[\[\]{}]/u.test(clean) ||
      /:$/u.test(trimmed) ||
      /^['"]/u.test(trimmed) ||
      /^[-?!&*|>%@`:,]/u.test(trimmed) ||
      /^(true|false|null|~)$/iu.test(trimmed) ||
      /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/u.test(trimmed);
    return needsQuoting ? JSON.stringify(clean) : clean;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }

  private isPendingLlmWikiDraft(markdown: string): boolean {
    const frontmatter = this.parseDraftFrontmatter(markdown);
    return frontmatter?.type === "llm-wiki-draft" && frontmatter?.status === "draft";
  }

  private isAcceptedLlmWikiDraftForTarget(markdown: string, targetPath: string): boolean {
    const frontmatter = this.parseDraftFrontmatter(markdown);
    return (
      frontmatter?.type === "llm-wiki-draft" &&
      frontmatter?.status === "accepted" &&
      this.normalizedPath(frontmatter?.formal_target || "") === this.normalizedPath(targetPath)
    );
  }

  private acceptedDraftBlockMarkers(draftPath: string, targetPath: string, body: string): { start: string; end: string } {
    const metadata = [
      `draft=${encodeURIComponent(this.normalizedPath(draftPath))}`,
      `target=${encodeURIComponent(this.normalizedPath(targetPath))}`,
      `body_hash=${simpleLlmWikiHash(body)}`
    ].join("; ");
    return {
      start: `<!-- llm-wiki-accepted-draft-start: ${metadata} -->`,
      end: `<!-- llm-wiki-accepted-draft-end: ${metadata} -->`
    };
  }

  private targetContainsAcceptedDraftBlock(markdown: string, markers: { start: string; end: string }, body: string): boolean {
    let searchFrom = 0;
    while (searchFrom < markdown.length) {
      const startIndex = markdown.indexOf(markers.start, searchFrom);
      if (startIndex < 0) return false;
      const blockContentStart = startIndex + markers.start.length;
      const endIndex = markdown.indexOf(markers.end, blockContentStart);
      if (endIndex >= 0 && markdown.slice(blockContentStart, endIndex).includes(body)) {
        return true;
      }
      searchFrom = blockContentStart;
    }
    return false;
  }

  private parseDraftSourceIds(markdown: string): string[] {
    const match = String(markdown || "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/);
    if (!match) return [];

    const lines = match[1].split(/\r?\n/);
    const values: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const inline = lines[index].match(/^\s*source_ids\s*:\s*(.*?)\s*$/iu);
      if (!inline) continue;

      const inlineValue = inline[1].replace(/^\[(.*)\]$/u, "$1").trim();
      if (inlineValue) {
        for (const value of this.splitInlineList(inlineValue)) {
          const parsed = this.parseYamlScalar(value);
          if (parsed) values.push(parsed);
        }
      }

      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor];
        if (!line.trim()) continue;
        const item = line.match(/^\s*-\s*(.*?)\s*$/u);
        if (!item) break;
        const parsed = this.parseYamlScalar(item[1]);
        if (parsed) values.push(parsed);
      }
    }
    return Array.from(new Set(values));
  }

  private splitInlineList(value: string): string[] {
    const parts: string[] = [];
    let current = "";
    let quote = "";
    for (const char of value) {
      if (quote) {
        current += char;
        if (char === quote) quote = "";
        continue;
      }
      if (char === "\"" || char === "'") {
        quote = char;
        current += char;
        continue;
      }
      if (char === ",") {
        parts.push(current);
        current = "";
        continue;
      }
      current += char;
    }
    parts.push(current);
    return parts.map((part) => part.trim()).filter(Boolean);
  }

  private parseDraftFrontmatter(markdown: string): Record<string, string> | null {
    const match = String(markdown || "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/);
    if (!match) return null;

    const values: Record<string, string> = {};
    const seenCriticalKeys = new Set<string>();
    for (const line of match[1].split(/\r?\n/)) {
      const pair = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/);
      if (!pair) continue;
      const key = pair[1].toLowerCase();
      if (key === "type" || key === "status" || key === "privacy_level" || key === "ai_processing_allowed") {
        if (seenCriticalKeys.has(key)) return null;
        seenCriticalKeys.add(key);
      }
      values[key] = this.parseYamlScalar(pair[2]);
    }
    return values;
  }

  private normalizeDraftPrivacyLevel(value: string | undefined): "normal" | "private" | "sensitive" {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "private" || normalized === "sensitive") return normalized;
    return "normal";
  }

  private isDraftAiProcessingAllowed(value: string | undefined): boolean {
    return String(value ?? "true").trim().toLowerCase() !== "false";
  }

  private isUnsafeDraftForAcceptance(markdown: string, body: string, fallbackTitle = ""): boolean {
    const frontmatter = this.parseDraftFrontmatter(markdown);
    if (this.normalizeDraftPrivacyLevel(frontmatter?.privacy_level) === "sensitive") return true;
    if (!this.isDraftAiProcessingAllowed(frontmatter?.ai_processing_allowed)) return true;
    const title = String(frontmatter?.title || "").trim() || this.inferDraftTitle(body, fallbackTitle);
    return detectLlmWikiPrivacyLevel(`${title}\n${body}`) === "sensitive";
  }

  private parseYamlScalar(value: string): string {
    const trimmed = String(value || "").trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1).replace(/''/g, "'");
    }
    const commentIndex = trimmed.search(/\s#/);
    return commentIndex >= 0 ? trimmed.slice(0, commentIndex).trimEnd() : trimmed;
  }

  private hasUnsafePathSegments(path: string): boolean {
    return this.normalizedPath(path).split("/").some((segment) => segment === "." || segment === "..");
  }

  private rejectedAcceptance(
    message: string,
    action?: "publish-new" | "merge-existing",
    targetPath?: string
  ): LlmWikiAcceptanceExecutionResult {
    return { ok: false, action, targetPath, message };
  }

  private async createFormalWikiPage(targetPath: string, content: string): Promise<TFile> {
    const folder = targetPath.split("/").slice(0, -1).join("/");
    await ensureFolder(this.app, folder);
    return this.app.vault.create(targetPath, content);
  }

  private async refreshFormalKeywordLinks(file: TFile): Promise<void> {
    const current = await this.app.vault.read(file);
    const title = this.inferDraftTitle(current, file.basename || "");
    // The system source section is provenance, not keyword evidence. Excluding it here
    // prevents headings/IDs in the generated block from becoming wiki keywords.
    const evidence = this.stripFormalSourceSection(current);
    const next = buildKeywordLinkedMarkdown(current, { title, evidence });
    if (next !== current) {
      await this.app.vault.modify(file, next);
    }
  }

  private isCreateConflictError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error || "");
    return /already exists|file exists|path exists/i.test(message);
  }

  private isCurrentFormalTargetFile(expectedPath: string, file: TFile): boolean {
    const normalizedExpected = this.normalizedPath(expectedPath);
    const normalizedFilePath = this.normalizedPath(file.path);
    return (
      normalizedFilePath === normalizedExpected &&
      this.isFormalWikiPath(normalizedFilePath) &&
      this.app.vault.getAbstractFileByPath(normalizedExpected) === file
    );
  }

  private async appendAcceptanceLog(draftPath: string, targetPath: string, acceptedAt: string): Promise<void> {
    await appendFile(
      this.app,
      this.paths.path("Wiki", "log.md"),
      `\n\n- accepted: ${this.normalizedPath(draftPath)}\n  - target: ${targetPath}\n  - at: ${acceptedAt}`
    );
  }

  private async appendSkippedLog(draftPath: string, skippedAt: string, reason: string): Promise<void> {
    await appendFile(
      this.app,
      this.paths.path("Wiki", "log.md"),
      `\n\n- skipped: ${this.normalizedPath(draftPath)}\n  - at: ${skippedAt}\n  - reason: ${reason}`
    );
  }

  private async tryAppendAcceptanceFailureLog(
    draftPath: string,
    targetPath: string,
    acceptedAt: string,
    warning: string
  ): Promise<void> {
    try {
      await appendFile(
        this.app,
        this.paths.path("Wiki", "log.md"),
        `\n\n- acceptance-failed: ${this.normalizedPath(draftPath)}\n  - target: ${targetPath}\n  - at: ${acceptedAt}\n  - warning: ${warning}`
      );
    } catch {
      // The returned warning must preserve the original mark/log failure.
    }
  }

  private isCurrentDraftFile(expectedPath: string, file: TFile): boolean {
    const normalizedExpected = this.normalizedPath(expectedPath);
    const normalizedFilePath = this.normalizedPath(file.path);
    return (
      normalizedFilePath === normalizedExpected &&
      this.isDraftPath(normalizedFilePath) &&
      this.app.vault.getAbstractFileByPath(normalizedExpected) === file
    );
  }

  private vault(): LlmWikiDraftVault {
    return this.app.vault as unknown as LlmWikiDraftVault;
  }
}
