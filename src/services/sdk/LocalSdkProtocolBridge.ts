import { assertSdkNativeStream, NativeTextPreview } from "./SdkNativeStream";
import { sdkProtocolFailure, type SdkProtocolFailure } from "./SdkProtocolDiagnostic";
import { SdkReasoningReplay } from "./SdkReasoningReplay";
import type { UnifiedAIConfig } from "./AIConfigResolver";
import { toAnthropicResponse } from "./SdkMessageCodec";
import { toOpenAISdkRequest } from "./SdkRequestEnvelope";
import { OpenAIStreamAccumulator, encodeAnthropicSSE, toOpenAIStreamingRequest } from "./SdkStreamCodec";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Internal-only port. Not an SDK settings form or alternative execution engine.
 * Credentials/headers are explicitly supplied by a future ordinary-config resolver.
 * No environment discovery, model calls on startup, redirects or automatic retry. */
export interface LocalSdkBridgeOptions {
  desktop: boolean;
  config: Pick<UnifiedAIConfig, "route" | "protocol" | "model" | "upstreamURL">;
  upstreamHeaders: Readonly<Record<string, string>>;
  transport: typeof fetch;
  timeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxConcurrent?: number;
  /** Static redacted failure only; production aborts the SDK before a retry. */
  onFailure?(code: string, failure?: Readonly<SdkProtocolFailure>): void;
  /** Capture immutable request identity before awaiting upstream. UI-only text. */
  captureTextPreview?(): ((text: string) => void) | undefined;
  captureFailure?(): LocalSdkBridgeOptions["onFailure"];
  reasoningEffort?: "default" | "low" | "medium" | "high" | "max";
}
export interface LocalSdkBridge {
  readonly baseURL: string;
  /** Ephemeral credential for the SDK child only. Never persist or log. */
  readonly sessionToken: string;
  state(): { active: number; requests: number; completed: number; failed: number; disposed: boolean };
  dispose(): Promise<void>;
}
class BridgeFault extends Error { constructor(readonly code: string, readonly status: number) { super(code); } }
function limit(value: number | undefined, fallback: number, max: number): number {
  const v = value ?? fallback;
  if (!Number.isSafeInteger(v) || v <= 0 || v > max) throw new Error("SDK_BRIDGE_INVALID_LIMIT"); return v;
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("SDK_BRIDGE_ABORTED"));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error("SDK_BRIDGE_ABORTED")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(v => { cleanup(); resolve(v); }, e => { cleanup(); reject(e); });
  });
}
async function write(res: ServerResponse, text: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted || res.destroyed) throw new Error("SDK_BRIDGE_ABORTED");
  if (res.write(text)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { res.removeListener("drain", drain); res.removeListener("close", closed); signal.removeEventListener("abort", closed); };
    const drain = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error("SDK_BRIDGE_ABORTED")); };
    res.once("drain", drain); res.once("close", closed); signal.addEventListener("abort", closed, { once: true });
    if (signal.aborted || res.destroyed) closed();
  });
}
async function body(req: IncomingMessage, max: number, signal: AbortSignal): Promise<string> {
  let size = 0; const pieces: Uint8Array[] = [];
  const it = req[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await abortable(it.next(), signal); if (next.done) break;
      const bytes = next.value as Uint8Array; size += bytes.byteLength;
      if (size > max) throw new BridgeFault("SDK_BRIDGE_INPUT_LIMIT", 413); pieces.push(bytes);
    }
    const combined = new Uint8Array(size); let at = 0; for (const piece of pieces) { combined.set(piece, at); at += piece.length; }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(combined); } catch { throw new BridgeFault("SDK_BRIDGE_INVALID_BODY", 400); }
  } finally { if (signal.aborted) req.destroy(); }
}
async function readResponse(response: Response, max: number, signal: AbortSignal, chunk?: (bytes: Uint8Array) => void): Promise<Uint8Array> {
  if (!response.body) throw new Error("SDK_BRIDGE_EMPTY_BODY");
  const reader = response.body.getReader(); let size = 0; const pieces: Uint8Array[] = [];
  try {
    while (true) {
      const next = await abortable(reader.read(), signal); if (next.done) break;
      size += next.value.byteLength; if (size > max) throw new Error("SDK_BRIDGE_OUTPUT_LIMIT");
      if (chunk) chunk(next.value); else pieces.push(next.value);
    }
  } finally {
    // A transport may fail to settle cancellation. The request timeout/dispose
    // signal still releases the host slot; late reader values are never used.
    await abortable(reader.cancel().catch(() => undefined), signal).catch(() => undefined);
    try { reader.releaseLock(); } catch { /* Pending reads cannot publish after abort. */ }
  }
  if (chunk) return new Uint8Array();
  const combined = new Uint8Array(size); let at = 0; for (const piece of pieces) { combined.set(piece, at); at += piece.length; } return combined;
}

