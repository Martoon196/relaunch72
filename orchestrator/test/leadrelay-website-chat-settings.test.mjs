import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/integrations/leadrelay/website-chat-settings.js', import.meta.url), 'utf8');
const { mountWebsiteChatSettings } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.isConnected = true; this.disabled = false; this.classList = { add() {} }; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text || this.children.map(node => node.textContent).join(' '); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this.text = ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
}
const all = node => [node, ...node.children.flatMap(all)];
const byText = (root, value) => all(root).find(node => node.textContent === value);
const byTag = (root, value) => all(root).find(node => node.tag === value);
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const config = { workspace_id: 'business-a', script_url: 'https://leadrelay.example/widget.js', runtime_enabled: false, worker_enabled: true, business_enabled: false, chat_enabled: false, origins: [], deployed_version_id: null, paused: true, available: false };
async function harness({ metadata = config, options = {}, read, clipboard } = {}) {
  const saved = { document: globalThis.document, MutationObserver: globalThis.MutationObserver, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  globalThis.document = { createElement: tag => new Element(tag), documentElement: new Element('html') };
  const observers = [];
  globalThis.MutationObserver = class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard } });
  const root = new Element('root'), requests = [];
  const api = async (path, request) => { requests.push({ path, ...request }); return read ? read(path, request) : { website_chat: structuredClone(metadata) }; };
  const controller = await mountWebsiteChatSettings(root, api, { canRead: true, ...options });
  const restore = () => {
    globalThis.document = saved.document; globalThis.MutationObserver = saved.MutationObserver;
    saved.navigator ? Object.defineProperty(globalThis, 'navigator', saved.navigator) : delete globalThis.navigator;
  };
  return { root, requests, controller, api, observers, restore };
}

test('website installer denies access by default without a read or embed', async () => {
  const h = await harness({ options: { canRead: undefined } });
  try { assert.equal(h.requests.length, 0); assert.match(h.root.textContent, /no website chat access/); assert.equal(byTag(h.root, 'textarea'), undefined); }
  finally { h.restore(); }
});
test('installation uses the server canonical script and exact business id while global chat remains off', async () => {
  const h = await harness();
  try {
    assert.equal(byTag(h.root, 'textarea').value, '<script src="https://leadrelay.example/widget.js" data-workspace="business-a" defer></script>');
    assert.match(h.root.textContent, /Website AI chat is off/); assert.match(h.root.textContent, /not active/);
    assert.match(h.root.textContent, /must be enabled securely/); assert.match(h.root.textContent, /paused/);
    assert.deepEqual(h.requests.map(row => row.path), ['/api/agent-builder']);
    assert.ok(h.requests.every(row => !row.method || row.method === 'GET')); assert.equal(h.requests[0].guard(), true);
  } finally { h.restore(); }
});
test('ready requires every server control and a deployed published version, not just available', async () => {
  const enabled = { ...config, runtime_enabled: true, business_enabled: true, chat_enabled: true, origins: ['https://business.example'], deployed_version_id: 'version-a', paused: false, available: true };
  const h = await harness({ metadata: enabled });
  try { assert.match(h.root.textContent, /Ready on reviewed websites/); assert.match(h.root.textContent, /website still needs the install code/); }
  finally { h.restore(); }
  const held = await harness({ metadata: { ...enabled, worker_enabled: false } });
  try { assert.match(held.root.textContent, /currently unavailable/); assert.match(held.root.textContent, /background worker is unavailable/); assert.doesNotMatch(held.root.textContent, /Ready on reviewed websites/); }
  finally { held.restore(); }
});
test('copy is explicit and single flight; it writes only public embed code and makes no API mutation', async () => {
  const wait = deferred(), copied = [];
  const h = await harness({ clipboard: { writeText: value => { copied.push(value); return wait.promise; } } });
  try {
    assert.equal(copied.length, 0);
    const copy = byText(h.root, 'Copy install code'); const pending = copy.onclick(); await copy.onclick();
    assert.equal(copy.disabled, true); assert.equal(copied.length, 1);
    assert.equal(copied[0], byTag(h.root, 'textarea').value);
    wait.resolve(); await pending; assert.equal(copy.disabled, false);
    assert.match(h.root.textContent, /Install code copied.*unchanged/); assert.equal(h.requests.length, 1);
  } finally { h.restore(); }
});
test('copy failure selects a read-only manual fallback and never claims successful copy', async () => {
  const h = await harness();
  try {
    await byText(h.root, 'Copy install code').onclick(); const code = byTag(h.root, 'textarea');
    assert.equal(code.readOnly, true); assert.equal(code.selected, true); assert.equal(code.focused, true);
    assert.match(h.root.textContent, /copy it manually/); assert.doesNotMatch(h.root.textContent, /Install code copied/);
  } finally { h.restore(); }
});
test('changed business fences delayed reads and does not show another business embed', async () => {
  const wait = deferred(); let current = true;
  const pending = harness({ read: () => wait.promise, options: { isCurrent: () => current } });
  current = false; wait.resolve({ website_chat: config }); const h = await pending;
  try { assert.equal(byTag(h.root, 'textarea'), undefined); assert.equal(h.requests[0].guard(), false); }
  finally { h.restore(); }
});
test('detached copy and native navigation do nothing; stale clipboard completion cannot change feedback', async () => {
  const wait = deferred(); let opened = 0;
  const h = await harness({ clipboard: { writeText: () => wait.promise }, options: { onReturnBuilder: async () => { opened++; } } });
  try {
    const copy = byText(h.root, 'Copy install code'), open = byText(h.root, 'Review agent and website deployment →');
    const pending = copy.onclick(); const before = h.root.textContent; h.controller.dispose();
    await open.onclick(); wait.resolve(); await pending; await copy.onclick();
    assert.equal(opened, 0); assert.equal(h.root.textContent, before); assert.equal(h.requests[0].guard(), false);
  } finally { h.restore(); }
});
test('native return callback is guarded and failure preserves the install code without navigation', async () => {
  let seen;
  const h = await harness({ options: { onReturnBuilder: async context => { seen = context; throw Error('Could not open agent review.'); } } });
  try {
    const before = byTag(h.root, 'textarea').value; const open = byText(h.root, 'Review agent and website deployment →');
    assert.equal(open.tag, 'button'); await open.onclick(); assert.equal(seen.isCurrent(), true);
    assert.equal(byTag(h.root, 'textarea').value, before); assert.match(h.root.textContent, /Could not open agent review/);
    assert.equal(open.disabled, false);
  } finally { h.restore(); }
});
test('unsafe install metadata cannot become copyable HTML', async () => {
  for (const invalid of [{ script_url: 'javascript:alert(1)' }, { script_url: 'https://user:pass@leadrelay.example/widget.js' }, { script_url: 'https://leadrelay.example/widget.js?secret=x' }, { workspace_id: 'a" onload="bad' }]) {
    const h = await harness({ metadata: { ...config, ...invalid } });
    try { assert.equal(byTag(h.root, 'textarea'), undefined); assert.match(h.root.textContent, /safe install details/); }
    finally { h.restore(); }
  }
});
test('reviewed origins are rendered only as text, with no external site or provider requests', async () => {
  const h = await harness({ metadata: { ...config, origins: ['<img src=x onerror=alert(1)>'] } });
  try {
    assert.match(h.root.textContent, /<img src=x/); assert.equal(byTag(h.root, 'img'), undefined);
    assert.equal(all(h.root).filter(node => node.tag === 'a').length, 1);
    assert.equal(h.requests.length, 1);
  } finally { h.restore(); }
});
