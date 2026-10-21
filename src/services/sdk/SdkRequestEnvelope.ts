import { toOpenAIRequest } from "./SdkMessageCodec";
type RecordValue = Record<string, unknown>;
function fail(): never { throw new Error("SDK_ENVELOPE_UNSUPPORTED"); }
function object(v: unknown): RecordValue { if (!v || typeof v !== "object" || Array.isArray(v)) fail(); return v as RecordValue; }
function known(r: RecordValue, keys: string[]): void { if (Object.keys(r).some(k => !keys.includes(k))) fail(); }
function withoutCacheHint(value: unknown): unknown {
  const b = object(value); if (b.cache_control === undefined) return b;
  const hint = object(b.cache_control); known(hint, ["type", "ttl"]);
  if (hint.type !== "ephemeral" || (hint.ttl !== undefined && !["5m", "1h"].includes(hint.ttl as string))) fail();
  const { cache_control: _hint, ...rest } = b; return rest;
}
function blocks(v: unknown): unknown { return Array.isArray(v) ? v.map(withoutCacheHint) : v; }

/** Consume only understood SDK transport metadata/cache hints. Never remove
 * prompt text, tool schemas, schema properties or semantic thinking/context
 * controls to make an incompatible provider appear supported. Cache hints are
 * not mapped to an OpenAI cache promise; only reported usage is accounted. */
export function toOpenAISdkRequest(value: unknown, hostEffort?: "default" | "low" | "medium" | "high" | "max"): RecordValue {
  const r = object(value), copy = { ...r };
  if (copy.metadata !== undefined) {
    const metadata = object(copy.metadata); known(metadata, ["user_id"]);
    if (metadata.user_id !== undefined && (typeof metadata.user_id !== "string" || metadata.user_id.length > 2048)) fail();
    delete copy.metadata; // Do not export the SDK's local user/session identifier.
  }
  if (copy.thinking !== undefined) {
    const thinking = object(copy.thinking); known(thinking, ["type"]);
    if (thinking.type !== "disabled") fail(); delete copy.thinking;
  }
  // Context edits can change semantics. They are not silently stripped.
  if (copy.context_management !== undefined) fail();
  let effort: string | undefined;
  if (copy.output_config !== undefined) {
    const out = object(copy.output_config); known(out, ["format", "effort"]);
    if (out.effort !== undefined) {
      if (typeof out.effort !== "string" || !["low", "medium", "high", "max"].includes(out.effort)) fail(); effort = out.effort;
    }
    if (out.format === undefined) delete copy.output_config; else copy.output_config = { format: out.format };
  }
  if (copy.system !== undefined) copy.system = blocks(copy.system);
  if (Array.isArray(copy.messages)) copy.messages = copy.messages.map(v => { const m = object(v); return { ...m, content: blocks(m.content) }; });
  if (Array.isArray(copy.tools)) copy.tools = copy.tools.map(withoutCacheHint);
  const out = toOpenAIRequest(copy);
  // Ordinary AI settings control effort. Do not force the SDK's implicit medium
  // value onto a provider when the user explicitly retained provider default.
  if (hostEffort !== "default" && (hostEffort || effort) !== undefined) out.reasoning_effort = hostEffort || effort;
  return out;
}
