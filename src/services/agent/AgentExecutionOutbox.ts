/** Durable per-turn receipts. A lost receipt is uncertain, never a licence to replay. */
export interface AgentOutboxPort { read(key: string): Promise<string | null>; write(key: string, value: string): Promise<void> }
interface Envelope { version: 1; identity: string; effects: Record<string, { status: "pending" | "applied" | "uncertain"; payloadHash: string; result?: unknown }> }
export class AgentExecutionOutbox {
  private static queues = new Map<string, Promise<unknown>>();
  constructor(private port: AgentOutboxPort, private namespace: string) {}
  private async hash(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map(x => x.toString(16).padStart(2, "0")).join(""); }
  /** Scope new receipts by account/channel/session. Preserve old unscoped receipts
   * (including uncertainty) rather than silently replaying a migrated turn. */
  async scopedEffect<T>(turn: string, scope: string, identity: string, kind: string, payload: string, apply: () => Promise<T>): Promise<T> {
    if (!scope || !turn) throw new Error("agent-outbox-scope-required");
    const legacy = await this.port.read(await this.hash(turn));
    return this.effect(legacy ? turn : JSON.stringify([scope, turn]), identity, kind, payload, apply);
  }
  async effect<T>(turn: string, identity: string, kind: string, payload: string, apply: () => Promise<T>, reconcile?: () => Promise<T | undefined>): Promise<T> {
    const key = await this.hash(turn), hash = await this.hash(payload), queue = this.namespace + ":" + key;
    const next = (AgentExecutionOutbox.queues.get(queue) || Promise.resolve()).catch(() => undefined).then(async () => {
      const raw = await this.port.read(key);
      const record: Envelope = raw ? JSON.parse(raw) : { version: 1, identity, effects: {} };
      if (record.version !== 1 || record.identity !== identity) throw new Error("agent-outbox-identity-changed");
      const effect = record.effects[kind];
      if (effect) {
        if (effect.payloadHash !== hash) throw new Error("agent-outbox-payload-changed");
        if (effect.status === "applied") return effect.result as T;
        const result = await reconcile?.();
        if (result !== undefined) { record.effects[kind] = { status: "applied", payloadHash: hash, result }; await this.port.write(key, JSON.stringify(record)); return result; }
        effect.status = "uncertain"; await this.port.write(key, JSON.stringify(record));
        throw new Error("agent-outbox-reconciliation-required");
      }
      record.effects[kind] = { status: "pending", payloadHash: hash }; await this.port.write(key, JSON.stringify(record));
      const result = await apply();
      record.effects[kind] = { status: "applied", payloadHash: hash, result }; await this.port.write(key, JSON.stringify(record));
      return result;
    });
    AgentExecutionOutbox.queues.set(queue, next);
    try { return await next; } finally { if (AgentExecutionOutbox.queues.get(queue) === next) AgentExecutionOutbox.queues.delete(queue); }
  }
}
