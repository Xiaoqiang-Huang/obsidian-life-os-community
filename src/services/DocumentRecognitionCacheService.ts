import { App, TFile } from "obsidian";
import { extractReadableDocumentText, readPdfPageText } from "./DocumentImportService";
import type { FileSystemService } from "./FileSystemService";
import { ensureFolder } from "../utils/vault";

export const RECOGNITION_FOLDER = "DocumentRecognition";
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

export interface RecognizedPage {
  text: string;
  page: number;
  totalPages: number;
  requiresOcr: boolean;
  method: "native" | "vision" | "empty";
  fromCache: boolean;
  cachePath?: string;
}

export function isDocumentRecognitionPath(path: string, fs: FileSystemService): boolean {
  const root = fs.path("Knowledge", RECOGNITION_FOLDER).replace(/\\/gu, "/").replace(/\/+$/u, "");
  const normalized = path.replace(/\\/gu, "/");
  return normalized.startsWith(`${root}/`) && normalized.toLowerCase().endsWith(".md");
}

export function readRecognizedPage(markdown: string, page: number): { text: string; method: RecognizedPage["method"] } | null {
  const marker = new RegExp(`^## 第 ${page} 页 \\[(native|vision|empty)\\]\\s*$`, "mu");
  const match = marker.exec(markdown);
  if (!match) return null;
  const start = match.index + match[0].length;
  const next = /^## 第 \d+ 页 \[(?:native|vision|empty)\]\s*$/gmu;
  next.lastIndex = start;
  const end = next.exec(markdown)?.index ?? markdown.length;
  return { text: markdown.slice(start, end).trim(), method: match[1] as RecognizedPage["method"] };
}

