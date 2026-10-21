import { Platform, TFile, type App } from "obsidian";
import type { PersonalLifeSystemSettings } from "../settings";
import type { ProjectAnalysisExecution, ProjectAnalysisIdentity } from "./sdk/SdkProjectAnalysisAdapter";
import { FileSystemService } from "./FileSystemService";
import { parseProjectIndex } from "./project-context";
import { recognizedSourcePath, readRecognizedPage, isDocumentRecognitionPath } from "./DocumentRecognitionCacheService";
import {
  AnalysisCoordinator, AnalysisStore, ProtectedJsonAnalysisStorage, approvalFor, freezeManifest,
  createExistingReaderAdapter, hashBytes, hashText, safePath, clone, newId,
  type AnalysisJob, type AuthorizationScope, type BudgetLimits, type ChunkSpec,
  assertApproval, authorizationIdentity,
  type ModelCall, type ModelResponse, type ModelIdentity, type SourceEntry, type TextUnit, type ManifestReader
} from "./agent/analysis";
import { desktopAnalysisIO } from "./agent/analysis/host-io";

export interface AnalysisPreparation {
  projectId: string; request: string;
  /** A USER-CONFIRMED conservative operating envelope, not discovered model capability. */
  safeWindowConfirmed: boolean; inputTokens: number; outputTokens: number; overheadTokens: number;
  limits: BudgetLimits; allowDerivedReport: boolean;
}
export const PROJECT_ANALYSIS_SPEC: ChunkSpec = { version: "utf16-v1", extractionVersion: "claims-v2-attribution", maxChars: 4000, overlap: 64 };
export function defaultAnalysisLimits(): BudgetLimits {
  return { api: 0, sdk: 20, sdkTurns: 20 * 4, vision: 0, search: 0, write: 1, tokens: 200000, cost: null, currency: "USD", durationMs: 15 * 60 * 1000 };
}
const inside = (p: string, root: string): boolean => p.startsWith(root + "/");
const frontmatter = (text: string, key: string): string | null => {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1];
  const raw = header?.split(/\r?\n/u).find(l => l.startsWith(key + ":"))?.slice(key.length + 1).trim();
  if (!raw) return null; try { return String(JSON.parse(raw)); } catch { return raw.replace(/^['"]|['"]$/gu, ""); }
};
const body = (text: string): string => text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");
const unit = (unitId: string, text: string, extra: Partial<TextUnit> = {}): TextUnit => ({
  unitId, text, readState: "read", role: "unknown", origin: "native", originalVerified: true, ...extra
});

/** No constructor/open/reload path invokes SDK. Only continue() drives approved work.
 * Source/cache reads NEVER call the cache service methods that create/refresh notes. */
export class ProjectAnalysisService {
  private coordinator?: AnalysisCoordinator;
  private initialization?: Promise<void>;
  private fs?: FileSystemService;
  private binding = "";
  private sdkJobLock?: (operation: () => Promise<AnalysisJob>) => Promise<AnalysisJob>;
  private disposed = false;
  private readonly running = new Set<string>();
  private readonly preparing = new Set<AbortController>();
  private readonly stopRevision = new Map<string, number>();
  constructor(private readonly app: App, private readonly settings: () => PersonalLifeSystemSettings, private readonly execution: ProjectAnalysisExecution) {}

  identity(): ProjectAnalysisIdentity { return this.execution.identity(); }
  private filesystem(): FileSystemService {
    const s = this.settings(), key = JSON.stringify([s.rootFolder, s.directoryLanguage]);
    if (this.binding && key !== this.binding) throw new Error("analysis-root-changed-reopen-service");
    return this.fs || new FileSystemService(this.app, s.rootFolder, s.directoryLanguage);
  }
  async projects(): Promise<Array<{ id: string; name: string }>> {
    const file = this.app.vault.getAbstractFileByPath(this.filesystem().path("Projects", "index.md"));
    return file instanceof TFile ? parseProjectIndex(await this.app.vault.read(file)).map(p => ({ id: p.id, name: p.name })) : [];
  }
  private file(path: string): TFile {
    const f = this.app.vault.getAbstractFileByPath(safePath(path)); if (!(f instanceof TFile)) throw new Error("analysis-source-missing"); return f;
  }
  private async initialize(): Promise<void> {
    if (this.disposed) throw new Error("analysis-service-disposed"); this.filesystem();
    if (!this.initialization) this.initialization = (async () => {
      if (!Platform.isDesktopApp) throw new Error("analysis-desktop-only");
      const adapter = this.app.vault.adapter as typeof this.app.vault.adapter & { getBasePath?: () => string };
      if (!adapter.getBasePath || !this.app.loadLocalStorage || !this.app.saveLocalStorage) throw new Error("analysis-persistence-capability-unavailable");
      const s = this.settings(); this.fs = this.filesystem(); this.binding = JSON.stringify([s.rootFolder, s.directoryLanguage]);
      const key = "lifeos.analysis.host.v1";
      let host = this.app.loadLocalStorage(key);
      if (typeof host !== "string" || !/^[a-zA-Z0-9-]{1,80}$/u.test(host)) { host = newId(); this.app.saveLocalStorage(key, host); }
      const io = await desktopAnalysisIO(adapter.getBasePath(), this.fs.path("Chat", "Agent", "Working State", "ProjectAnalysis"), String(host));
      this.sdkJobLock = operation => io.withHostLock("project-analysis-sdk-serial", operation);
      const reader: ManifestReader = {
        enumerate: async () => { throw new Error("analysis-project-scope-required"); },
        snapshot: (e, o) => this.reader(o.projectId).snapshot(e, o),
        currentIdentity: d => this.reader(d.projectId).currentIdentity(d)
      };
      const dispatch = async (call: ModelCall & { schema?: object }): Promise<ModelResponse> => {
        const store = this.coordinator!.store;
        const before = await store.read(call.jobId), leaseToken = before.lease?.token;
        const validate = async () => {
          if (this.disposed || call.signal.aborted) throw new Error("analysis-reading-cancelled"); this.filesystem();
          const live = this.identity();
          for (const k of ["profile", "profileRevision", "model", "destination"] as const) if (live[k] !== call.profile[k]) throw new Error("analysis-sdk-identity-changed");
          if (call.maxTurns !== 1 || call.profile.backend !== "sdk") throw new Error("analysis-sdk-single-turn-required");
          const job = await store.read(call.jobId);
          if (job.hostIdentity !== store.storage.hostIdentity) throw new Error("foreign-host-read-only");
          if (!job.status.startsWith("running-") || !leaseToken || job.lease?.token !== leaseToken) throw new Error("analysis-start-stopped");
          store.assertLease(job, leaseToken); assertApproval(job, store.clock());
          if (job.identityHash !== await authorizationIdentity(job.manifest, job.authorization)) throw new Error("approval-identity-mismatch");
          const reserved = job.budget.reservations.find(r => r.executionId === call.executionId && r.taskId === call.taskId);
          if (!reserved || reserved.state !== "reserved" || reserved.profile !== call.profile.profile) throw new Error("analysis-reservation-changed");
          if (job.budget.limits.durationMs !== null && store.clock() - job.startedAt >= job.budget.limits.durationMs) throw new Error("duration-budget-exhausted");
          for (const doc of job.manifest.documents) {
            if (doc.sourceHash === "unknown" && !doc.units.some(u => u.readState === "read" && u.text)) continue;
            const current = await this.reader(doc.projectId, call.signal).currentIdentity(doc);
            if (current.sourceHash !== doc.sourceHash || current.effectiveTextHash !== doc.effectiveTextHash) {
              await store.update(job.jobId, j => { if (j.status !== "cancelled") { j.status = "paused"; j.waitReason = "source-changed"; } });
              throw new Error("analysis-source-changed");
            }
          }
        };
        try { await validate(); }
        catch (cause) {
          // The execution port was never called: this is a proven zero dispatch,
          // unlike a lost SDK terminal receipt. Preserve completed work and pause.
          const code = cause instanceof Error && ["analysis-reading-cancelled", "analysis-entitlement-required", "analysis-sdk-identity-changed", "analysis-start-stopped", "analysis-source-changed", "duration-budget-exhausted", "approval-required"].includes(cause.message)
            ? cause.message : "analysis-dispatch-policy-denied";
          await store.update(call.jobId, j => { if (j.status !== "cancelled") { j.status = "paused";
            j.waitReason = code === "duration-budget-exhausted" ? "budget-required" : code === "analysis-source-changed" ? "source-changed" : "approval-required";
            if (["analysis-sdk-identity-changed", "analysis-entitlement-required"].includes(code)) delete j.approval;
            j.error = code; } });
          return { finish: "error", output: null, usage: { receiptId: `${call.executionId}:host-no-dispatch`, executionId: call.executionId,
            taskId: call.taskId, profile: call.profile.profile, category: "sdk", basis: "incremental", tokens: 0, cost: 0,
            sdkHttpRequests: 0, sdkTurns: 0, sdkResultTurns: null, ...(call.allowance.currency ? { currency: call.allowance.currency } : {}) } };
        }
        const response = await this.execution.analysisCall(call, { hostIdentity: before.hostIdentity, projectId: before.manifest.scope,
          beforeDispatch: validate, remainingDurationMs: before.budget.limits.durationMs === null ? 90000
            : Math.max(0, before.budget.limits.durationMs - (store.clock() - before.startedAt)) });
        try {
          const live = this.identity();
          for (const key of ["profile", "profileRevision", "model", "destination"] as const) if (live[key] !== call.profile[key]) throw Error("analysis-sdk-identity-changed");
        } catch { await store.update(call.jobId, j => { if (j.status !== "cancelled") { j.status = "paused"; j.waitReason = "approval-required"; delete j.approval; } }); }
        return response;
      };
      this.coordinator = new AnalysisCoordinator(new AnalysisStore(new ProtectedJsonAnalysisStorage(io)), reader,
        { costCeiling: () => null, extract: dispatch, synthesize: dispatch });
    })().catch(e => { this.initialization = undefined; throw e; });
    await this.initialization;
  }
  private root(projectId: string): string {
    if (!projectId || projectId === "." || projectId === ".." || /[\\/:\u0000-\u001f]/u.test(projectId)) throw new Error("analysis-invalid-project-id");
    return this.filesystem().path("Projects") + "/" + projectId;
  }
  /** Public for read-only preview/tests. Listing is frozen per reader instance and fully paginated. */
  reader(projectId: string, signal?: AbortSignal): ManifestReader {
    const root = this.root(projectId), fs = this.filesystem();
    const check = (): void => { if (signal?.aborted || this.disposed) throw new Error("analysis-reading-cancelled"); this.filesystem(); };
    let listing: Promise<SourceEntry[]> | undefined;
    const enumerate = async (): Promise<SourceEntry[]> => {
      check(); const entries: SourceEntry[] = [], candidates = this.app.vault.getFiles();
      const scopeFiles = candidates.filter(f => inside(f.path, root + "/Documents") || inside(f.path, root + "/Attachments"));
      const paths = new Set(scopeFiles.map(f => f.path));
      for (const file of scopeFiles) {
        check(); const format = file.extension.toLowerCase();
        let kind: SourceEntry["kind"] = "original", sourceFile: string | undefined;
        if (format === "md") {
          const text = await this.app.vault.read(file), type = frontmatter(text, "type");
          if (type === "lifeos-agent-analysis-report") kind = "derived-report";
          if (type === "lifeos-agent-analysis-state") kind = "work-state";
          const source = recognizedSourcePath(text);
          if (source && paths.has(source) && source !== file.path) { sourceFile = source; kind = type === "lifeos-document-recognition" ? "recognition" : "wrapper"; }
        }
        entries.push({ path: file.path, projectId, format, kind, ...(sourceFile ? { sourceFile } : {}) });
      }
      // Metadata prefilters prevent reading unrelated caches outside approved scope.
      for (const f of candidates.filter(f => isDocumentRecognitionPath(f.path, fs) && !paths.has(f.path))) {
        check(); const metadata = this.app.metadataCache.getFileCache(f)?.frontmatter;
        if (typeof metadata?.source_file !== "string" || !paths.has(metadata.source_file)) continue;
        const text = await this.app.vault.read(f), source = recognizedSourcePath(text);
        if (!source || !paths.has(source)) continue;
        entries.push({ path: f.path, projectId, format: "md", kind: "recognition", sourceFile: source });
      }
      return entries.sort((a, b) => a.path.localeCompare(b.path));
    };
    return createExistingReaderAdapter({
      enumerateAuthorized: async cursor => {
        if (!listing) listing = enumerate(); const rows = await listing, offset = Number(cursor || 0);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > rows.length) throw new Error("analysis-enumeration-cursor");
        return { entries: rows.slice(offset, offset + 200), ...(offset + 200 < rows.length ? { next: String(offset + 200) } : {}) };
      },
      readOriginalBytes: async p => { check(); if (!inside(p, root + "/Documents") && !inside(p, root + "/Attachments")) throw new Error("analysis-source-outside-scope"); return new Uint8Array(await this.app.vault.readBinary(this.file(p))); },
      readMarkdown: async p => { check(); return this.app.vault.read(this.file(p)); },
      markdownMetadata: text => { const author = frontmatter(text, "author"); return { role: "unknown", ...(author ? { author } : {}) }; },
      readCachedOrNative: async (effective, original) => {
        check(); let native: Awaited<ReturnType<ProjectAnalysisService["native"]>>;
        try { native = await this.native(original.path, signal); }
        catch (e) { check(); native = { totalUnits: null, units: [unit("document", "", { readState: "failed", error: String(e) })], error: "native-reading-failed" }; }
        if (effective.path === original.path) return native;
        const text = await this.app.vault.read(this.file(effective.path));
        if (recognizedSourcePath(text) !== original.path) throw new Error("analysis-cache-source-changed");
        const bytes = new Uint8Array(await this.app.vault.readBinary(this.file(original.path))), hash = await hashBytes(bytes);
        const recognizedCache = frontmatter(text, "type") === "lifeos-document-recognition";
        if (recognizedCache && frontmatter(text, "source_hash") !== hash) return native;
        const section = `cache-sha256:${await hashText(text)}`;
        // Existing caches have no authenticated immutable body hash. Conservatively label
        // every cached/wrapper body as potentially manually edited, never original-verbatim.
        const edited = (id: string, value: string, page?: number): TextUnit => unit(id, value, { section, ...(page ? { page } : {}), origin: "manually-edited", originalVerified: false });
        if (original.format === "pdf" && recognizedCache) {
          const markers = Array.from(text.matchAll(/^## 第 (\d+) 页 \[(native|vision|empty)\][ \t]*\r?$/gmu));
          if (new Set(markers.map(m => Number(m[1]))).size !== markers.length) throw new Error("analysis-duplicate-cache-page");
          const total = native.totalUnits;
          if (total === null) return { totalUnits: null, units: [edited("cache-body", body(text))], error: "cache-page-count-unverified" };
          const units = native.units.map(u => {
            const index = markers.findIndex(m => Number(m[1]) === u.page);
            if (index < 0) return u;
            const m = markers[index]; const recognized = readRecognizedPage(text, u.page!);
            if (!recognized) return u;
            const raw = text.slice(m.index! + m[0].length, markers[index + 1]?.index ?? text.length);
            if (recognized.method === "empty") return unit(u.unitId, raw, { page: u.page, section, readState: "unsupported",
              origin: "manually-edited", originalVerified: false, error: "cache-page-empty-no-evidence" });
            return raw.trim() ? edited(u.unitId, raw, u.page) : u;
          });
          if (markers.some(m => Number(m[1]) < 1 || Number(m[1]) > total)) throw new Error("analysis-cache-page-out-of-range");
          return { totalUnits: total, units };
        }
        return { totalUnits: native.totalUnits, units: [edited("document", body(text))], ...(native.totalUnits === null ? { error: "native-structure-coverage-unknown" } : {}) };
      }
    });
  }
  private async native(path: string, signal?: AbortSignal): Promise<{ totalUnits: number | null; units: TextUnit[]; error?: string }> {
    const file = this.file(path), ext = file.extension.toLowerCase();
    const check = (): void => { if (signal?.aborted || this.disposed) throw new Error("analysis-reading-cancelled"); };
    check();
    if (["md", "txt", "csv", "json"].includes(ext)) return { totalUnits: 1, units: [unit("document", await this.app.vault.read(file))] };
    if (ext !== "pdf" && ext !== "docx") return { totalUnits: null, units: [unit("document", "", { readState: "unsupported", originalVerified: false, error: "native-format-unsupported-no-vision" })] };
    const bytes = new Uint8Array(await this.app.vault.readBinary(file));
    const native = await import("./DocumentImportService"); check();
    if (ext === "pdf") {
      const first = await native.readPdfPageText(bytes.slice(), 1, signal), units: TextUnit[] = [];
      for (let page = 1; page <= first.totalPages; page++) {
        check();
        try { const result = page === 1 ? first : await native.readPdfPageText(bytes.slice(), page, signal);
          units.push(unit(`page-${page}`, result.text, { page, ...(result.requiresOcr ? { readState: "unsupported", originalVerified: false, error: "page-requires-ocr-disabled" } : {}) }));
        } catch (e) { check(); units.push(unit(`page-${page}`, "", { page, readState: "failed", error: String(e) })); }
      }
      return { totalUnits: first.totalPages, units };
    }
    if (bytes.length > 10 * 1024 * 1024) throw new Error("docx-native-size-limit");
    const extracted = await native.extractReadableDocumentText({ name: file.name, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer }, "word", { maxTextChars: null, enablePdfOcr: false });
    // Existing DOCX reader exposes body text, not verified counts of images/headers/comments.
    return { totalUnits: null, units: [unit("document", extracted.text, { originalVerified: true, ...(extracted.text ? {} : { readState: "unsupported" }) })], error: "docx-nonbody-coverage-unknown" };
  }
  private authorization(input: AnalysisPreparation): AuthorizationScope {
    if (!input.safeWindowConfirmed) throw new Error("explicit-safe-input-window-required");
    for (const n of [input.inputTokens, input.outputTokens, input.overheadTokens]) if (!Number.isSafeInteger(n) || n <= 0) throw new Error("invalid-safe-window");
    if (input.limits.api || input.limits.vision || input.limits.search) throw new Error("analysis-sdk-cache-native-only");
    if (input.limits.cost !== null) throw new Error("analysis-price-ceiling-unknown-no-amount-guarantee");
    const id = this.identity();
    const profile: ModelIdentity = { ...id, modelRevision: `${id.profileRevision}:${id.model}`, backend: "sdk",
      // This number is only the confirmed local envelope; NOT a tested provider context size.
      contextTokens: input.inputTokens + input.outputTokens + input.overheadTokens,
      inputTokens: input.inputTokens, outputTokens: input.outputTokens, overheadTokens: input.overheadTokens,
      maxInputChars: input.inputTokens, tokenCounting: "conservative-estimate", sdkTurnLimit: 1, sdkReportedTurnAllowance: 4 };
    return { profile, limits: clone(input.limits), permissions: { modelEgress: true, derivedWrite: input.allowDerivedReport },
      contentCategories: ["project-documents-and-attachments", "cache-may-be-manually-edited", "user-confirmed-safe-window-not-model-capability", "semantic-quality-unverified"] };
  }
  async prepare(input: AnalysisPreparation): Promise<AnalysisJob> {
    const scope = this.authorization(input); this.root(input.projectId);
    if (!input.request.trim()) throw new Error("analysis-request-required");
    const controller = new AbortController(); this.preparing.add(controller);
    try {
      await this.initialize(); if (controller.signal.aborted) throw new Error("analysis-reading-cancelled");
      const manifest = await freezeManifest(input.projectId, this.reader(input.projectId, controller.signal));
      if (controller.signal.aborted) throw new Error("analysis-reading-cancelled");
      return await this.coordinator!.create(input.request, manifest, scope, PROJECT_ANALYSIS_SPEC);
    } finally { this.preparing.delete(controller); }
  }
  async reload(id: string): Promise<AnalysisJob> { await this.initialize(); return this.coordinator!.reload(id); }
  /** Observation only: unlike explicit recovery, never mutates status/lease/usage. */
  async observe(id: string): Promise<AnalysisJob> { await this.initialize(); return this.coordinator!.store.read(id); }
  async approve(id: string, consent: { identityHash: string; authorizationRevision: number; accepted: true }): Promise<AnalysisJob> {
    await this.initialize(); const job = await this.coordinator!.store.read(id);
    if (consent.accepted !== true || consent.identityHash !== job.identityHash || consent.authorizationRevision !== job.authorizationRevision) throw new Error("analysis-current-consent-required");
    const live = this.identity(); for (const key of ["profile", "profileRevision", "model", "destination"] as const) if (live[key] !== job.authorization.profile[key]) throw new Error("analysis-sdk-identity-changed");
    return this.coordinator!.approve(id, approvalFor(job, Date.now(), null));
  }
  async continue(id: string, explicitUserContinue: true): Promise<AnalysisJob> {
    const stop = this.stopRevision.get(id) || 0;
    await this.initialize(); if (explicitUserContinue !== true) throw new Error("analysis-explicit-continue-required");
    if ((this.stopRevision.get(id) || 0) !== stop) throw new Error("analysis-start-stopped");
    if (this.running.has(id)) throw new Error("analysis-job-already-running");
    this.running.add(id);
    try { return await this.sdkJobLock!(() => {
      if (this.disposed || (this.stopRevision.get(id) || 0) !== stop) throw new Error("analysis-start-stopped");
      return this.coordinator!.run(id, { explicitUserContinue: true, owner: "desktop:" + newId() });
    }); }
    finally { this.running.delete(id); }
  }
  async pause(id: string): Promise<AnalysisJob> { this.stopRevision.set(id, (this.stopRevision.get(id) || 0) + 1); await this.initialize(); return this.coordinator!.pause(id); }
  async cancel(id: string): Promise<AnalysisJob> { this.stopRevision.set(id, (this.stopRevision.get(id) || 0) + 1); await this.initialize(); return this.coordinator!.cancel(id); }
  cancelPreparation(): void { for (const c of this.preparing) c.abort(); }
  async reprepare(id: string, input: AnalysisPreparation): Promise<AnalysisJob> {
    const scope = this.authorization(input);
    const controller = new AbortController(); this.preparing.add(controller);
    try {
      await this.initialize(); if (controller.signal.aborted) throw new Error("analysis-reading-cancelled");
      const old = await this.coordinator!.store.read(id);
      if (old.request !== input.request) throw new Error("analysis-new-request-needs-new-job");
      const manifest = await freezeManifest(input.projectId, this.reader(input.projectId, controller.signal));
      if (controller.signal.aborted || this.disposed) throw new Error("analysis-reading-cancelled");
      return await this.coordinator!.rebind(id, manifest, scope, PROJECT_ANALYSIS_SPEC);
    } finally { this.preparing.delete(controller); }
  }
  async report(id: string): Promise<string> { await this.initialize(); return (await this.coordinator!.snapshotReport(id)).markdown; }
  async saveReport(id: string, explicitUserSave: true): Promise<AnalysisJob> {
    if (explicitUserSave !== true) throw new Error("analysis-explicit-report-save-required"); await this.initialize();
    const current = await this.coordinator!.store.read(id), identity = this.identity();
    for (const key of ["profile", "profileRevision", "model", "destination"] as const) if (identity[key] !== current.authorization.profile[key]) throw new Error("analysis-sdk-identity-changed");
    return this.coordinator!.publishReport(id, newId(), { apply: async (effect, markdown) => {
      const path = this.filesystem().path("Reports", "AgentAnalysis", `${id}-${effect.effectId}.md`);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing) {
        if (!(existing instanceof TFile) || await this.app.vault.read(existing) !== markdown) throw new Error("analysis-report-existing-content-preserved");
      } else {
        const parts = path.split("/").slice(0, -1); let folder = "";
        for (const p of parts) { folder = folder ? `${folder}/${p}` : p;
          if (!this.app.vault.getAbstractFileByPath(folder)) try { await this.app.vault.createFolder(folder); }
          catch (e) { if (!this.app.vault.getAbstractFileByPath(folder)) throw e; }
        }
        await this.app.vault.create(path, markdown);
      }
      return `vault:${path}:${await hashText(markdown)}`;
    } });
  }
  dispose(): void {
    this.disposed = true; this.cancelPreparation();
    for (const id of this.running) void this.coordinator?.interrupt(id).catch(() => undefined);
    // SDK is owned by main, not disposed here. Pending checkpoints retain usage/uncertainty.
  }
}
