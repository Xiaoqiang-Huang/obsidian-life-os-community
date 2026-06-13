import type { App } from "obsidian";
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
}

export interface PdfOcrOptions {
  languages?: string[];
  maxPages?: number;
  scale?: number;
  onProgress?: (progress: PdfOcrProgress) => void;
}

const DEFAULT_OCR_LANGUAGES = ["chi_sim", "eng"];
const DEFAULT_MAX_OCR_PAGES = 30;
const DEFAULT_RENDER_SCALE = 2;
const OCR_PLUGIN_ASSET_ROOT = ".obsidian/plugins/personal-life-system/assets/ocr";
type OcrLoggerMessage = { status: string; progress?: number };

export class PdfOcrService implements PdfOcrProvider {
  constructor(private app: App) {}

  async extractPdfText(file: ReadableImportFile, options: PdfOcrOptions = {}): Promise<PdfOcrResult> {
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
        const result = await worker.recognize(image);
        const text = result.data.text.replace(/\r\n/g, "\n").trim();
        if (text) pageTexts.push(`## OCR Page ${pageNumber}\n\n${text}`);
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
