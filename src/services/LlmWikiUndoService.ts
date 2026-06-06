import { App, TFile } from "obsidian";
import type { DirectoryLanguage } from "../settings";
import { appendFile, ensureFolder, normalizePath, readFile } from "../utils/vault";
import { LlmWikiPathService } from "./LlmWikiPathService";

export class LlmWikiUndoService {
  private paths: LlmWikiPathService;

  constructor(private app: App, rootFolder = "PersonalLifeSystem", directoryLanguage: DirectoryLanguage = "en") {
    this.paths = new LlmWikiPathService(app, rootFolder, directoryLanguage);
  }

  async undoBatch(batchPath: string): Promise<string[]> {
    const manifest = await readFile(this.app, batchPath);
    const createdFiles = this.extractList(manifest, "created_files");
    const moved = await this.undoFiles(createdFiles);

    await this.appendLog(`undo-batch: ${batchPath}; moved ${moved.length}\n`);
    return moved;
  }

  async undoFiles(paths: string[]): Promise<string[]> {
    const moved: string[] = [];

    for (const path of paths) {
      const cleanPath = normalizePath(path);
      if (!this.isUndoableLlmWikiPath(cleanPath)) continue;

      const file = this.app.vault.getAbstractFileByPath(cleanPath);
      if (!(file instanceof TFile)) continue;

      const target = this.uniqueTrashPathFor(cleanPath);
      const targetFolder = target.split("/").slice(0, -1).join("/");
      await ensureFolder(this.app, targetFolder);
      await this.app.vault.rename(file, target);
      moved.push(target);
    }

    await this.appendLog(`undo-files: moved ${moved.length}\n`);
    return moved;
  }

  private isUndoableLlmWikiPath(path: string): boolean {
    const cleanPath = normalizePath(path);
    const prefixes = [
      this.paths.path("Raw", "Inbox"),
      this.paths.path("Raw", "Sources"),
      this.paths.path("Raw", "Versions"),
      this.paths.path("Wiki", "Drafts"),
      this.paths.path("Wiki", "Batches")
    ];

    return prefixes.some((prefix) => cleanPath.startsWith(`${prefix}/`));
  }

  private extractList(markdown: string, key: string): string[] {
    const lines = markdown.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim() === `${key}:`);
    if (start < 0) return [];

    const values: string[] = [];
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;

      const itemMatch = line.match(/^\s*-\s*(.*?)\s*$/);
      if (!itemMatch) break;

      const value = this.unquoteYamlListValue(itemMatch[1].trim());
      if (value) values.push(value);
    }

    return values;
  }

  private trashPathFor(path: string): string {
    const cleanPath = normalizePath(path);
    const filename = cleanPath.split("/").pop() ?? "unknown.md";
    const wikiRoot = this.paths.path("Wiki");

    if (cleanPath.startsWith(`${wikiRoot}/Drafts/`)) {
      return this.paths.path("Trash", "Drafts", filename);
    }
    if (cleanPath.startsWith(`${wikiRoot}/Batches/`)) {
      return this.paths.path("Trash", "Batches", filename);
    }
    return this.paths.path("Trash", "Raw", filename);
  }

  private uniqueTrashPathFor(path: string): string {
    const firstTarget = this.trashPathFor(path);
    if (!this.app.vault.getAbstractFileByPath(firstTarget)) return firstTarget;

    const slashIndex = firstTarget.lastIndexOf("/");
    const folder = slashIndex >= 0 ? firstTarget.slice(0, slashIndex) : "";
    const filename = slashIndex >= 0 ? firstTarget.slice(slashIndex + 1) : firstTarget;
    const dotIndex = filename.lastIndexOf(".");
    const hasExtension = dotIndex > 0;
    const basename = hasExtension ? filename.slice(0, dotIndex) : filename;
    const extension = hasExtension ? filename.slice(dotIndex) : "";

    for (let index = 2; index <= 999; index += 1) {
      const candidateName = `${basename}_${index}${extension}`;
      const candidate = folder ? `${folder}/${candidateName}` : candidateName;
      if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
    }

    throw new Error(`Could not find an available Trash path for "${path}".`);
  }

  private unquoteYamlListValue(value: string): string {
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }
    return value;
  }

  private async appendLog(line: string): Promise<void> {
    await appendFile(this.app, this.paths.path("Wiki", "log.md"), line);
  }
}
