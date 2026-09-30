import { fileURLToPath } from "node:url";

// JSZip's browser mapping points to a pre-bundled file containing IE-era
// <script> scheduling fallbacks. Resolve its maintained source modules so the
// scheduling replacements below are effective and reviewable.
const jszipSource = fileURLToPath(new URL("../../node_modules/jszip/lib/index.js", import.meta.url));
const scheduler = fileURLToPath(new URL("../vendor/review-safe-setimmediate.cjs", import.meta.url));
const nativePromise = fileURLToPath(new URL("../vendor/review-safe-promise.cjs", import.meta.url));

export const reviewSafeJsZip = {
  name: "review-safe-jszip",
  setup(build) {
    build.onResolve({ filter: /^jszip$/ }, () => ({ path: jszipSource }));
    build.onResolve({ filter: /^setimmediate$/ }, () => ({ path: scheduler }));
    build.onResolve({ filter: /^lie$/ }, () => ({ path: nativePromise }));
  }
};
