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
  formatAttachmentSize,
  saveImportedFileToVault,
  type ImportedDocumentKind,
  type ReadableImportFile
} from "./DocumentImportService";
import { buildKeywordLinkedMarkdown } from "./KeywordLinkService";
import { PdfOcrService, type PdfOcrProvider } from "./PdfOcrService";

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
}

export type ProjectDocumentImportKind = ImportedDocumentKind;

export interface ProjectDocumentImportResult {
  document: LifeOSProjectDocument;
  sourceName: string;
  attachmentPath: string;
  obsidianLink: string;
  extractedText: boolean;
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

  async importDocuments(project: LifeOSProject, files: ReadableImportFile[]): Promise<ProjectDocumentImportResult[]> {
    await this.ensureProjectSpace(project);
    const results: ProjectDocumentImportResult[] = [];

    for (const sourceFile of files) {
      const sourceName = sourceFile.name || "imported-file";
      const title = this.cleanTitle(sourceName.replace(/\.[^.]+$/u, "") || sourceName);
      const importKind = this.classifyImportFile(sourceFile);
      const saved = await saveImportedFileToVault(this.app, sourceFile, {
        folderPath: this.attachmentsPath(project)
      });
      const extraction = await this.extractImportText(sourceFile, importKind);
      const wrapperPath = this.uniquePath(this.documentsPath(project), `${this.slugify(title)}.md`);
      const wrapper = this.importedDocumentMarkdown(project, {
        title,
        sourceFile,
        importKind,
        attachmentPath: saved.vaultPath,
        obsidianLink: saved.obsidianLink,
        text: extraction.text,
        warnings: extraction.warnings
      });
      const file = await this.createFile(wrapperPath, wrapper);
      const document = await this.describeDocument(project, file, await this.readFile(file));
      results.push({
        document,
        sourceName,
        attachmentPath: saved.vaultPath,
        obsidianLink: saved.obsidianLink,
        extractedText: Boolean(extraction.text.trim()),
        warnings: extraction.warnings
      });
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
      docs.push(await this.describeDocument(project, file, await this.readFile(file)));
    }
    return docs;
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
    return {
      projectId: String(frontmatter.project_id || project.id),
      projectName: String(frontmatter.project_name || project.name),
      title: this.inferTitle(file, markdown),
      path: file.path,
      kind: this.normalizeKind(String(frontmatter.kind || "")),
      mtime: file.stat?.mtime ?? 0,
      excerpt: this.excerpt(markdown)
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

  private excerpt(markdown: string): string {
    return markdown
      .replace(/^---[\s\S]*?\n---\s*/m, "")
      .replace(/^#\s+.+$/m, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);
  }

  private classifyImportFile(file: ReadableImportFile): ProjectDocumentImportKind {
    return classifyImportedDocument(file.name, file.type || "");
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
