import type { ContextEvidence } from "./types";

export interface VectorRetrievalIndex {
  search?: (input: VectorSearchInput) => Promise<ContextEvidence[]> | ContextEvidence[];
}

export interface VectorSearchInput {
  userMessage: string;
  maxResults?: number;
}

export interface VectorSearchResult {
  available: boolean;
  evidence: ContextEvidence[];
  warnings: string[];
}

const DEFAULT_MAX_RESULTS = 8;
const HARD_MAX_RESULTS = 12;
const EVIDENCE_CONTENT_MAX_CHARS = 1200;
const SOURCE_EXCERPT_MAX_CHARS = 240;
const SOURCE_TYPES = new Set(["current-note", "daily", "task", "memory", "summary", "knowledge", "llm-wiki", "graph", "url"]);

export class VectorRetrievalService {
  constructor(private readonly index?: VectorRetrievalIndex) {}

  async search(input: VectorSearchInput): Promise<VectorSearchResult> {
    if (!this.index?.search) {
      return this.unavailable();
    }

    try {
      const evidence = await this.index.search({
        ...input,
        maxResults: this.maxResults(input.maxResults)
      });
      return {
        available: true,
        evidence: this.sanitizeEvidence(evidence, input.maxResults),
        warnings: []
      };
    } catch {
      return this.unavailable();
    }
  }

  private unavailable(): VectorSearchResult {
    return {
      available: false,
      evidence: [],
      warnings: ["向量索引不可用，已降级为智能上下文。"]
    };
  }

  private sanitizeEvidence(value: unknown, requestedMax?: number): ContextEvidence[] {
    if (!Array.isArray(value)) return [];
    const limit = this.maxResults(requestedMax);
    const evidence: ContextEvidence[] = [];

    for (const entry of value) {
      if (evidence.length >= limit) break;
      const item = this.sanitizeEntry(entry);
      if (item) evidence.push(item);
    }

    return evidence;
  }

  private sanitizeEntry(value: unknown): ContextEvidence | null {
    if (!value || typeof value !== "object") return null;
    const item = value as Partial<ContextEvidence>;
    const source = item.source;
    if (!source || typeof source !== "object") return null;
    const path = String(source.path ?? "").trim();
    const title = String(source.title ?? "").trim();
    const content = String(item.content ?? "").trim();
    if (!path || !title || !content) return null;
    const sourceType = SOURCE_TYPES.has(String(source.type)) ? source.type : "knowledge";

    return {
      content: this.truncate(content, EVIDENCE_CONTENT_MAX_CHARS),
      score: Number.isFinite(Number(item.score)) ? Number(item.score) : 0,
      source: {
        path,
        title,
        type: sourceType,
        excerpt: source.excerpt ? this.truncate(String(source.excerpt), SOURCE_EXCERPT_MAX_CHARS) : undefined
      }
    };
  }

  private maxResults(maxResults?: number): number {
    const numericMax = Number(maxResults ?? DEFAULT_MAX_RESULTS);
    if (!Number.isFinite(numericMax) || numericMax <= 0) return DEFAULT_MAX_RESULTS;
    return Math.min(Math.floor(numericMax), HARD_MAX_RESULTS);
  }

  private truncate(value: string, maxChars: number): string {
    return value.length > maxChars ? value.slice(0, maxChars).trim() : value;
  }
}
