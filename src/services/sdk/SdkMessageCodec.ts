/** Bounded, non-streaming protocol PoC. NOT an agent, server, SDK launcher or
 * capability detector. Unsupported fields fail closed instead of losing intent.
 * Stream events, HTTP authentication and lifecycle remain separate P0 gates. */
type RecordValue = Record<string, unknown>;
function fail(code: string): never { throw new Error("SDK_WIRE_" + code); }
function record(v: unknown, code = "INVALID_REQUEST"): RecordValue {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(code);
  return v as RecordValue;
}
function array(v: unknown, code: string): unknown[] { if (!Array.isArray(v)) fail(code); return v; }
function str(v: unknown, code: string, max = 2_000_000): string {
  if (typeof v !== "string" || v.length > max) fail(code); return v;
}
function identifier(v: unknown, code: string): string {
  const s = str(v, code, 256); if (!/^[a-zA-Z0-9_.:-]+$/.test(s)) fail(code); return s;
}
function integer(v: unknown, code: string, positive = false): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < (positive ? 1 : 0)) fail(code); return v;
}
function fields(r: RecordValue, allowed: string[], code: string): void {
  if (Object.keys(r).some(k => !allowed.includes(k))) fail(code);
}
function textBlocks(v: unknown, code: string): string {
  if (typeof v === "string") return str(v, code);
  return array(v, code).map(x => { const b = record(x, code); fields(b, ["type", "text"], code); if (b.type !== "text") fail(code); return str(b.text, code); }).join("\n");
}
function contentPart(v: unknown): RecordValue {
  const b = record(v);
  if (b.type === "text") {
    fields(b, ["type", "text"], "UNSUPPORTED_CONTENT"); return { type: "text", text: str(b.text, "INVALID_TEXT") };
  }
  if (b.type === "image") {
    fields(b, ["type", "source"], "INVALID_IMAGE");
    const source = record(b.source, "INVALID_IMAGE"); fields(source, ["type", "media_type", "data"], "INVALID_IMAGE");
    const mime = str(source.media_type, "INVALID_IMAGE", 64), data = str(source.data, "INVALID_IMAGE", 24_000_000);
    if (source.type !== "base64" || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime) ||
        !data || data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) fail("INVALID_IMAGE");
    return { type: "image_url", image_url: { url: "data:" + mime + ";base64," + data } };
  }
  return fail("UNSUPPORTED_CONTENT");
}

