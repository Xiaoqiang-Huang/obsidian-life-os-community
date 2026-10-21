/** Desktop native HTTP port: does not use Electron/browser fetch, cookies, CORS,
 * proxy environment, automatic redirects or retries. Node imports are lazy. */
export function createNodeSdkTransport(desktop: boolean): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!desktop) throw new Error("SDK_NODE_TRANSPORT_DESKTOP_ONLY");
    if (typeof input !== "string" && !(input instanceof URL)) throw new Error("SDK_NODE_TRANSPORT_INVALID_REQUEST");
    const url = new URL(String(input));
    if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("SDK_NODE_TRANSPORT_INVALID_URL");
    if (init?.method !== "POST" || typeof init.body !== "string" || init.redirect !== "manual") throw new Error("SDK_NODE_TRANSPORT_INVALID_REQUEST");
    if (init.signal?.aborted) throw new Error("SDK_NODE_TRANSPORT_ABORTED");
    const http = url.protocol === "https:" ? await import("node:https") : await import("node:http");
    const headers: Record<string, string> = {}; new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    if (headers["accept-encoding"] && headers["accept-encoding"] !== "identity") throw new Error("SDK_NODE_TRANSPORT_ENCODING_UNSUPPORTED");
    headers["accept-encoding"] = "identity";
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const req = http.request(url, { method: "POST", headers, signal: init.signal || undefined, agent: false }, response => {
        if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") { response.destroy(); reject(new Error("SDK_NODE_TRANSPORT_ENCODING_UNSUPPORTED")); return; }
        const status = response.statusCode || 502;
        const head = new Headers(); for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) head.set(name, Array.isArray(value) ? value.join(", ") : value);
        let streamDone = false;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            response.on("data", (chunk: Uint8Array) => { if (streamDone) return; controller.enqueue(new Uint8Array(chunk)); if ((controller.desiredSize ?? 0) <= 0) response.pause(); });
            response.once("end", () => { if (!streamDone) { streamDone = true; controller.close(); } });
            const failed = () => { if (!streamDone) { streamDone = true; controller.error(new Error("SDK_NODE_TRANSPORT_FAILED")); } };
            response.once("error", failed); response.once("aborted", failed);
          },
          pull() { if (!streamDone) response.resume(); },
          cancel() { streamDone = true; response.destroy(); req.destroy(); }
        });
        settled = true;
        if ([204, 205, 304].includes(status)) { response.resume(); resolve(new Response(null, { status, headers: head })); }
        else resolve(new Response(stream, { status, headers: head }));
      });
      req.once("error", () => { if (!settled) reject(new Error(init.signal?.aborted ? "SDK_NODE_TRANSPORT_ABORTED" : "SDK_NODE_TRANSPORT_FAILED")); });
      req.once("upgrade", (_response, socket) => { socket.destroy(); reject(new Error("SDK_NODE_TRANSPORT_INVALID_RESPONSE")); });
      req.end(init.body);
    });
  }) as typeof fetch;
}
