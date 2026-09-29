const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const esbuild = require("esbuild");

async function main() {
  const bundled = await esbuild.build({ entryPoints: [path.join(__dirname, "../src/services/agent/AgentLoop.ts")],
    bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" });
  const loaded = new Module("agent-route-test.js", module);
  loaded.filename = "agent-route-test.js";
  loaded.paths = module.paths;
  loaded._compile(bundled.outputFiles[0].text, loaded.filename);
  const loop = new loaded.exports.AgentLoop(null, { hasExecutor: () => true }, null);
  const calls = (text) => loop.heuristicCalls({ toolContext: { userContent: text, imageParts: [] },
    hasLocalEvidence: false, hasWebEvidence: false }).map((call) => call.name);
  const local = calls("在资料库搜索六级词汇大纲词 PDF 内容");
  assert.ok(local.includes("document-file-find"));
  assert.ok(!local.includes("web-search"), "local document names must not leak to web search by default");
  assert.equal(loop.shouldPlanToolUse("根据六级词汇大纲词 PDF 内容回答问题"), true);
  const realQuestion = "六级词汇大纲词.pdf文档里面写了什么";
  assert.ok(calls(realQuestion).includes("document-file-find"), "natural file question must discover the original PDF");
  assert.equal(loop.shouldPlanToolUse(realQuestion), true, "natural file question must continue after discovery");
  assert.ok(calls("六级词汇大纲词.pdf里面写了什么").includes("document-file-find"));
  assert.ok(calls("考公-公考正道是沧桑-原因解释题目讲义.pdf里面写了什么").includes("document-file-find"));
  const withOtherEvidence = loop.heuristicCalls({ toolContext: { userContent: realQuestion, imageParts: [] },
    hasLocalEvidence: true, hasWebEvidence: false }).map((call) => call.name);
  assert.ok(withOtherEvidence.includes("document-file-find"), "unrelated local evidence must not suppress exact-file discovery");
  const source = "PersonalLifeSystem/知识库/附件/Originals/materials/六级词汇大纲词.pdf";
  const found = (candidates) => [{ ok: true, toolId: "document-file-find", callId: "call-1", output: JSON.stringify({ candidates }) }];
  assert.deepEqual(loop.followupDocumentRead(found([{ path: source, kind: "pdf", score: 100 }])),
    [{ id: "read-call-1", name: "pdf-page-read", input: { path: source, page: 1 } }]);
  assert.deepEqual(loop.followupDocumentRead(found([{ path: source, kind: "pdf", score: 0 }])), []);
  assert.deepEqual(loop.followupDocumentRead(found([{ path: source, kind: "pdf", score: 100 },
    { path: "PersonalLifeSystem/Knowledge/other.pdf", kind: "pdf", score: 100 }])), [], "ambiguous names require a choice");
  assert.deepEqual(loop.followupDocumentRead(found([{ path: "PersonalLifeSystem/Knowledge/note.docx", kind: "docx", score: 100 }])),
    [{ id: "read-call-1", name: "docx-text-read", input: { path: "PersonalLifeSystem/Knowledge/note.docx" } }]);
  assert.ok(calls("联网搜索 PDF 最新资料").includes("web-search"));
  const executed = [];
  const runtime = {
    hasExecutor: () => true, pendingWrite: () => null, available: () => [],
    descriptor: (name) => ({ id: name, mode: "read", description: name }),
    executeBatch: async (batch) => batch.map((call) => {
      executed.push(call.name);
      return { ok: true, toolId: call.name, callId: call.id, output: call.name === "document-file-find"
        ? JSON.stringify({ candidates: [{ path: source, kind: "pdf", score: 100 }] })
        : JSON.stringify({ page: 1, totalPages: 55, nextPage: 2 }) + "\n第 1 页扫描页识别文字" };
    })
  };
  const agent = new loaded.exports.AgentLoop({ complete: async () => ({ ok: true, text: "仅根据第 1 页识别内容回答" }) },
    runtime, { compact: (messages) => ({ messages, compacted: false }) });
  const result = await agent.run({ messages: [{ role: "user", content: realQuestion }],
    toolContext: { userContent: realQuestion, imageParts: [], channel: "desktop", sessionId: "test", turnId: "turn-1" },
    hasLocalEvidence: false, hasWebEvidence: false });
  assert.deepEqual(executed, ["document-file-find", "pdf-page-read"], "exact PDF must be read before final synthesis");
  assert.equal(result.ok, true);
  console.log("PASS local-document discovery, conditional follow-up planning, no accidental web search");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
