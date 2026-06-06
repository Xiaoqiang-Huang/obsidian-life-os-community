import { App, TFolder } from "obsidian";
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
  ["Reviews", "Daily"],
  ["Reviews", "Weekly"],
  ["Reviews", "Monthly"]
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
    return LIFEOS_FOLDER_STRUCTURE
      .map((parts) => ({
        from: this.pathForLanguage(sourceLanguage, ...parts),
        to: this.pathForLanguage(targetLanguage, ...parts)
      }))
      .filter((pair) => pair.from !== pair.to);
  }

  async migrateLocalizedFolders(): Promise<void> {
    for (const pair of this.localizedFolderMovePairs()) {
      const source = this.app.vault.getAbstractFileByPath(pair.from);
      if (!(source instanceof TFolder)) continue;
      if (this.app.vault.getAbstractFileByPath(pair.to)) continue;
      await ensureFolder(this.app, pair.to.split("/").slice(0, -1).join("/"));
      await this.app.fileManager.renameFile(source, pair.to);
    }
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
