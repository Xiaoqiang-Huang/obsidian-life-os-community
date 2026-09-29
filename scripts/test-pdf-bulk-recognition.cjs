const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const esbuild = require("esbuild");

async function main() {
  const bundled = await esbuild.build({ entryPoints: [path.join(__dirname, "../src/services/agent/PdfBulkRecognition.ts")],
    bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" });
  const loaded = new Module("pdf-bulk-recognition-test.js", module);
  loaded.filename = "pdf-bulk-recognition-test.js";
  loaded.paths = module.paths;
  loaded._compile(bundled.outputFiles[0].text, loaded.filename);
  const { bulkPdfQuery, selectUniquePdfPath, pdfCachedPages, recognizePdfPages, PDF_BULK_ACTION_PREFIX } = loaded.exports;
  const cp = { objective: "六级词汇大纲词.pdf里面写了什么", nextActions: [] };
  assert.equal(bulkPdfQuery("尽量一口气跑完", cp), "六级词汇大纲词.pdf");
  assert.equal(bulkPdfQuery("继续", cp), null, "generic continuation without a pending OCR task must not run");
  cp.nextActions.push(`${PDF_BULK_ACTION_PREFIX}PersonalLifeSystem/六级词汇大纲词.pdf`);
  assert.equal(bulkPdfQuery("继续", cp), "六级词汇大纲词.pdf");
  assert.equal(bulkPdfQuery("换个话题", cp), null);
  const source = "PersonalLifeSystem/知识库/六级词汇大纲词.pdf";
  assert.equal(selectUniquePdfPath("请把六级词汇大纲词.pdf全部识别", [source]), source);
  assert.equal(selectUniquePdfPath("六级词汇大纲词.pdf", [source, "PersonalLifeSystem/其他/六级词汇大纲词.pdf"]), null);
  const cached = pdfCachedPages("## 第 1 页 [vision]\nA\n## 第 28 页 [vision]\nB\n## 第 55 页 [vision]\nC\n## 第 3 页 [empty]\n");
  assert.deepEqual([...cached], [1, 28, 55]);
  const called = [], notices = [];
  const partial = await recognizePdfPages({ totalPages: 55, cached, maxNewPages: 3,
    read: async page => { called.push(page); return { text: `page ${page}`, cachePath: "cache.md" }; },
    onPage: async (page, completed) => notices.push([page, completed]) });
  assert.deepEqual(called, [2, 3, 4]);
  assert.deepEqual(notices, [[2, 4], [3, 5], [4, 6]]);
  assert.equal(partial.stopReason, "budget");
  assert.equal(partial.completed, 6);
  assert.equal(partial.remaining, 49);
  const resumed = await recognizePdfPages({ totalPages: 55, cached, maxNewPages: 60,
    read: async page => { called.push(page); return { text: `page ${page}`, cachePath: "cache.md" }; } });
  assert.equal(resumed.stopReason, "completed");
  assert.equal(resumed.completed, 55);
  assert.equal(resumed.remaining, 0);
  assert.equal(called.filter(page => page === 28 || page === 55).length, 0, "cached pages must never be re-sent");
  const cancelled = new AbortController(); cancelled.abort();
  const stopped = await recognizePdfPages({ totalPages: 2, cached: new Set(), maxNewPages: 2,
    signal: cancelled.signal, read: async () => { throw new Error("unexpected request"); } });
  assert.equal(stopped.stopReason, "cancelled");
  assert.equal(stopped.completed, 0);
  const failed = await recognizePdfPages({ totalPages: 2, cached: new Set(), maxNewPages: 2,
    read: async page => ({ text: page === 1 ? "visible" : "" }) });
  assert.equal(failed.stopReason, "failed");
  assert.equal(failed.completed, 1);
  console.log("PASS bulk PDF intent, unique target, cache skip, bounded resume, cancellation, empty-page stop");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
