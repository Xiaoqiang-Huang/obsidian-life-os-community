import { ObsidianMetadataService } from "./ObsidianMetadataService";
import type { ContextInventoryItem, ContextSection, ContextSource } from "./types";

export interface ContextCandidateBuildInput {
  userMessage: string;
  inventory: ContextInventoryItem[];
  limit?: number;
}

interface ScoredCandidate {
  item: ContextInventoryItem;
  markdown: string;
  score: number;
  type: ContextSource["type"];
  matchedKeywords: string[];
}

const DEFAULT_LIMIT = 10;
const HARD_LIMIT = 16;
const SCAN_LIMIT = 260;
const NORMAL_SCAN_LIMIT = 8;
const EXCERPT_CHARS = 1000;
const SOURCE_TYPE_FIRST_PASS_LIMIT = 4;

const GENERIC_TERMS = new Set([
  "the", "and", "for", "with", "from", "what", "which", "about", "tell", "me",
  "我的", "根据", "回答", "分析", "总结", "知识库", "资料", "笔记", "内容", "信息", "全部", "所有", "关于",
  "里面", "有什么", "是什么", "怎么", "如何", "请问", "一下"
]);

const DOMAIN_TERMS = [
  "知识库", "日记", "任务", "项目", "复盘", "记忆", "学习", "资料", "进度", "总结", "计划", "目标"
];

export class ContextCandidateService {
  private readonly rootFolder: string;

  constructor(private readonly metadata: ObsidianMetadataService, rootFolder: string) {
    this.rootFolder = rootFolder.replace(/\\/g, "/").replace(/\/+$/g, "");
  }

  async buildSections(input: ContextCandidateBuildInput): Promise<ContextSection[]> {
    const keywords = this.keywords(input.userMessage);
    const limit = this.limit(input.limit);
    const scannedItems = this.scanItems(input.inventory, keywords, input.userMessage);
    const candidates: ScoredCandidate[] = [];

    for (const item of scannedItems) {
      const markdown = await this.read(item.path);
      if (!markdown.trim()) continue;
      const scored = this.scoreCandidate(item, markdown, keywords, input.userMessage);
      if (scored.score <= 0) continue;
      candidates.push(scored);
    }

    const selected = this.selectDiverse(candidates, limit);
    const sections = selected.map((candidate, index) => this.candidateSection(candidate, index));
    sections.push(this.auditSection({
      scannedCount: scannedItems.length,
      candidateCount: candidates.length,
      selected,
      omittedCount: Math.max(0, candidates.length - selected.length)
    }));
    return sections;
  }

  private scanItems(inventory: ContextInventoryItem[], keywords: string[], userMessage: string): ContextInventoryItem[] {
    const readable = inventory
      .filter((item) => this.isReadableMarkdown(item))
      .map((item) => ({ item, score: this.metadataScore(item, keywords) }))
      .sort((a, b) => b.score - a.score || b.item.mtime - a.item.mtime || a.item.path.localeCompare(b.item.path));

    const knowledgeIntent = this.hasKnowledgeIntent(userMessage);
    const scanLimit = knowledgeIntent ? SCAN_LIMIT : NORMAL_SCAN_LIMIT;
    const priority = readable.filter((entry) => entry.score > 0).map((entry) => entry.item);
    const recent = [...readable].sort((a, b) => b.item.mtime - a.item.mtime).map((entry) => entry.item);
    const knowledge = readable
      .filter((entry) => entry.item.path.toLowerCase().includes("/knowledge/"))
      .map((entry) => entry.item);

    return this.uniqueItems(knowledgeIntent ? [...knowledge, ...priority, ...recent] : [...priority, ...recent]).slice(0, scanLimit);
  }

  private async read(path: string): Promise<string> {
    try {
      return await this.metadata.readFile(path);
    } catch {
      return "";
    }
  }

