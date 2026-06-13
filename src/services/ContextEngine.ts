import type { App } from "obsidian";
import type { PersonalLifeSystemSettings } from "../settings";
import type { LifeOSTask } from "../types";
import { parseTaskLine } from "../utils/markdown";
import { LlmWikiContextService } from "./LlmWikiContextService";
import { buildProjectOverview, formatProjectOverviewForAi, parseProjectIndex } from "./project-context";
import { AiRetrievalPlanner } from "./context-engine/AiRetrievalPlanner";
import { ContextCandidateService } from "./context-engine/ContextCandidateService";
import { ContextComposer } from "./context-engine/ContextComposer";
import { GraphContextService } from "./context-engine/GraphContextService";
import { LocalRetrievalService } from "./context-engine/LocalRetrievalService";
import { ObsidianMetadataService } from "./context-engine/ObsidianMetadataService";
import { ContextSourcePolicyService } from "./context-engine/ContextSourcePolicyService";
import { SummaryIndexService } from "./context-engine/SummaryIndexService";
import { VectorRetrievalService } from "./context-engine/VectorRetrievalService";
import { extractWebUrls, getWebSearchQuery } from "./WebContextService";
import type {
  AiLike,
  ChatContextMode,
  ContextEngineBuildInput,
  ContextInventoryItem,
  ContextEngineMode,
  ContextEngineResult,
  ContextEvidence,
  ContextSection,
  ContextSource
} from "./context-engine/types";

const DEFAULT_CONTEXT_CHARS = 56000;
const CURRENT_NOTE_CHARS = 2500;
const URL_CONTEXT_CHARS = 4000;
const WEB_SEARCH_CONTEXT_CHARS = 7000;
const KNOWLEDGE_CATALOG_LIMIT = 160;
const KNOWLEDGE_SCAN_LIMIT = 240;
const KNOWLEDGE_RELEVANT_EXCERPT_LIMIT = 10;
const KNOWLEDGE_BROAD_EXCERPT_LIMIT = 24;
const KNOWLEDGE_EXCERPT_CHARS = 900;
const PROJECT_DOCUMENT_SCAN_LIMIT = 80;
const PROJECT_DOCUMENT_SECTION_LIMIT = 12;
const PROJECT_DOCUMENT_EXCERPT_CHARS = 1600;

export class ContextEngine {
  private readonly app: App;
  private readonly settings: Partial<PersonalLifeSystemSettings>;
  private readonly metadata: ObsidianMetadataService;
  private readonly planner: AiRetrievalPlanner;
  private readonly summaries: SummaryIndexService;
  private readonly localRetrieval: LocalRetrievalService;
  private readonly candidates: ContextCandidateService;
  private readonly vectorRetrieval: VectorRetrievalService;
  private readonly graphContext: GraphContextService;
  private readonly composer = new ContextComposer();
  private readonly rootFolder: string;
  private readonly policy: ContextSourcePolicyService;

  constructor(app: App, settings: Partial<PersonalLifeSystemSettings>, ai?: AiLike) {
    this.app = app;
    this.settings = settings;
    this.rootFolder = settings.rootFolder || "PersonalLifeSystem";
    this.policy = new ContextSourcePolicyService(this.rootFolder);
    this.metadata = new ObsidianMetadataService(app, this.rootFolder, this.policy);
    this.planner = new AiRetrievalPlanner(ai);
    this.summaries = new SummaryIndexService(this.metadata, this.rootFolder);
    this.localRetrieval = new LocalRetrievalService(this.metadata);
    this.candidates = new ContextCandidateService(this.metadata, this.rootFolder);
    this.vectorRetrieval = new VectorRetrievalService();
    this.graphContext = new GraphContextService(this.metadata, this.rootFolder);
  }

