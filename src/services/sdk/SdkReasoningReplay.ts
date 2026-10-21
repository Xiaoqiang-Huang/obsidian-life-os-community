type Value = Record<string, unknown>;
function invalid(): never { throw new Error("SDK_REASONING_REPLAY_INVALID"); }
function object(value: unknown): Value { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Value; }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
function identity(message: Value): string {
  const calls = message.tool_calls === undefined ? [] : (Array.isArray(message.tool_calls) ? message.tool_calls : invalid());
  return JSON.stringify([message.content === "" ? null : message.content ?? null, calls.map(value => {
    const call = object(value), fn = object(call.function);
    if (typeof call.id !== "string" || call.type !== "function" || typeof fn.name !== "string" || typeof fn.arguments !== "string") invalid();
    let args: unknown; try { args = JSON.parse(fn.arguments); } catch { return invalid(); }
    return [call.id, fn.name, canonical(args)];
  })]);
}
/** One owned SDK-query bridge only. Hidden provider reasoning is never rendered,
 * logged, persisted or transferred across accounts/requests. Replay attaches it
 * solely to the exact assistant text/tool identities already seen upstream. */
export class SdkReasoningReplay {
  #entries = new Map<string, string>();
  #bytes = 0;
  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) invalid();
  }
  remember(value: unknown): void {
    const message = object(value), reasoning = message.reasoning_content;
    if (reasoning === undefined || reasoning === null || reasoning === "") return;
    if (message.role !== "assistant" || typeof reasoning !== "string") invalid();
    const key = identity(message), old = this.#entries.get(key), size = new TextEncoder().encode(key + reasoning).length;
    const next = this.#bytes + size - (old === undefined ? 0 : new TextEncoder().encode(key + old).length);
    if (next > this.maxBytes || !this.#entries.has(key) && this.#entries.size >= 128) throw new Error("SDK_REASONING_REPLAY_LIMIT");
    this.#entries.set(key, reasoning); this.#bytes = next;
  }
  apply(request: Value): Value {
    if (!Array.isArray(request.messages)) invalid();
    return { ...request, messages: request.messages.map(value => {
      const message = object(value);
      if (message.role !== "assistant") return message;
      const reasoning = this.#entries.get(identity(message));
      return reasoning === undefined ? message : { ...message, reasoning_content: reasoning };
    }) };
  }
  clear(): void { this.#entries.clear(); this.#bytes = 0; }
}