  private scoreCandidate(
    item: ContextInventoryItem,
    markdown: string,
    keywords: string[],
    userMessage: string
  ): ScoredCandidate {
    const matchedKeywords = this.matchedKeywords(markdown, item, keywords);
    const metadataScore = this.metadataScore(item, keywords);
    const bodyScore = this.bodyScore(markdown, keywords);
    const type = this.sourceType(item.path);
    const typeBoost = this.typeBoost(type, userMessage);
    const recencyBoost = Math.min(8, Math.max(0, item.mtime / 1_000_000_000_000));

    return {
      item,
      markdown,
      score: metadataScore + bodyScore + typeBoost + recencyBoost,
      type,
      matchedKeywords
    };
  }

  private metadataScore(item: ContextInventoryItem, keywords: string[]): number {
    const haystack = [
      item.path,
      item.title,
      ...item.tags,
      ...item.headings,
      ...item.links,
      ...item.backlinks,
      ...Object.keys(item.frontmatter)
    ].join(" ").toLowerCase();

    let score = 0;
    for (const keyword of keywords) {
      if (haystack.includes(keyword.toLowerCase())) score += 18;
    }
    if (item.path.toLowerCase().includes("/knowledge/")) score += 2;
    return score;
  }

  private bodyScore(markdown: string, keywords: string[]): number {
    const lower = markdown.toLowerCase();
    let score = 0;
    for (const keyword of keywords) {
      const normalized = keyword.toLowerCase();
      if (!normalized) continue;
      if (lower.includes(normalized)) score += Math.min(56, 16 + normalized.length * 2);
    }
    return score;
  }

  private typeBoost(type: ContextSource["type"], userMessage: string): number {
    const lower = userMessage.toLowerCase();
    if (type === "knowledge" || type === "llm-wiki") {
      return /知识库|资料|笔记|wiki|knowledge|note/i.test(lower) ? 18 : 6;
    }
    if (type === "task") return /任务|项目|进度|task|project/i.test(lower) ? 16 : 4;
    if (type === "daily") return /日记|今天|过去|daily|diary/i.test(lower) ? 14 : 2;
    if (type === "memory" || type === "summary") return /记忆|复盘|总结|memory|review|summary/i.test(lower) ? 12 : 3;
    return 0;
  }

  private selectDiverse(candidates: ScoredCandidate[], limit: number): ScoredCandidate[] {
    const sorted = [...candidates].sort((a, b) => b.score - a.score || b.item.mtime - a.item.mtime || a.item.path.localeCompare(b.item.path));
    const selected: ScoredCandidate[] = [];
    const countByType = new Map<ContextSource["type"], number>();

    for (const candidate of sorted) {
      if (selected.length >= limit) break;
      const count = countByType.get(candidate.type) ?? 0;
      if (count >= SOURCE_TYPE_FIRST_PASS_LIMIT) continue;
      selected.push(candidate);
      countByType.set(candidate.type, count + 1);
    }

    for (const candidate of sorted) {
      if (selected.length >= limit) break;
      if (selected.some((item) => item.item.path === candidate.item.path)) continue;
      selected.push(candidate);
    }

    return selected;
  }

  private candidateSection(candidate: ScoredCandidate, index: number): ContextSection {
    const excerpt = this.excerpt(candidate.markdown, candidate.matchedKeywords);
    const content = [
      `Source: ${candidate.item.path}`,
      `Score: ${Math.round(candidate.score)}`,
      candidate.matchedKeywords.length > 0 ? `Matched keywords: ${candidate.matchedKeywords.join(", ")}` : "",
      "",
      excerpt
    ].filter(Boolean).join("\n");

    return {
      title: `Context candidate ${index + 1}: ${candidate.item.title}`,
      content,
      priority: 58,
      source: candidate.item.path,
      sourceInfo: {
        path: candidate.item.path,
        title: candidate.item.title,
        type: candidate.type,
        excerpt: excerpt.slice(0, 240)
      }
    };
  }

