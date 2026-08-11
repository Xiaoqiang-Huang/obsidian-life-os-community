import type { ReviewEvidenceItem, ReviewEvidenceKind, ReviewEvidenceWindow } from "./ReviewEvidenceService";

export interface ReviewQualityReport {
  ok: boolean;
  score: number;
  errors: string[];
  warnings: string[];
  missingSections: string[];
  duplicateSections: string[];
  citationCoverage: number;
  uncitedFacts: string[];
  unknownCitations: string[];
  actionIssues: string[];
}

const DAILY_SECTIONS = [
  "今日主线",
  "已验证成果",
  "关键事件与决定",
  "问题、原因与影响",
  "状态与变化",
  "明日优先事项与验收条件"
] as const;

const WEEKLY_SECTIONS = [
  "本周成果和项目推进",
  "重要事件与关键决定",
  "反复阻碍和未完成延续",
  "节奏、投入和变化趋势",
  "下周三项重点及验收条件"
] as const;

const MONTHLY_SECTIONS = [
  "月度目标与实际结果",
  "项目、学习和生活主题",
  "关键变化和趋势",
  "决策质量、反复问题与风险",
  "下月策略、停止事项和行动清单"
] as const;

const CITATION_PATTERN = /\[来源[：:]\s*([^\]]+)\]/gu;
const GENERIC_ADVICE = /(?:继续努力|保持节奏|持续优化|加强学习|不断提升|再接再厉|稳步推进|做好规划)(?:[。！!]|$)/u;

export class ReviewQualityService {
  sectionsFor(kind: ReviewEvidenceKind, window: ReviewEvidenceWindow): string[] {
    const effective = kind === "custom" ? this.kindForWindow(window) : kind;
    if (effective === "daily") return [...DAILY_SECTIONS];
    if (effective === "weekly") return [...WEEKLY_SECTIONS];
    return [...MONTHLY_SECTIONS];
  }

