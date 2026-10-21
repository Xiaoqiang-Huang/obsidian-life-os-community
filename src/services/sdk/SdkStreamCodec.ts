import { toAnthropicResponse } from "./SdkMessageCodec";
import { toOpenAISdkRequest } from "./SdkRequestEnvelope";

type ObjectValue = Record<string, unknown>;
export interface AnthropicStreamEvent { type: string; [key: string]: unknown }
function fail(code: string): never { throw new Error("SDK_STREAM_" + code); }
function object(v: unknown): ObjectValue { if (!v || typeof v !== "object" || Array.isArray(v)) fail("INVALID_CHUNK"); return v as ObjectValue; }
function token(v: unknown): number { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail("INVALID_USAGE"); return v; }
function text(v: unknown): string { if (typeof v !== "string") fail("INVALID_CHUNK"); return v; }
function identifier(v: unknown): string { const s = text(v); if (!/^[a-zA-Z0-9_.:-]{1,256}$/.test(s)) fail("INVALID_IDENTIFIER"); return s; }

/** Actual OpenAI streaming requests must opt into reported final usage. */
export function toOpenAIStreamingRequest(value: unknown, hostEffort?: "default" | "low" | "medium" | "high" | "max"): ObjectValue {
  const r = object(value);
  if (r.stream !== true) fail("STREAM_REQUIRED");
  return { ...toOpenAISdkRequest({ ...r, stream: false }, hostEffort), stream: true, stream_options: { include_usage: true } };
}

/** A bounded streaming transport accumulator, not a model or reasoning loop.
 * OpenAI commonly reports input usage only at the end. We intentionally wait
 * for validated terminal usage before emitting Anthropic message_start/content.
 * This avoids fabricated initial zero usage. Caller may emit ping while waiting.
 * A separate paint-only observer may show text before that gate, never usage/tools. */
