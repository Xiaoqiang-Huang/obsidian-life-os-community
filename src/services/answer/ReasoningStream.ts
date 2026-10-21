/** Supplier thinking is projected on its own callback. It is never answer
 * text, evidence, a citation target, or persisted chat content. */
export const REASONING_MAX_BYTES = 64 * 1024;
export const REASONING_MAX_CHARS = 64 * 1024;
export const REASONING_TRUNCATED_NOTICE = "\n\n[思考内容超过 64KB，已截断]";

/** Parse only supplier-emitted deltas. Never synthesize or use these as evidence.
 * The canonical SDK kernel now projects thinking_delta through onReasoning; these
 * parsers stay for protocol fixtures and bridges that expose non-SDK fields. */
export function reasoningDelta(chunk: any): string {
  if (chunk?.type === "content_block_delta" && chunk.delta?.type === "thinking_delta") {
    return typeof chunk.delta.thinking === "string" ? chunk.delta.thinking : "";
  }
  if (chunk?.type === "response.reasoning_summary_text.delta") {
    return typeof chunk.delta === "string" ? chunk.delta : "";
  }
  const value = chunk?.choices?.[0]?.delta?.reasoning_content;
  return typeof value === "string" ? value : "";
}

/** Streaming filter for writeback envelopes, including markers split across chunks. */
export class VisibleAnswerFilter {
  private buffer = "";
  private hidden = false;
  push(delta: string, final = false): string {
    this.buffer += delta;
    let visible = "";
    while (this.buffer) {
      const marker = this.hidden ? "</lifeos_writeback>" : "<lifeos_writeback>";
      const index = this.buffer.toLowerCase().indexOf(marker);
      if (index >= 0) {
        if (!this.hidden) visible += this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + marker.length);
        this.hidden = !this.hidden;
        continue;
      }
      let hold = 0;
      if (!final) {
        for (let n = 1; n < marker.length && n <= this.buffer.length; n++) {
          if (marker.startsWith(this.buffer.slice(-n).toLowerCase())) hold = n;
        }
      }
      if (!this.hidden) visible += this.buffer.slice(0, this.buffer.length - hold);
      this.buffer = hold ? this.buffer.slice(-hold) : "";
      break;
    }
    return visible;
  }
}
