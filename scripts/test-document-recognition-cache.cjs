const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const esbuild = require("esbuild");

async function loadService() {
  const services = path.join(__dirname, "../src/services").replace(/\\/g, "/");
  const result = await esbuild.build({
    stdin: { contents: `export * from "${services}/DocumentRecognitionCacheService.ts"; export { isManagedKnowledgePath } from "${services}/knowledge-document-scope.ts";`,
      resolveDir: __dirname, sourcefile: "recognition-cache-entry.ts", loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent",
    external: ["pdfjs-dist/legacy/build/pdf.mjs"],
    plugins: [{ name: "recognition-fixtures", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "fixture" }));
      build.onResolve({ filter: /^\.\/DocumentImportService$/ }, () => ({ path: "document-import", namespace: "fixture" }));
      build.onResolve({ filter: /^\.\.\/utils\/vault$/ }, () => ({ path: "vault-utils", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: id }) => ({ contents: id === "obsidian"
        ? "export class TFile { constructor(path, data, mtime=1) { this.path=path; this.name=path.split('/').pop(); this.basename=this.name.replace(/\\.[^.]+$/, ''); this.extension=this.name.split('.').pop(); this.data=data; this.stat={size:data.length,mtime}; } } globalThis.__TFile=TFile;"
        : id === "document-import"
          ? "export async function readPdfPageText(bytes, page) { globalThis.__reads++; const text=new TextDecoder().decode(bytes); if(text === 'SCAN') structuredClone(bytes.buffer,{transfer:[bytes.buffer]}); return {text:text === 'SCAN' ? '' : text, page, totalPages:3, requiresOcr:text === 'SCAN'}; } export async function extractReadableDocumentText(file) { globalThis.__reads++; return {text:new TextDecoder().decode(await file.arrayBuffer()),warnings:[]}; }"
          : "export async function ensureFolder() {}", loader: "js" }));
    } }]
  });
  const output = new Module("recognition-test.js", module);
  output.filename = "recognition-test.js";
  output.paths = module.paths;
  output._compile(result.outputFiles[0].text, output.filename);
  return { ...output.exports, TFile: globalThis.__TFile };
}

async function main() {
  globalThis.__reads = 0;
  const { DocumentRecognitionCacheService, isDocumentRecognitionPath, isManagedKnowledgePath, recognizedSourcePath, orderRecognizedPdfPages, TFile } = await loadService();
  assert.equal(orderRecognizedPdfPages("# title\n## 第 28 页 [vision]\nB\n## 第 1 页 [vision]\nA\n"),
    "# title\n## 第 1 页 [vision]\nA\n## 第 28 页 [vision]\nB\n");
  const files = new Map();
  const fs = { path: (...parts) => `LifeOS/${parts.join("/")}` };
  const app = { vault: {
    getAbstractFileByPath: (key) => files.get(key) || null,
    getMarkdownFiles: () => [...files.values()].filter((file) => file.extension === "md"),
    readBinary: async (file) => new TextEncoder().encode(file.data).buffer,
    read: async (file) => file.data,
    cachedRead: async (file) => file.data,
    create: async (key, content) => { const file = new TFile(key, content); files.set(key, file); return file; },
    process: async (file, fn) => { file.data = fn(file.data); file.stat.size = file.data.length; file.stat.mtime++; }
  } };
  const first = new TFile("LifeOS/Knowledge/Attachments/a.pdf", "PDF CONTENT");
  files.set(first.path, first);
  const service = new DocumentRecognitionCacheService(app, fs);
  const initial = await service.readPdfPage(first, 1);
  assert.equal(initial.text, "PDF CONTENT");
  assert.equal(initial.fromCache, false);
  assert.equal(globalThis.__reads, 1);
  assert.ok(isDocumentRecognitionPath(initial.cachePath, fs));
  assert.equal(isManagedKnowledgePath(initial.cachePath, fs), false, "derived note must not appear as a library document");
  assert.equal(recognizedSourcePath(files.get(initial.cachePath).data), first.path);
  const repeated = await new DocumentRecognitionCacheService(app, fs).readPdfPage(first, 1);
  assert.equal(repeated.fromCache, true);
  assert.equal(globalThis.__reads, 1);
  assert.equal((await service.currentCaches()).get(first.path).path, initial.cachePath);

  const copy = new TFile("LifeOS/Knowledge/Attachments/copy.pdf", first.data);
  files.set(copy.path, copy);
  const copied = await service.readPdfPage(copy, 1);
  assert.notEqual(copied.cachePath, initial.cachePath);
  assert.equal(copied.fromCache, true, "identical binary in another path should reuse recognition");
  assert.equal(globalThis.__reads, 1);
  assert.equal(recognizedSourcePath(files.get(copied.cachePath).data), copy.path);

  first.data = "PDF CHANGED"; first.stat = { size: 11, mtime: 2 };
  const changed = await service.readPdfPage(first, 1);
  assert.notEqual(changed.cachePath, initial.cachePath);
  assert.equal((await service.currentCaches()).get(first.path).path, changed.cachePath);

  const scan = new TFile("LifeOS/Knowledge/Attachments/scan.pdf", "SCAN");
  files.set(scan.path, scan);
  const empty = await service.readPdfPage(scan, 2);
  assert.equal(empty.requiresOcr, true);
  service.renderPdfPage = async (bytes) => {
    assert.equal(bytes.byteLength, 4, "OCR rendering must retain the original PDF bytes after native parser transfer");
    return "data:image/jpeg;base64,AAAA";
  };
  const vision = await service.readPdfPage(scan, 2, undefined, async () => "看见的文字");
  assert.equal(vision.method, "vision");
  assert.equal((await service.readPdfPage(scan, 2)).text, "看见的文字");

  const word = new TFile("LifeOS/Knowledge/Attachments/doc.docx", "DOCX TEXT");
  files.set(word.path, word);
  const document = await service.readDocx(word);
  assert.equal(document.fromCache, false);
  assert.equal((await new DocumentRecognitionCacheService(app, fs).readDocx(word)).fromCache, true);
  console.log("PASS native PDF cache, restart reuse, copy isolation, invalidation, scan upgrade, DOCX cache");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
