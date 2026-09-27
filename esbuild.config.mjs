import esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { pdfRuntimeIsolation } from "./scripts/pdf-runtime-isolation.mjs";
import { readFileSync } from "node:fs";
import process from "process";
import builtins from "builtin-modules";
import { buildUIStyles } from "./scripts/build-ui-styles.mjs";

const prod = process.argv[2] === "production";
await buildUIStyles();

const context = await esbuild.context({
  ...pdfRuntimeIsolation(fileURLToPath(new URL(".", import.meta.url))),
  banner: {
    js: "/* Personal Life System Obsidian Plugin */\n/* Mozilla Readability 0.6.0 — Copyright Mozilla contributors.\n" + readFileSync(new URL("./src/vendor/readability/LICENSE.md", import.meta.url), "utf8").replaceAll("*/", "* /") + "\n*/"
  },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