  async build(input: ContextEngineBuildInput): Promise<ContextEngineResult> {
    const mode = this.resolveMode(input);
    const maxChars = input.maxChars ?? DEFAULT_CONTEXT_CHARS;

    if (mode === "vector") {
      const [vector, inventory] = await Promise.all([
        this.vectorRetrieval.search({
          userMessage: input.userMessage,
          maxResults: 8
        }),
        this.metadata.getInventory()
      ]);
      const scopedInventory = this.scopeInventoryForProject(inventory, input.projectScopeId);
      if (!vector.available) {
        return this.buildLocal(input, vector.warnings, "local", maxChars);
      }
      const projectSections = await this.projectTaskSections(inventory, input.projectScopeId);
      const projectDocumentSections = await this.projectDocumentSections(inventory, input.projectScopeId, input.userMessage);
      const knowledgeSections = await this.knowledgeCoverageSections(scopedInventory, input.userMessage);
      const candidateSections = await this.candidates.buildSections({ userMessage: input.userMessage, inventory: scopedInventory, limit: 6 });
      return this.composer.compose({
        userMessage: input.userMessage,
        modeUsed: "vector",
        maxChars,
        sections: [
          ...projectSections,
          ...projectDocumentSections,
          ...knowledgeSections,
          ...candidateSections,
          ...this.evidenceSections(vector.evidence, 58, "向量检索证据")
        ],
        warnings: vector.warnings
      });
    }

    if (mode === "graph") {
      return this.buildGraph(input, maxChars);
    }

    return this.buildLocal(input, [], "local", maxChars);
  }

  private async buildLocal(
    input: ContextEngineBuildInput,
    warnings: string[],
    modeUsed: ContextEngineMode,
    maxChars: number
  ): Promise<ContextEngineResult> {
    const inventory = await this.metadata.getInventory();
    const scopedInventory = this.scopeInventoryForProject(inventory, input.projectScopeId);
    const plan = await this.planner.plan({
      userMessage: input.userMessage,
      mode: "local",
      inventory: scopedInventory
    });
    const [summarySections, evidence, candidateSections, llmWikiSections, currentNoteSections, urlSections, webSearchSections, projectSections, projectDocumentSections, knowledgeSections, coreSections] = await Promise.all([
      this.summaries.getSections({ mode: "local", date: input.date, inventory: scopedInventory }),
      this.localRetrieval.search(plan, scopedInventory),
      this.candidates.buildSections({ userMessage: input.userMessage, inventory: scopedInventory }),
      this.llmWikiSections(),
      this.currentNoteSections(scopedInventory),
      this.urlSections(input.userMessage, input.fetchUrl),
      this.webSearchSections(input.userMessage, input.searchWeb),
      this.projectTaskSections(inventory, input.projectScopeId),
      this.projectDocumentSections(inventory, input.projectScopeId, input.userMessage),
      this.knowledgeCoverageSections(scopedInventory, input.userMessage),
      this.coreContextSections(scopedInventory, input.date)
    ]);

    return this.composer.compose({
      userMessage: input.userMessage,
      modeUsed,
      maxChars,
      sections: [
        ...currentNoteSections,
        ...urlSections,
        ...webSearchSections,
        ...projectSections,
        ...projectDocumentSections,
        ...knowledgeSections,
        ...candidateSections,
        ...coreSections,
        ...summarySections,
        ...this.evidenceSections(evidence, 45, "本地检索证据"),
        ...llmWikiSections
      ],
      warnings
    });
  }

  private async buildGraph(input: ContextEngineBuildInput, maxChars: number): Promise<ContextEngineResult> {
    const inventory = await this.metadata.getInventory();
    const scopedInventory = this.scopeInventoryForProject(inventory, input.projectScopeId);
    const plan = await this.planner.plan({
      userMessage: input.userMessage,
      mode: "graph",
      inventory: scopedInventory
    });
    const [projectSections, projectDocumentSections, knowledgeSections, graphSections, candidateSections, summarySections, evidence] = await Promise.all([
      this.projectTaskSections(inventory, input.projectScopeId),
      this.projectDocumentSections(inventory, input.projectScopeId, input.userMessage),
      this.knowledgeCoverageSections(scopedInventory, input.userMessage),
      this.graphContext.build({ userMessage: input.userMessage, date: input.date, inventory: scopedInventory }),
      this.candidates.buildSections({ userMessage: input.userMessage, inventory: scopedInventory, limit: 8 }),
      this.summaries.getSections({ mode: "graph", date: input.date, inventory: scopedInventory }),
      this.localRetrieval.search(plan, scopedInventory)
    ]);

    return this.composer.compose({
      userMessage: input.userMessage,
      modeUsed: "graph",
      maxChars,
      sections: [
        ...projectSections,
        ...projectDocumentSections,
        ...knowledgeSections,
        ...graphSections,
        ...candidateSections,
        ...summarySections,
        ...this.evidenceSections(evidence, 38, "本地原始证据")
      ],
      warnings: []
    });
  }

