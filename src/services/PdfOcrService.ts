import { requestUrl, type App } from "obsidian";
import { getDocument, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
import type { ReadableImportFile } from "./DocumentImportService";

export interface PdfOcrProgress {
  page: number;
  totalPages: number;
  status: string;
  progress?: number;
}

export interface PdfOcrResult {
  text: string;
  warnings: string[];
}

export interface PdfOcrProvider {
  extractPdfText(file: ReadableImportFile, options?: PdfOcrOptions): Promise<PdfOcrResult>;
  prefersStructuredParsing?(): boolean;
}

export interface PdfOcrOptions {
  languages?: string[];
  maxPages?: number;
  scale?: number;
  fallbackToLocal?: boolean;
  onProgress?: (progress: PdfOcrProgress) => void;
}

export type PdfOcrEngine = "auto" | "tesseract" | "paddle";

export interface PdfOcrRuntimeOptions {
  engine?: PdfOcrEngine;
  paddleEndpoint?: string;
}

export interface TesseractLineLike {
  text?: string;
  confidence?: number;
  bbox?: { x0?: number; y0?: number; x1?: number; y1?: number };
}

export interface TesseractParagraphLike {
  text?: string;
  confidence?: number;
  bbox?: { x0?: number; y0?: number; x1?: number; y1?: number };
  lines?: TesseractLineLike[];
}

export interface TesseractBlockLike {
  text?: string;
  confidence?: number;
  blocktype?: string;
  bbox?: { x0?: number; y0?: number; x1?: number; y1?: number };
  paragraphs?: TesseractParagraphLike[];
}

export interface PaddleStructuredOcrResult {
  markdown: string;
  pageCount: number;
}

const DEFAULT_OCR_LANGUAGES = ["chi_sim", "eng"];
const DEFAULT_MAX_OCR_PAGES = 30;
const DEFAULT_RENDER_SCALE = 2;
const OCR_PLUGIN_ASSET_ROOT = ".obsidian/plugins/personal-life-system/assets/ocr";
type OcrLoggerMessage = { status: string; progress?: number };

export class PdfOcrService implements PdfOcrProvider {
  constructor(private app: App, private runtime: PdfOcrRuntimeOptions = {}) {}

  prefersStructuredParsing(): boolean {
    const engine = this.runtime.engine ?? "auto";
    return Boolean(normalizePaddleEndpoint(this.runtime.paddleEndpoint))
      && (engine === "auto" || engine === "paddle");
  }

  async extractPdfText(file: ReadableImportFile, options: PdfOcrOptions = {}): Promise<PdfOcrResult> {
    const fallbackWarnings: string[] = [];
    const endpoint = normalizePaddleEndpoint(this.runtime.paddleEndpoint);
    const engine = this.runtime.engine ?? "auto";
    const shouldTryPaddle = engine === "paddle" || (engine === "auto" && Boolean(endpoint));
    if (shouldTryPaddle && endpoint) {
      try {
        return await this.extractWithPaddle(file, endpoint, options);
      } catch (error) {
        if (options.fallbackToLocal === false) {
          throw new Error(
            `PaddleOCR structured parsing was unavailable. ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        fallbackWarnings.push(
          `PaddleOCR structured parsing was unavailable; used local OCR instead. ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    } else if (engine === "paddle" && !endpoint) {
      if (options.fallbackToLocal === false) {
        throw new Error("PaddleOCR is selected but no PP-StructureV3 service URL is configured.");
      }
      fallbackWarnings.push("PaddleOCR is selected but no PP-StructureV3 service URL is configured; used local OCR instead.");
    }

    const local = await this.extractWithTesseract(file, options);
    return {
      text: local.text,
      warnings: [...fallbackWarnings, ...local.warnings]
    };
  }

  private async extractWithTesseract(file: ReadableImportFile, options: PdfOcrOptions = {}): Promise<PdfOcrResult> {
    if (!hasCanvasRuntime()) {
      return {
        text: "",
        warnings: ["Scanned PDF OCR requires browser canvas and local OCR assets. If this device cannot run OCR, use selectable PDF text or finish OCR on desktop."]
      };
    }

    const languages = options.languages?.length ? options.languages : DEFAULT_OCR_LANGUAGES;
    const scale = Math.max(1, Math.min(3, options.scale ?? DEFAULT_RENDER_SCALE));
    const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_OCR_PAGES);
    const bytes = await readFileBytes(file);
    const loadingTask = getDocument({
      data: bytes,
      disableFontFace: true,
      useSystemFonts: true
    });
    const pageTexts: string[] = [];
    const warnings: string[] = [];
    let worker: Awaited<ReturnType<typeof import("tesseract.js").createWorker>> | null = null;

    try {
      const document = await loadingTask.promise;
      const totalPages = Math.min(document.numPages, maxPages);
      worker = await this.createWorker(languages, options.onProgress);

      for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
        options.onProgress?.({ page: pageNumber, totalPages, status: "rendering" });
        const page = await document.getPage(pageNumber);
        const image = await renderPdfPageToImage(page, scale);
        options.onProgress?.({ page: pageNumber, totalPages, status: "recognizing" });
        const result = await worker.recognize(image, {}, {
          text: true,
          blocks: true,
          layoutBlocks: true,
          hocr: false,
          tsv: false
        });
        const text = formatTesseractBlocksForMarkdown(
          result.data.blocks as TesseractBlockLike[] | null,
          result.data.text
        );
        if (text) pageTexts.push(`<!-- lifeos-source-page:${pageNumber} -->\n${text}`);
        page.cleanup();
      }

      if (document.numPages > totalPages) {
        warnings.push(`OCR processed the first ${totalPages} of ${document.numPages} scanned PDF pages. Import again with a higher page limit if you need the rest.`);
      }
      if (pageTexts.length > 0) {
        warnings.push(`OCR completed locally for ${totalPages} scanned PDF page${totalPages > 1 ? "s" : ""}.`);
      }
    } finally {
      await worker?.terminate();
      await loadingTask.destroy();
    }

    return {
      text: pageTexts.join("\n\n").trim(),
      warnings: pageTexts.length > 0 ? warnings : ["No selectable PDF text was detected, and OCR did not find readable text."]
    };
  }

  private async extractWithPaddle(
    file: ReadableImportFile,
    endpoint: string,
    options: PdfOcrOptions
  ): Promise<PdfOcrResult> {
    options.onProgress?.({ page: 0, totalPages: 0, status: "paddle_uploading" });
    const bytes = await readFileBytes(file);
    const response = await requestUrl({
      url: endpoint,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        file: bytesToBase64(bytes),
        fileType: 0,
        useDocOrientationClassify: true,
        useDocUnwarping: true,
        useTextlineOrientation: true,
        useTableRecognition: true,
        useFormulaRecognition: true,
        useChartRecognition: false,
        useRegionDetection: true,
        formatBlockContent: true,
        returnMarkdownImages: false,
        visualize: false
      })
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`PP-StructureV3 returned HTTP ${response.status}.`);
    }
    options.onProgress?.({ page: 0, totalPages: 0, status: "paddle_parsing" });
    const parsed = parsePaddleStructuredOcrResponse(response.json);
    if (!parsed.markdown.trim()) {
      throw new Error("PP-StructureV3 returned no readable Markdown.");
    }
    return {
      text: parsed.markdown,
      warnings: [`PaddleOCR PP-StructureV3 completed structured parsing for ${parsed.pageCount} page${parsed.pageCount === 1 ? "" : "s"}.`]
    };
  }

  private async createWorker(
    languages: string[],
    onProgress?: (progress: PdfOcrProgress) => void
  ): ReturnType<typeof import("tesseract.js").createWorker> {
    const { createWorker } = await import("tesseract.js");
    const useLocalAssets = await this.hasLocalOcrAssets(languages);
    const sharedOptions = {
      cacheMethod: "write",
      logger: (message: OcrLoggerMessage) => {
        onProgress?.({
          page: 0,
          totalPages: 0,
          status: message.status,
          progress: message.progress
        });
      }
    };
    if (!useLocalAssets) {
      onProgress?.({ page: 0, totalPages: 0, status: "loading_remote_ocr_assets" });
      return createWorker(languages, 1, sharedOptions);
    }
    return createWorker(languages, 1, {
      ...sharedOptions,
      workerPath: this.ocrAssetUrl("worker.min.js"),
      corePath: this.ocrAssetUrl("core"),
      langPath: this.ocrAssetUrl("lang")
    });
  }

  private async hasLocalOcrAssets(languages: string[]): Promise<boolean> {
    const adapter = this.app.vault.adapter as App["vault"]["adapter"] & {
      exists?: (path: string, sensitive?: boolean) => Promise<boolean>;
    };
    if (typeof adapter.exists !== "function") return false;
    const requiredPaths = [
      `${OCR_PLUGIN_ASSET_ROOT}/worker.min.js`,
      `${OCR_PLUGIN_ASSET_ROOT}/core/tesseract-core.wasm.js`,
      ...languages.map((language) => `${OCR_PLUGIN_ASSET_ROOT}/lang/${language}.traineddata.gz`)
    ];
    try {
      const exists = await Promise.all(requiredPaths.map((path) => adapter.exists?.(path)));
      return exists.every(Boolean);
    } catch {
      return false;
    }
  }

  private ocrAssetUrl(relativePath: string): string {
    const path = `${OCR_PLUGIN_ASSET_ROOT}/${relativePath}`.replace(/\\/g, "/");
    const adapter = this.app.vault.adapter as App["vault"]["adapter"] & {
      getResourcePath?: (path: string) => string;
    };
    if (typeof adapter.getResourcePath === "function") {
      return adapter.getResourcePath(path);
    }
    return path;
  }
}

