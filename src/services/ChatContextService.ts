import type { App } from "obsidian";
import { localizeLifeOsPathParts, normalizeDirectoryLanguage, type ChatContextMode, type PersonalLifeSystemSettings } from "../settings";
import { today } from "../utils/dates";
import { ContextEngine, chatModeToEngineMode } from "./ContextEngine";
import { ContextSourcePolicyService } from "./context-engine/ContextSourcePolicyService";
import type { AiLike, ContextEngineResult, ContextSource } from "./context-engine/types";
import { LlmWikiContextService } from "./LlmWikiContextService";

export type ChatContextKey = "daily" | "tasks" | "memory" | "review" | "knowledge" | "current-note";

export interface ChatContextStatusCard {
  key: ChatContextKey;
  label: string;
  main: string;
  detail: string;
  path: string;
  available: boolean;
}

export interface ChatContextSection {
  title: string;
  content: string;
  priority: number;
  source?: string;
}

export interface ChatContextBundle {
  promptContext: string;
  sections: ChatContextSection[];
  statusCards: ChatContextStatusCard[];
  contextSources: string[];
}

export interface BuildChatContextOptions {
  date?: string;
  userMessage?: string;
  maxChars?: number;
  fetchUrl?: (url: string) => Promise<string>;
  searchWeb?: (query: string) => Promise<string>;
  contextMode?: ChatContextMode;
}

type FileLike = {
  path: string;
  name: string;
  basename: string;
  extension?: string;
  stat?: { mtime: number };
};

const MEMORY_CATEGORIES = ["学业", "项目", "备考", "人际", "健康", "偏好", "其他"];
const DEFAULT_CONTEXT_CHARS = 56000;
const MIN_CONTEXT_ENGINE_BUILD_CHARS = 4000;
const EMPTY_TEXT = "暂时没有内容";
const FALLBACK_DAILY_LIMIT = 7;

export class ChatContextService {
  constructor(private app: App, private settings: Partial<PersonalLifeSystemSettings>, private ai?: AiLike) {}

