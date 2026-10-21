import type { App, TFile } from "obsidian";
import { ContextSourcePolicyService, prepareCitableMarkdown, type CitableMarkdown } from "./ContextSourcePolicyService";
import type { ContextInventoryItem, ContextSection, ContextSource } from "./types";

type FileLike = TFile & {
  path: string;
  name?: string;
  basename?: string;
  extension?: string;
  stat?: { mtime?: number; size?: number };
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

interface BacklinkSourceRecord {
  /** Identity of the resolved-links record last read for this source. */
  reference: object | null;
  /** Destination paths whose resolved count is positive, in link-record order. */
  destinations: string[];
  /** Source mtime last seen in the Vault (undefined when the Vault does not list it). */
  mtime: number | undefined;
}

interface BacklinkIndexState {
  /** Allowed-file stamp (path + mtime) the index below was refreshed for. */
  stamp: string;
  /** Allowed file paths and mtimes of the last refresh: file creation/deletion re-links everything. */
  files: Map<string, number>;
  /** Per-source link records, so one edited document re-enumerates one record. */
  sources: Map<string, BacklinkSourceRecord>;
  /** destination path -> allowed source paths, in resolvedLinks key order. */
  backlinks: Map<string, string[]>;
}

const DOCUMENT_CACHE = new WeakMap<object, Map<string, CachedMarkdownDocument>>();
const BACKLINK_INDEX = new WeakMap<object, Map<string, BacklinkIndexState>>();

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
    // KB-09: one traversal of the resolved link graph serves every document below
    // (V+E), instead of one whole-graph scan per document (V^2).
    const backlinks = this.backlinksForFiles(files.filter((file) => this.policy.isAllowedPath(file.path)));
    const inventory: ContextInventoryItem[] = [];

    for (const file of files) {
      if (!this.policy.isAllowedPath(file.path)) continue;

      const parsed = await this.metadataForFile(file);
      if (!parsed) continue;
      if (!this.recognitionSourceIsCurrent(parsed.frontmatter)) continue;
      // Three separated layers: this inventory feeds model-bound retrieval, summaries
      // and catalogs only. The Knowledge view lists/searches/opens notes by reading the
      // Vault directly, so excluding a source here keeps it locally visible while its
      // body and metadata stay out of every prompt. Never auto-upgrade a source.
      if (!this.policy.isAiEligible(file.path, parsed.frontmatter)) continue;
      if (!this.policy.isAllowedFrontmatter(parsed.frontmatter) && !await this.readCitableSource(file.path)) continue;

      inventory.push({
        path: file.path,
        title: this.titleForFile(file, parsed.headings),
        tags: parsed.tags,
        headings: parsed.headings,
        links: parsed.links,
        backlinks: this.findBacklinks(backlinks, file.path),
        frontmatter: parsed.frontmatter,
        mtime: file.stat?.mtime ?? 0
      });
    }

    return inventory;
  }

  /**
   * Reverse index over the resolved link graph, maintained on the same app object as
   * the document cache but per root folder (the source policy is part of the result).
   *
   * A hot inventory (no file added, removed or edited) reuses the index without reading
   * the graph at all. A content edit re-enumerates only that document's link record; a
   * file creation/deletion re-links every source because it can change how other
   * documents resolve their links. Nothing here reads a note body.
   */
  private backlinksForFiles(files: FileLike[]): Map<string, string[]> {
    const state = this.backlinkIndexState();
    const stamp = this.vaultStamp(files);
    if (state.stamp === stamp) return state.backlinks;
    this.refreshBacklinkIndex(state, files, stamp);
    return state.backlinks;
  }

  private backlinkIndexState(): BacklinkIndexState {
    const appKey = this.app as unknown as object;
    let states = BACKLINK_INDEX.get(appKey);
    if (!states) {
      states = new Map<string, BacklinkIndexState>();
      BACKLINK_INDEX.set(appKey, states);
    }
    const key = this.normalizePath(this.rootFolder).replace(/\/+$/u, "").toLowerCase();
    let state = states.get(key);
    if (!state) {
      state = { stamp: "", files: new Map<string, number>(), sources: new Map<string, BacklinkSourceRecord>(), backlinks: new Map<string, string[]>() };
      states.set(key, state);
    }
    return state;
  }

  /** Fingerprint of the allowed Markdown files (path + mtime): O(V), no graph access. */
  private vaultStamp(files: FileLike[]): string {
    let hash = 2166136261;
    for (const file of files) {
      const text = `${this.normalizePath(file.path)}|${file.stat?.mtime ?? 0}\n`;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    }
    return `${files.length}:${(hash >>> 0).toString(16)}`;
  }

  private refreshBacklinkIndex(state: BacklinkIndexState, files: FileLike[], stamp: string): void {
    const resolvedLinks = this.resolvedLinksOrEmpty();
    const keys = this.objectKeys(resolvedLinks);
    const ranks = new Map<string, number>();
    keys.forEach((key, index) => ranks.set(key, index));
    const mtimes = new Map<string, number>();
    for (const file of files) mtimes.set(this.normalizePath(file.path), file.stat?.mtime ?? 0);
    const fileSetChanged = !this.sameFileSet(state.files, mtimes);
    const touched = new Set<string>();

    for (const source of Array.from(state.sources.keys())) {
      if (!ranks.has(source)) this.unlinkBacklinkSource(state, source, touched);
    }
    for (const source of keys) {
      const reference = this.resolvedLinkRecord(resolvedLinks, source);
      const previous = state.sources.get(source);
      const mtime = mtimes.get(this.normalizePath(source));
      if (previous && !fileSetChanged && previous.reference === reference && previous.mtime === mtime) continue;
      this.unlinkBacklinkSource(state, source, touched);
      const destinations = this.positiveDestinations(reference);
      state.sources.set(source, { reference, destinations, mtime });
      if (!this.policy.isAllowedPath(source)) continue;
      for (const destination of destinations) this.linkBacklinkSource(state, destination, source, touched);
    }
    // Keep the previous contract: sources of one destination follow resolvedLinks key order.
    for (const destination of touched) {
      const sources = state.backlinks.get(destination);
      if (sources && sources.length > 1) {
        sources.sort((left, right) => (ranks.get(left) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(right) ?? Number.MAX_SAFE_INTEGER));
      }
    }
    state.stamp = stamp;
    state.files = mtimes;
  }

  private unlinkBacklinkSource(state: BacklinkIndexState, source: string, touched: Set<string>): void {
    const record = state.sources.get(source);
    if (record) {
      for (const destination of record.destinations) {
        const sources = state.backlinks.get(destination);
        if (!sources) continue;
        const remaining = sources.filter((entry) => entry !== source);
        if (remaining.length === 0) state.backlinks.delete(destination); else state.backlinks.set(destination, remaining);
        touched.add(destination);
      }
    }
    state.sources.delete(source);
  }

  private linkBacklinkSource(state: BacklinkIndexState, destination: string, source: string, touched: Set<string>): void {
    const sources = state.backlinks.get(destination);
    if (sources) {
      if (!sources.includes(source)) sources.push(source);
    } else {
      state.backlinks.set(destination, [source]);
    }
    touched.add(destination);
  }

  private resolvedLinksOrEmpty(): Record<string, Record<string, number>> {
    try {
      return this.app.metadataCache?.resolvedLinks ?? {};
    } catch {
      return {};
    }
  }

  private objectKeys(value: object): string[] {
    try {
      return Object.keys(value);
    } catch {
      return [];
    }
  }

  private resolvedLinkRecord(resolvedLinks: Record<string, Record<string, number>>, source: string): object | null {
    try {
      const record = (resolvedLinks as Record<string, unknown>)[source];
      return record && typeof record === "object" ? record : null;
    } catch {
      return null;
    }
  }

  /** Destination paths with a positive resolved count, exactly as the per-file scan read them. */
  private positiveDestinations(record: object | null): string[] {
    if (!record) return [];
    const destinations: string[] = [];
    try {
      for (const [destination, count] of Object.entries(record as Record<string, unknown>)) {
        if (Number(count ?? 0) > 0) destinations.push(destination);
      }
    } catch {
      // An unreadable link record contributes no links; the rest of the inventory stays usable.
    }
    return destinations;
  }

  private sameFileSet(previous: Map<string, number>, current: Map<string, number>): boolean {
    if (previous.size !== current.size) return false;
    for (const path of current.keys()) {
      if (!previous.has(path)) return false;
    }
    return true;
  }

  async readFile(path: string): Promise<string> {
    if (!this.policy.isAllowedPath(path)) return "";
    const file = this.app.vault.getAbstractFileByPath?.(path);
    if (!file || !this.policy.isAllowedPath(file.path)) return "";

    try {
      const metadata = await this.metadataForFile(file);
      if (!metadata || !this.recognitionSourceIsCurrent(metadata.frontmatter)) return "";
      // Hard gate for every model-bound reader (orchestrator, retrieval indexes,
      // summaries, linked notes, current note). Local display/search/open paths read
      // the Vault through the view layer and are deliberately unaffected.
      if (!this.policy.isAiEligible(file.path, metadata.frontmatter)) return "";
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
    const frontmatter = this.documentCache.get(source.path)?.metadata.frontmatter;
    if (frontmatter?.type === "lifeos-document-recognition" && this.recognitionSourceIsCurrent(frontmatter)) {
      const page = /^第 (\d+) 页 \[(?:native|vision|empty)\]$/u.exec(source.heading || "");
      return { ...source, originalPath: String(frontmatter.source_file), page: page ? Number(page[1]) : undefined,
        title: String(frontmatter.source_file).split("/").pop() || source.title,
        evidenceOrigin: this.evidenceDecisions.get(source.path)?.origin ?? "note" };
    }
    return { ...source, evidenceOrigin: this.evidenceDecisions.get(source.path)?.origin ?? "note" };
  }

  private recognitionSourceIsCurrent(frontmatter: Record<string, unknown>): boolean {
    if (frontmatter.type !== "lifeos-document-recognition") return true;
    const sourcePath = String(frontmatter.source_file || "").replace(/\\/gu, "/");
    const root = this.rootFolder.replace(/\\/gu, "/").replace(/\/+$/u, "");
    if (!sourcePath.startsWith(`${root}/`) || !/\.(pdf|docx)$/iu.test(sourcePath)) return false;
    const source = this.app.vault.getAbstractFileByPath?.(sourcePath);
    return !!source && source.stat?.size === Number(frontmatter.source_size)
      && source.stat?.mtime === Number(frontmatter.source_mtime);
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

  private findBacklinks(index: Map<string, string[]>, path: string): string[] {
    // Copy so a later incremental refresh can never mutate an inventory snapshot.
    return [...(index.get(path) ?? [])];
  }

  private normalizePath(path: string): string {
    return String(path || "").replace(/\\/gu, "/");
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