export class OpenAIStreamAccumulator {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private dataLines: string[] = [];
  private bytes = 0;
  private frameBytes = 0;
  private done = false;
  private closed = false;
  private failed = false;
  private id = "";
  private model = "";
  private finishReason: string | undefined;
  private usage: ObjectValue | undefined;
  private texts: string[] = [];
  private reasoning: string[] = [];
  private replayMessage: ObjectValue | undefined;
  private tools = new Map<number, { id: string; name: string; arguments: string[] }>();
  constructor(private readonly maxBytes = 8 * 1024 * 1024, private readonly maxFrameBytes = 2 * 1024 * 1024, private readonly onPreview?: (text: string) => void) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 64 * 1024 * 1024 || !Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0 || maxFrameBytes > maxBytes) fail("INVALID_LIMIT");
  }
  push(bytes: Uint8Array): void {
    if (this.closed || this.failed) fail("CLOSED");
    try {
      this.bytes += bytes.byteLength; if (this.bytes > this.maxBytes) fail("BYTE_LIMIT");
      this.buffer += this.decoder.decode(bytes, { stream: true });
      this.consumeLines();
    } catch (e) { this.failed = true; throw e instanceof Error && e.message.startsWith("SDK_STREAM_") ? e : new Error("SDK_STREAM_INVALID_UTF8"); }
  }
  private consumeLines(): void {
    let at: number;
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at).replace(/\r$/, ""); this.buffer = this.buffer.slice(at + 1);
      this.frameBytes += new TextEncoder().encode(line).length;
      if (this.frameBytes > this.maxFrameBytes) fail("FRAME_LIMIT");
      if (!line) { this.frame(); this.frameBytes = 0; }
      else if (line.startsWith("data:")) this.dataLines.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("event:") && line.slice(6).trim() === "error") fail("UPSTREAM_ERROR");
    }
    if (new TextEncoder().encode(this.buffer).length > this.maxFrameBytes) fail("FRAME_LIMIT");
  }
  private frame(): void {
    if (!this.dataLines.length) return;
    const raw = this.dataLines.join("\n"); this.dataLines = [];
    if (this.done) fail("AFTER_DONE");
    if (raw === "[DONE]") { this.done = true; return; }
    let parsed: unknown; try { parsed = JSON.parse(raw); } catch { return fail("INVALID_JSON"); }
    const r = object(parsed); if (r.error) fail("UPSTREAM_ERROR");
    const id = identifier(r.id), model = text(r.model);
    if (!model || model.length > 256 || /[\u0000-\u001f]/.test(model)) fail("INVALID_IDENTIFIER");
    if ((this.id && this.id !== id) || (this.model && this.model !== model)) fail("IDENTITY_CHANGED");
    this.id = id; this.model = model;
    if (r.usage !== undefined && r.usage !== null) {
      if (this.usage) fail("DUPLICATE_USAGE");
      const usage = object(r.usage); token(usage.prompt_tokens); token(usage.completion_tokens);
      this.usage = usage;
    }
    if (!Array.isArray(r.choices) || r.choices.length > 1) fail("INVALID_CHOICES");
    if (!r.choices.length) return;
    const c = object(r.choices[0]); if (c.index !== 0) fail("INVALID_CHOICES");
    if (this.finishReason) fail("AFTER_FINISH");
    const d = object(c.delta);
    if (Object.keys(d).some(k => !["role", "content", "tool_calls", "reasoning_content"].includes(k))) fail("UNSUPPORTED_DELTA");
    if (d.role !== undefined && d.role !== null && d.role !== "assistant") fail("INVALID_ROLE");
    if (d.content !== undefined && d.content !== null) this.texts.push(text(d.content));
    if (d.reasoning_content !== undefined && d.reasoning_content !== null) this.reasoning.push(text(d.reasoning_content));
    if (d.tool_calls !== undefined && d.tool_calls !== null) {
      if (!Array.isArray(d.tool_calls) || d.tool_calls.length > 128) fail("INVALID_TOOL");
      for (const value of d.tool_calls) {
        const t = object(value), index = token(t.index);
        if (index > 127 || (t.type !== undefined && t.type !== null && t.type !== "function")) fail("INVALID_TOOL");
        let entry = this.tools.get(index);
        if (!entry) { entry = { id: "", name: "", arguments: [] }; this.tools.set(index, entry); }
        if (t.id !== undefined && t.id !== null) { const id = identifier(t.id); if (entry.id && entry.id !== id) fail("INVALID_TOOL"); entry.id = id; }
        if (t.function !== undefined && t.function !== null) {
          const fn = object(t.function);
          if (fn.name !== undefined && fn.name !== null) entry.name += text(fn.name);
          if (fn.arguments !== undefined && fn.arguments !== null) entry.arguments.push(text(fn.arguments));
        }
      }
    }
    if (c.finish_reason !== undefined && c.finish_reason !== null) this.finishReason = text(c.finish_reason);
    // Only after this frame's shape checks. Terminal validity is still pending.
    if (typeof d.content === "string" && d.content) this.onPreview?.(d.content);
  }
  /** Single-use private replay material, never an answer/thinking UI event. */
  takeReasoningReplay(): ObjectValue | undefined {
    if (!this.closed || this.failed) fail("INCOMPLETE");
    const result = this.replayMessage; this.replayMessage = undefined; return result;
  }
  finish(): AnthropicStreamEvent[] {
    if (this.closed || this.failed) fail("CLOSED");
    this.closed = true;
    try {
      this.buffer += this.decoder.decode(); this.consumeLines();
      if (this.buffer || this.dataLines.length || !this.done || !this.finishReason || !this.usage) fail("INCOMPLETE");
      const tools = [...this.tools.entries()].sort((a, b) => a[0] - b[0]);
      const ids = new Set<string>();
      const calls = tools.map(([index, t], position) => {
        if (index !== position || ids.has(t.id)) fail("INVALID_TOOL"); ids.add(t.id);
        return { id: identifier(t.id), type: "function", function: { name: identifier(t.name), arguments: t.arguments.join("") } };
      });
      const message = toAnthropicResponse({ id: this.id, model: this.model, choices: [{ message: { role: "assistant", content: this.texts.join("") || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: this.finishReason }], usage: this.usage });
      if (this.reasoning.length) this.replayMessage = { role: "assistant", content: this.texts.join("") || null, ...(calls.length ? { tool_calls: calls } : {}), reasoning_content: this.reasoning.join("") };
      this.reasoning = [];
      const events: AnthropicStreamEvent[] = [{ type: "message_start", message: { ...message, content: [], stop_reason: null, stop_sequence: null } }];
      const blocks = message.content as ObjectValue[];
      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        events.push({ type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } });
        const fragments = block.type === "text" ? this.texts : tools[index - (this.texts.join("") ? 1 : 0)][1].arguments;
        for (const fragment of fragments) events.push({ type: "content_block_delta", index, delta: block.type === "text" ? { type: "text_delta", text: fragment } : { type: "input_json_delta", partial_json: fragment } });
        events.push({ type: "content_block_stop", index });
      }
      events.push({ type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage });
      events.push({ type: "message_stop" });
      return events;
    } catch (e) { this.failed = true; throw e instanceof Error && /^(SDK_STREAM_|SDK_WIRE_)/.test(e.message) ? e : new Error("SDK_STREAM_INVALID_FINAL"); }
  }
}

export function encodeAnthropicSSE(event: AnthropicStreamEvent): string {
  if (!/^[a-z_]+$/.test(event.type)) fail("INVALID_EVENT");
  return "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n";
}