  async buildContextBundle(options: BuildChatContextOptions = {}): Promise<ChatContextBundle> {
    const date = options.date ?? today();
    try {
      const result = await new ContextEngine(this.app, this.settings, this.ai).build({
        userMessage: options.userMessage ?? "",
        chatMode: options.contextMode,
        date,
        maxChars: Math.max(options.maxChars ?? DEFAULT_CONTEXT_CHARS, MIN_CONTEXT_ENGINE_BUILD_CHARS),
        fetchUrl: options.fetchUrl,
        searchWeb: options.searchWeb
      });
      const sections = result.sections;
      const requestedMode = chatModeToEngineMode(options.contextMode);
      const promptContext = withContextEngineMetadata(result, {
        userMessage: options.userMessage ?? "",
        selectedModeLabel: contextModeLabel(options.contextMode ?? "smart"),
        requestedMode,
        maxChars: options.maxChars ?? DEFAULT_CONTEXT_CHARS
      });
      const contextSources = uniqueStrings([
        `ContextMode:${contextModeLabel(options.contextMode ?? "smart")}`,
        `ContextEngine:${result.modeUsed}`,
        `ContextEngineRequested:${requestedMode}`,
        ...sections.map((section) => section.title),
        ...result.sources.map((source) => source.path),
        ...result.warnings
      ]);

      return {
        promptContext,
        sections,
        statusCards: await this.collectStatusCards(date),
        contextSources
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const recovery = "Primary context engine recovered with all-vault markdown fallback.";
      const sections = await this.buildAllVaultFallbackSections(date);
      sections.unshift({
        title: "Context recovery note",
        content: `${recovery}\nDiary, knowledge, and memory Markdown notes below remain usable for this answer; Obsidian plugin configuration files remain excluded.`,
        priority: 100,
        source: "ContextEngine"
      });
      return {
        promptContext: applyContextBudget(sections, options.userMessage ?? "", options.maxChars ?? DEFAULT_CONTEXT_CHARS),
        sections,
        statusCards: await this.collectStatusCards(date),
        contextSources: uniqueStrings([
          `上下文模式：${contextModeLabel(options.contextMode ?? "smart")}`,
          "warning: ContextEngine recovered with all-vault markdown fallback",
          "fallback: all-vault markdown context",
          `diagnostic: ${message}`
        ])
      };
    }
  }

  private async buildAllVaultFallbackSections(date: string): Promise<ChatContextSection[]> {
    const sections = await this.buildCoreFallbackSections(date);
    const existingSources = new Set(sections.map((section) => section.source).filter(Boolean));
    const parts: string[] = [];
    const files = this.markdownFiles()
      .filter((file) => this.isReadableChatContextFile(file))
      .sort(byRecent)
      .slice(0, 24);

    for (const file of files) {
      if (existingSources.has(file.path)) continue;
      const excerpt = this.cleanExcerpt(await this.readAllowedFile(file), 700);
      if (excerpt) parts.push(`### ${file.path}\n${excerpt}`);
      if (parts.length >= 16) break;
    }

    if (parts.length > 0) {
      sections.push({
        title: "全库 Markdown（降级）",
        content: parts.join("\n\n"),
        priority: 88,
        source: "Vault Markdown"
      });
    }

    return sections;
  }

  private async buildCoreFallbackSections(date: string): Promise<ChatContextSection[]> {
    const sections: ChatContextSection[] = [];

    const todayPath = this.path("Daily", `${date}.md`);
    const todayDaily = await this.readAllowedPath(todayPath);
    if (todayDaily.trim()) {
      sections.push({
        title: "今日日记（降级）",
        content: this.cleanExcerpt(todayDaily, 2200),
        priority: 96,
        source: todayPath
      });
    }

    const recentDailyParts: string[] = [];
    const recentDailyFiles = this.filesUnder(this.path("Daily"))
      .filter((file) => file.path !== todayPath)
      .sort(byRecent)
      .slice(0, FALLBACK_DAILY_LIMIT);
    for (const file of recentDailyFiles) {
      const content = await this.readAllowedFile(file);
      const excerpt = this.cleanExcerpt(content, 700);
      if (excerpt) recentDailyParts.push(`### ${file.basename}\n${excerpt}`);
    }
    if (recentDailyParts.length > 0) {
      sections.push({
        title: "最近日记（降级）",
        content: recentDailyParts.join("\n\n"),
        priority: 90,
        source: this.path("Daily")
      });
    }

    const openTasksPath = this.path("Tasks", "open.md");
    const openTasks = (await this.readAllowedPath(openTasksPath))
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith("- [ ]"))
      .slice(0, 20)
      .join("\n");
    if (openTasks) {
      sections.push({
        title: "未完成待办（降级）",
        content: openTasks,
        priority: 82,
        source: openTasksPath
      });
    }

    const coreParts: string[] = [];
    for (const name of ["profile.md", "current-projects.md"]) {
      const path = this.path("Memory", "Core", name);
      const content = this.cleanExcerpt(await this.readAllowedPath(path), 900);
      if (content) coreParts.push(`### ${name}\n${content}`);
    }
    if (coreParts.length > 0) {
      sections.push({
        title: "核心记忆（降级）",
        content: coreParts.join("\n\n"),
        priority: 78,
        source: this.path("Memory", "Core")
      });
    }

    const dailySummaryRoot = this.path("Memory", "Summaries", "Daily");
    const summaryParts: string[] = [];
    for (const file of this.filesUnder(dailySummaryRoot).sort(byRecent).slice(0, 5)) {
      const excerpt = this.cleanExcerpt(await this.readAllowedFile(file), 500);
      if (excerpt) summaryParts.push(`### ${file.basename}\n${excerpt}`);
    }
    if (summaryParts.length > 0) {
      sections.push({
        title: "最近复盘摘要（降级）",
        content: summaryParts.join("\n\n"),
        priority: 66,
        source: dailySummaryRoot
      });
    }

    return sections;
  }

