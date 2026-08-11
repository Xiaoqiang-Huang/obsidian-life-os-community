import { HybridRetrievalService, type HybridRetrievalInput, type HybridRetrievalResult } from "./HybridRetrievalService";
import { extractSpecificQueryAnchors } from "./QueryAnalysis";
import type { ContextEvidence, ContextRetrievalRoute, ContextRetrievalTrace } from "./types";

export interface AdaptiveRetrievalInput extends HybridRetrievalInput {}

export interface AdaptiveRetrievalResult {
  evidence: ContextEvidence[];
  trace: ContextRetrievalTrace;
  warnings: string[];
}

const CONCEPT_GROUPS: Array<{ pattern: RegExp; terms: string[] }> = [
  { pattern: /ocr|文字识别|字符识别|扫描件/i, terms: ["ocr", "文字识别", "扫描件"] },
  { pattern: /方案|设计|架构|流程|方法/i, terms: ["方案", "设计", "架构", "流程"] },
  { pattern: /风险|问题|隐患|卡点|阻塞/i, terms: ["风险", "问题", "隐患", "卡点"] },
  { pattern: /下一步|计划|待办|后续|行动/i, terms: ["下一步", "计划", "待办", "后续"] },
  { pattern: /会话|对话|聊天|conversation|session/i, terms: ["会话", "对话", "聊天"] },
  { pattern: /知识库|知识|资料|笔记|knowledge/i, terms: ["知识库", "知识", "资料", "笔记"] },
  { pattern: /进度|状态|完成|推进|里程碑/i, terms: ["进度", "状态", "完成", "推进"] },
  { pattern: /记忆|memory|偏好|规则/i, terms: ["记忆", "偏好", "规则"] }
];

/** Chooses retrieval depth from the request and retries only when it adds value. */
export class AdaptiveRetrievalService {
  constructor(private readonly hybrid: HybridRetrievalService) {}

  async search(input: AdaptiveRetrievalInput): Promise<AdaptiveRetrievalResult> {
    const startedAt = Date.now();
    const route = this.route(input.userMessage);
    if (route === "none") return this.emptyTrace(route, startedAt);

    const queries = this.queries(input.userMessage, route);
    const results: HybridRetrievalResult[] = [];
    for (let index = 0; index < queries.length; index += 1) {
      const result = await this.hybrid.search({
        ...input,
        userMessage: queries[index],
        maxResults: this.attemptLimit(input.maxResults ?? 10, route, index)
      });
      results.push(result);
      if (route === "focused" && result.trace.coverage >= 0.58 && result.evidence.length >= 2) break;
    }

    const maxResults = Math.max(1, Math.min(24, input.maxResults ?? (route === "focused" ? 8 : 14)));
    const evidence = this.mergeEvidence(results.map((result) => result.evidence), maxResults, route, input.userMessage);
    const warnings = Array.from(new Set(results.flatMap((result) => result.warnings)));
    const last = results[results.length - 1]?.trace;
    const coverage = this.coverage(input.userMessage, evidence);
    if (coverage < 0.34 && evidence.length > 0) warnings.push("本地证据只覆盖了问题的一部分，请核对来源后再采用结论。");

    return {
      evidence,
      warnings,
      trace: {
        route,
        strategy: "hybrid-bm25-vector-rrf-rerank",
        queries: queries.slice(0, results.length),
        attempts: results.length,
        sparseCandidates: results.reduce((sum, result) => sum + result.trace.sparseCandidates, 0),
        vectorCandidates: results.reduce((sum, result) => sum + result.trace.vectorCandidates, 0),
        fusedCandidates: results.reduce((sum, result) => sum + result.trace.fusedCandidates, 0),
        selectedCount: evidence.length,
        candidateCount: Math.max(0, ...results.map((result) => result.trace.candidateCount)),
        coverage,
        durationMs: Date.now() - startedAt,
        indexDocuments: last?.indexDocuments ?? 0,
        indexChunks: last?.indexChunks ?? 0,
        updatedDocuments: results.reduce((sum, result) => sum + result.trace.updatedDocuments, 0),
        reusedDocuments: last?.reusedDocuments ?? 0
      }
    };
  }

  private route(message: string): ContextRetrievalRoute {
    const value = String(message || "").trim();
    if (!value || /^(你好|您好|hello|hi|谢谢|感谢|早上好|晚上好)[！!。.\s]*$/i.test(value)) return "none";
    if (/全部|所有|全量|完整|整体|总览|盘点|跨项目|跨会话|系统梳理/i.test(value)) return "broad";
    if (/对比|比较|为什么|原因|冲突|关系|综合|分别|演变|取舍|影响/i.test(value) || /[、,，；;]/.test(value)) return "deep";
    return "focused";
  }

  private queries(message: string, route: ContextRetrievalRoute): string[] {
    const original = String(message || "").trim();
    if (route === "focused") {
      return [original, `${original} 相关结论 决策 背景 来源`];
    }
    const concepts = this.concepts(original);
    const expanded = concepts.flatMap((concept) => concept.terms).join(" ");
    if (route === "broad") {
      return Array.from(new Set([
        original,
        `${original} ${expanded} 背景 决策 现状 风险 下一步`,
        `${expanded} 相关记录 历史变化 待办 结论`
      ])).filter(Boolean).slice(0, 3);
    }
    const clauses = original.split(/[、,，；;]|以及|和|与/).map((value) => value.trim()).filter((value) => value.length >= 2);
    return Array.from(new Set([original, `${original} ${expanded}`, ...clauses])).slice(0, 4);
  }

  private attemptLimit(base: number, route: ContextRetrievalRoute, index: number): number {
    const addition = route === "focused" ? index * 2 : 4 + index * 2;
    return Math.max(4, Math.min(24, base + addition));
  }

