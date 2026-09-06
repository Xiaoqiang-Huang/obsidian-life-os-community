import type { App } from "obsidian";
import {
  localizeLifeOsPathParts,
  normalizeAgentMemoryMinConfidence,
  normalizeAgentMemoryRetentionDays,
  normalizeDirectoryLanguage,
  type PersonalLifeSystemSettings
} from "../../settings";
import { normalizePath } from "../../utils/vault";
import type {
  AgentMemoryCandidate,
  AgentMemoryDiagnostics,
  AgentMemoryExtractionJob,
  AgentMemoryRecallResult,
  AgentMemoryRecord,
  AgentMemoryScope,
  AgentMemoryStoreState,
  AgentSkillSuggestion
} from "./AgentMemoryTypes";

interface StructuralVault {
  getAbstractFileByPath?: (path: string) => unknown;
  read?: (file: unknown) => Promise<string>;
  createFolder?: (path: string) => Promise<unknown>;
  create?: (path: string, content: string) => Promise<unknown>;
  modify?: (file: unknown, content: string) => Promise<void>;
}

const MAX_RECORDS = 2_000;
const MAX_JOBS = 500;
const MAX_FORGOTTEN = 2_000;
const MAX_SUGGESTIONS = 100;

/** Durable generated recall registry, extraction queue and Skill suggestions. */
export class AgentMemoryStore {
  private cache: AgentMemoryStoreState | null = null;
  private loadedStorePath = "";
  private mutationQueue: Promise<void> = Promise.resolve();
  private volatileLastError = "";

  constructor(
    private app?: App,
    private getSettings?: () => Partial<PersonalLifeSystemSettings>
  ) {}

  async listRecords(includeInactive = false): Promise<AgentMemoryRecord[]> {
    const state = await this.loadState();
    return state.records
      .filter((record) => includeInactive || !["forgotten", "superseded"].includes(record.status))
      .map((record) => this.clone(record))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listSkillSuggestions(): Promise<AgentSkillSuggestion[]> {
    const state = await this.loadState();
    return state.skillSuggestions
      .filter((item) => item.status === "candidate" && item.occurrences >= 3)
      .map((item) => ({ ...item }))
      .sort((a, b) => b.occurrences - a.occurrences || b.updatedAt.localeCompare(a.updatedAt));
  }

  async enqueue(job: AgentMemoryExtractionJob): Promise<boolean> {
    let inserted = false;
    await this.mutate((state) => {
      const existing = state.jobs.find((item) => item.fingerprint === job.fingerprint);
      if (existing) return;
      state.jobs.push(this.sanitizeJob(job));
      state.jobs = state.jobs.slice(-MAX_JOBS);
      inserted = true;
    });
    return inserted;
  }

  async claimJobs(limit: number, now = new Date(), leaseMs = 60_000): Promise<AgentMemoryExtractionJob[]> {
    const claimed: AgentMemoryExtractionJob[] = [];
    await this.mutate((state) => {
      for (const job of state.jobs) {
        if (claimed.length >= Math.max(1, limit)) break;
        const leaseExpired = job.status === "processing"
          && (!job.leaseUntil || new Date(job.leaseUntil).getTime() <= now.getTime());
        if (job.status !== "queued" && job.status !== "failed" && !leaseExpired) continue;
        // The retry budget belongs to the job, not to a particular status.
        // A process can crash after claiming a job, leaving it in `processing`;
        // an expired lease is recoverable, but must not reset/bypass the cap.
        if (job.attempts >= 3) continue;
        job.status = "processing";
        job.attempts += 1;
        job.updatedAt = now.toISOString();
        job.leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
        delete job.error;
        claimed.push(this.clone(job));
      }
    });
    return claimed;
  }

  async completeJob(jobId: string, candidates: AgentMemoryCandidate[]): Promise<{ added: number; updated: number }> {
    let added = 0;
    let updated = 0;
    await this.mutate((state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job || job.status === "completed") return;
      for (const candidate of candidates) {
        const outcome = this.upsertCandidateInState(state, candidate);
        if (outcome === "added") added += 1;
        if (outcome === "updated") updated += 1;
      }
      job.status = "completed";
      job.updatedAt = new Date().toISOString();
      delete job.leaseUntil;
      delete job.error;
    });
    await this.refreshReadPath();
    return { added, updated };
  }

