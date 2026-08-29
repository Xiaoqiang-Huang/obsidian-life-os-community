import type { App } from "obsidian";
import type { PersonalLifeSystemSettings } from "../../settings";
import type { LifeOSAgentEvent } from "./LifeOSAgentTypes";

const MAX_MEMORY_EVENTS = 800;

/** Append-only execution ledger. Markdown chat files remain a projection. */
export class AgentEventStore {
  private readonly memory = new Map<string, LifeOSAgentEvent[]>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private app?: App,
    private getSettings?: () => Partial<PersonalLifeSystemSettings>
  ) {}

  async append(event: LifeOSAgentEvent): Promise<void> {
    const current = this.memory.get(event.sessionId) || [];
    current.push(this.sanitize(event));
    this.memory.set(event.sessionId, current.slice(-MAX_MEMORY_EVENTS));
    await this.appendToVault(event).catch(() => undefined);
  }

  async appendMany(events: LifeOSAgentEvent[]): Promise<void> {
    for (const event of events) await this.append(event);
  }

  async replay(sessionId: string): Promise<LifeOSAgentEvent[]> {
    const inMemory = this.memory.get(sessionId);
    if (inMemory?.length) return inMemory.map((item) => ({ ...item }));
    const vault = this.app?.vault as unknown as {
      getAbstractFileByPath?: (path: string) => unknown;
      read?: (file: unknown) => Promise<string>;
    } | undefined;
    if (!vault?.getAbstractFileByPath || !vault.read) return [];
    const file = vault.getAbstractFileByPath(this.pathFor(sessionId));
    if (!file) return [];
    try {
      const events = (await vault.read(file))
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LifeOSAgentEvent)
        .filter((item) => item.sessionId === sessionId)
        .slice(-MAX_MEMORY_EVENTS);
      this.memory.set(sessionId, events);
      return events.map((item) => ({ ...item }));
    } catch {
      return [];
    }
  }

  clearMemory(sessionId?: string): void {
    if (sessionId) this.memory.delete(sessionId);
    else this.memory.clear();
  }

  private async appendToVault(event: LifeOSAgentEvent): Promise<void> {
    const vault = this.app?.vault as unknown as {
      getAbstractFileByPath?: (path: string) => unknown;
      createFolder?: (path: string) => Promise<unknown>;
      create?: (path: string, content: string) => Promise<unknown>;
      append?: (file: unknown, content: string) => Promise<void>;
    } | undefined;
    if (!vault?.getAbstractFileByPath || !vault.create || !vault.append) return;
    const path = this.pathFor(event.sessionId);
    const operation = (this.queues.get(path) || Promise.resolve()).catch(() => undefined).then(async () => {
      let file = vault.getAbstractFileByPath?.(path);
      if (!file) {
        const folders = path.split("/").slice(0, -1);
        let current = "";
        for (const folder of folders) {
          current = current ? `${current}/${folder}` : folder;
          if (!vault.getAbstractFileByPath?.(current) && vault.createFolder) {
            await vault.createFolder(current).catch(() => undefined);
          }
        }
        file = await vault.create?.(path, "");
      }
      if (file) await vault.append?.(file, `${JSON.stringify(this.sanitize(event))}\n`);
    });
    const tracked = operation.catch(() => undefined);
    this.queues.set(path, tracked);
    try {
      await operation;
    } finally {
      if (this.queues.get(path) === tracked) this.queues.delete(path);
    }
  }

  private pathFor(sessionId: string): string {
    const root = String(this.getSettings?.().rootFolder || "PersonalLifeSystem").replace(/[\\/]+$/u, "");
    return `${root}/Chat/Agent/Events/${this.safeId(sessionId)}.jsonl`;
  }

  private safeId(value: string): string {
    const readable = value.replace(/[^a-z0-9_-]+/giu, "-").replace(/^-+|-+$/gu, "").slice(0, 72);
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    const suffix = (hash >>> 0).toString(16).padStart(8, "0");
    return readable ? `${readable.slice(0, 63)}-${suffix}` : `session-${suffix}`;
  }

  private sanitize(event: LifeOSAgentEvent): LifeOSAgentEvent {
    const compact = (value: string | undefined, max: number) => String(value || "")
      .replace(/data:[^\s;]+;base64,[A-Za-z0-9+/=]+/giu, "[binary omitted]")
      .slice(0, max);
    return {
      ...event,
      summary: compact(event.summary, 500),
      ...(event.detail ? { detail: compact(event.detail, 4_000) } : {})
    };
  }
}
