import { App, TAbstractFile, TFolder } from "obsidian";
import type { DirectoryLanguage } from "../settings";
import { localizeLifeOsPathParts, normalizeDirectoryLanguage } from "../settings";
import { formatDate } from "../utils/dates";
import { ensureFile, ensureFolder, joinPath, normalizePath } from "../utils/vault";
import { LlmWikiPathService } from "./LlmWikiPathService";

export const LIFEOS_MEMORY_CATEGORIES = ["学业", "项目", "备考", "人际", "健康", "偏好", "其他"];

const LIFEOS_FOLDER_STRUCTURE = [
  ["Chat"],
  ["Daily"],
  ["Exam"],
  ["Inbox"],
  ["Knowledge"],
  ["Memory"],
  ["Projects"],
  ["Reports"],
  ["Reviews"],
  ["Tasks"],
  ["Templates"],
  ["Exports"],
  ["Memory", "Core"],
  ["Memory", "Inbox"],
  ["Memory", "Episodes"],
  ["Memory", "Summaries"],
  ["Memory", "Summaries", "Daily"],
  ["Memory", "Summaries", "Weekly"],
  ["Memory", "Summaries", "Monthly"],
  ["Memory", "Summaries", "Yearly"],
  ["Exam", "Xingce"],
  ["Exam", "Interview"],
  ["Exam", "QuestionBank"],
  ["Exam", "Goals"],
  ["Exam", "Tasks"],
  ["Exam", "Checkins"],
  ["Exam", "Materials"],
  ["Knowledge", "Materials"],
  ["Knowledge", "Books"],
  ["Knowledge", "Mistakes"],
  ["Knowledge", "Attachments"],
  ["Reviews", "Daily"],
  ["Reviews", "Weekly"],
  ["Reviews", "Monthly"]
];

const LIFEOS_LLM_WIKI_FOLDER_STRUCTURE = [
  ["Knowledge", "LLMWiki"],
  ["Knowledge", "LLMWiki", "Raw"],
  ["Knowledge", "LLMWiki", "Raw", "Inbox"],
  ["Knowledge", "LLMWiki", "Raw", "Sources"],
  ["Knowledge", "LLMWiki", "Raw", "Versions"],
  ["Knowledge", "LLMWiki", "Wiki"],
  ["Knowledge", "LLMWiki", "Wiki", "Drafts"],
  ["Knowledge", "LLMWiki", "Wiki", "Sources"],
  ["Knowledge", "LLMWiki", "Wiki", "Concepts"],
  ["Knowledge", "LLMWiki", "Wiki", "Entities"],
  ["Knowledge", "LLMWiki", "Wiki", "Questions"],
  ["Knowledge", "LLMWiki", "Wiki", "Syntheses"],
  ["Knowledge", "LLMWiki", "Wiki", "Contradictions"],
  ["Knowledge", "LLMWiki", "Wiki", "Batches"],
  ["Knowledge", "LLMWiki", "Schema"],
  ["Knowledge", "LLMWiki", "Reports"],
  ["Knowledge", "LLMWiki", "Trash"],
  ["Knowledge", "LLMWiki", "Trash", "Raw"],
  ["Knowledge", "LLMWiki", "Trash", "Drafts"],
  ["Knowledge", "LLMWiki", "Trash", "Batches"]
];

export class FileSystemService {
  constructor(
    private app: App,
    private rootFolder: string,
    private directoryLanguage: DirectoryLanguage = "en"
  ) {}

  get root(): string {
    return normalizePath(this.rootFolder || "PersonalLifeSystem");
  }

  path(...parts: string[]): string {
    return joinPath(this.root, ...localizeLifeOsPathParts(parts, normalizeDirectoryLanguage(this.directoryLanguage)));
  }

  pathForLanguage(language: DirectoryLanguage, ...parts: string[]): string {
    return joinPath(this.root, ...localizeLifeOsPathParts(parts, normalizeDirectoryLanguage(language)));
  }

  localizedFolderMovePairs(): Array<{ from: string; to: string }> {
    const targetLanguage = normalizeDirectoryLanguage(this.directoryLanguage);
    const sourceLanguage: DirectoryLanguage = targetLanguage === "zh" ? "en" : "zh";
    const pairsBySource = new Map<string, { from: string; to: string }>();
    for (const parts of [...LIFEOS_FOLDER_STRUCTURE, ...LIFEOS_LLM_WIKI_FOLDER_STRUCTURE]) {
      const to = this.pathForLanguage(targetLanguage, ...parts);
      for (const from of this.localizedSourceVariantPaths(parts, targetLanguage, sourceLanguage)) {
        if (from !== to && !pairsBySource.has(from)) pairsBySource.set(from, { from, to });
      }
    }
    return Array.from(pairsBySource.values())
      .sort((a, b) => b.from.split("/").length - a.from.split("/").length || b.from.length - a.from.length);
  }

