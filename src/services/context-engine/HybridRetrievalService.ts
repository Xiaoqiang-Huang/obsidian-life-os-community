import type { App } from "obsidian";
import { MarkdownChunkingService, type MarkdownChunk } from "./MarkdownChunkingService";
import { ObsidianMetadataService } from "./ObsidianMetadataService";
import { extractSpecificQueryAnchors } from "./QueryAnalysis";
import type {
  ContextEvidence,
  ContextInventoryItem,
  ContextRetrievalTrace,
  ContextSource
} from "./types";

export interface HybridRetrievalInput {
  userMessage: string;
  inventory: ContextInventoryItem[];
  allowedPaths?: string[];
  maxResults?: number;
}

export interface HybridRetrievalResult {
  evidence: ContextEvidence[];
  trace: ContextRetrievalTrace;
  warnings: string[];
}

interface IndexedChunk extends MarkdownChunk {
  tokens: string[];
  termFrequency: Map<string, number>;
  vector: Map<number, number>;
  vectorNorm: number;
  mtime: number;
}

interface IndexedDocument {
  path: string;
  mtime: number;
  chunks: IndexedChunk[];
}

interface IndexState {
  documents: Map<string, IndexedDocument>;
}

interface RankedChunk {
  chunk: IndexedChunk;
  score: number;
  sparseRank?: number;
  vectorRank?: number;
}

const VECTOR_DIMENSIONS = 384;
const RRF_K = 60;
const MAX_RESULTS = 24;
const CANDIDATE_LIMIT = 48;
const INDEX_STATES = new WeakMap<object, Map<string, IndexState>>();

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "what", "which", "about", "please",
  "请", "帮我", "一下", "是什么", "怎么", "如何", "哪些", "一个", "这个", "那个", "进行", "内容", "信息", "根据"
]);

const ALIAS_GROUPS: string[][] = [
  ["ocr", "文字识别", "字符识别", "光学字符识别", "扫描件"],
  ["pdf", "文档", "扫描版", "电子文档"],
  ["方案", "设计", "架构", "流程", "方法"],
  ["风险", "问题", "隐患", "卡点", "阻塞"],
  ["下一步", "计划", "待办", "后续", "行动"],
  ["会话", "对话", "聊天", "conversation", "session"],
  ["知识库", "知识", "资料", "笔记", "knowledge"],
  ["进度", "状态", "完成", "推进", "里程碑"],
  ["记忆", "memory", "偏好", "规则"],
  ["日报", "日记", "今日记录", "daily"]
];

/**
 * Built-in local hybrid retrieval. It combines BM25 and a hashed semantic
 * vector, fuses them with RRF, then reranks with metadata and diversity.
 * No remote embedding service is required, so semantic mode always works.
 */
export class HybridRetrievalService {
  private readonly chunker = new MarkdownChunkingService();
  private readonly state: IndexState;

  constructor(
    app: App,
    private readonly metadata: ObsidianMetadataService,
    rootFolder: string
  ) {
    const key = rootFolder.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
    let states = INDEX_STATES.get(app as unknown as object);
    if (!states) {
      states = new Map<string, IndexState>();
      INDEX_STATES.set(app as unknown as object, states);
    }
    const existing = states.get(key);
    if (existing) {
      this.state = existing;
    } else {
      this.state = { documents: new Map<string, IndexedDocument>() };
      states.set(key, this.state);
    }
  }

