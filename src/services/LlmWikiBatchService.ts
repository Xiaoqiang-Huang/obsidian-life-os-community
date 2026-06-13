import { App } from "obsidian";
import type { DirectoryLanguage } from "../settings";
import { ensureFolder } from "../utils/vault";
import { LlmWikiPathService } from "./LlmWikiPathService";
import { LlmWikiCompilerService, type CompileLlmWikiSourceInput } from "./LlmWikiCompilerService";
import {
  buildLlmWikiBatchMarkdown,
  classifyLlmWikiMaterialLength,
  type LlmWikiBatchOperation
} from "./llm-wiki-logic";

export interface LlmWikiBatchManifestInput {
  id: string;
  createdAt: string;
  operation: LlmWikiBatchOperation;
  sourceIds: string[];
  createdFiles: string[];
  modifiedFiles: string[];
  skippedFiles: string[];
  errors: string[];
  revertOf?: string;
}

export class LlmWikiBatchService {
  private paths: LlmWikiPathService;

  constructor(
    private app: App,
    rootFolder: string,
    private compiler?: LlmWikiCompilerService,
    directoryLanguage: DirectoryLanguage = "en"
  ) {
    this.paths = new LlmWikiPathService(app, rootFolder, directoryLanguage);
  }

  async writeBatchManifest(input: LlmWikiBatchManifestInput): Promise<string> {
    const safeId = this.sanitizeManifestId(input.id);
    const folder = this.paths.path("Wiki", "Batches");
    await ensureFolder(this.app, folder);

    for (let index = 1; index <= 1000; index += 1) {
      const id = index === 1 ? safeId : `${safeId}_${index}`;
      const path = this.paths.path("Wiki", "Batches", `${id}.md`);
      const markdown = buildLlmWikiBatchMarkdown({ ...input, id });

      if (this.app.vault.getAbstractFileByPath(path)) {
        continue;
      }

      try {
        await this.app.vault.create(path, markdown);
        return path;
      } catch (error) {
        if (this.isCreateConflictError(error) || this.app.vault.getAbstractFileByPath(path)) {
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Could not create unique LLM Wiki batch manifest for ${safeId}`);
  }

  async processShortSources(sources: CompileLlmWikiSourceInput[]): Promise<{ createdFiles: string[]; skipped: string[]; errors: string[]; processedSourceIds: string[] }> {
    const createdFiles: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];
    const processedSourceIds: string[] = [];

    for (const source of sources) {
      const materialLength = classifyLlmWikiMaterialLength(source.rawContent);
      if (materialLength !== "short") {
        skipped.push(source.sourceId);
        continue;
      }

      try {
        if (!this.compiler) {
          skipped.push(source.sourceId);
          continue;
        }

        const draft = await this.compiler.compileSourceToDraft(source);
        createdFiles.push(draft.path);
        processedSourceIds.push(source.sourceId);
      } catch (error) {
        errors.push(`${source.sourceId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { createdFiles, skipped, errors, processedSourceIds };
  }

  private sanitizeManifestId(id: string): string {
    return String(id || "batch")
      .trim()
      .replace(/[<>:"|?*\x00-\x1F\\/]+/g, "-")
      .replace(/^-+|-+$/g, "") || "batch";
  }

  private isCreateConflictError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error || "");
    return /already exists|path exists|file exists/i.test(message);
  }
}
