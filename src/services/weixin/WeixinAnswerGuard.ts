import type { CitationVerificationOptions, CitationVerificationResult } from "../context-engine/CitationVerifierService";
import type { ContextSource } from "../context-engine/types";
import { extractReadableWebBody, hasReadableWebBody, hasUnavailableWebBody, selectReadableWebParagraph, selectReadableWebEvidence } from "../context-engine/WebEvidenceBody";
import { isNewsRequest, isNewsDependentLine, newsAnswerQualityIssues, newsEvidenceCoverage, newsSubjects, newsFactsForVerification, diversifyNewsResults } from "../context-engine/NewsAnswerQuality";
import { isWebEvidenceRelevant } from "../WebContextService";
import { splitSentenceFragments } from "../../utils/sentence-split";

/** A limited attributed news summary is not official confirmation or cross-verification. */
export function canUsePartialWeixinNewsEvidence(query: string, sources: ContextSource[]): boolean {
  if (!isNewsRequest(query) || /官方|官网|确认|证实|\bofficial\b|\bconfirm(?:ed|ation)?\b/iu.test(query)) return false;
  return sources.some((s) => s.type === "url" && (s.trust ?? 0) >= 0.7 && (s.trust ?? 0) < 0.9
    && hasReadableWebBody(s)
    && !/(?:正文不可用|抓取失败|待读取正文|未取得正文|无法访问)/u.test(s.excerpt || "")
    && isWebEvidenceRelevant(query, `${s.title}\n${s.path}\n${s.excerpt || ""}`));
}

export interface WeixinWebEvidenceDiagnostic {
  level: "none" | "partial" | "sufficient";
  reason: "none" | "single-secondary" | "insufficient-corroboration" | "search-empty" | "body-fetch-empty" | "body-filtered" | "excerpt-unavailable";
  searchCount: number;
  fetchedCount: number;
  readableCount: number;
  selectedCount: number;
}

export function summarizeWeixinWebEvidence(context: { sources: ContextSource[]; contextSources: string[] }): WeixinWebEvidenceDiagnostic {
  const count = (name: string): number => {
    const value = context.contextSources.find((s) => s.startsWith(`WebRead:${name}=`))?.split("=")[1];
    return Math.max(0, Math.min(1_000, Number(value) || 0));
  };
  const selectedCount = context.sources.filter((s) => s.type === "url" && hasReadableWebBody(s)).length;
  const level = selectedCount && context.contextSources.includes("WebEvidence:sufficient") ? "sufficient"
    : selectedCount && context.contextSources.includes("WebEvidence:partial") ? "partial" : "none";
  return {
    level,
    reason: level === "sufficient" ? "none" : level === "partial" ? "single-secondary"
      : selectedCount ? "insufficient-corroboration" : count("readable") ? "excerpt-unavailable"
        : count("fetched") ? "body-filtered" : count("search") ? "body-fetch-empty" : "search-empty",
    searchCount: count("search"), fetchedCount: count("fetched"), readableCount: count("readable"), selectedCount
  };
}

/** Only bounded status codes/counts survive persistence; never raw responses or credentials. */
export function normalizeWeixinWebEvidence(value: unknown): WeixinWebEvidenceDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (!["none", "partial", "sufficient"].includes(String(v.level))) return undefined;
  const count = (name: string): number => Number.isFinite(Number(v[name]))
    ? Math.max(0, Math.min(1_000, Math.floor(Number(v[name])))) : 0;
  const reasons = ["none", "single-secondary", "insufficient-corroboration", "search-empty", "body-fetch-empty", "body-filtered", "excerpt-unavailable"];
  return { level: v.level as WeixinWebEvidenceDiagnostic["level"],
    reason: (reasons.includes(String(v.reason)) ? v.reason : "none") as WeixinWebEvidenceDiagnostic["reason"],
    searchCount: count("searchCount"), fetchedCount: count("fetchedCount"), readableCount: count("readableCount"), selectedCount: count("selectedCount") };
}

