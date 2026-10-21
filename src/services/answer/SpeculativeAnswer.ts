/** A single ephemeral request. No persistence, retries, or implicit consent. */
export class SpeculativeAnswer<T> {
  private active?: { key: string; controller: AbortController; result: Promise<T> };
  private attempts: number[] = [];
  private taken = false;
  private prefix = { answer: "", reasoning: "" };
  private subscriber?: (kind: "answer" | "reasoning", text: string) => void;
  constructor(private now = () => Date.now()) {}

  start(key: string, allowed: boolean, run: (signal: AbortSignal, emit: (kind: "answer" | "reasoning", text: string) => void) => Promise<T>): boolean {
    if (!allowed) { this.cancel(); return false; }
    if (this.active?.key === key) return true;
    this.cancel();
    this.attempts = this.attempts.filter((at) => at > this.now() - 600_000);
    if (this.attempts.length >= 10) return false;
    this.attempts.push(this.now());
    const controller = new AbortController();
    const result = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      return run(controller.signal, (kind, text) => {
        if (controller.signal.aborted || this.active?.controller !== controller) return;
        this.prefix[kind] = (this.prefix[kind] + text).slice(0, 30000);
        this.subscriber?.(kind, text);
      });
    });
    // An edited/abandoned draft may reject without a consumer.
    void result.catch(() => undefined);
    this.active = { key, controller, result }; this.taken = false;
    return true;
  }

  take(key: string, onDelta?: (kind: "answer" | "reasoning", text: string) => void): Promise<T> | undefined {
    if (!this.active || this.taken || this.active.key !== key || this.active.controller.signal.aborted) {
      this.cancel(); return undefined;
    }
    this.taken = true;
    this.subscriber = onDelta;
    if (this.prefix.reasoning) onDelta?.("reasoning", this.prefix.reasoning);
    if (this.prefix.answer) onDelta?.("answer", this.prefix.answer);
    return this.active.result;
  }

  isTaken(): boolean { return this.taken; }

  cancel(): void {
    this.active?.controller.abort(); this.active = undefined; this.taken = false;
    this.subscriber = undefined; this.prefix = { answer: "", reasoning: "" };
  }
}
