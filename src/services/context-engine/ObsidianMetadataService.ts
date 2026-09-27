import type { App, TFile } from "obsidian";
import { ContextSourcePolicyService, prepareCitableMarkdown, type CitableMarkdown } from "./ContextSourcePolicyService";
import type { ContextInventoryItem, ContextSection, ContextSource } from "./types";

type FileLike = TFile & {
  path: string;
  name?: string;
  basename?: string;
  extension?: string;
  stat?: { mtime?: number };
};

interface CacheTag {
  tag?: string;
}

interface CacheHeading {
  heading?: string;
}

interface CacheLink {
  link?: string;
}

interface FileCacheLike {
  frontmatter?: Record<string, unknown>;
  tags?: CacheTag[];
  headings?: CacheHeading[];
  links?: CacheLink[];
}

interface MetadataCacheLike {
  getFileCache?: (file: FileLike) => FileCacheLike | null | undefined;
  resolvedLinks?: Record<string, Record<string, number>>;
}

interface AppLike {
  vault: {
    getMarkdownFiles?: () => FileLike[];
    getAbstractFileByPath?: (path: string) => FileLike | null;
    read: (file: FileLike) => Promise<string>;
  };
  workspace?: {
    getActiveFile?: () => FileLike | null;
  };
  metadataCache?: MetadataCacheLike;
}

interface ParsedMarkdownMetadata {
  frontmatter: Record<string, unknown>;
  tags: string[];
  headings: string[];
  links: string[];
}

interface CachedMarkdownDocument {
  mtime: number;
  markdown: string;
  metadata: ParsedMarkdownMetadata;
}

const DOCUMENT_CACHE = new WeakMap<object, Map<string, CachedMarkdownDocument>>();

export class ObsidianMetadataService {
  private readonly app: AppLike;
  private readonly policy: ContextSourcePolicyService;
  private readonly documentCache: Map<string, CachedMarkdownDocument>;
  private readonly evidenceDecisions = new Map<string, CitableMarkdown>();

  constructor(app: App, private readonly rootFolder: string, policy = new ContextSourcePolicyService(rootFolder)) {
    this.app = app as unknown as AppLike;
    this.policy = policy;
    const appKey = app as unknown as object;
    const cached = DOCUMENT_CACHE.get(appKey);
    if (cached) {
      this.documentCache = cached;
    } else {
      this.documentCache = new Map<string, CachedMarkdownDocument>();
      DOCUMENT_CACHE.set(appKey, this.documentCache);
    }
  }

  async getInventory(): Promise<ContextInventoryItem[]> {
    const files = this.app.vault.getMarkdownFiles?.() ?? [];
    const inventory: ContextInventoryItem[] = [];

    for (const file of files) {
      if (!this.policy.isAllowedPath(file.path)) continue;

      const parsed = await this.metadataForFile(file);
      if (!parsed) continue;
      if (!this.policy.isAllowedFrontmatter(parsed.frontmatter) && !await this.readCitableSource(file.path)) continue;

      inventory.push({
        path: file.path,
        title: this.titleForFile(file, parsed.headings),
        tags: parsed.tags,
        headings: parsed.headings,
        links: parsed.links,
        backlinks: this.findBacklinks(file.path),
        frontmatter: parsed.frontmatter,
        mtime: file.stat?.mtime ?? 0
      });
    }

    return inventory;
  }

  async readFile(path: string): Promise<string> {
    if (!this.policy.isAllowedPath(path)) return "";
    const file = this.app.vault.getAbstractFileByPath?.(path);
    if (!file || !this.policy.isAllowedPath(file.path)) return "";

    try {
      const mtime = file.stat?.mtime ?? 0;
      const cached = this.documentCache.get(file.path);
      if (cached && cached.mtime === mtime) {
        return this.citableText(file.path, cached.markdown);
      }
      const markdown = await this.app.vault.read(file);
      const parsed = this.parseMarkdown(markdown);
      this.documentCache.set(file.path, { mtime, markdown, metadata: parsed });
      return this.citableText(file.path, markdown);
    } catch {
      return "";
    }
  }