export function formatTesseractBlocksForMarkdown(
  blocks: TesseractBlockLike[] | null | undefined,
  fallbackText: string
): string {
  const orderedBlocks = [...(blocks ?? [])].sort(compareTesseractLayoutItems);
  const paragraphs: string[] = [];
  for (const block of orderedBlocks) {
    const orderedParagraphs = [...(block.paragraphs ?? [])].sort(compareTesseractLayoutItems);
    if (orderedParagraphs.length === 0) {
      const blockText = normalizeOcrParagraph(block.text ?? "");
      if (blockText) paragraphs.push(blockText);
      continue;
    }
    for (const paragraph of orderedParagraphs) {
      const orderedLines = [...(paragraph.lines ?? [])].sort(compareTesseractLayoutItems);
      const text = orderedLines.length > 0
        ? orderedLines
          .map((line) => String(line.text ?? "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .join("\n")
        : normalizeOcrParagraph(paragraph.text ?? "");
      if (text) paragraphs.push(text);
    }
  }
  const structured = paragraphs.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return structured || normalizeOcrParagraph(fallbackText);
}

export function parsePaddleStructuredOcrResponse(payload: unknown): PaddleStructuredOcrResult {
  const root = unwrapPaddleResponse(payload);
  if (!root || typeof root !== "object") throw new Error("PP-StructureV3 returned an invalid response.");
  const response = root as {
    errorCode?: unknown;
    errorMsg?: unknown;
    result?: {
      layoutParsingResults?: Array<{
        markdown?: { text?: unknown; isStart?: unknown; isEnd?: unknown };
      }>;
    };
  };
  if (Number(response.errorCode ?? 0) !== 0) {
    throw new Error(String(response.errorMsg || `PP-StructureV3 error ${response.errorCode}`));
  }
  const pages = Array.isArray(response.result?.layoutParsingResults)
    ? response.result.layoutParsingResults
    : [];
  const output: string[] = [];
  let previousEnded = true;
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const text = typeof page.markdown?.text === "string" ? page.markdown.text.trim() : "";
    if (!text) continue;
    const startsSegment = page.markdown?.isStart !== false;
    const separator = output.length === 0 ? "" : previousEnded || startsSegment ? "\n\n" : "\n";
    output.push(`${separator}<!-- lifeos-source-page:${index + 1} -->\n${text}`);
    previousEnded = page.markdown?.isEnd !== false;
  }
  return {
    markdown: output.join("").replace(/\n{3,}/g, "\n\n").trim(),
    pageCount: pages.length
  };
}

function unwrapPaddleResponse(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const candidate = payload as { outputs?: Array<{ data?: unknown[] }> };
  const tritonData = candidate.outputs?.[0]?.data?.[0];
  if (typeof tritonData === "string") {
    try {
      return unwrapPaddleResponse(JSON.parse(tritonData));
    } catch {
      throw new Error("PP-StructureV3 returned malformed JSON.");
    }
  }
  return payload;
}

function compareTesseractLayoutItems(
  left: { bbox?: { x0?: number; y0?: number } },
  right: { bbox?: { x0?: number; y0?: number } }
): number {
  const y = Number(left.bbox?.y0 ?? 0) - Number(right.bbox?.y0 ?? 0);
  return Math.abs(y) > 3 ? y : Number(left.bbox?.x0 ?? 0) - Number(right.bbox?.x0 ?? 0);
}

function normalizeOcrParagraph(text: string): string {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizePaddleEndpoint(value: string | undefined): string {
  const clean = String(value || "").trim().replace(/\/+$/u, "");
  if (!clean) return "";
  try {
    const url = new URL(clean);
    if (!/^https?:$/u.test(url.protocol)) return "";
    if (!url.pathname || url.pathname === "/") url.pathname = "/layout-parsing";
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return "";
  }
}

async function renderPdfPageToImage(page: PDFPageProxy, scale: number): Promise<string> {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Unable to create a canvas context for scanned PDF OCR.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  return canvas.toDataURL("image/png");
}

function hasCanvasRuntime(): boolean {
  return typeof document !== "undefined" &&
    typeof document.createElement === "function" &&
    typeof HTMLCanvasElement !== "undefined";
}

async function readFileBytes(file: ReadableImportFile): Promise<Uint8Array> {
  if (!file.arrayBuffer) throw new Error("This file object cannot provide bytes for OCR.");
  return new Uint8Array(await file.arrayBuffer());
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