  private localizedSourceVariantPaths(
    parts: string[],
    targetLanguage: DirectoryLanguage,
    sourceLanguage: DirectoryLanguage
  ): string[] {
    let variants: Array<{ segments: string[]; hasSourceSegment: boolean }> = [{ segments: [], hasSourceSegment: false }];
    for (const part of parts) {
      const targetName = localizeLifeOsPathParts([part], targetLanguage)[0] || part;
      const sourceName = localizeLifeOsPathParts([part], sourceLanguage)[0] || part;
      const options = sourceName === targetName
        ? [{ name: targetName, isSource: false }]
        : [{ name: targetName, isSource: false }, { name: sourceName, isSource: true }];

      const nextVariants: Array<{ segments: string[]; hasSourceSegment: boolean }> = [];
      for (const variant of variants) {
        for (const option of options) {
          nextVariants.push({
            segments: [...variant.segments, option.name],
            hasSourceSegment: variant.hasSourceSegment || option.isSource
          });
        }
      }
      variants = nextVariants;
    }

    return Array.from(new Set(
      variants
        .filter((variant) => variant.hasSourceSegment)
        .map((variant) => joinPath(this.root, ...variant.segments))
    ));
  }

  async migrateLocalizedFolders(): Promise<void> {
    for (const pair of this.localizedFolderMovePairs()) {
      const source = this.app.vault.getAbstractFileByPath(pair.from);
      if (!(source instanceof TFolder)) continue;
      await this.moveOrMergeFolder(source, pair.to);
    }
  }

  private async moveOrMergeFolder(source: TFolder, targetPath: string): Promise<void> {
    const target = this.app.vault.getAbstractFileByPath(targetPath);
    if (target instanceof TFolder) {
      await this.mergeFolderContents(source, target);
      return;
    }
    if (target) return;

    await ensureFolder(this.app, targetPath.split("/").slice(0, -1).join("/"));
    await this.app.fileManager.renameFile(source, targetPath);
  }

  private async mergeFolderContents(source: TFolder, target: TFolder): Promise<void> {
    for (const child of [...source.children]) {
      await this.moveOrMergeChild(child, target);
    }

    const refreshedSource = this.app.vault.getAbstractFileByPath(source.path);
    if (refreshedSource instanceof TFolder && refreshedSource.children.length === 0) {
      await this.app.vault.delete(refreshedSource, true);
    }
  }

  private async moveOrMergeChild(child: TAbstractFile, target: TFolder): Promise<void> {
    const targetChildPath = joinPath(target.path, child.name);
    const existing = this.app.vault.getAbstractFileByPath(targetChildPath);
    if (child instanceof TFolder && existing instanceof TFolder) {
      await this.mergeFolderContents(child, existing);
      return;
    }

    const nextPath = existing ? this.uniqueMergeChildPath(target.path, child.name) : targetChildPath;
    await ensureFolder(this.app, nextPath.split("/").slice(0, -1).join("/"));
    await this.app.fileManager.renameFile(child, nextPath);
  }

  private uniqueMergeChildPath(targetFolderPath: string, childName: string): string {
    const extensionIndex = childName.lastIndexOf(".");
    const hasExtension = extensionIndex > 0;
    const baseName = hasExtension ? childName.slice(0, extensionIndex) : childName;
    const extension = hasExtension ? childName.slice(extensionIndex) : "";

    for (let index = 2; index < 100; index += 1) {
      const candidate = joinPath(targetFolderPath, `${baseName}_${index}${extension}`);
      if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
    }
    return joinPath(targetFolderPath, `${baseName}_${Date.now()}${extension}`);
  }

  async ensureBaseStructure(): Promise<void> {
    await this.migrateLocalizedFolders();

    const folders = [
      this.root,
      ...LIFEOS_FOLDER_STRUCTURE.map((parts) => this.path(...parts))
    ];

    for (const folder of folders) {
      await ensureFolder(this.app, folder);
    }

    await ensureFile(this.app, this.path("Tasks", "open.md"), "# 未完成待办\n\n");
    await ensureFile(this.app, this.path("Tasks", "done.md"), "# 已完成待办\n\n");
    await ensureFile(this.app, this.path("Knowledge", "index.md"), "# 知识库\n\n这里可以整理学习资料、读书笔记、错题知识点和长期参考材料。\n\n");
    await ensureFile(this.app, this.path("Projects", "index.md"), "# Projects\n\n");
    await ensureFile(
      this.app,
      this.path("Memory", "Core", "profile.md"),
      `# 用户画像\n\n- updated: ${formatDate()}\n`
    );
    await ensureFile(
      this.app,
      this.path("Memory", "Core", "current-projects.md"),
      `# 当前项目\n\n- updated: ${formatDate()}\n`
    );
    await ensureFile(
      this.app,
      this.path("Memory", "Inbox", "pending-memories.md"),
      "# 待确认记忆\n\n"
    );

    for (const category of LIFEOS_MEMORY_CATEGORIES) {
      await ensureFile(this.app, this.path("Memory", `${category}.md`), `# ${category}记忆\n\n`);
    }

    await new LlmWikiPathService(this.app, this.root, this.directoryLanguage).ensureBaseStructure();
  }

}
