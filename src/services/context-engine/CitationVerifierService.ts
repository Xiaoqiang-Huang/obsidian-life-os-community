import type { ContextSource } from "./types";

export interface CitationVerificationOptions {
  requireCitations?: boolean;
  minimumCompleteness?: number;
  /** Do not count explicit recommendations as source-derived factual claims. */
  allowUncitedAdvice?: boolean;
  /** Verify that the cited evidence text can actually support each cited claim. */
  verifyClaimSupport?: boolean;
  /** Minimum lexical evidence score for one claim. */
  minimumClaimSupport?: number;
  /** Minimum share of cited claims that must be supported. */
  minimumSupportCoverage?: number;
  /** Fail closed when even one cited claim is unsupported. */
  failOnUnsupportedClaim?: boolean;
}

export interface CitationVerificationResult {
  valid: boolean;
  citationIds: string[];
  invalidCitationIds: string[];
  factualClaimCount: number;
  citedClaimCount: number;
  completeness: number;
  supportedClaimCount: number;
  unsupportedClaimCount: number;
  unsupportedClaims: string[];
  supportCoverage: number;
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
    const verifyClaimSupport = options.verifyClaimSupport === true;
    const minimumClaimSupport = this.clamp(options.minimumClaimSupport ?? 0.14, 0.05, 0.8);
    const minimumSupportCoverage = this.clamp(options.minimumSupportCoverage ?? 0.7, 0, 1);
    const available = new Set(sources.map((source) => source.citationId).filter((id): id is string => Boolean(id)));
    const sourceById = new Map(sources
      .filter((source): source is ContextSource & { citationId: string } => Boolean(source.citationId))
      .map((source) => [source.citationId, source]));
    const citationIds = Array.from(new Set(Array.from(String(answer || "").matchAll(/\[(S\d+)\]/g), (match) => match[1])));
    const invalidCitationIds = citationIds.filter((id) => !available.has(id));
    const claims = this.factualClaims(answer, options.allowUncitedAdvice === true);
    const citedClaims = claims.filter((claim) => {
      const ids = Array.from(claim.matchAll(/\[(S\d+)\]/g), (match) => match[1]);
      return ids.some((id) => available.has(id));
    });
    const citedClaimCount = citedClaims.length;
    const completeness = claims.length === 0 ? 1 : citedClaimCount / claims.length;
    const hasValidCitation = citationIds.some((id) => available.has(id));
    const unsupportedClaims = verifyClaimSupport
      ? citedClaims.filter((claim) => !this.claimSupported(claim, sourceById, minimumClaimSupport))
      : [];
    const supportedClaimCount = verifyClaimSupport
      ? Math.max(0, citedClaimCount - unsupportedClaims.length)
      : citedClaimCount;
    const supportCoverage = citedClaimCount === 0
      ? (claims.length === 0 ? 1 : 0)
      : supportedClaimCount / citedClaimCount;
    const supportValid = !verifyClaimSupport || (
      supportCoverage >= minimumSupportCoverage
      && (options.failOnUnsupportedClaim !== true || unsupportedClaims.length === 0)
    );
    const valid = invalidCitationIds.length === 0
      && (!requireCitations || (hasValidCitation && completeness >= minimumCompleteness))
      && supportValid;

    const issues: string[] = [];
    if (invalidCitationIds.length > 0) issues.push(`引用了不存在的来源 ${invalidCitationIds.map((id) => `[${id}]`).join("、")}`);
    if (requireCitations && !hasValidCitation) issues.push("没有引用本轮检索到的来源");
    if (requireCitations && claims.length > 0 && completeness < minimumCompleteness) {
      issues.push(`事实性表述引用覆盖约 ${Math.round(completeness * 100)}%`);
    }
    if (verifyClaimSupport && unsupportedClaims.length > 0) {
      issues.push(`${unsupportedClaims.length} 条引用表述无法由所引证据直接核对`);
    }
    if (verifyClaimSupport && citedClaimCount > 0 && supportCoverage < minimumSupportCoverage) {
      issues.push(`证据支持覆盖约 ${Math.round(supportCoverage * 100)}%`);
    }

