/** Bounded paint-only observer; the independent full terminal guard stays authoritative.
 * Never projects thinking, signatures, tool arguments, usage, or terminal status. */
export class NativeTextPreview {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private data: string[] = [];
  private bytes = 0;
  private frameBytes = 0;
  private started = false;
  private stopped = false;
  private textBlocks = new Set<number>();
  constructor(private readonly maxBytes: number, private readonly onText: (text: string) => void) {}
  push(bytes: Uint8Array): void {
    this.bytes += bytes.byteLength;
    if (this.bytes > this.maxBytes) throw new Error("SDK_NATIVE_BYTE_LIMIT");
    this.buffer += this.decoder.decode(bytes, { stream: true });
    let at: number;
    const cap = Math.min(this.maxBytes, 2 * 1024 * 1024);
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at).replace(/\r$/, ""); this.buffer = this.buffer.slice(at + 1);
      this.frameBytes += new TextEncoder().encode(line).length;
      if (this.frameBytes > cap) throw new Error("SDK_NATIVE_FRAME_LIMIT");
      if (!line) { this.frame(); this.frameBytes = 0; }
      else if (line.startsWith("data:")) this.data.push(line.slice(5).replace(/^ /, ""));
    }
    if (new TextEncoder().encode(this.buffer).length > cap) throw new Error("SDK_NATIVE_FRAME_LIMIT");
  }
  private frame(): void {
    if (!this.data.length) return;
    const raw = this.data.join("\n"); this.data = [];
    let event: Record<string, any>;
    try { event = JSON.parse(raw); } catch { throw new Error("SDK_NATIVE_INVALID_JSON"); }
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("SDK_NATIVE_INVALID_EVENT");
    if (event.type === "ping") return;
    if (this.stopped) throw new Error("SDK_NATIVE_AFTER_STOP");
    if (event.type === "error") throw new Error("SDK_NATIVE_UPSTREAM_ERROR");
    if (event.type === "message_start") { this.started = true; return; }
    if (!this.started) return;
    if (event.type === "message_stop") { this.stopped = true; return; }
    if (!Number.isSafeInteger(event.index) || event.index < 0) return;
    if (event.type === "content_block_start" && event.content_block?.type === "text") {
      this.textBlocks.add(event.index);
      // Match the SDK's authoritative text_delta observer. Nonempty start text
      // belongs only to the final result, otherwise validated replay can shrink UI.
    }
    if (event.type === "content_block_delta" && this.textBlocks.has(event.index) && event.delta?.type === "text_delta" && typeof event.delta.text === "string") this.onText(event.delta.text);
    if (event.type === "content_block_stop") this.textBlocks.delete(event.index);
  }
}

/** A terminal-outcome guard, NOT a native-protocol translator. Original SSE is
 * forwarded byte-for-byte after this check. In particular thinking/signature
 * blocks are never repurposed as answer text. Stop an empty/error/truncated
 * native response before the SDK can implicitly request another paid attempt. */
export function assertSdkNativeStream(wire: string): void {
  let started = false, stopped = false, reason: string | undefined, hasText = false, hasTool = false;
  const block = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    const b = v as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) hasText = true;
    if (b.type === "tool_use") hasTool = true;
  };
  const frames = wire.replace(/\r\n/g, "\n").split("\n\n");
  for (const frame of frames) {
    const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) continue;
    let event: Record<string, any>;
    try { event = JSON.parse(data); } catch { throw new Error("SDK_NATIVE_INVALID_JSON"); }
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("SDK_NATIVE_INVALID_EVENT");
    if (event.type === "error") throw new Error("SDK_NATIVE_UPSTREAM_ERROR");
    if (event.type === "ping") continue;
    if (stopped) throw new Error("SDK_NATIVE_AFTER_STOP");
    if (event.type === "message_start") {
      if (started) throw new Error("SDK_NATIVE_INVALID_EVENT"); started = true;
      if (Array.isArray(event.message?.content)) event.message.content.forEach(block);
    }
    if (event.type === "content_block_start") block(event.content_block);
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string" && event.delta.text.trim()) hasText = true;
    if (event.type === "message_delta" && typeof event.delta?.stop_reason === "string") reason = event.delta.stop_reason;
    if (event.type === "message_stop") stopped = true;
  }
  if (!started || !stopped || !reason) throw new Error("SDK_NATIVE_INCOMPLETE");
  if (reason === "max_tokens" || reason === "model_context_window_exceeded") throw new Error("SDK_WIRE_OUTPUT_TRUNCATED");
  if (!hasText && !hasTool) throw new Error("SDK_WIRE_EMPTY_RESPONSE");
}
