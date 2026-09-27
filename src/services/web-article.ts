import { Readability } from "../vendor/readability";
import JSDOMParser from "../vendor/readability/JSDOMParser";
/** Isolated JS DOM parser: no browser resource loading, scripts or network calls. */
export function extractWebArticle(html: string): string | null {
  if (html.length > 2_000_000) throw new Error("网页过大，未执行正文解析。");
  if (!/<(?:html|body|article|main|p)[\s>]/i.test(html)) return null;
  try {
    const doc = new JSDOMParser().parse(html);
    const article = new Readability(doc, { maxElemsToParse: 20000, charThreshold: 120, disableJSONLD: true }).parse();
    return article?.content && (article.textContent?.trim().length || 0) >= 120 ? article.content : null;
  } catch { return null; }
}
