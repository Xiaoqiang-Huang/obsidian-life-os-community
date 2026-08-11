import type { App } from "obsidian";
import type {
  LifeOSProject,
  LifeOSProjectDocument,
  LifeOSProjectDocumentKind
} from "../types";
import { formatDate } from "../utils/dates";
import { joinPath, normalizePath } from "../utils/vault";
import type { FileSystemService } from "./FileSystemService";
import {
  classifyImportedDocument,
  extractReadableDocumentText,
  formatImportedPlainText,
  formatAttachmentSize,
  saveImportedFileToVault,
  type ImportedDocumentKind,
  type ReadableImportFile
} from "./DocumentImportService";
import { buildKeywordLinkedMarkdown, stripKeywordLinksSection } from "./KeywordLinkService";
import { PdfOcrService, type PdfOcrProvider } from "./PdfOcrService";

export { docxXmlToMarkdown, formatImportedPlainText, reconstructPdfPageText } from "./DocumentImportService";
export { formatTesseractBlocksForMarkdown, parsePaddleStructuredOcrResponse } from "./PdfOcrService";

interface VaultFileLike {
  path: string;
  name: string;
  basename?: string;
  extension?: string;
  stat?: { mtime?: number };
  content?: string;
}

interface VaultFolderLike {
  path: string;
  name: string;
  children?: unknown[];
}

interface ProjectDocumentCreateInput {
  title: string;
  kind?: LifeOSProjectDocumentKind;
  content?: string;
}

interface ProjectDocumentListOptions {
  includeTrash?: boolean;
}

export interface ProjectDocumentServiceOptions {
  pdfOcr?: PdfOcrProvider;
  aiFormatter?: ProjectDocumentAiFormatter;
}

export type ProjectDocumentImportKind = ImportedDocumentKind;
export type ProjectDocumentTextImportMode = "attachment-only" | "plain-text" | "ai-formatted";
export type ProjectDocumentImportStage = "saving" | "extracting" | "formatting" | "writing" | "completed";

export interface ProjectDocumentImportProgress {
  fileIndex: number;
  fileCount: number;
  sourceName: string;
  stage: ProjectDocumentImportStage;
  chunkIndex?: number;
  chunkCount?: number;
}

export interface ProjectDocumentImportOptions {
  textMode?: ProjectDocumentTextImportMode;
  onProgress?: (progress: ProjectDocumentImportProgress) => void;
}

export interface ProjectDocumentAiFormatterInput {
  project: LifeOSProject;
  title: string;
  sourceName: string;
  importKind: ProjectDocumentImportKind;
  text: string;
  chunkIndex?: number;
  chunkCount?: number;
  chunkTextLength?: number;
  fullTextLength?: number;
}

export interface ProjectDocumentAiFormatterResult {
  markdown: string;
  warnings?: string[];
}

export type ProjectDocumentAiFormatter = (
  input: ProjectDocumentAiFormatterInput
) => Promise<ProjectDocumentAiFormatterResult | string>;

export interface ProjectDocumentImportResult {
  document: LifeOSProjectDocument;
  sourceName: string;
  attachmentPath: string;
  obsidianLink: string;
  extractedText: boolean;
  textMode: ProjectDocumentTextImportMode;
  warnings: string[];
}

interface ProjectDocumentVault {
  getAbstractFileByPath(path: string): VaultFileLike | VaultFolderLike | null;
  getMarkdownFiles(): VaultFileLike[];
  createFolder(path: string): Promise<VaultFolderLike>;
  create(path: string, content: string): Promise<VaultFileLike>;
  read(file: VaultFileLike): Promise<string>;
  modify(file: VaultFileLike, content: string): Promise<void>;
  rename(file: VaultFileLike, path: string): Promise<void>;
}

const PROJECT_DOCUMENT_KINDS: LifeOSProjectDocumentKind[] = ["note", "meeting", "requirement", "reference", "review"];
const PROJECT_DOCUMENT_TYPE = "lifeos-project-document";
const PROJECT_DOCUMENT_AI_FORMAT_CHUNK_CHARS = 3600;
const PROJECT_DOCUMENT_AI_FORMAT_MIN_RETENTION_RATIO = 0.72;
const PROJECT_DOCUMENT_AI_FORMAT_MARKER_RETENTION_RATIO = 0.86;

