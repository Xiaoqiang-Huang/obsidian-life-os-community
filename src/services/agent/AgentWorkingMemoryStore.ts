import type { App } from "obsidian";
import {
  localizeLifeOsPathParts,
  normalizeAgentMemoryIdleHours,
  normalizeDirectoryLanguage,
  type PersonalLifeSystemSettings
} from "../../settings";
import { normalizePath } from "../../utils/vault";
import type { AgentWorkingMemoryState } from "./AgentMemoryTypes";
import type { LifeOSAgentChannel } from "./LifeOSAgentTypes";

export interface AgentWorkingMemoryScopeQuery {
  channel: LifeOSAgentChannel;
  projectScopeId: string;
  accountScopeId?: string;
}

interface StructuralVault {
  getAbstractFileByPath?: (path: string) => unknown;
  getFiles?: () => Array<{ path: string }>;
  read?: (file: unknown) => Promise<string>;
  createFolder?: (path: string) => Promise<unknown>;
  create?: (path: string, content: string) => Promise<unknown>;
  modify?: (file: unknown, content: string) => Promise<void>;
  delete?: (file: unknown, force?: boolean) => Promise<void>;
}

/**
 * Persists the compact, attachment-free working checkpoint for each chat.
 * JSON is intentionally stored in a visible, non-dot path because hidden
 * files are not indexed consistently by every Obsidian adapter.
 */
export class AgentWorkingMemoryStore {
  private readonly memory = new Map<string, AgentWorkingMemoryState>();
  private readonly queues = new Map<string, Promise<void>>();
  private activeFolderPath = "";

  constructor(
    private app?: App,
    private getSettings?: () => Partial<PersonalLifeSystemSettings>
  ) {}