  async search(input: HybridRetrievalInput): Promise<HybridRetrievalResult> {
    const startedAt = Date.now();
    const indexStats = await this.ensureIndex(input.inventory);
    const allowed = input.allowedPaths?.length ? new Set(input.allowedPaths.map((path) => this.normalizePath(path))) : null;
    const chunks = Array.from(this.state.documents.values())
      .filter((document) => !allowed || allowed.has(this.normalizePath(document.path)))
      .flatMap((document) => document.chunks);
    const originalQuery = String(input.userMessage || "");
    const originalTokens = this.tokenize(originalQuery);
    const query = this.expandAliases(originalQuery);
    const queryTokens = this.tokenize(query);
    const queryVector = this.vectorize(queryTokens);
    const sparse = this.bm25(chunks, queryTokens).slice(0, CANDIDATE_LIMIT);
    const vector = chunks
      .map((chunk) => ({ chunk, score: this.cosine(queryVector.vector, queryVector.norm, chunk.vector, chunk.vectorNorm) }))
      .filter((entry) => entry.score > 0.01)
      .sort((a, b) => b.score - a.score)
      .slice(0, CANDIDATE_LIMIT);
    const rankingTokens = originalTokens.length > 0 ? originalTokens : queryTokens;
    const fused = this.fuse(sparse, vector, rankingTokens, originalQuery);
    const bestScore = fused[0]?.score ?? 0;
    const qualified = fused.filter((entry) => entry.score >= Math.max(0.055, bestScore * 0.32));
    const selected = this.selectDiverse(qualified, this.clamp(input.maxResults ?? 10, 1, MAX_RESULTS));
    const evidence = selected.map(({ chunk, score }) => ({
      content: chunk.content,
      score,
      source: {
        path: chunk.path,
        title: chunk.title,
        type: this.sourceType(chunk.path),
        excerpt: this.excerpt(chunk.content, 320),
        chunkId: chunk.id,
        heading: chunk.heading || undefined,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        updatedAt: chunk.mtime,
        score,
        trust: this.sourceTrust(chunk.path)
      }
    }));

    return {
      evidence,
      warnings: evidence.length === 0 && queryTokens.length > 0 ? ["未找到与当前问题足够相关的本地证据。"] : [],
      trace: {
        route: "focused",
        strategy: "hybrid-bm25-vector-rrf-rerank",
        queries: [String(input.userMessage || "").trim()].filter(Boolean),
        attempts: 1,
        sparseCandidates: sparse.length,
        vectorCandidates: vector.length,
        fusedCandidates: fused.length,
        selectedCount: evidence.length,
        candidateCount: chunks.length,
        coverage: this.coverage(rankingTokens, evidence),
        durationMs: Date.now() - startedAt,
        indexDocuments: this.state.documents.size,
        indexChunks: Array.from(this.state.documents.values()).reduce((sum, document) => sum + document.chunks.length, 0),
        updatedDocuments: indexStats.updated,
        reusedDocuments: indexStats.reused
      }
    };
  }

  private async ensureIndex(inventory: ContextInventoryItem[]): Promise<{ updated: number; reused: number }> {
    const readable = inventory.filter((item) => item.path.toLowerCase().endsWith(".md"));
    const livePaths = new Set(readable.map((item) => this.normalizePath(item.path)));
    for (const path of Array.from(this.state.documents.keys())) {
      if (!livePaths.has(this.normalizePath(path))) this.state.documents.delete(path);
    }

    const changed = readable.filter((item) => {
      const existing = this.state.documents.get(item.path);
      return !existing || existing.mtime !== item.mtime;
    });
    const reused = readable.length - changed.length;

    for (let offset = 0; offset < changed.length; offset += 16) {
      const batch = changed.slice(offset, offset + 16);
      const indexed = await Promise.all(batch.map(async (item) => {
        const markdown = await this.metadata.readFile(item.path);
        const chunks = this.chunker.chunk(item.path, item.title, markdown).map((chunk) => this.indexChunk(chunk, item.mtime));
        return { item, chunks };
      }));
      for (const { item, chunks } of indexed) {
        if (chunks.length === 0) {
          this.state.documents.delete(item.path);
        } else {
          this.state.documents.set(item.path, { path: item.path, mtime: item.mtime, chunks });
        }
      }
      if (offset + batch.length < changed.length) await this.yieldToUi();
    }
    return { updated: changed.length, reused };
  }

  private indexChunk(chunk: MarkdownChunk, mtime: number): IndexedChunk {
    // Expand the query, not every document. Expanding document paths such as
    // `/Knowledge/` would give all files the same aliases and drown exact hits.
    const tokens = this.tokenize(chunk.searchableText);
    const termFrequency = new Map<string, number>();
    for (const token of tokens) termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
    const vectorized = this.vectorize(tokens);
    return { ...chunk, tokens, termFrequency, vector: vectorized.vector, vectorNorm: vectorized.norm, mtime };
  }