  private auditSection(input: {
    scannedCount: number;
    candidateCount: number;
    selected: ScoredCandidate[];
    omittedCount: number;
  }): ContextSection {
    const selectedTypes = this.countTypes(input.selected);
    const selectedPaths = input.selected.map((candidate) => `- ${candidate.item.path}`).join("\n") || "- none";
    const content = [
      `Scanned markdown files: ${input.scannedCount}`,
      `Relevant candidates: ${input.candidateCount}`,
      `Selected candidates: ${input.selected.length}`,
      `Omitted by budget/diversity: ${input.omittedCount}`,
      `Selected source types: ${selectedTypes}`,
      "Selected paths:",
      selectedPaths
    ].join("\n");

    return {
      title: "Context retrieval audit",
      content,
      priority: 55,
      source: "ContextCandidateService",
      sourceInfo: {
        path: "ContextCandidateService",
        title: "Context retrieval audit",
        type: "graph",
        excerpt: content.slice(0, 240)
      }
    };
  }

  private countTypes(candidates: ScoredCandidate[]): string {
    const counts = new Map<string, number>();
    for (const candidate of candidates) {
      counts.set(candidate.type, (counts.get(candidate.type) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([type, count]) => `${type}=${count}`).join(", ") || "none";
  }

  private matchedKeywords(markdown: string, item: ContextInventoryItem, keywords: string[]): string[] {
    const lower = [
      item.path,
      item.title,
      ...item.tags,
      ...item.headings,
      markdown
    ].join(" ").toLowerCase();
    return keywords.filter((keyword) => lower.includes(keyword.toLowerCase())).slice(0, 8);
  }

  private excerpt(markdown: string, keywords: string[]): string {
    const clean = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "").replace(/\r\n/g, "\n").trim();
    if (!clean) return "";
    const lower = clean.toLowerCase();
    const matchIndex = keywords
      .map((keyword) => lower.indexOf(keyword.toLowerCase()))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, matchIndex - 220);
    const excerpt = clean.slice(start, start + EXCERPT_CHARS).trim();
    return start > 0 ? `...${excerpt}` : excerpt;
  }

  private keywords(message: string): string[] {
    const terms = new Set<string>();
    for (const term of DOMAIN_TERMS) {
      if (message.includes(term)) terms.add(term);
    }

    for (const match of message.matchAll(/[A-Za-z0-9][A-Za-z0-9_-]*|[\p{Script=Han}]{2,}/gu)) {
      const value = match[0].trim();
      if (!value) continue;
      if (/^[A-Za-z0-9_-]+$/.test(value)) {
        this.addKeyword(terms, value);
      } else {
        this.addHanKeywords(terms, value);
      }
    }

    return Array.from(terms).slice(0, 24);
  }

  private addHanKeywords(terms: Set<string>, value: string): void {
    const compact = value.replace(/我的|根据|回答|分析|总结|关于|里面|有什么|是什么|请问|一下/g, "");
    if (compact.length >= 2 && compact.length <= 8) this.addKeyword(terms, compact);
    for (const term of DOMAIN_TERMS) {
      if (value.includes(term)) this.addKeyword(terms, term);
    }
  }

  private addKeyword(terms: Set<string>, value: string): void {
    const normalized = value.trim().toLowerCase();
    if (normalized.length < 2) return;
    if (GENERIC_TERMS.has(normalized)) return;
    terms.add(value.trim());
  }

  private hasKnowledgeIntent(message: string): boolean {
    return /知识库|资料|笔记|wiki|knowledge|note|zettelkasten/i.test(message);
  }

  private isReadableMarkdown(item: ContextInventoryItem): boolean {
    const lower = item.path.toLowerCase();
    if (!lower.endsWith(".md")) return false;
    if (!lower.startsWith(`${this.rootFolder.toLowerCase()}/`)) return false;
    if (lower.includes("/knowledge/llmwiki/trash/")) return false;
    if (lower.includes("/attachments/")) return false;
    return true;
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

  private uniqueItems(items: ContextInventoryItem[]): ContextInventoryItem[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      if (seen.has(item.path)) return false;
      seen.add(item.path);
      return true;
    });
  }

  private limit(value?: number): number {
    const numeric = Number(value ?? DEFAULT_LIMIT);
    if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_LIMIT;
    return Math.min(Math.max(Math.floor(numeric), 1), HARD_LIMIT);
  }
}
