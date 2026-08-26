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
  channel: "desktop" | "weixin" | string;
  source: string;
  projectId: string;
  updatedAt: string;
}

export type ChatHistoryChannelFilter = "all" | "desktop" | "weixin";

export interface ChatContextItem {
  label: string;
  path: string;
  preview: string;
}

export interface SaveConversationOptions {
  date?: string;
  title?: string;
  source?: string;
  channel?: string;
  projectId?: string;
  accountId?: string;
  conversationId?: string;
  senderId?: string;
  isGroup?: boolean;
  updatedAt?: string;
  mode?: string;
  style?: string;
  length?: string;
  status?: "completed" | "interrupted" | "error" | "saved" | string;
  contextSources?: string[];
}

export class ChatService {
  constructor(private app: App, private fs: FileSystemService, private assistantName: string, private settings?: PersonalLifeSystemSettings) {}

  async loadHistory(limit = 8, channel: ChatHistoryChannelFilter = "all"): Promise<ChatHistoryItem[]> {
    const files = this.listHistoryFiles();
    const history: ChatHistoryItem[] = [];
    for (const file of files) {
      // WeChat conversations live in their own subtree. Skip those files before
      // reading when the desktop drawer is selected; otherwise a large remote
      // history makes merely opening the local history drawer unnecessarily slow.
      if (channel === "desktop" && file.path.includes("/Weixin/")) continue;
      const cached = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
      const content = await this.app.vault.read(file);
      const cachedTitle = String(cached.title ?? "").trim();
      const source = this.frontmatterValue(content, "source", cached.source) || (file.path.includes("/Weixin/") ? "weixin" : "assistant");
      const itemChannel = this.normalizeChannel(
        this.frontmatterValue(content, "channel", cached.channel) || source,
        file.path
      );
      if (channel !== "all" && itemChannel !== channel) continue;
      history.push({
        path: file.path,
        title: cachedTitle || this.frontmatterTitle(content) || file.basename,
        messages: parseChatMarkdown(content, this.assistantName) as ChatMessage[],
        channel: itemChannel,
        source,
        projectId: this.frontmatterValue(content, "project_id", cached.project_id),
        updatedAt: this.frontmatterValue(content, "updated_at", cached.updated_at) || new Date(file.stat.mtime).toISOString()
      });
      if (history.length >= limit) break;
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

  async clearHistory(channel: ChatHistoryChannelFilter = "desktop"): Promise<number> {
    const items = await this.loadHistory(Number.MAX_SAFE_INTEGER, channel);
    const files = items
      .map((item) => this.app.vault.getAbstractFileByPath(item.path))
      .filter((file): file is TFile => file instanceof TFile);
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
      title: normalized.title || this.conversationTitle(messages),
      source: normalized.source || "assistant",
      channel: normalized.channel || "desktop",
      projectId: normalized.projectId,
      accountId: normalized.accountId,
      conversationId: normalized.conversationId,
      senderId: normalized.senderId,
      isGroup: normalized.isGroup,
      updatedAt: normalized.updatedAt || new Date().toISOString(),
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
      .sort((a, b) => b.stat.mtime - a.stat.mtime || b.basename.localeCompare(a.basename));
  }

  private frontmatterTitle(content: string): string {
    const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1] ?? "";
    const raw = block.match(/^title:\s*(.+)$/mu)?.[1]?.trim() ?? "";
    if (!raw) return "";
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        const parsed = JSON.parse(raw);
        return typeof parsed === "string" ? parsed.trim() : "";
      } catch {
        return raw.slice(1, -1).trim();
      }
    }
    return raw.replace(/^['"]|['"]$/g, "").trim();
  }

  private frontmatterValue(content: string, key: string, cached?: unknown): string {
    const cachedText = String(cached ?? "").trim();
    if (cachedText) return cachedText;
    const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1] ?? "";
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const raw = block.match(new RegExp(`^${escapedKey}:\\s*(.*)$`, "mu"))?.[1]?.trim() ?? "";
    if (!raw) return "";
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        const parsed = JSON.parse(raw);
        return typeof parsed === "string" ? parsed.trim() : String(parsed ?? "").trim();
      } catch {
        return raw.slice(1, -1).trim();
      }
    }
    return raw.replace(/^['"]|['"]$/g, "").trim();
  }

  private normalizeChannel(value: string, path: string): "desktop" | "weixin" | string {
    const normalized = value.trim().toLowerCase();
    if (normalized === "weixin" || path.includes("/Weixin/")) return "weixin";
    if (!normalized || normalized === "assistant" || normalized === "obsidian" || normalized === "desktop") return "desktop";
    return normalized;
  }

  private conversationTitle(messages: ChatMessage[]): string {
    const first = messages.find((message) => message.role === "user")?.content.replace(/\s+/gu, " ").trim() || "新对话";
    return first.length > 64 ? `${first.slice(0, 64)}…` : first;
  }
}
