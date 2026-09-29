const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const ts = require('typescript');
const YAML = require('yaml');

function load(relative) {
  const code = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', relative)], bundle: true,
    platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  const shim = { exports: {} };
  new Function('module', 'exports', code)(shim, shim.exports);
  return shim.exports;
}

const { composerFileLabel, composerSkillLabel, findComposerFiles, findComposerSkills, promptWithoutFileLabel, promptWithoutSelectedSkill, readComposerTrigger, replaceComposerTrigger } = load('src/ui/chat-composer-mentions.ts');
assert.deepEqual(readComposerTrigger('请看 @六级', 6), { kind: 'file', query: '六级', start: 3, end: 6 });
assert.deepEqual(readComposerTrigger('用 /周报', 5), { kind: 'skill', query: '周报', start: 2, end: 5 });
assert.equal(readComposerTrigger('路径/不是命令', 7), null);
assert.deepEqual(readComposerTrigger('请看 @资料/六级 词汇.pdf', '请看 @资料/六级 词汇.pdf'.length),
  { kind: 'file', query: '资料/六级 词汇.pdf', start: 3, end: '请看 @资料/六级 词汇.pdf'.length });
const trigger = readComposerTrigger('请看 @六级 后续', 6);
assert.equal(replaceComposerTrigger('请看 @六级 后续', trigger, '@六级词汇大纲词').value, '请看 @六级词汇大纲词 后续');
assert.equal(composerSkillLabel('/小p判断推理'), '/小p判断推理 ');
assert.equal(composerSkillLabel('资料整理 Skill'), '/资料整理 Skill ');
assert.equal(composerFileLabel('六级词汇大纲词.pdf'), '@「六级词汇大纲词.pdf」 ');
assert.equal(promptWithoutSelectedSkill('/小p判断推理 请解释这段', '/小p判断推理'), '请解释这段');
assert.equal(promptWithoutSelectedSkill('/小p判断推理', '/小p判断推理'), '');
assert.equal(promptWithoutSelectedSkill('/小p判断推理补充 请解释', '/小p判断推理'), '/小p判断推理补充 请解释');
assert.equal(promptWithoutSelectedSkill('请用 /小p判断推理 分析', '/小p判断推理'), '请用 分析');
assert.equal(promptWithoutFileLabel('请分析 @「六级词汇大纲词.pdf」 内容', '六级词汇大纲词.pdf'), '请分析 内容');
assert.equal(readComposerTrigger('请看 @「六级词汇大纲词.pdf」 接着提问', '请看 @「六级词汇大纲词.pdf」 接着提问'.length), null);
assert.deepEqual(readComposerTrigger('请看 @「六级词汇大纲词.pdf」 接着问 @新文件', '请看 @「六级词汇大纲词.pdf」 接着问 @新文件'.length),
  { kind: 'file', query: '新文件', start: '请看 @「六级词汇大纲词.pdf」 接着问 '.length, end: '请看 @「六级词汇大纲词.pdf」 接着问 @新文件'.length });
assert.equal(replaceComposerTrigger('问 /小p旧词后续', { kind: 'skill', query: '小p旧词', start: 2, end: 7 }, '/小p判断推理 ').value, '问 /小p判断推理 后续');
const manyFiles = Array.from({ length: 55 }, (_, i) => ({ basename: `笔记-${i}`, path: `资料/笔记-${i}.md`, extension: 'md', stat: { mtime: i } }));
manyFiles.push({ basename: '六级 词汇', path: '资料/六级 词汇.pdf', extension: 'pdf', stat: { mtime: 0 } });
manyFiles.push({ basename: '课本封面', path: '图片/课本封面.png', extension: 'png', stat: { mtime: 0 } });
manyFiles.push({ basename: 'OCR缓存', path: '资料/DocumentRecognition/OCR缓存.md', extension: 'md', stat: { mtime: 0 } });
assert.equal(findComposerFiles(manyFiles, '').length, 57);
assert.equal(findComposerFiles(manyFiles, '六级 词汇')[0]?.path, '资料/六级 词汇.pdf');
assert.equal(findComposerFiles(manyFiles, '资料 六级')[0]?.path, '资料/六级 词汇.pdf');
assert.equal(findComposerFiles(manyFiles, '资料/六级')[0]?.basename, '六级 词汇');
assert.equal(findComposerFiles(manyFiles, '课本封面')[0]?.extension, 'png');
assert.equal(findComposerSkills(Array.from({ length: 35 }, (_, i) => ({ id: `skill-${i}`, name: `Skill ${i}`, description: '演示' })), '').length, 35);
const builtInSkills = load('src/services/AiSkillService.ts').getAvailableAiSkills();
assert.ok(builtInSkills.length > 20);
assert.equal(findComposerSkills(builtInSkills, '').length, builtInSkills.length);
console.log(`PASS / Skill catalog: all ${builtInSkills.length} visible skills remain searchable`);

