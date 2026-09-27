import type { App, EventRef, TFile } from "obsidian";

export class VaultSnapshotChangedError extends Error {
  constructor() { super("文件在读取期间发生变化，请重试。"); }
}

export function throwIfReadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("读取已取消", "AbortError");
}

/** Cancel a consumer, not a shared/uncancellable Obsidian disk read. */
export function withReadSignal<T>(promise: Promise<T>, ...signals: Array<AbortSignal | undefined>): Promise<T> {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => active.forEach(signal => signal.removeEventListener("abort", abort));
    const abort = () => { cleanup(); reject(new DOMException("读取已取消", "AbortError")); };
    // Attach both handlers even if already aborted, so the disk promise cannot
    // later produce an unhandled rejection after its last consumer leaves.
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (active.some(signal => signal.aborted)) { abort(); return; }
    active.forEach(signal => signal.addEventListener("abort", abort, { once: true }));
  });
}

interface ReadEntry {
  file: TFile;
  stamp: string;
  promise: Promise<string>;
  readers: number;
  settled: boolean;
  cancelQueued?: () => void;
}

interface CachedText { file: TFile; stamp: string; text: string }

export interface VaultReadCacheOptions {
  maxEntries?: number;
  maxCharacters?: number;
  maxEntryCharacters?: number;
  concurrency?: number;
  maxQueuedReads?: number;
}

const caches = new WeakMap<App["vault"], VaultReadCache>();

/** Read-only snapshots. Mutation/conflict checks must keep using vault.read/process. */
export class VaultReadCache {
  private values = new Map<string, CachedText>();
  private pending = new Map<string, ReadEntry>();
  private refs: EventRef[] = [];
  private lifetime = new AbortController();
  private queue: Array<() => void> = [];
  private active = 0;
  private characters = 0;
  private limits: Required<VaultReadCacheOptions>;