  private mergeEvidence(
    attempts: ContextEvidence[][],
    limit: number,
    route: ContextRetrievalRoute,
    originalMessage: string
  ): ContextEvidence[] {
    const byChunk = new Map<string, ContextEvidence>();
    attempts.forEach((evidence, attemptIndex) => evidence.forEach((item, rank) => {
      const key = item.source.chunkId || `${item.source.path}:${item.source.lineStart ?? 0}:${item.source.lineEnd ?? 0}`;
      const attemptWeight = 1 / (1 + attemptIndex * 0.45);
      const contribution = attemptWeight / (20 + rank + 1);
      const current = byChunk.get(key);
      if (current) {
        current.score += contribution;
      } else {
        byChunk.set(key, { ...item, score: contribution });
      }
    }));
    let sorted = Array.from(byChunk.values()).sort((a, b) => b.score - a.score || a.source.path.localeCompare(b.source.path));
    const anchors = this.specificAnchors(originalMessage);
    if (anchors.length > 0) {
      const anchored = sorted.map((item) => {
        const haystack = `${item.source.path} ${item.source.title} ${item.source.heading ?? ""} ${item.content}`.toLowerCase();
        const hits = anchors.filter((anchor) => haystack.includes(anchor)).length;
        return {
          ...item,
          score: item.score + Math.min(0.24, hits * 0.07) + (anchors.length >= 2 && hits === anchors.length ? 0.08 : 0),
          anchorHits: hits
        };
      }).filter((item) => item.anchorHits > 0)
        .sort((a, b) => b.score - a.score || a.source.path.localeCompare(b.source.path));
      if (anchored.length > 0) sorted = anchored;
    }
    const selected: ContextEvidence[] = [];
    const byPath = new Map<string, number>();
    const byGroup = new Map<string, number>();
    // Prefer source diversity over repeated nearby chunks. Broad inventory
    // questions may use two locations from one document; normal/deep answers
    // get the single strongest passage per file.
    const perPath = route === "broad" ? 2 : 1;
    const perGroup = route === "broad" ? 5 : 2;
    for (const item of sorted) {
      if (selected.length >= limit) break;
      const count = byPath.get(item.source.path) ?? 0;
      if (count >= perPath) continue;
      const group = this.sourceGroup(item.source.path);
      const groupCount = byGroup.get(group) ?? 0;
      if (groupCount >= perGroup) continue;
      selected.push(item);
      byPath.set(item.source.path, count + 1);
      byGroup.set(group, groupCount + 1);
    }
    return selected;
  }

  private sourceGroup(path: string): string {
    const normalized = String(path || "").replace(/\\/g, "/").toLowerCase();
    const separator = normalized.lastIndexOf("/");
    return separator > 0 ? normalized.slice(0, separator) : normalized;
  }

  private specificAnchors(message: string): string[] {
    const generic = new Set([
      "answer", "please", "knowledge", "project", "task", "context", "information",
      "知识库", "知识", "资料", "笔记", "全部", "所有", "完整", "全量", "信息", "内容", "回答", "根据",
      "什么", "怎么", "如何", "分析", "盘点", "总览", "项目", "任务"
    ]);
    const anchors = Array.from(String(message || "").toLowerCase().matchAll(/[a-z0-9][a-z0-9_.-]{2,}/g), (match) => match[0])
      .filter((term) => !generic.has(term));
    anchors.push(...extractSpecificQueryAnchors(message).filter((term) => !generic.has(term)));
    for (const concept of this.concepts(message)) {
      const explicit = concept.terms.find((term) => message.toLowerCase().includes(term.toLowerCase()));
      if (explicit && !generic.has(explicit.toLowerCase())) anchors.push(explicit.toLowerCase());
    }
    return Array.from(new Set(anchors)).slice(0, 12);
  }

  private coverage(message: string, evidence: ContextEvidence[]): number {
    if (evidence.length === 0) return 0;
    const concepts = this.concepts(message);
    const haystack = evidence.map((item) => `${item.source.title} ${item.source.heading ?? ""} ${item.content}`).join(" ").toLowerCase();
    if (concepts.length > 0) {
      const matched = concepts.filter((concept) => concept.terms.some((term) => haystack.includes(term.toLowerCase()))).length;
      return Math.min(1, matched / concepts.length);
    }
    const rawTerms = Array.from(message.toLowerCase().matchAll(/[a-z0-9][a-z0-9_.-]*|[\p{Script=Han}]{2,6}/gu), (match) => match[0])
      .filter((term) => !/^(什么|怎么|如何|请问|帮我)$/.test(term));
    if (rawTerms.length === 0) return 1;
    return Math.min(1, rawTerms.filter((term) => haystack.includes(term)).length / rawTerms.length);
  }

  private concepts(message: string): Array<{ pattern: RegExp; terms: string[] }> {
    return CONCEPT_GROUPS.filter((group) => group.pattern.test(message));
  }

  private emptyTrace(route: ContextRetrievalRoute, startedAt: number): AdaptiveRetrievalResult {
    return {
      evidence: [],
      warnings: [],
      trace: {
        route,
        strategy: "hybrid-bm25-vector-rrf-rerank",
        queries: [],
        attempts: 0,
        sparseCandidates: 0,
        vectorCandidates: 0,
        fusedCandidates: 0,
        selectedCount: 0,
        candidateCount: 0,
        coverage: 1,
        durationMs: Date.now() - startedAt,
        indexDocuments: 0,
        indexChunks: 0,
        updatedDocuments: 0,
        reusedDocuments: 0
      }
    };
  }
}
