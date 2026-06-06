export interface NumericEvidence {
  raw: string;
  kind: "amount" | "percent" | "date" | "time" | "count" | "number";
  sourceLabel: string;
  line: number;
  context: string;
}

export interface ExtractNumericEvidenceOptions {
  text: string;
  sourceLabel: string;
  maxItems?: number;
}

const NUMERIC_PATTERN = /(?:\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2}日?)?)|(?:\d{1,2}:\d{2})|(?:(?:¥|￥)?\s*[+-]?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:元|块|%|天|小时|分钟|次|个|条|题|页|公里|km|kg|g|ml|L|台|人|份|本|分|小时)?)/giu;

export function extractNumericEvidence(options: ExtractNumericEvidenceOptions): NumericEvidence[] {
  const maxItems = Math.max(1, options.maxItems ?? 80);
  const lines = options.text.split(/\r?\n/);
  const evidence: NumericEvidence[] = [];

  for (let index = 0; index < lines.length && evidence.length < maxItems; index++) {
    const line = lines[index];
    let match: RegExpExecArray | null;
    NUMERIC_PATTERN.lastIndex = 0;
    while ((match = NUMERIC_PATTERN.exec(line)) && evidence.length < maxItems) {
      const raw = match[0].trim();
      if (!raw || raw === "+" || raw === "-") continue;
      evidence.push({
        raw,
        kind: classifyNumericEvidence(raw),
        sourceLabel: options.sourceLabel,
        line: index + 1,
        context: compactEvidenceContext(line, match.index)
      });
    }
  }

  return evidence;
}

export function buildNumericEvidenceMarkdown(items: NumericEvidence[]): string {
  if (items.length === 0) return "";
  const lines = [
    "## Candidate numeric evidence",
    "This table is candidate, not a final calculation. Use it only together with the surrounding context and Life OS source text. For money, counts, dates, durations, progress, scores, or trends, cite the matching line; if the meaning is unclear or absent, say that the available evidence is insufficient.",
    "",
    "| Number | Kind | Source | Line | Context |",
    "| --- | --- | --- | ---: | --- |"
  ];
  for (const item of items) {
    lines.push(`| ${escapeTableCell(item.raw)} | ${item.kind} | ${escapeTableCell(item.sourceLabel)} | ${item.line} | ${escapeTableCell(item.context)} |`);
  }
  return lines.join("\n");
}

export function hasNumericIntent(text: string): boolean {
  return /(多少钱|花了|支出|收入|预算|总共|合计|平均|趋势|多少|几次|几天|百分比|进度|分数|排名|统计|数字|账单|记账|count|total|average|budget|expense|income|percent|trend)/i.test(text);
}

function classifyNumericEvidence(raw: string): NumericEvidence["kind"] {
  if (/\d{4}[-/年]\d{1,2}/u.test(raw)) return "date";
  if (/^\d{1,2}:\d{2}$/u.test(raw)) return "time";
  if (/(?:¥|￥|元|块)/u.test(raw)) return "amount";
  if (/%/u.test(raw)) return "percent";
  if (/(天|小时|分钟|次|个|条|题|页|公里|km|kg|g|ml|L|台|人|份|本|分)$/iu.test(raw)) return "count";
  return "number";
}

function compactEvidenceContext(line: string, matchIndex: number): string {
  const start = Math.max(0, matchIndex - 36);
  const end = Math.min(line.length, matchIndex + 72);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < line.length ? "..." : "";
  return `${prefix}${line.slice(start, end).trim()}${suffix}`;
}

function dedupeEvidence(items: NumericEvidence[]): NumericEvidence[] {
  const seen = new Set<string>();
  const result: NumericEvidence[] = [];
  for (const item of items) {
    const key = `${item.raw}|${item.sourceLabel}|${item.line}|${item.context}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}
