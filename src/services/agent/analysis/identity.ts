export async function hashBytes(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("analysis-hash-capability-unavailable");
  // Buffer.slice() is a view, unlike Uint8Array.slice(). Hash ONLY supplied bytes.
  const buffer = new Uint8Array(bytes).buffer;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
}
/** Hash exact JS UTF-16 code units, including unpaired surrogates. No normalization. */
export function hashText(text: string): Promise<string> {
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); bytes[i * 2] = c & 255; bytes[i * 2 + 1] = c >>> 8; }
  return hashBytes(bytes);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).filter(k => (value as Record<string, unknown>)[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  const result = JSON.stringify(value); if (result === undefined) throw new Error("non-json-identity"); return result;
}
export const hashRecord = (value: unknown): Promise<string> => hashText(canonical(value));
export function safePath(path: string): string {
  const p = path.replace(/\\/gu, "/");
  if (!p || p.startsWith("/") || /^[a-z]:/iu.test(p) || p.split("/").some(s => !s || s === "." || s === "..")) throw new Error("invalid-vault-path");
  return p;
}
export function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function newId(): string { return globalThis.crypto.randomUUID(); }
