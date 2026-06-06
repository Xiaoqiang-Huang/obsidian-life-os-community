import { ObsidianMetadataService } from "./ObsidianMetadataService";
import type { ContextInventoryItem, ContextSection, ContextSource } from "./types";

interface GraphBuildInput {
  userMessage: string;
  date?: string;
  inventory?: ContextInventoryItem[];
}

const MAX_ENTITY_LINES = 10;
const MAX_EVIDENCE_FILES = 4;
const EXCERPT_CHARS = 1000;

export class GraphContextService {
  private readonly rootFolder: string;

  constructor(private readonly metadata: ObsidianMetadataService, rootFolder: string) {
    this.rootFolder = rootFolder.replace(/\\/g, "/").replace(/\/+$/g, "");
  }

  async build(input: GraphBuildInput): Promise<ContextSection[]> {
    const inventory = input.inventory ?? await this.metadata.getInventory();
    if (inventory.length === 0) return [];

    const active = await this.metadata.getActiveFile();
    const seeds = this.seedItems(inventory, input.userMessage, active?.path, input.date);
    const related = this.relatedItems(inventory, seeds, input.userMessage);
    const sections: ContextSection[] = [];

    for (const item of this.uniqueItems([...seeds, ...related]).slice(0, MAX_ENTITY_LINES)) {
      sections.push({
        title: `Obsidian 图谱节点：${item.title}`,
        content: this.graphSummary(item, seeds, related),
        priority: 72,
        source: item.path,
        sourceInfo: this.sourceFor(item, "")
      });
    }

    for (const item of related.slice(0, MAX_EVIDENCE_FILES)) {
      const markdown = await this.metadata.readFile(item.path);
      if (!markdown) continue;
      sections.push({
        title: `Obsidian 图谱证据：${item.title}`,
        content: this.excerpt(markdown),
        priority: 64,
        source: item.path,
        sourceInfo: this.sourceFor(item, markdown)
      });
    }

    return sections;
  }

  private seedItems(inventory: ContextInventoryItem[], userMessage: string, activePath?: string, date?: string): ContextInventoryItem[] {
    const tokens = this.tokens(userMessage);
    const seeds = inventory
      .map((item) => ({ item, score: this.textScore(item, tokens, date) + (item.path === activePath ? 40 : 0) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.item.mtime - a.item.mtime)
      .map((entry) => entry.item);
    if (seeds.length === 0 && activePath) {
      const active = inventory.find((item) => item.path === activePath);
      if (active) return [active];
    }
    return seeds.slice(0, 5);
  }

  private relatedItems(inventory: ContextInventoryItem[], seeds: ContextInventoryItem[], userMessage: string): ContextInventoryItem[] {
    const tokens = this.tokens(userMessage);
    const seedPaths = new Set(seeds.map((item) => item.path));
    const seedNames = new Set(seeds.flatMap((item) => [item.path, item.title, this.basename(item.path)]).map((name) => this.normalizeEntity(name)));
    const linkedNames = new Set(seeds.flatMap((item) => [...item.links, ...item.backlinks]).map((name) => this.normalizeEntity(name)));
    const linkedPaths = new Set(seeds.flatMap((item) => item.backlinks));

    const ranked = inventory
      .map((item) => {
        const isSeed = seedPaths.has(item.path);
        const linked = linkedPaths.has(item.path) || linkedNames.has(this.normalizeEntity(item.path)) || linkedNames.has(this.normalizeEntity(item.title)) || linkedNames.has(this.normalizeEntity(this.basename(item.path)));
        const connectsToSeed = item.links.some((link) => seedNames.has(this.normalizeEntity(link))) || item.backlinks.some((path) => seedPaths.has(path));
        return {
          item,
          score: (isSeed ? 80 : 0) + (linked ? 60 : 0) + (connectsToSeed ? 30 : 0) + this.textScore(item, tokens)
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.item.mtime - a.item.mtime)
      .map((entry) => entry.item);

    return this.uniqueItems(ranked);
  }

  private graphSummary(item: ContextInventoryItem, seeds: ContextInventoryItem[], related: ContextInventoryItem[]): string {
    const role = seeds.some((seed) => seed.path === item.path) ? "seed" : related.some((relatedItem) => relatedItem.path === item.path) ? "related" : "node";
    const links = [...item.links, ...item.backlinks].slice(0, 6).join(", ");
    const tags = item.tags.length > 0 ? ` #${item.tags.join(" #")}` : "";
    return `- ${item.title}${tags} (${role}): ${links || "无显式链接"} (${item.path})`;
  }

  private textScore(item: ContextInventoryItem, tokens: string[], date?: string): number {
    let score = date && item.path.includes(date) ? 20 : 0;
    const haystack = [
      item.path,
      item.title,
      ...item.tags,
      ...item.headings,
      ...item.links,
      ...item.backlinks,
      ...Object.keys(item.frontmatter)
    ].join(" ").toLowerCase();
    for (const token of tokens) {
      if (haystack.includes(token.toLowerCase())) score += 12;
    }
    if (item.path.startsWith(`${this.rootFolder}/Memory/Summaries/`)) score += 8;
    return score;
  }

  private sourceFor(item: ContextInventoryItem | undefined, markdown: string): ContextSource | undefined {
    if (!item) return undefined;
    return {
      path: item.path,
      title: item.title,
      type: this.sourceType(item.path),
      excerpt: markdown ? this.excerpt(markdown).slice(0, 240) : undefined
    };
  }

  private excerpt(markdown: string): string {
    const clean = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "").trim();
    return clean.length > EXCERPT_CHARS ? `${clean.slice(0, EXCERPT_CHARS).trim()}...` : clean;
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

  private tokens(text: string): string[] {
    return Array.from(text.matchAll(/[\p{L}\p{N}_-]+/gu), (match) => match[0].trim()).filter(Boolean).slice(0, 12);
  }

  private basename(path: string): string {
    return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
  }

  private normalizeEntity(value: string): string {
    return value.replace(/\.md$/i, "").trim().toLowerCase();
  }

  private uniqueItems(items: ContextInventoryItem[]): ContextInventoryItem[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      if (seen.has(item.path)) return false;
      seen.add(item.path);
      return true;
    });
  }
}
