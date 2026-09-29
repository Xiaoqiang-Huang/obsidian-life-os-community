const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const esbuild = require("esbuild");
const { zipSync, strToU8 } = require("fflate");

function smallPdf() {
  const content = "BT /F1 12 Tf 72 720 Td (HELLO PDF SOURCE) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(output));
    output += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(output);
}

async function main() {
  const temp = path.join(__dirname, "../tmp");
  fs.mkdirSync(temp, { recursive: true });
  const output = path.join(temp, "recognition-native-parser.mjs");
  const result = await esbuild.build({ stdin: {
    contents: `export { readPdfPageText, extractReadableDocumentText } from "${path.join(__dirname, "../src/services/DocumentImportService.ts").replace(/\\/g, "/")}";`,
    resolveDir: __dirname, sourcefile: "native-parser-entry.ts", loader: "ts"
  }, bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
  external: ["pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-dist/legacy/build/pdf.worker.mjs"],
  plugins: [{ name: "obsidian-test-stub", setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export class TFolder {} export class TFile {}", loader: "js" }));
  } }] });
  fs.writeFileSync(output, result.outputFiles[0].contents);
  const { readPdfPageText, extractReadableDocumentText } = await import(pathToFileURL(output).href + `?t=${Date.now()}`);
  const pdf = await readPdfPageText(smallPdf(), 1);
  assert.equal(pdf.totalPages, 1);
  assert.match(pdf.text, /HELLO PDF SOURCE/u);
  const docx = zipSync({ "word/document.xml": strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>HELLO DOCX SOURCE</w:t></w:r></w:p></w:body></w:document>') });
  const word = await extractReadableDocumentText({ name: "sample.docx", size: docx.byteLength,
    arrayBuffer: async () => docx.slice().buffer }, "word", { maxTextChars: null });
  assert.match(word.text, /HELLO DOCX SOURCE/u);
  const oversized = zipSync({ "word/document.xml": strToU8("X".repeat(8 * 1024 * 1024 + 1)) });
  await assert.rejects(extractReadableDocumentText({ name: "large.docx", size: oversized.byteLength,
    arrayBuffer: async () => oversized.slice().buffer }, "word", { maxTextChars: null }), /8 MB/u);
  console.log("PASS actual pdfjs PDF page text and fflate DOCX body extraction");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
