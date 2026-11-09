import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/integrations/leadrelay/voice-settings.js', import.meta.url), 'utf8');
const { mountVoiceSettings } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.value = ''; this.disabled = false; this.isConnected = true;
    this.attributes = {}; this.classes = new Set(); this.classList = { add: item => this.classes.add(item) };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text || this.children.map(child => child.textContent).join(' '); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this.text = ''; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; if (key === 'src') this.src = ''; }
  play() { this.played = true; return Promise.resolve(); }
  pause() { this.paused = true; }
}
const all = node => [node, ...node.children.flatMap(all)];
const byText = (root, text) => all(root).find(node => node.textContent === text);
const field = (root, name) => all(root).find(node => node.name === name);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const state = { provider: 'retell', verified: true, saved_voice: { voice_id: 'old_voice', voice_name: 'Old voice' },
  published: { version_id: 'version-one', voice_id: 'old_voice', status: 'published' }, can_apply: true, blocker: null, outreach_started: false };
const catalog = { provider: 'retell', voices: [{ voice_id: 'eve_voice', voice_name: 'Eve', provider: 'cartesia', gender: 'female', accent: 'British', supported: true }],
  facets: { providers: ['cartesia', 'elevenlabs'], genders: ['female', 'male'], accents: ['British', 'American'] }, total: 1, offset: 0, next_offset: null, truncated: false, outreach_started: false };

