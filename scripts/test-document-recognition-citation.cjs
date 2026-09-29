const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const esbuild = require("esbuild");

async function main() {
  const root = path.join(__dirname, "../src/services/context-engine").replace(/\\/g, "/");
  const result = await esbuild.build({ stdin: {
    contents: `export { ObsidianMetadataService } from "${root}/ObsidianMetadataService.ts"; export { HybridRetrievalService } from "${root}/HybridRetrievalService.ts";`,
    resolveDir: __dirname, sourcefile: "recognition-citation-entry.ts", loader: "ts"
  }, bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" });
  const loaded = new Module("recognition-citation-test.js", module);
  loaded.filename = "recognition-citation-test.js";
  loaded.paths = module.paths;
  loaded._compile(result.outputFiles[0].text, loaded.filename);
  const { ObsidianMetadataService, HybridRetrievalService } = loaded.exports;
  const sourcePath = "LifeOS/Knowledge/Attachments/原件.pdf";
  const cachePath = "LifeOS/Knowledge/DocumentRecognition/abc.md";
  const source = { path: sourcePath, name: "原件.pdf", stat: { size: 12, mtime: 42 } };
  const markdown = `---\ntype: lifeos-document-recognition\nsource_file: "${sourcePath}"\nsource_size: 12\nsource_mtime: 42\n---\n\n# 原件 · 识别文本\n\n## 第 2 页 [native]\n\n独特船舶词 这是第二页的可核对文字。\n`;
  const note = { path: cachePath, name: "abc.md", basename: "abc", stat: { size: markdown.length, mtime: 8 } };
  const wordPath = "LifeOS/Knowledge/Attachments/原件.docx";
  const wordCachePath = "LifeOS/Knowledge/DocumentRecognition/docx.md";
  const wordSource = { path: wordPath, name: "原件.docx", stat: { size: 14, mtime: 7 } };
  const wordMarkdown = `---\ntype: lifeos-document-recognition\nsource_file: "${wordPath}"\nsource_size: 14\nsource_mtime: 7\n---\n\n# 原件 · 识别文本\n\n## 正文 [native]\n\nDOCXONLYTERM 这是 DOCX 正文。\n`;
  const wordNote = { path: wordCachePath, name: "docx.md", basename: "docx", stat: { size: wordMarkdown.length, mtime: 9 } };
  let includeWord = false;
  let includeEmpty = false;
  const emptyPath = "LifeOS/Knowledge/Attachments/empty.pdf";
  const emptyCachePath = "LifeOS/Knowledge/DocumentRecognition/empty.md";
  const emptySource = { path: emptyPath, name: "empty.pdf", stat: { size: 4, mtime: 1 } };
  const emptyMarkdown = `---\ntype: lifeos-document-recognition\nsource_file: "${emptyPath}"\nsource_size: 4\nsource_mtime: 1\n---\n\n# EMPTYONLYTERM · 识别文本\n\n## 第 1 页 [empty]\n\n（本页没有可识别文字）\n`;
  const emptyNote = { path: emptyCachePath, name: "empty.md", basename: "empty", stat: { size: emptyMarkdown.length, mtime: 10 } };
  const app = { vault: {
    getMarkdownFiles: () => [note, ...(includeWord ? [wordNote] : []), ...(includeEmpty ? [emptyNote] : [])],
    getAbstractFileByPath: (key) => key === cachePath ? note : key === sourcePath ? source
      : key === wordCachePath ? wordNote : key === wordPath ? wordSource
        : key === emptyCachePath ? emptyNote : key === emptyPath ? emptySource : null,
    read: async (file) => file.path === wordCachePath ? wordMarkdown : file.path === emptyCachePath ? emptyMarkdown : markdown
  } };
  const metadata = new ObsidianMetadataService(app, "LifeOS");
  const search = new HybridRetrievalService(app, metadata, "LifeOS");
  const inventory = await metadata.getInventory();
  assert.equal(inventory.length, 1);
  const result1 = await search.search({ inventory, userMessage: "独特船舶词", maxResults: 5 });
  assert.ok(result1.evidence.length > 0);
  assert.equal(result1.evidence[0].source.originalPath, sourcePath);
  assert.equal(result1.evidence[0].source.page, 2);
  source.stat.mtime = 43;
  assert.equal((await metadata.getInventory()).length, 0, "changed original must invalidate cached evidence");
  const result2 = await search.search({ inventory: await metadata.getInventory(), userMessage: "独特船舶词" });
  assert.equal(result2.evidence.length, 0);
  includeWord = true;
  const wordEvidence = await search.search({ inventory: await metadata.getInventory(), userMessage: "DOCXONLYTERM" });
  assert.equal(wordEvidence.evidence[0]?.source.originalPath, wordPath);
  assert.equal(wordEvidence.evidence[0]?.source.page, undefined);
  includeEmpty = true;
  const emptyEvidence = await search.search({ inventory: await metadata.getInventory(), userMessage: "EMPTYONLYTERM" });
  assert.equal(emptyEvidence.evidence.length, 0, "empty scan must not become a cited source");
  console.log("PASS PDF/DOCX original citations, stale source excluded, empty scan not cited");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