  private async buildLegacyContextBundle(options: BuildChatContextOptions = {}, date = options.date ?? today()): Promise<ChatContextBundle> {
    const contextMode = options.contextMode ?? "smart";
    const sections: ChatContextSection[] = [];

    const currentNote = await this.buildCurrentNoteSection(options.userMessage ?? "");
    if (currentNote) sections.push(currentNote);

    const dailyPath = this.path("Daily", `${date}.md`);
    const dailyContent = await this.readPath(dailyPath);
    if (dailyContent) {
      sections.push({
        title: "今日日记",
        content: this.cleanExcerpt(dailyContent, 3000),
        priority: 95,
        source: dailyPath
      });
      const recentRecords = recentRecordBlocks(dailyContent, 3);
      if (recentRecords) {
        sections.push({
          title: "最近 3 条记录",
          content: recentRecords,
          priority: 92,
          source: dailyPath
        });
      }
    }

    const openTasksPath = this.path("Tasks", "open.md");
    const openTasksContent = await this.readPath(openTasksPath);
    const openTasks = openTasksContent.split(/\r?\n/).filter((line) => line.trim().startsWith("- [ ]")).slice(0, 20);
    if (openTasks.length > 0) {
      sections.push({
        title: "未完成待办",
        content: openTasks.join("\n"),
        priority: 90,
        source: openTasksPath
      });
    }

    const doneTasksPath = this.path("Tasks", "done.md");
    const doneTasksContent = await this.readPath(doneTasksPath);
    const doneTasks = doneTasksContent.split(/\r?\n/).filter((line) => line.trim().startsWith("- [x]")).slice(-10);
    if (doneTasks.length > 0) {
      sections.push({
        title: "最近完成任务",
        content: doneTasks.join("\n"),
        priority: 70,
        source: doneTasksPath
      });
    }

    await this.addMemorySections(sections);
    await this.addSummarySections(sections, date);
    await this.addExamSections(sections, date);
    await this.addKnowledgeSections(sections);
    sections.push(...await new LlmWikiContextService(this.app, this.settings).buildContextSections());
    await this.addUrlSection(sections, options.userMessage ?? "", options.fetchUrl);

    const statusCards = await this.collectStatusCards(date);
    const promptContext = applyContextBudget(sections, options.userMessage ?? "", options.maxChars ?? DEFAULT_CONTEXT_CHARS);
    const contextSources = [`上下文模式：${contextModeLabel(contextMode)}`, ...sections.map((section) => section.title)];
    return { promptContext, sections, statusCards, contextSources };
  }