  private citableText(path: string, markdown: string): string {
    const decision = prepareCitableMarkdown(path, markdown, { rootFolder: this.rootFolder });
    this.evidenceDecisions.set(path, decision);
    return decision.allowed ? decision.markdown : "";
  }

  /** Revalidate provider/local paths against the actual Vault, never provider metadata. */
  async readCitableSource(path: string): Promise<CitableMarkdown | null> {
    const markdown = await this.readFile(path);
    if (!markdown.trim()) return null;
    return this.evidenceDecisions.get(path) ?? null;
  }

  decorateSource(source: ContextSource): ContextSource {
    return { ...source, evidenceOrigin: this.evidenceDecisions.get(source.path)?.origin ?? "note" };
  }

  /** Call after readFile: graph/index metadata must not quote headings/tags inside masked chat blocks. */
  citableInventoryItem(item: ContextInventoryItem): ContextInventoryItem {
    const decision = this.evidenceDecisions.get(item.path);
    if (!decision?.allowed) return item;
    const parsed = this.parseMarkdown(decision.markdown);
    return { ...item, ...parsed, title: parsed.headings[0] ?? item.path.split("/").pop()!.replace(/\.md$/iu, ""),
      links: parsed.links.filter(path => this.policy.isAllowedPath(path.endsWith(".md") ? path : `${path}.md`)),
      backlinks: item.backlinks.filter(path => this.policy.isAllowedPath(path)) };
  }

  /** Last shared boundary before [S] allocation. Context-only data never acquires a citation. */
  async prepareSections(sections: ContextSection[]): Promise<ContextSection[]> {
    const decisions = new Map<string, Promise<CitableMarkdown | null>>();
    const result: ContextSection[] = [];
    for (const section of sections) {
      const path = section.sourceInfo?.path ?? section.source;
      if (!path || section.kind === "diagnostic" || section.kind === "context" || /^https?:\/\//iu.test(path)) {
        result.push(section);
        continue;
      }
      if (!this.policy.isAllowedPath(path)) continue;
      const file = this.app.vault.getAbstractFileByPath?.(path);
      // Catalogs and synthesized navigation have no document to cite.
      if (!file) { result.push({ ...section, kind: "context", sourceInfo: undefined }); continue; }
      if (!decisions.has(path)) decisions.set(path, this.readCitableSource(path));
      const decision = await decisions.get(path);
      if (!decision?.allowed) continue;
      const content = prepareCitableMarkdown(path, section.content, { rootFolder: this.rootFolder });
      if (!content.allowed) continue;
      const source = section.sourceInfo ?? { path, title: file.basename ?? path, type: "knowledge" as const };
      result.push({ ...section, content: content.markdown, sourceInfo: { ...source, evidenceOrigin: decision.origin } });
    }
    return result;
  }

  async getActiveFile(): Promise<FileLike | null> {
    const file = this.app.workspace?.getActiveFile?.() ?? null;
    if (!file || !this.policy.isAllowedPath(file.path)) return null;
    const metadata = await this.metadataForFile(file);
    if (!metadata) return null;
    return await this.readCitableSource(file.path) ? file : null;
  }

  private async metadataForFile(file: FileLike): Promise<ParsedMarkdownMetadata | null> {
    const getFileCache = this.app.metadataCache?.getFileCache;
    if (typeof getFileCache === "function") {
      try {
        const cache = getFileCache(file);
        if (!cache || this.hasNullFrontmatterCache(cache)) return this.metadataFromMarkdown(file);
        return this.metadataFromCache(cache);
      } catch {
        return this.metadataFromMarkdown(file);
      }
    }

    return this.metadataFromMarkdown(file);
  }

  private metadataFromCache(cache: FileCacheLike): ParsedMarkdownMetadata {
    const frontmatter = this.asRecord(cache.frontmatter);
    return {
      frontmatter,
      tags: this.unique([...this.tagsFromFrontmatter(frontmatter), ...(cache.tags ?? []).map((tag) => this.cleanTag(tag.tag ?? ""))]),
      headings: this.unique((cache.headings ?? []).map((heading) => heading.heading ?? "").filter(Boolean)),
      links: this.unique((cache.links ?? []).map((link) => link.link ?? "").filter(Boolean))
    };
  }

