import type { AgentWorkingCheckpoint } from "./AgentMemoryTypes";

const BULK_WORDS = /(?:一口气|全部(?:识别|读取|读完|跑完|提取)|整(?:本|份)(?:识别|读取|读完|提取)?|逐页(?:识别|读取|提取)|读完|跑完|完整识别)/u;
const CONTINUE_WORDS = /^\s*(?:继续|接着|继续执行|继续处理|继续识别|接着读)(?:吧|下去|剩余的|剩下的|未读的|PDF|文档|。|！|!|\s)*$/u;
export const PDF_BULK_ACTION_PREFIX = "继续识别 PDF：";

/** A short follow-up inherits only an unfinished PDF task in this same session. */
export function bulkPdfQuery(content: string, checkpoint?: AgentWorkingCheckpoint): string | null {
  const explicit = BULK_WORDS.test(content);
  const pending = checkpoint?.nextActions.find((item) => item.startsWith(PDF_BULK_ACTION_PREFIX));
  if (!explicit && !(pending && CONTINUE_WORDS.test(content))) return null;
  const context = /\.pdf\b/iu.test(content) ? content : checkpoint?.objective || "";
  const match = /([^\\/\n\r"“”]+?\.pdf)\b/iu.exec(context);
  return match?.[1].trim() || null;
}

export function selectUniquePdfPath(query: string, paths: string[]): string | null {
  const wanted = query.normalize("NFKC").toLocaleLowerCase();
  const exact = paths.filter((path) => path.split("/").pop()?.normalize("NFKC").toLocaleLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const mentioned = paths.filter((path) => wanted.includes(path.split("/").pop()?.normalize("NFKC").toLocaleLowerCase() || "\0"));
  return mentioned.length === 1 ? mentioned[0] : null;
}

export function pdfCachedPages(markdown: string): Set<number> {
  const result = new Set<number>();
  for (const match of markdown.matchAll(/^## 第 (\d+) 页 \[(?:native|vision)\]\s*$/gmu)) result.add(Number(match[1]));
  return result;
}

export interface BulkPdfProgress {
  total: number;
  completed: number;
  remaining: number;
  newPages: number;
  cachePath: string;
  stopReason: "completed" | "budget" | "cancelled" | "failed";
  error?: string;
}

/** Sequential to keep image/model requests bounded and each finished page durable. */
export async function recognizePdfPages(input: {
  totalPages: number;
  cached: Set<number>;
  maxNewPages: number;
  read: (page: number) => Promise<{ text: string; cachePath?: string }>;
  signal?: AbortSignal;
  onPage?: (page: number, completed: number, total: number) => Promise<void>;
}): Promise<BulkPdfProgress> {
  const { totalPages, cached, read, signal } = input;
  let newPages = 0, cachePath = "", error = "";
  let stopReason: BulkPdfProgress["stopReason"] = "completed";
  for (let page = 1; page <= totalPages; page++) {
    if (cached.has(page)) continue;
    if (signal?.aborted) { stopReason = "cancelled"; break; }
    if (newPages >= input.maxNewPages) { stopReason = "budget"; break; }
    try {
      const result = await read(page);
      cachePath = result.cachePath || cachePath;
      if (!result.text.trim()) { stopReason = "failed"; error = `第 ${page} 页未能识别出文字`; break; }
      cached.add(page);
      newPages++;
      await input.onPage?.(page, cached.size, totalPages);
    } catch (caught) {
      stopReason = signal?.aborted ? "cancelled" : "failed";
      error = caught instanceof Error ? caught.message : String(caught);
      break;
    }
  }
  const completed = Array.from(cached).filter((page) => page >= 1 && page <= totalPages).length;
  return { total: totalPages, completed, remaining: totalPages - completed, newPages, cachePath, stopReason, ...(error ? { error } : {}) };
}
