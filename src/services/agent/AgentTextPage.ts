/** Bounded, resumable text reads. Offsets are JavaScript UTF-16 indices. */
export function readAgentTextPage(text: string, source: string, offsetValue?: unknown, limitValue?: unknown) {
  const parse = (value: unknown, fallback: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error("offset/limit must be non-negative safe integers");
    }
    return value;
  };
  let offset = Math.min(parse(offsetValue, 0), text.length);
  const limit = Math.min(Math.max(parse(limitValue, 12000), 2), 24000);
  // Never return half a surrogate pair, even for a caller-supplied offset.
  if (offset > 0 && /[\uDC00-\uDFFF]/u.test(text[offset] || "") && /[\uD800-\uDBFF]/u.test(text[offset - 1])) offset--;
  let end = Math.min(offset + limit, text.length);
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
  const metadata = { source, offset, end, totalChars: text.length, hasMore: end < text.length, nextOffset: end, status: end < text.length ? "partial" : "complete" };
  return { output: JSON.stringify(metadata) + "\n" + text.slice(offset, end), metadata };
}
