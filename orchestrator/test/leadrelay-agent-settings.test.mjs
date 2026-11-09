import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/integrations/leadrelay/agent-settings.js', import.meta.url), 'utf8');
const fixture = source
  .replace("import { mountVoiceSettings } from './voice-settings.js';", 'const mountVoiceSettings = (...args) => globalThis.__settingsChildren.voice(...args);')
  .replace("import { mountAgentTraining } from './agent-training.js';", 'const mountAgentTraining = (...args) => globalThis.__settingsChildren.training(...args);')
  .replace("import { mountWebsiteChatSettings } from './website-chat-settings.js';", 'const mountWebsiteChatSettings = (...args) => globalThis.__settingsChildren.websiteChat(...args);');
const { mountAgentSettings } = await import(`data:text/javascript;base64,${Buffer.from(fixture).toString('base64')}`);
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.isConnected = true; this.classList = { add() {} }; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
}
const all = root => [root, ...root.children.flatMap(all)];
const byText = (root, text) => all(root).find(node => node.textContent === text);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function harness(children = {}) {
  const old = { document: globalThis.document, MutationObserver: globalThis.MutationObserver, __settingsChildren: globalThis.__settingsChildren };
  const observers = [], calls = [], requests = [];
  globalThis.document = { createElement: tag => new Element(tag), documentElement: new Element('html') };
  globalThis.MutationObserver = class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } };
  globalThis.__settingsChildren = Object.fromEntries(['voice', 'training', 'websiteChat'].map(kind => [kind, async (root, api, options) => {
    const call = { kind, root, api, options, disposed: 0 }; calls.push(call);
    const controller = { dispose() { call.disposed++; } };
    return children[kind] ? children[kind](call, controller) : controller;
  }]));
  const root = new Element('root');
  const api = async (path, request) => { requests.push({ path, request }); return { ok: true }; };
  return { root, api, calls, requests, observers, restore() { Object.assign(globalThis, old); } };
}

test('agent settings is default denied and makes no API or child calls', async () => {
  const h = harness();
  try {
    const view = await mountAgentSettings(h.root, h.api);
    assert.equal(h.calls.length, 0); assert.equal(h.requests.length, 0);
    assert.ok(byText(h.root, 'Your role has no agent settings access for this business.'));
    view.dispose();
  } finally { h.restore(); }
});

test('voice read does not infer configuration, preview, apply or training permissions', async () => {
  const h = harness();
  try {
    const view = await mountAgentSettings(h.root, h.api, { voice: { canRead: true, canCatalog: true } });
    const options = h.calls[0].options;
    assert.equal(h.calls[0].kind, 'voice'); assert.equal(options.canRead, true); assert.equal(options.canCatalog, true);
    for (const key of ['canPreview', 'canSaveChoice', 'canApplyVoice', 'canConfigure', 'canPublish', 'canListVoices']) assert.equal(options[key], false, key);
    assert.equal(byText(h.root, 'Training & goals'), undefined);
    view.dispose(); assert.equal(h.calls[0].disposed, 1);
  } finally { h.restore(); }
});

test('training-only read stays read-only and explicit train maps all training controls', async () => {
  const h = harness();
  try {
    await mountAgentSettings(h.root, h.api, { training: { canRead: true } });
    for (const key of ['canTrain', 'canEdit', 'canReview']) assert.equal(h.calls[0].options[key], false);
    const view = await mountAgentSettings(h.root, h.api, { training: { canRead: true, canTrain: true } });
    assert.equal(h.calls[0].disposed, 1);
    for (const key of ['canTrain', 'canEdit', 'canReview']) assert.equal(h.calls[1].options[key], true);
    view.dispose();
  } finally { h.restore(); }
});

test('tab switch disposes the prior child and fences saved API and navigation callbacks', async () => {
  const h = harness(); let navigation = 0;
  try {
    const view = await mountAgentSettings(h.root, h.api, { voice: { canRead: true }, training: { canRead: true }, onOpenConnections: async ({ isCurrent }) => { if (isCurrent()) navigation++; } });
    const voice = h.calls[0];
    await voice.options.onOpenConnections(); assert.equal(navigation, 1);
    await byText(h.root, 'Training & goals').onclick();
    assert.equal(voice.disposed, 1); assert.equal(voice.options.isCurrent(), false); assert.equal(h.calls[1].options.isCurrent(), true);
    await voice.options.onOpenConnections(); assert.equal(navigation, 1);
    await assert.rejects(voice.api('/api/agent-builder/voice-settings'), /view changed/);
    assert.equal(h.requests.length, 0);
    view.dispose(); assert.equal(h.calls[1].disposed, 1);
  } finally { h.restore(); }
});

test('pending child mount is disposed when the user switches tabs before it finishes', async () => {
  const pending = deferred(); const h = harness({ voice: async (_call, controller) => { await pending.promise; return controller; } });
  try {
    const mounting = mountAgentSettings(h.root, h.api, { voice: { canRead: true }, training: { canRead: true } });
    await byText(h.root, 'Training & goals').onclick(); pending.resolve(); const view = await mounting;
    assert.equal(h.calls[0].disposed, 1); assert.equal(h.calls[1].disposed, 0); assert.equal(h.calls[1].options.isCurrent(), true);
    view.dispose(); assert.equal(h.calls[1].disposed, 1);
  } finally { h.restore(); }
});

test('child API combines guards and rejects a response after the current view changes', async () => {
  const pending = deferred(); const h = harness(); let hostCurrent = true, childCurrent = true, forwarded;
  try {
    const view = await mountAgentSettings(h.root, async (_path, request) => { forwarded = request.guard; return pending.promise; }, { voice: { canRead: true }, isCurrent: () => hostCurrent });
    const call = h.calls[0];
    await assert.rejects(call.api('/api/agent-builder/voice-settings', { guard: 'invalid' }), /guard is invalid/);
    childCurrent = false; await assert.rejects(call.api('/api/agent-builder/voice-settings', { guard: () => childCurrent }), /view changed/);
    childCurrent = true; const request = call.api('/api/agent-builder/voice-settings', { guard: () => childCurrent });
    assert.equal(forwarded(), true); hostCurrent = false; assert.equal(forwarded(), false); pending.resolve({ ok: true });
    await assert.rejects(request, /view changed/); view.dispose();
  } finally { h.restore(); }
});

test('detachment disposes children and pending parent navigation receives a fenced guard', async () => {
  const h = harness(); let forwarded;
  try {
    await mountAgentSettings(h.root, h.api, { voice: { canRead: true }, onOpenConnections: async context => { forwarded = context.isCurrent; } });
    await h.calls[0].options.onOpenConnections(); assert.equal(forwarded(), true);
    h.root.isConnected = false; h.observers[0].callback();
    assert.equal(forwarded(), false); assert.equal(h.calls[0].options.isCurrent(), false); assert.equal(h.calls[0].disposed, 1);
    assert.equal(h.observers[0].disconnected, true);
  } finally { h.restore(); }
});


test('Website chatbot uses only its explicit read capability and does not inherit deployment permission', async () => {
  const h = harness();
  try {
    const view = await mountAgentSettings(h.root, h.api, { websiteChat: { canRead: true, canDeploy: true } });
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].kind, 'websiteChat');
    assert.equal(h.calls[0].options.canRead, true); assert.equal(h.calls[0].options.canDeploy, undefined);
    assert.equal(byText(h.root, 'Voice'), undefined); assert.equal(byText(h.root, 'Training & goals'), undefined);
    assert.ok(byText(h.root, 'Website chatbot')); view.dispose(); assert.equal(h.calls[0].disposed, 1);
  } finally { h.restore(); }
});
