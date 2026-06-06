import { App, Notice, TFile } from "obsidian";
import type { PendingMemory } from "../types";
import { formatDate, formatTime } from "../utils/dates";
import { ensureFile, readFile } from "../utils/vault";
import { FileSystemService } from "./FileSystemService";
import {
  appendConfirmedMemory,
  formatMemoryCandidate,
  parseCategoryMemories,
  parseIgnoredMemories,
  parsePendingMemories,
  updateMemoryStatus,
  type MemoryCandidateInput
} from "./lifeos-logic";
import { randomId } from "../utils/ids";

export interface MemoryRecord {
  content: string;
  source: string;
  created: string;
  status: string;
}

export class MemoryService {
  constructor(private app: App, private fs: FileSystemService) {}

  parsePendingMemories(content: string): PendingMemory[] {
    return parsePendingMemories(content, this.now()).map((entry) => this.toPendingMemory(entry));
  }

  async loadPending(): Promise<PendingMemory[]> {
    const path = this.fs.path("Memory", "Inbox", "pending-memories.md");
    const content = await readFile(this.app, path);
    return this.parsePendingMemories(content);
  }

  async appendCandidate(input: { content: string; category?: string; source?: string; importance?: string; created?: string }): Promise<void> {
    const file = await ensureFile(this.app, this.fs.path("Memory", "Inbox", "pending-memories.md"), "# 待确认记忆\n\n");
    await this.app.vault.append(file, formatMemoryCandidate({
      id: `mem_${randomId("").replace(/^-/, "").replace(/-/g, "_")}`,
      content: input.content,
      category: input.category || "其他",
      source: input.source || "quick-capture",
      created: input.created || this.now(),
      status: "pending",
      importance: input.importance || "normal"
    }));
  }

  async loadCategory(category: string): Promise<MemoryRecord[]> {
    const content = await readFile(this.app, this.fs.path("Memory", `${category}.md`));
    return parseCategoryMemories(content);
  }

  async loadIgnored(): Promise<MemoryRecord[]> {
    const content = await readFile(this.app, this.fs.path("Memory", "Inbox", "pending-memories.md"));
    return parseIgnoredMemories(content);
  }

  async confirm(entries: PendingMemory[], fallbackCategory: string): Promise<void> {
    if (entries.length === 0) return;
    const confirmed = this.now();
    const groups = new Map<string, PendingMemory[]>();
    for (const entry of entries) {
      const category = entry.category?.trim() || fallbackCategory || "其他";
      groups.set(category, [...(groups.get(category) ?? []), entry]);
    }

    for (const [category, group] of groups) {
      const categoryFile = await ensureFile(this.app, this.fs.path("Memory", `${category}.md`), `# ${category}记忆\n\n`);
      let content = await this.app.vault.read(categoryFile);
      for (const entry of group) content = appendConfirmedMemory(content, this.fromPendingMemory(entry, category), confirmed);
      await this.app.vault.modify(categoryFile, content);
    }

    await this.markEntries(entries, "confirmed", confirmed);
    new Notice(`已确认 ${entries.length} 条记忆。`);
  }

  async ignore(entries: PendingMemory[]): Promise<void> {
    await this.markEntries(entries, "ignored", this.now());
    new Notice(`已忽略 ${entries.length} 条候选记忆。`);
  }

  private async markEntries(entries: PendingMemory[], status: "confirmed" | "ignored", timestamp: string): Promise<void> {
    const path = this.fs.path("Memory", "Inbox", "pending-memories.md");
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    const content = await this.app.vault.read(file);
    await this.app.vault.modify(file, updateMemoryStatus(content, entries.map((entry) => this.fromPendingMemory(entry)), status, timestamp));
  }

  private toPendingMemory(entry: MemoryCandidateInput): PendingMemory {
    return {
      id: entry.id || `mem_${randomId("").replace(/^-/, "").replace(/-/g, "_")}`,
      lineStart: entry.lineStart ?? 0,
      lineEnd: entry.lineEnd ?? entry.lineStart ?? 0,
      raw: entry.raw || formatMemoryCandidate(entry),
      content: entry.content,
      source: entry.source || "quick-capture",
      created: entry.created || "",
      status: entry.status || "pending",
      category: entry.category || "其他",
      importance: entry.importance || "normal",
      selected: false
    };
  }

  private fromPendingMemory(entry: PendingMemory, category = entry.category): MemoryCandidateInput {
    return {
      id: entry.id,
      content: entry.content,
      category: category || "其他",
      source: entry.source || "quick-capture",
      created: entry.created || this.now(),
      status: entry.status || "pending",
      importance: entry.importance || "normal",
      lineStart: entry.lineStart,
      lineEnd: entry.lineEnd,
      raw: entry.raw
    };
  }

  private now(): string {
    return `${formatDate()} ${formatTime()}`;
  }
}
