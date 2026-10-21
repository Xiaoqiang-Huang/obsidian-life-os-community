import { setMaxListeners as nodeSetMaxListeners } from "node:events";

/** Electron DOM AbortSignal is not Node's EventTarget. Browser targets have no
 * Node max-listener warning limit; skip ONLY that optional tuning operation.
 * Abort propagation, listeners, Node emitters and all other errors are unchanged. */
export function rendererSetMaxListeners(limit: number, ...targets: Parameters<typeof nodeSetMaxListeners>[1][]): void {
  if (targets.length === 0) { nodeSetMaxListeners(limit); return; }
  for (const target of targets) {
    try { nodeSetMaxListeners(limit, target); }
    catch (error) {
      const signal = target as unknown as AbortSignal;
      if ((error as { code?: string })?.code !== "ERR_INVALID_ARG_TYPE" || typeof globalThis.AbortSignal !== "function" || !(signal instanceof globalThis.AbortSignal) || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function") throw error;
    }
  }
}