async function harness({ options = {}, initial = state, onWrite, onRead, onStart } = {}) {
  const original = { document: globalThis.document, MutationObserver: globalThis.MutationObserver, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  const created = [], revoked = [];
  URL.createObjectURL = blob => { created.push(blob); return `blob:synthetic-${created.length}`; };
  URL.revokeObjectURL = url => revoked.push(url);
  globalThis.document = { createElement: tag => new Element(tag), documentElement: new Element('html') };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  let timerId = 0; const timers = new Map();
  globalThis.setTimeout = callback => { timers.set(++timerId, callback); return timerId; };
  globalThis.clearTimeout = id => timers.delete(id);
  let saved = structuredClone(initial), config = { voice_id: 'old_voice', from_number: '+447700900111' };
  const requests = [], root = new Element('root');
  const api = async (path, request = {}) => {
    if (request.guard && !request.guard()) throw Error('View changed');
    requests.push({ path, ...request });
    if (!request.method || request.method === 'GET') {
      if (onRead) return onRead(path, request, () => structuredClone(saved));
      if (path.endsWith('/voice-settings')) return structuredClone(saved);
      throw Error('Unexpected GET ' + path);
    }
    if (onWrite) return onWrite(path, request, { setVoice: id => { config.voice_id = id; saved.saved_voice = { voice_id: id, voice_name: 'Eve' }; } });
    if (path.endsWith('/voice-catalog')) return structuredClone(catalog);
    if (path.endsWith('/voice-choice')) {
      config.voice_id = request.body.voice_id; saved.saved_voice = { voice_id: config.voice_id, voice_name: 'Eve' };
      return { saved: true, voice_id: config.voice_id, outreach_started: false };
    }
    if (path.endsWith('/voice-preview')) return { provider: 'retell', voice_id: request.body.voice_id, mime: 'audio/mpeg', audio_base64: 'ZmFrZS1hdWRpbw==', outreach_started: false };
    if (path.endsWith('/voice-apply')) return { operation_id: request.body.request_id, version_id: 'version-two', status: 'queued', queued: true, unchanged: false, outreach_started: false };
    throw Error('Unexpected write ' + path);
  };
  onStart?.(root);
  const controller = await mountVoiceSettings(root, api, { canRead: true, canConfigure: true, canPublish: true, ...options });
  return { root, requests, controller, created, revoked, timers, setStatus: value => { saved = structuredClone(value); }, async runPoll() {
    const entry = timers.entries().next().value; assert.ok(entry, 'a read-only status poll is scheduled'); timers.delete(entry[0]); await entry[1]();
  }, restore() {
    controller.dispose(); URL.createObjectURL = create; URL.revokeObjectURL = revoke; Object.assign(globalThis, original);
  } };
}
const writes = h => h.requests.filter(item => item.method && item.method !== 'GET');
async function selectEve(h) {
  await byText(h.root, 'Load available voices').onclick();
  field(h.root, 'agent_voice').value = 'eve_voice'; field(h.root, 'agent_voice').onchange();
}

test('voice settings loads saved state without any supplier write or apply', async () => {
  const h = await harness();
  try {
    assert.equal(writes(h).length, 0);
    assert.match(h.root.textContent, /Published voice: Old voice/);
    assert.ok(byText(h.root, 'Apply voice to agent'));
    assert.equal(all(h.root).some(node => node.type === 'password'), false);
  } finally { h.restore(); }
});

test('catalog filtering includes provider gender accent and name with no credentials or live mutation', async () => {
  const h = await harness();
  try {
    await byText(h.root, 'Load available voices').onclick();
    field(h.root, 'voice_provider').value = 'cartesia';
    field(h.root, 'voice_gender').value = 'female';
    field(h.root, 'voice_accent').value = 'British';
    field(h.root, 'voice_query').value = 'Eve'; field(h.root, 'voice_query').oninput();
    await byText(h.root, 'Load available voices').onclick();
    assert.deepEqual(writes(h).at(-1).body, { provider: 'cartesia', gender: 'female', accent: 'British', query: 'Eve', offset: 0 });
    assert.ok(all(h.root).find(node => node.tag === 'option' && node.value === 'eve_voice'));
    assert.equal(writes(h).some(item => item.path.endsWith('/voice-apply') || item.path.endsWith('/voice-choice')), false);
  } finally { h.restore(); }
});

test('save choice preserves caller and requires a separate explicit Apply', async () => {
  const h = await harness();
  try {
    await selectEve(h);
    assert.equal(byText(h.root, 'Apply voice to agent').disabled, true);
    await byText(h.root, 'Save voice choice').onclick();
    const saved = writes(h).find(item => item.path.endsWith('/voice-choice'));
    assert.deepEqual(saved.body, { voice_id: 'eve_voice' });
    assert.equal(writes(h).some(item => item.path.endsWith('/voice-apply')), false);
    assert.match(h.root.textContent, /published agent has not changed/);
    const form = all(h.root).find(node => node.className === 'voice-settings-apply');
    await form.onsubmit({ preventDefault() {} });
    assert.equal(writes(h).some(item => item.path.endsWith('/voice-apply')), false);
    field(h.root, 'voice_apply_confirmed').checked = true;
    await form.onsubmit({ preventDefault() {} });
    const applied = writes(h).find(item => item.path.endsWith('/voice-apply'));
    assert.equal(applied.body.version_id, 'version-one');
    assert.equal(applied.body.confirmation, 'APPLY VERIFIED VOICE TO MY AGENT');
    assert.match(applied.body.request_id, /^[A-Za-z0-9_-]{16,100}$/);
    assert.equal(Object.hasOwn(applied.body, 'voice_id'), false);
  } finally { h.restore(); }
});

test('preview uses bounded same-origin audio and revokes the Blob without changing choice', async () => {
  const h = await harness();
  try {
    await selectEve(h);
    await byText(h.root, 'Hear selected voice').onclick();
    assert.equal(h.created.length, 1);
    assert.deepEqual(writes(h).at(-1).body, { voice_id: 'eve_voice' });
    const audio = all(h.root).find(node => node.tag === 'audio');
    assert.equal(audio.src, 'blob:synthetic-1'); assert.equal(audio.hidden, false);
    assert.equal(writes(h).some(item => item.path.endsWith('/voice-choice') || item.path.endsWith('/voice-apply')), false);
    field(h.root, 'agent_voice').value = 'old_voice'; field(h.root, 'agent_voice').onchange();
    assert.deepEqual(h.revoked, ['blob:synthetic-1']); assert.equal(audio.hidden, true);
  } finally { h.restore(); }
});

test('lost Apply response checks the same request ID instead of another voice build', async () => {
  const bodies = [];
  const h = await harness({ initial: { ...state, saved_voice: { voice_id: 'eve_voice', voice_name: 'Eve' } }, onWrite: async (path, request) => {
    assert.ok(path.endsWith('/voice-apply')); bodies.push(request.body);
    if (bodies.length === 1) throw Error('Connection lost');
    return { operation_id: request.body.request_id, version_id: 'version-two', status: 'queued', queued: true, unchanged: false, outreach_started: false };
  } });
  try {
    const form = all(h.root).find(node => node.className === 'voice-settings-apply');
    field(h.root, 'voice_apply_confirmed').checked = true;
    await form.onsubmit({ preventDefault() {} });
    await form.onsubmit({ preventDefault() {} });
    assert.equal(bodies.length, 2); assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(field(h.root, 'voice_apply_confirmed').disabled, true);
  } finally { h.restore(); }
});

test('changed business cannot receive a stale voice preview or verification result', async () => {
  const pending = deferred(); let current = true;
  const h = await harness({ options: { isCurrent: () => current }, onWrite: async path => {
    if (path.endsWith('/voice-catalog')) return structuredClone(catalog);
    return pending.promise;
  } });
  try {
    await selectEve(h);
    const saving = byText(h.root, 'Save voice choice').onclick();
    current = false;
    pending.resolve({ saved: true, voice_id: 'eve_voice', outreach_started: false });
    await saving;
    assert.equal(writes(h).length, 2);
    assert.equal(h.requests.filter(item => item.path.endsWith('/voice-settings')).length, 1);
    assert.equal(h.created.length, 0);
  } finally { h.restore(); }
});

test('read-only settings cannot list preview save or apply', async () => {
  const h = await harness({ options: { canConfigure: false, canPublish: false } });
  try {
    assert.equal(byText(h.root, 'Load available voices').disabled, true);
    assert.equal(byText(h.root, 'Hear selected voice').disabled, true);
    assert.equal(byText(h.root, 'Save voice choice').disabled, true);
    assert.equal(byText(h.root, 'Apply voice to agent').disabled, true);
    assert.equal(writes(h).length, 0);
  } finally { h.restore(); }
});

test('no access performs no read or credential request', async () => {
  const h = await harness({ options: { canRead: false } });
  try { assert.equal(h.requests.length, 0); assert.match(h.root.textContent, /no voice settings access/); }
  finally { h.restore(); }
});


test('status refresh preserves an unsaved voice choice and its matching preview', async () => {
  const h = await harness();
  try {
    await selectEve(h); await byText(h.root, 'Hear selected voice').onclick();
    const audio = all(h.root).find(node => node.tag === 'audio');
    assert.equal(audio.hidden, false);
    await byText(h.root, 'Check voice status').onclick();
    assert.equal(field(h.root, 'agent_voice').value, 'eve_voice');
    assert.equal(audio.hidden, false); assert.equal(audio.src, 'blob:synthetic-1');
    assert.deepEqual(h.revoked, []);
    assert.equal(writes(h).some(item => item.path.endsWith('/voice-choice') || item.path.endsWith('/voice-apply')), false);
  } finally { h.restore(); }
});

test('a filtered catalog clears preview audio when the previously selected voice is absent', async () => {
  let filtered = false;
  const h = await harness({ onWrite: async (path, request) => {
    if (path.endsWith('/voice-catalog')) return structuredClone(filtered ? { ...catalog, voices: [], total: 0 } : catalog);
    if (path.endsWith('/voice-preview')) return { provider: 'retell', voice_id: request.body.voice_id, mime: 'audio/mpeg', audio_base64: 'ZmFrZS1hdWRpbw==', outreach_started: false };
    throw Error('Unexpected write');
  } });
  try {
    await selectEve(h); await byText(h.root, 'Hear selected voice').onclick();
    const audio = all(h.root).find(node => node.tag === 'audio');
    filtered = true; await byText(h.root, 'Load available voices').onclick();
    assert.equal(field(h.root, 'agent_voice').value, ''); assert.equal(audio.hidden, true);
    assert.equal(audio.src, ''); assert.equal(audio.paused, true); assert.deepEqual(h.revoked, ['blob:synthetic-1']);
    assert.equal(byText(h.root, 'Hear selected voice').disabled, true);
  } finally { h.restore(); }
});

const voiceOperation = (status = 'queued', extra = {}) => ({ operation_id: 'saved_voice_operation_12345', parent_version_id: 'version-one',
  version_id: 'version-two', status, step: status === 'published' ? 'complete' : 'voice', unchanged: false, ...extra });
const applyFeedback = h => all(h.root).find(node => node.className === 'voice-settings-apply').children.find(node => node.className === 'voice-settings-feedback');
const saveFeedback = h => all(h.root).find(node => node.className === 'voice-settings-save').children.find(node => node.className === 'voice-settings-feedback');

test('save shows working state beside its button, prevents repeat submit and confirms saved-only success', async () => {
  const pending = deferred();
  const h = await harness({ onWrite: async (path, request, context) => {
    if (path.endsWith('/voice-catalog')) return structuredClone(catalog);
    if (path.endsWith('/voice-choice')) { await pending.promise; context.setVoice(request.body.voice_id); return { saved: true, voice_id: request.body.voice_id, outreach_started: false }; }
    throw Error('Unexpected write');
  } });
  try {
    await selectEve(h);
    const button = byText(h.root, 'Save voice choice');
    const operation = button.onclick();
    assert.equal(button.textContent, 'Verifying and saving…'); assert.equal(button.disabled, true);
    assert.equal(saveFeedback(h).attributes['data-state'], 'pending');
    assert.match(saveFeedback(h).textContent, /Verifying this voice/);
    await button.onclick(); assert.equal(writes(h).filter(item => item.path.endsWith('/voice-choice')).length, 1);
    pending.resolve(); await operation;
    assert.equal(button.textContent, 'Save voice choice');
    assert.equal(saveFeedback(h).attributes['data-state'], 'success');
    assert.match(saveFeedback(h).textContent, /saved.*published agent has not changed/);
    assert.match(h.root.textContent, /Published voice: Old voice/);
    assert.equal(writes(h).some(item => item.path.endsWith('/voice-apply')), false);
    assert.equal(field(h.root, 'agent_voice').value, 'eve_voice');
  } finally { h.restore(); }
});

test('save failure stays next to the action and preserves the selected voice', async () => {
  const h = await harness({ onWrite: async path => {
    if (path.endsWith('/voice-catalog')) return structuredClone(catalog);
    throw Error('Retell could not verify this voice');
  } });
  try {
    await selectEve(h); await byText(h.root, 'Save voice choice').onclick();
    assert.equal(saveFeedback(h).attributes.role, 'alert'); assert.equal(saveFeedback(h).attributes['data-state'], 'error');
    assert.match(saveFeedback(h).textContent, /could not verify.*selection is preserved/);
    assert.equal(field(h.root, 'agent_voice').value, 'eve_voice');
    assert.equal(byText(h.root, 'Save voice choice').disabled, false);
    assert.equal(writes(h).some(item => item.path.endsWith('/voice-apply')), false);
  } finally { h.restore(); }
});

test('accepted voice update polls only GET and shows published success only for its confirmed version', async () => {
  const pending = deferred(); let applyBody;
  const h = await harness({ initial: { ...state, saved_voice: { voice_id: 'eve_voice', voice_name: 'Eve' } }, onWrite: async (path, request) => {
    assert.ok(path.endsWith('/voice-apply')); applyBody = request.body;
    return pending.promise;
  } });
  try {
    const form = all(h.root).find(node => node.className === 'voice-settings-apply');
    field(h.root, 'voice_apply_confirmed').checked = true;
    const operation = form.onsubmit({ preventDefault() {} });
    assert.equal(byText(h.root, 'Applying voice…').disabled, true);
    assert.equal(applyFeedback(h).attributes['data-state'], 'pending');
    await form.onsubmit({ preventDefault() {} }); assert.equal(writes(h).length, 1);
    pending.resolve({ operation_id: applyBody.request_id, version_id: 'version-two', status: 'queued', unchanged: false, outreach_started: false });
    await operation;
    assert.equal(applyFeedback(h).attributes['data-state'], 'pending');
    assert.doesNotMatch(applyFeedback(h).textContent, /update published/);
    assert.equal(field(h.root, 'voice_provider').disabled, true);
    h.setStatus({ ...state, saved_voice: { voice_id: 'eve_voice', voice_name: 'Eve' }, can_apply: true,
      published: { version_id: 'version-two', voice_id: 'eve_voice', voice_name: 'Eve', status: 'published' },
      voice_operation: voiceOperation('published', { operation_id: applyBody.request_id }) });
    await h.runPoll();
    assert.equal(writes(h).length, 1); assert.equal(h.timers.size, 0);
    assert.equal(applyFeedback(h).attributes['data-state'], 'success');
    assert.match(applyFeedback(h).textContent, /Voice update published.*using Eve.*knowledge stayed unchanged/);
    assert.match(h.root.textContent, /Published voice: Eve/);
    assert.equal(byText(h.root, 'Apply voice to agent').disabled, true);
    assert.equal(field(h.root, 'voice_provider').disabled, false);
  } finally { h.restore(); }
});

test('reload restores a persisted pending request and checks it without another apply POST', async () => {
  const operation = voiceOperation();
  const h = await harness({ initial: { ...state, saved_voice: { voice_id: 'eve_voice', voice_name: 'Eve' }, can_apply: false,
    blocker: 'Finish or review the newer agent version before applying a voice change.', voice_operation: operation } });
  try {
    assert.equal(writes(h).length, 0); assert.equal(h.timers.size, 1);
    assert.equal(field(h.root, 'agent_voice').disabled, true);
    assert.equal(byText(h.root, 'Check this voice request').disabled, false);
    const form = all(h.root).find(node => node.className === 'voice-settings-apply');
    await form.onsubmit({ preventDefault() {} });
    assert.equal(writes(h).length, 0);
    assert.equal(h.requests.filter(item => item.path.endsWith('/voice-settings')).length, 2);
    assert.equal(applyFeedback(h).attributes['data-state'], 'pending');
  } finally { h.restore(); }
});

for (const status of ['uncertain', 'failed']) test(`${status} voice request stays held and refresh never retries publication`, async () => {
  const h = await harness({ initial: { ...state, saved_voice: { voice_id: 'eve_voice', voice_name: 'Eve' }, can_apply: false, voice_operation: voiceOperation(status) } });
  try {
    assert.equal(h.timers.size, 0); assert.equal(field(h.root, 'agent_voice').disabled, true);
    assert.equal(applyFeedback(h).attributes['data-state'], status === 'failed' ? 'error' : 'warning');
    await all(h.root).find(node => node.className === 'voice-settings-apply').onsubmit({ preventDefault() {} });
    assert.equal(writes(h).length, 0); assert.equal(h.timers.size, 0);
    assert.equal(byText(h.root, 'Check this voice request').disabled, false);
  } finally { h.restore(); }
});

test('status polling is bounded and does not relabel queued publication as success', async () => {
  const h = await harness({ initial: { ...state, saved_voice: { voice_id: 'eve_voice', voice_name: 'Eve' }, can_apply: false, voice_operation: voiceOperation() } });
  try {
    for (let index = 0; index < 30; index++) await h.runPoll();
    assert.equal(h.timers.size, 0); assert.equal(writes(h).length, 0);
    assert.equal(applyFeedback(h).attributes['data-state'], 'warning');
    assert.match(applyFeedback(h).textContent, /not confirmed publication.*request is preserved/);
    assert.ok(byText(h.root, 'Check this voice request'));
  } finally { h.restore(); }
});

test('initial read failure leaves a visible read-only retry and cannot enable writes', async () => {
  let reads = 0;
  const h = await harness({ onRead: async (_path, _request, value) => { if (++reads === 1) throw Error('Voice status unavailable'); return value(); } });
  try {
    assert.equal(byText(h.root, 'Check voice status').disabled, false);
    assert.equal(byText(h.root, 'Save voice choice').disabled, true);
    await byText(h.root, 'Check voice status').onclick();
    assert.equal(writes(h).length, 0); assert.match(h.root.textContent, /Published voice: Old voice/);
  } finally { h.restore(); }
});

test('initial status loading disables every mutation before the saved binding is known', async () => {
  const pending = deferred(); let root;
  const mounting = harness({ onStart: value => { root = value; }, onRead: async () => pending.promise });
  const form = all(root).find(node => node.className === 'voice-settings-apply');
  assert.equal(byText(root, 'Apply voice to agent').disabled, true);
  assert.equal(byText(root, 'Save voice choice').disabled, true);
  assert.equal(field(root, 'voice_apply_confirmed').disabled, true);
  assert.match(root.textContent, /Loading saved and published voice settings/);
  field(root, 'voice_apply_confirmed').checked = true;
  await form.onsubmit({ preventDefault() {} });
  pending.resolve(structuredClone(state)); const h = await mounting;
  try { assert.equal(writes(h).length, 0); }
  finally { h.restore(); }
});

test('confirmed save with failed status refresh is reported accurately and holds new writes until a successful read', async () => {
  let reads = 0;
  const h = await harness({ onRead: async (_path, _request, value) => { if (++reads === 2) throw Error('Status read failed'); return value(); },
    onWrite: async (path, request, context) => {
      if (path.endsWith('/voice-catalog')) return structuredClone(catalog);
      if (path.endsWith('/voice-choice')) { context.setVoice(request.body.voice_id); return { saved: true, voice_id: request.body.voice_id, outreach_started: false }; }
      throw Error('Unexpected write');
    } });
  try {
    await selectEve(h); await byText(h.root, 'Save voice choice').onclick();
    assert.equal(saveFeedback(h).attributes['data-state'], 'warning');
    assert.match(saveFeedback(h).textContent, /was saved.*could not be refreshed/);
    assert.equal(field(h.root, 'agent_voice').value, 'eve_voice');
    assert.equal(byText(h.root, 'Apply voice to agent').disabled, true);
    assert.equal(byText(h.root, 'Check voice status').disabled, false);
    await byText(h.root, 'Check voice status').onclick();
    assert.equal(byText(h.root, 'Apply voice to agent').disabled, false);
    assert.equal(writes(h).filter(item => item.path.endsWith('/voice-choice')).length, 1);
    assert.equal(writes(h).some(item => item.path.endsWith('/voice-apply')), false);
  } finally { h.restore(); }
});

test('failed pending-result read holds publication, retains the receipt and offers a GET retry', async () => {
  let reads = 0;
  const queued = { ...state, saved_voice: { voice_id: 'eve_voice', voice_name: 'Eve' }, can_apply: false, voice_operation: voiceOperation() };
  const h = await harness({ initial: queued, onRead: async (_path, _request, value) => { if (++reads === 2) throw Error('Provider status unavailable'); return value(); } });
  try {
    await h.runPoll();
    assert.equal(h.timers.size, 0); assert.equal(applyFeedback(h).attributes['data-state'], 'warning');
    assert.match(applyFeedback(h).textContent, /request is preserved/);
    assert.equal(byText(h.root, 'Check this voice request').disabled, true);
    assert.equal(byText(h.root, 'Check voice status').disabled, false);
    await byText(h.root, 'Check voice status').onclick();
    assert.equal(byText(h.root, 'Check this voice request').disabled, false);
    assert.equal(writes(h).length, 0);
  } finally { h.restore(); }
});

test('disposed or changed-business polling cannot report old voice publication', async () => {
  const pending = deferred(); let reads = 0, current = true;
  const queued = { ...state, saved_voice: { voice_id: 'eve_voice', voice_name: 'Eve' }, can_apply: false, voice_operation: voiceOperation() };
  const h = await harness({ initial: queued, options: { isCurrent: () => current }, onRead: async (_path, _request, value) => ++reads === 1 ? value() : pending.promise });
  try {
    const operation = h.runPoll(); current = false;
    pending.resolve({ ...queued, published: { version_id: 'version-two', voice_id: 'eve_voice', voice_name: 'Eve', status: 'published' }, voice_operation: voiceOperation('published') });
    await operation;
    assert.doesNotMatch(applyFeedback(h).textContent, /update published/);
    assert.equal(writes(h).length, 0); assert.equal(h.timers.size, 0);
  } finally { h.restore(); }
});

test('an old published operation never claims that a different current agent uses its voice', async () => {
  const h = await harness({ initial: { ...state, saved_voice: { voice_id: 'eve_voice', voice_name: 'Eve' }, voice_operation: voiceOperation('published') } });
  try {
    assert.equal(applyFeedback(h).attributes['data-state'], 'warning');
    assert.match(applyFeedback(h).textContent, /different agent version is currently published/);
    assert.doesNotMatch(applyFeedback(h).textContent, /now using Eve/);
    assert.equal(writes(h).length, 0);
  } finally { h.restore(); }
});

test('publication reports its actual voice when a newer different choice was only saved', async () => {
  const h = await harness({ initial: { ...state, saved_voice: { voice_id: 'new_unsaved_apply', voice_name: 'Different saved voice' },
    published: { version_id: 'version-two', voice_id: 'eve_voice', voice_name: 'Eve', status: 'published' }, voice_operation: voiceOperation('published') } });
  try {
    assert.equal(applyFeedback(h).attributes['data-state'], 'success');
    assert.match(applyFeedback(h).textContent, /now using Eve/);
    assert.doesNotMatch(applyFeedback(h).textContent, /now using Different/);
    assert.match(h.root.textContent, /different saved choice is ready to apply/);
  } finally { h.restore(); }
});