export interface WeixinAnswerCheck {
  stage: "web-search" | "answer-check" | "answer-repair" | "evidence-fallback" | "done";
  failureKind: "none" | "web-evidence-insufficient" | "web-answer-check" | "local-citation-check";
  repair: "not-needed" | "skipped" | "requested" | "succeeded" | "empty" | "request-error" | "rejected";
  issues: string[];
  recovery?: "supported-claims" | "summarized-claims" | "source-extracts" | "checked-digest";
  synthesis?: "requested" | "succeeded" | "skipped" | "request-error" | "empty" | "rejected";
  synthesisError?: "auth" | "quota" | "timeout" | "network" | "server" | "cancelled" | "budget" | "request";
  synthesisAttempts?: number;
  digestVerification?: WeixinVerificationSummary;
  synthesisVerification?: WeixinVerificationSummary;
  initialVerification?: WeixinVerificationSummary;
  repairedVerification?: WeixinVerificationSummary;
}

type WeixinVerificationSummary = Pick<CitationVerificationResult,
  "valid" | "completeness" | "supportCoverage" | "invalidCitationIds" | "unsupportedClaimCount">;

const ISSUE_CODES = new Set([
  "web-evidence-insufficient", "citation-missing", "citation-invalid", "citation-coverage",
  "claim-support", "answer-verification", "unavailable-body", "skill-mismatch", "user-constraint",
  "news-orphaned-context", "news-stale-background", "news-disordered-summary", "news-missing-summary",
  "news-missing-subject", "news-uncertainty-lost"
]);

export function summarizeWeixinVerification(value: CitationVerificationResult): WeixinVerificationSummary {
  return {
    valid: value.valid,
    completeness: value.completeness,
    supportCoverage: value.supportCoverage,
    invalidCitationIds: value.invalidCitationIds,
    unsupportedClaimCount: value.unsupportedClaimCount
  };
}

export function weixinVerificationIssues(value: CitationVerificationResult): string[] {
  if (value.valid) return [];
  const issues = [
    value.citationIds.length === 0 ? "citation-missing" : "",
    value.invalidCitationIds.length > 0 ? "citation-invalid" : "",
    value.completeness < 0.7 ? "citation-coverage" : "",
    value.unsupportedClaimCount > 0 || value.supportCoverage < 0.7 ? "claim-support" : ""
  ].filter(Boolean);
  return issues.length > 0 ? issues : ["answer-verification"];
}

/** Use all available sources rather than truncating the beginning of one large context. */
export function buildWeixinRepairEvidence(sources: ContextSource[], query = ""): string {
  const selected = diversifyNewsResults(query, sources.filter((source) => source.excerpt?.trim()), 20);
  // The 10k ceiling includes titles and URLs, not only body characters.
  const rowBudget = Math.floor(10_000 / Math.max(1, selected.length));
  return selected.map((source) => {
    const header = `[${source.citationId || "无引用编号"}] ${source.title.slice(0, Math.min(100, rowBudget / 5))}\n${source.path.slice(0, Math.min(180, rowBudget / 4))}\n`;
    const budget = Math.min(1_500, rowBudget - header.length - 2);
    const body = source.type === "url" ? selectReadableWebEvidence(source, query, budget) : source.excerpt?.slice(0, budget);
    return header + (body || "");
  }).join("\n\n");
}

/** Store an allowlisted reason only; raw provider errors may contain credentials. */
export function weixinSynthesisErrorCode(error: unknown): NonNullable<WeixinAnswerCheck["synthesisError"]> {
  const text = (error instanceof Error ? error.message : String(error || "")).slice(0, 2_000);
  if (/取消|cancel|abort/iu.test(text)) return "cancelled";
  if (/\b401\b|\b403\b|unauthori[sz]ed|invalid.?api.?key|authentication/iu.test(text)) return "auth";
  if (/\b429\b|quota|rate.?limit|额度|余额|限流/iu.test(text)) return "quota";
  if (/预算|budget|max.?input|context.{0,10}(?:length|window)/iu.test(text)) return "budget";
  if (/timeout|timed.?out|超时/iu.test(text)) return "timeout";
  if (/\b5\d{2}\b/iu.test(text)) return "server";
  if (/ECONNRESET|ENOTFOUND|fetch failed|network|网络|连接中断/iu.test(text)) return "network";
  return "request";
}

/** A source-first, literal digest for failed synthesis, not invented editorial prose.
 * Every fact is checked independently, then checked again after organisation.
 * Qualifications remain attached; old dated sources cannot masquerade as updates.
 */
