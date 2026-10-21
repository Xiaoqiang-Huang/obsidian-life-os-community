import type { ChatContextBundle } from "../ChatContextService";
import type { ContextSource } from "../context-engine/types";

export interface FastContextResolution {
  useFast: boolean;
  bundle: ChatContextBundle | null;
  reason?: "prefetch-miss";
}

/** Fast context may only use the bounded project prefetch bundle. It must never
 * fall back to the full-vault context builder. */
export async function resolveFastContext(
  prefetch: () => Promise<{ bundle: ChatContextBundle } | undefined>
): Promise<FastContextResolution> {
  try {
    const result = await prefetch();
    if (result && result.bundle.sources.length > 0) {
      return { useFast: true, bundle: result.bundle };
    }
  } catch { /* timeout/stale/missing all fall back to deep */ }
  return { useFast: false, bundle: null, reason: "prefetch-miss" };
}

/** Fast context answers use a source list, not inline [S1] markers.
 * Accept either a cited path or title; never invent a citation. */
export function verifyFastContextSourceList(
  content: string,
  sources: ContextSource[]
): string | null {
  const text = String(content || "");
  const cited = sources.some(source => {
    const path = String(source.path || "").trim();
    const title = String(source.title || "").trim();
    return Boolean((path && text.includes(path)) || (title && text.includes(title)));
  });
  if (cited) return null;
  return "> **引用检查：** 未列出本轮预取来源路径。请打开“上下文来源”核对后再采用结论。";
}
