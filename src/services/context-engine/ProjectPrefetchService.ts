import type { App, TFile } from "obsidian";
import type { PersonalLifeSystemSettings } from "../../settings";
import { localizeLifeOsPathParts, normalizeDirectoryLanguage } from "../../settings";
import type { ChatContextBundle } from "../ChatContextService";
import { parseProjectIndex, formatProjectForIndex } from "../project-context";
import { parseTaskLine } from "../../utils/markdown";
import { ContextPrefetchCache, type PrefetchIdentity } from "./ContextPrefetchCache";
import { ContextSourcePolicyService } from "./ContextSourcePolicyService";
import type { ContextSource } from "./types";

/** Opaque local index token, not a credential hash or a security primitive.
 * Cache identity retains the normalized question as a collision guard in memory. */
export function opaqueHash(text: string): string {
  let a = 2166136261, b = 2246822519;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b ^ text.charCodeAt(i), 3266489917);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}
export interface ProjectPrefetchScope {
  question: string; project: string; account: string; session: string; config: string;
  sessionMemory: Array<{ role: string; content: string }>;
}
interface ReadFile { path: string; basename: string; stat: { mtime: number; size: number }; }
interface Selected { file: ReadFile; type: ContextSource["type"]; mode: "project-index" | "tasks" | "content"; version: string; }
export interface ProjectPrefetchSnapshot {
  identity: PrefetchIdentity; scope: ProjectPrefetchScope; selected: Selected[]; fingerprint: string;
}
export interface ProjectPrefetchResult { bundle: ChatContextBundle; durationMs: number; sourceCount: number; reads: Map<string, { version: string; raw: string }>; hits: number; }

/** Read-only project bundle: index, recent documents, scoped tasks, scoped memory
 * and current session memory. Never uses ensureFile, AI planners, web or writes. */