const { buildKeywordLinkedMarkdown } = load('src/services/KeywordLinkService.ts');
const generated = buildKeywordLinkedMarkdown('# 样本\n\n正文', { title: '"MBA大师"创始人薛睿' });
const yaml = generated.match(/^---\n([\s\S]*?)\n---/)[1];
assert.doesNotThrow(() => YAML.parse(yaml));
assert.match(yaml, /\\?"MBA大师/);

const { readManagedKnowledgeFrontmatter } = load('src/utils/managed-knowledge-frontmatter.ts');
const invalid = '---\nkeywords:\n  - "MBA大师"创始人薛睿\n---\n正文';
const result = readManagedKnowledgeFrontmatter(invalid, YAML.parse);
assert.match(result.warning, /属性区格式错误/);
assert.equal(result.frontmatter, undefined);
assert.equal(result.issue.fileLine, 3);
assert.equal(result.issue.sourceLine, '  - "MBA大师"创始人薛睿');
assert.equal(result.issue.suggestedLine, '  - \'"MBA大师"创始人薛睿\'');
assert.doesNotThrow(() => YAML.parse(invalid.split('\n').slice(1, -2).map((line, index) => index === 1 ? result.issue.suggestedLine : line).join('\n')));
assert.equal(readManagedKnowledgeFrontmatter('---\ntitle: 有效\n---\n正文', YAML.parse).frontmatter.title, '有效');

const chat = fs.readFileSync(path.join(__dirname, '../src/views/ChatView.ts'), 'utf8');
const selectionMethods = ['applyComposerSuggestion', 'composerTriggerStillCurrent', 'selectComposerFile', 'selectComposerSkill'];
const selectionSource = selectionMethods.map((name, index) => {
  const start = chat.indexOf(`  private ${index === 2 ? 'async ' : ''}${name}(`);
  const next = chat.indexOf('\n  private ', start + 10);
  assert.ok(start >= 0 && next > start, `missing selection method ${name}`);
  return chat.slice(start, next);
}).join('\n');
const selectionCompiled = ts.transpileModule(`class SelectionHarness {\n${selectionSource}\n}\nmodule.exports = SelectionHarness;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const selectionModule = { exports: {} };
let resolveImport;
let importPromise = new Promise((resolve) => { resolveImport = resolve; });
const notices = [];
new Function('module', 'replaceComposerTrigger', 'readComposerTrigger', 'composerFileLabel', 'composerSkillLabel',
  'promptWithoutSelectedSkill', 'getAiSkills', 'requireProFeature', 'readImportedFile', 'Notice', selectionCompiled)(selectionModule, replaceComposerTrigger,
    readComposerTrigger, composerFileLabel, composerSkillLabel, promptWithoutSelectedSkill, () => [], () => true, () => importPromise,
    class { constructor(message) { notices.push(message); } });
const SelectionHarness = selectionModule.exports;
function selectionView(value) {
  const view = new SelectionHarness();
  view.inputEl = { value, selectionStart: value.length, isConnected: true, focus() {}, setSelectionRange(start) { this.selectionStart = start; }, setAttribute() {} };
  view.composerSuggestionEl = { hide() {} };
  view.plugin = { settings: { maxChatAttachmentCount: 5, maxChatAttachmentBytes: 1024 * 1024 } };
  view.app = { vault: {} };
  view.importedDocuments = [];
  view.selectedSkillIds = [];
  view.composerFileImportsPending = 0;
  view.resizeComposer = () => {};
  view.persistActiveChatState = () => {};
  view.persistSelectedSkills = () => {};
  view.syncSkillSelectionUi = () => {};
  view.renderAttachmentList = () => {};
  view.canUseVisionModel = () => false;
  return view;
}
const skillView = selectionView('/小p');
skillView.selectComposerSkill({ id: 'reasoning', name: '/小p判断推理' }, readComposerTrigger('/小p', 3));
assert.equal(skillView.inputEl.value, '/小p判断推理 ');
assert.deepEqual(skillView.selectedSkillIds, ['reasoning']);
const fileView = selectionView('请看 @六级');
const file = { name: '六级词汇大纲词.txt', basename: '六级词汇大纲词', path: '资料/六级词汇大纲词.txt', extension: 'txt', stat: { size: 100 } };
const pendingImport = fileView.selectComposerFile(file, readComposerTrigger(fileView.inputEl.value, fileView.inputEl.selectionStart));
assert.equal(fileView.inputEl.value, '请看 @「六级词汇大纲词.txt」 ');
assert.equal(fileView.composerFileImportsPending, 1);
resolveImport({ id: 'imported-1', name: file.name, text: '正文', warnings: [] });
pendingImport.then(async () => {
  assert.equal(fileView.composerFileImportsPending, 0);
  assert.equal(fileView.importedDocuments[0].vaultPath, file.path);
  assert.equal(fileView.inputEl.value, '请看 @「六级词汇大纲词.txt」 ');
  assert.deepEqual(notices, []);
  let rejectImport;
  importPromise = new Promise((_, reject) => { rejectImport = reject; });
  const failedView = selectionView('@六级');
  const failed = failedView.selectComposerFile(file, readComposerTrigger('@六级', 3));
  assert.equal(failedView.inputEl.value, '@「六级词汇大纲词.txt」 ');
  rejectImport(new Error('sample read failure'));
  await failed;
  assert.equal(failedView.inputEl.value, '@六级');
  assert.equal(failedView.importedDocuments.length, 0);
  assert.equal(failedView.composerFileImportsPending, 0);
  assert.ok(notices.some((message) => message.includes('标记已撤回')));
  console.log('PASS selected Skill and @ file remain visible in composer; file binding follows async read');
}).catch((error) => { process.nextTick(() => { throw error; }); });
const renderStart = chat.indexOf('  private renderComposerSuggestions(): void {');
const renderEnd = chat.indexOf('\n  private applyComposerSuggestion(', renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart);
const compiledRender = ts.transpileModule(`class ComposerHarness {\n${chat.slice(renderStart, renderEnd)}\n}\nmodule.exports = ComposerHarness;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const renderModule = { exports: {} };
new Function('module', 'readComposerTrigger', 'findComposerFiles', 'findComposerSkills', 'getAvailableAiSkills',
  'CHAT_SLASH_SUGGESTIONS', compiledRender)(renderModule, readComposerTrigger, findComposerFiles, findComposerSkills,
    () => [{ id: 'defense', name: '防疫复盘 Skill', description: '防疫资料整理' }],
    [{ command: '/compact', description: '压缩早期对话' }]);
function suggestionHost() {
  return { nodes: [], hidden: false, scrollTop: 0, empty() { this.nodes = []; }, hide() { this.hidden = true; },
    show() { this.hidden = false; }, createDiv(options) { const node = { tag: 'div', ...options }; this.nodes.push(node); return node; },
    createEl(tag, options) { const node = { tag, ...options, children: [], setAttribute(name, value) { this[name] = value; },
      createEl(childTag, childOptions) { const child = { tag: childTag, ...childOptions }; this.children.push(child); return child; },
      createSpan(childOptions) { const child = { tag: 'span', ...childOptions }; this.children.push(child); return child; } };
      this.nodes.push(node); return node; }, querySelector() { return this.nodes.find((node) => node.tag === 'button'); } };
}
const ComposerHarness = renderModule.exports;
const imeView = new ComposerHarness();
imeView.composerSuggestionEl = suggestionHost();
imeView.inputEl = { value: '/防', selectionStart: 2, setAttribute() {} };
imeView.plugin = { settings: {} }; imeView.importedAiSkills = [];
imeView.composerCompositionActive = true; imeView.composerSuggestionKey = ''; imeView.composerSuggestionLimit = 20;
imeView.renderComposerSuggestions();
assert.deepEqual(imeView.composerSuggestionEl.nodes.filter((node) => node.tag === 'button').map((node) => node.children[0]?.text), ['防疫复盘 Skill']);
imeView.inputEl.value = '@六级'; imeView.inputEl.selectionStart = 3;
imeView.app = { vault: { getFiles: () => [{ basename: '六级词汇大纲词', path: '知识库/六级词汇大纲词.pdf', extension: 'pdf', stat: { mtime: 1 } }] } };
imeView.renderComposerSuggestions();
assert.deepEqual(imeView.composerSuggestionEl.nodes.filter((node) => node.tag === 'button').map((node) => node.children[0]?.text), ['六级词汇大纲词']);
assert.match(chat, /compositionend[\s\S]{0,400}queueMicrotask\([\s\S]{0,120}renderComposerSuggestions/);
console.log('PASS live IME pre-edit refresh: /防 and @六级 replace stale suggestions before composition ends');
assert.match(chat, /selectComposerFile\(file: TFile/);
assert.match(chat, /this\.applyComposerSuggestion\(trigger, composerFileLabel\(file\.name\)\)/);
assert.match(chat, /this\.applyComposerSuggestion\(trigger, composerSkillLabel\(skill\.name\)\)/);
assert.match(chat, /this\.composerFileImportsPending > 0/);
assert.match(chat, /promptWithoutSelectedSkill\(this\.inputEl\.value, selectedSkill\?\.name\)/);
assert.match(chat, /imported\.vaultPath = file\.path/);
assert.match(chat, /selectComposerSkill\(skill: AiSkill/);
assert.match(chat, /getAvailableAiSkills\(this\.importedAiSkills/);
assert.match(chat, /this\.composerSuggestionLimit \+= 20/);
for (const command of ['/compact', '/usage', '/sources', '/memory', '/remember', '/whiteboard', '/whiteboard-adjust', '/clear']) {
  assert.match(chat, new RegExp(`command: "${command.replaceAll('/', '\\/')}"`));
}
assert.match(chat, /data-suggestion": "command"/);
assert.match(chat, /renderQuickComposerControls/);
const pages = fs.readFileSync(path.join(__dirname, '../src/styles/pages.css'), 'utf8');
assert.match(pages, /lifeos-knowledge-capture-field\s*\{\s*align-self: start/);
const knowledgeView = fs.readFileSync(path.join(__dirname, '../src/views/KnowledgeView.ts'), 'utf8');
for (const field of ['document.file.path', 'document.metadataIssue.fileLine', 'document.metadataIssue.sourceLine', 'document.metadataIssue.suggestedLine']) {
  assert.ok(knowledgeView.includes(field), `missing visible YAML warning field: ${field}`);
}
const acceptanceVault = process.env.LIFEOS_ACCEPTANCE_VAULT;
if (acceptanceVault) {
  const affected = path.join(acceptanceVault, 'PersonalLifeSystem/项目/project-mq4yej4f-8oji6o/Documents/薛睿-判断.md.md');
  if (fs.existsSync(affected)) {
    const raw = fs.readFileSync(affected, 'utf8');
    const actual = readManagedKnowledgeFrontmatter(raw, YAML.parse);
    assert.equal(actual.issue.fileLine, 20);
    assert.equal(actual.issue.suggestedLine, '  - \'"MBA大师"创始人薛睿\'');
    console.log('PASS real vault YAML diagnostic: project copy, file line 20, validated repair; original unchanged');
  }
  const vaultFiles = [];
  const folders = [acceptanceVault];
  while (folders.length) {
    const folder = folders.pop();
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === '.obsidian') continue;
      const absolute = path.join(folder, entry.name);
      if (entry.isDirectory()) { folders.push(absolute); continue; }
      if (!entry.isFile()) continue;
      const relative = path.relative(acceptanceVault, absolute).replaceAll('\\', '/');
      vaultFiles.push({ basename: path.basename(entry.name, path.extname(entry.name)), path: relative,
        extension: path.extname(entry.name).slice(1), stat: { mtime: fs.statSync(absolute).mtimeMs } });
    }
  }
  const found = findComposerFiles(vaultFiles, '六级词汇');
  assert.ok(found.some((file) => file.path.endsWith('/六级词汇大纲词.pdf')),
    'previously imported PDF must be found by @ search');
  assert.ok(findComposerFiles(vaultFiles, '六级 大纲').some((file) => file.path.endsWith('/六级词汇大纲词.pdf')),
    'multiple @ search words must match across the same file path');
  console.log(`PASS real vault @ search: ${vaultFiles.length} indexed files; 六级词汇 matches=${found.length}`);
}
console.log('PASS composer @/ trigger, vault-file binding, Skill selection, YAML recovery and compact controls');
