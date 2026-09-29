const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const compiled = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/services/chat/ChatContinuity.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false
}).outputFiles[0].text;
const moduleShim = { exports: {} };
new Function('module', 'exports', compiled)(moduleShim, moduleShim.exports);
const { ChatContinuity } = moduleShim.exports;
const hub = new ChatContinuity({ messages: [], draftInput: '', updatedAt: 0 });
const oldView = {}, newView = {};
const observed = [];
const unsubscribe = hub.subscribe((state, run, source) => {
  if (source !== newView) observed.push({ content: state.messages.at(-1)?.content, running: !!run, draft: state.draftInput });
});
const controller = new AbortController();
assert.equal(hub.beginRun('desktop-a', controller, oldView), true);
assert.equal(hub.beginRun('desktop-b', new AbortController(), newView), false, 'one desktop run at a time');
hub.publish({ messages: [{ role: 'ai', content: 'partial answer' }], draftInput: '', updatedAt: 1 }, oldView);
assert.deepEqual(observed.at(-1), { content: 'partial answer', running: true, draft: '' });
hub.publish({ messages: hub.state.messages, draftInput: 'draft typed after returning', updatedAt: 2 }, newView);
hub.publish({ messages: [{ role: 'ai', content: 'finished answer' }], draftInput: hub.state.draftInput, updatedAt: 3 }, oldView);
hub.endRun(new AbortController(), oldView);
assert.equal(hub.activeRun?.controller, controller, 'unrelated run cannot clear active owner');
hub.endRun(controller, oldView);
assert.deepEqual(observed.at(-1), { content: 'finished answer', running: false, draft: 'draft typed after returning' });
assert.equal(observed.length, 4);
unsubscribe();
hub.publish({ messages: [], draftInput: '', updatedAt: 4 }, oldView);
assert.equal(observed.length, 4, 'closed view no longer receives progress');

const chat = fs.readFileSync(path.join(__dirname, '../src/views/ChatView.ts'), 'utf8');
assert.match(chat, /chatContinuity\.subscribe/);
assert.match(chat, /this\.isViewOpen \? this\.inputEl\?\.value/);
assert.match(chat, /remoteRun \? this\.plugin\.activeChatState\.messages/);
assert.match(chat, /this\.plugin\.chatContinuity\.beginRun/);
assert.match(chat, /this\.plugin\.chatContinuity\.endRun/);
console.log('PASS cross-view answer updates, one active run, cancellation ownership, returned draft and listener cleanup');