  private scopeInventoryForProject(
    inventory: ContextInventoryItem[],
    projectScopeId?: string
  ): ContextInventoryItem[] {
    if (!projectScopeId) return inventory;
    const projectsRoot = this.normalizePath(`${this.rootFolder}/Projects/`);
    const selectedProjectRoot = this.normalizePath(`${this.rootFolder}/Projects/${projectScopeId}/`);
    const projectsIndex = this.normalizePath(`${this.rootFolder}/Projects/index.md`);
    const openTasks = this.normalizePath(`${this.rootFolder}/Tasks/open.md`);
    const doneTasks = this.normalizePath(`${this.rootFolder}/Tasks/done.md`);

    return inventory.filter((item) => {
      const path = this.normalizePath(item.path);
      if (path === openTasks || path === doneTasks) return false;
      if (path === projectsIndex) return true;
      if (path.startsWith(projectsRoot)) return path.startsWith(selectedProjectRoot);
      return true;
    });
  }

  private normalizePath(path: string): string {
    return path.replace(/\\/g, "/");
  }

  private async llmWikiSections(): Promise<ContextSection[]> {
    return new LlmWikiContextService(this.app, this.settings).buildContextEngineSections();
  }

  private async projectTaskSections(inventory: ContextInventoryItem[], projectScopeId?: string): Promise<ContextSection[]> {
    const projectsItem = inventory.find((item) => item.path === `${this.rootFolder}/Projects/index.md`);
    const openItem = inventory.find((item) => item.path === `${this.rootFolder}/Tasks/open.md`);
    const doneItem = inventory.find((item) => item.path === `${this.rootFolder}/Tasks/done.md`);
    if (!projectsItem && !openItem && !doneItem) return [];

    const [projectsMarkdown, openMarkdown, doneMarkdown] = await Promise.all([
      this.readInventoryContent(projectsItem),
      this.readInventoryContent(openItem),
      this.readInventoryContent(doneItem)
    ]);
    const projects = parseProjectIndex(projectsMarkdown);
    const openTasks = this.parseTaskMarkdown(openMarkdown, "open");
    const doneTasks = this.parseTaskMarkdown(doneMarkdown, "done");
    if (projects.length === 0 && openTasks.length === 0 && doneTasks.length === 0) return [];

    const overview = buildProjectOverview(projects, openTasks, doneTasks);
    const content = formatProjectOverviewForAi(overview, { projectScopeId });
    const sourcePath = projectsItem?.path ?? openItem?.path ?? doneItem?.path ?? `${this.rootFolder}/Projects/index.md`;

    return [{
      title: "项目任务概览",
      content,
      priority: 84,
      source: sourcePath,
      sourceInfo: {
        path: sourcePath,
        title: "项目任务概览",
        type: "project",
        excerpt: content.slice(0, 240)
      }
    }];
  }

  private async projectDocumentSections(inventory: ContextInventoryItem[], projectScopeId?: string, userMessage = ""): Promise<ContextSection[]> {
    if (!projectScopeId) return [];
    const projectsItem = inventory.find((item) => item.path === `${this.rootFolder}/Projects/index.md`);
    const projects = parseProjectIndex(await this.readInventoryContent(projectsItem));
    const projectName = projects.find((project) => project.id === projectScopeId)?.name ?? projectScopeId;
    const documentsRoot = `${this.rootFolder}/Projects/${projectScopeId}/Documents/`;
    const keywords = this.knowledgeKeywords(userMessage);
    const items = inventory
      .filter((item) => item.path.startsWith(documentsRoot) && item.path.toLowerCase().endsWith(".md"))
      .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
      .slice(0, PROJECT_DOCUMENT_SCAN_LIMIT);
    const ranked: Array<{ item: ContextInventoryItem; content: string; score: number }> = [];

    for (const item of items) {
      const markdown = await this.readInventoryContent(item);
      const content = this.cleanProjectDocumentContext(markdown, PROJECT_DOCUMENT_EXCERPT_CHARS, keywords);
      if (!content) continue;
      ranked.push({
        item,
        content,
        score: this.projectDocumentScore(item, markdown, keywords)
      });
    }

    ranked.sort((a, b) => b.score - a.score || b.item.mtime - a.item.mtime || a.item.path.localeCompare(b.item.path));
    const sections: ContextSection[] = [];

    for (const { item, content } of ranked.slice(0, PROJECT_DOCUMENT_SECTION_LIMIT)) {
      const title = `项目文档：${projectName}`;
      const sectionContent = [`# ${title}`, `项目ID：${projectScopeId}`, `路径：${item.path}`, "", content].join("\n");
      sections.push({
        title: `${title} / ${item.title}`,
        content: sectionContent,
        priority: 86,
        source: item.path,
        sourceInfo: {
          path: item.path,
          title: item.title,
          type: "project",
          excerpt: content.slice(0, 240)
        }
      });
    }

    return sections;
  }