export function buildWeixinCheckedNewsDigest(
  sources: ContextSource[], query: string,
  verify: (answer: string, sources: ContextSource[], options: CitationVerificationOptions) => CitationVerificationResult,
  now = new Date()
): string {
  const subjects = newsSubjects(query);
  const records: Array<{ subject: string; text: string; key: string }> = [];
  const seen = new Set<string>();
  const options = { requireCitations: true, minimumCompleteness: 1, verifyClaimSupport: true,
    minimumSupportCoverage: 1, failOnUnsupportedClaim: true, normalizeEquivalentNumbers: true };
  for (const source of diversifyNewsResults(query, sources, 20)) {
    if (source.type !== "url" || !/^S\d+$/u.test(source.citationId || "") || !hasReadableWebBody(source)
      || hasUnavailableWebBody(source.excerpt) || /(?:内容|本文).{0,10}(?:由\s*AI\s*生成|AI生成)/iu.test(source.excerpt || "")) continue;
    const datedPath = source.path.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/u);
    if (datedPath && newsAnswerQualityIssues(`${datedPath[1]}年${datedPath[2]}月${datedPath[3]}日，报道。`, query, now).includes("news-stale-background")) continue;
    const published = (source.excerpt || "").match(/(?:发布时间|发布日期|发布于|Published(?:\s+(?:on|at))?)\s*[:：]?\s*(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/iu);
    if (published && newsAnswerQualityIssues(`${published[1]}年${published[2]}月${published[3]}日，报道。`, query, now).includes("news-stale-background")) continue;
    const paragraphs = extractReadableWebBody(source).split("\n").map(s => s.trim());
    for (let i = 0; i < paragraphs.length; i += 1) {
      let paragraph = paragraphs[i];
      if (paragraph.length < 20 || paragraph.length > 700 || !/[。！？.!?；;]/u.test(paragraph)
        || /^(?:来源|作者|编辑|发布时间|发布日期|Published|Updated|Author|By)\s*[:：]/iu.test(paragraph)
        || isNewsDependentLine(paragraph)) continue;
      // Never detach the uncertainty sentence immediately following an assertion.
      let qualifications = 0;
      while (paragraphs[i + 1] && qualifications < 2
        && (/^(?:但|然而|尚未|仍未|不能确认|未获|目前尚|尚无)/u.test(paragraphs[i + 1])
          || /不实|否认|辟谣|澄清|未经证实/u.test(paragraphs[i + 1]))) {
        paragraph += paragraphs[++i];
        qualifications += 1;
      }
      if (paragraph.length > 900) continue;
      const related = newsEvidenceCoverage(query, [{ ...source, title: "", excerpt: paragraph }]);
      const subject = subjects.find(s => !related.missingSubjects.includes(s)) || (subjects.length ? "" : "重要进展与影响");
      if (!subject || records.filter(r => r.subject === subject).length >= 3) continue;
      const key = paragraph.replace(/\s+/gu, "");
      if (seen.has(key)) continue;
      const fact = splitSentenceFragments(paragraph.replace(/\[S\d+\]/gu, ""))
        .map(sentence => `${sentence.trim()} [${source.citationId}]`).join(" ");
      // Unlike generated claims this is the complete literal source paragraph,
      // including adjacent qualifications, never a rewritten confirmation.
      if (newsAnswerQualityIssues(fact, query, now).length || !verify(fact, sources, options).valid) continue;
      seen.add(key); records.push({ subject, text: fact, key });
      if (records.length >= 12) break;
    }
  }
  if (!records.length) return "";
  const leads = Array.from(new Set(records.map(r => r.subject))).map(s => records.find(r => r.subject === s)!);
  const sections = leads.map(r => `## ${r.subject}\n${records.filter(v => v.subject === r.subject).map(v => v.text).join("\n\n")}`);
  const digest = `## 简要总结\n${leads.map(r => r.text).join("\n")}\n\n${sections.join("\n\n")}`;
  return digest.length <= 6_000 && verify(newsFactsForVerification(digest, query), sources, options).valid ? digest : "";
}