export class ProjectPrefetchService {
  private readonly cache: ContextPrefetchCache<ProjectPrefetchResult>;
  private activeScope = "";
  constructor(private readonly app: App, private readonly settings: () => Partial<PersonalLifeSystemSettings>,
    options: { ttlMs?: number; timeoutMs?: number } = {}) {
    this.cache = new ContextPrefetchCache(options.ttlMs ?? 300_000, 12, options.timeoutMs ?? 1900);
  }
  clear(): void { this.activeScope = ""; this.cache.clear(); }
  private path(...parts: string[]): string {
    const settings = this.settings();
    return [settings.rootFolder || "", ...localizeLifeOsPathParts(parts, normalizeDirectoryLanguage(settings.directoryLanguage))]
      .join("/").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
  }
  snapshot(scope: ProjectPrefetchScope, activate = true): ProjectPrefetchSnapshot | undefined {
    if (!scope.project || /[\\/\u0000-\u001f]|\.\./u.test(scope.project)) return undefined;
    const started = Date.now();
    const settings = this.settings();
    const policy = new ContextSourcePolicyService(settings.rootFolder || "");
    const all = this.app.vault.getMarkdownFiles() as ReadFile[];
    if (all.length > 20_000) return undefined; // bounded CPU, normal retrieval handles larger libraries
    const root = this.path("Projects", scope.project);
    const globalIndex = this.path("Projects", "index.md");
    const taskPaths = [this.path("Tasks", "open.md"), this.path("Tasks", "done.md")];
    const memoryRoot = this.path("Memory") + "/";
    const eligible: Selected[] = [];
    const versions: string[] = [];
    for (const file of all) {
      if (Date.now() - started >= 100) return undefined;
      if (!policy.isAllowedPath(file.path) || !file.stat || file.stat.size > 256_000) continue;
      let type: ContextSource["type"] | undefined;
      let mode: Selected["mode"] = "content";
      if (file.path === globalIndex) { type = "project"; mode = "project-index"; }
      else if (file.path.startsWith(root + "/") && !/\/(?:Trash|Attachments)\//u.test(file.path)) type = "project";
      else if (taskPaths.includes(file.path)) { type = "task"; mode = "tasks"; }
      else if (file.path.startsWith(memoryRoot)) {
        const fm = this.app.metadataCache?.getFileCache(file as TFile)?.frontmatter || {};
        const project = String(fm.projectId || fm.project || "");
        const session = String(fm.sessionId || fm.session || "");
        if (project === scope.project && (!session || session === scope.session)) {
          type = "memory";
          versions.push(JSON.stringify([file.path, project, session]));
        }
      }
      if (!type) continue;
      const version = JSON.stringify([file.path, file.stat.mtime, file.stat.size]);
      versions.push(version);
      eligible.push({ file, type, mode, version });
    }
    // Include every eligible file's version, not only the selected top-N: a new or
    // newly recent document changes the index and cannot reuse a stale selection.
    const fingerprint = opaqueHash(versions.sort().join("\n"));
    const documents = eligible.filter(e => e.type === "project" && e.mode === "content" && e.file.path !== root + "/index.md")
      .sort((a, b) => b.file.stat.mtime - a.file.stat.mtime || a.file.path.localeCompare(b.file.path)).slice(0, 8);
    const selected = [
      ...eligible.filter(e => e.mode === "project-index" || e.file.path === root + "/index.md" || e.type === "task"),
      ...documents,
      ...eligible.filter(e => e.type === "memory").sort((a, b) => b.file.stat.mtime - a.file.stat.mtime).slice(0, 4)
    ];
    const question = scope.question.trim().replace(/\s+/gu, " ");
    const identity: PrefetchIdentity = {
      question: opaqueHash(question) + ":" + question, project: scope.project, account: scope.account,
      indexVersion: fingerprint, config: scope.config, session: scope.session
    };
    const activeScope = JSON.stringify([scope.project, scope.account, scope.session, scope.config]);
    if (activate && activeScope !== this.activeScope) { this.cache.clear(); this.activeScope = activeScope; }
    return { identity, scope: { ...scope, sessionMemory: scope.sessionMemory.map(m => ({ ...m })) }, selected, fingerprint };
  }
  get(scope: ProjectPrefetchScope): ProjectPrefetchResult | undefined {
    try { const snapshot = this.snapshot(scope); return snapshot ? this.cache.get(snapshot.identity) : undefined; }
    catch { return undefined; }
  }
  /** Transparent read-through adapter. Selection, excerpts and citations still
   * belong to ContextEngine; old/unselected documents always use normal reads. */
  cachedApp(result?: ProjectPrefetchResult): App {
    if (!result) return this.app;
    const scoped = Object.create(this.app) as App;
    const vault = Object.create(this.app.vault);
    for (const method of ["read", "cachedRead"] as const) {
      vault[method] = (file: TFile) => {
        const row = result.reads.get(file.path);
        if (row && row.version === JSON.stringify([file.path, file.stat.mtime, file.stat.size])) {
          result.hits++; return Promise.resolve(row.raw);
        }
        return this.app.vault[method](file);
      };
    }
    Object.defineProperty(scoped, "vault", { value: vault });
    return scoped;
  }
  async prefetch(scope: ProjectPrefetchScope): Promise<ProjectPrefetchResult | undefined> {
    try {
      const snapshot = this.snapshot(scope);
      if (!snapshot) return undefined;
      return await this.cache.prefetch(snapshot.identity, signal => this.build(snapshot, signal));
    } catch { return undefined; }
  }
  async build(snapshot: ProjectPrefetchSnapshot, signal: AbortSignal, parallel = true): Promise<ProjectPrefetchResult> {
    const started = Date.now();
    const check = () => {
      if (signal.aborted) throw new Error("PROJECT_PREFETCH_CANCELLED");
    };
    const read = async (entry: Selected) => {
      check();
      if (JSON.stringify([entry.file.path, entry.file.stat.mtime, entry.file.stat.size]) !== entry.version) throw new Error("PROJECT_PREFETCH_STALE");
      const raw = await this.app.vault.cachedRead(entry.file as TFile);
      check();
      if (JSON.stringify([entry.file.path, entry.file.stat.mtime, entry.file.stat.size]) !== entry.version) throw new Error("PROJECT_PREFETCH_STALE");
      let text = raw;
      if (entry.mode === "project-index") {
        text = parseProjectIndex(raw).filter(p => p.id === snapshot.scope.project).map(formatProjectForIndex).join("\n");
      } else if (entry.mode === "tasks") {
        text = raw.split(/\r?\n/).filter(line => parseTaskLine(line, "open")?.projectId === snapshot.scope.project).join("\n");
      }
      return { entry, raw, text: text.slice(0, 4000) };
    };
    const rows: Awaited<ReturnType<typeof read>>[] = [];
    if (parallel) rows.push(...await Promise.all(snapshot.selected.map(read)));
    else for (const entry of snapshot.selected) rows.push(await read(entry)); // cold serial fixture/control
    check();
    const current = this.snapshot(snapshot.scope, false);
    if (!current || current.fingerprint !== snapshot.fingerprint) throw new Error("PROJECT_PREFETCH_STALE");
    const bundle: ChatContextBundle = { promptContext: "", sections: [], sources: [], statusCards: [], contextSources: [] };
    let remaining = 24_000;
    for (const { entry, text } of rows) {
      if (!text.trim() || remaining <= 0) continue;
      const content = text.slice(0, remaining); remaining -= content.length;
      const citationId = `S${bundle.sources.length + 1}`;
      bundle.sources.push({ path: entry.file.path, title: entry.file.basename, type: entry.type,
        citationId, updatedAt: entry.file.stat.mtime, excerpt: content });
      bundle.sections.push({ title: entry.type === "memory" ? "项目相关记忆" : entry.file.basename,
        content: `[${citationId}] ${entry.file.path}\n${content}`, priority: 90, source: entry.file.path });
      bundle.contextSources.push(entry.file.path);
    }
    const sessionText = snapshot.scope.sessionMemory.slice(-6).map(m => `${m.role}: ${m.content.slice(0, 800)}`).join("\n");
    if (sessionText) bundle.sections.push({ title: "当前会话记忆（非独立证据）", content: sessionText, priority: 70 });
    bundle.promptContext = "只读项目上下文：项目索引、最近文档、项目任务、相关记忆。范围有界；缺失资料不得编造。\n"
      + bundle.sections.map(section => `## ${section.title}\n${section.content}`).join("\n\n");
    return { bundle, durationMs: Date.now() - started, sourceCount: bundle.sources.length, hits: 0,
      reads: new Map(rows.map(row => [row.entry.file.path, { version: row.entry.version, raw: row.raw }])) };
  }
}