export function toOpenAIRequest(value: unknown): RecordValue {
  const r = record(value);
  fields(r, ["model", "max_tokens", "system", "messages", "tools", "tool_choice", "temperature", "top_p", "stop_sequences", "output_config", "stream"], "UNSUPPORTED_REQUEST");
  if (r.stream !== undefined && r.stream !== false) fail("STREAM_NOT_IMPLEMENTED");
  const out: RecordValue = { model: str(r.model, "INVALID_MODEL", 256), max_tokens: integer(r.max_tokens, "INVALID_BUDGET", true) };
  if (!out.model) fail("INVALID_MODEL");
  const messages: RecordValue[] = [];
  if (r.system !== undefined) messages.push({ role: "system", content: textBlocks(r.system, "INVALID_SYSTEM") });
  const pendingTools = new Set<string>();
  for (const raw of array(r.messages, "INVALID_MESSAGES")) {
    const m = record(raw); fields(m, ["role", "content"], "INVALID_MESSAGES");
    if (m.role === "system") {
      if (pendingTools.size) fail("UNRESOLVED_TOOL");
      messages.push({ role: "system", content: textBlocks(m.content, "INVALID_SYSTEM") }); continue;
    }
    if (m.role !== "user" && m.role !== "assistant") fail("INVALID_ROLE");
    const blocks = typeof m.content === "string" ? [{ type: "text", text: str(m.content, "INVALID_TEXT") }] : array(m.content, "INVALID_CONTENT");
    if (m.role === "assistant") {
      if (pendingTools.size) fail("UNRESOLVED_TOOL");
      const texts: string[] = [], calls: RecordValue[] = [];
      for (const rawBlock of blocks) {
        const b = record(rawBlock);
        if (b.type === "text") { fields(b, ["type", "text"], "UNSUPPORTED_CONTENT"); texts.push(str(b.text, "INVALID_TEXT")); }
        else if (b.type === "tool_use") {
          fields(b, ["type", "id", "name", "input"], "INVALID_TOOL");
          const id = identifier(b.id, "INVALID_TOOL"); if (pendingTools.has(id)) fail("INVALID_TOOL"); pendingTools.add(id);
          calls.push({ id, type: "function", function: { name: identifier(b.name, "INVALID_TOOL"), arguments: JSON.stringify(record(b.input, "INVALID_TOOL")) } });
        } else fail("UNSUPPORTED_CONTENT");
      }
      messages.push({ role: "assistant", content: texts.length ? texts.join("\n") : null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      let parts: RecordValue[] = [];
      const flush = () => { if (parts.length) { if (pendingTools.size) fail("UNRESOLVED_TOOL"); messages.push({ role: "user", content: parts }); parts = []; } };
      for (const rawBlock of blocks) {
        const b = record(rawBlock);
        if (b.type === "tool_result") {
          flush(); fields(b, ["type", "tool_use_id", "content", "is_error"], "INVALID_TOOL");
          const id = identifier(b.tool_use_id, "INVALID_TOOL"); if (!pendingTools.delete(id)) fail("UNKNOWN_TOOL");
          if (b.is_error !== undefined && typeof b.is_error !== "boolean") fail("INVALID_TOOL");
          const content = textBlocks(b.content, "INVALID_TOOL");
          messages.push({ role: "tool", tool_call_id: id, content: b.is_error ? "Tool error: " + content : content });
        } else parts.push(contentPart(b));
      }
      flush();
    }
  }
  if (pendingTools.size || !messages.some(m => m.role !== "system")) fail("UNRESOLVED_TOOL");
  out.messages = messages;
  if (r.tools !== undefined) {
    out.tools = array(r.tools, "INVALID_TOOL").map(v => {
      const t = record(v, "INVALID_TOOL"); fields(t, ["name", "description", "input_schema"], "UNSUPPORTED_TOOL");
      return { type: "function", function: { name: identifier(t.name, "INVALID_TOOL"), ...(t.description !== undefined ? { description: str(t.description, "INVALID_TOOL") } : {}), parameters: record(t.input_schema, "INVALID_TOOL") } };
    });
  }
  if (r.tool_choice !== undefined) {
    const t = record(r.tool_choice, "INVALID_TOOL"); fields(t, ["type", "name"], "UNSUPPORTED_TOOL_CHOICE");
    out.tool_choice = t.type === "auto" ? "auto" : t.type === "any" ? "required" : t.type === "none" ? "none" :
      t.type === "tool" ? { type: "function", function: { name: identifier(t.name, "INVALID_TOOL") } } : fail("UNSUPPORTED_TOOL_CHOICE");
  }
  for (const name of ["temperature", "top_p"]) if (r[name] !== undefined) {
    const n = r[name]; if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) fail("INVALID_SAMPLING"); out[name] = n;
  }
  if (r.stop_sequences !== undefined) out.stop = array(r.stop_sequences, "INVALID_STOP").map(s => str(s, "INVALID_STOP", 1024));
  if (r.output_config !== undefined) {
    const config = record(r.output_config); fields(config, ["format"], "UNSUPPORTED_OUTPUT_CONFIG");
    const format = record(config.format); fields(format, ["type", "schema"], "UNSUPPORTED_OUTPUT_CONFIG");
    if (format.type !== "json_schema") fail("UNSUPPORTED_OUTPUT_CONFIG");
    out.response_format = { type: "json_schema", json_schema: { name: "lifeos_result", strict: true, schema: record(format.schema) } };
  }
  return out;
}

/** Reported cached input is part of prompt_tokens, not additional input. */
export function toAnthropicUsage(value: unknown): RecordValue {
  const u = record(value, "INVALID_USAGE");
  const input = integer(u.prompt_tokens, "INVALID_USAGE"), output = integer(u.completion_tokens, "INVALID_USAGE");
  if (!Number.isSafeInteger(input + output) || (u.total_tokens !== undefined && integer(u.total_tokens, "INVALID_USAGE") !== input + output)) fail("INVALID_USAGE");
  let cached: number | undefined;
  if (u.prompt_tokens_details !== undefined && u.prompt_tokens_details !== null) {
    const details = record(u.prompt_tokens_details, "INVALID_USAGE");
    if (details.cached_tokens !== undefined) cached = integer(details.cached_tokens, "INVALID_USAGE");
  }
  if (cached !== undefined && cached > input) fail("INVALID_USAGE");
  if (u.completion_tokens_details !== undefined && u.completion_tokens_details !== null) {
    const details = record(u.completion_tokens_details, "INVALID_USAGE");
    if (details.reasoning_tokens !== undefined && integer(details.reasoning_tokens, "INVALID_USAGE") > output) fail("INVALID_USAGE");
  }
  return { input_tokens: input - (cached ?? 0), output_tokens: output,
    ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}) };
}