  private async readInventoryContent(item?: ContextInventoryItem): Promise<string> {
    if (!item) return "";
    try {
      return await this.metadata.readFile(item.path);
    } catch {
      return "";
    }
  }

  private parseTaskMarkdown(markdown: string, source: "open" | "done"): LifeOSTask[] {
    return markdown
      .split(/\r?\n/)
      .map((line) => parseTaskLine(line, source))
      .filter((task): task is LifeOSTask => task !== null);
  }

  private cleanProjectDocumentContext(markdown: string, maxChars: number, keywords: string[]): string {
    return this.relevantMarkdownPassages(markdown, keywords, maxChars);
  }

  private projectDocumentScore(item: ContextInventoryItem, markdown: string, keywords: string[]): number {
    if (keywords.length === 0) return 1;
    const haystack = [
      item.path,
      item.title,
      ...item.tags,
      ...item.headings,
      ...item.links,
      ...item.backlinks
    ].join(" ").toLowerCase();
    let score = 0;
    for (const keyword of keywords) {
      const normalized = keyword.toLowerCase();
      if (!normalized) continue;
      if (haystack.includes(normalized)) score += 8 + normalized.length;
    }
    score += this.bestBlockScore(markdown, keywords);
    return score;
  }

  private relevantMarkdownPassages(markdown: string, keywords: string[], maxChars: number): string {
    const clean = markdown
      .replace(/^---\r?\n[\s\S]*?\r?\n---\s*/m, "")
      .replace(/\r\n/g, "\n")
      .trim();
    if (!clean) return "";
    const meaningfulKeywords = this.meaningfulExcerptKeywords(keywords);
    if (meaningfulKeywords.length === 0 || clean.length <= maxChars) return clean.slice(0, maxChars);

    const blocks = clean.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
    const scored = blocks
      .map((block, index) => ({ block, index, score: this.blockKeywordScore(block, meaningfulKeywords) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);
    if (scored.length === 0) return clean.slice(0, maxChars);

    const selected = scored.slice(0, 4).sort((a, b) => a.index - b.index);
    const parts: string[] = [];
    let remaining = maxChars;
    for (const entry of selected) {
      if (remaining <= 0) break;
      const excerpt = this.excerptBlockAroundKeywords(entry.block, meaningfulKeywords, Math.min(remaining, 700));
      if (!excerpt) continue;
      const addition = parts.length > 0 ? `\n\n---\n\n${excerpt}` : excerpt;
      if (addition.length > remaining) {
        parts.push(addition.slice(0, remaining).trim());
        break;
      }
      parts.push(addition);
      remaining -= addition.length;
    }
    return parts.join("").trim();
  }

  private bestBlockScore(markdown: string, keywords: string[]): number {
    const meaningfulKeywords = this.meaningfulExcerptKeywords(keywords);
    if (meaningfulKeywords.length === 0) return 0;
    const clean = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/m, "").replace(/\r\n/g, "\n").trim();
    return clean
      .split(/\n{2,}/)
      .map((block) => this.blockKeywordScore(block, meaningfulKeywords))
      .reduce((max, score) => Math.max(max, score), 0);
  }

  private blockKeywordScore(block: string, keywords: string[]): number {
    const lower = block.toLowerCase();
    let score = 0;
    for (const keyword of keywords) {
      const normalized = keyword.toLowerCase();
      if (!normalized) continue;
      if (lower.includes(normalized)) score += 12 + Math.min(normalized.length, 16);
    }
    return score;
  }

  private excerptBlockAroundKeywords(block: string, keywords: string[], maxChars: number): string {
    if (block.length <= maxChars) return block;
    const lower = block.toLowerCase();
    const matchIndex = keywords
      .map((keyword) => lower.indexOf(keyword.toLowerCase()))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, matchIndex - 220);
    const excerpt = block.slice(start, start + maxChars).trim();
    return start > 0 ? `...${excerpt}` : excerpt;
  }