/** This is an explicitly labelled extractive fallback, never an unchecked AI summary. */
export function buildWeixinWebEvidenceFallback(sources: ContextSource[], check?: WeixinAnswerCheck, query = "", includeLinks = true): string {
  const seen = new Set<string>();
  const selected = sources.filter((source) => {
    if (source.type !== "url" || !hasReadableWebBody(source) || seen.has(source.path)) return false;
    seen.add(source.path);
    return true;
  }).slice(0, 3);
  const excerpts = selected.map((source, index) => {
    const text = selectReadableWebParagraph(source, query, 450);
    return `${index + 1}. ${source.title.slice(0, 120)}\n原文摘录：${text}${includeLinks ? `\n${source.path}` : ""}`;
  });
  const labels: Record<string, string> = {
    "citation-missing": "回答未标注来源", "citation-invalid": "引用编号不存在",
    "citation-coverage": "部分事实缺少引用", "claim-support": "部分事实无法由所引网页核对",
    "unavailable-body": "回答声称读取了不可用正文", "skill-mismatch": "回答混入未选择的 Skill",
    "user-constraint": "回答未遵守本轮限制", "answer-verification": "回答一致性检查未通过",
    "news-orphaned-context": "摘要缺少完整事件开头", "news-stale-background": "旧背景混入最新消息",
    "news-disordered-summary": "主事件被放在零散细节之后", "news-missing-summary": "回答缺少可独立阅读的简要总结",
    "news-missing-subject": "摘要遗漏了有正文的查询对象", "news-uncertainty-lost": "摘要丢失了消息归属或未确认限定"
  };
  const reasons = (check?.issues || []).map((code) => labels[code]).filter(Boolean);
  return [
    `已取得 ${seen.size} 个网页正文来源，但生成的回答未通过引用或一致性检查，未发送未经核对的总结。`,
    reasons.length > 0 ? `校验问题：${reasons.join("；")}。` : "",
    "以下仅为已读取网页的原文摘录，不代表完整新闻综述；请打开链接核对时间与上下文。",
    ...excerpts
  ].filter(Boolean).join("\n\n");
}

/** Remove ungrounded sentences, never invent citations or auto-attach them to uncited claims. */
export function selectWeixinSupportedClaims(
  candidates: string[],
  sources: ContextSource[],
  verify: (answer: string, sources: ContextSource[], options: CitationVerificationOptions) => CitationVerificationResult,
  query = "",
  now = new Date()
): string {
  const selected: string[] = [];
  const seen = new Set<string>();
  const news = isNewsRequest(query);
  for (const answer of candidates) {
    const fragments = String(answer || "").slice(0, 16_000)
      .replace(/```[\s\S]*?```/gu, " ")
      .replace(/([。！？!?；;])\s*((?:\[S\d+\]\s*)+)/gu, "$2$1")
      .split(/\n+/u)
      .flatMap((part) => splitSentenceFragments(part))
      .map((fragment) => fragment.replace(/^\s*(?:[-*•]|\d+[.)、](?!\d))\s*/u, "").trim())
      .filter((fragment) => fragment.length >= 8 && fragment.length <= 600 && /\[S\d+\]/u.test(fragment));
    for (const fragment of fragments) {
      const quality = newsAnswerQualityIssues(fragment, query, now);
      if (quality.includes("news-stale-background")) continue;
      if (quality.includes("news-orphaned-context")) {
        const ids = Array.from(fragment.matchAll(/\[(S\d+)\]/gu), (m) => m[1]);
        if (!selected.some((prior) => !isNewsDependentLine(prior) && ids.some((id) => prior.includes(`[${id}]`)))) continue;
      }
      const key = fragment.replace(/\[S\d+\]/gu, "").replace(/\s+/gu, "");
      if (seen.has(key)) continue;
      const result = verify(fragment, sources, {
        requireCitations: true, minimumCompleteness: 1, verifyClaimSupport: true,
        minimumSupportCoverage: 1, failOnUnsupportedClaim: true, normalizeEquivalentNumbers: true
      });
      if (!result.valid) continue;
      seen.add(key); selected.push(fragment);
      if (selected.length >= (news ? 24 : 6)) break;
    }
    if (selected.length >= (news ? 24 : 6)) break;
  }
  // Reserve a lead for each named subject before spending the six-fact budget on details.
  const ordered = news ? selected.filter((s) => !isNewsDependentLine(s)).concat(selected.filter(isNewsDependentLine)) : selected;
  let final = ordered.slice(0, 6);
  if (news) {
    const reports = newsEvidenceCoverage(query, sources).groups;
    const counts = new Map<number, number>();
    final = [];
    const balanced = diversifyNewsResults(query, ordered.map((title) => ({ title })), ordered.length);
    for (const { title: fragment } of balanced) {
      const ids = Array.from(fragment.matchAll(/\[(S\d+)\]/gu), (m) => m[1]);
      const report = reports.findIndex((items) => items.some((s) => s.citationId && ids.includes(s.citationId)));
      if ((counts.get(report) || 0) >= 3) continue;
      if (isNewsDependentLine(fragment) && !final.some((s) => !isNewsDependentLine(s) && ids.some((id) => s.includes(`[${id}]`)))) continue;
      final.push(fragment); counts.set(report, (counts.get(report) || 0) + 1);
      if (final.length >= 6) break;
    }
  }
  const reply = final.map((fragment) => `- ${fragment}`).join("\n");
  if (!reply) return "";
  return verify(reply, sources, {
    requireCitations: true, minimumCompleteness: 1, verifyClaimSupport: true,
    minimumSupportCoverage: 1, failOnUnsupportedClaim: true, normalizeEquivalentNumbers: true
  }).valid ? reply : "";
}

