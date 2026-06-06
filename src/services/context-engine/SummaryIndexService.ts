import { ObsidianMetadataService } from "./ObsidianMetadataService";
import type { ContextEngineMode, ContextInventoryItem, ContextSection, ContextSource } from "./types";

interface SummarySectionInput {
  date?: string;
  mode: ContextEngineMode;
  inventory?: ContextInventoryItem[];
}

export class SummaryIndexService {
  private readonly rootFolder: string;

  constructor(private readonly metadata: ObsidianMetadataService, rootFolder: string) {
    this.rootFolder = rootFolder.replace(/\\/g, "/").replace(/\/+$/g, "");
  }

  async getSections(input: SummarySectionInput): Promise<ContextSection[]> {
    const inventory = input.inventory ?? await this.metadata.getInventory();
    const sections: ContextSection[] = [];
    const date = input.date ?? this.today();

    await this.addDailySections(sections, inventory, date);
    if (input.mode === "graph") {
      await this.addSummarySections(sections, inventory, "weekly", 48);
      await this.addSummarySections(sections, inventory, "monthly", 46);
    }

    return sections;
  }

  private async addDailySections(sections: ContextSection[], inventory: ContextInventoryItem[], date: string): Promise<void> {
    const todayDaily = this.findByPath(inventory, `${this.rootFolder}/Daily/${date}.md`);
    const todaySummary = inventory.find((item) =>
      item.path.includes(date) && this.isSummaryLike(item) && item.path.toLowerCase().includes("/daily/")
    );

    for (const item of [todaySummary, todayDaily]) {
      if (item) await this.addSection(sections, item, item === todaySummary ? 60 : 55);
    }

    const recentDaily = inventory
      .filter((item) => item.path.toLowerCase().includes("/daily/") && item.path !== todayDaily?.path && item.path !== todaySummary?.path)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 3);
    for (const item of recentDaily) {
      await this.addSection(sections, item, 35);
    }
  }

  private async addSummarySections(sections: ContextSection[], inventory: ContextInventoryItem[], kind: "weekly" | "monthly", priority: number): Promise<void> {
    const candidates = inventory
      .filter((item) => {
        const lower = `${item.path} ${item.title} ${item.tags.join(" ")}`.toLowerCase();
        return lower.includes(kind) || lower.includes(kind === "weekly" ? "周" : "月");
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 2);
    for (const item of candidates) {
      await this.addSection(sections, item, priority);
    }
  }

  private async addSection(sections: ContextSection[], item: ContextInventoryItem, priority: number): Promise<void> {
    if (sections.some((section) => section.source === item.path)) return;
    const content = await this.metadata.readFile(item.path);
    if (!content) return;
    sections.push({
      title: item.title,
      content: content.slice(0, 2000),
      priority,
      source: item.path,
      sourceInfo: {
        path: item.path,
        title: item.title,
        type: this.sourceType(item.path),
        excerpt: content.slice(0, 240)
      }
    });
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

  private findByPath(inventory: ContextInventoryItem[], path: string): ContextInventoryItem | undefined {
    return inventory.find((item) => item.path === path);
  }

  private isSummaryLike(item: ContextInventoryItem): boolean {
    const text = `${item.path} ${item.title} ${item.tags.join(" ")}`.toLowerCase();
    return text.includes("summary") || text.includes("review") || text.includes("总结") || text.includes("复盘");
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
