import type { App, TFile } from "obsidian";
import { strFromU8, unzipSync } from "fflate";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { ensureFolder, joinPath, normalizePath } from "../utils/vault";
import type { PdfOcrOptions, PdfOcrProvider } from "./PdfOcrService";

export type ImportedDocumentKind = "text" | "markdown" | "csv" | "json" | "pdf" | "word" | "image" | "unknown";

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
  maxTextChars?: number | null;
  enablePdfOcr?: boolean;
  pdfOcr?: PdfOcrProvider;
  pdfOcrOptions?: PdfOcrOptions;
}

export interface ExtractedDocumentText {
  text: string;
  warnings: string[];
}

export interface SaveImportedFileToVaultOptions {
  folderPath: string;
}

export interface SavedImportedFile {
  vaultPath: string;
  obsidianLink: string;
}

export interface ExtractReadableDocumentTextOptions {
  maxTextChars?: number | null;
  enablePdfOcr?: boolean;
  pdfOcr?: PdfOcrProvider;
  pdfOcrOptions?: PdfOcrOptions;
}

export interface PdfTextItemLike {
  str?: string;
  transform?: ArrayLike<number>;
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

const DEFAULT_MAX_TEXT_CHARS = 24000;
const IMAGE_MIME_MARKER = "image/*";
const PDF_MIME_MARKER = "application/pdf";
const DOCX_MIME_MARKER = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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
  ".pdf",
  PDF_MIME_MARKER,
  ".doc",
  "application/msword",
  ".docx",
  DOCX_MIME_MARKER,
  IMAGE_MIME_MARKER
].join(",");

export function classifyImportedDocument(name: string, mimeType = ""): ImportedDocumentKind {
  const lowerName = name.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  if (lowerMime.startsWith("image/")) return "image";
  if (lowerMime === PDF_MIME_MARKER || lowerName.endsWith(".pdf")) return "pdf";
  if (lowerMime === DOCX_MIME_MARKER || lowerName.endsWith(".docx") || lowerName.endsWith(".doc")) return "word";
  if (lowerMime.includes("json") || lowerName.endsWith(".json")) return "json";
  if (lowerMime.includes("csv") || lowerName.endsWith(".csv")) return "csv";
  if (lowerMime.includes("markdown") || lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) return "markdown";
  if (lowerMime.startsWith("text/") || lowerName.endsWith(".txt")) return "text";
  return "unknown";
}