  constructor(private vault: App["vault"], options: VaultReadCacheOptions = {}) {
    this.limits = {
      maxEntries: 512, maxCharacters: 8 * 1024 * 1024,
      maxEntryCharacters: 1024 * 1024, concurrency: 4, maxQueuedReads: 128,
      ...options
    };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid read-cache limit");
    }
    const invalidate = (file: { path: string }) => this.invalidate(file.path);
    this.refs.push(vault.on("create", invalidate), vault.on("modify", invalidate), vault.on("delete", invalidate));
    this.refs.push(vault.on("rename", (file, oldPath) => { this.invalidate(oldPath); this.invalidate(file.path); }));
  }

  async read(path: string, signal?: AbortSignal): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      throwIfReadAborted(signal);
      throwIfReadAborted(this.lifetime.signal);
      const file = snapshotFile(this.vault, path);
      const stamp = this.stamp(file);
      const cached = this.values.get(path);
      if (cached && cached.file === file && cached.stamp === stamp) {
        this.values.delete(path); this.values.set(path, cached);
        return cached.text;
      }
      this.dropValue(path);
      let entry = this.pending.get(path);
      if (!entry || entry.file !== file || entry.stamp !== stamp) {
        entry?.cancelQueued?.();
        entry = { file, stamp, readers: 0, settled: false, promise: Promise.resolve("") };
        const next = entry;
        this.pending.set(path, next);
        entry.promise = this.schedule(next, async () => {
          this.assertCurrent(path, next);
          const text = await this.vault.read(file);
          this.assertCurrent(path, next);
          this.store(path, { file, stamp, text });
          return text;
        }).finally(() => {
          next.settled = true;
          if (next.readers === 0 && this.pending.get(path) === next) this.pending.delete(path);
        });
      }
      const current = entry;
      current.readers++;
      try {
        const text = await withReadSignal(current.promise, signal, this.lifetime.signal);
        throwIfReadAborted(signal);
        // Keep the invalidation token until delivery, including oversized texts
        // that never enter the LRU. An edit may land between disk resolution and
        // this consumer's microtask, not only while disk I/O is still pending.
        this.assertCurrent(path, current);
        return text;
      } catch (error) {
        if (!(error instanceof VaultSnapshotChangedError)) throw error;
        // A read that raced an edit/rename never warms the cache or supplies old
        // text. Retry a bounded number of times against the current file object.
      } finally {
        current.readers--;
        if ((current.settled || signal?.aborted) && current.readers === 0 && this.pending.get(path) === current) {
          this.pending.delete(path);
          current.cancelQueued?.();
        }
      }
    }
    throw new VaultSnapshotChangedError();
  }

  invalidate(path: string): void {
    // Folder delete/rename invalidates descendants too. No growing path→version ledger.
    for (const key of this.values.keys()) if (key === path || key.startsWith(`${path}/`)) this.dropValue(key);
    for (const [key, entry] of this.pending) {
      if (key === path || key.startsWith(`${path}/`)) {
        this.pending.delete(key);
        entry.cancelQueued?.();
      }
    }
  }

  dispose(): void {
    this.lifetime.abort();
    this.refs.splice(0).forEach(ref => this.vault.offref(ref));
    this.values.clear(); this.pending.clear(); this.characters = 0;
    // Drain queued jobs as cancelled without waiting for an uninterruptible disk read.
    this.queue.splice(0).forEach(run => run());
  }

  diagnostics(): { entries: number; characters: number; active: number; queued: number } {
    return { entries: this.values.size, characters: this.characters, active: this.active, queued: this.queue.length };
  }

  private stamp(file: TFile): string { return `${file.path}:${file.stat?.mtime}:${file.stat?.size}`; }

  private assertCurrent(path: string, entry: ReadEntry): void {
    throwIfReadAborted(this.lifetime.signal);
    if (this.pending.get(path) !== entry || this.vault.getAbstractFileByPath(path) !== entry.file || this.stamp(entry.file) !== entry.stamp) {
      throw new VaultSnapshotChangedError();
    }
  }

  private dropValue(path: string): void {
    const old = this.values.get(path);
    if (old) this.characters -= old.text.length;
    this.values.delete(path);
  }

  private store(path: string, value: CachedText): void {
    if (value.text.length > Math.min(this.limits.maxEntryCharacters, this.limits.maxCharacters)) return;
    this.dropValue(path);
    this.values.set(path, value); this.characters += value.text.length;
    while (this.values.size > this.limits.maxEntries || this.characters > this.limits.maxCharacters) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.dropValue(oldest);
    }
  }

  private schedule<T>(entry: ReadEntry, operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limits.concurrency && this.queue.length >= this.limits.maxQueuedReads) {
      return Promise.reject(new Error("读取队列繁忙，请稍后重试。"));
    }
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        if (this.lifetime.signal.aborted) { reject(new DOMException("读取已取消", "AbortError")); return; }
        this.active++;
        Promise.resolve().then(operation).then(resolve, reject).finally(() => {
          this.active--;
          this.queue.shift()?.();
        });
      };
      if (this.active < this.limits.concurrency) run();
      else {
        this.queue.push(run);
        entry.cancelQueued = () => {
          const index = this.queue.indexOf(run);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(new VaultSnapshotChangedError());
        };
      }
    });
  }
}

function snapshotFile(vault: App["vault"], path: string): TFile {
  const file = vault.getAbstractFileByPath(path);
  if (!file || !("extension" in file)) throw new Error(`文件已不存在或不可读取：${path}`);
  return file as TFile;
}

/** One owner per plugin/Vault, not one listener set per transient service or view. */
export function installVaultReadCache(app: App, options?: VaultReadCacheOptions): () => void {
  const vault = app.vault;
  caches.get(vault)?.dispose();
  const cache = new VaultReadCache(vault, options);
  caches.set(vault, cache);
  return () => { cache.dispose(); if (caches.get(vault) === cache) caches.delete(vault); };
}

export async function readVaultSnapshot(app: App, path: string, signal?: AbortSignal): Promise<string> {
  throwIfReadAborted(signal);
  const cache = caches.get(app.vault);
  if (cache) return cache.read(path, signal);
  // Standalone service consumers still work without installing plugin listeners.
  return withReadSignal(app.vault.read(snapshotFile(app.vault, path)), signal);
}
