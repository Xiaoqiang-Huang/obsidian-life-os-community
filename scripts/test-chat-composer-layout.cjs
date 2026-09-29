const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-composer-layout-'));
const styles = pathToFileURL(path.resolve(process.argv[2] || path.join(__dirname, '../styles.css'))).href;
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${styles}"></head>
<body style="margin:0"><div class="lifeos-v3 lifeos-root lifeos-chat-root" style="width:1000px;height:700px;padding:16px">
<div class="lifeos-chat-main" style="height:100%;display:flex;flex-direction:column">
<div style="flex:1"></div><div class="lifeos-chat-runtime-status">上下文 0%</div>
<div class="lifeos-chat-composer-suggestions" id="suggestions"><div class="lifeos-chat-suggestion-heading">命令</div>
<button class="lifeos-chat-suggestion-item"><strong>/compact</strong><span>压缩早期对话，保留摘要</span></button>
<button class="lifeos-chat-suggestion-item"><strong>资料整理和知识库问答 Skill</strong><span>按来源整理文档并保留可核对的路径与引用</span></button>
<div class="lifeos-chat-suggestion-footer">输入内容搜索文档或 Skill</div></div>
<div class="lifeos-chat-composer" id="composer"><textarea class="lifeos-input" id="input">/</textarea>
<div class="lifeos-chat-composer-bottom" id="bottom"><div class="lifeos-chat-composer-bottom-left"><button class="lifeos-chat-send-attach"><span class="lifeos-v2-button-label">添加文件</span>＋</button>
<div class="lifeos-chat-composer-toolbar"><details class="lifeos-chat-options" open><summary>会话选项</summary><div class="lifeos-chat-options-body" id="options"><div class="lifeos-chat-compact-toolbar"><label class="lifeos-chat-compact-control"><span class="lifeos-chat-compact-label">模式</span><select class="lifeos-chat-compact-select"><option>项目问答</option></select></label><label class="lifeos-chat-compact-control"><span class="lifeos-chat-compact-label">推理强度</span><select class="lifeos-chat-compact-select"><option>自动</option></select></label><details class="lifeos-chat-compact-control lifeos-chat-skill-dropdown"><summary class="lifeos-chat-skill-dropdown-summary"><span class="lifeos-chat-compact-label">Skill</span><span class="lifeos-chat-skill-dropdown-value" id="skill">资料整理和知识库问答 Skill</span></summary></details></div></div></details></div></div>
<div class="lifeos-chat-composer-bottom-right"><div class="lifeos-chat-quick-controls"><label class="lifeos-chat-compact-control"><span class="lifeos-chat-compact-label">模型</span><select class="lifeos-chat-compact-select"><option>模型 A</option></select></label>
<label class="lifeos-chat-compact-control"><span class="lifeos-chat-compact-label">联网</span><select class="lifeos-chat-compact-select"><option>自动</option></select></label></div>
<div class="lifeos-chat-send-actions"><button class="lifeos-chat-send"><span class="lifeos-v2-button-label">发送问题</span>↑</button></div></div></div></div></div></div>
<pre id="metrics"></pre><script>addEventListener('load',()=>{
const r=s=>document.querySelector(s).getBoundingClientRect(), c=s=>getComputedStyle(document.querySelector(s));
const a=r('#suggestions'),b=r('#composer'),t=r('#input'),bar=r('#bottom'),item=r('.lifeos-chat-suggestion-item'),name=r('.lifeos-chat-suggestion-item strong'),options=r('#options'),skill=r('#skill');
document.querySelector('#metrics').textContent=JSON.stringify({above:a.bottom<=b.top,composer:c('#composer').display,radius:parseFloat(c('#composer').borderTopLeftRadius),
textBorder:c('#input').borderTopWidth,textBackground:c('#input').backgroundColor,barBelow:bar.top>=t.bottom,
leftInside:r('.lifeos-chat-composer-bottom-left').left>=b.left,rightInside:r('.lifeos-chat-composer-bottom-right').right<=b.right,
suggestionHeight:a.height,itemWidth:item.width,itemOffset:item.left-a.left,nameOffset:name.left-item.left,
optionsWidth:options.width,optionsHeight:options.height,optionsRight:options.right,composerRight:b.right,skillWidth:skill.width,
skillTextWidth:document.querySelector('#skill').scrollWidth,
skillHeight:skill.height,skillTextHeight:document.querySelector('#skill').scrollHeight,
textColor:c('#input').color,surface:c('#composer').backgroundColor});
});</script></body></html>`;
const file = path.join(temp, 'fixture.html');
try {
  const variants = [
    { name: 'wide-light', markup: html },
    { name: 'narrow-dark', markup: html.replace('<body style=', '<body class="theme-dark" style=').replace('width:1000px;height:700px', 'width:390px;height:700px') }
  ];
  for (const variant of variants) {
    fs.writeFileSync(file, variant.markup);
    const result = spawnSync(chrome, ['--headless=new', '--no-first-run', '--disable-background-networking', '--disable-extensions', '--disable-gpu',
      `--user-data-dir=${path.join(temp, `profile-${variant.name}`)}`, '--window-size=1100,800', '--dump-dom', pathToFileURL(file).href],
      { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const match = result.stdout.match(/<pre id="metrics">([^<]+)<\/pre>/);
    assert.ok(match, result.stdout.slice(-500));
    const m = JSON.parse(match[1].replaceAll('&quot;', '"'));
    assert.equal(m.above, true, variant.name);
    assert.equal(m.composer, 'flex', variant.name);
    assert.ok(m.radius >= 14, variant.name);
    assert.equal(m.textBorder, '0px', variant.name);
    assert.equal(m.textBackground, 'rgba(0, 0, 0, 0)', variant.name);
    assert.equal(m.barBelow, true, variant.name);
    assert.equal(m.leftInside, true, variant.name);
    assert.equal(m.rightInside, true, variant.name);
    assert.ok(m.suggestionHeight >= 80 && m.suggestionHeight <= 220, variant.name);
    assert.ok(m.itemWidth >= m.suggestionHeight * 2 && m.itemOffset < 15, `${variant.name} suggestion row not full-width/left-aligned: ${JSON.stringify(m)}`);
    assert.ok(m.nameOffset < 16, `${variant.name} suggestion name is centered: ${JSON.stringify(m)}`);
    assert.ok(m.optionsWidth >= (variant.name === 'wide-light' ? 480 : 300) && m.optionsHeight <= 270 && m.optionsRight <= m.composerRight + 1,
      `${variant.name} options panel is narrow, tall or overflows pane: ${JSON.stringify(m)}`);
    assert.ok(m.skillWidth >= 120 && m.skillTextWidth <= m.skillWidth + 1 && m.skillTextHeight <= m.skillHeight + 1,
      `${variant.name} Skill is clipped: ${JSON.stringify(m)}`);
    assert.notEqual(m.textColor, 'rgba(0, 0, 0, 0)', variant.name);
    console.log(`PASS ${variant.name}: one rounded composer, bottom actions and suggestion panel above input`);
  }
} finally {
  try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch (error) { if (error.code !== 'EPERM') throw error; }
}
