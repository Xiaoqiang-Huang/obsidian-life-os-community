const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { zipSync, strToU8 } = require('fflate');
const esbuild = require('esbuild');

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const text = 'Select this Word paragraph with a real mouse drag';
const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const docx = zipSync({
  '[Content_Types].xml': strToU8(`${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
  '_rels/.rels': strToU8(`${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
  'word/document.xml': strToU8(`${xml}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`)
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-word-drag-'));
let processHandle;
let socket;

async function waitFor(fn, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await Promise.resolve().then(fn).catch(() => null);
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

(async () => {
  try {
    const source = `import {renderAsync} from 'docx-preview';
      const bytes=Uint8Array.from(atob('${Buffer.from(docx).toString('base64')}'),c=>c.charCodeAt(0));
      renderAsync(bytes.buffer,document.querySelector('.lifeos-word-preview-document-body'),document.getElementById('styles'),{className:'lifeos-word-docx',inWrapper:true})
        .then(()=>document.body.dataset.ready='true').catch(error=>document.body.dataset.error=String(error));`;
    const bundle = await esbuild.build({ stdin: { contents: source, resolveDir: path.join(__dirname, '..'), loader: 'js' }, bundle: true, platform: 'browser', format: 'iife', write: false });
    const css = fs.readFileSync(path.join(__dirname, '../src/styles/pages.css'), 'utf8');
    const html = `<!doctype html><html><head><style>
      body { user-select:none; -webkit-user-select:none; }
      .workspace-leaf-content { width:1100px; }
      ${css}
    </style></head><body><div class="workspace-leaf-content" data-type="lifeos-word-preview"><div class="lifeos-word-preview"><div id="styles"></div><div class="lifeos-word-preview-document-body"></div></div></div><script>${bundle.outputFiles[0].text.replaceAll('</script>', '<\\/script>')}</script></body></html>`;
    const fixture = path.join(tmp, 'fixture.html');
    fs.writeFileSync(fixture, html);
    processHandle = spawn(chrome, ['--headless=new', '--no-first-run', '--disable-background-networking', '--disable-extensions', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${path.join(tmp, 'profile')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    const portFile = path.join(tmp, 'profile', 'DevToolsActivePort');
    const port = await waitFor(() => fs.existsSync(portFile) && Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]), 'Chrome CDP port');
    const targets = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      return (await response.json()).find(target => target.type === 'page');
    }, 'Chrome page target');
    socket = new WebSocket(targets.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let nextId = 0;
    const pending = new Map();
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const slot = pending.get(message.id);
      if (!slot) return;
      pending.delete(message.id);
      if (message.error) slot.reject(new Error(message.error.message));
      else slot.resolve(message.result);
    };
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Page.navigate', { url: new URL(`file:///${fixture.replaceAll('\\', '/')}`).href });
    await waitFor(() => evaluate('document.body?.dataset.ready === "true"'), 'rendered Word paragraph');
    const geometry = await evaluate(`(() => {
      const p=[...document.querySelectorAll('.lifeos-word-preview-document-body p')].find(p=>p.textContent.includes(${JSON.stringify(text)}));
      const node=[...p.childNodes].find(n=>n.nodeType===Node.TEXT_NODE) || p.querySelector('span').firstChild;
      const first=document.createRange(); first.setStart(node,0); first.setEnd(node,1);
      const last=document.createRange(); last.setStart(node,0); last.setEnd(node,${text.length});
      const a=first.getBoundingClientRect(),b=last.getBoundingClientRect();
      return {x1:a.left+1,x2:b.right-1,y:(a.top+a.bottom)/2,select:getComputedStyle(p).userSelect};
    })()`);
    assert.equal(geometry.select, 'text');
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geometry.x1, y: geometry.y });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: geometry.x1, y: geometry.y, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 8; step++) await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geometry.x1 + (geometry.x2 - geometry.x1) * step / 8, y: geometry.y, button: 'left', buttons: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geometry.x2, y: geometry.y, button: 'left', clickCount: 1 });
    const selected = await evaluate('window.getSelection().toString()');
    assert.ok(selected.startsWith('Select this Word paragraph'), `actual mouse drag selected ${JSON.stringify(selected)}`);
    console.log('PASS actual Chromium mouse drag selects DOCX paragraph under Obsidian-like user-select:none ancestor');
  } finally {
    socket?.close();
    if (processHandle?.pid) spawnSync('taskkill.exe', ['/PID', String(processHandle.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await sleep(500);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (error) { if (error.code !== 'EPERM') throw error; }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
