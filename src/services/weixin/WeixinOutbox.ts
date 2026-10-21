import { Platform } from "obsidian";

function desktopModule<T>(specifier: string): T {
  if (!Platform.isDesktopApp || typeof require !== "function") throw new Error("OUTBOX_DESKTOP_REQUIRED");
  return require(specifier) as T;
}

export const OUTBOX_STOP = "已停止（已保留前文）";
export const OUTBOX_FAILURE = "未完成（投递失败，已保留前文）";
export const OUTBOX_RECOVERY_PARTIAL = "未完成（程序重启，已保留前文）";
export const OUTBOX_RECOVERY_UNAVAILABLE = "未完成（程序重启，正文未能恢复）";
export const OUTBOX_REGENERATED = "因重启重新生成：";

export interface OutboxRoute {
  accountId: string;
  conversationId: string;
  recipientId: string;
  messageId: string;
  /** Distinguishes a new streaming run of the same inbound message. */
  runId?: string;
}

/** Electron safeStorage-backed codec. Tests inject a deterministic codec. */
export interface OutboxCipher {
  readonly id: string;
  isAvailable(): boolean;
  seal(plaintext: string): Promise<string>;
  open(ciphertext: string): Promise<string>;
}

export type OutboxRegenerate = (route: OutboxRoute) => Promise<string | undefined>;
export type OutboxOutcome = "resumed" | "regenerated" | "notice" | "skipped" | "failed";
export interface OutboxRecovery {
  messageId: string;
  route: OutboxRoute;
  outcome: OutboxOutcome;
  /** The stream carried the whole answer (a normal close), not a crash mid-answer. */
  complete: boolean;
  reason?: string;
}

type NoticeKind = "stop" | "failure" | "partial" | "unavailable" | "regenerated";
const NOTICE_TEXT: Record<NoticeKind, string> = {
  stop: OUTBOX_STOP,
  failure: OUTBOX_FAILURE,
  partial: OUTBOX_RECOVERY_PARTIAL,
  unavailable: OUTBOX_RECOVERY_UNAVAILABLE,
  regenerated: OUTBOX_REGENERATED
};
const NOTICES = new Set<string>(Object.keys(NOTICE_TEXT));

interface Block {
  sequence: number;
  key: string;
  digest: string;
  length: number;
  state: "pending" | "acked" | "cancelled" | "lost";
  attempts: number;
  nextAt: number;
  terminal: boolean;
  /** Ciphertext of the chunk. Never plaintext. */
  sealed?: string;
  cipher?: string;
  /** Fixed UI marker; safe to store without encryption. */
  notice?: NoticeKind;
  lostReason?: "key-unavailable" | "decrypt-failed" | "missing-ciphertext" | "regeneration";
  /** Remote idempotency key reused verbatim when an ACK write was lost. */
  clientId?: string;
}
interface Stream {
  id: string;
  route: OutboxRoute;
  blocks: Block[];
  lastConfirmedSequence: number;
  closed: boolean;
  stopped: boolean;
  failed: boolean;
  /** Set only when the answer stream finished normally, never on a crash. */
  complete?: boolean;
  recovery?: "resumed" | "regenerated" | "notice";
}
/** Version 3 stores sealed chunks or fixed notice enums, never message text. */
export interface OutboxState {
  version: 3;
  privacy: "encrypted";
  cipher: string;
  streams: Record<string, Stream>;
}
export interface OutboxStore { load(): Promise<OutboxState | undefined>; save(state: OutboxState): Promise<void>; }
export type OutboxTransport = (route: OutboxRoute, text: string, key: string, clientId: string, signal: AbortSignal) => Promise<void>;

const hash = (text: string) => desktopModule<typeof import("crypto")>("crypto").createHash("sha256").update(text).digest("hex");
export const outboxStreamId = (route: OutboxRoute): string =>
  hash(JSON.stringify([route.accountId, route.conversationId, route.recipientId, route.messageId, route.runId || ""]));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const splitChunks = (text: string): string[] => {
  const chars = Array.from(text);
  const chunks: string[] = [];
  while (chars.length) chunks.push(chars.splice(0, 480).join(""));
  return chunks;
};

