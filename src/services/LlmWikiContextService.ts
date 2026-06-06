import type { App } from "obsidian";
import { localizeLifeOsPathParts, normalizeDirectoryLanguage, type PersonalLifeSystemSettings } from "../settings";
import type { ContextSection } from "./context-engine/types";

export interface LlmWikiContextSection {
  title: string;
  content: string;
  priority: number;
  source: string;
}

type FileLike = {
  path: string;
  name: string;
  basename: string;
  extension?: string;
  stat?: { mtime: number };
};

interface LlmWikiFileContext {
  file: FileLike;
  content: string;
  draft: boolean;
}

const FORMAL_WIKI_DIRS = ["Concepts", "Entities", "Questions", "Syntheses", "Sources", "Contradictions"];
const FORMAL_FILE_LIMIT = 12;
const DRAFT_FILE_LIMIT = 5;
const FORMAL_EXCERPT_CHARS = 900;
const DRAFT_EXCERPT_CHARS = 700;

export class LlmWikiContextService {
  constructor(private app: App, private settings: Partial<PersonalLifeSystemSettings>) {}

  async buildContextSections(): Promise<LlmWikiContextSection[]> {
    if (this.settings.enableLlmWiki === false) return [];

    const files = this.markdownFiles();
    if (files.length === 0) return [];

    const sections: LlmWikiContextSection[] = [];
    const formalContent = await this.buildFormalContent(files);
    if (formalContent) {
      sections.push({
        title: "LLM Wiki 正式知识",
        content: formalContent,
        priority: 48,
        source: this.path("Wiki")
      });
    }

    if (this.settings.llmWikiIncludeDraftsInChat !== false) {
      const draftContent = await this.buildDraftContent(files);
      if (draftContent) {
        sections.push({
          title: "LLM Wiki 最近 Draft",
          content: draftContent,
          priority: 43,
          source: this.path("Wiki", "Drafts")
        });
      }
    }

    return sections;
  }

  async buildContextEngineSections(): Promise<ContextSection[]> {
    if (this.settings.enableLlmWiki === false) return [];

    const files = this.markdownFiles();
    if (files.length === 0) return [];

    const contexts = [
      ...await this.buildFormalFileContexts(files),
      ...(this.settings.llmWikiIncludeDraftsInChat === false ? [] : await this.buildDraftFileContexts(files))
    ];

    return contexts.map((context) => ({
      title: context.draft ? `LLM Wiki draft: ${context.file.basename}` : `LLM Wiki formal: ${context.file.basename}`,
      content: context.content,
      priority: context.draft ? 43 : 48,
      source: context.file.path,
      sourceInfo: {
        path: context.file.path,
        title: context.file.basename,
        type: "llm-wiki",
        excerpt: context.content.slice(0, 240)
      }
    }));
  }

  private async buildFormalContent(files: FileLike[]): Promise<string> {
    const candidates = FORMAL_WIKI_DIRS
      .flatMap((dir) => this.filesUnder(files, this.path("Wiki", dir)))
      .sort(byRecent);
    return this.readFilesAsContext(candidates, FORMAL_EXCERPT_CHARS, false, FORMAL_FILE_LIMIT);
  }

  private async buildDraftContent(files: FileLike[]): Promise<string> {
    const drafts = this.filesUnder(files, this.path("Wiki", "Drafts"))
      .sort(byRecent);
    return this.readFilesAsContext(drafts, DRAFT_EXCERPT_CHARS, true, DRAFT_FILE_LIMIT);
  }

  private async buildFormalFileContexts(files: FileLike[]): Promise<LlmWikiFileContext[]> {
    const candidates = FORMAL_WIKI_DIRS
      .flatMap((dir) => this.filesUnder(files, this.path("Wiki", dir)))
      .sort(byRecent);
    return this.readFilesAsContexts(candidates, FORMAL_EXCERPT_CHARS, false, FORMAL_FILE_LIMIT);
  }

  private async buildDraftFileContexts(files: FileLike[]): Promise<LlmWikiFileContext[]> {
    const drafts = this.filesUnder(files, this.path("Wiki", "Drafts"))
      .sort(byRecent);
    return this.readFilesAsContexts(drafts, DRAFT_EXCERPT_CHARS, true, DRAFT_FILE_LIMIT);
  }

  private async readFilesAsContext(files: FileLike[], maxChars: number, draft: boolean, limit: number): Promise<string> {
    const parts: string[] = [];
    for (const file of files) {
      let raw = "";
      try {
        raw = await this.readFile(file);
      } catch {
        continue;
      }
      const excerpt = cleanExcerpt(raw, maxChars);
      if (!excerpt) continue;

      const title = draft ? `### 草稿：${file.basename}` : `### ${file.basename}`;
      parts.push(`${title}\n来源：${file.path}\n${excerpt}`);
      if (parts.length >= limit) break;
    }
    return parts.join("\n\n");
  }

  private async readFilesAsContexts(files: FileLike[], maxChars: number, draft: boolean, limit: number): Promise<LlmWikiFileContext[]> {
    const contexts: LlmWikiFileContext[] = [];
    for (const file of files) {
      let raw = "";
      try {
        raw = await this.readFile(file);
      } catch {
        continue;
      }
      const excerpt = cleanExcerpt(raw, maxChars);
      if (!excerpt) continue;

      contexts.push({ file, content: excerpt, draft });
      if (contexts.length >= limit) break;
    }
    return contexts;
  }

  private filesUnder(files: FileLike[], prefix: string): FileLike[] {
    const clean = `${normalizePathLocal(prefix)}/`;
    return files.filter((file) => normalizePathLocal(file.path).startsWith(clean));
  }

  private markdownFiles(): FileLike[] {
    const files = (this.app as unknown as { vault?: { getMarkdownFiles?: () => unknown[] } }).vault?.getMarkdownFiles?.() ?? [];
    return files.filter(isMarkdownFile);
  }

  private async readFile(file: FileLike): Promise<string> {
    return String(await (this.app as unknown as { vault: { read: (file: FileLike) => Promise<string> } }).vault.read(file));
  }

  private path(...parts: string[]): string {
    const localized = localizeLifeOsPathParts(["Knowledge", "LLMWiki", ...parts], normalizeDirectoryLanguage(this.settings.directoryLanguage));
    return joinPathLocal(this.settings.rootFolder || "PersonalLifeSystem", ...localized);
  }
}

function isMarkdownFile(value: unknown): value is FileLike {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<FileLike>;
  return typeof file.path === "string" && typeof file.name === "string" && file.name.toLowerCase().endsWith(".md");
}

function cleanExcerpt(content: string, maxChars: number): string {
  const clean = content
    .replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("![[") && !line.startsWith("![]("))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars).trim()}...` : clean;
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
