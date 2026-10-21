export interface RuntimePreparation {
  streamingAvailable: boolean;
  sdkLoaded: boolean;
}

/** Compatibility adapter for the canonical SDK bootstrap, NOT a second runtime.
 * Preparation only loads the pinned SDK module; it never dispatches a model
 * request, opens a socket, or writes a Vault file. Keys stay in memory. */
export class RuntimePrewarm<T> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private pending: Promise<T> | undefined;
  private key = "";
  private value: T | undefined;
  private disposed = false;
  private scheduled = false;
  private revision = 0;

  constructor(private readonly prepare: (signal: AbortSignal) => Promise<T>) {}

  schedule(desktop: boolean, key: () => string, delayMs = 20_000): void {
    if (!desktop || this.disposed || this.scheduled) return;
    this.scheduled = true;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.ready(key()).catch(() => undefined);
    }, Math.max(15_000, Math.min(30_000, delayMs)));
  }

  peek(key: string): T | undefined { return key === this.key ? this.value : undefined; }

  async ready(key: string, signal?: AbortSignal): Promise<T> {
    if (this.disposed || signal?.aborted) throw new Error("RUNTIME_PREPARATION_CANCELLED");
    if (key !== this.key) {
      this.controller?.abort();
      this.revision++;
      this.key = key;
      this.value = undefined;
      this.pending = undefined;
    }
    if (this.value !== undefined) return this.value;
    if (!this.pending) {
      const controller = new AbortController();
      this.controller = controller;
      const revision = this.revision;
      const preparation = Promise.resolve().then(() => this.prepare(controller.signal));
      const cancellable = new Promise<T>((resolve, reject) => {
        const abort = () => reject(new Error("RUNTIME_PREPARATION_CANCELLED"));
        controller.signal.addEventListener("abort", abort, { once: true });
        preparation.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", abort));
      });
      const pending = cancellable.then(value => {
        if (controller.signal.aborted || this.disposed || revision !== this.revision) {
          throw new Error("RUNTIME_PREPARATION_CANCELLED");
        }
        this.value = value;
        return value;
      }).finally(() => { if (this.pending === pending) this.pending = undefined; });
      this.pending = pending;
    }
    const work = this.pending;
    if (!signal) return work;
    return new Promise<T>((resolve, reject) => {
      const abort = () => { clean(); reject(new Error("RUNTIME_PREPARATION_CANCELLED")); };
      const clean = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      work.then(value => { clean(); resolve(value); }, error => { clean(); reject(error); });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.revision++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.pending = undefined;
    this.value = undefined;
  }
}

/** Local-only capability preparation used by fixtures and mobile guards. */
export async function prepareLocalAiRuntime(signal: AbortSignal): Promise<RuntimePreparation> {
  if (signal.aborted) throw new Error("RUNTIME_PREPARATION_CANCELLED");
  if (typeof TextDecoder !== "undefined") new TextDecoder("utf-8").decode(new Uint8Array());
  return {
    streamingAvailable: typeof fetch === "function" && typeof ReadableStream !== "undefined" && typeof TextDecoder !== "undefined",
    sdkLoaded: false
  };
}

/** Idle preparation for the pinned SDK module. It never calls query(). */
export async function prepareSdkRuntime(
  signal: AbortSignal,
  load: () => Promise<{ query?: unknown }> = async () => {
    const { loadClaudeSdk } = await import("../agent/backends/claude/ClaudeSdkRuntime");
    return loadClaudeSdk(true);
  }
): Promise<RuntimePreparation> {
  if (signal.aborted) throw new Error("RUNTIME_PREPARATION_CANCELLED");
  const sdk = await load();
  if (signal.aborted) throw new Error("RUNTIME_PREPARATION_CANCELLED");
  return { streamingAvailable: true, sdkLoaded: typeof sdk["query"] === "function" };
}
