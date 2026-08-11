import type { ContextSource } from "./types";

export interface CitationVerificationOptions {
  requireCitations?: boolean;
  minimumCompleteness?: number;
}

export interface CitationVerificationResult {
  valid: boolean;
  citationIds: string[];
  invalidCitationIds: string[];
  factualClaimCount: number;
  citedClaimCount: number;
  completeness: number;
  warningMarkdown: string;
}

/** Verifies that answer citations exist and that factual claims are grounded. */
export class CitationVerifierService {
  verify(
    answer: string,
    sources: ContextSource[],
    options: CitationVerificationOptions = {}
  ): CitationVerificationResult {
    const requireCitations = options.requireCitations === true;
    const minimumCompleteness = options.minimumCompleteness ?? 0.6;
    const available = new Set(sources.map((source) => source.citationId).filter((id): id is string => Boolean(id)));
    const citationIds = Array.from(new Set(Array.from(String(answer || "").matchAll(/\[(S\d+)\]/g), (match) => match[1])));
    const invalidCitationIds = citationIds.filter((id) => !available.has(id));
    const claims = this.factualClaims(answer);
    const citedClaimCount = claims.filter((claim) => {
      const ids = Array.from(claim.matchAll(/\[(S\d+)\]/g), (match) => match[1]);
      return ids.some((id) => available.has(id));
    }).length;
    const completeness = claims.length === 0 ? 1 : citedClaimCount / claims.length;
    const hasValidCitation = citationIds.some((id) => available.has(id));
    const valid = invalidCitationIds.length === 0
      && (!requireCitations || (hasValidCitation && completeness >= minimumCompleteness));

    const issues: string[] = [];
    if (invalidCitationIds.length > 0) issues.push(`引用了不存在的来源 ${invalidCitationIds.map((id) => `[${id}]`).join("、")}`);
    if (requireCitations && !hasValidCitation) issues.push("没有引用本轮检索到的来源");
    if (requireCitations && claims.length > 0 && completeness < minimumCompleteness) {
      issues.push(`事实性表述引用覆盖约 ${Math.round(completeness * 100)}%`);
    }

    return {
      valid,
      citationIds,
      invalidCitationIds,
      factualClaimCount: claims.length,
      citedClaimCount,
      completeness,
      warningMarkdown: valid
        ? ""
        : `> **引用检查：** ${issues.join("；")}。请打开“上下文来源”核对后再采用结论。`
    };
  }

  private factualClaims(answer: string): string[] {
    return String(answer || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/([。！？!?；;])\s*((?:\[S\d+\]\s*)+)/g, "$2$1")
      .replace(/(?:^|\n)\s*(?:AI生成|AI 生成)\s*$/gu, "")
      .replace(/([。！？!?；;])\s*/g, "$1\n")
      .split(/\n+/)
      .map((value) => value.trim())
      .filter((value) => value.length >= 8)
      .filter((value) => !/^#{1,6}\s/.test(value))
      .filter((value) => !/^>\s*(?:引用检查|说明|提示)/.test(value))
      .filter((value) => !/^(你可以|请问|是否需要|如果你愿意)/.test(value));
  }
}
