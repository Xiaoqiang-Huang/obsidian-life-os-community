import { opaqueHash } from "../context-engine/ProjectPrefetchService";

/** Per-answer ownership, never a global current request shared by channels.
 * The SDK kernel is the only dispatcher; this trace counts host-observed
 * boundaries and tool receipts, not HTTP attempts. */
export class AnswerTrace {
  readonly startedAt = Date.now();
  dispatch = 0;
  toolCount = 0;
  fallbackCount = 0;
  firstTokenAt: number | null = null;
  private hashes = new Set<string>();
  dispatchModel(): void { this.dispatch++; }
  fallback(): void { this.fallbackCount++; }
  firstToken(): void { this.firstTokenAt ??= Date.now(); }
  tool(path = ""): void { this.toolCount++; if (path && this.hashes.size < 16) this.hashes.add(opaqueHash(path)); }
  get ttftMs(): number | null { return this.firstTokenAt === null ? null : this.firstTokenAt - this.startedAt; }
  snapshot() {
    return { dispatch: this.dispatch, toolCount: this.toolCount, fallbackCount: this.fallbackCount,
      pathHashes: [...this.hashes], totalMs: Date.now() - this.startedAt, ttftMs: this.ttftMs };
  }
}