  private bm25(chunks: IndexedChunk[], queryTokens: string[]): RankedChunk[] {
    if (chunks.length === 0 || queryTokens.length === 0) return [];
    const terms = Array.from(new Set(queryTokens));
    const documentFrequency = new Map<string, number>();
    for (const term of terms) {
      documentFrequency.set(term, chunks.reduce((count, chunk) => count + (chunk.termFrequency.has(term) ? 1 : 0), 0));
    }
    const averageLength = chunks.reduce((sum, chunk) => sum + chunk.tokens.length, 0) / Math.max(1, chunks.length);
    const k1 = 1.35;
    const b = 0.72;
    return chunks
      .map((chunk) => {
        let score = 0;
        for (const term of terms) {
          const frequency = chunk.termFrequency.get(term) ?? 0;
          if (frequency === 0) continue;
          const df = documentFrequency.get(term) ?? 0;
          const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
          const denominator = frequency + k1 * (1 - b + b * chunk.tokens.length / Math.max(1, averageLength));
          score += idf * ((frequency * (k1 + 1)) / denominator);
        }
        return { chunk, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  private fuse(
    sparse: RankedChunk[],
    vector: RankedChunk[],
    queryTokens: string[],
    originalQuery: string
  ): RankedChunk[] {
    const byId = new Map<string, RankedChunk>();
    sparse.forEach((entry, index) => {
      byId.set(entry.chunk.id, { ...entry, sparseRank: index + 1, score: 1 / (RRF_K + index + 1) });
    });
    vector.forEach((entry, index) => {
      const current = byId.get(entry.chunk.id) ?? { chunk: entry.chunk, score: 0 };
      current.vectorRank = index + 1;
      current.score += 1 / (RRF_K + index + 1);
      byId.set(entry.chunk.id, current);
    });

    const uniqueTerms = Array.from(new Set(queryTokens));
    const normalizedPhrase = this.normalize(originalQuery);
    const specificAnchors = extractSpecificQueryAnchors(originalQuery).map((value) => this.normalize(value));
    return Array.from(byId.values())
      .map((entry) => {
        const haystack = this.normalize(entry.chunk.searchableText);
        const matched = uniqueTerms.filter((term) => entry.chunk.termFrequency.has(term)).length;
        const tokenCoverage = matched / Math.max(1, uniqueTerms.length);
        const titleHeading = this.normalize(`${entry.chunk.path} ${entry.chunk.title} ${entry.chunk.heading}`);
        const metadataHits = uniqueTerms.filter((term) => titleHeading.includes(term)).length;
        const anchorHits = specificAnchors.filter((anchor) => haystack.includes(anchor)).length;
        const metadataAnchorHits = specificAnchors.filter((anchor) => titleHeading.includes(anchor)).length;
        const allAnchorsHit = specificAnchors.length >= 2 && anchorHits === specificAnchors.length;
        const phraseBoost = (normalizedPhrase.length >= 4 && haystack.includes(normalizedPhrase) ? 0.12 : 0)
          + Math.min(0.3, anchorHits * 0.1)
          + Math.min(0.12, metadataAnchorHits * 0.04)
          + (allAnchorsHit ? 0.08 : 0);
        const trustBoost = this.sourceTrust(entry.chunk.path) * 0.025;
        const score = entry.score + tokenCoverage * 0.18 + metadataHits * 0.018 + phraseBoost + trustBoost;
        return { ...entry, score };
      })
      .sort((a, b) => b.score - a.score || b.chunk.mtime - a.chunk.mtime || a.chunk.path.localeCompare(b.chunk.path));
  }

  private selectDiverse(ranked: RankedChunk[], limit: number): RankedChunk[] {
    const selected: RankedChunk[] = [];
    const counts = new Map<string, number>();
    const perFile = limit >= 12 ? 3 : 2;
    for (const entry of ranked) {
      if (selected.length >= limit) break;
      const count = counts.get(entry.chunk.path) ?? 0;
      if (count >= perFile) continue;
      selected.push(entry);
      counts.set(entry.chunk.path, count + 1);
    }
    return selected;
  }

  private tokenize(value: string): string[] {
    const normalized = this.normalize(value);
    const tokens: string[] = [];
    for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_.-]*|[\p{Script=Han}]+/gu)) {
      const term = match[0];
      if (/^[a-z0-9]/.test(term)) {
        if (term.length > 1 && !STOP_WORDS.has(term)) tokens.push(term);
        continue;
      }
      if (term.length <= 4 && !STOP_WORDS.has(term)) tokens.push(term);
      for (let size = 2; size <= Math.min(4, term.length); size += 1) {
        for (let index = 0; index <= term.length - size; index += 1) {
          const token = term.slice(index, index + size);
          if (!STOP_WORDS.has(token)) tokens.push(token);
        }
      }
    }
    return tokens.slice(0, 5000);
  }

  private expandAliases(value: string): string {
    const normalized = this.normalize(value);
    const additions: string[] = [];
    for (const group of ALIAS_GROUPS) {
      if (group.some((alias) => normalized.includes(this.normalize(alias)))) additions.push(...group);
    }
    return [value, ...additions].join(" ");
  }

  private vectorize(tokens: string[]): { vector: Map<number, number>; norm: number } {
    const vector = new Map<number, number>();
    for (const token of tokens) {
      const hash = this.hashNumber(token);
      const index = Math.abs(hash) % VECTOR_DIMENSIONS;
      const sign = hash & 1 ? 1 : -1;
      vector.set(index, (vector.get(index) ?? 0) + sign / Math.sqrt(Math.max(1, token.length)));
    }
    const norm = Math.sqrt(Array.from(vector.values()).reduce((sum, value) => sum + value * value, 0));
    return { vector, norm };
  }

  private cosine(left: Map<number, number>, leftNorm: number, right: Map<number, number>, rightNorm: number): number {
    if (!leftNorm || !rightNorm) return 0;
    let dot = 0;
    const smaller = left.size <= right.size ? left : right;
    const larger = smaller === left ? right : left;
    for (const [index, value] of smaller) dot += value * (larger.get(index) ?? 0);
    return dot / (leftNorm * rightNorm);
  }

  private coverage(queryTokens: string[], evidence: ContextEvidence[]): number {
    const meaningful = Array.from(new Set(queryTokens.filter((term) => term.length >= 2))).slice(0, 32);
    if (meaningful.length === 0) return evidence.length > 0 ? 1 : 0;
    const haystack = this.normalize(evidence.map((item) => `${item.source.title} ${item.content}`).join(" "));
    const matched = meaningful.filter((term) => haystack.includes(term)).length;
    return Math.min(1, matched / meaningful.length);
  }

  private sourceType(path: string): ContextSource["type"] {
    const lower = path.toLowerCase();
    if (lower.includes("/memory/summaries/") || lower.includes("/weekly/") || lower.includes("/monthly/")) return "summary";
    if (lower.includes("/daily/")) return "daily";
    if (lower.includes("/tasks/")) return "task";
    if (lower.includes("/projects/")) return "project";
    if (lower.includes("/knowledge/llmwiki/")) return "llm-wiki";
    if (lower.includes("/memory/")) return "memory";
    if (lower.includes("/knowledge/")) return "knowledge";
    return "graph";
  }

  private sourceTrust(path: string): number {
    const lower = path.toLowerCase();
    if (lower.includes("/memory/core/") || lower.includes("/projects/") || lower.includes("/tasks/")) return 1;
    if (lower.includes("/knowledge/")) return 0.92;
    if (lower.includes("/daily/")) return 0.82;
    return 0.72;
  }

  private excerpt(value: string, maxChars: number): string {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
  }

  private normalize(value: string): string {
    return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  }

  private normalizePath(path: string): string {
    return path.replace(/\\/g, "/");
  }

  private hashNumber(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash | 0;
  }

  private async yieldToUi(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.round(Number.isFinite(value) ? value : min)));
  }
}
