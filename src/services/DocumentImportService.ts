import type { App, TFile } from "obsidian";
import { ensureFolder, joinPath, normalizePath } from "../utils/vault";

export type ImportedDocumentKind = "text" | "markdown" | "csv" | "json" | "pdf" | "image" | "unknown";

export interface ReadableImportFile {
  name: string;
  type?: string;
  size: number;
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}

export interface ImportedDocument {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: ImportedDocumentKind;
  text: string;
  dataUrl?: string;
  vaultPath?: string;
  obsidianLink?: string;
  warnings: string[];
}

export interface ReadImportedFileOptions {
  maxBytes: number;
  allowImageVision: boolean;
  maxTextChars?: number;
}

export interface SaveImportedFileToVaultOptions {
  folderPath: string;
}

export interface SavedImportedFile {
  vaultPath: string;
  obsidianLink: string;
}

const DEFAULT_MAX_TEXT_CHARS = 24000;
const IMAGE_MIME_MARKER = "image/*";
const PDF_MIME_MARKER = "application/pdf";

export const CHAT_IMPORT_ACCEPT = [
  ".txt",
  "text/plain",
  ".md",
  ".markdown",
  "text/markdown",
  ".csv",
  "text/csv",
  ".json",
  "application/json",
  IMAGE_MIME_MARKER
].join(",");

export function classifyImportedDocument(name: string, mimeType = ""): ImportedDocumentKind {
  const lowerName = name.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  if (lowerMime.startsWith("image/")) return "image";
  if (lowerMime === PDF_MIME_MARKER || lowerName.endsWith(".pdf")) return "pdf";
  if (lowerMime.includes("json") || lowerName.endsWith(".json")) return "json";
  if (lowerMime.includes("csv") || lowerName.endsWith(".csv")) return "csv";
  if (lowerMime.includes("markdown") || lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) return "markdown";
  if (lowerMime.startsWith("text/") || lowerName.endsWith(".txt")) return "text";
  return "unknown";
}

export function isSupportedImportKind(kind: ImportedDocumentKind): boolean {
  return kind !== "unknown" && kind !== "pdf";
}

export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function readImportedFile(
  file: ReadableImportFile,
  options: ReadImportedFileOptions
): Promise<ImportedDocument> {
  const mimeType = file.type || "";
  const kind = classifyImportedDocument(file.name, mimeType);
  const warnings: string[] = [];
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;

  if (kind === "pdf") {
    throw new Error("PDF 解析暂未开放。请先把 PDF 转成文本或 Markdown；扫描件可以截图后配合视觉模型识别。");
  }
  if (!isSupportedImportKind(kind)) {
    throw new Error(`Unsupported file type: ${file.name}`);
  }
  if (file.size > options.maxBytes) {
    throw new Error(`${file.name} is larger than ${formatAttachmentSize(options.maxBytes)}.`);
  }

  let text = "";
  let dataUrl: string | undefined;

  if (kind === "image") {
    if (options.allowImageVision) {
      dataUrl = await readFileAsDataUrl(file, mimeType || inferImageMime(file.name));
      text = `[Image attachment: ${file.name}]`;
    } else {
      warnings.push("Image recognition requires a configured vision model.");
      text = `[Image attachment: ${file.name}; visual analysis disabled]`;
    }
  } else {
    text = await readTextLikeFile(file, kind, maxTextChars);
  }

  return {
    id: uniqueImportedDocumentId(file.name, file.size, kind),
    name: file.name,
    mimeType,
    size: file.size,
    kind,
    text: capText(text, maxTextChars),
    dataUrl,
    warnings
  };
}

export function buildImportedDocumentsMarkdown(documents: ImportedDocument[]): string {
  const usable = documents.filter((item) => item.text.trim() || item.warnings.length > 0);
  if (usable.length === 0) return "";
  const parts = ["## Imported files"];
  for (const document of usable) {
    parts.push(
      [
        `### ${document.name}`,
        `- Type: ${document.kind}`,
        `- MIME: ${document.mimeType || "unknown"}`,
        `- Size: ${formatAttachmentSize(document.size)}`,
        document.vaultPath ? `- Vault path: ${document.vaultPath}` : "",
        document.obsidianLink ? `- Obsidian link: ${document.obsidianLink}` : ""
      ].filter(Boolean).join("\n")
    );
    if (document.warnings.length > 0) {
      parts.push(`Warnings:\n${document.warnings.map((warning) => `- ${warning}`).join("\n")}`);
    }
    if (document.text.trim()) {
      parts.push(`Content excerpt:\n\n${document.text.trim()}`);
    }
  }
  return parts.join("\n\n").trim();
}

