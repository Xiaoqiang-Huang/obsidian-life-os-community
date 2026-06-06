import { ObsidianMetadataService } from "./ObsidianMetadataService";
import type { ContextEvidence, ContextInventoryItem, ContextRetrievalPlan, ContextSource } from "./types";

const EXCERPT_MAX_CHARS = 1200;
const MAX_SEARCH_LIMIT = 12;
const MAX_READ_CANDIDATES = 12;
const MAX_BODY_SEARCH_CANDIDATES = 80;

interface ScoredInventoryItem {
  item: ContextInventoryItem;
  score: number;
}

interface BodyMatch {
  candidate: ScoredInventoryItem;
  markdown: string;
  score: number;
}

interface BodySearchResult {
  matches: BodyMatch[];
  markdownByPath: Map<string, string>;
}

export class LocalRetrievalService {
  constructor(private readonly metadata: ObsidianMetadataService) {}

  async search(plan: ContextRetrievalPlan, inventory?: ContextInventoryItem[]): Promise<ContextEvidence[]> {
    const limit = this.clampedLimit(plan.limit);
    const items = inventory ?? await this.metadata.getInventory();
    const candidates = items
      .map((item) => ({ item, score: this.scoreItem(item, plan) }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || b.item.mtime - a.item.mtime);

    const evidence: ContextEvidence[] = [];
    const seen = new Set<string>();

    const bodySearch = await this.bodyMatches(candidates, plan);
    for (const match of bodySearch.matches) {
      if (evidence.length >= limit) break;
      seen.add(match.candidate.item.path);
      evidence.push({
        content: this.excerpt(match.markdown, plan.keywords),
        score: match.score,
        source: this.sourceFor(match.candidate.item, match.markdown)
      });
    }

    for (const candidate of candidates.slice(0, Math.min(limit, MAX_READ_CANDIDATES))) {
      if (evidence.length >= limit) break;
      if (seen.has(candidate.item.path)) continue;
      const markdown = bodySearch.markdownByPath.get(candidate.item.path) ?? await this.metadata.readFile(candidate.item.path);
      if (!markdown) continue;
      evidence.push({
        content: this.excerpt(markdown, plan.keywords),
        score: candidate.score,
        source: this.sourceFor(candidate.item, markdown)
      });
    }
    return evidence;
  }

  private async bodyMatches(candidates: ScoredInventoryItem[], plan: ContextRetrievalPlan): Promise<BodySearchResult> {
    const keywords = plan.keywords.map((keyword) => keyword.trim()).filter(Boolean);
    const markdownByPath = new Map<string, string>();
    if (keywords.length === 0 || candidates.length === 0) return { matches: [], markdownByPath };

    const matches: BodyMatch[] = [];
    for (const candidate of candidates.slice(0, MAX_BODY_SEARCH_CANDIDATES)) {
      const markdown = await this.metadata.readFile(candidate.item.path);
      if (!markdown) continue;
      markdownByPath.set(candidate.item.path, markdown);
      const matchScore = this.bodyKeywordScore(markdown, keywords);
      if (matchScore <= 0) continue;
      matches.push({
        candidate,
        markdown,
        score: candidate.score + 64 + matchScore
      });
    }

    return {
      matches: matches.sort((a, b) => b.score - a.score || b.candidate.item.mtime - a.candidate.item.mtime),
      markdownByPath
    };
  }

  private clampedLimit(limit: number | undefined): number {
    const numericLimit = Number(limit ?? 8);
    if (!Number.isFinite(numericLimit)) return 8;
    return Math.min(Math.max(Math.floor(numericLimit), 1), MAX_SEARCH_LIMIT);
  }

  private scoreItem(item: ContextInventoryItem, plan: ContextRetrievalPlan): number {
    let score = 0;
    if (plan.paths.includes(item.path)) score += 100;
    if (plan.directories.some((directory) => this.pathMatchesDirectory(item.path, directory))) score += 12;
    score += item.tags.filter((tag) => plan.tags.includes(tag)).length * 16;

    const haystack = [
      item.path,
      item.title,
      ...item.tags,
      ...item.headings,
      ...item.links,
      ...item.backlinks
    ].join(" ").toLowerCase();
    for (const keyword of plan.keywords) {
      if (haystack.includes(keyword.toLowerCase())) score += 8;
    }

    return score;
  }

  private pathMatchesDirectory(path: string, directory: string): boolean {
    const normalizedDirectory = directory.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
    if (!normalizedDirectory) return false;
    return path.toLowerCase().split("/").includes(normalizedDirectory);
  }

  private bodyKeywordScore(markdown: string, keywords: string[]): number {
    const lower = markdown.toLowerCase();
    let score = 0;
    for (const keyword of keywords) {
      const normalized = keyword.toLowerCase();
      if (!normalized) continue;
      if (lower.includes(normalized)) score += Math.min(normalized.length, 12);
    }
    return score;
  }

  private excerpt(markdown: string, keywords: string[]): string {
    const normalized = markdown.replace(/\r\n/g, "\n").trim();
    const lower = normalized.toLowerCase();
    const keywordIndex = keywords
      .map((keyword) => lower.indexOf(keyword.toLowerCase()))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, keywordIndex - 240);
    const excerpt = normalized.slice(start, start + EXCERPT_MAX_CHARS);
    return start > 0 ? `...${excerpt}`.slice(0, EXCERPT_MAX_CHARS) : excerpt;
  }

  private sourceFor(item: ContextInventoryItem, markdown: string): ContextSource {
    return {
      path: item.path,
      title: item.title,
      type: this.sourceType(item.path),
      excerpt: this.excerpt(markdown, [])
    };
  }

  private sourceType(path: string): ContextSource["type"] {
    const lower = path.toLowerCase();
    if (lower.includes("/memory/summaries/") || lower.includes("summary") || lower.includes("/weekly/") || lower.includes("/monthly/")) return "summary";
    if (lower.includes("/daily/")) return "daily";
    if (lower.includes("/tasks/")) return "task";
    if (lower.includes("/knowledge/llmwiki/")) return "llm-wiki";
    if (lower.includes("/memory/")) return "memory";
    if (lower.includes("/knowledge/")) return "knowledge";
    return "graph";
  }
}