  private async metadataFromMarkdown(file: FileLike): Promise<ParsedMarkdownMetadata | null> {
    try {
      // Local metadata fallback only: callers still receive metadata fields, never the body text.
      const mtime = file.stat?.mtime ?? 0;
      const cached = this.documentCache.get(file.path);
      if (cached && cached.mtime === mtime) return cached.metadata;
      const markdown = await this.app.vault.read(file);
      const metadata = this.parseMarkdown(markdown);
      this.documentCache.set(file.path, { mtime, markdown, metadata });
      return metadata;
    } catch {
      return null;
    }
  }

  private parseMarkdown(markdown: string): ParsedMarkdownMetadata {
    const { frontmatter, body } = this.parseFrontmatter(markdown);
    return {
      frontmatter,
      tags: this.unique([...this.tagsFromFrontmatter(frontmatter), ...this.tagsFromBody(body)]),
      headings: this.unique(this.headingsFromBody(body)),
      links: this.unique(this.linksFromBody(body))
    };
  }

  private parseFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string } {
    const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) return { frontmatter: {}, body: markdown };

    const frontmatter: Record<string, unknown> = {};
    for (const line of match[1].split(/\r?\n/)) {
      const keyValue = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
      if (!keyValue) continue;
      frontmatter[keyValue[1]] = this.parseYamlValue(keyValue[2]);
    }

    return { frontmatter, body: markdown.slice(match[0].length) };
  }

  private parseYamlValue(value: string): unknown {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      return trimmed.slice(1, -1).split(",").map((item) => this.parseYamlScalar(item)).filter(Boolean);
    }
    return this.parseYamlScalar(trimmed);
  }

  private parseYamlScalar(value: string): string {
    const trimmed = this.stripUnquotedComment(value).trim();
    const quote = trimmed[0];
    if ((quote === "\"" || quote === "'") && trimmed.endsWith(quote)) {
      return trimmed.slice(1, -1).trim();
    }
    return trimmed.trimEnd();
  }

  private stripUnquotedComment(value: string): string {
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

  private tagsFromFrontmatter(frontmatter: Record<string, unknown>): string[] {
    const tags = frontmatter.tags;
    if (Array.isArray(tags)) return tags.map((tag) => this.cleanTag(String(tag))).filter(Boolean);
    if (typeof tags === "string") return tags.split(/[,\s]+/).map((tag) => this.cleanTag(tag)).filter(Boolean);
    return [];
  }

  private tagsFromBody(body: string): string[] {
    return Array.from(body.matchAll(/(^|\s)#([A-Za-z0-9/_-]+)/g), (match) => this.cleanTag(match[2])).filter(Boolean);
  }

  private headingsFromBody(body: string): string[] {
    return Array.from(body.matchAll(/^#{1,6}\s+(.+)$/gm), (match) => match[1].trim()).filter(Boolean);
  }

  private linksFromBody(body: string): string[] {
    return Array.from(body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g), (match) => match[1].trim()).filter(Boolean);
  }

  private findBacklinks(path: string): string[] {
    let resolvedLinks: Record<string, Record<string, number>> = {};
    try {
      resolvedLinks = this.app.metadataCache?.resolvedLinks ?? {};
    } catch {
      resolvedLinks = {};
    }
    return this.unique(
      Object.entries(resolvedLinks)
        .filter(([, destinations]) => Number(destinations[path] ?? 0) > 0)
        .map(([source]) => source)
        .filter((source) => this.policy.isAllowedPath(source))
    );
  }

  private titleForFile(file: FileLike, headings: string[]): string {
    return headings[0] ?? file.basename ?? (file.name ?? file.path.split("/").pop() ?? file.path).replace(/\.md$/i, "");
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private hasFrontmatterCache(cache: FileCacheLike): boolean {
    return Object.prototype.hasOwnProperty.call(cache, "frontmatter") && cache.frontmatter !== null && cache.frontmatter !== undefined;
  }

  private hasNullFrontmatterCache(cache: FileCacheLike): boolean {
    return Object.prototype.hasOwnProperty.call(cache, "frontmatter") && (cache.frontmatter === null || cache.frontmatter === undefined);
  }

  private cleanTag(tag: string): string {
    return tag.replace(/^#/, "").trim();
  }

  private unique(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean)));
  }
}
