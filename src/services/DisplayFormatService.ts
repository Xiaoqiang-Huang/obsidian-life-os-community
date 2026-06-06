export type DisplayBlockKind = "record" | "summary" | "highlight" | "task" | "memory" | "note";

export interface DisplayBlock {
  title?: string;
  text: string;
  sourceDate?: string;
  sourcePath?: string;
  kind: DisplayBlockKind;
}

const METADATA_KEYS = new Set([
  "assistant",
  "analysis_status",
  "type",
  "status",
  "source",
  "created",
  "updated",
  "id",
  "tags",
  "category",
  "completed",
  "confirmed",
  "ignored",
  "importance",
  "date",
  "daily",
  "pending",
  "mood",
  "energy",
  "sleep"
]);

const CHINESE_METADATA_KEYS = new Set(["精力", "情绪", "睡眠", "状态", "来源", "分类", "创建", "更新"]);

const PREFERRED_DAILY_SECTIONS = ["快速记录", "今日记录", "记录", "日记", "今日想法"];

export class DisplayFormatService {
  cleanMarkdownForDisplay(raw: string): string {
    return this.extractUserVisibleLines(raw).join("\n");
  }

  extractUserVisibleLines(raw: string): string[] {
    return stripFrontmatter(raw)
      .split(/\r?\n/)
      .map((line) => normalizeDisplayLine(line))
      .filter((line): line is string => Boolean(line))
      .filter((line) => !this.isMetadataLine(line))
      .filter((line) => !this.isTemplatePlaceholder(line))
      .slice(0, 24);
  }

  isMetadataLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "---") return true;
    if (/^[-*]\s+(source|created|updated|status|id|category|importance|completed|confirmed|ignored):/i.test(trimmed)) return true;
    const keyValue = trimmed.match(/^[-*]?\s*([A-Za-z_][\w-]*|[\u4e00-\u9fa5]{1,8})\s*[:：]\s*(.*)$/);
    if (!keyValue) return false;
    const key = keyValue[1].toLowerCase();
    const value = keyValue[2].trim();
    if (METADATA_KEYS.has(key)) return true;
    if (CHINESE_METADATA_KEYS.has(keyValue[1])) return true;
    if (!value) return ["今天", "今日", "明天", "状态", "心情", "总结", "计划", "备注", "精力", "情绪", "睡眠"].includes(keyValue[1]);
    if (/^(__+|TODO|待填写|null|undefined|pending|daily)$/i.test(value)) return true;
    return false;
  }

  isTemplatePlaceholder(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (/^[_\s/\\.-]+$/.test(trimmed)) return true;
    if (/^20\d{2}-\d{2}-\d{2}$/.test(trimmed)) return true;
    if (/^(daily|pending|completed)$/i.test(trimmed)) return true;
    if (/^\d+[.)、]?$/.test(trimmed)) return true;
    if (/^[-*+]\s*(\[[ xX]\])?\s*$/.test(trimmed)) return true;
    if (/^#+\s*$/.test(trimmed)) return true;
    if (/^(TODO|待填写|暂无|无|N\/A)$/i.test(trimmed)) return true;
    if (/^(精力|情绪|睡眠)[:：]\s*(__+|__+\/10|__h)?$/i.test(trimmed)) return true;
    if (/[:：]\s*(__+|TODO|待填写)\s*$/i.test(trimmed)) return true;
    return false;
  }

  async formatDailyRecordForDisplay(raw: string, sourceDate?: string, sourcePath?: string): Promise<DisplayBlock[]> {
    const sectionLines = extractPreferredSections(raw, PREFERRED_DAILY_SECTIONS);
    const lines = (sectionLines.length > 0 ? sectionLines : this.extractUserVisibleLines(raw))
      .map((line) => normalizeDailySentence(line))
      .filter((line): line is string => Boolean(line))
      .slice(0, 4);
    return lines.map((text) => ({ text, sourceDate, sourcePath, kind: "record" }));
  }

  async formatReviewHighlightForDisplay(raw: string, sourceDate?: string, sourcePath?: string): Promise<DisplayBlock[]> {
    const lines = this.extractUserVisibleLines(raw)
      .map((line) => line.replace(/^高光时刻[:：]?\s*/, "").trim())
      .filter((line) => line.length >= 6)
      .slice(0, 3);
    return lines.map((text) => ({ text, sourceDate, sourcePath, kind: "highlight" }));
  }

  async formatKnowledgeSnippetForDisplay(raw: string, sourcePath?: string): Promise<DisplayBlock[]> {
    const lines = this.extractUserVisibleLines(raw)
      .filter((line) => !/^#/.test(line))
      .slice(0, 2);
    const text = lines.join("；").slice(0, 120);
    return text ? [{ text, sourcePath, kind: "note" }] : [];
  }

  async formatChatMarkdownForDisplay(raw: string): Promise<string> {
    return stripFrontmatter(raw).trim();
  }
}

export function stripFrontmatter(raw: string): string {
  return raw.replace(/^---[\s\S]*?---\s*/m, "");
}

function normalizeDisplayLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (/^#{1,6}\s+/.test(trimmed)) {
    const title = trimmed.replace(/^#{1,6}\s+/, "").trim();
    return title && !/^(快速记录|今日记录|记录|日记|今日想法|今日复盘|模板|基本信息|关键内容|后续行动|主题)$/.test(title) ? title : null;
  }
  const withoutMarker = trimmed
    .replace(/^>\s*/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)、]\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .trim();
  return withoutMarker || null;
}

function normalizeDailySentence(line: string): string | null {
  const withoutTime = line.replace(/^([01]\d|2[0-3]):[0-5]\d\s+/, "").trim();
  const todayPrefix = withoutTime.match(/^今天[:：]\s*(.+)$/);
  return (todayPrefix?.[1] ?? withoutTime).trim() || null;
}

function extractPreferredSections(raw: string, sectionNames: string[]): string[] {
  const lines = stripFrontmatter(raw).split(/\r?\n/);
  const result: string[] = [];
  let active = false;
  for (const line of lines) {
    const heading = line.trim().match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      active = sectionNames.some((name) => heading[1].trim().includes(name));
      continue;
    }
    if (!active) continue;
    if (/^#{1,6}\s+/.test(line.trim())) continue;
    const normalized = normalizeDisplayLine(line);
    if (normalized) result.push(normalized);
  }
  return result;
}