  private meaningfulExcerptKeywords(keywords: string[]): string[] {
    const generic = new Set(["life", "os", "project", "projects", "文档", "项目", "分析", "回答", "根据"]);
    return Array.from(new Set(
      keywords
        .map((keyword) => keyword.trim())
        .filter((keyword) => keyword.length >= 2)
        .filter((keyword) => !generic.has(keyword.toLowerCase()))
    )).slice(0, 16);
  }

  private async knowledgeCoverageSections(inventory: ContextInventoryItem[], userMessage: string): Promise<ContextSection[]> {
    if (!this.hasKnowledgeIntent(userMessage)) return [];
    const items = inventory
      .filter((item) => this.isKnowledgeContextItem(item))
      .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    if (items.length === 0) return [];

    const rootPath = `${this.rootFolder}/Knowledge`;
    const broad = this.hasBroadKnowledgeIntent(userMessage);
    const keywords = this.knowledgeKeywords(userMessage);
    const catalogLines = items.slice(0, KNOWLEDGE_CATALOG_LIMIT).map((item) => {
      const meta = [
        item.tags.length > 0 ? `tags=${item.tags.slice(0, 4).join(",")}` : "",
        item.headings.length > 0 ? `headings=${item.headings.slice(0, 3).join(" / ")}` : ""
      ].filter(Boolean).join("；");
      return `- ${item.title} -> ${item.path}${meta ? ` -> ${meta}` : ""}`;
    });
    if (items.length > KNOWLEDGE_CATALOG_LIMIT) {
      catalogLines.push(`- 还有 ${items.length - KNOWLEDGE_CATALOG_LIMIT} 条知识文件未列入索引。`);
    }

    const sections: ContextSection[] = [{
      title: "知识库覆盖索引",
      content: [
        `共发现 ${items.length} 条知识库 Markdown。这个索引用来避免只看最近知识；正文是否完整读取请以“知识库相关摘录/知识库广域摘录”为准。`,
        ...catalogLines
      ].join("\n"),
      priority: 62,
      source: rootPath,
      sourceInfo: {
        path: rootPath,
        title: "知识库覆盖索引",
        type: "knowledge",
        excerpt: catalogLines.slice(0, 3).join("\n").slice(0, 240)
      }
    }];

    const excerptSection = await this.knowledgeExcerptSection(items, keywords, broad, rootPath);
    if (excerptSection) sections.push(excerptSection);
    return sections;
  }

  private async knowledgeExcerptSection(
    items: ContextInventoryItem[],
    keywords: string[],
    broad: boolean,
    rootPath: string
  ): Promise<ContextSection | null> {
    const scored: Array<{ item: ContextInventoryItem; markdown: string; score: number }> = [];
    for (const item of items.slice(0, KNOWLEDGE_SCAN_LIMIT)) {
      const markdown = await this.readInventoryContent(item);
      if (!markdown.trim()) continue;
      const score = this.knowledgeItemScore(item, markdown, keywords, broad);
      if (score <= 0) continue;
      scored.push({ item, markdown, score });
    }

    scored.sort((a, b) => b.score - a.score || b.item.mtime - a.item.mtime || a.item.path.localeCompare(b.item.path));
    const limit = broad ? KNOWLEDGE_BROAD_EXCERPT_LIMIT : KNOWLEDGE_RELEVANT_EXCERPT_LIMIT;
    const parts: string[] = [];
    for (const { item, markdown } of scored.slice(0, limit)) {
      const excerpt = this.excerptAroundKeywords(markdown, keywords, KNOWLEDGE_EXCERPT_CHARS);
      if (!excerpt) continue;
      parts.push(`### ${item.title}\n来源：${item.path}\n${excerpt}`);
    }
    if (parts.length === 0) return null;

    const content = [
      broad
        ? "用户要求查看知识库全部/全量信息，因此这里会跨越最近排序限制扫描知识库正文，并优先列出与问题命中的内容。"
        : "这里列出与当前问题命中的知识库正文摘录。",
      ...parts
    ].join("\n\n");

    return {
      title: broad ? "知识库广域摘录" : "知识库相关摘录",
      content,
      priority: 61,
      source: rootPath,
      sourceInfo: {
        path: rootPath,
        title: broad ? "知识库广域摘录" : "知识库相关摘录",
        type: "knowledge",
        excerpt: content.slice(0, 240)
      }
    };
  }