  async collectStatusCards(date = today()): Promise<ChatContextStatusCard[]> {
    const dailyPath = this.path("Daily", `${date}.md`);
    const daily = await this.readPath(dailyPath);
    const dailyRecords = countRecordLines(daily);

    const openPath = this.path("Tasks", "open.md");
    const openTasks = countMatches(await this.readPath(openPath), /^-\s*\[\s\]/gm);

    const memoryRoot = this.path("Memory");
    const longTermMemories = await this.countLongTermMemories();
    const pendingPath = this.path("Memory", "Inbox", "pending-memories.md");
    const pendingMemories = countMatches(await this.readPath(pendingPath), /^-\s*\[\s\]/gm);

    const summaryPath = this.path("Memory", "Summaries", "Daily", `${date}.md`);
    const summary = await this.readPath(summaryPath);

    const knowledgeRoot = this.path("Knowledge");
    const knowledgeCount = this.recentKnowledgeFiles(8).length;

    const current = getActiveMarkdownFile(this.app);

    return [
      {
        key: "daily",
        label: "今日日记",
        main: dailyRecords > 0 ? `已读取 ${dailyRecords} 条记录` : "暂无记录",
        detail: dailyRecords > 0 ? "已纳入今天的记录上下文" : "今天还没有日记或有效记录",
        path: dailyPath,
        available: dailyRecords > 0
      },
      {
        key: "tasks",
        label: "待办任务",
        main: `${openTasks} 条未完成`,
        detail: openTasks > 0 ? "会优先参考未完成行动" : "当前没有未完成任务",
        path: openPath,
        available: openTasks > 0
      },
      {
        key: "memory",
        label: "记忆",
        main: `已读取 ${longTermMemories} 条长期记忆 / ${pendingMemories} 条候选`,
        detail: longTermMemories > 0 || pendingMemories > 0 ? "会参考已确认记忆和候选池" : "还没有可参考的长期记忆",
        path: memoryRoot,
        available: longTermMemories > 0 || pendingMemories > 0
      },
      {
        key: "review",
        label: "复盘",
        main: summary.trim() ? "今日复盘已读取" : "暂未生成",
        detail: summary.trim() ? "今日总结会作为压缩上下文" : "今天还没有复盘总结",
        path: summaryPath,
        available: Boolean(summary.trim())
      },
      {
        key: "knowledge",
        label: "知识库",
        main: `已读取 ${knowledgeCount} 条最近知识`,
        detail: knowledgeCount > 0 ? "会参考最近整理的知识笔记" : "Knowledge 目录暂无最近笔记",
        path: knowledgeRoot,
        available: knowledgeCount > 0
      },
      {
        key: "current-note",
        label: "当前笔记",
        main: current ? "已读取当前笔记摘要" : "未打开 Markdown 笔记",
        detail: current ? "会参考当前工作区的笔记内容和链接" : "打开一篇笔记后可提供更精准上下文",
        path: current?.path ?? "当前工作区",
        available: Boolean(current)
      }
    ];
  }

  private async buildCurrentNoteSection(focusText: string): Promise<ChatContextSection | null> {
    const file = getActiveMarkdownFile(this.app);
    if (!file) return null;
    if (!this.isReadableChatContextFile(file)) return null;
    const content = await this.readFile(file);
    const links = await this.buildLinkContext(file, focusText);
    const body = [
      `当前笔记：${file.path}`,
      this.cleanExcerpt(content, 2500),
      links
    ].filter(Boolean).join("\n\n");
    return {
      title: "当前打开笔记摘要",
      content: body,
      priority: 100,
      source: file.path
    };
  }

  private async addMemorySections(sections: ChatContextSection[]): Promise<void> {
    const coreParts: string[] = [];
    for (const name of ["profile.md", "current-projects.md"]) {
      const path = this.path("Memory", "Core", name);
      const content = await this.readPath(path);
      if (content.trim()) coreParts.push(`### ${name}\n${this.cleanExcerpt(content, 1200)}`);
    }
    if (coreParts.length > 0) {
      sections.push({ title: "核心记忆", content: coreParts.join("\n\n"), priority: 88, source: this.path("Memory", "Core") });
    }

    const categoryParts: string[] = [];
    for (const category of MEMORY_CATEGORIES) {
      const path = this.path("Memory", `${category}.md`);
      const content = await this.readPath(path);
      const lines = content.split(/\r?\n/).filter((line) => line.trim().startsWith("- ")).slice(-8);
      if (lines.length > 0) categoryParts.push(`### ${category}\n${lines.join("\n")}`);
    }
    if (categoryParts.length > 0) {
      sections.push({ title: "分类长期记忆", content: categoryParts.join("\n\n"), priority: 82, source: this.path("Memory") });
    }

    const pendingPath = this.path("Memory", "Inbox", "pending-memories.md");
    const pending = (await this.readPath(pendingPath)).split(/\r?\n/).filter((line) => line.trim().startsWith("- [ ]")).slice(-10);
    if (pending.length > 0) {
      sections.push({ title: "候选记忆", content: pending.join("\n"), priority: 64, source: pendingPath });
    }
  }

