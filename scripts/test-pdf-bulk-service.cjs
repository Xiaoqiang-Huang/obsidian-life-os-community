const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const esbuild = require("esbuild");

class TFile {
  constructor(path, data, mtime = 1) {
    this.path = path;
    this.name = path.split("/").pop();
    this.basename = this.name.replace(/\.[^.]+$/u, "");
    this.extension = this.name.split(".").pop();
    this.data = data;
    this.stat = { size: data.length, mtime };
  }
}

function smallPdf() {
  const content = "BT /F1 12 Tf 72 720 Td (HELLO PDF SOURCE) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let output = "%PDF-1.4\n"; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return new TextEncoder().encode(output + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}

async function main() {
  const source = path.join(__dirname, "../src/services/LifeOSAgentService.ts");
  const bundled = await esbuild.build({ entryPoints: [source], bundle: true, platform: "node", format: "cjs",
    write: false, logLevel: "silent", external: ["obsidian", "pdfjs-dist/legacy/build/pdf.mjs"] });
  const originalLoad = Module._load;
  const obsidian = new Proxy({ TFile, normalizePath: value => value, requestUrl: async () => ({}) },
    { get: (target, key) => target[key] ?? class {} });
  Module._load = function(request, parent, isMain) {
    return request === "obsidian" ? obsidian : originalLoad.call(this, request, parent, isMain);
  };
  let Agent;
  try {
    const loaded = new Module("bulk-service-test.js", module);
    loaded.filename = path.join(__dirname, "bulk-service-test.js"); loaded.paths = module.paths;
    loaded._compile(bundled.outputFiles[0].text, loaded.filename);
    Agent = loaded.exports.LifeOSAgentService;
  } finally { Module._load = originalLoad; }
  const files = new Map();
  const original = new TFile("LifeOS/Knowledge/sample.pdf", smallPdf()); files.set(original.path, original);
  const vault = {
    getFiles: () => [...files.values()].filter(file => file.extension !== "md"),
    getMarkdownFiles: () => [...files.values()].filter(file => file.extension === "md"),
    getAbstractFileByPath: key => files.get(key) || null,
    readBinary: async file => file.data.slice().buffer,
    read: async file => file.data,
    cachedRead: async file => file.data,
    createFolder: async () => {},
    create: async (key, text) => { const file = new TFile(key, text); files.set(key, file); return file; },
    process: async (file, fn) => { file.data = fn(file.data); file.stat = { size: file.data.length, mtime: file.stat.mtime + 1 }; }
  };
  const agent = Object.create(Agent.prototype);
  agent.app = { vault };
  agent.events = { append: async () => {} };
  agent.ai = { complete: async () => { throw new Error("native text PDF must not invoke AI"); } };
  agent.fileSystem = () => ({ root: "LifeOS", path: (...parts) => `LifeOS/${parts.join("/")}` });
  agent.getSettings = () => ({ enableVisionFileAnalysis: false });
  agent.finalizeTurnMemory = async () => [];
  const prepared = { content: "尽量一口气跑完", sessionId: "s", runtimeMemoryKey: "s", turnId: "t",
    channel: "desktop", preparationEvents: [], persistEvents: false,
    workingCheckpoint: { objective: "sample.pdf里面写了什么", nextActions: [] } };
  const observed = [], callbacks = { onDone: text => observed.push(text) };
  const result = await agent.completeStream(prepared, {}, callbacks);
  assert.equal(result.ok, true);
  assert.match(result.text, /已完成整本识别/u);
  assert.match(result.text, /已识别 1 页/u);
  assert.equal(observed[0], result.text);
  const notes = vault.getMarkdownFiles(); assert.equal(notes.length, 1);
  assert.match(notes[0].data, /HELLO PDF SOURCE/u);
  assert.match(notes[0].data, /## 第 1 页 \[native\]/u);
  console.log("PASS service follow-up route, actual PDF parser, user-visible Markdown, no unnecessary model call");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