export function buildImportedDocumentsSummary(documents: ImportedDocument[]): string {
  if (documents.length === 0) return "";
  return documents
    .map((item) => `- ${item.name} (${item.kind}, ${formatAttachmentSize(item.size)})${item.vaultPath ? ` -> ${item.vaultPath}` : ""}`)
    .join("\n");
}

export async function saveImportedFileToVault(
  app: App,
  file: ReadableImportFile,
  options: SaveImportedFileToVaultOptions
): Promise<SavedImportedFile> {
  const folderPath = normalizePath(options.folderPath);
  if (!folderPath) {
    throw new Error("Attachment archive folder is not configured.");
  }
  await ensureFolder(app, folderPath);
  const bytes = await readFileBytes(file);
  const vaultPath = uniqueVaultFilePath(app, folderPath, file.name);
  const binary = new Uint8Array(bytes).buffer;
  const vault = app.vault as App["vault"] & {
    createBinary?: (path: string, data: ArrayBuffer) => Promise<TFile>;
  };
  if (typeof vault.createBinary !== "function") {
    throw new Error("Current Obsidian vault does not support binary file creation.");
  }
  await vault.createBinary(vaultPath, binary);
  return {
    vaultPath,
    obsidianLink: formatImportedDocumentLink({ kind: classifyImportedDocument(file.name, file.type || ""), vaultPath })
  };
}

export function formatImportedDocumentReference(document: Pick<ImportedDocument, "name" | "kind" | "vaultPath" | "obsidianLink">): string {
  if (!document.vaultPath) return `- ${document.name}`;
  return `- ${document.name}: ${document.obsidianLink || formatImportedDocumentLink(document)}`;
}

function formatImportedDocumentLink(document: Pick<ImportedDocument, "kind" | "vaultPath">): string {
  if (!document.vaultPath) return "";
  return document.kind === "image" ? `![[${document.vaultPath}]]` : `[[${document.vaultPath}]]`;
}

function uniqueImportedDocumentId(name: string, size: number, kind: ImportedDocumentKind): string {
  const safeName = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "file";
  return `${kind}-${Date.now().toString(36)}-${randomImportedDocumentSuffix()}-${size}-${safeName}`;
}

function randomImportedDocumentSuffix(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

function uniqueVaultFilePath(app: App, folderPath: string, fileName: string): string {
  const safeName = safeImportedFileName(fileName);
  const extensionIndex = safeName.lastIndexOf(".");
  const stem = extensionIndex > 0 ? safeName.slice(0, extensionIndex) : safeName;
  const extension = extensionIndex > 0 ? safeName.slice(extensionIndex) : "";
  let candidate = joinPath(folderPath, safeName);
  let counter = 2;
  while (app.vault.getAbstractFileByPath(candidate)) {
    candidate = joinPath(folderPath, `${stem}-${counter}${extension}`);
    counter += 1;
  }
  return candidate;
}

function safeImportedFileName(fileName: string): string {
  const normalized = fileName
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|#^[\]]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return normalized || "imported-file";
}

async function readTextLikeFile(file: ReadableImportFile, kind: ImportedDocumentKind, maxChars: number): Promise<string> {
  const raw = await readFileText(file);
  if (kind !== "json") return capText(raw, maxChars);
  try {
    const parsed = JSON.parse(raw) as unknown;
    return capText(JSON.stringify(parsed, null, 2), maxChars);
  } catch {
    return capText(raw, maxChars);
  }
}

async function readFileText(file: ReadableImportFile): Promise<string> {
  if (typeof file.text === "function") return file.text();
  const bytes = await readFileBytes(file);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function readFileBytes(file: ReadableImportFile): Promise<Uint8Array> {
  if (typeof file.arrayBuffer !== "function") {
    throw new Error(`Cannot read file bytes: ${file.name}`);
  }
  return new Uint8Array(await file.arrayBuffer());
}

async function readFileAsDataUrl(file: ReadableImportFile, mimeType: string): Promise<string> {
  const bytes = await readFileBytes(file);
  return `data:${mimeType || "application/octet-stream"};base64,${bytesToBase64(bytes)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.slice(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function inferImageMime(name: string): string {
  const lowerName = name.toLowerCase();
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) return "image/jpeg";
  if (lowerName.endsWith(".webp")) return "image/webp";
  if (lowerName.endsWith(".gif")) return "image/gif";
  return "image/png";
}

function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 80)).trimEnd()}\n\n[Truncated: source text exceeded ${maxChars} characters]`;
}