  validate(
    markdown: string,
    kind: ReviewEvidenceKind,
    window: ReviewEvidenceWindow,
    evidence: ReviewEvidenceItem[]
  ): ReviewQualityReport {
    const expected = this.sectionsFor(kind, window);
    const headingCounts = new Map<string, number>();
    for (const match of markdown.matchAll(/^##\s+(.+?)\s*$/gmu)) {
      const heading = match[1].trim();
      headingCounts.set(heading, (headingCounts.get(heading) ?? 0) + 1);
    }
    const missingSections = expected.filter((section) => !headingCounts.has(section));
    const duplicateSections = expected.filter((section) => (headingCounts.get(section) ?? 0) > 1);
    const errors: string[] = [];
    const warnings: string[] = [];
    if (missingSections.length > 0) errors.push(`缺少章节：${missingSections.join("、")}`);
    if (duplicateSections.length > 0) errors.push(`章节重复：${duplicateSections.join("、")}`);

    const actionSection = expected[expected.length - 1];
    const sectionBlocks = parseSections(markdown);
    const knownCitations = this.knownCitationTokens(evidence);
    const factualUnits: string[] = [];
    const uncitedFacts: string[] = [];
    const unknownCitations: string[] = [];
    let citedCount = 0;
    for (const section of expected.slice(0, -1)) {
      const block = sectionBlocks.get(section) ?? "";
      for (const unit of factualLines(block)) {
        if (/资料不足/u.test(unit)) continue;
        factualUnits.push(unit);
        const citations = Array.from(unit.matchAll(CITATION_PATTERN)).flatMap((match) => splitCitationTokens(match[1]));
        if (citations.length === 0) {
          uncitedFacts.push(shorten(unit));
          continue;
        }
        citedCount += 1;
        for (const citation of citations) {
          if (!this.citationKnown(citation, knownCitations)) unknownCitations.push(citation);
        }
      }
    }
    if (uncitedFacts.length > 0) errors.push(`事实性内容缺少来源：${uncitedFacts.slice(0, 3).join("；")}`);
    if (unknownCitations.length > 0) errors.push(`引用无法对应当前证据：${unique(unknownCitations).slice(0, 5).join("、")}`);

    const actionIssues = this.validateActions(sectionBlocks.get(actionSection) ?? "");
    if (actionIssues.length > 0) errors.push(...actionIssues);
    if (GENERIC_ADVICE.test(markdown)) warnings.push("存在空泛建议，请改为具体动作、时间和验收条件。");
    if (/\b(?:完成|已完成)\s*\d+\s*(?:项|个)/u.test(markdown) && !/\[来源[：:]\s*统计快照\]/u.test(markdown)) {
      warnings.push("完成数量没有引用统计快照，请核对后再保存。");
    }
    const citationCoverage = factualUnits.length === 0 ? 1 : citedCount / factualUnits.length;
    const score = Math.max(0, Math.round(100
      - missingSections.length * 12
      - duplicateSections.length * 8
      - uncitedFacts.length * 6
      - unique(unknownCitations).length * 8
      - actionIssues.length * 10
      - warnings.length * 3));
    return {
      ok: errors.length === 0,
      score,
      errors,
      warnings,
      missingSections,
      duplicateSections,
      citationCoverage,
      uncitedFacts,
      unknownCitations: unique(unknownCitations),
      actionIssues
    };
  }

  repairPrompt(report: ReviewQualityReport, sections: string[]): string {
    return [
      "上一版未通过 Life OS 复盘质量门禁。请只修复列出的问题，不添加证据中不存在的事实。",
      `必须按此顺序完整保留章节：${sections.map((section) => `## ${section}`).join(" → ")}`,
      report.errors.length > 0 ? `错误：\n- ${report.errors.join("\n- ")}` : "",
      report.warnings.length > 0 ? `警告：\n- ${report.warnings.join("\n- ")}` : "",
      "事实性段落必须以 [来源：日期；节点 ID] 结尾；没有证据时写“资料不足”。",
      "行动项必须使用 - [ ]，并包含“依据、时间、验收”三个字段。"
    ].filter(Boolean).join("\n\n");
  }

  private kindForWindow(window: ReviewEvidenceWindow): Exclude<ReviewEvidenceKind, "custom"> {
    const days = Math.max(1, Math.round((localDate(window.end).getTime() - localDate(window.start).getTime()) / 86_400_000) + 1);
    if (days === 1) return "daily";
    if (days <= 14) return "weekly";
    return "monthly";
  }

  private knownCitationTokens(evidence: ReviewEvidenceItem[]): Set<string> {
    const known = new Set<string>(["统计快照", "当前任务状态"]);
    for (const item of evidence) {
      if (item.date && item.date !== "current") known.add(item.date);
      if (item.date === "current") known.add("当前");
      known.add(item.id);
      for (const nodeId of item.sourceNodeIds) known.add(nodeId);
      for (const token of item.sourceRef.split(/[\/；;,，]/u).map((value) => value.trim()).filter(Boolean)) known.add(token);
    }
    return known;
  }

  private citationKnown(citation: string, known: Set<string>): boolean {
    if (known.has(citation)) return true;
    if (/^20\d{2}-\d{2}-\d{2}$/u.test(citation)) return known.has(citation);
    return Array.from(known).some((token) => token.length >= 4 && (citation.includes(token) || token.includes(citation)));
  }

  private validateActions(block: string): string[] {
    if (/资料不足/u.test(block) && !/-\s*\[ \]/u.test(block)) return [];
    const lines = block.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const actions = lines.filter((line) => /^-\s*\[ \]/u.test(line));
    const issues: string[] = [];
    if (actions.length === 0) return ["行动章节缺少可执行待办（- [ ]）。"];
    actions.forEach((line, index) => {
      const missing = ["依据", "时间", "验收"].filter((field) => !new RegExp(`${field}[：:]`, "u").test(line));
      if (missing.length > 0) issues.push(`第 ${index + 1} 条行动缺少${missing.join("、")}字段。`);
    });
    return issues;
  }
}

function parseSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  const matches = Array.from(markdown.matchAll(/^##\s+(.+?)\s*$/gmu));
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    sections.set(match[1].trim(), markdown.slice(start, end).trim());
  }
  return sections;
}

function factualLines(block: string): string[] {
  return block.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => Boolean(line) && !/^<!--/u.test(line) && !/^```/u.test(line));
}

function splitCitationTokens(value: string): string[] {
  return value.split(/[；;,，]/u).map((item) => item.trim()).filter(Boolean);
}

function shorten(value: string): string {
  const clean = value.replace(/^[-*]\s*/u, "").trim();
  return clean.length > 72 ? `${clean.slice(0, 69)}...` : clean;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function localDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}