  async failJob(jobId: string, error: unknown): Promise<void> {
    await this.mutate((state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job || job.status === "completed") return;
      job.status = "failed";
      job.updatedAt = new Date().toISOString();
      job.error = this.clean(error, 500);
      delete job.leaseUntil;
      state.lastError = job.error;
    });
  }

  async upsertCandidate(candidate: AgentMemoryCandidate): Promise<"added" | "updated" | "ignored"> {
    let outcome: "added" | "updated" | "ignored" = "ignored";
    await this.mutate((state) => {
      outcome = this.upsertCandidateInState(state, candidate);
    });
    if (outcome !== "ignored") await this.refreshReadPath();
    return outcome;
  }

  async recall(query: string, scope: AgentMemoryScope, limit = 2): Promise<AgentMemoryRecallResult> {
    const state = await this.loadState();
    const queryKeywords = tokenizeAgentMemory(query);
    const minimum = normalizeAgentMemoryMinConfidence(this.getSettings?.().agentMemoryMinConfidence);
    const now = Date.now();
    const candidates = state.records
      .filter((record) => this.scopeMatches(record.scope, scope))
      .filter((record) => record.status === "confirmed" || record.status === "candidate")
      .filter((record) => record.confidence >= minimum)
      .map((record) => ({ record, score: this.recallScore(record, queryKeywords, now) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt));
    const records = candidates.slice(0, Math.max(0, Math.min(4, limit))).map((item) => this.clone(item.record));
    if (records.length > 0) {
      const accessed = new Set(records.map((record) => record.id));
      await this.mutate((draft) => {
        const timestamp = new Date().toISOString();
        for (const record of draft.records) {
          if (accessed.has(record.id)) record.lastAccessedAt = timestamp;
        }
      });
    }
    const prompt = records.length
      ? records.map((record, index) => {
        const evidence = record.evidence[0];
        const scopeLabel = record.scope.projectScopeId ? `项目 ${record.scope.projectScopeId}` : "全局";
        const freshness = this.freshnessLabel(record.updatedAt, now);
        return [
          `[M${index + 1}] ${record.title}`,
          `内容：${record.content}`,
          `状态：${record.status}；更新时间：${record.updatedAt.slice(0, 10)}（新鲜度：${freshness}）；来源权威：${record.authority}；置信度：${record.confidence.toFixed(2)}；范围：${scopeLabel}`,
          evidence ? `证据：${evidence.excerpt}${evidence.path ? `（${evidence.path}）` : ""}` : "证据：无"
        ].join("\n");
      }).join("\n\n")
      : "本轮没有命中可用的长期回忆。";
    return {
      records,
      registryMatches: candidates.length,
      queryKeywords,
      scope: { ...scope },
      prompt
    };
  }

  async forget(recordId: string): Promise<boolean> {
    let changed = false;
    await this.mutate((state) => {
      const record = state.records.find((item) => item.id === recordId);
      if (!record || record.status === "forgotten") return;
      record.status = "forgotten";
      record.updatedAt = new Date().toISOString();
      state.forgottenFingerprints = Array.from(new Set([...state.forgottenFingerprints, record.fingerprint])).slice(-MAX_FORGOTTEN);
      changed = true;
    });
    if (changed) await this.refreshReadPath();
    return changed;
  }

  async confirm(recordId: string): Promise<boolean> {
    let changed = false;
    await this.mutate((state) => {
      const record = state.records.find((item) => item.id === recordId);
      if (!record || record.status === "forgotten") return;
      record.status = "confirmed";
      record.authority = "confirmed";
      record.confidence = Math.max(record.confidence, 0.92);
      record.updatedAt = new Date().toISOString();
      changed = true;
    });
    if (changed) await this.refreshReadPath();
    return changed;
  }

  async addSkillSuggestion(input: Omit<AgentSkillSuggestion, "id" | "createdAt" | "updatedAt">): Promise<void> {
    await this.mutate((state) => {
      const existing = state.skillSuggestions.find((item) => item.fingerprint === input.fingerprint);
      const now = new Date().toISOString();
      if (existing) {
        const previousOccurrences = existing.occurrences;
        existing.occurrences = Math.min(999, existing.occurrences + Math.max(1, input.occurrences));
        existing.title = input.title;
        existing.reason = input.reason;
        existing.examplePrompt = input.examplePrompt;
        existing.updatedAt = now;
        if (existing.status === "dismissed" && existing.occurrences >= previousOccurrences + 3) existing.status = "candidate";
        return;
      }
      state.skillSuggestions.push({
        ...input,
        id: `skill-${agentMemoryHash(input.fingerprint)}`,
        createdAt: now,
        updatedAt: now
      });
      state.skillSuggestions = state.skillSuggestions.slice(-MAX_SUGGESTIONS);
    });
  }

  async dismissSkillSuggestion(id: string): Promise<boolean> {
    let changed = false;
    await this.mutate((state) => {
      const suggestion = state.skillSuggestions.find((item) => item.id === id);
      if (!suggestion) return;
      suggestion.status = "dismissed";
      suggestion.updatedAt = new Date().toISOString();
      changed = true;
    });
    return changed;
  }

  async runMaintenance(now = new Date()): Promise<AgentMemoryDiagnostics> {
    const retentionMs = normalizeAgentMemoryRetentionDays(this.getSettings?.().agentMemoryRetentionDays) * 86_400_000;
    await this.mutate((state) => {
      for (const record of state.records) {
        if (record.status !== "candidate" || record.kind === "correction" || record.authority === "confirmed") continue;
        const updated = new Date(record.updatedAt).getTime();
        if (Number.isFinite(updated) && now.getTime() - updated > retentionMs) record.status = "stale";
      }
      state.jobs = state.jobs.filter((job) => {
        const updated = new Date(job.updatedAt).getTime();
        return job.status !== "completed" || !Number.isFinite(updated) || now.getTime() - updated <= 30 * 86_400_000;
      }).slice(-MAX_JOBS);
      state.lastMaintenanceAt = now.toISOString();
      delete state.lastError;
    });
    await this.refreshReadPath();
    return this.diagnostics();
  }

  async diagnostics(): Promise<AgentMemoryDiagnostics> {
    const state = await this.loadState();
    const latestRecordAt = state.records.reduce(
      (latest, item) => item.updatedAt.localeCompare(latest) > 0 ? item.updatedAt : latest,
      new Date(0).toISOString()
    );
    return {
      storeId: this.storeId(),
      schemaVersion: state.schemaVersion,
      recordCount: state.records.length,
      candidateCount: state.records.filter((item) => item.status === "candidate").length,
      confirmedCount: state.records.filter((item) => item.status === "confirmed").length,
      staleCount: state.records.filter((item) => item.status === "stale").length,
      forgottenCount: state.records.filter((item) => item.status === "forgotten").length,
      queuedJobCount: state.jobs.filter((item) => item.status === "queued" || item.status === "processing").length,
      failedJobCount: state.jobs.filter((item) => item.status === "failed").length,
      suggestionCount: state.skillSuggestions.filter((item) => item.status === "candidate" && item.occurrences >= 3).length,
      externalRecordCount: state.records.filter((item) => item.authority === "external").length,
      workingStateCount: 0,
      latestRecordAt,
      lastMaintenanceAt: state.lastMaintenanceAt,
      storePath: this.storePath(),
      readPath: this.readPath(),
      ...(this.volatileLastError || state.lastError
        ? { lastError: this.volatileLastError || state.lastError }
        : {})
    };
  }

  storePath(): string {
    return `${this.baseFolder()}/state.json`;
  }

  readPath(): string {
    return `${this.baseFolder()}/read-path.md`;
  }

  storeId(): string {
    return `agent-memory-${agentMemoryHash(this.baseFolder().toLocaleLowerCase())}`;
  }

  private async loadState(): Promise<AgentMemoryStoreState> {
    const currentStorePath = this.storePath();
    if (this.cache && this.loadedStorePath === currentStorePath) return this.cache;
    this.cache = null;
    this.loadedStorePath = currentStorePath;
    const vault = this.vault();
    if (vault?.getAbstractFileByPath && vault.read) {
      const file = vault.getAbstractFileByPath(currentStorePath);
      if (file) {
        try {
          const parsed = JSON.parse(await vault.read(file)) as Partial<AgentMemoryStoreState>;
          this.cache = this.normalizeState(parsed);
          return this.cache;
        } catch (error) {
          this.cache = this.emptyState();
          this.cache.lastError = `记忆索引读取失败：${this.clean(error, 240)}`;
          return this.cache;
        }
      }
    }
    this.cache = this.emptyState();
    return this.cache;
  }

  private async mutate(operation: (state: AgentMemoryStoreState) => void): Promise<void> {
    let thrown: unknown;
    const queued = this.mutationQueue.catch(() => undefined).then(async () => {
      const committed = await this.loadState();
      const draft = this.clone(committed);
      try {
        operation(draft);
        draft.records = draft.records.slice(-MAX_RECORDS);
        await this.writeFile(this.storePath(), `${JSON.stringify(draft, null, 2)}\n`);
        this.cache = draft;
        this.volatileLastError = "";
      } catch (error) {
        thrown = error;
        this.volatileLastError = this.clean(error, 500);
      }
    });
    this.mutationQueue = queued.catch(() => undefined);
    await queued;
    if (thrown) throw thrown;
  }

  private upsertCandidateInState(state: AgentMemoryStoreState, candidate: AgentMemoryCandidate): "added" | "updated" | "ignored" {
    const normalized = this.normalizeCandidate(candidate);
    const fingerprint = agentMemoryHash([
      normalized.kind,
      normalized.content.toLocaleLowerCase(),
      normalized.scope.projectScopeId || "global",
      normalized.scope.channel || "any",
      normalized.scope.accountId || "any"
    ].join("|"));
    if (state.forgottenFingerprints.includes(fingerprint)) return "ignored";
    const existing = state.records.find((record) => record.fingerprint === fingerprint);
    const now = new Date().toISOString();
    if (existing) {
      existing.title = normalized.title;
      existing.content = normalized.content;
      existing.keywords = Array.from(new Set([...existing.keywords, ...normalized.keywords])).slice(0, 40);
      existing.confidence = Math.max(existing.confidence, normalized.confidence);
      existing.evidence = this.mergeEvidence(existing.evidence, normalized.evidence);
      existing.updatedAt = now;
      return "updated";
    }
    const record: AgentMemoryRecord = {
      id: `memory-${fingerprint}`,
      ...normalized,
      status: "candidate",
      authority: normalized.authority || "generated",
      fingerprint,
      createdAt: now,
      updatedAt: now
    };
    if (record.kind === "correction") {
      const conflicts = state.records.filter((item) =>
        !["forgotten", "superseded"].includes(item.status)
        && item.status !== "confirmed"
        && item.authority !== "confirmed"
        && this.sameScope(item.scope, record.scope)
        && item.id !== record.id
        && item.keywords.some((keyword) => record.keywords.includes(keyword))
      );
      if (conflicts.length) {
        record.supersedes = conflicts.map((item) => item.id);
        for (const conflict of conflicts) conflict.status = "superseded";
      }
    }
    state.records.push(record);
    return "added";
  }

  private normalizeCandidate(candidate: AgentMemoryCandidate): AgentMemoryCandidate {
    return {
      kind: candidate.kind,
      title: this.clean(candidate.title, 120) || this.clean(candidate.content, 80),
      content: this.clean(candidate.content, 1_200),
      keywords: Array.from(new Set([...(candidate.keywords || []), ...tokenizeAgentMemory(candidate.content)]
        .map((item) => this.clean(item, 48).toLocaleLowerCase())
        .filter(Boolean))).slice(0, 40),
      scope: {
        ...(candidate.scope.projectScopeId ? { projectScopeId: this.clean(candidate.scope.projectScopeId, 180) } : {}),
        ...(candidate.scope.channel ? { channel: candidate.scope.channel } : {}),
        ...(candidate.scope.accountId ? { accountId: this.clean(candidate.scope.accountId, 220) } : {})
      },
      authority: candidate.authority || "generated",
      confidence: Math.min(1, Math.max(0, Number(candidate.confidence) || 0)),
      evidence: (candidate.evidence || []).slice(0, 12).map((item) => ({
        ...(item.sessionId ? { sessionId: this.clean(item.sessionId, 180) } : {}),
        ...(item.turnId ? { turnId: this.clean(item.turnId, 180) } : {}),
        ...(item.path ? { path: normalizePath(this.clean(item.path, 360)) } : {}),
        excerpt: this.clean(item.excerpt, 800),
        hash: this.clean(item.hash, 80) || agentMemoryHash(item.excerpt),
        capturedAt: this.date(item.capturedAt)
      })),
      ...(candidate.sourceTool ? { sourceTool: this.clean(candidate.sourceTool, 80) } : {})
    };
  }

  private normalizeState(value: Partial<AgentMemoryStoreState>): AgentMemoryStoreState {
    const empty = this.emptyState();
    return {
      schemaVersion: 1,
      records: Array.isArray(value.records)
        ? value.records.filter(Boolean).slice(-MAX_RECORDS).map((record) => this.sanitizeRecord(record as AgentMemoryRecord))
        : [],
      jobs: Array.isArray(value.jobs) ? value.jobs.filter(Boolean).slice(-MAX_JOBS).map((job) => this.sanitizeJob(job)) : [],
      skillSuggestions: Array.isArray(value.skillSuggestions)
        ? value.skillSuggestions.filter(Boolean).slice(-MAX_SUGGESTIONS).map((item) => this.sanitizeSuggestion(item as AgentSkillSuggestion))
        : [],
      forgottenFingerprints: Array.isArray(value.forgottenFingerprints)
        ? Array.from(new Set(value.forgottenFingerprints.map((item) => this.clean(item, 80)).filter(Boolean))).slice(-MAX_FORGOTTEN)
        : [],
      lastMaintenanceAt: this.date(value.lastMaintenanceAt || empty.lastMaintenanceAt),
      ...(value.lastError ? { lastError: this.clean(value.lastError, 500) } : {})
    };
  }

  private sanitizeJob(job: AgentMemoryExtractionJob): AgentMemoryExtractionJob {
    const status = ["queued", "processing", "completed", "failed"].includes(job.status) ? job.status : "queued";
    return {
      id: this.clean(job.id, 180),
      fingerprint: this.clean(job.fingerprint, 80),
      sessionId: this.clean(job.sessionId, 180),
      turnId: this.clean(job.turnId, 180),
      channel: job.channel === "weixin" ? "weixin" : "desktop",
      projectScopeId: this.clean(job.projectScopeId, 180),
      ...(job.accountScopeId ? { accountScopeId: this.clean(job.accountScopeId, 220) } : {}),
      userContent: this.clean(job.userContent, 8_000),
      assistantContent: this.clean(job.assistantContent, 8_000),
      toolSummaries: Array.isArray(job.toolSummaries) ? job.toolSummaries.map((item) => this.clean(item, 600)).filter(Boolean).slice(0, 20) : [],
      status: status as AgentMemoryExtractionJob["status"],
      attempts: Math.max(0, Math.floor(Number(job.attempts || 0))),
      createdAt: this.date(job.createdAt),
      updatedAt: this.date(job.updatedAt),
      ...(job.leaseUntil ? { leaseUntil: this.date(job.leaseUntil) } : {}),
      ...(job.error ? { error: this.clean(job.error, 500) } : {})
    };
  }

  private sanitizeRecord(record: AgentMemoryRecord): AgentMemoryRecord {
    const normalized = this.normalizeCandidate({
      kind: record.kind,
      title: record.title,
      content: record.content,
      keywords: record.keywords,
      scope: record.scope || {},
      authority: record.authority,
      confidence: record.confidence,
      evidence: record.evidence,
      sourceTool: record.sourceTool
    });
    const status = ["candidate", "confirmed", "stale", "superseded", "forgotten"].includes(record.status)
      ? record.status
      : "candidate";
    const fingerprint = this.clean(record.fingerprint, 80) || agentMemoryHash([
      normalized.kind,
      normalized.content.toLocaleLowerCase(),
      normalized.scope.projectScopeId || "global",
      normalized.scope.channel || "any",
      normalized.scope.accountId || "any"
    ].join("|"));
    return {
      id: this.clean(record.id, 180) || `memory-${fingerprint}`,
      ...normalized,
      status: status as AgentMemoryRecord["status"],
      authority: normalized.authority || "generated",
      fingerprint,
      createdAt: this.date(record.createdAt),
      updatedAt: this.date(record.updatedAt),
      ...(record.lastAccessedAt ? { lastAccessedAt: this.date(record.lastAccessedAt) } : {}),
      ...(Array.isArray(record.supersedes)
        ? { supersedes: record.supersedes.map((item) => this.clean(item, 180)).filter(Boolean).slice(0, 20) }
        : {})
    };
  }

  private sanitizeSuggestion(item: AgentSkillSuggestion): AgentSkillSuggestion {
    const fingerprint = this.clean(item.fingerprint, 80)
      || agentMemoryHash(`${item.title}|${item.examplePrompt}`);
    const status = ["candidate", "dismissed", "created"].includes(item.status) ? item.status : "candidate";
    return {
      id: this.clean(item.id, 180) || `skill-${fingerprint}`,
      title: this.clean(item.title, 120),
      reason: this.clean(item.reason, 500),
      examplePrompt: this.clean(item.examplePrompt, 1_200),
      occurrences: Math.max(1, Math.min(999, Math.floor(Number(item.occurrences) || 1))),
      status: status as AgentSkillSuggestion["status"],
      fingerprint,
      createdAt: this.date(item.createdAt),
      updatedAt: this.date(item.updatedAt)
    };
  }

  private recallScore(record: AgentMemoryRecord, queryKeywords: string[], now: number): number {
    const haystack = new Set([...record.keywords, ...tokenizeAgentMemory(`${record.title} ${record.content}`)]);
    const overlap = queryKeywords.filter((item) => haystack.has(item)).length;
    if (queryKeywords.length > 0 && overlap === 0) return 0;
    const age = now - new Date(record.updatedAt).getTime();
    const freshness = Number.isFinite(age) ? Math.max(0, 1 - age / (365 * 86_400_000)) : 0;
    const authority = record.authority === "confirmed" ? 1 : record.authority === "external" ? 0.72 : 0.58;
    const status = record.status === "confirmed" ? 0.25 : 0;
    return overlap * 2.5 + record.confidence + freshness * 0.35 + authority + status;
  }

  private freshnessLabel(updatedAt: string, now: number): string {
    const updated = new Date(updatedAt).getTime();
    if (!Number.isFinite(updated)) return "未知";
    const ageDays = Math.max(0, now - updated) / 86_400_000;
    if (ageDays <= 1) return "今天";
    if (ageDays <= 7) return "近 7 天";
    if (ageDays <= 30) return "近 30 天";
    if (ageDays <= 180) return "较早";
    return "陈旧";
  }

  private scopeMatches(record: AgentMemoryScope, requested: AgentMemoryScope): boolean {
    if (record.projectScopeId && record.projectScopeId !== requested.projectScopeId) return false;
    if (record.channel && record.channel !== requested.channel) return false;
    if (record.accountId && record.accountId !== requested.accountId) return false;
    return true;
  }

  private sameScope(left: AgentMemoryScope, right: AgentMemoryScope): boolean {
    return (left.projectScopeId || "") === (right.projectScopeId || "")
      && (left.channel || "") === (right.channel || "")
      && (left.accountId || "") === (right.accountId || "");
  }

  private mergeEvidence(left: AgentMemoryRecord["evidence"], right: AgentMemoryRecord["evidence"]): AgentMemoryRecord["evidence"] {
    const byHash = new Map(left.map((item) => [item.hash, item]));
    for (const item of right) byHash.set(item.hash, item);
    return Array.from(byHash.values()).slice(-12);
  }

  private async refreshReadPath(): Promise<void> {
    const state = await this.loadState();
    const active = state.records.filter((record) => record.status === "candidate" || record.status === "confirmed");
    const lines = [
      "---",
      "lifeos_type: agent-memory-read-path",
      `updated: ${new Date().toISOString()}`,
      "generated: true",
      "---",
      "",
      "# Agent 记忆读取路径",
      "",
      "> 这是系统生成的回忆索引，不是用户原文，也不能单独作为事实证据。删除或确认请在 Life OS 记忆页面完成。",
      ""
    ];
    for (const record of active.slice(0, 300)) {
      const scope = record.scope.projectScopeId ? `project:${record.scope.projectScopeId}` : "global";
      lines.push(`- [${record.status}] [${record.kind}] ${record.title} · ${scope} · ${record.confidence.toFixed(2)} · ${record.id}`);
    }
    await this.writeFile(this.readPath(), `${lines.join("\n")}\n`);
  }

  private emptyState(): AgentMemoryStoreState {
    return {
      schemaVersion: 1,
      records: [],
      jobs: [],
      skillSuggestions: [],
      forgottenFingerprints: [],
      lastMaintenanceAt: new Date(0).toISOString()
    };
  }

  private baseFolder(): string {
    const settings = this.getSettings?.() || {};
    const root = normalizePath(String(settings.rootFolder || "PersonalLifeSystem"));
    const parts = localizeLifeOsPathParts(["Memory", "Agent"], normalizeDirectoryLanguage(settings.directoryLanguage));
    return normalizePath([root, ...parts].join("/"));
  }

  private vault(): StructuralVault | undefined {
    return this.app?.vault as unknown as StructuralVault | undefined;
  }

  private async writeFile(path: string, content: string): Promise<void> {
    const vault = this.vault();
    if (!vault?.getAbstractFileByPath || !vault.create || !vault.modify) {
      throw new Error("当前 Vault 不支持持久化 Agent 记忆索引。");
    }
    await this.ensureFolders(path, vault);
    const file = vault.getAbstractFileByPath(path);
    if (file) await vault.modify(file, content);
    else await vault.create(path, content);
  }

  private async ensureFolders(path: string, vault: StructuralVault): Promise<void> {
    if (!vault.createFolder || !vault.getAbstractFileByPath) return;
    const folders = path.split("/").slice(0, -1);
    let current = "";
    for (const folder of folders) {
      current = current ? `${current}/${folder}` : folder;
      if (!vault.getAbstractFileByPath(current)) await vault.createFolder(current).catch(() => undefined);
    }
  }

  private date(value: unknown): string {
    const parsed = new Date(String(value || ""));
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
  }

  private clean(value: unknown, max: number): string {
    return String(value || "")
      .replace(/data:[^\s;]+;base64,[A-Za-z0-9+/=]+/giu, "[binary omitted]")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, max);
  }

  private clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

export function agentMemoryHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function tokenizeAgentMemory(value: string): string[] {
  const normalized = String(value || "").toLocaleLowerCase();
  const latin = normalized.match(/[a-z0-9][a-z0-9_.+-]{1,47}/gu) || [];
  const chinese = normalized.match(/[\p{Script=Han}]{2,12}/gu) || [];
  const stop = new Set(["这个", "那个", "一下", "可以", "还是", "进行", "需要", "用户", "当前", "已经", "没有", "什么", "怎么", "然后", "以及", "能够"]);
  return Array.from(new Set([...latin, ...chinese].filter((item) => !stop.has(item)))).slice(0, 80);
}