/** Keep a sampled-then-completed PDF note readable in the original page order. */
export function orderRecognizedPdfPages(markdown: string): string {
  const markers = Array.from(markdown.matchAll(/^## 第 (\d+) 页 \[(?:native|vision|empty)\]\s*$/gmu));
  if (markers.length < 2) return markdown;
  const sections = markers.map((match, index) => ({
    page: Number(match[1]),
    text: markdown.slice(match.index!, markers[index + 1]?.index ?? markdown.length)
  }));
  sections.sort((a, b) => a.page - b.page);
  return markdown.slice(0, markers[0].index) + sections.map((section) => section.text).join("");
}

function frontmatterValue(markdown: string, key: string): string | null {
  const header = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(markdown)?.[1];
  const line = header?.split(/\r?\n/u).find((entry) => entry.startsWith(`${key}: `));
  if (!line) return null;
  const raw = line.slice(key.length + 2);
  try { return JSON.parse(raw) as string; } catch { return raw.trim(); }
}

export function recognizedSourcePath(markdown: string): string | null {
  return frontmatterValue(markdown, "source_file");
}

export function recognizedSourceIdentity(markdown: string): { path: string; size: number; mtime: number } | null {
  const path = recognizedSourcePath(markdown);
  if (!path) return null;
  return { path, size: Number(frontmatterValue(markdown, "source_size")), mtime: Number(frontmatterValue(markdown, "source_mtime")) };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("当前宿主不支持 Web Crypto，未创建识别缓存");
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function cachePath(folder: string, sourcePath: string, bytes: Uint8Array): Promise<{ path: string; digest: string }> {
  const [digest, identity] = await Promise.all([sha256(bytes), sha256(new TextEncoder().encode(sourcePath))]);
  return { path: `${folder}/${digest}-${identity.slice(0, 12)}.md`, digest };
}

function refreshSourceStat(markdown: string, source: TFile): string {
  return markdown.replace(/^source_size: \d+$/mu, `source_size: ${source.stat.size}`)
    .replace(/^source_mtime: \d+$/mu, `source_mtime: ${source.stat.mtime}`);
}

function cloneForSource(markdown: string, source: TFile): string {
  return refreshSourceStat(markdown, source)
    .replace(/^source_file: .*$/mu, `source_file: ${JSON.stringify(source.path)}`)
    .replace(/^# .* · 识别文本$/mu, `# ${source.basename} · 识别文本`)
    .replace(/^> 派生识别结果；请以原文档为准。原文档：.*$/mu,
      `> 派生识别结果；请以原文档为准。原文档：[[${source.path}]]`);
}

/** Derived, user-visible notes live in the Vault but are not independent library documents. */
export class DocumentRecognitionCacheService {
  constructor(private readonly app: App, private readonly fs: FileSystemService) {}

  private folder(): string { return this.fs.path("Knowledge", RECOGNITION_FOLDER); }

  async orderPdfCache(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile && file.path.startsWith(`${this.folder()}/`)) {
      await this.app.vault.process(file, orderRecognizedPdfPages);
    }
  }

  private async reuseMatchingContent(path: string, digest: string, source: TFile): Promise<string> {
    const prefix = `${this.folder()}/${digest}-`;
    for (const candidate of this.app.vault.getMarkdownFiles()) {
      if (candidate.path === path || !candidate.path.startsWith(prefix)) continue;
      const markdown = await this.app.vault.read(candidate);
      if (frontmatterValue(markdown, "type") !== "lifeos-document-recognition"
        || frontmatterValue(markdown, "source_hash") !== digest) continue;
      const cloned = cloneForSource(markdown, source);
      await ensureFolder(this.app, this.folder());
      if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.create(path, cloned);
      return cloned;
    }
    return "";
  }

  async currentCaches(): Promise<Map<string, TFile>> {
    const byOriginal = new Map<string, TFile>();
    const prefix = `${this.folder()}/`;
    for (const candidate of this.app.vault.getMarkdownFiles()) {
      if (!candidate.path.startsWith(prefix)) continue;
      let identity: ReturnType<typeof recognizedSourceIdentity>;
      try { identity = recognizedSourceIdentity(await this.app.vault.cachedRead(candidate)); }
      catch { continue; }
      if (!identity) continue;
      const source = this.app.vault.getAbstractFileByPath(identity.path);
      if (source instanceof TFile && source.stat.size === identity.size && source.stat.mtime === identity.mtime) {
        byOriginal.set(source.path, candidate);
      }
    }
    return byOriginal;
  }

  async readPdfPage(source: TFile, pageNumber: number, signal?: AbortSignal,
    recognizeImage?: (imageDataUrl: string, signal?: AbortSignal) => Promise<string>): Promise<RecognizedPage> {
    if (source.extension.toLowerCase() !== "pdf") throw new Error("仅支持 PDF 按页识别");
    if (source.stat.size > MAX_SOURCE_BYTES) throw new Error("PDF 超过 50 MB 读取上限");
    if (signal?.aborted) throw new Error("Reading cancelled");
    const bytes = new Uint8Array(await this.app.vault.readBinary(source));
    if (signal?.aborted) throw new Error("Reading cancelled");
    const { path, digest } = await cachePath(this.folder(), source.path, bytes);
    let existing = this.app.vault.getAbstractFileByPath(path);
    let current = existing instanceof TFile ? await this.app.vault.read(existing) : "";
    if (!current) {
      current = await this.reuseMatchingContent(path, digest, source);
      existing = this.app.vault.getAbstractFileByPath(path);
    }
    const cached = current && recognizedSourcePath(current) === source.path ? readRecognizedPage(current, pageNumber) : null;
    if (cached && (cached.method !== "empty" || !recognizeImage)) {
      const totalPages = Number(frontmatterValue(current, "total_pages")) || pageNumber;
      if (Number(frontmatterValue(current, "source_mtime")) !== source.stat.mtime && existing instanceof TFile) {
        await this.app.vault.process(existing, (old) => refreshSourceStat(old, source));
      }
      return { ...cached, page: pageNumber, totalPages, requiresOcr: cached.method === "empty", fromCache: true, cachePath: path };
    }
    // pdf.js transfers its input ArrayBuffer to the worker. Keep the original
    // bytes alive for image rendering when this page has no selectable text.
    const native = await readPdfPageText(bytes.slice(), pageNumber, signal);
    let text = native.text.trim();
    let method: RecognizedPage["method"] = text ? "native" : "empty";
    if (!text && recognizeImage) {
      const imageDataUrl = await this.renderPdfPage(bytes, pageNumber, signal);
      text = (await recognizeImage(imageDataUrl, signal)).trim();
      if (text) method = "vision";
    }
    if (signal?.aborted) throw new Error("Reading cancelled");
    const header = `---\ntype: lifeos-document-recognition\nsource_file: ${JSON.stringify(source.path)}\nsource_hash: ${JSON.stringify(digest)}\nsource_size: ${source.stat.size}\nsource_mtime: ${source.stat.mtime}\ntotal_pages: ${native.totalPages}\n---\n\n# ${source.basename} · 识别文本\n\n> 派生识别结果；请以原文档为准。原文档：[[${source.path}]]\n`;
    const section = `\n## 第 ${pageNumber} 页 [${method}]\n\n${text || "（本页没有可识别文字）"}\n`;
    await ensureFolder(this.app, this.folder());
    const latest = this.app.vault.getAbstractFileByPath(path);
    if (latest instanceof TFile) {
      await this.app.vault.process(latest, (old) => {
        const previous = readRecognizedPage(old, pageNumber);
        if (!previous) return old + section;
        if (previous.method !== "empty" || method === "empty") return old;
        const marker = new RegExp(`^## 第 ${pageNumber} 页 \\[empty\\]\\s*$`, "mu");
        const found = marker.exec(old);
        if (!found) return old;
        const next = /^## 第 \d+ 页 \[(?:native|vision|empty)\]\s*$/gmu;
        next.lastIndex = found.index + found[0].length;
        return old.slice(0, found.index) + section + old.slice(next.exec(old)?.index ?? old.length);
      });
    } else {
      await this.app.vault.create(path, header + section);
    }
    return { text, page: pageNumber, totalPages: native.totalPages, requiresOcr: !text, method, fromCache: false, cachePath: path };
  }

  async readDocx(source: TFile, signal?: AbortSignal): Promise<{ text: string; cachePath: string; fromCache: boolean }> {
    if (source.extension.toLowerCase() !== "docx") throw new Error("仅支持 DOCX 正文识别；旧版 .doc 请先转换为 .docx");
    if (source.stat.size > 10 * 1024 * 1024) throw new Error("DOCX 超过 10 MB 读取上限");
    if (signal?.aborted) throw new Error("Reading cancelled");
    const bytes = new Uint8Array(await this.app.vault.readBinary(source));
    const { path, digest } = await cachePath(this.folder(), source.path, bytes);
    let cachedFile = this.app.vault.getAbstractFileByPath(path);
    if (!(cachedFile instanceof TFile)) {
      await this.reuseMatchingContent(path, digest, source);
      cachedFile = this.app.vault.getAbstractFileByPath(path);
    }
    if (cachedFile instanceof TFile) {
      const markdown = await this.app.vault.read(cachedFile);
      if (recognizedSourcePath(markdown) === source.path) {
        const marker = /^## 正文 \[native\]\s*$/mu.exec(markdown);
        if (marker) {
          if (Number(frontmatterValue(markdown, "source_mtime")) !== source.stat.mtime) {
            await this.app.vault.process(cachedFile, (old) => refreshSourceStat(old, source));
          }
          return { text: markdown.slice(marker.index + marker[0].length).trim(), cachePath: path, fromCache: true };
        }
      }
    }
    const extracted = await extractReadableDocumentText({ name: source.name, size: bytes.byteLength,
      arrayBuffer: async () => bytes.slice().buffer }, "word", { maxTextChars: 2_000_000 });
    if (signal?.aborted) throw new Error("Reading cancelled");
    if (!extracted.text.trim()) throw new Error(extracted.warnings.join("；") || "DOCX 没有可读取正文");
    const markdown = `---\ntype: lifeos-document-recognition\nsource_file: ${JSON.stringify(source.path)}\nsource_hash: ${JSON.stringify(digest)}\nsource_size: ${source.stat.size}\nsource_mtime: ${source.stat.mtime}\n---\n\n# ${source.basename} · 识别文本\n\n> 派生识别结果；请以原文档为准。原文档：[[${source.path}]]\n\n## 正文 [native]\n\n${extracted.text}\n`;
    await ensureFolder(this.app, this.folder());
    const latest = this.app.vault.getAbstractFileByPath(path);
    if (!(latest instanceof TFile)) await this.app.vault.create(path, markdown);
    return { text: extracted.text, cachePath: path, fromCache: false };
  }

  private async renderPdfPage(bytes: Uint8Array, pageNumber: number, signal?: AbortSignal): Promise<string> {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({ data: bytes, disableFontFace: true, useSystemFonts: true });
    const abort = () => { void loading.destroy(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const pdfDocument = await loading.promise;
      const page = await pdfDocument.getPage(pageNumber);
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(1.8, 2048 / Math.max(natural.width, natural.height)) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建 PDF 页面画布");
      await page.render({ canvasContext: context, viewport, canvas }).promise;
      if (signal?.aborted) throw new Error("Reading cancelled");
      const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
      page.cleanup();
      return dataUrl;
    } finally {
      signal?.removeEventListener("abort", abort);
      await loading.destroy();
    }
  }
}