/** Durable logs accept only bounded codes and metrics, never model text, prompts or errors. */
export function normalizeWeixinAnswerCheck(value: unknown): WeixinAnswerCheck | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!["web-search", "answer-check", "answer-repair", "evidence-fallback", "done"].includes(String(record.stage))) return undefined;
  const bounded = (input: unknown, maximum: number): number => {
    const n = Number(input);
    return Number.isFinite(n) ? Math.max(0, Math.min(maximum, n)) : 0;
  };
  const summary = (input: unknown): WeixinVerificationSummary | undefined => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
    const v = input as Record<string, unknown>;
    return {
      valid: v.valid === true,
      completeness: bounded(v.completeness, 1),
      supportCoverage: bounded(v.supportCoverage, 1),
      unsupportedClaimCount: bounded(v.unsupportedClaimCount, 10_000),
      invalidCitationIds: Array.isArray(v.invalidCitationIds)
        ? v.invalidCitationIds.filter((id): id is string => typeof id === "string" && /^S\d{1,6}$/u.test(id)).slice(0, 24)
        : []
    };
  };
  return {
    stage: record.stage as WeixinAnswerCheck["stage"],
    failureKind: ["none", "web-evidence-insufficient", "web-answer-check", "local-citation-check"].includes(String(record.failureKind))
      ? record.failureKind as WeixinAnswerCheck["failureKind"] : "none",
    repair: ["not-needed", "skipped", "requested", "succeeded", "empty", "request-error", "rejected"].includes(String(record.repair))
      ? record.repair as WeixinAnswerCheck["repair"] : "not-needed",
    issues: Array.isArray(record.issues) ? Array.from(new Set(record.issues.filter((code): code is string => typeof code === "string" && ISSUE_CODES.has(code)))).slice(0, 12) : [],
    recovery: ["supported-claims", "summarized-claims", "source-extracts", "checked-digest"].includes(String(record.recovery))
      ? record.recovery as WeixinAnswerCheck["recovery"] : undefined,
    synthesis: ["requested", "succeeded", "skipped", "request-error", "empty", "rejected"].includes(String(record.synthesis))
      ? record.synthesis as WeixinAnswerCheck["synthesis"] : undefined,
    synthesisVerification: summary(record.synthesisVerification),
    synthesisError: ["auth", "quota", "timeout", "network", "server", "cancelled", "budget", "request"].includes(String(record.synthesisError))
      ? record.synthesisError as WeixinAnswerCheck["synthesisError"] : undefined,
    synthesisAttempts: record.synthesisAttempts === undefined ? undefined : Math.floor(bounded(record.synthesisAttempts, 2)),
    digestVerification: summary(record.digestVerification),
    initialVerification: summary(record.initialVerification),
    repairedVerification: summary(record.repairedVerification)
  };
}
