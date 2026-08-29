import { App, TFile } from "obsidian";
import { FileSystemService } from "./FileSystemService";

export interface LlmWikiPendingInventory {
  rawFiles: TFile[];
  draftFiles: TFile[];
  total: number;
}

/**
 * Single source of truth for the LLM Wiki work queue.
 *
 * Files that have already been accepted or skipped stay in the Drafts folder
 * for traceability, so folder size cannot be used as the pending count.
 */
export class LlmWikiQueueService {
  constructor(private app: App, private fs: FileSystemService) {}

  async inventory(options: { rawLimit?: number; draftLimit?: number } = {}): Promise<LlmWikiPendingInventory> {
    const rawFiles = this.filesUnder(this.fs.path("Knowledge", "LLMWiki", "Raw", "Inbox"));
    const draftCandidates = this.filesUnder(this.fs.path("Knowledge", "LLMWiki", "Wiki", "Drafts"));
    const draftFiles: TFile[] = [];
    for (const file of draftCandidates) {
      if (await this.isPendingDraft(file)) draftFiles.push(file);
      if (typeof options.draftLimit === "number" && draftFiles.length >= options.draftLimit) break;
    }
    const limitedRaw = typeof options.rawLimit === "number" ? rawFiles.slice(0, options.rawLimit) : rawFiles;
    return {
      rawFiles: limitedRaw,
      draftFiles,
      total: limitedRaw.length + draftFiles.length
    };
  }

  async countPending(): Promise<number> {
    return (await this.inventory()).total;
  }

  async listPendingDrafts(limit?: number): Promise<TFile[]> {
    return (await this.inventory({ rawLimit: 0, draftLimit: limit })).draftFiles;
  }

  async isPendingDraft(file: TFile): Promise<boolean> {
    const cached = this.app.metadataCache?.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    const frontmatter = cached ?? this.parseFrontmatter(await this.app.vault.read(file));
    return this.scalar(frontmatter.type) === "llm-wiki-draft"
      && this.scalar(frontmatter.status || "draft") === "draft";
  }

  private filesUnder(root: string): TFile[] {
    const prefix = `${root.replace(/\\/gu, "/").replace(/\/+$/gu, "")}/`;
    return this.app.vault.getMarkdownFiles()
      .filter((file) => {
        const path = file.path.replace(/\\/gu, "/");
        return path.startsWith(prefix) && file.extension === "md" && file.basename !== "index";
      })
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
  }

  private parseFrontmatter(markdown: string): Record<string, string> {
    const match = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/u);
    if (!match) return {};
    const result: Record<string, string> = {};
    for (const line of match[1].split(/\r?\n/u)) {
      const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/u);
      if (field) result[field[1]] = field[2];
    }
    return result;
  }

  private scalar(value: unknown): string {
    return String(value ?? "")
      .trim()
      .replace(/^['"]|['"]$/gu, "")
      .toLowerCase();
  }
}
