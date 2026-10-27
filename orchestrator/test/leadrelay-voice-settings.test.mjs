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

async function harness({ options = {}, initial = state, onWrite } = {}) {
  const original = { document: globalThis.document, MutationObserver: globalThis.MutationObserver };
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  const created = [], revoked = [];
  URL.createObjectURL = blob => { created.push(blob); return `blob:synthetic-${created.length}`; };
  URL.revokeObjectURL = url => revoked.push(url);
  globalThis.document = { createElement: tag => new Element(tag), documentElement: new Element('html') };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  let saved = structuredClone(initial), config = { voice_id: 'old_voice', from_number: '+447700900111' };
  const requests = [], root = new Element('root');
  const api = async (path, request = {}) => {
    if (request.guard && !request.guard()) throw Error('View changed');
    requests.push({ path, ...request });
    if (!request.method || request.method === 'GET') {
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
  const controller = await mountVoiceSettings(root, api, { canRead: true, canConfigure: true, canPublish: true, ...options });
  return { root, requests, controller, created, revoked, restore() {
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


test('status refresh clears preview audio when it resets an unsaved voice selection', async () => {
  const h = await harness();
  try {
    await selectEve(h); await byText(h.root, 'Hear selected voice').onclick();
    const audio = all(h.root).find(node => node.tag === 'audio');
    assert.equal(audio.hidden, false);
    await byText(h.root, 'Check voice status').onclick();
    assert.equal(field(h.root, 'agent_voice').value, 'old_voice');
    assert.equal(audio.hidden, true); assert.equal(audio.src, ''); assert.equal(audio.paused, true);
    assert.deepEqual(h.revoked, ['blob:synthetic-1']);
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