export function toAnthropicResponse(value: unknown): RecordValue {
  const r = record(value, "INVALID_RESPONSE"), choices = array(r.choices, "INVALID_RESPONSE");
  if (choices.length !== 1) fail("INVALID_RESPONSE");
  const choice = record(choices[0], "INVALID_RESPONSE"), m = record(choice.message, "INVALID_RESPONSE");
  if (m.role !== "assistant" || m.refusal) fail("UNSUPPORTED_RESPONSE");
  if (m.reasoning) fail("UNSUPPORTED_REASONING");
  if (m.reasoning_content !== undefined && m.reasoning_content !== null && typeof m.reasoning_content !== "string") fail("INVALID_REASONING");
  const content: RecordValue[] = [];
  if (m.content !== null && m.content !== undefined) { const text = str(m.content, "INVALID_RESPONSE"); if (text) content.push({ type: "text", text }); }
  const ids = new Set<string>();
  if (m.tool_calls !== undefined && m.tool_calls !== null) for (const v of array(m.tool_calls, "INVALID_TOOL")) {
    const call = record(v, "INVALID_TOOL"), fn = record(call.function, "INVALID_TOOL");
    if (call.type !== "function") fail("INVALID_TOOL");
    let input: unknown; try { input = JSON.parse(str(fn.arguments, "INVALID_TOOL")); } catch { return fail("INVALID_TOOL"); }
    const id = identifier(call.id, "INVALID_TOOL"); if (ids.has(id)) fail("INVALID_TOOL"); ids.add(id);
    content.push({ type: "tool_use", id, name: identifier(fn.name, "INVALID_TOOL"), input: record(input, "INVALID_TOOL") });
  }
  const finish = choice.finish_reason;
  if (!["stop", "length", "tool_calls"].includes(finish as string)) fail("UNSUPPORTED_FINISH");
  const hasTool = content.some(b => b.type === "tool_use");
  if ((finish === "tool_calls") !== hasTool) fail("TOOL_FINISH_MISMATCH");
  if (!content.length) fail(finish === "length" ? "OUTPUT_TRUNCATED" : "EMPTY_RESPONSE");
  const usage = toAnthropicUsage(r.usage);
  return { id: identifier(r.id, "INVALID_RESPONSE"), type: "message", role: "assistant", model: str(r.model, "INVALID_MODEL", 256), content,
    stop_reason: finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn", stop_sequence: null,
    usage };
}