  private async addSummarySections(sections: ChatContextSection[], date: string): Promise<void> {
    const todaySummaryPath = this.path("Memory", "Summaries", "Daily", `${date}.md`);
    const todaySummary = await this.readPath(todaySummaryPath);
    if (todaySummary.trim()) {
      sections.push({ title: "今日 Daily Summary", content: this.cleanExcerpt(todaySummary, 1200), priority: 86, source: todaySummaryPath });
    }

    const recentDaily = this.filesUnder(this.path("Memory", "Summaries", "Daily"))
      .sort((a, b) => b.name.localeCompare(a.name))
      .filter((file) => file.path !== todaySummaryPath)
      .slice(0, 7);
    const dailyParts = await this.readFilesAsSummaries(recentDaily, 500);
    if (dailyParts) sections.push({ title: "最近 7 天 Daily Summary", content: dailyParts, priority: 66, source: this.path("Memory", "Summaries", "Daily") });

    const weekly = await this.readFilesAsSummaries(this.filesUnder(this.path("Memory", "Summaries", "Weekly")).sort(byRecent).slice(0, 2), 700);
    if (weekly) sections.push({ title: "最近 Weekly Summary", content: weekly, priority: 54, source: this.path("Memory", "Summaries", "Weekly") });

    const monthly = await this.readFilesAsSummaries(this.filesUnder(this.path("Memory", "Summaries", "Monthly")).sort(byRecent).slice(0, 2), 900);
    if (monthly) sections.push({ title: "最近 Monthly Summary", content: monthly, priority: 46, source: this.path("Memory", "Summaries", "Monthly") });
  }

  private async addExamSections(sections: ChatContextSection[], date: string): Promise<void> {
    const checkinPath = this.path("Exam", "Checkins", `${date}.md`);
    const checkin = await this.readPath(checkinPath);
    if (checkin.trim()) sections.push({ title: "今日打卡", content: this.cleanExcerpt(checkin, 900), priority: 78, source: checkinPath });

    const goals = this.filesUnder(this.path("Exam", "Goals")).sort(byRecent).slice(0, 8);
    const active: string[] = [];
    for (const file of goals) {
      const content = await this.readFile(file);
      if (/status:\s*active/i.test(content) || /状态[:：]\s*进行中/.test(content)) {
        active.push(`### ${file.basename}\n${this.cleanExcerpt(content, 500)}`);
      }
    }
    if (active.length > 0) sections.push({ title: "Exam Active Goals", content: active.join("\n\n"), priority: 58, source: this.path("Exam", "Goals") });
  }

  private async addKnowledgeSections(sections: ChatContextSection[]): Promise<void> {
    const recent = this.recentKnowledgeFiles(5);
    const summaries = await this.readFilesAsSummaries(recent, 700);
    if (summaries) sections.push({ title: "Knowledge 最近修改内容", content: summaries, priority: 44, source: this.path("Knowledge") });
  }

  private async addUrlSection(sections: ChatContextSection[], message: string, fetchUrl?: (url: string) => Promise<string>): Promise<void> {
    const urls = extractUrls(message).slice(0, 3);
    if (urls.length === 0) return;
    const parts: string[] = [];
    for (const url of urls) {
      try {
        const text = await this.fetchUrlText(url, fetchUrl);
        parts.push(`### ${url}\n${text.slice(0, 4000).trim() || "链接内容为空"}`);
      } catch {
        parts.push(`### ${url}\n无法读取此链接，聊天会继续。`);
      }
    }
    sections.push({ title: "链接内容", content: parts.join("\n\n"), priority: 74, source: urls.join(", ") });
  }

  private async fetchUrlText(url: string, fetchUrl?: (url: string) => Promise<string>): Promise<string> {
    if (fetchUrl) return fetchUrl(url);
    throw new Error(`URL fetcher is not configured: ${url}`);
  }

