export interface PrefetchIdentity {
  question: string;
  project: string;
  account: string;
  indexVersion: string;
  config: string;
  session: string;
}

export function prefetchKey(identity: PrefetchIdentity): string {
  // In-memory only. Length framing prevents scope/key ambiguities.
  return JSON.stringify([
    identity.question.trim().replace(/\s+/gu, " "), identity.project,
    identity.account, identity.indexVersion, identity.config, identity.session
  ]);
}

export class ContextPrefetchCache<T> {
  private entries = new Map<string, { expires: number; value: T }>();
  private pending = new Map<string, Promise<T | undefined>>();
  private generation = 0;
  constructor(private ttlMs = 300_000, private capacity = 12, private timeoutMs = 2000) {}

  get(identity: PrefetchIdentity): T | undefined {
    const key = prefetchKey(identity);
    const entry = this.entries.get(key);
    if (!entry || entry.expires <= Date.now()) { this.entries.delete(key); return undefined; }
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }

  async prefetch(identity: PrefetchIdentity, build: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    const cached = this.get(identity);
    if (cached !== undefined) return cached;
    const key = prefetchKey(identity);
    if (this.pending.has(key)) return this.pending.get(key);
    const generation = this.generation;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.race([
      Promise.resolve().then(() => build(controller.signal)),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(undefined); }, this.timeoutMs); })
    ]).catch(() => undefined).then((value) => {
      if (value !== undefined && !controller.signal.aborted && generation === this.generation) {
        this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
        while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
      }
      return generation === this.generation ? value : undefined;
    }).finally(() => { if (timer) clearTimeout(timer); if (this.pending.get(key) === work) this.pending.delete(key); });
    this.pending.set(key, work);
    return work;
  }

  clear(): void { this.generation++; this.entries.clear(); this.pending.clear(); }
}
