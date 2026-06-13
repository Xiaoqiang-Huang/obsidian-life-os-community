import { App, TFile, normalizePath } from "obsidian";
import type { DirectoryLanguage } from "../settings";
import { LlmWikiPathService } from "./LlmWikiPathService";
import { appendFile, ensureFolder } from "../utils/vault";
import { buildKeywordLinkedMarkdown } from "./KeywordLinkService";
import {
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

  constructor(private app: App, private rootFolder: string, directoryLanguage: DirectoryLanguage = "en") {
    this.paths = new LlmWikiPathService(app, rootFolder, directoryLanguage);
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
        await this.createFormalWikiPage(targetPath, this.buildFormalWikiMarkdown(current, body));
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

  private buildFormalWikiMarkdown(draftMarkdown: string, body: string, privacyOverride?: "normal" | "private"): string {
    const frontmatter = this.parseDraftFrontmatter(draftMarkdown) ?? {};
    const privacyLevel = privacyOverride ?? this.normalizeDraftPrivacyLevel(frontmatter.privacy_level);
    const title = this.inferDraftTitle(draftMarkdown, "");
    return buildKeywordLinkedMarkdown([
      "---",
      "type: llm-wiki-formal",
      `privacy_level: ${privacyLevel}`,
      "ai_processing_allowed: true",
      "---",
      "",
      body,
      ""
    ].join("\n"), { title });
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
    const next = buildKeywordLinkedMarkdown(current, { title });
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