  private async buildLinkContext(source: FileLike, focusText: string): Promise<string> {
    const links = (this.app as unknown as { metadataCache?: { resolvedLinks?: Record<string, Record<string, number>> } }).metadataCache?.resolvedLinks ?? {};
    const outbound = links[source.path] ?? {};
    const candidates = new Map<string, number>();
    for (const [path, count] of Object.entries(outbound)) candidates.set(path, (candidates.get(path) ?? 0) + count * 2);
    for (const [from, destinations] of Object.entries(links)) {
      const count = destinations[source.path] ?? 0;
      if (count > 0) candidates.set(from, (candidates.get(from) ?? 0) + count);
    }
    const focus = focusText.toLowerCase();
    const files = Array.from(candidates.entries())
      .map(([path, score]) => {
        const file = this.getFile(path);
        if (!file || file.path === source.path) return null;
        if (!this.isReadableChatContextFile(file)) return null;
        const bonus = focus && focus.includes(file.basename.toLowerCase()) ? 5 : 0;
        return { file, score: score + bonus };
      })
      .filter((entry): entry is { file: FileLike; score: number } => Boolean(entry))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    if (files.length === 0) return "";
    const parts: string[] = [];
    for (const { file, score } of files) {
      const content = await this.readFile(file);
      parts.push(`### ${file.path}（关联强度 ${score}）\n${this.cleanExcerpt(content, 450)}`);
    }
    return `## Obsidian 链接上下文\n${parts.join("\n\n")}`;
  }

  private async readFilesAsSummaries(files: FileLike[], maxChars: number): Promise<string> {
    const parts: string[] = [];
    for (const file of files) {
      const content = await this.readFile(file);
      const excerpt = this.cleanExcerpt(content, maxChars);
      if (excerpt) parts.push(`### ${file.basename}\n${excerpt}`);
    }
    return parts.join("\n\n");
  }

  private async countLongTermMemories(): Promise<number> {
    let count = 0;
    for (const category of MEMORY_CATEGORIES) {
      count += countMatches(await this.readPath(this.path("Memory", `${category}.md`)), /^-\s+/gm);
    }
    return count;
  }

  private recentKnowledgeFiles(limit: number): FileLike[] {
    return this.filesUnder(this.path("Knowledge"))
      .filter((file) => file.name !== "index.md")
      .filter((file) => this.isReadableChatContextFile(file))
      .sort(byRecent)
      .slice(0, limit);
  }

  private isReadableChatContextFile(file: FileLike): boolean {
    return new ContextSourcePolicyService(normalizePathLocal(this.settings.rootFolder || "PersonalLifeSystem")).isAllowedPath(file.path);
  }

  private filesUnder(prefix: string): FileLike[] {
    const clean = prefix.endsWith("/") ? prefix : `${prefix}/`;
    return this.markdownFiles().filter((file) => file.path.startsWith(clean));
  }

  private markdownFiles(): FileLike[] {
    const files = (this.app as unknown as { vault?: { getMarkdownFiles?: () => FileLike[] } }).vault?.getMarkdownFiles?.() ?? [];
    return files.filter((file) => isMarkdownFile(file));
  }

  private getFile(path: string): FileLike | null {
    const file = (this.app as unknown as { vault?: { getAbstractFileByPath?: (path: string) => unknown } }).vault?.getAbstractFileByPath?.(path);
    return isMarkdownFile(file) ? file : null;
  }

  private async readPath(path: string): Promise<string> {
    const file = this.getFile(path);
    return file ? this.readFile(file) : "";
  }

  private async readAllowedPath(path: string): Promise<string> {
    const file = this.getFile(path);
    return file ? this.readAllowedFile(file) : "";
  }

  private async readAllowedFile(file: FileLike): Promise<string> {
    const policy = new ContextSourcePolicyService(normalizePathLocal(this.settings.rootFolder || "PersonalLifeSystem"));
    if (!policy.isAllowedPath(file.path)) return "";
    try {
      const content = await this.readFile(file);
      return policy.isAllowedFrontmatter(parseFrontmatterLocal(content)) ? content : "";
    } catch {
      return "";
    }
  }