  async load(sessionId: string, scope?: AgentWorkingMemoryScopeQuery): Promise<AgentWorkingMemoryState | null> {
    this.ensureActiveFolder();
    const key = scope ? this.storageKey(sessionId, scope) : "";
    const cached = key
      ? this.memory.get(key)
      : Array.from(this.memory.values())
        .filter((state) => state.sessionId === sessionId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (cached) return this.clone(cached);
    const vault = this.vault();
    if (!vault?.getAbstractFileByPath || !vault.read) return null;
    const paths = scope
      ? [this.pathFor(sessionId, scope), this.legacyPathFor(sessionId)]
      : [this.legacyPathFor(sessionId)];
    for (const path of paths) {
      const file = vault.getAbstractFileByPath(path);
      if (!file) continue;
      try {
        const parsed = JSON.parse(await vault.read(file)) as Partial<AgentWorkingMemoryState>;
        const normalized = this.normalizeState(sessionId, parsed);
        if (!normalized || this.isExpired(normalized) || (scope && !this.matchesScope(normalized, scope))) continue;
        this.memory.set(this.storageKey(normalized.sessionId, normalized), normalized);
        if (scope && path === this.legacyPathFor(sessionId)) await this.migrateLegacy(path, normalized, vault);
        return this.clone(normalized);
      } catch {
        // A malformed or stale checkpoint must not block the active conversation.
      }
    }
    if (!scope) {
      const states = (await this.listInternal(false))
        .filter((state) => state.sessionId === sessionId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return states[0] ? this.clone(states[0]) : null;
    }
    return null;
  }

  async save(state: AgentWorkingMemoryState): Promise<void> {
    this.ensureActiveFolder();
    const normalized = this.normalizeState(state.sessionId, state);
    if (!normalized || normalized.policy.temporary) return;
    const key = this.storageKey(normalized.sessionId, normalized);
    await this.writeJson(this.pathFor(normalized.sessionId, normalized), normalized);
    // A checkpoint is committed in memory only after the same value reached
    // disk. Otherwise a failed adapter write would appear to work until the
    // next restart and could contaminate later turns in the current process.
    this.memory.set(key, normalized);
  }

  async remove(sessionId: string, scope?: AgentWorkingMemoryScopeQuery): Promise<void> {
    this.ensureActiveFolder();
    for (const [key, state] of this.memory) {
      if (state.sessionId === sessionId && (!scope || this.matchesScope(state, scope))) this.memory.delete(key);
    }
    const vault = this.vault();
    if (!vault?.getAbstractFileByPath || !vault.delete) return;
    if (scope) {
      const file = vault.getAbstractFileByPath(this.pathFor(sessionId, scope));
      if (file) await vault.delete(file, true).catch(() => undefined);
      const legacy = vault.getAbstractFileByPath(this.legacyPathFor(sessionId));
      if (legacy && vault.read) {
        try {
          const parsed = JSON.parse(await vault.read(legacy)) as Partial<AgentWorkingMemoryState>;
          const normalized = this.normalizeState(sessionId, parsed);
          if (normalized && this.matchesScope(normalized, scope)) await vault.delete(legacy, true).catch(() => undefined);
        } catch {
          // Leave an unreadable legacy checkpoint for manual diagnostics.
        }
      }
      return;
    }
    const prefix = `${this.folderPath()}/`;
    for (const file of vault.getFiles?.() || []) {
      if (!file.path.startsWith(prefix) || !file.path.endsWith(".json")) continue;
      if (file.path === this.legacyPathFor(sessionId)) {
        await vault.delete(file, true).catch(() => undefined);
        continue;
      }
      if (!vault.read) continue;
      try {
        const parsed = JSON.parse(await vault.read(file)) as Partial<AgentWorkingMemoryState>;
        if (String(parsed.sessionId || "").trim() === sessionId) await vault.delete(file, true).catch(() => undefined);
      } catch {
        // Do not delete unrelated or damaged files by filename guesswork.
      }
    }
  }

  async list(): Promise<AgentWorkingMemoryState[]> {
    return this.listInternal(false);
  }

  private async listInternal(includeExpired: boolean): Promise<AgentWorkingMemoryState[]> {
    this.ensureActiveFolder();
    const found = new Map<string, AgentWorkingMemoryState>();
    for (const [key, state] of this.memory) {
      if (includeExpired || !this.isExpired(state)) found.set(key, this.clone(state));
    }
    const vault = this.vault();
    if (!vault?.getFiles || !vault.read) return Array.from(found.values());
    const prefix = `${this.folderPath()}/`;
    for (const file of vault.getFiles()) {
      if (!file.path.startsWith(prefix) || !file.path.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await vault.read(file)) as Partial<AgentWorkingMemoryState>;
        const sessionId = String(parsed.sessionId || "").trim();
        const normalized = sessionId ? this.normalizeState(sessionId, parsed) : null;
        if (normalized && (includeExpired || !this.isExpired(normalized))) {
          found.set(this.storageKey(sessionId, normalized), normalized);
        }
      } catch {
        // A damaged checkpoint is isolated to its session and never blocks Chat.
      }
    }
    return Array.from(found.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async pruneExpired(now = new Date()): Promise<number> {
    const states = await this.listInternal(true);
    const maxIdleMs = normalizeAgentMemoryIdleHours(this.getSettings?.().agentMemoryIdleHours) * 60 * 60 * 1000;
    let removed = 0;
    for (const state of states) {
      const updated = new Date(state.updatedAt).getTime();
      if (Number.isFinite(updated) && now.getTime() - updated <= maxIdleMs) continue;
      await this.remove(state.sessionId, state);
      removed += 1;
    }
    return removed;
  }

  pathFor(sessionId: string, scope?: AgentWorkingMemoryScopeQuery): string {
    const identity = scope ? this.storageKey(sessionId, scope) : sessionId;
    return `${this.folderPath()}/${this.safeId(identity)}.json`;
  }

  private legacyPathFor(sessionId: string): string {
    return `${this.folderPath()}/${this.safeId(sessionId)}.json`;
  }

  private folderPath(): string {
    const settings = this.getSettings?.() || {};
    const root = normalizePath(String(settings.rootFolder || "PersonalLifeSystem"));
    const parts = localizeLifeOsPathParts(
      ["Chat", "Agent", "Working State"],
      normalizeDirectoryLanguage(settings.directoryLanguage)
    );
    return normalizePath([root, ...parts].join("/"));
  }

  private ensureActiveFolder(): void {
    const folder = this.folderPath();
    if (folder === this.activeFolderPath) return;
    this.activeFolderPath = folder;
    this.memory.clear();
  }

  private storageKey(sessionId: string, scope: AgentWorkingMemoryScopeQuery): string {
    return [
      sessionId,
      scope.channel,
      String(scope.projectScopeId || "").trim(),
      String(scope.accountScopeId || "").trim()
    ].join("\u001f");
  }

  private matchesScope(state: AgentWorkingMemoryState, scope: AgentWorkingMemoryScopeQuery): boolean {
    return state.channel === scope.channel
      && state.projectScopeId === String(scope.projectScopeId || "").trim()
      && String(state.accountScopeId || "").trim() === String(scope.accountScopeId || "").trim();
  }

  private async migrateLegacy(
    legacyPath: string,
    state: AgentWorkingMemoryState,
    vault: StructuralVault
  ): Promise<void> {
    const scopedPath = this.pathFor(state.sessionId, state);
    if (legacyPath === scopedPath) return;
    await this.writeJson(scopedPath, state);
    const legacy = vault.getAbstractFileByPath?.(legacyPath);
    if (legacy && vault.delete) await vault.delete(legacy, true).catch(() => undefined);
  }

  private isExpired(state: AgentWorkingMemoryState): boolean {
    const idleMs = normalizeAgentMemoryIdleHours(this.getSettings?.().agentMemoryIdleHours) * 60 * 60 * 1000;
    const updated = new Date(state.updatedAt).getTime();
    return Number.isFinite(updated) && Date.now() - updated > idleMs;
  }

  private normalizeState(sessionId: string, value: Partial<AgentWorkingMemoryState>): AgentWorkingMemoryState | null {
    if (!value.taskMemory || !value.checkpoint || !value.policy) return null;
    const compact = (input: unknown, max: number) => String(input || "")
      .replace(/data:[^\s;]+;base64,[A-Za-z0-9+/=]+/giu, "[binary omitted]")
      .slice(0, max);
    const list = (input: unknown, maxItems = 16) => Array.isArray(input)
      ? Array.from(new Set(input.map((item) => compact(item, 320).trim()).filter(Boolean))).slice(-maxItems)
      : [];
    const checkpoint = value.checkpoint;
    const task = value.taskMemory;
    return {
      schemaVersion: 1,
      sessionId,
      channel: value.channel === "weixin" ? "weixin" : "desktop",
      projectScopeId: compact(value.projectScopeId, 180).trim(),
      ...(value.accountScopeId ? { accountScopeId: compact(value.accountScopeId, 220).trim() } : {}),
      policy: {
        mode: value.policy.mode,
        use: value.policy.use === true,
        contribute: value.policy.contribute === true,
        temporary: value.policy.temporary === true
      },
      taskMemory: {
        sessionId,
        goal: compact(task.goal, 800),
        currentFocus: compact(task.currentFocus, 800),
        openItems: list(task.openItems),
        decisions: list(task.decisions),
        completedItems: list(task.completedItems),
        constraints: list(task.constraints),
        corrections: list(task.corrections),
        unresolved: list(task.unresolved),
        nextActions: list(task.nextActions),
        recentTopics: list(task.recentTopics),
        lastSummary: compact(task.lastSummary, 1_600),
        updatedAt: this.date(task.updatedAt)
      },
      checkpoint: {
        objective: compact(checkpoint.objective, 800),
        activeWork: compact(checkpoint.activeWork, 800),
        decisions: list(checkpoint.decisions),
        constraints: list(checkpoint.constraints),
        corrections: list(checkpoint.corrections),
        unresolved: list(checkpoint.unresolved),
        nextActions: list(checkpoint.nextActions),
        entities: list(checkpoint.entities),
        recentTopics: list(checkpoint.recentTopics),
        evidenceRefs: list(checkpoint.evidenceRefs)
      },
      compressedSummary: compact(value.compressedSummary, 8_000),
      compressedMessageCount: Math.max(0, Math.floor(Number(value.compressedMessageCount || 0))),
      compressedSourceCount: Math.max(0, Math.floor(Number(value.compressedSourceCount || 0))),
      lastTurnId: compact(value.lastTurnId, 180),
      lastTurnAt: this.date(value.lastTurnAt),
      updatedAt: this.date(value.updatedAt)
    };
  }

  private date(value: unknown): string {
    const date = new Date(String(value || ""));
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
  }

  private clone(state: AgentWorkingMemoryState): AgentWorkingMemoryState {
    return JSON.parse(JSON.stringify(state)) as AgentWorkingMemoryState;
  }

  private vault(): StructuralVault | undefined {
    return this.app?.vault as unknown as StructuralVault | undefined;
  }

  private async writeJson(path: string, value: AgentWorkingMemoryState): Promise<void> {
    const vault = this.vault();
    if (!vault?.getAbstractFileByPath || !vault.create || !vault.modify) {
      throw new Error("当前 Vault 不支持持久化 Agent 工作状态。");
    }
    const operation = (this.queues.get(path) || Promise.resolve()).catch(() => undefined).then(async () => {
      await this.ensureFolders(path, vault);
      const content = `${JSON.stringify(value, null, 2)}\n`;
      const file = vault.getAbstractFileByPath?.(path);
      if (file) await vault.modify?.(file, content);
      else await vault.create?.(path, content);
    });
    const tracked = operation.catch(() => undefined);
    this.queues.set(path, tracked);
    try {
      await operation;
    } finally {
      if (this.queues.get(path) === tracked) this.queues.delete(path);
    }
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

  private safeId(value: string): string {
    const readable = value.replace(/[^a-z0-9_-]+/giu, "-").replace(/^-+|-+$/gu, "").slice(0, 60);
    return `${readable || "session"}-${this.hash(value)}`;
  }

  private hash(value: string): string {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
}
