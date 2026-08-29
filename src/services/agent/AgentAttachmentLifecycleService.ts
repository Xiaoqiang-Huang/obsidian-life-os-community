import type {
  LifeOSAgentAttachment,
  LifeOSAgentAttachmentState
} from "./LifeOSAgentTypes";

const DEFAULT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_PER_SESSION = 24;

/**
 * Turn-scoped attachment state machine.
 *
 * Attachments are never inherited merely because a Skill was selected. A
 * caller must bind a pending resource to the current turn or explicitly
 * resolve a reference such as “上一张图”.
 */
export class AgentAttachmentLifecycleService {
  private readonly records = new Map<string, LifeOSAgentAttachment[]>();

  constructor(
    private retentionMs = DEFAULT_RETENTION_MS,
    private maxPerSession = DEFAULT_MAX_PER_SESSION
  ) {}

  stage(
    sessionId: string,
    attachments: Array<Partial<LifeOSAgentAttachment> & Pick<LifeOSAgentAttachment, "kind" | "name">>,
    sourceMessageId = "",
    now = new Date()
  ): LifeOSAgentAttachment[] {
    this.prune(now.getTime());
    const current = this.records.get(sessionId) || [];
    const additions: LifeOSAgentAttachment[] = [];
    const staged = attachments.map((item, index) => {
      const id = item.id || this.idFor(sessionId, sourceMessageId, item.name, index);
      const existing = current.find((record) => record.id === id)
        || additions.find((record) => record.id === id);
      if (existing) return existing;
      const timestamp = now.toISOString();
      const created: LifeOSAgentAttachment = {
        id,
        sessionId,
        sourceMessageId: item.sourceMessageId || sourceMessageId,
        state: "pending" as const,
        kind: item.kind,
        name: item.name,
        mimeType: item.mimeType,
        vaultPath: item.vaultPath,
        createdAt: item.createdAt || timestamp,
        updatedAt: timestamp,
        ordinal: current.length + index + 1,
        metadata: item.metadata
      };
      additions.push(created);
      return created;
    });
    // `stage` is also the retry boundary.  Return the existing record to the
    // caller, but append only genuinely new records to durable session state.
    this.records.set(sessionId, [...current, ...additions].slice(-this.maxPerSession));
    return staged.map((item) => ({ ...item }));
  }

  bindPending(sessionId: string, turnId: string, sourceMessageId = turnId, now = new Date()): LifeOSAgentAttachment[] {
    return this.transition(sessionId, (item) => item.state === "pending" && item.sourceMessageId === sourceMessageId, "bound", now, (item) => ({
      ...item,
      boundTurnId: turnId
    }));
  }

  markConsumed(sessionId: string, turnId: string, now = new Date()): LifeOSAgentAttachment[] {
    return this.transition(
      sessionId,
      (item) => item.boundTurnId === turnId && item.state === "bound",
      "consumed",
      now,
      (item) => ({ ...item, consumedAt: now.toISOString() })
    );
  }

  markReferenceable(sessionId: string, turnId: string, now = new Date()): LifeOSAgentAttachment[] {
    return this.transition(
      sessionId,
      (item) => item.boundTurnId === turnId && (item.state === "bound" || item.state === "consumed"),
      "referenceable",
      now,
      (item) => ({ ...item, consumedAt: item.consumedAt || now.toISOString() })
    );
  }

  resolveReference(
    sessionId: string,
    reference: { id?: string; ordinal?: number; kind?: LifeOSAgentAttachment["kind"] } = {},
    now = new Date()
  ): LifeOSAgentAttachment[] {
    this.prune(now.getTime());
    const candidates = (this.records.get(sessionId) || [])
      .filter((item) => item.state === "referenceable" || item.state === "consumed")
      .filter((item) => !reference.kind || item.kind === reference.kind);
    let resolved: LifeOSAgentAttachment[] = [];
    if (reference.id) resolved = candidates.filter((item) => item.id === reference.id);
    else if (reference.ordinal) resolved = candidates.filter((item) => item.ordinal === reference.ordinal);
    else {
      const latestMessage = candidates[candidates.length - 1]?.sourceMessageId;
      resolved = latestMessage
        ? candidates.filter((item) => item.sourceMessageId === latestMessage)
        : [];
    }
    const ids = new Set(resolved.map((item) => item.id));
    const timestamp = now.toISOString();
    this.records.set(sessionId, (this.records.get(sessionId) || []).map((item) => ids.has(item.id)
      ? { ...item, state: "referenceable", lastReferencedAt: timestamp, updatedAt: timestamp }
      : item));
    return resolved.map((item) => ({ ...item, state: "referenceable", lastReferencedAt: timestamp, updatedAt: timestamp }));
  }

  archive(sessionId: string, predicate: (item: LifeOSAgentAttachment) => boolean = () => true, now = new Date()): number {
    const changed = this.transition(sessionId, predicate, "archived", now);
    return changed.length;
  }

  list(sessionId: string, states?: LifeOSAgentAttachmentState[]): LifeOSAgentAttachment[] {
    const allowed = states ? new Set(states) : null;
    return (this.records.get(sessionId) || [])
      .filter((item) => !allowed || allowed.has(item.state))
      .map((item) => ({ ...item }));
  }

  clear(sessionId: string): void {
    this.records.delete(sessionId);
  }

  prune(now = Date.now()): void {
    for (const [sessionId, items] of this.records.entries()) {
      const retained = items.filter((item) => Date.parse(item.createdAt) + this.retentionMs > now);
      if (retained.length > 0) this.records.set(sessionId, retained.slice(-this.maxPerSession));
      else this.records.delete(sessionId);
    }
  }

  private transition(
    sessionId: string,
    predicate: (item: LifeOSAgentAttachment) => boolean,
    state: LifeOSAgentAttachmentState,
    now: Date,
    decorate: (item: LifeOSAgentAttachment) => LifeOSAgentAttachment = (item) => item
  ): LifeOSAgentAttachment[] {
    const timestamp = now.toISOString();
    const changed: LifeOSAgentAttachment[] = [];
    const next = (this.records.get(sessionId) || []).map((item) => {
      if (!predicate(item)) return item;
      const updated = { ...decorate(item), state, updatedAt: timestamp };
      changed.push(updated);
      return updated;
    });
    this.records.set(sessionId, next);
    return changed.map((item) => ({ ...item }));
  }

  private idFor(sessionId: string, sourceMessageId: string, name: string, index: number): string {
    const value = `${sessionId}\u001f${sourceMessageId}\u001f${name}\u001f${index}`;
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return `att-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }
}