  private async readFile(file: FileLike): Promise<string> {
    return String(await (this.app as unknown as { vault: { read: (file: FileLike) => Promise<string> } }).vault.read(file));
  }

  private path(...parts: string[]): string {
    const localized = localizeLifeOsPathParts(parts, normalizeDirectoryLanguage(this.settings.directoryLanguage));
    return joinPathLocal(normalizePathLocal(this.settings.rootFolder || "PersonalLifeSystem"), ...localized);
  }

  private cleanExcerpt(content: string, maxChars: number): string {
    const clean = content
      .replace(/^---[\s\S]*?---\s*/m, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("![[") && !line.startsWith("![]("))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return clean.length > maxChars ? `${clean.slice(0, maxChars).trim()}...` : clean;
  }
}

export function applyContextBudget(sections: ChatContextSection[], userQuestion: string, maxChars = DEFAULT_CONTEXT_CHARS): string {
  const header = userQuestion.trim() ? `# 用户当前问题\n${userQuestion.trim()}\n\n# Life OS 上下文\n` : "# Life OS 上下文\n";
  const ordered = [...sections].sort((a, b) => b.priority - a.priority);
  const chunks: string[] = [];
  let remaining = Math.max(0, maxChars - header.length);

  for (const section of ordered) {
    if (remaining <= 0) break;
    const block = `\n\n## ${section.title}${section.source ? `\n来源：${section.source}` : ""}\n${section.content.trim()}`;
    if (block.length <= remaining) {
      chunks.push(block);
      remaining -= block.length;
      continue;
    }
    const title = `\n\n## ${section.title}${section.source ? `\n来源：${section.source}` : ""}\n`;
    if (remaining > title.length + 40) {
      chunks.push(`${title}${section.content.trim().slice(0, remaining - title.length - 3)}...`);
    }
    break;
  }

  return `${header}${chunks.join("")}`.slice(0, maxChars);
}

export function extractUrls(message: string): string[] {
  return Array.from(new Set(message.match(/https?:\/\/[^\s\]\)"'<>]+/g) ?? []));
}

function getActiveMarkdownFile(app: App): FileLike | null {
  const file = (app as unknown as { workspace?: { getActiveFile?: () => unknown } }).workspace?.getActiveFile?.();
  return isMarkdownFile(file) ? file : null;
}

function isMarkdownFile(value: unknown): value is FileLike {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<FileLike>;
  return typeof file.path === "string" && typeof file.name === "string" && file.name.toLowerCase().endsWith(".md");
}

function countRecordLines(content: string): number {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^-\s+/.test(line) && !/^-\s+(id|category|source|created|status|importance|confirmed|ignored|completed|priority):/i.test(line))
    .length;
}

function countMatches(content: string, pattern: RegExp): number {
  return content.match(pattern)?.length ?? 0;
}

function recentRecordBlocks(content: string, limit: number): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^-\s+(?:\d{1,2}:\d{2}\s+)?/.test(line))
    .slice(-limit);
  return lines.length > 0 ? lines.join("\n") : "";
}

function byRecent(a: FileLike, b: FileLike): number {
  return (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0) || b.name.localeCompare(a.name);
}

function normalizePathLocal(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/")
    .trim();
}

function joinPathLocal(...parts: string[]): string {
  return parts.map(normalizePathLocal).filter(Boolean).join("/");
}

function parseFrontmatterLocal(markdown: string): Record<string, unknown> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};

  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const keyValue = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!keyValue) continue;
    frontmatter[keyValue[1]] = parseYamlScalarLocal(keyValue[2]);
  }
  return frontmatter;
}