export const PROJECT_DOCUMENT_IMPORT_ACCEPT = [
  ".txt",
  "text/plain",
  ".md",
  ".markdown",
  "text/markdown",
  ".csv",
  "text/csv",
  ".json",
  "application/json",
  ".pdf",
  "application/pdf",
  ".doc",
  ".docx",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/*"
].join(",");

export class ProjectDocumentService {
  private defaultPdfOcr?: PdfOcrProvider;

  constructor(private app: App, private fs: FileSystemService, private options: ProjectDocumentServiceOptions = {}) {}

  projectRootPath(project: Pick<LifeOSProject, "id">): string {
    return joinPath(this.fs.path("Projects"), project.id);
  }

  documentsPath(project: Pick<LifeOSProject, "id">): string {
    return joinPath(this.projectRootPath(project), "Documents");
  }

  attachmentsPath(project: Pick<LifeOSProject, "id">): string {
    return joinPath(this.projectRootPath(project), "Attachments");
  }

  trashPath(project: Pick<LifeOSProject, "id">): string {
    return joinPath(this.projectRootPath(project), "Trash");
  }

  async ensureProjectSpace(project: LifeOSProject): Promise<void> {
    const root = this.projectRootPath(project);
    await this.ensureFolder(root);
    await this.ensureFolder(this.documentsPath(project));
    await this.ensureFolder(joinPath(root, "Notes"));
    await this.ensureFolder(joinPath(root, "Attachments"));
    await this.ensureFolder(this.trashPath(project));
    await this.ensureFile(joinPath(root, "index.md"), this.projectIndexMarkdown(project));
  }

  async createDocument(project: LifeOSProject, input: ProjectDocumentCreateInput): Promise<LifeOSProjectDocument> {
    await this.ensureProjectSpace(project);
    const title = this.cleanTitle(input.title);
    const kind = this.normalizeKind(input.kind);
    const path = this.uniquePath(this.documentsPath(project), `${this.slugify(title)}.md`);
    const file = await this.createFile(path, this.documentMarkdown(project, title, kind, input.content ?? ""));
    return this.describeDocument(project, file, await this.readFile(file));
  }

  async importDocuments(
    project: LifeOSProject,
    files: ReadableImportFile[],
    options: ProjectDocumentImportOptions = {}
  ): Promise<ProjectDocumentImportResult[]> {
    await this.ensureProjectSpace(project);
    const results: ProjectDocumentImportResult[] = [];
    const textMode = options.textMode ?? "plain-text";

    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const sourceFile = files[fileIndex];
      const sourceName = sourceFile.name || "imported-file";
      const title = this.cleanTitle(sourceName.replace(/\.[^.]+$/u, "") || sourceName);
      const importKind = this.classifyImportFile(sourceFile);
      const report = (stage: ProjectDocumentImportStage, chunkIndex?: number, chunkCount?: number) => options.onProgress?.({
        fileIndex: fileIndex + 1,
        fileCount: files.length,
        sourceName,
        stage,
        chunkIndex,
        chunkCount
      });
      report("saving");
      const saved = await saveImportedFileToVault(this.app, sourceFile, {
        folderPath: this.attachmentsPath(project)
      });
      report("extracting");
      const extraction = textMode === "attachment-only"
        ? { text: "", warnings: ["Original file saved only. Searchable text conversion was skipped by import option."] }
        : await this.extractImportText(sourceFile, importKind);
      const formatted = await this.prepareImportedDocumentText(project, {
        title,
        sourceFile,
        importKind,
        text: extraction.text,
        textMode,
        onFormattingProgress: (chunkIndex, chunkCount) => report("formatting", chunkIndex, chunkCount)
      });
      report("writing");
      const wrapperPath = this.uniquePath(this.documentsPath(project), `${this.slugify(title)}.md`);
      const wrapper = this.importedDocumentMarkdown(project, {
        title,
        sourceFile,
        importKind,
        attachmentPath: saved.vaultPath,
        obsidianLink: saved.obsidianLink,
        text: formatted.text,
        textMode,
        warnings: [...extraction.warnings, ...formatted.warnings]
      });
      const file = await this.createFile(wrapperPath, wrapper);
      const document = await this.describeDocument(project, file, await this.readFile(file));
      results.push({
        document,
        sourceName,
        attachmentPath: saved.vaultPath,
        obsidianLink: saved.obsidianLink,
        extractedText: Boolean(extraction.text.trim()),
        textMode,
        warnings: [...extraction.warnings, ...formatted.warnings]
      });
      report("completed");
    }

    return results;
  }

  async listDocuments(
    project: LifeOSProject,
    options: ProjectDocumentListOptions = {}
  ): Promise<LifeOSProjectDocument[]> {
    await this.ensureProjectSpace(project);
    const documentsRoot = `${this.documentsPath(project)}/`;
    const trashRoot = `${this.trashPath(project)}/`;
    const files = this.markdownFiles()
      .filter((file) => file.path.startsWith(documentsRoot) || (options.includeTrash && file.path.startsWith(trashRoot)))
      .filter((file) => file.path.toLowerCase().endsWith(".md"))
      .sort((a, b) => (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0) || a.path.localeCompare(b.path));

    const docs: LifeOSProjectDocument[] = [];
    for (const file of files) {
      const content = await this.readFile(file);
      if (this.isAiWorkspaceSessionAsset(file.path, content)) continue;
      docs.push(await this.describeDocument(project, file, content));
    }
    return docs;
  }

  private isAiWorkspaceSessionAsset(path: string, content: string): boolean {
    return /\/Documents\/AI Workspace\//iu.test(path)
      || /^---[\s\S]*?\ntype:\s*ai-workspace-session\s*$/imu.test(content);
  }

  async updateDocument(path: string, content: string): Promise<void> {
    const file = this.getFile(path);
    if (!file) throw new Error(`Project document not found: ${path}`);
    await this.vault().modify(file, buildKeywordLinkedMarkdown(content));
  }

  async renameDocument(project: LifeOSProject, documentOrPath: LifeOSProjectDocument | string, nextTitle: string): Promise<LifeOSProjectDocument> {
    await this.ensureProjectSpace(project);
    const file = this.getFile(this.documentPath(documentOrPath));
    if (!file) throw new Error(`Project document not found: ${this.documentPath(documentOrPath)}`);
    const title = this.cleanTitle(nextTitle);
    const nextPath = this.uniquePath(this.documentsPath(project), `${this.slugify(title)}.md`, file.path);
    await this.renameFile(file, nextPath);
    const renamed = this.getFile(nextPath) ?? { ...file, path: nextPath, name: nextPath.split("/").pop() ?? nextPath };
    return this.describeDocument(project, renamed, await this.readFile(renamed));
  }

  async deleteDocument(project: LifeOSProject, documentOrPath: LifeOSProjectDocument | string): Promise<LifeOSProjectDocument> {
    await this.ensureProjectSpace(project);
    const file = this.getFile(this.documentPath(documentOrPath));
    if (!file) throw new Error(`Project document not found: ${this.documentPath(documentOrPath)}`);
    const nextPath = this.uniquePath(this.trashPath(project), file.name || `${this.slugify(file.path)}.md`);
    await this.renameFile(file, nextPath);
    const moved = this.getFile(nextPath) ?? { ...file, path: nextPath, name: nextPath.split("/").pop() ?? nextPath };
    return this.describeDocument(project, moved, await this.readFile(moved));
  }

  private projectIndexMarkdown(project: LifeOSProject): string {
    const lines = [
      "---",
      "type: lifeos-project",
      `project_id: ${yamlScalar(project.id)}`,
      `project_name: ${yamlScalar(project.name)}`,
      `status: ${yamlScalar(project.status)}`,
      `project_type: ${yamlScalar(project.type)}`,
      `updated: ${formatDate()}`,
      "---",
      "",
      `# ${project.name}`,
      ""
    ];
    if (project.goal) lines.push("## 目标", "", project.goal, "");
    lines.push("## 项目文档", "", "- 文档保存在 `Documents/`。", "- 删除的文档会移动到 `Trash/`。", "");
    return lines.join("\n");
  }

  private documentMarkdown(
    project: LifeOSProject,
    title: string,
    kind: LifeOSProjectDocumentKind,
    content: string
  ): string {
    const body = content.trim() ? content.trim() : "";
    return buildKeywordLinkedMarkdown([
      "---",
      `type: ${PROJECT_DOCUMENT_TYPE}`,
      `project_id: ${yamlScalar(project.id)}`,
      `project_name: ${yamlScalar(project.name)}`,
      `kind: ${yamlScalar(kind)}`,
      `created: ${formatDate()}`,
      `updated: ${formatDate()}`,
      "---",
      "",
      `# ${title}`,
      "",
      body,
      ""
    ].join("\n"), { title });
  }

  private importedDocumentMarkdown(
    project: LifeOSProject,
    input: {
      title: string;
      sourceFile: ReadableImportFile;
      importKind: ProjectDocumentImportKind;
      attachmentPath: string;
      obsidianLink: string;
      text: string;
      textMode: ProjectDocumentTextImportMode;
      warnings: string[];
    }
  ): string {
    const lines = [
      "---",
      `type: ${PROJECT_DOCUMENT_TYPE}`,
      `project_id: ${yamlScalar(project.id)}`,
      `project_name: ${yamlScalar(project.name)}`,
      "kind: reference",
      `source_file: ${yamlScalar(input.attachmentPath)}`,
      `source_name: ${yamlScalar(input.sourceFile.name)}`,
      `source_kind: ${yamlScalar(input.importKind)}`,
      `text_import_mode: ${yamlScalar(input.textMode)}`,
      `source_mime: ${yamlScalar(input.sourceFile.type || "unknown")}`,
      `source_size: ${yamlScalar(formatAttachmentSize(input.sourceFile.size))}`,
      `created: ${formatDate()}`,
      `updated: ${formatDate()}`,
      "---",
      "",
      `# ${input.title}`,
      "",
      "## 原始文件",
      "",
      input.obsidianLink || `[[${input.attachmentPath}]]`,
      "",
      `- 文件名：${input.sourceFile.name}`,
      `- 类型：${input.importKind}`,
      `- 大小：${formatAttachmentSize(input.sourceFile.size)}`,
      ""
    ];

    if (input.warnings.length > 0) {
      lines.push("## 导入说明", "", ...input.warnings.map((warning) => `- ${warning}`), "");
    }

    if (input.text.trim()) {
      lines.push("## 可检索正文", "", input.text.trim(), "");
    }

    return buildKeywordLinkedMarkdown(lines.join("\n"), { title: input.title });
  }

  private async describeDocument(
    project: LifeOSProject,
    file: VaultFileLike,
    markdown: string
  ): Promise<LifeOSProjectDocument> {
    const frontmatter = parseFrontmatter(markdown);
    const readableBody = extractProjectDocumentReadableBody(markdown, Boolean(frontmatter.source_name));
    const plainBody = markdownToPlainDocumentText(readableBody);
    const textImportMode = normalizeProjectDocumentTextImportMode(frontmatter.text_import_mode);
    return {
      projectId: String(frontmatter.project_id || project.id),
      projectName: String(frontmatter.project_name || project.name),
      title: this.inferTitle(file, markdown),
      path: file.path,
      kind: this.normalizeKind(String(frontmatter.kind || "")),
      mtime: file.stat?.mtime ?? 0,
      excerpt: plainBody.slice(0, 220),
      sourceName: optionalFrontmatterValue(frontmatter.source_name),
      sourceKind: optionalFrontmatterValue(frontmatter.source_kind),
      sourceSize: optionalFrontmatterValue(frontmatter.source_size),
      textImportMode,
      characterCount: plainBody.length,
      hasSearchableText: plainBody.length > 0,
      warningCount: countProjectDocumentImportWarnings(markdown)
    };
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    const clean = normalizePath(folderPath);
    if (!clean) return;
    let current = "";
    for (const part of clean.split("/")) {
      current = current ? `${current}/${part}` : part;
      const existing = this.vault().getAbstractFileByPath(current);
      if (this.isFile(existing)) {
        throw new Error(`Cannot create folder "${current}" because a file already exists at that path.`);
      }
      if (existing) continue;
      await this.vault().createFolder(current);
    }
  }

  private async ensureFile(path: string, content: string): Promise<VaultFileLike> {
    const existing = this.vault().getAbstractFileByPath(path);
    if (this.isFile(existing)) return existing;
    if (existing) throw new Error(`Cannot create file "${path}" because a folder already exists at that path.`);
    await this.ensureFolder(path.split("/").slice(0, -1).join("/"));
    return this.createFile(path, content);
  }

  private async createFile(path: string, content: string): Promise<VaultFileLike> {
    return this.vault().create(path, content);
  }

  private async readFile(file: VaultFileLike): Promise<string> {
    return this.vault().read(file);
  }

  private async renameFile(file: VaultFileLike, path: string): Promise<void> {
    await this.vault().rename(file, path);
  }

  private markdownFiles(): VaultFileLike[] {
    return this.vault().getMarkdownFiles();
  }

  private getFile(path: string): VaultFileLike | null {
    const file = this.vault().getAbstractFileByPath(normalizePath(path));
    return this.isFile(file) ? file : null;
  }

  private isFile(value: unknown): value is VaultFileLike {
    if (!value || typeof value !== "object") return false;
    const candidate = value as VaultFileLike;
    return typeof candidate.path === "string" && typeof candidate.name === "string" && "extension" in candidate;
  }

  private vault(): ProjectDocumentVault {
    return this.app.vault as unknown as ProjectDocumentVault;
  }

  private uniquePath(folderPath: string, fileName: string, currentPath?: string): string {
    const cleanName = this.cleanFileName(fileName);
    const extensionIndex = cleanName.lastIndexOf(".");
    const baseName = extensionIndex > 0 ? cleanName.slice(0, extensionIndex) : cleanName;
    const extension = extensionIndex > 0 ? cleanName.slice(extensionIndex) : ".md";
    for (let index = 1; index < 1000; index += 1) {
      const suffix = index === 1 ? "" : `-${index}`;
      const candidate = joinPath(folderPath, `${baseName}${suffix}${extension}`);
      if (candidate === currentPath || !this.vault().getAbstractFileByPath(candidate)) return candidate;
    }
    return joinPath(folderPath, `${baseName}-${Date.now()}${extension}`);
  }

  private documentPath(documentOrPath: LifeOSProjectDocument | string): string {
    return typeof documentOrPath === "string" ? normalizePath(documentOrPath) : normalizePath(documentOrPath.path);
  }

  private cleanTitle(title: string): string {
    const clean = title.trim().replace(/\s+/g, " ");
    if (!clean) throw new Error("Project document title cannot be empty.");
    return clean;
  }

  private slugify(title: string): string {
    const slug = title
      .trim()
      .toLowerCase()
      .replace(/[\\/:*?"<>|#^[\]]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug || `project-doc-${Date.now()}`;
  }

  private cleanFileName(fileName: string): string {
    const clean = fileName.replace(/[\\/:*?"<>|#^[\]]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
    return clean || `project-doc-${Date.now()}.md`;
  }

  private normalizeKind(kind?: string): LifeOSProjectDocumentKind {
    return PROJECT_DOCUMENT_KINDS.includes(kind as LifeOSProjectDocumentKind)
      ? kind as LifeOSProjectDocumentKind
      : "note";
  }

  private inferTitle(file: VaultFileLike, markdown: string): string {
    const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
    return heading || file.basename || (file.name || file.path.split("/").pop() || "Project document").replace(/\.md$/i, "");
  }

  private classifyImportFile(file: ReadableImportFile): ProjectDocumentImportKind {
    return classifyImportedDocument(file.name, file.type || "");
  }

  private async prepareImportedDocumentText(
    project: LifeOSProject,
    input: {
      title: string;
      sourceFile: ReadableImportFile;
      importKind: ProjectDocumentImportKind;
      text: string;
      textMode: ProjectDocumentTextImportMode;
      onFormattingProgress?: (chunkIndex: number, chunkCount: number) => void;
    }
  ): Promise<{ text: string; warnings: string[] }> {
    const raw = input.text.trim();
    if (!raw) return { text: "", warnings: [] };
    const localMarkdown = this.formatExtractedTextForMarkdown(raw, input.importKind);
    if (input.textMode === "plain-text") {
      return { text: localMarkdown, warnings: [] };
    }
    if (input.textMode !== "ai-formatted") {
      return { text: "", warnings: [] };
    }
    if (!this.options.aiFormatter) {
      return {
        text: localMarkdown,
        warnings: ["AI formatting was requested but no formatter is configured. Used local paragraph formatting instead."]
      };
    }

    const chunks = splitMarkdownForAiFormatting(localMarkdown, PROJECT_DOCUMENT_AI_FORMAT_CHUNK_CHARS);
    if (chunks.length === 0) return { text: localMarkdown, warnings: [] };

    const formattedChunks: string[] = [];
    const warnings: string[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      input.onFormattingProgress?.(index + 1, chunks.length);
      try {
        const formatted = await this.options.aiFormatter({
          project,
          title: input.title,
          sourceName: input.sourceFile.name,
          importKind: input.importKind,
          text: chunk,
          chunkIndex: index + 1,
          chunkCount: chunks.length,
          chunkTextLength: chunk.length,
          fullTextLength: localMarkdown.length
        });
        const markdown = typeof formatted === "string" ? formatted : formatted.markdown;
        const clean = stripMarkdownFences(markdown).trim();
        if (!clean) throw new Error("AI formatter returned empty markdown.");
        if (looksLikeAiFormattingDroppedContent(chunk, clean)) {
          formattedChunks.push(chunk);
          warnings.push(`AI formatting batch ${index + 1}/${chunks.length} looked incomplete; kept the locally extracted text for that batch.`);
          continue;
        }
        formattedChunks.push(clean);
        if (typeof formatted !== "string") warnings.push(...formatted.warnings ?? []);
      } catch (error) {
        formattedChunks.push(chunk);
        warnings.push(error instanceof Error
          ? `AI formatting batch ${index + 1}/${chunks.length} failed; kept the locally extracted text for that batch. ${error.message}`
          : `AI formatting batch ${index + 1}/${chunks.length} failed; kept the locally extracted text for that batch.`);
      }
    }
    return { text: joinFormattedImportChunks(formattedChunks), warnings };
  }

  private formatExtractedTextForMarkdown(text: string, kind: ProjectDocumentImportKind): string {
    const normalized = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
    if (!normalized) return "";
    if (kind === "markdown") return normalized;
    if (kind === "json") return `\`\`\`json\n${normalized}\n\`\`\``;
    if (kind === "csv") return `\`\`\`csv\n${normalized}\n\`\`\``;
    return formatImportedPlainText(normalized);
  }

  private async extractImportText(
    file: ReadableImportFile,
    kind: ProjectDocumentImportKind
  ): Promise<{ text: string; warnings: string[] }> {
    try {
      return await extractReadableDocumentText(file, kind, {
        maxTextChars: null,
        enablePdfOcr: true,
        pdfOcr: this.pdfOcrProvider()
      });
    } catch (error) {
      return {
        text: "",
        warnings: [error instanceof Error ? error.message : "File text extraction failed. The original file was saved as a project attachment."]
      };
    }
  }

  private pdfOcrProvider(): PdfOcrProvider {
    if (this.options.pdfOcr) return this.options.pdfOcr;
    this.defaultPdfOcr ??= new PdfOcrService(this.app);
    return this.defaultPdfOcr;
  }
}

function extractProjectDocumentReadableBody(markdown: string, imported: boolean): string {
  const withoutGeneratedLinks = stripKeywordLinksSection(String(markdown || ""));
  const body = withoutGeneratedLinks
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/u, "")
    .replace(/^#\s+.+(?:\r?\n|$)/u, "")
    .trim();
  if (!imported) return body;

  const searchableHeading = body.match(/^##\s+(?:可检索正文|Searchable body)\s*$/imu);
  if (!searchableHeading || searchableHeading.index === undefined) return "";
  return body.slice(searchableHeading.index + searchableHeading[0].length).trim();
}

function markdownToPlainDocumentText(markdown: string): string {
  return String(markdown || "")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/```[A-Za-z0-9_-]*\s*|```/gu, " ")
    .replace(/!\[\[[^\]]+\]\]/gu, " ")
    .replace(/\[\[([^\]|#]+)(?:[|#]([^\]]+))?\]\]/gu, (_match, target: string, alias?: string) => alias || target)
    .replace(/!\[[^\]]*\]\([^)]+\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/^\s*(?:[-*+]>?|\d+[.、．)])\s*/gmu, "")
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gmu, " ")
    .replace(/\|/gu, " ")
    .replace(/[*_~`]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeProjectDocumentTextImportMode(
  value: string | undefined
): LifeOSProjectDocument["textImportMode"] | undefined {
  return value === "attachment-only" || value === "plain-text" || value === "ai-formatted"
    ? value
    : undefined;
}

function optionalFrontmatterValue(value: string | undefined): string | undefined {
  const clean = String(value || "").trim();
  return clean || undefined;
}

function countProjectDocumentImportWarnings(markdown: string): number {
  const body = stripKeywordLinksSection(String(markdown || ""))
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/u, "");
  const heading = body.match(/^##\s+(?:导入说明|Import notes)\s*$/imu);
  if (!heading || heading.index === undefined) return 0;
  const sectionStart = heading.index + heading[0].length;
  const tail = body.slice(sectionStart);
  const nextHeading = tail.search(/^##\s+/mu);
  const section = nextHeading >= 0 ? tail.slice(0, nextHeading) : tail;
  return (section.match(/^\s*[-*+]\s+\S+/gmu) ?? []).length;
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const keyValue = line.match(/^([^:]+):\s*(.*)$/);
    if (!keyValue) continue;
    frontmatter[keyValue[1].trim()] = keyValue[2].trim().replace(/^["']|["']$/g, "");
  }
  return frontmatter;
}

function yamlScalar(value: string): string {
  const clean = value.trim();
  if (/^[A-Za-z0-9_-]+$/.test(clean)) return clean;
  return JSON.stringify(clean);
}

function stripMarkdownFences(markdown: string): string {
  const trimmed = markdown.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function splitMarkdownForAiFormatting(markdown: string, maxChars: number): string[] {
  const normalized = markdown.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];
  const blocks = normalized.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    const clean = current.trim();
    if (clean) chunks.push(clean);
    current = "";
  };

  const appendBlock = (block: string) => {
    const next = current ? `${current}\n\n${block}` : block;
    if (next.length <= maxChars) {
      current = next;
      return;
    }
    pushCurrent();
    if (block.length <= maxChars) {
      current = block;
      return;
    }
    for (const part of splitLongImportBlock(block, maxChars)) {
      if (part.length > maxChars) {
        chunks.push(part);
      } else {
        current = part;
        pushCurrent();
      }
    }
  };

  for (const block of blocks.length > 0 ? blocks : [normalized]) appendBlock(block);
  pushCurrent();
  return chunks;
}

function splitLongImportBlock(block: string, maxChars: number): string[] {
  const sentenceText = block
    .replace(/([。！？；;.!?])\s+/g, "$1\n")
    .replace(/(\d+[.、]\s*)/g, "\n$1")
    .replace(/([A-H][.、]\s*)/g, "\n$1");
  const pieces = sentenceText.split(/\n+/).map((part) => part.trim()).filter(Boolean);
  const parts: string[] = [];
  let current = "";

  const pushCurrent = () => {
    const clean = current.trim();
    if (clean) parts.push(clean);
    current = "";
  };

  for (const piece of pieces.length > 0 ? pieces : [block]) {
    if (piece.length > maxChars) {
      pushCurrent();
      for (let offset = 0; offset < piece.length; offset += maxChars) {
        parts.push(piece.slice(offset, offset + maxChars).trim());
      }
      continue;
    }
    const next = current ? `${current}\n${piece}` : piece;
    if (next.length <= maxChars) {
      current = next;
    } else {
      pushCurrent();
      current = piece;
    }
  }
  pushCurrent();
  return parts;
}

function looksLikeAiFormattingDroppedContent(source: string, formatted: string): boolean {
  const sourceCompact = compactImportTextForRetention(source);
  const formattedCompact = compactImportTextForRetention(formatted);
  if (sourceCompact.length < 180) return false;
  if (formattedCompact.length < sourceCompact.length * PROJECT_DOCUMENT_AI_FORMAT_MIN_RETENTION_RATIO) return true;
  const markers = importantImportRetentionMarkers(sourceCompact);
  if (markers.length === 0) return false;
  const kept = markers.filter((marker) => formattedCompact.includes(marker)).length;
  return kept < Math.ceil(markers.length * PROJECT_DOCUMENT_AI_FORMAT_MARKER_RETENTION_RATIO);
}

function importantImportRetentionMarkers(text: string): string[] {
  const markers = new Set<string>();
  const normalized = text.replace(/\s+/g, "");
  const windowSize = 18;
  const steps = [0.08, 0.24, 0.42, 0.62, 0.82, 0.94];
  for (const step of steps) {
    const index = Math.max(0, Math.min(normalized.length - windowSize, Math.floor(normalized.length * step)));
    const marker = normalized.slice(index, index + windowSize);
    if (marker.length >= 10) markers.add(marker);
  }
  return Array.from(markers);
}

function compactImportTextForRetention(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-z]*|```/gi, ""))
    .replace(/[#>*_`~\-\[\]().:：,，、；;。！？!?\s]/g, "")
    .trim();
}

function joinFormattedImportChunks(chunks: string[]): string {
  return chunks
    .map((chunk) => stripMarkdownFences(chunk).trim())
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