  private isKnowledgeContextItem(item: ContextInventoryItem): boolean {
    const lower = item.path.toLowerCase();
    if (!lower.endsWith(".md")) return false;
    if (!lower.includes("/knowledge/")) return false;
    if (lower.endsWith("/knowledge/index.md")) return false;
    if (lower.includes("/knowledge/llmwiki/trash/")) return false;
    return true;
  }

  private hasKnowledgeIntent(message: string): boolean {
    return /知识库|资料|笔记|长文档|LLM\s*Wiki|wiki|全部信息|全部内容|全量|所有知识|所有资料/i.test(message);
  }

  private hasBroadKnowledgeIntent(message: string): boolean {
    return /(知识库|资料|笔记|长文档|wiki|LLM\s*Wiki).{0,12}(全部|所有|全量|完整|整体|总览|盘点)|(?:全部|所有|全量|完整|整体|总览|盘点).{0,12}(知识库|资料|笔记|长文档|wiki|LLM\s*Wiki)/i.test(message);
  }

  private knowledgeKeywords(message: string): string[] {
    const generic = new Set([
      "请", "根据", "回答", "什么", "是什么", "知识库", "全部", "所有", "全量", "完整", "整体", "信息", "内容",
      "资料", "笔记", "长文档", "wiki", "llm", "the", "and", "with", "from"
    ]);
    const tokens = Array.from(message.matchAll(/[\p{L}\p{N}_-]+/gu), (match) => match[0].trim())
      .filter((token) => token.length >= 2)
      .filter((token) => !generic.has(token.toLowerCase()));
    return Array.from(new Set(tokens)).slice(0, 16);
  }
  private knowledgeItemScore(item: ContextInventoryItem, markdown: string, keywords: string[], broad: boolean): number {
    const haystack = [
      item.path,
      item.title,
      ...item.tags,
      ...item.headings,
      ...item.links,
      ...item.backlinks
    ].join(" ").toLowerCase();
    let score = broad ? 1 : 0;
    for (const keyword of keywords) {
      const normalized = keyword.toLowerCase();
      if (!normalized) continue;
      if (haystack.includes(normalized)) score += 18;
    }

    const body = markdown.toLowerCase();
    for (const keyword of keywords) {
      const normalized = keyword.toLowerCase();
      if (!normalized) continue;
      if (body.includes(normalized)) score += Math.min(48, 12 + normalized.length);
    }
    return score;
  }

