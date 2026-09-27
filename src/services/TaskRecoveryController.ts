import { isTaskIndexPending } from "./task-write-coordinator";

export type TaskRecoveryStatus =
  | { phase: "ready" }
  | { phase: "waiting"; error: unknown }
  | { phase: "blocked"; error: unknown; indexPending: boolean };

/** Startup-only retries. Never replays user actions or bypasses the task writer.
 * Do not await onLayoutReady in onload: Obsidian may wait for plugins to load.
 */
export class TaskRecoveryController {
  private disposed = false;
  private settled = false;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private readonly lifecycle = new AbortController();
  private readonly delays = [250, 500, 1000, 2000, 4000, 8000];

  constructor(private recover: (signal: AbortSignal) => Promise<void>, private report: (status: TaskRecoveryStatus) => void) {}

  start(): Promise<void> { return this.run(); }

  /** Layout readiness is a hint, not permission to retry corruption/conflicts. */
  layoutReady(): Promise<void> {
    if (this.disposed || this.settled) return Promise.resolve();
    if (this.running) return this.running;
    this.clearTimer();
    return this.run();
  }

  /** Explicit user command may retry after a conflict was resolved externally. */
  retry(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.running) return this.running;
    this.clearTimer(); this.attempt = 0; this.settled = false;
    return this.run();
  }

  dispose(): void { this.disposed = true; this.lifecycle.abort(); this.clearTimer(); }

  private clearTimer(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
  }

  private run(): Promise<void> {
    if (this.disposed || this.settled) return Promise.resolve();
    if (this.running) return this.running;
    const work = Promise.resolve().then(async () => {
      if (this.disposed) return;
      try {
        await this.recover(this.lifecycle.signal);
        if (this.disposed) return;
        this.settled = true; this.clearTimer(); this.report({ phase: "ready" });
      } catch (error) {
        if (this.disposed) return;
        if (isTaskIndexPending(error) && this.attempt < this.delays.length) {
          this.report({ phase: "waiting", error });
          const delay = this.delays[this.attempt++];
          this.timer = setTimeout(() => { this.timer = null; void this.run(); }, delay);
        } else {
          this.settled = true; this.clearTimer();
          this.report({ phase: "blocked", error, indexPending: isTaskIndexPending(error) });
        }
      }
    });
    this.running = work.finally(() => { this.running = null; });
    return this.running;
  }
}
