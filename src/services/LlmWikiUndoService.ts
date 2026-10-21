import { App, TFile } from "obsidian";
import type { DirectoryLanguage } from "../settings";
import { appendFile, ensureFolder, normalizePath, readFile } from "../utils/vault";
import { isInternalTrashPath } from "./context-engine/ContextSourcePolicyService";
import { LlmWikiPathService } from "./LlmWikiPathService";
import { LlmWikiChangeService, type WikiChangeSet } from "./LlmWikiChangeService";

/** One recorded undo move: the eligible location and the internal Trash location. */
export interface LlmWikiUndoMove {
  from: string;
  to: string;
}

export class LlmWikiUndoService {
  private paths: LlmWikiPathService;

  constructor(private app: App, private rootFolder = "PersonalLifeSystem", private directoryLanguage: DirectoryLanguage = "en") {
    this.paths = new LlmWikiPathService(app, rootFolder, directoryLanguage);
  }

  /** Formal-page undo is version guarded and durable; batch trash permissions stay unchanged. */
  async undoKnowledgeUpdate(receiptPath: string, approvedVersion: string): Promise<WikiChangeSet> {
    return new LlmWikiChangeService(this.app, { rootFolder: this.rootFolder, directoryLanguage: this.directoryLanguage }).undo(receiptPath, approvedVersion);
  }

  async undoBatch(batchPath: string): Promise<string[]> {
    const manifest = await readFile(this.app, batchPath);
    const createdFiles = this.extractList(manifest, "created_files");
    const moved = await this.undoFiles(createdFiles);

    await this.appendLog(`undo-batch: ${batchPath}; moved ${moved.length}\n`);
    return moved;
  }

  async undoFiles(paths: string[]): Promise<string[]> {
    const moves: LlmWikiUndoMove[] = [];

    for (const path of paths) {
      const cleanPath = normalizePath(path);
      if (!this.isUndoableLlmWikiPath(cleanPath)) continue;

      const file = this.app.vault.getAbstractFileByPath(cleanPath);
      if (!(file instanceof TFile)) continue;

      const target = this.uniqueTrashPathFor(cleanPath);
      const targetFolder = target.split("/").slice(0, -1).join("/");
      await ensureFolder(this.app, targetFolder);
      await this.app.vault.rename(file, target);
      moves.push({ from: cleanPath, to: target });
    }

    await this.appendUndoReceipt(moves);
    await this.appendLog(`undo-files: moved ${moves.length}\n`);
    return moves.map((move) => move.to);
  }

  /**
   * The reverse of undoFiles: move internally trashed sources back to the location their undo
   * receipt recorded. The original folder is never guessed from the Trash layout (Trash/Raw can
   * come from Inbox, Sources or Versions), so a file without a receipt stays where the user put
   * it. An occupied original location restores beside it instead of overwriting anything.
   */
  async restoreFiles(paths: string[]): Promise<string[]> {
    const recorded = await this.readUndoMoves();
    const restored: string[] = [];

    for (const path of paths) {
      const cleanPath = normalizePath(path);
      if (!isInternalTrashPath(cleanPath)) continue;

      const file = this.app.vault.getAbstractFileByPath(cleanPath);
      if (!(file instanceof TFile)) continue;

      const original = recorded.get(cleanPath);
      if (!original || !this.isUndoableLlmWikiPath(original)) continue;

      const target = this.uniqueSiblingPath(original);
      const targetFolder = target.split("/").slice(0, -1).join("/");
      await ensureFolder(this.app, targetFolder);
      await this.app.vault.rename(file, target);
      restored.push(target);
    }

    await this.appendLog(`restore-files: restored ${restored.length}\n`);
    return restored;
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
    const draftsRoot = this.paths.path("Wiki", "Drafts");
    const batchesRoot = this.paths.path("Wiki", "Batches");

    if (cleanPath.startsWith(`${draftsRoot}/`)) {
      return this.paths.path("Trash", "Drafts", filename);
    }
    if (cleanPath.startsWith(`${batchesRoot}/`)) {
      return this.paths.path("Trash", "Batches", filename);
    }
    return this.paths.path("Trash", "Raw", filename);
  }

  private uniqueTrashPathFor(path: string): string {
    return this.uniqueSiblingPath(this.trashPathFor(path));
  }

  /** First free sibling path (`name_2.md`, `name_3.md`, …); never overwrites an existing file. */
  private uniqueSiblingPath(target: string): string {
    const firstTarget = normalizePath(target);
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

    throw new Error(`Could not find an available path for "${target}".`);
  }

  /** Append-only undo receipts under the internal Trash: the state marker a restore reuses. */
  private receiptPath(): string {
    return this.paths.path("Trash", "receipts.jsonl");
  }

  private async appendUndoReceipt(moves: LlmWikiUndoMove[]): Promise<void> {
    if (moves.length === 0) return;
    await appendFile(this.app, this.receiptPath(), `${JSON.stringify({ version: 1, at: new Date().toISOString(), moves })}\n`);
  }

  /** Latest receipt wins for a Trash path, so a restore+re-undo cycle keeps the newest mapping. */
  private async readUndoMoves(): Promise<Map<string, string>> {
    const recorded = new Map<string, string>();
    const receipts = await readFile(this.app, this.receiptPath());
    for (const line of receipts.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { moves?: Array<Partial<LlmWikiUndoMove>> };
        if (!parsed || !Array.isArray(parsed.moves)) continue;
        for (const move of parsed.moves) {
          if (typeof move?.from !== "string" || typeof move?.to !== "string") continue;
          recorded.set(normalizePath(move.to), normalizePath(move.from));
        }
      } catch {
        // A corrupt receipt line must never block a restore of the other files.
      }
    }
    return recorded;
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
