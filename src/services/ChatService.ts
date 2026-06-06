import { App, TFile } from "obsidian";
import type { PersonalLifeSystemSettings } from "../settings";
import type { ChatMessage } from "../types";
import { formatTime, today } from "../utils/dates";
import { ensureFile } from "../utils/vault";
import { ChatContextService, type ChatContextStatusCard } from "./ChatContextService";
import { DailyNoteService } from "./DailyNoteService";
import { FileSystemService } from "./FileSystemService";
import { parseChatMarkdown, serializeChatMarkdown } from "./lifeos-logic";

export interface ChatHistoryItem {
  path: string;
  title: string;
  messages: ChatMessage[];
}

export interface ChatContextItem {
  label: string;
  path: string;
  preview: string;
}

export interface SaveConversationOptions {
  date?: string;
  mode?: string;
  style?: string;
  length?: string;
  status?: "completed" | "interrupted" | "error" | "saved" | string;
  contextSources?: string[];
}

export class ChatService {
  constructor(private app: App, private fs: FileSystemService, private assistantName: string, private settings?: PersonalLifeSystemSettings) {}

  async loadHistory(limit = 8): Promise<ChatHistoryItem[]> {
    const files = this.listHistoryFiles().slice(0, limit);
    const history: ChatHistoryItem[] = [];
    for (const file of files) {
      const content = await this.app.vault.read(file);
      history.push({ path: file.path, title: file.basename, messages: parseChatMarkdown(content, this.assistantName) as ChatMessage[] });
    }
    return history;
  }

  async deleteHistoryItem(path: string): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    if (!file.path.startsWith(this.fs.path("Chat") + "/")) return false;
    await this.app.vault.delete(file);
    return true;
  }

  async clearHistory(): Promise<number> {
    const files = this.listHistoryFiles();
    for (const file of files) {
      await this.app.vault.delete(file);
    }
    return files.length;
  }

  async saveConversation(messages: ChatMessage[], options: SaveConversationOptions | string = {}): Promise<TFile> {
    const normalized = typeof options === "string" ? { date: options } : options;
    const date = normalized.date ?? today();
    const stamp = formatTime().replace(":", "");
    const path = this.fs.path("Chat", `${date}-${stamp}.md`);
    const file = await ensureFile(this.app, path, "");
    await this.app.vault.modify(file, serializeChatMarkdown({
      date,
      assistantName: this.assistantName,
      messages,
      mode: normalized.mode,
      style: normalized.style,
      length: normalized.length,
      status: normalized.status,
      contextSources: normalized.contextSources
    }));
    return file;
  }

  async appendToDaily(content: string, date = today()): Promise<TFile> {
    const file = await new DailyNoteService(this.app, this.fs, this.settings).ensureTodayNote(date);
    await this.app.vault.append(file, `\n## AI 对话记录 ${formatTime()}\n\n${content.trim()}\n`);
    return file;
  }

  async collectContext(date = today()): Promise<ChatContextItem[]> {
    const cards = await this.collectStatusCards(date);
    return cards.map((card) => ({
      label: card.label,
      path: card.path,
      preview: card.main || "暂时没有内容"
    }));
  }

  async collectStatusCards(date = today()): Promise<ChatContextStatusCard[]> {
    return new ChatContextService(this.app, this.settings ?? { rootFolder: this.fs.root }).collectStatusCards(date);
  }

  formatContextForPrompt(items: ChatContextItem[]): string {
    return items.map((item) => `## ${item.label}\n路径：${item.path}\n${item.preview}`).join("\n\n");
  }

  private listHistoryFiles(): TFile[] {
    const prefix = this.fs.path("Chat") + "/";
    return this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(prefix))
      .sort((a, b) => b.basename.localeCompare(a.basename));
  }
}