  private excerptAroundKeywords(markdown: string, keywords: string[], maxChars: number): string {
    const clean = this.cleanExcerpt(markdown, Math.max(maxChars * 2, maxChars));
    if (!clean) return "";
    const lower = clean.toLowerCase();
    const matchIndex = keywords
      .map((keyword) => lower.indexOf(keyword.toLowerCase()))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, matchIndex - 220);
    const excerpt = clean.slice(start, start + maxChars).trim();
    return start > 0 ? `...${excerpt}` : excerpt;
  }

  private async currentNoteSections(inventory: Array<{ path: string }>): Promise<ContextSection[]> {
    const file = this.activeMarkdownFile();
    if (!file) return [];
    if (!this.policy.isAllowedPath(file.path)) return [];
    let content = "";
    try {
      content = String(await (this.app as unknown as { vault: { read: (file: unknown) => Promise<string> } }).vault.read(file));
    } catch {
      return [];
    }
    const clean = this.cleanExcerpt(content, CURRENT_NOTE_CHARS);
    if (!clean || !this.policy.isAllowedFrontmatter(parseFrontmatterLocal(content))) return [];
    const linkedContext = await this.currentNoteLinkedContext(file.path);
    const title = file.basename ?? file.name ?? file.path;

    return [{
      title: `Current note: ${title}`,
      content: [clean, linkedContext].filter(Boolean).join("\n\n"),
      priority: 75,
      source: file.path,
      sourceInfo: {
        path: file.path,
        title,
        type: "current-note",
        excerpt: clean.slice(0, 240)
      }
    }];
  }

  private async urlSections(userMessage: string, fetchUrl?: (url: string) => Promise<string>): Promise<ContextSection[]> {
    const urls = extractWebUrls(userMessage).slice(0, 3);
    if (urls.length === 0 || !fetchUrl) return [];

    const sections: ContextSection[] = [];
    for (const url of urls) {
      try {
        const content = this.cleanExcerpt(await fetchUrl(url), URL_CONTEXT_CHARS);
        sections.push({
          title: `URL Context: ${url}`,
          content: content || "URL returned no readable text.",
          priority: 70,
          source: url,
          sourceInfo: {
            path: url,
            title: url,
            type: "url",
            excerpt: (content || "URL returned no readable text.").slice(0, 240)
          }
        });
      } catch {
        sections.push({
          title: `URL Context: ${url}`,
          content: "Unable to read this URL; continuing without its body.",
          priority: 30,
          source: url,
          sourceInfo: {
            path: url,
            title: url,
            type: "url",
            excerpt: "Unable to read this URL; continuing without its body."
          }
        });
      }
    }

    return sections;
  }

  private async webSearchSections(userMessage: string, searchWeb?: (query: string) => Promise<string>): Promise<ContextSection[]> {
    const query = getWebSearchQuery(userMessage);
    if (!query || !searchWeb) return [];

    try {
      const content = this.cleanExcerpt(await searchWeb(query), WEB_SEARCH_CONTEXT_CHARS);
      return [{
        title: `Web Search: ${query}`,
        content: content || "Web search returned no readable results.",
        priority: 69,
        source: query,
        sourceInfo: {
          path: `web-search:${query}`,
          title: query,
          type: "url",
          excerpt: (content || "Web search returned no readable results.").slice(0, 240)
        }
      }];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [{
        title: `Web Search: ${query}`,
        content: `Unable to search the web for this query: ${message}`,
        priority: 25,
        source: query,
        sourceInfo: {
          path: `web-search:${query}`,
          title: query,
          type: "url",
          excerpt: `Unable to search the web for this query: ${message}`.slice(0, 240)
        }
      }];
    }
  }

  private async coreContextSections(inventory: ContextInventoryItem[], date?: string): Promise<ContextSection[]> {
    const sections: ContextSection[] = [];
    const openTasks = inventory.find((item) => item.path === `${this.rootFolder}/Tasks/open.md`);
    if (openTasks) {
      const section = await this.sectionFromInventoryItem(openTasks, "未完成待办", 82);
      if (section) sections.push(section);
    }

    const coreMemoryPaths = ["profile.md", "current-projects.md"].map((name) => `${this.rootFolder}/Memory/Core/${name}`);
    for (const [index, path] of coreMemoryPaths.entries()) {
      const item = inventory.find((candidate) => candidate.path === path);
      if (!item) continue;
      const section = await this.sectionFromInventoryItem(item, `Core memory: ${item.title}`, 78 - index);
      if (section) sections.push(section);
    }

    const checkin = date ? inventory.find((item) => item.path === `${this.rootFolder}/Exam/Checkins/${date}.md`) : undefined;
    if (checkin) {
      const section = await this.sectionFromInventoryItem(checkin, "Exam checkin", 54);
      if (section) sections.push(section);
    }

    const knowledge = inventory
      .filter((item) => item.path.toLowerCase().includes("/knowledge/") && !item.path.toLowerCase().includes("/knowledge/llmwiki/raw/"))
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (knowledge) {
      const section = await this.sectionFromInventoryItem(knowledge, `Knowledge: ${knowledge.title}`, 44);
      if (section) sections.push(section);
    }

    return sections;
  }

  private async sectionFromInventoryItem(item: ContextInventoryItem, title: string, priority: number): Promise<ContextSection | null> {
    const content = await this.metadata.readFile(item.path);
    if (!content.trim()) return null;
    return {
      title,
      content: content.slice(0, 2000),
      priority,
      source: item.path,
      sourceInfo: {
        path: item.path,
        title: item.title,
        type: this.sourceType(item.path),
        excerpt: content.slice(0, 240)
      }
    };
  }

  private evidenceSections(evidence: ContextEvidence[], priority: number, titlePrefix: string): ContextSection[] {
    return evidence.map((item, index) => ({
      title: `${titlePrefix} ${index + 1}: ${item.source.title}`,
      content: item.content,
      priority: priority + Math.max(0, 8 - index),
      source: item.source.path,
      sourceInfo: item.source
    }));
  }

  private resolveMode(input: ContextEngineBuildInput): ContextEngineMode {
    if (input.mode) return input.mode;
    return chatModeToEngineMode(input.chatMode);
  }

  private cleanExcerpt(content: string, maxChars: number): string {
    const clean = content
      .replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "")
      .trim();
    return clean.length > maxChars ? `${clean.slice(0, maxChars).trim()}...` : clean;
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

  private activeMarkdownFile(): { path: string; name?: string; basename?: string } | null {
    const file = (this.app as unknown as { workspace?: { getActiveFile?: () => unknown } }).workspace?.getActiveFile?.();
    if (!file || typeof file !== "object") return null;
    const candidate = file as { path?: unknown; name?: unknown; basename?: unknown };
    const path = typeof candidate.path === "string" ? candidate.path : "";
    const name = typeof candidate.name === "string" ? candidate.name : path.split("/").pop() ?? "";
    if (!path || !name.toLowerCase().endsWith(".md")) return null;
    return Object.assign(file as object, {
      path,
      name,
      basename: typeof candidate.basename === "string" ? candidate.basename : name.replace(/\.md$/i, "")
    }) as { path: string; name?: string; basename?: string };
  }

  private async currentNoteLinkedContext(sourcePath: string): Promise<string> {
    const links = (this.app as unknown as { metadataCache?: { resolvedLinks?: Record<string, Record<string, number>> } }).metadataCache?.resolvedLinks ?? {};
    const linkedPaths = new Set<string>();
    for (const path of Object.keys(links[sourcePath] ?? {})) linkedPaths.add(path);
    for (const [path, destinations] of Object.entries(links)) {
      if (Number(destinations[sourcePath] ?? 0) > 0) linkedPaths.add(path);
    }

    const parts: string[] = [];
    for (const path of Array.from(linkedPaths).slice(0, 4)) {
      if (!this.policy.isAllowedPath(path)) continue;
      const file = (this.app as unknown as { vault?: { getAbstractFileByPath?: (path: string) => unknown; read?: (file: unknown) => Promise<string> } }).vault?.getAbstractFileByPath?.(path);
      if (!file || typeof file !== "object") continue;
      try {
        const markdown = String(await (this.app as unknown as { vault: { read: (file: unknown) => Promise<string> } }).vault.read(file));
        if (!this.policy.isAllowedFrontmatter(parseFrontmatterLocal(markdown))) continue;
        const excerpt = this.cleanExcerpt(markdown, 450);
        if (excerpt) parts.push(`### ${path}\n${excerpt}`);
      } catch {
        // Ignore individual linked-note read failures so current-note context can still be used.
      }
    }

    return parts.length > 0 ? `Linked note context\n${parts.join("\n\n")}` : "";
  }
}