export async function startLocalSdkProtocolBridge(options: LocalSdkBridgeOptions): Promise<LocalSdkBridge> {
  // Must run before any Node imports or socket operation.
  if (!options.desktop) throw new Error("SDK_BRIDGE_DESKTOP_ONLY");
  const direct = ["anthropic-direct", "anthropic-bridge"].includes(options.config.route) && options.config.protocol === "anthropic-messages";
  if (!direct && (options.config.route !== "openai-bridge" || options.config.protocol !== "openai-chat")) throw new Error("SDK_BRIDGE_PROTOCOL_UNSUPPORTED");
  const maxInput = limit(options.maxInputBytes, 32 * 1024 * 1024, 32 * 1024 * 1024);
  const maxOutput = limit(options.maxOutputBytes, 16 * 1024 * 1024, 64 * 1024 * 1024);
  const replay = new SdkReasoningReplay(maxOutput);
  const timeout = limit(options.timeoutMs, 120000, 600000), maxConcurrent = limit(options.maxConcurrent, 2, 8);
  if (typeof options.config.upstreamURL !== "string" || options.config.upstreamURL.length > 2048 || /[\s\u0000-\u001f\u007f\\]/.test(options.config.upstreamURL)) throw new Error("SDK_BRIDGE_INVALID_URL");
  let url: URL; try { url = new URL(options.config.upstreamURL); } catch { throw new Error("SDK_BRIDGE_INVALID_URL"); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("SDK_BRIDGE_INVALID_URL");
  const upstreamURL = url.href, model = options.config.model, headers: Record<string, string> = { "content-type": "application/json" };
  if (!model || model.length > 256 || /[\u0000-\u001f]/.test(model) || typeof options.transport !== "function") throw new Error("SDK_BRIDGE_INVALID_CONFIG");
  const names = new Set<string>();
  for (const [name, value] of Object.entries(options.upstreamHeaders)) {
    const low = name.toLowerCase();
    if (!/^[a-z0-9-]+$/.test(low) || names.has(low) || ["host", "connection", "transfer-encoding", "content-length", "cookie", "origin", "referer"].includes(low) || typeof value !== "string" || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value) || (low === "content-type" && !/^application\/json(?:\s*;|$)/i.test(value))) throw new Error("SDK_BRIDGE_INVALID_HEADERS");
    names.add(low); headers[low] = value;
  }
  Object.freeze(headers);
  const transport = options.transport;
  const reasoningEffort = options.reasoningEffort;
  if (reasoningEffort !== undefined && !["default", "low", "medium", "high", "max"].includes(reasoningEffort)) throw new Error("SDK_BRIDGE_INVALID_CONFIG");
  const http = await import("node:http"), crypto = await import("node:crypto");
  const sessionToken = crypto.randomBytes(32).toString("hex");
  let disposed = false, requests = 0, completed = 0, failed = 0, host = "";
  const active = new Set<AbortController>(), tasks = new Set<Promise<void>>();
  const error = (res: ServerResponse, code: string, status: number) => {
    if (res.destroyed || res.writableEnded) return;
    const result = { type: "error", error: { type: status >= 400 && status < 500 ? "invalid_request_error" : "api_error", message: code } };
    if (res.headersSent) res.end(encodeAnthropicSSE(result));
    else { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(result)); }
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (disposed) { error(res, "SDK_BRIDGE_DISPOSED", 503); return; }
    if (req.headers.host !== host || req.headers.origin) { error(res, "SDK_BRIDGE_ORIGIN_DENIED", 403); return; }
    // The fixed SDK's Messages beta client adds this one literal query flag.
    if (req.method !== "POST" || !["/v1/messages", "/v1/messages?beta=true"].includes(req.url || "")) { error(res, "SDK_BRIDGE_ROUTE_DENIED", 404); return; }
    const credentials = req.headers["x-api-key"] || (typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "");
    if ((req.headers["x-api-key"] && req.headers.authorization) || typeof credentials !== "string" || !/^[a-f0-9]{64}$/.test(credentials) || !crypto.timingSafeEqual(Buffer.from(credentials), Buffer.from(sessionToken))) { error(res, "SDK_BRIDGE_AUTH_DENIED", 401); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) { error(res, "SDK_BRIDGE_CONTENT_TYPE", 415); return; }
    const declared = req.headers["content-length"];
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxInput)) { error(res, "SDK_BRIDGE_INPUT_LIMIT", 413); return; }
    if (active.size >= maxConcurrent) { error(res, "SDK_BRIDGE_BUSY", 429); return; }
    const controller = new AbortController(), signal = controller.signal; active.add(controller); requests++;
    const reportFailure = options.captureFailure ? options.captureFailure() : options.onFailure;
    let timedOut = false, stage: SdkProtocolFailure["stage"] = "request-body", status: number | undefined, conversionFailure: unknown;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    const abort = () => { if (!res.writableFinished) controller.abort(); };
    req.once("aborted", abort); res.once("close", abort);
    try {
      let payload: unknown; try { payload = JSON.parse(await body(req, maxInput, signal)); } catch (e) { if (e instanceof BridgeFault || signal.aborted) throw e; throw new BridgeFault("SDK_BRIDGE_INVALID_BODY", 400); }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new BridgeFault("SDK_BRIDGE_INVALID_BODY", 400);
      const request = payload as Record<string, unknown>;
      if (request.model !== model) throw new BridgeFault("SDK_BRIDGE_MODEL_CHANGED", 400);
      const streaming = request.stream === true;
      stage = "request-convert";
      let converted: Record<string, unknown>;
      try { converted = direct ? { ...request } : streaming ? toOpenAIStreamingRequest(request, reasoningEffort) : toOpenAISdkRequest(request, reasoningEffort); } catch (e) { conversionFailure = e; throw new BridgeFault("SDK_BRIDGE_UNSUPPORTED_REQUEST", 400); }
      if (!direct) converted = replay.apply(converted);
      const capturedPreview = streaming ? options.captureTextPreview?.() : undefined;
      const preview = capturedPreview ? (text: string) => {
        if (!signal.aborted && !disposed) capturedPreview(text);
      } : undefined;
      stage = "upstream";
      const upstream = await abortable(transport(upstreamURL, { method: "POST", headers, body: JSON.stringify(converted), signal, redirect: "manual" }), signal);
      status = upstream.status;
      if (!upstream.ok) { await upstream.body?.cancel().catch(() => undefined); throw new BridgeFault("SDK_BRIDGE_UPSTREAM_STATUS", upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502); }
      stage = "response-headers";
      if (streaming) {
        if (!/text\/event-stream/i.test(upstream.headers.get("content-type") || "")) { await upstream.body?.cancel().catch(() => undefined); throw new Error("SDK_BRIDGE_INVALID_CONTENT_TYPE"); }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
        await write(res, encodeAnthropicSSE({ type: "ping" }), signal);
        const decoder = new OpenAIStreamAccumulator(maxOutput, Math.min(maxOutput, 2 * 1024 * 1024), preview);
        const nativePreview = direct && preview ? new NativeTextPreview(maxOutput, preview) : undefined;
        const directPieces: Uint8Array[] = [];
        stage = "response-stream";
        await readResponse(upstream, maxOutput, signal, bytes => { if (direct) { directPieces.push(bytes); nativePreview?.push(bytes); } else decoder.push(bytes); });
        stage = "response-final";
        const nativeDecoder = new TextDecoder("utf-8", { fatal: true });
        const events = direct ? [...directPieces.map(b => nativeDecoder.decode(b, { stream: true })), nativeDecoder.decode()] : decoder.finish().map(encodeAnthropicSSE);
        if (direct) assertSdkNativeStream(events.join(""));
        if (!direct) { const material = decoder.takeReasoningReplay(); if (material) replay.remember(material); }
        if (events.reduce((n, s) => n + Buffer.byteLength(s), 0) > maxOutput) throw new Error("SDK_BRIDGE_OUTPUT_LIMIT");
        stage = "response-write";
        for (const event of events) await write(res, event, signal);
        if (signal.aborted) throw new Error("SDK_BRIDGE_ABORTED"); res.end();
      } else {
        if (!/application\/json/i.test(upstream.headers.get("content-type") || "")) { await upstream.body?.cancel().catch(() => undefined); throw new Error("SDK_BRIDGE_INVALID_CONTENT_TYPE"); }
        stage = "response-final";
        const bytes = await readResponse(upstream, maxOutput, signal);
        const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        const response = JSON.stringify(direct ? parsed : toAnthropicResponse(parsed));
        if (!direct) replay.remember(parsed.choices[0].message);
        if (Buffer.byteLength(response) > maxOutput || signal.aborted) throw new Error("SDK_BRIDGE_OUTPUT_LIMIT");
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(response);
      }
      completed++;
    } catch (e) {
      const aborted = signal.aborted; failed++; controller.abort();
      const code = timedOut ? "SDK_BRIDGE_TIMEOUT" : aborted ? "SDK_BRIDGE_ABORTED" : e instanceof BridgeFault ? e.code : e instanceof Error && e.message.startsWith("SDK_NODE_TRANSPORT_") ? "SDK_BRIDGE_UPSTREAM_CONNECTION" : "SDK_BRIDGE_UPSTREAM_INVALID";
      if (code !== "SDK_BRIDGE_ABORTED") { try { reportFailure?.(code, sdkProtocolFailure(stage, conversionFailure ?? e, status)); } catch { /* Never expose callback exceptions or retry. */ } }
      error(res, code, timedOut ? 504 : e instanceof BridgeFault ? e.status : 502);
    } finally {
      clearTimeout(timer); req.removeListener("aborted", abort); res.removeListener("close", abort); active.delete(controller);
    }
  };
  const server = http.createServer((req, res) => {
    const task = handle(req, res); tasks.add(task); void task.finally(() => tasks.delete(task)).catch(() => undefined);
  });
  server.requestTimeout = timeout; server.headersTimeout = Math.min(timeout, 30000);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === "string") { server.close(); throw new Error("SDK_BRIDGE_BIND_FAILED"); }
  host = "127.0.0.1:" + address.port;
  let disposing: Promise<void> | undefined;
  return Object.freeze({ baseURL: "http://" + host, sessionToken,
    state: () => ({ active: active.size, requests, completed, failed, disposed }),
    dispose: () => {
      if (!disposing) {
        disposed = true; for (const controller of active) controller.abort();
        disposing = (async () => {
          const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections();
          await Promise.allSettled([...tasks]); replay.clear(); await closed;
        })();
      }
      return disposing;
    } });
}