export function isSupportedImportKind(kind: ImportedDocumentKind): boolean {
  return kind !== "unknown";
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
  const maxTextChars = options.maxTextChars === null ? null : options.maxTextChars ?? null;

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
    const extracted = await extractReadableDocumentText(file, kind, {
      maxTextChars,
      enablePdfOcr: options.enablePdfOcr,
      pdfOcr: options.pdfOcr,
      pdfOcrOptions: options.pdfOcrOptions
    });
    text = extracted.text;
    warnings.push(...extracted.warnings);
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

export async function extractReadableDocumentText(
  file: ReadableImportFile,
  kind = classifyImportedDocument(file.name, file.type || ""),
  options: ExtractReadableDocumentTextOptions = {}
): Promise<ExtractedDocumentText> {
  const maxTextChars = options.maxTextChars === null ? null : options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;

  if (kind === "pdf") {
    const structuredWarnings: string[] = [];
    if (
      options.enablePdfOcr
      && options.pdfOcr
      && options.pdfOcr.prefersStructuredParsing?.()
    ) {
      try {
        const structured = await options.pdfOcr.extractPdfText(file, {
          ...options.pdfOcrOptions,
          fallbackToLocal: false
        });
        if (structured.text.trim()) {
          return {
            text: capText(structured.text, maxTextChars),
            warnings: structured.warnings
          };
        }
        structuredWarnings.push(...structured.warnings);
      } catch (error) {
        structuredWarnings.push(
          `Structured PDF parsing failed; preserved selectable PDF text instead. ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    const text = await extractPdfText(file);
    if (text.trim()) return { text: capText(text, maxTextChars), warnings: structuredWarnings };
    if (options.enablePdfOcr && options.pdfOcr) {
      const ocr = await options.pdfOcr.extractPdfText(file, options.pdfOcrOptions);
      return {
        text: capText(ocr.text, maxTextChars),
        warnings: [...structuredWarnings, ...ocr.warnings]
      };
    }
    return {
      text: "",
      warnings: [
        ...structuredWarnings,
        "No selectable PDF text was detected. Scanned PDFs require OCR before they can be searched."
      ]
    };
  }

  if (kind === "word") {
    if (!file.name.toLowerCase().endsWith(".docx")) {
      return { text: "", warnings: ["Legacy .doc files are not supported by the local parser yet. Convert the file to .docx before importing."] };
    }
    const text = await extractDocxText(file);
    return text.trim()
      ? { text: capText(text, maxTextChars), warnings: [] }
      : { text: "", warnings: ["No readable DOCX body text was detected."] };
  }

  if (kind === "image") {
    return { text: "", warnings: ["The image was saved as an attachment. Body text extraction requires a vision model or OCR."] };
  }

  if (["text", "markdown", "csv", "json"].includes(kind)) {
    return { text: await readTextLikeFile(file, kind, maxTextChars), warnings: [] };
  }

  return { text: "", warnings: [`Unsupported file type for local text extraction: ${file.name}`] };
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

export function buildImportedDocumentsContextMarkdown(
  documents: ImportedDocument[],
  query: string,
  options: { maxDocumentChars?: number; maxBlocks?: number } = {}
): string {
  const usable = documents.filter((item) => item.text.trim() || item.warnings.length > 0);
  if (usable.length === 0) return "";
  const maxDocumentChars = Math.max(400, options.maxDocumentChars ?? 2400);
  const maxBlocks = Math.max(1, options.maxBlocks ?? 4);
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
      const excerpt = importedDocumentRelevantPassages(document.text, query, maxDocumentChars, maxBlocks);
      parts.push(`Relevant content:\n\n${excerpt}`);
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

async function readTextLikeFile(file: ReadableImportFile, kind: ImportedDocumentKind, maxChars: number | null): Promise<string> {
  const raw = await readFileText(file);
  if (kind !== "json") return capText(raw, maxChars);
  try {
    const parsed = JSON.parse(raw) as unknown;
    return capText(JSON.stringify(parsed, null, 2), maxChars);
  } catch {
    return capText(raw, maxChars);
  }
}

async function extractPdfText(file: ReadableImportFile): Promise<string> {
  const bytes = await readFileBytes(file);
  const loadingTask = getDocument({
    data: bytes,
    disableFontFace: true,
    useSystemFonts: true
  });

  try {
    const document = await loadingTask.promise;
    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = reconstructPdfPageText(content.items as PdfTextItemLike[]);
      if (text) {
        pageTexts.push(`<!-- lifeos-source-page:${pageNumber} -->\n${text}`);
      }
      page.cleanup();
    }
    return pageTexts.join("\n\n").trim();
  } finally {
    await loadingTask.destroy();
  }
}

interface PositionedPdfToken {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hasEOL: boolean;
}

interface PositionedPdfLine {
  y: number;
  height: number;
  x: number;
  tokens: PositionedPdfToken[];
  text: string;
}

export function reconstructPdfPageText(items: PdfTextItemLike[]): string {
  const tokens = items
    .map((item, index): PositionedPdfToken | null => {
      const text = String(item.str ?? "").replace(/\s+/g, " ").trim();
      if (!text) return null;
      const transform = item.transform ? Array.from(item.transform) : [];
      const height = Math.max(1, Math.abs(Number(transform[3])) || Number(item.height) || 10);
      const x = Number(transform[4]);
      const y = Number(transform[5]);
      const estimatedWidth = Math.max(height * 0.45, Array.from(text).length * height * 0.52);
      return {
        text,
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(y) ? y : -index * height,
        width: Math.max(0, Number(item.width) || estimatedWidth),
        height,
        hasEOL: item.hasEOL === true
      };
    })
    .filter((item): item is PositionedPdfToken => Boolean(item))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  if (tokens.length === 0) return "";

  const lines: PositionedPdfLine[] = [];
  for (const token of tokens) {
    let bestLine: PositionedPdfLine | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = Math.max(0, lines.length - 8); index < lines.length; index += 1) {
      const candidate = lines[index];
      const tolerance = Math.max(2, Math.min(8, Math.max(candidate.height, token.height) * 0.46));
      const distance = Math.abs(candidate.y - token.y);
      if (distance <= tolerance && distance < bestDistance) {
        bestLine = candidate;
        bestDistance = distance;
      }
    }
    if (!bestLine) {
      lines.push({
        y: token.y,
        height: token.height,
        x: token.x,
        tokens: [token],
        text: ""
      });
      continue;
    }
    bestLine.tokens.push(token);
    bestLine.y = (bestLine.y * (bestLine.tokens.length - 1) + token.y) / bestLine.tokens.length;
    bestLine.height = Math.max(bestLine.height, token.height);
    bestLine.x = Math.min(bestLine.x, token.x);
  }

  for (const line of lines) {
    line.tokens.sort((a, b) => a.x - b.x);
    line.text = joinPdfLineTokens(line.tokens);
  }
  lines.sort((a, b) => b.y - a.y || a.x - b.x);

  const medianHeight = median(lines.map((line) => line.height)) || 10;
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.text) continue;
    output.push(line.text);
    const next = lines[index + 1];
    if (next && shouldSeparatePdfLines(line, next, medianHeight)) output.push("");
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function formatImportedPlainText(text: string): string {
  const lines = String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .split("\n");
  const blocks: string[] = [];
  let paragraph = "";
  let structuralLines: string[] = [];

  const flushParagraph = () => {
    const clean = paragraph.trim();
    if (clean) blocks.push(clean);
    paragraph = "";
  };
  const flushStructural = () => {
    if (structuralLines.length > 0) blocks.push(structuralLines.join("\n"));
    structuralLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/[ \t]+/g, " ").trim();
    if (!line) {
      flushParagraph();
      flushStructural();
      continue;
    }
    if (isStructuralImportLine(line)) {
      flushParagraph();
      structuralLines.push(line);
      continue;
    }
    flushStructural();
    if (!paragraph) {
      paragraph = line;
      continue;
    }
    if (shouldJoinImportedLines(paragraph, line)) {
      paragraph = `${paragraph}${wrappedLineSeparator(paragraph, line)}${line}`;
      continue;
    }
    flushParagraph();
    paragraph = line;
  }
  flushParagraph();
  flushStructural();

  return blocks
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function joinPdfLineTokens(tokens: PositionedPdfToken[]): string {
  let output = "";
  let previous: PositionedPdfToken | null = null;
  for (const token of tokens) {
    if (!previous) {
      output = token.text;
      previous = token;
      continue;
    }
    const gap = token.x - (previous.x + previous.width);
    const separator = pdfTokenSeparator(previous.text, token.text, gap, Math.min(previous.height, token.height));
    output += `${separator}${token.text}`;
    previous = token;
  }
  return output.replace(/[ \t]+/g, " ").trim();
}

function pdfTokenSeparator(previous: string, next: string, gap: number, height: number): string {
  if (!previous || !next) return "";
  if (/[\s([{<"'“‘]$/u.test(previous) || /^[\s,.;:!?%)\]}>，。；：！？、”’]/u.test(next)) return "";
  const previousAscii = /[A-Za-z0-9]$/u.test(previous);
  const nextAscii = /^[A-Za-z0-9]/u.test(next);
  if (previousAscii && nextAscii) return " ";
  if (gap > Math.max(2, height * 0.38)) return " ";
  return "";
}

function shouldSeparatePdfLines(current: PositionedPdfLine, next: PositionedPdfLine, medianHeight: number): boolean {
  const verticalGap = Math.abs(current.y - next.y);
  if (verticalGap > Math.max(medianHeight * 1.75, current.height * 1.55)) return true;
  if (isStructuralImportLine(current.text) || isStructuralImportLine(next.text)) return true;
  if (Math.abs(current.x - next.x) > medianHeight * 1.6) return true;
  return false;
}

function isStructuralImportLine(line: string): boolean {
  return /^#{1,6}\s+/u.test(line)
    || /^<!--\s*lifeos-source-page:\d+\s*-->$/u.test(line)
    || /^```/u.test(line)
    || /^\|.*\|$/u.test(line)
    || /^\s*[-*+]\s+/u.test(line)
    || /^\s*\d{1,4}[.、．)]\s*/u.test(line)
    || /^\s*[A-HＡ-Ｈ][.、．)]\s*/u.test(line)
    || /^(?:第[一二三四五六七八九十百千万\d]+[章节部分题]|附录)\b/u.test(line);
}

function shouldJoinImportedLines(previous: string, next: string): boolean {
  if (!previous || !next) return false;
  if (/[。！？!?；;：:]$/u.test(previous)) return false;
  if (/^[A-Z][A-Z\s\d_-]{3,}$/u.test(next) && next.length < 72) return false;
  if (/^(?:图|表|Figure|Table)\s*[\d一二三四五六七八九十]+[.：:\s]/iu.test(next)) return false;
  return true;
}

function wrappedLineSeparator(previous: string, next: string): string {
  if (/[\u3400-\u9fff]$/u.test(previous) && /^[\u3400-\u9fff]/u.test(next)) return "";
  if (/[-/([{]$/u.test(previous) || /^[,.;:!?%)\]}>，。；：！？、]/u.test(next)) return "";
  return " ";
}

function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

async function extractDocxText(file: ReadableImportFile): Promise<string> {
  const bytes = await readFileBytes(file);
  const archive = unzipSync(bytes);
  const documentXml = archive["word/document.xml"];
  if (!documentXml) return "";
  return docxXmlToMarkdown(strFromU8(documentXml));
}

export function docxXmlToMarkdown(xml: string): string {
  const body = xml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/)?.[1] ?? xml;
  const blocks = Array.from(body.matchAll(/<(w:p|w:tbl)\b[\s\S]*?<\/\1>/g), (match) => match[0]);
  const markdownBlocks = (blocks.length > 0 ? blocks : [body])
    .map((block) => block.startsWith("<w:tbl") ? docxTableToMarkdown(block) : docxParagraphToMarkdown(block))
    .map((block) => block.trim())
    .filter(Boolean);
  return markdownBlocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function docxParagraphToMarkdown(paragraph: string): string {
  const text = docxInlineText(paragraph);
  if (!text) return "";
  const style = paragraph.match(/<w:pStyle\b[^>]*w:val=(?:"([^"]+)"|'([^']+)')[^>]*\/?>/i);
  const styleName = (style?.[1] ?? style?.[2] ?? "").trim();
  const headingMatch = styleName.match(/^(?:Heading|标题)\s*([1-6])$/i);
  if (headingMatch) return `${"#".repeat(Number(headingMatch[1]))} ${text}`;
  if (/^(?:Title|标题)$/i.test(styleName)) return `# ${text}`;
  if (/<w:numPr\b[\s\S]*?<\/w:numPr>/i.test(paragraph) || /<w:numPr\b[^>]*\/>/i.test(paragraph)) {
    return `- ${text}`;
  }
  return text;
}

function docxTableToMarkdown(table: string): string {
  const rows = Array.from(table.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g), (rowMatch) => {
    const cells = Array.from(rowMatch[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g), (cellMatch) => {
      const paragraphs = Array.from(cellMatch[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g), (paragraphMatch) =>
        docxInlineText(paragraphMatch[0])
      ).filter(Boolean);
      return paragraphs.join("<br>").replace(/\|/g, "\\|").trim() || " ";
    });
    return cells;
  }).filter((cells) => cells.length > 0);
  if (rows.length === 0) return "";
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? " "));
  const formatRow = (row: string[]) => `| ${row.join(" | ")} |`;
  return [
    formatRow(normalizedRows[0]),
    formatRow(Array.from({ length: columnCount }, () => "---")),
    ...normalizedRows.slice(1).map(formatRow)
  ].join("\n");
}

