type Kind = "reasoning" | "answer";

/** Transport owns durable/retry semantics; each chunk has a stable id, and is queued once. */
export class WeixinAnswerStream {
  private queue: Array<{ text: string; id: string; persisted: Promise<void> }> = [];
  private buffers: Record<Kind, string> = { reasoning: "", answer: "" };
  private totals: Record<Kind, number> = { reasoning: 0, answer: 0 };
  private capped: Record<Kind, boolean> = { reasoning: false, answer: false };
  private started = false;
  private sequence = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private draining?: Promise<void>;
  private failure: unknown;
  private closed = false;

  constructor(private send: (text: string, id: string) => Promise<void>, private id: string, private intervalMs = 1200, private persist?: (text: string, id: string) => Promise<void>) {}

  push(kind: Kind, text: string): void {
    if (this.closed || !text || this.capped[kind]) return;
    const limit = kind === "reasoning" ? 3000 : 6000;
    const chars = Array.from(text);
    const allowed = Math.max(0, limit - this.totals[kind]);
    this.buffers[kind] += chars.slice(0, allowed).join("");
    this.totals[kind] += Math.min(chars.length, allowed);
    this.capped[kind] = chars.length > allowed;
    if (!this.started) {
      this.started = true;
      this.enqueue("思考中…");
      this.flush();
    } else if (Array.from(this.buffers[kind]).length >= 160) this.flush();
    if (!this.timer && !this.closed) this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, this.intervalMs);
  }

  private enqueue(text: string): void {
    const id = `${this.id}-${++this.sequence}`;
    const persisted = this.persist?.(text, id) ?? Promise.resolve();
    // Persist ALL queued chunks before their turn to send, not just the head.
    void persisted.catch(() => undefined);
    this.queue.push({ text, id, persisted });
    this.drain();
  }

  private drain(): void {
    if (this.draining || this.failure) return;
    this.draining = (async () => {
      while (this.queue.length) {
        const item = this.queue[0];
        await item.persisted;
        await this.send(item.text, item.id);
        if (this.queue[0] === item) this.queue.shift(); // Only acknowledged prefixes are removed.
      }
    })().catch((error) => { this.failure = error; }).finally(() => { this.draining = undefined; });
  }

  private flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    for (const kind of ["reasoning", "answer"] as const) {
      const chars = Array.from(this.buffers[kind]); this.buffers[kind] = "";
      while (chars.length) this.enqueue(`${kind === "reasoning" ? "【思考】" : "【回答】"}${chars.splice(0, 490).join("")}`);
    }
  }

  async finish(finalText: string, state: "completed" | "interrupted" | "error" = "completed"): Promise<void> {
    this.closed = true;
    if (state === "interrupted") {
      if (this.timer) clearTimeout(this.timer);
      this.buffers = { reasoning: "", answer: "" };
      this.queue = [];
      await this.draining; this.failure = undefined;
    } else this.flush();
    // A final complete answer is necessary only if incremental output was capped or unavailable.
    if (state !== "interrupted" && !this.totals.answer) {
      const chars = Array.from(finalText).slice(0, 6000);
      while (chars.length) this.enqueue(`【回答】${chars.splice(0, 490).join("")}`);
    }
    if (state !== "interrupted" && this.capped.answer) this.enqueue("增量输出已达长度上限，已保留前文。");
    this.enqueue(state === "interrupted" ? "已停止（已保留前文）" : state === "error" ? "未完成（已保留前文）" : "回答完成。");
    await this.draining;
    if (this.failure) throw this.failure;
    if (this.queue.length) { this.drain(); await this.draining; }
    if (this.failure) throw this.failure;
  }

  /** Flush supplier thinking without sending a final answer or completion
   * marker. Used by the deep Weixin path, whose guarded answer is delivered
   * separately by the durable channel transport. */
  async finishReasoning(state: "completed" | "interrupted" = "completed"): Promise<void> {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (state === "interrupted") {
      this.buffers = { reasoning: "", answer: "" };
      this.queue = [];
    } else {
      this.flush();
    }
    await this.draining;
    if (this.failure) throw this.failure;
  }
}
