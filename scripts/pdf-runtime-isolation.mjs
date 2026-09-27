import { resolve } from "node:path";
/** PDF.js publishes globals even when imported as ESM. Keep API and worker paired locally. */
export function pdfRuntimeIsolation(root) {
  return {
    inject: [resolve(root, "src/services/pdf-runtime-private.ts")],
    define: {
      "globalThis.pdfjsLib": "lifeosPrivatePdfRuntime.library",
      "globalThis.pdfjsWorker": "lifeosPrivatePdfRuntime.worker",
      "globalThis._pdfjsTestingUtils": "lifeosPrivatePdfRuntime.testing"
    }
  };
}