function docxInlineText(xml: string): string {
  const parts: string[] = [];
  const inlinePattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>/g;
  for (const match of xml.matchAll(inlinePattern)) {
    if (match[1] !== undefined) parts.push(decodeXmlText(match[1]));
    else if (match[0].startsWith("<w:tab")) parts.push("\t");
    else parts.push("\n");
  }
  if (parts.length === 0) return stripXmlTags(xml).replace(/\s+/g, " ").trim();
  return parts.join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripXmlTags(xml: string): string {
  return decodeXmlText(xml.replace(/<[^>]+>/g, " "));
}

function decodeXmlText(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return "\"";
    if (entity === "apos") return "'";
    if (entity.startsWith("#x")) {
      const value = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    if (entity.startsWith("#")) {
      const value = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return match;
  });
}

function importedDocumentRelevantPassages(text: string, query: string, maxChars: number, maxBlocks: number): string {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean || clean.length <= maxChars) return clean;
  const keywords = importedDocumentKeywords(query);
  if (keywords.length === 0) return clean.slice(0, maxChars).trim();
  const blocks = clean.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const scored = blocks
    .map((block, index) => ({ block, index, score: importedDocumentBlockScore(block, keywords) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (scored.length === 0) return clean.slice(0, maxChars).trim();

  const selected = scored.slice(0, maxBlocks).sort((a, b) => a.index - b.index);
  const parts: string[] = [];
  let remaining = maxChars;
  for (const entry of selected) {
    if (remaining <= 0) break;
    const excerpt = importedDocumentExcerptAroundKeywords(entry.block, keywords, Math.min(remaining, 700));
    if (!excerpt) continue;
    const addition = parts.length > 0 ? `\n\n---\n\n${excerpt}` : excerpt;
    if (addition.length > remaining) {
      parts.push(addition.slice(0, remaining).trim());
      break;
    }
    parts.push(addition);
    remaining -= addition.length;
  }
  return parts.join("").trim();
}

function importedDocumentKeywords(query: string): string[] {
  const generic = new Set(["life", "os", "file", "files", "document", "documents", "pdf", "docx", "分析", "解析", "总结", "整理", "结构化", "文档", "文件", "附件", "内容", "根据"]);
  const terms = new Set<string>();
  for (const match of query.toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) {
    const value = match[0].trim();
    if (!generic.has(value)) terms.add(value);
  }
  for (const match of query.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const text = match[0];
    for (let index = 0; index < text.length - 1; index += 1) {
      const value = text.slice(index, index + 2);
      if (!generic.has(value)) terms.add(value);
    }
    if (!generic.has(text)) terms.add(text);
  }
  return Array.from(terms).slice(0, 24);
}

function importedDocumentBlockScore(block: string, keywords: string[]): number {
  const lower = block.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    const normalized = keyword.toLowerCase();
    if (lower.includes(normalized)) score += 12 + Math.min(normalized.length, 16);
  }
  return score;
}

function importedDocumentExcerptAroundKeywords(block: string, keywords: string[], maxChars: number): string {
  if (block.length <= maxChars) return block;
  const lower = block.toLowerCase();
  const matchIndex = keywords
    .map((keyword) => lower.indexOf(keyword.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, matchIndex - 220);
  const excerpt = block.slice(start, start + maxChars).trim();
  return start > 0 ? `...${excerpt}` : excerpt;
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

function capText(text: string, maxChars: number | null): string {
  if (maxChars === null) return text;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 80)).trimEnd()}\n\n[Truncated: source text exceeded ${maxChars} characters]`;
}