export function chatModeToEngineMode(chatMode: ChatContextMode | undefined): ContextEngineMode {
  if (chatMode === "semantic") return "vector";
  if (chatMode === "global") return "graph";
  return "local";
}

function extractUrls(message: string): string[] {
  return Array.from(new Set(message.match(/https?:\/\/[^\s\]\)"'<>]+/g) ?? []));
}

function parseFrontmatterLocal(markdown: string): Record<string, unknown> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};

  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const keyValue = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!keyValue) continue;
    frontmatter[keyValue[1]] = keyValue[2].trim();
  }
  return frontmatter;
}

export * from "./context-engine/types";
export { AiRetrievalPlanner } from "./context-engine/AiRetrievalPlanner";
export { ContextComposer } from "./context-engine/ContextComposer";
export { ContextCandidateService } from "./context-engine/ContextCandidateService";
export { ContextSourcePolicyService } from "./context-engine/ContextSourcePolicyService";
export { GraphContextService } from "./context-engine/GraphContextService";
export { LocalRetrievalService } from "./context-engine/LocalRetrievalService";
export { ObsidianMetadataService } from "./context-engine/ObsidianMetadataService";
export { SummaryIndexService } from "./context-engine/SummaryIndexService";
export { VectorRetrievalService } from "./context-engine/VectorRetrievalService";
