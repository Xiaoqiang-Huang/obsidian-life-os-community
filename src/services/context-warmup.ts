/** Desktop-only, best-effort warm-up for the shared local retrieval index.
 *
 * The first search in a large Vault pays for inventory + index construction
 * inside the tool call (F-01). This scheduler moves that one-time cost to an
 * idle window 30s after plugin load (D-14: the longer window also leaves the
 * first real turn to finish undisturbed). It never calls a model, never writes
 * to the Vault and never opens a second index: the callback is expected to call
 * ContextEngine.warmIndex(), which reuses HybridRetrievalService.ensureIndex().
 *
 * D-14 yielding: a live chat/agent request must not compete with the index
 * build. Before running, and again when a deferred idle callback fires, the
 * helper asks the read-only activity probe `isBusy`. A busy host postpones the
 * attempt by one full window instead of building the index concurrently; after
 * CONTEXT_WARMUP_MAX_ATTEMPTS busy windows the warm-up gives up silently.
 *
 * Failures stay silent by design (warm-up is not a user action). A pending
 * delay, retry or idle callback can be cancelled on unload. requestIdleCallback
 * is preferred when the host provides it; the 5s timeout bounds the wait so a
 * busy UI cannot postpone the warm-up forever.
 */
export const CONTEXT_WARMUP_DELAY_MS = 30_000;
export const CONTEXT_WARMUP_RETRY_MS = 30_000;
export const CONTEXT_WARMUP_MAX_ATTEMPTS = 3;
export const CONTEXT_WARMUP_IDLE_TIMEOUT_MS = 5_000;

export interface ContextWarmupEnvironment {
  isDesktop: boolean;
  warm: () => unknown;
  /** Read-only activity probe (no model call, no state change). A live
   * chat/agent request defers the warm-up; a broken probe never blocks it. */
  isBusy?: () => boolean;
  delayMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  idleTimeoutMs?: number;
  setTimeoutFn?: (handler: () => void, timeout: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  requestIdleCallback?: ((callback: () => void, options?: { timeout: number }) => unknown) | null;
  cancelIdleCallback?: ((handle: unknown) => void) | null;
}

export interface ContextWarmupHandle {
  cancel(): void;
}

export function scheduleContextIndexWarmup(environment: ContextWarmupEnvironment): ContextWarmupHandle {
  if (!environment.isDesktop) return { cancel: () => undefined };
  const schedule = environment.setTimeoutFn ?? ((handler: () => void, timeout: number) => setTimeout(handler, timeout));
  const unschedule = environment.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const maxAttempts = Math.max(1, Math.trunc(environment.maxAttempts ?? CONTEXT_WARMUP_MAX_ATTEMPTS) || 0);
  const firstDelay = environment.delayMs ?? CONTEXT_WARMUP_DELAY_MS;
  const retryDelay = environment.retryDelayMs ?? environment.delayMs ?? CONTEXT_WARMUP_RETRY_MS;
  let timer: unknown = null;
  let idle: unknown = null;
  let cancelled = false;
  let ran = false;
  let attempt = 0;

  const busy = (): boolean => {
    try { return environment.isBusy?.() === true; } catch { return false; }
  };

  const wait = () => {
    if (cancelled || ran) return;
    attempt += 1;
    // Bounded yielding: after a few busy windows the host is left alone.
    if (attempt > maxAttempts) return;
    timer = schedule(() => { timer = null; start(); }, attempt === 1 ? firstDelay : retryDelay);
  };

  const run = () => {
    if (cancelled || ran) return;
    // Re-check at the moment of execution: a request that started during the
    // delay or the idle wait still owns the host, and the index build waits.
    if (busy()) { wait(); return; }
    ran = true;
    try {
      void Promise.resolve(environment.warm()).catch(() => {
        // Warm-up is an optimization; a failed read must not surface as a turn error.
      });
    } catch {
      // A synchronous failure is equally silent.
    }
  };

  const start = () => {
    if (cancelled || ran) return;
    const requestIdle = environment.requestIdleCallback;
    if (typeof requestIdle === "function") {
      // Do not even register an idle callback for a host that is obviously
      // busy; the execution-time check in run() covers a request that starts
      // while an already-requested idle callback is still waiting.
      if (busy()) { wait(); return; }
      try {
        const handle = requestIdle(() => { idle = null; run(); }, { timeout: environment.idleTimeoutMs ?? CONTEXT_WARMUP_IDLE_TIMEOUT_MS });
        idle = handle === undefined ? null : handle;
        return;
      } catch {
        // A host that advertises but rejects requestIdleCallback still warms now.
      }
    }
    run();
  };

  wait();

  return {
    cancel() {
      cancelled = true;
      if (timer !== null) {
        try { unschedule(timer); } catch { /* the host timer may already be gone */ }
        timer = null;
      }
      if (idle !== null) {
        try { environment.cancelIdleCallback?.(idle); } catch { /* best effort */ }
        idle = null;
      }
    }
  };
}
