import type { AiLike, ContextEngineMode, ContextInventoryItem, ContextRetrievalPlan } from "./types";

interface PlanInput {
  userMessage: string;
  mode: ContextEngineMode;
  inventory: ContextInventoryItem[];
}

type PartialPlan = Partial<ContextRetrievalPlan>;

const DEFAULT_DIRECTORIES = ["Daily", "Tasks", "Memory", "Knowledge", "Projects"];
const INVENTORY_ITEM_CAP = 80;
const PROMPT_INVENTORY_CHAR_CAP = 12000;
const TITLE_CHAR_CAP = 80;
const LIST_ITEM_CAP = 8;
const LIST_ITEM_CHAR_CAP = 80;
const USER_MESSAGE_AI_CHAR_CAP = 2000;

export class AiRetrievalPlanner {
  constructor(private readonly ai?: AiLike) {}

  async plan(input: PlanInput): Promise<ContextRetrievalPlan> {
    if (!this.ai) return this.fallbackPlan(input.userMessage);

    try {
      const prompt = this.buildPrompt(input);
      const response = await this.ai.complete({
        prompt,
        messages: [
          { role: "system", content: "You are a safe retrieval planner for a local Obsidian Life OS vault. Return only JSON." },
          { role: "user", content: prompt }
        ],
        responseFormat: "json",
        temperature: 0
      });
      if (!response.ok || !response.text) return this.fallbackPlan(input.userMessage);

      const parsed = this.parsePlan(response.text);
      if (!parsed) return this.fallbackPlan(input.userMessage);
      return this.normalizePlan(parsed, input.userMessage);
    } catch {
      return this.fallbackPlan(input.userMessage);
    }
  }

  private buildPrompt(input: PlanInput): string {
    const inventory = this.promptInventory(input);
    const userMessage = this.truncate(input.userMessage, USER_MESSAGE_AI_CHAR_CAP);

    return [
      "You are planning safe local retrieval for a Life OS vault.",
      "Use only this metadata inventory. Do not assume or request note body text.",
      "Return JSON with keys: keywords, paths, tags, directories, limit.",
      JSON.stringify({
        userMessage,
        mode: input.mode,
        inventory
      })
    ].join("\n");
  }

  private promptInventory(input: PlanInput): Array<{
    path: string;
    title: string;
    tags: string[];
    headings: string[];
    links: string[];
    backlinks: string[];
    mtime: number;
  }> {
    const inventory = input.inventory
      .slice(0, INVENTORY_ITEM_CAP)
      .map((item) => ({
        path: item.path,
        title: this.truncate(item.title, TITLE_CHAR_CAP),
        tags: this.truncateList(item.tags),
        headings: this.truncateList(item.headings),
        links: this.truncateList(item.links),
        backlinks: this.truncateList(item.backlinks),
        mtime: item.mtime
      }));

    while (inventory.length > 0 && this.inventoryJsonLength(input, inventory) > PROMPT_INVENTORY_CHAR_CAP) {
      inventory.pop();
    }

    return inventory;
  }

  private inventoryJsonLength(input: PlanInput, inventory: unknown[]): number {
    return JSON.stringify({
      userMessage: this.truncate(input.userMessage, USER_MESSAGE_AI_CHAR_CAP),
      mode: input.mode,
      inventory
    }).length;
  }

  private truncateList(values: string[]): string[] {
    return values.slice(0, LIST_ITEM_CAP).map((value) => this.truncate(value, LIST_ITEM_CHAR_CAP));
  }

  private truncate(value: string, maxChars: number): string {
    return value.length > maxChars ? value.slice(0, maxChars) : value;
  }

  private parsePlan(text: string): PartialPlan | null {
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as PartialPlan : null;
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        const parsed = JSON.parse(match[0]) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as PartialPlan : null;
      } catch {
        return null;
      }
    }
  }

  private normalizePlan(plan: PartialPlan, userMessage: string): ContextRetrievalPlan {
    const fallback = this.fallbackPlan(userMessage);
    return {
      keywords: this.stringArray(plan.keywords, fallback.keywords),
      paths: this.stringArray(plan.paths, []),
      tags: this.stringArray(plan.tags, []),
      directories: this.stringArray(plan.directories, fallback.directories),
      limit: this.safeLimit(plan.limit, fallback.limit)
    };
  }

  private fallbackPlan(userMessage: string): ContextRetrievalPlan {
    return {
      keywords: this.tokenize(userMessage),
      paths: [],
      tags: [],
      directories: [...DEFAULT_DIRECTORIES],
      limit: 8
    };
  }

  private tokenize(text: string): string[] {
    const tokens = Array.from(text.matchAll(/[\p{L}\p{N}_-]+/gu), (match) => match[0].trim())
      .filter((token) => token.length > 0 && !["最近", "怎么", "怎么样"].includes(token));
    return Array.from(new Set(tokens)).slice(0, 12);
  }

  private stringArray(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) return fallback;
    const values = value.map((item) => String(item ?? "").trim()).filter(Boolean);
    return values.length > 0 ? Array.from(new Set(values)).slice(0, 20) : fallback;
  }

  private safeLimit(value: unknown, fallback: number): number {
    const limit = Number(value);
    if (!Number.isFinite(limit) || limit <= 0) return fallback;
    return Math.min(Math.max(Math.floor(limit), 1), 20);
  }
}