    return {
      valid,
      citationIds,
      invalidCitationIds,
      factualClaimCount: claims.length,
      citedClaimCount,
      completeness,
      supportedClaimCount,
      unsupportedClaimCount: unsupportedClaims.length,
      unsupportedClaims: unsupportedClaims.slice(0, 5).map((claim) => this.previewClaim(claim)),
      supportCoverage,
      warningMarkdown: valid
        ? ""
        : `> **引用检查：** ${issues.join("；")}。请打开“上下文来源”核对后再采用结论。`
    };
  }

  private claimSupported(
    claim: string,
    sourceById: Map<string, ContextSource>,
    minimumClaimSupport: number
  ): boolean {
    const ids = Array.from(new Set(Array.from(claim.matchAll(/\[(S\d+)\]/g), (match) => match[1])));
    const citedSources = ids.map((id) => sourceById.get(id)).filter((source): source is ContextSource => Boolean(source));
    if (citedSources.length === 0) return false;
    const evidence = citedSources.map((source) => [
      source.title,
      source.path,
      source.heading ?? "",
      source.excerpt ?? ""
    ].filter(Boolean).join("\n")).join("\n\n").trim();
    if (!evidence || !citedSources.some((source) => Boolean(source.excerpt?.trim()))) return false;

    const cleanClaim = claim.replace(/\[(?:S\d+)\]/g, " ").trim();
    if (this.claimsReadableBody(cleanClaim) && this.evidenceSaysUnavailable(evidence)) return false;

    const claimNumbers = this.numericTokens(cleanClaim);
    const evidenceNumbers = new Set(this.numericTokens(evidence));
    if (claimNumbers.some((token) => !evidenceNumbers.has(token))) return false;

    const normalizedClaim = this.normalizeForMatch(cleanClaim);
    const normalizedEvidence = this.normalizeForMatch(evidence);
    if (normalizedClaim.length >= 6 && normalizedEvidence.includes(normalizedClaim)) return true;

    const terms = this.meaningfulTerms(cleanClaim);
    if (terms.length === 0) return claimNumbers.length > 0;
    const matched = terms.filter((term) => normalizedEvidence.includes(this.normalizeForMatch(term))).length;
    const score = matched / terms.length;
    const minimumMatches = terms.length <= 3 ? 1 : 2;
    return matched >= minimumMatches && score >= minimumClaimSupport;
  }

  private claimsReadableBody(value: string): boolean {
    return /(?:已经|已|成功)(?:读到|读取|获取|访问)(?:了)?(?:正文|全文|页面内容)/u.test(value);
  }

  private evidenceSaysUnavailable(value: string): boolean {
    return /(?:待读取正文|无法访问|未取得正文|正文不可用|抓取失败|仅保存链接|没有读取到正文|未读取正文)/u.test(value);
  }

  private numericTokens(value: string): string[] {
    return Array.from(new Set(Array.from(
      String(value || "").matchAll(/\d+(?:[.,:/-]\d+)*(?:\s*(?:%|元|美元|人民币|万|亿|千|k|m|b))?/giu),
      (match) => match[0].replace(/[\s,]/gu, "").toLocaleLowerCase()
    )));
  }

  private meaningfulTerms(value: string): string[] {
    const stopWords = new Set([
      "这个", "那个", "目前", "当前", "已经", "可以", "需要", "进行", "一个", "我们", "你们", "他们",
      "以及", "或者", "因此", "但是", "如果", "其中", "相关", "结果", "内容", "信息", "来源", "记录",
      "the", "and", "that", "this", "with", "from", "have", "has", "was", "were", "into", "about"
    ]);
    const clean = String(value || "")
      .replace(/https?:\/\/\S+/giu, " ")
      .replace(/\[(?:S\d+)\]/g, " ")
      .replace(/\d+(?:[.,:/-]\d+)*/gu, " ")
      .toLocaleLowerCase();
    const terms: string[] = [];
    for (const match of clean.matchAll(/[a-z][a-z0-9_.-]{2,}/gu)) {
      if (!stopWords.has(match[0])) terms.push(match[0]);
    }
    for (const match of clean.matchAll(/[\u3400-\u9fff]{2,}/gu)) {
      const segment = match[0];
      if (segment.length <= 4 && !stopWords.has(segment)) terms.push(segment);
      for (let index = 0; index < segment.length - 1; index += 1) {
        const bigram = segment.slice(index, index + 2);
        if (!stopWords.has(bigram)) terms.push(bigram);
      }
    }
    return Array.from(new Set(terms)).slice(0, 80);
  }

  private normalizeForMatch(value: string): string {
    return String(value || "")
      .toLocaleLowerCase()
      .replace(/\[(?:S\d+)\]/g, "")
      .replace(/[\s`*_>#|，。！？；：、,.!?;:'"“”‘’()（）\[\]{}<>《》-]+/gu, "");
  }

  private previewClaim(value: string): string {
    const clean = value.replace(/\s+/gu, " ").trim();
    return clean.length > 120 ? `${clean.slice(0, 119)}…` : clean;
  }

  private clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  private factualClaims(answer: string, allowUncitedAdvice = false): string[] {
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
      .filter((value) => !/^(你可以|请问|是否需要|如果你愿意)/.test(value))
      .filter((value) => {
        if (!allowUncitedAdvice) return true;
        const normalized = value.replace(/^\s*(?:[-*•]|\d+[.)、]|[（(]?[一二三四五六七八九十]+[)）、.])\s*/u, "");
        return !/^(?:下一步(?:建议)?|建议|推荐|可以(?:先|尝试|考虑)|你可以|最好|应当|应该|不妨|优先考虑|接下来|先.{0,24}(?:再|然后|最后))/u.test(normalized);
      });
  }
}
