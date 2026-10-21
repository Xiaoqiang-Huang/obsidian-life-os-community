import { Validator, type Schema } from "@cfworker/json-schema";
import type { AiRequest } from "../../ai";
import { sdkFault } from "./SdkUsageLedger";

export function sdkJsonValidator(schema: Record<string, unknown>): (value: unknown) => boolean {
  let nodes = 0;
  const inspect = (v: unknown, depth: number) => {
    if (++nodes > 10000 || depth > 32) throw sdkFault("SCHEMA_INVALID");
    if (!v || typeof v !== "object") return;
    for (const [k, value] of Object.entries(v)) {
      if ((k === "$ref" && (typeof value !== "string" || !value.startsWith("#/"))) || k === "$dynamicRef" || k === "$recursiveRef") throw sdkFault("SCHEMA_INVALID");
      inspect(value, depth + 1);
    }
  };
  inspect(schema, 0);
  try { const validator = new Validator(schema as Schema); return value => validator.validate(value).valid; }
  catch { throw sdkFault("SCHEMA_INVALID"); }
}
export interface SdkPrompt { system: string; content: Array<Record<string, unknown>>; vision: boolean }
/** No implicit @ expansion, filesystem reads, URL fetches or image download.
 * Explicit inline data images only. Remote/file/blob URLs require a host to
 * resolve them with its own scope/consent before submitting this request. */
export function prepareSdkPrompt(request: AiRequest, maxBytes: number, jsonSchema?: Record<string, unknown>): SdkPrompt {
  if (!request || !Array.isArray(request.messages) || !request.messages.length || request.messages.length > 200) throw sdkFault("INVALID_INPUT");
  const system: string[] = [], transcript: unknown[] = [], images: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const m of request.messages) {
    if (!m || !["system", "user", "assistant"].includes(m.role)) throw sdkFault("INVALID_INPUT");
    const parts = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    if (!Array.isArray(parts) || parts.length > 100) throw sdkFault("INVALID_INPUT");
    const texts: string[] = [];
    for (const v of parts) {
      if (v.type === "text" && typeof v.text === "string") { texts.push(v.text); bytes += new TextEncoder().encode(v.text).length; }
      else if (v.type === "image_url" && m.role === "user") {
        const raw = v.image_url?.url, match = typeof raw === "string" && /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
        if (!match || match[2].length % 4 !== 0 || match[2].length > 8 * 1024 * 1024) throw sdkFault("IMAGE_INLINE_REQUIRED");
        bytes += raw.length; if (images.length >= 20) throw sdkFault("INPUT_LIMIT");
        images.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
        texts.push(`[explicit image ${images.length}]`);
      } else throw sdkFault("INVALID_INPUT");
      if (bytes > maxBytes) throw sdkFault("INPUT_LIMIT");
    }
    if (m.role === "system") system.push(texts.join("\n")); else transcript.push({ role: m.role, content: texts.join("\n") });
  }
  if (!transcript.length) throw sdkFault("INVALID_INPUT");
  if (request.responseFormat === "json") system.push("Return only one valid JSON value, without Markdown fences or commentary." + (jsonSchema ? " It must satisfy this host schema: " + JSON.stringify(jsonSchema) : ""));
  // The streaming SDK input only accepts user messages. Keep historical roles
  // explicit in a quoted transcript rather than relabel assistant turns as users.
  return { system: system.join("\n\n"), content: [{ type: "text", text: "Life OS conversation transcript (roles preserved):\n" + JSON.stringify(transcript) }, ...images], vision: images.length > 0 };
}