/** Durable encrypted chunk receipts for Weixin streaming.
 *
 * Unconfirmed text is sealed with the host safeStorage codec before it is
 * committed. A restart with the same key decrypts pending blocks and resumes
 * from the first unacknowledged sequence. If the key is unavailable or a block
 * cannot be decrypted, the outbox never falls back to plaintext and never
 * replays an acknowledged prefix: it asks the caller for exactly one bounded
 * regeneration from the durable inbound queue, or sends a fixed notice. */
export class WeixinOutbox {
  private state: OutboxState;
  /** The only copy of unacknowledged plaintext. Cleared on ACK, cancel, stop. */
  private plaintext = new Map<string, string>();
  private loaded?: Promise<void>;
  private queue = Promise.resolve();
  private pumps = new Map<string, Promise<void>>();
  private controllers = new Map<string, AbortController>();
  private stopped = new Set<string>();
  private owned = new Set<string>();
  private disposed = false;

  constructor(private store: OutboxStore, private delays = [0, 750, 2000], private now = () => Date.now(), private cipher?: OutboxCipher) {
    this.state = { version: 3, privacy: "encrypted", cipher: this.cipherId(), streams: {} };
  }

  private cipherId(): string {
    try { return this.cipher?.isAvailable() ? this.cipher.id : "none"; } catch { return "none"; }
  }
  private async seal(text: string): Promise<{ sealed?: string; cipher?: string }> {
    if (!this.cipher) return {};
    try {
      if (!this.cipher.isAvailable()) return {};
      return { sealed: await this.cipher.seal(text), cipher: this.cipher.id };
    } catch { return {}; }
  }
  private async unseal(sealed: string | undefined, cipher: string | undefined): Promise<string | undefined> {
    if (!sealed || !cipher || cipher === "none" || !this.cipher) return undefined;
    try {
      if (!this.cipher.isAvailable() || this.cipher.id !== cipher) return undefined;
      return await this.cipher.open(sealed);
    } catch { return undefined; }
  }
  private ready(): Promise<void> {
    return this.loaded ??= this.store.load().then(async value => {
      if (!value) return;
      const version = (value as { version?: unknown }).version;
      if (version === 1 || JSON.stringify(value).includes("\"text\"")) throw new Error("OUTBOX_PLAINTEXT_STATE_REJECTED");
      if (version === 2) throw new Error("OUTBOX_LEGACY_STATE_REJECTED");
      if (version !== 3) throw new Error("OUTBOX_CORRUPT");
      if (value.privacy !== "encrypted" || typeof value.cipher !== "string" || !value.streams || typeof value.streams !== "object") throw new Error("OUTBOX_CORRUPT");
      for (const [id, stream] of Object.entries(value.streams)) {
        if (!stream.route || outboxStreamId(stream.route) !== id || !Array.isArray(stream.blocks) || !Number.isInteger(stream.lastConfirmedSequence)) throw new Error("OUTBOX_CORRUPT");
        if (typeof stream.closed !== "boolean" || typeof stream.stopped !== "boolean" || typeof stream.failed !== "boolean") throw new Error("OUTBOX_CORRUPT");
        if (stream.complete !== undefined && typeof stream.complete !== "boolean") throw new Error("OUTBOX_CORRUPT");
        if (stream.recovery !== undefined && !["resumed", "regenerated", "notice"].includes(stream.recovery)) throw new Error("OUTBOX_CORRUPT");
        for (const [index, block] of stream.blocks.entries()) {
          if (block.sequence !== index + 1 || !/^[a-f0-9]{64}$/.test(block.key) || !/^[a-f0-9]{64}$/.test(block.digest)
            || !Number.isInteger(block.length) || block.length < 0 || block.length > 500
            || !["pending", "acked", "cancelled", "lost"].includes(block.state)
            || !Number.isInteger(block.attempts) || block.attempts < 0 || !Number.isFinite(block.nextAt)) throw new Error("OUTBOX_CORRUPT");
          if (block.clientId !== undefined && (typeof block.clientId !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(block.clientId))) throw new Error("OUTBOX_CORRUPT");
          if (typeof block.terminal !== "boolean") throw new Error("OUTBOX_CORRUPT");
          if (block.notice !== undefined) {
            if (!NOTICES.has(block.notice) || block.sealed !== undefined || block.cipher !== undefined) throw new Error("OUTBOX_CORRUPT");
          } else if (block.sealed !== undefined) {
            if (typeof block.sealed !== "string" || !block.sealed || typeof block.cipher !== "string" || !block.cipher) throw new Error("OUTBOX_CORRUPT");
          }
        }
      }
      this.state = value;
      for (const stream of Object.values(this.state.streams)) {
        if (stream.stopped) this.stopped.add(stream.id);
        for (const block of stream.blocks) {
          if (block.state !== "pending" || block.notice) continue;
          const text = await this.unseal(block.sealed, block.cipher);
          if (text !== undefined && hash(text) === block.digest && Array.from(text).length === block.length) this.plaintext.set(block.key, text);
          else {
            block.state = "lost";
            block.lostReason = text !== undefined ? "decrypt-failed" : block.sealed ? (block.cipher !== this.cipherId() ? "key-unavailable" : "decrypt-failed") : "missing-ciphertext";
          }
        }
      }
    });
  }
  private change(fn: (state: OutboxState) => void): Promise<void> {
    const work = this.queue.then(async () => {
      await this.ready();
      if (this.disposed) throw new Error("OUTBOX_PAUSED");
      const next = clone(this.state); fn(next); await this.store.save(next); this.state = next;
    });
    this.queue = work.catch(() => undefined); return work;
  }
  async open(route: OutboxRoute): Promise<{ id: string; existing: boolean }> {
    await this.ready(); const id = outboxStreamId(route);
    const existing = Boolean(this.state.streams[id]);
    if (!existing) await this.change(state => {
      if (Object.keys(state.streams).length >= 1000) throw new Error("OUTBOX_CAPACITY_REQUIRES_REVIEW");
      state.streams[id] ??= { id, route: { ...route }, blocks: [], lastConfirmedSequence: 0, closed: false, stopped: false, failed: false };
      state.cipher = this.cipherId();
    });
    this.owned.add(id); return { id, existing };
  }
  async enqueue(id: string, text: string, clientKey: string, terminal = false, clientId = ""): Promise<void> {
    if (!text || Array.from(text).length > 500) throw new Error("OUTBOX_CHUNK_LIMIT");
    const sealed = await this.seal(text);
    const key = hash(id + ":" + (terminal && text === OUTBOX_STOP ? "stop" : clientKey)), digest = hash(text);
    await this.change(state => {
      const stream = state.streams[id]; if (!stream) throw new Error("OUTBOX_UNKNOWN_STREAM");
      const prior = stream.blocks.find(block => block.key === key);
      if (prior) { if (prior.digest !== digest) throw new Error("OUTBOX_IDEMPOTENCY_CONFLICT"); return; }
      if (stream.stopped || this.stopped.has(id) || stream.failed || stream.closed) {
        if (!(terminal && text === OUTBOX_STOP && stream.stopped)) return;
      }
      if (stream.blocks.length >= 128) throw new Error("OUTBOX_STREAM_LIMIT");
      stream.blocks.push({ sequence: stream.blocks.length + 1, key, digest, length: Array.from(text).length, state: "pending", attempts: 0, nextAt: 0, terminal, ...sealed,
        ...(clientId ? { clientId } : {}) });
    });
    const block = this.state.streams[id]?.blocks.find(item => item.key === key);
    if (block?.state === "pending" && !block.notice) this.plaintext.set(key, text);
  }
  async close(id: string, complete = true): Promise<void> {
    await this.change(state => { const stream = state.streams[id]; if (stream) { stream.closed = true; stream.complete = complete; } });
  }
  /** Transport ACK for one chunk: deletes the ciphertext and the memory copy. */
  async ack(id: string, clientKey: string): Promise<void> {
    const key = hash(id + ":" + clientKey);
    await this.change(state => {
      const stream = state.streams[id]; if (!stream) return;
      const item = stream.blocks.find(block => block.key === key);
      if (!item || item.state !== "pending") return;
      item.state = "acked"; item.sealed = undefined; item.cipher = undefined; this.plaintext.delete(item.key);
      stream.lastConfirmedSequence = Math.max(stream.lastConfirmedSequence, item.sequence);
    });
  }
  async stop(id: string): Promise<void> {
    this.stopped.add(id); this.controllers.get(id)?.abort();
    await this.change(state => {
      const stream = state.streams[id]; if (!stream || stream.stopped) return;
      stream.stopped = true; stream.closed = true;
      for (const block of stream.blocks) if (block.state === "pending") {
        block.state = "cancelled"; block.sealed = undefined; block.cipher = undefined; this.plaintext.delete(block.key);
      }
      this.marker(stream, "stop");
    });
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.controllers.values()) controller.abort();
    this.plaintext.clear();
    await this.queue;
  }
  release(id: string): void { this.owned.delete(id); }
  /** Remove a stream that never journaled a chunk (for example a deep turn
   * that only streamed ephemeral thinking). Without this, an empty stream
   * would look like a crash and trigger a needless recovery notice. */
  async discard(id: string): Promise<void> {
    await this.change(state => {
      const stream = state.streams[id];
      if (stream) for (const block of stream.blocks) this.plaintext.delete(block.key);
      delete state.streams[id];
    });
    this.owned.delete(id);
  }
  releaseAccount(accountId: string): void {
    for (const id of this.owned) if (this.state.streams[id]?.route.accountId === accountId) this.owned.delete(id);
  }
  async stopRoute(accountId: string, conversationId: string, recipientId: string): Promise<string[]> {
    await this.ready();
    const ids = Object.values(this.state.streams).filter(stream => stream.route.accountId === accountId
      && stream.route.conversationId === conversationId && stream.route.recipientId === recipientId
      && (!stream.closed || stream.blocks.some(block => block.state === "pending"))).map(stream => stream.id);
    await Promise.all(ids.map(id => this.stop(id))); return ids;
  }
  private marker(stream: Stream, notice: NoticeKind): void {
    const key = hash(stream.id + ":notice:" + notice), text = NOTICE_TEXT[notice];
    if (!stream.blocks.some(block => block.key === key)) {
      stream.blocks.push({ sequence: stream.blocks.length + 1, key, digest: hash(text), length: Array.from(text).length,
        state: "pending", attempts: 0, nextAt: 0, terminal: true, notice, clientId: "lifeos-notice-" + key.slice(0, 32) });
    }
  }
  async recover(accountId: string, transport: OutboxTransport, regenerate?: OutboxRegenerate): Promise<OutboxRecovery[]> {
    await this.ready();
    const ids = Object.values(this.state.streams).filter(stream => stream.route.accountId === accountId && !this.owned.has(stream.id)
      && (!stream.closed || stream.blocks.some(block => block.state === "pending" || block.state === "lost"))).map(stream => stream.id);
    const rows: OutboxRecovery[] = [];
    for (const id of ids) {
      try { rows.push(await this.recoverStream(id, transport, regenerate)); }
      catch (error) {
        const stream = this.state.streams[id];
        rows.push({ messageId: stream?.route.messageId || "", route: stream?.route || { accountId, conversationId: "", recipientId: "", messageId: "" },
          outcome: "failed", complete: false, reason: error instanceof Error ? error.message : "OUTBOX_RECOVERY_FAILED" });
      }
    }
    return rows;
  }
  async recoverStream(id: string, transport: OutboxTransport, regenerate?: OutboxRegenerate): Promise<OutboxRecovery> {
    await this.ready();
    const before = this.state.streams[id]; if (!before) throw new Error("OUTBOX_UNKNOWN_STREAM");
    // `complete` records a normal close. The caller uses it to decide whether
    // an incomplete encrypted suffix may be acknowledged or must be regenerated.
    const complete = before.complete === true;
    let hadLost = false, hadPending = false;
    await this.change(state => {
      const stream = state.streams[id]; if (!stream) throw new Error("OUTBOX_UNKNOWN_STREAM");
      for (const block of stream.blocks) {
        if (block.state === "pending" && block.sequence <= stream.lastConfirmedSequence) {
          block.state = "acked"; block.sealed = undefined; block.cipher = undefined; this.plaintext.delete(block.key);
        }
        if (block.state === "pending" && !block.notice && !this.plaintext.has(block.key)) {
          block.state = "lost";
          block.lostReason = block.sealed ? (block.cipher !== this.cipherId() ? "key-unavailable" : "decrypt-failed") : "missing-ciphertext";
        }
        if (block.state === "lost") hadLost = true;
        if (block.state === "pending") hadPending = true;
      }
      // Regeneration is all-or-nothing for the answer. Mixing decrypted old
      // chunks with a new answer would repeat or split content.
      if (hadLost) {
        for (const block of stream.blocks) if (block.state === "pending") {
          block.state = "lost"; block.lostReason = "regeneration"; block.sealed = undefined; block.cipher = undefined; this.plaintext.delete(block.key);
        }
      }
      stream.closed = true;
    });
    let outcome: OutboxOutcome = hadLost ? "notice" : hadPending ? "resumed" : "skipped";
    const stream = this.state.streams[id];
    if (hadLost) {
      if (stream.lastConfirmedSequence === 0 && regenerate && !stream.recovery) {
        let text: string | undefined;
        try { text = await regenerate(stream.route); } catch { text = undefined; }
        if (text?.trim()) { await this.appendRecovery(id, text); outcome = "regenerated"; }
        else {
          await this.change(state => { const current = state.streams[id]; current.recovery = "notice"; this.marker(current, "unavailable"); });
        }
      } else {
        await this.change(state => {
          const current = state.streams[id]; current.recovery = "notice";
          this.marker(current, current.lastConfirmedSequence > 0 ? "partial" : "unavailable");
        });
      }
    } else if (outcome === "resumed") {
      await this.change(state => { state.streams[id].recovery = "resumed"; });
    }
    await this.deliver(id, transport);
    const after = this.state.streams[id];
    // A transport that exhausted its retries leaves a failure marker; the
    // caller must let the durable inbound queue regenerate instead of treating
    // this as a delivered answer.
    if (after?.failed && (outcome === "resumed" || outcome === "regenerated")) outcome = "notice";
    return { messageId: stream.route.messageId, route: stream.route, outcome, complete };
  }
  private async appendRecovery(id: string, text: string): Promise<void> {
    const chunks = splitChunks(text);
    const packed: Array<{ text: string; sealed: { sealed?: string; cipher?: string } }> = [];
    for (const chunk of chunks) packed.push({ text: chunk, sealed: await this.seal(chunk) });
    await this.change(state => {
      const stream = state.streams[id]; if (!stream || stream.recovery) return;
      this.marker(stream, "regenerated");
      for (const [index, chunk] of packed.entries()) {
        const key = hash(stream.id + ":regen:" + index);
        if (stream.blocks.some(block => block.key === key)) continue;
        if (stream.blocks.length >= 128) break;
        stream.blocks.push({ sequence: stream.blocks.length + 1, key, digest: hash(chunk.text), length: Array.from(chunk.text).length,
          state: "pending", attempts: 0, nextAt: 0, terminal: false, ...chunk.sealed, clientId: "lifeos-regen-" + key.slice(0, 32) });
        this.plaintext.set(key, chunk.text);
      }
      stream.recovery = "regenerated";
    });
  }
  deliver(id: string, transport: OutboxTransport): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("OUTBOX_PAUSED"));
    const current = this.pumps.get(id); if (current) return current;
    const work = this.pump(id, transport).finally(() => { this.pumps.delete(id); this.controllers.delete(id); });
    this.pumps.set(id, work); return work;
  }
  private async pump(id: string, transport: OutboxTransport): Promise<void> {
    await this.ready();
    for (;;) {
      await this.queue;
      if (this.disposed) throw new Error("OUTBOX_PAUSED");
      const stream = this.state.streams[id];
      const block = stream?.blocks.find(item => item.state === "pending" && item.sequence > stream.lastConfirmedSequence); if (!block) return;
      if (block.attempts >= this.delays.length) throw new Error("OUTBOX_DELIVERY_FAILED_REQUIRES_REVIEW");
      const text = block.notice ? NOTICE_TEXT[block.notice] : this.plaintext.get(block.key);
      if (text === undefined) {
        await this.change(state => {
          const item = state.streams[id].blocks[block.sequence - 1];
          if (item.state === "pending") { item.state = "lost"; item.lostReason = "missing-ciphertext"; item.sealed = undefined; item.cipher = undefined; }
        });
        continue;
      }
      const controller = new AbortController(); this.controllers.set(id, controller);
      const delay = Math.max(0, block.nextAt - this.now());
      if (delay) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, delay); controller.signal.addEventListener("abort", done, { once: true });
      });
      if (controller.signal.aborted) { await this.queue; continue; }
      if (this.stopped.has(id) && !block.terminal) throw new Error("OUTBOX_STOP_NOT_COMMITTED");
      await this.change(state => { const item = state.streams[id].blocks[block.sequence - 1]; item.attempts++; });
      // Stop may have arrived during fsync. Check again at the actual transport boundary.
      if (controller.signal.aborted) { await this.queue; continue; }
      if (this.stopped.has(id) && !block.terminal) throw new Error("OUTBOX_STOP_NOT_COMMITTED");
      try {
        await transport(stream.route, text, block.key, block.clientId || "", controller.signal);
      } catch (error) {
        if (error instanceof Error && error.message === "OUTBOX_PAUSED") {
          await this.change(state => { state.streams[id].blocks[block.sequence - 1].attempts--; });
          throw error;
        }
        if (controller.signal.aborted) continue;
        await this.change(state => {
          const current = state.streams[id], item = current.blocks[block.sequence - 1];
          if (item.state !== "pending") return;
          item.nextAt = this.now() + (this.delays[item.attempts] ?? 0);
          if (item.attempts >= this.delays.length && !item.terminal) {
            current.failed = true; current.closed = true;
            for (const row of current.blocks) if (row.state === "pending") {
              row.state = "cancelled"; row.sealed = undefined; row.cipher = undefined; this.plaintext.delete(row.key);
            }
            this.marker(current, "failure");
          }
        });
        continue;
      }
      // A lost ACK write leaves the same pending key on disk. Do NOT consume the
      // next block in memory or retry this process: recovery reuses that exact key.
      await this.change(state => {
        const current = state.streams[id], item = current.blocks[block.sequence - 1];
        item.state = "acked"; item.sealed = undefined; item.cipher = undefined;
        this.plaintext.delete(item.key);
        current.lastConfirmedSequence = Math.max(current.lastConfirmedSequence, item.sequence);
      });
    }
  }
  async inspect(): Promise<OutboxState> { await this.ready(); await this.queue; return clone(this.state); }
  /** Test/diagnostic seam: proves plaintext is bounded to pending rows. */
  plaintextKeys(): string[] { return [...this.plaintext.keys()]; }
}

/** Atomic same-directory rename. On any failure retain the old committed file;
 * never unlink it to make replacement succeed. Corruption is fail-closed. */
export class FileOutboxStore implements OutboxStore {
  constructor(private file: () => string) {}
  async load(): Promise<OutboxState | undefined> {
    const fs = desktopModule<typeof import("fs/promises")>("fs/promises");
    try { return JSON.parse(await fs.readFile(this.file(), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("OUTBOX_LOAD_FAILED"); }
  }
  async save(state: OutboxState): Promise<void> {
    const fs = desktopModule<typeof import("fs/promises")>("fs/promises");
    const path = desktopModule<typeof import("path")>("path");
    const target = this.file(), temp = target + ".tmp-" + hash(String(Date.now()) + Math.random()).slice(0, 16);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    let committed = false;
    try {
      const handle = await fs.open(temp, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, target); committed = true;
    } finally {
      if (!committed) await fs.unlink(temp).catch(() => undefined); // only this transaction's temp, never the committed file
    }
  }
}
