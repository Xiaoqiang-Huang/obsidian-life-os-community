const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { zipSync, strToU8 } = require('fflate');
const esbuild = require('esbuild');

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const main = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
const knowledge = fs.readFileSync(path.join(__dirname, '../src/views/KnowledgeView.ts'), 'utf8');
const viewer = fs.readFileSync(path.join(__dirname, '../src/views/WordPreviewView.ts'), 'utf8');
const popover = fs.readFileSync(path.join(__dirname, '../src/ui/AiEditPopover.ts'), 'utf8');
assert.match(main, /registerExtensions\(\["docx"\], WORD_PREVIEW_VIEW_TYPE\)/);
assert.match(knowledge, /查看原文档/);
assert.match(viewer, /extends FileView/);
assert.match(viewer, /Platform\.isDesktopApp/);
assert.match(viewer, /useBase64URL: true/);
assert.match(main, /captureWordTextSelection\(wordViews, selection\)/);
assert.match(main, /new WordPreviewView\(leaf, \(file, selection\) =>/);
assert.match(viewer, /registerDomEvent\(this\.contentEl, "mouseup", deliverSelection\)/);
assert.match(viewer, /registerDomEvent\(this\.contentEl, "keyup", deliverSelection\)/);
assert.match(main, /const readOnlyDocument = snapshot\.file\.extension === "pdf" \|\| snapshot\.file\.extension === "docx"/);
assert.match(main, /snapshot && \(snapshot\.file\.extension === "pdf" \|\| snapshot\.file\.extension === "docx"\)/);
assert.match(popover, /target\.kind === "readonly-selection"/);
assert.match(popover, /PDF\/Word 原件为只读预览/);
assert.doesNotMatch(viewer, /vault\.(?:modify|create|delete|rename)\(/);

const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const drawing = '<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="Fixture image"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="Fixture image"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>';
const documentXml = `${xml}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Life OS Word heading</w:t></w:r></w:p><w:p><w:r><w:t>Read only paragraph</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r>${drawing}</w:r></w:p></w:body></w:document>`;
const docx = zipSync({
  '[Content_Types].xml': strToU8(`${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
  '_rels/.rels': strToU8(`${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
  'word/document.xml': strToU8(documentXml),
  'word/_rels/document.xml.rels': strToU8(`${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pixel.png"/></Relationships>`),
  'word/media/pixel.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Y7sAAAAASUVORK5CYII=', 'base64')
});
const base64 = Buffer.from(docx).toString('base64');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-word-smoke-'));
(async () => {
  try {
    const source = `import {renderAsync} from 'docx-preview';
      import {captureWordTextSelection} from './src/ui/word-selection.ts';
      const b=Uint8Array.from(atob('${base64}'),c=>c.charCodeAt(0));
      renderAsync(b.buffer,document.getElementById('body'),document.getElementById('styles'),{className:'lifeos-word-docx',useBase64URL:true,inWrapper:true,breakPages:true})
      .then(()=>{const el=document.getElementById('body');
        const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){if(node.textContent.includes('Read only paragraph'))break;}
        const range=document.createRange();range.setStart(node,0);range.setEnd(node,'Read only paragraph'.length);
        const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
        const file={path:'fixture.docx'};const owned=captureWordTextSelection([{file,containerEl:document.body}],selection);
        const foreign=captureWordTextSelection([{file:{path:'other.docx'},containerEl:document.getElementById('foreign')}],selection);
        selection.removeAllRanges();const collapsed=captureWordTextSelection([{file,containerEl:document.body}],selection);
        const outside=document.getElementById('toolbar').firstChild;range.setStart(outside,0);range.setEnd(outside,4);selection.addRange(range);
        const toolbar=captureWordTextSelection([{file,containerEl:document.body}],selection);
        document.body.dataset.result=JSON.stringify({heading:el.textContent.includes('Life OS Word heading'),paragraph:el.textContent.includes('Read only paragraph'),table:el.querySelectorAll('table').length,cell:el.textContent.includes('Table cell'),image:el.querySelectorAll('img').length,owned:owned?.file===file&&owned?.text==='Read only paragraph',ownedText:owned?.text??null,foreign:foreign===null,collapsed:collapsed===null,toolbar:toolbar===null});})
      .catch(e=>{document.body.dataset.error=String(e);});`;
    const build = await esbuild.build({ stdin: { contents: source, resolveDir: path.join(__dirname, '..'), loader: 'js' }, bundle: true, platform: 'browser', format: 'iife', write: false });
    const html = `<!doctype html><html><body><div id="toolbar">Open original</div><div id="foreign"></div><div id="styles"></div><div id="body" class="lifeos-word-preview-document-body"></div><script>${build.outputFiles[0].text.replaceAll('</script>', '<\\/script>')}</script></body></html>`;
    const file = path.join(tmp, 'preview.html');
    fs.writeFileSync(file, html);
    const dom = execFileSync(chrome, ['--headless=new', '--no-first-run', '--disable-background-networking', '--disable-extensions', '--disable-gpu', `--user-data-dir=${path.join(tmp, 'chrome')}`, '--virtual-time-budget=7000', '--dump-dom', new URL(`file:///${file.replaceAll('\\','/')}`).href], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
    const match = dom.match(/data-result="([^"]+)"/);
    assert.ok(match, `render did not finish: ${dom.match(/data-error="([^"]+)/)?.[1] || 'no marker'}`);
    const result = JSON.parse(match[1].replaceAll('&quot;', '"'));
    assert.deepEqual(result, { heading: true, paragraph: true, table: 1, cell: true, image: 1, owned: true, ownedText: 'Read only paragraph', foreign: true, collapsed: true, toolbar: true });
    console.log('PASS DOCX rendering plus owned-text selection, foreign-tab, collapsed and toolbar exclusions');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