function parseYamlScalarLocal(value: string): string {
  const trimmed = stripUnquotedCommentLocal(value).trim();
  const quote = trimmed[0];
  if ((quote === "\"" || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed.trimEnd();
}

function stripUnquotedCommentLocal(value: string): string {
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = index > 0 ? value[index - 1] : "";
    if ((char === "\"" || char === "'") && previous !== "\\") {
      quote = quote === char ? "" : quote || char;
    }
    if (!quote && char === "#" && (index === 0 || /\s/.test(previous))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

function mergeContextSections(primary: ChatContextSection[], fallback: ChatContextSection[]): ChatContextSection[] {
  const sections: ChatContextSection[] = [];
  const seen = new Set<string>();

  for (const section of [...primary, ...fallback]) {
    const key = `${section.title}\n${section.source ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sections.push(section);
  }

  return sections;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function withContextEngineMetadata(
  result: ContextEngineResult,
  input: { userMessage: string; selectedModeLabel: string; requestedMode: string; maxChars: number }
): string {
  const maxChars = Math.max(0, input.maxChars);
  if (maxChars === 0) return "";

  const promptParts = splitContextPrompt(result.promptContext);
  if (input.userMessage.trim()) promptParts.question = `# 用户当前问题\n${input.userMessage.trim()}`;
  let warnings = result.warnings;
  let metadata = formatContextEngineMetadata(result, input, warnings);
  const separator = "\n\n";

  if (promptParts.question.length + separator.length + metadata.length + separator.length + promptParts.body.length > maxChars) {
    warnings = uniqueStrings([...warnings, "上下文元信息已注入；正文部分因预算限制被截断。"]);
    metadata = formatContextEngineMetadata(result, input, warnings);
  }

  const requiredBlocks = [promptParts.question, metadata].filter(Boolean);
  let promptContext = requiredBlocks.join(separator);
  const availableForBody = maxChars - promptContext.length - (promptParts.body ? separator.length : 0);
  if (availableForBody <= 0) return promptContext.slice(0, maxChars);

  const body = promptParts.body.length > availableForBody
    ? promptParts.body.slice(0, availableForBody)
    : promptParts.body;
  return `${promptContext}${separator}${body}`.slice(0, maxChars);
}

function splitContextPrompt(promptContext: string): { question: string; body: string } {
  const match = promptContext.match(/^# 用户当前问题\n([\s\S]*?)\n\n# Life OS 上下文\n?/);
  if (!match) return { question: "", body: promptContext };

  const question = match[1].trim();
  const body = promptContext.slice(match[0].length).trim();
  return {
    question: question ? `# 用户当前问题\n${question}` : "",
    body: body ? `# Life OS 上下文\n${body}` : "# Life OS 上下文"
  };
}

function formatContextEngineMetadata(
  result: ContextEngineResult,
  input: { selectedModeLabel: string; requestedMode: string },
  warnings: string[]
): string {
  const warningLines = warnings.length
    ? warnings.slice(0, 8).map((warning) => `  - ${warning}`)
    : ["  - 无"];
  if (warnings.length > 8) warningLines.push(`  - 另有 ${warnings.length - 8} 条警告已省略`);

  const sourceLines = formatContextSources(result.sources);

  return [
    "# Context Engine 元信息",
    `- 用户选择模式：${input.selectedModeLabel}`,
    `- 请求检索模式：${input.requestedMode}`,
    `- 实际检索模式：${result.modeUsed}`,
    `- 置信度：${Math.round(result.confidence * 100)}%`,
    "- 警告：",
    ...warningLines,
    "- 可引用来源：",
    ...sourceLines
  ].join("\n");
}

function formatContextSources(sources: ContextSource[]): string[] {
  if (!sources.length) return ["  - 暂无可引用来源；回答时需要说明资料不足，不能编造来源。"];

  const displayed = sources.slice(0, 20).map((source) => {
    const title = source.title && source.title !== source.path ? ` (${source.title})` : "";
    return `  - [${source.type}] ${source.path}${title}`;
  });
  if (sources.length > 20) displayed.push(`  - 另有 ${sources.length - 20} 个来源已省略`);
  return displayed;
}

function contextModeLabel(mode: ChatContextMode): string {
  switch (mode) {
    case "semantic":
      return "语义增强";
    case "global":
      return "全局分析";
    case "smart":
    default:
      return "智能上下文";
  }
}
