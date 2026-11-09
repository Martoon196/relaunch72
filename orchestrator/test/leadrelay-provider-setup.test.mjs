import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/integrations/leadrelay/provider-setup.js', import.meta.url), 'utf8');
const { mountProviderSetup } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.value = ''; this.disabled = false; this.isConnected = true; this.attributes = {};
    this.classes = new Set();
    this.classList = { add: value => this.classes.add(value), toggle: (value, on) => on ? this.classes.add(value) : this.classes.delete(value) };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text || this.children.map(child => child.textContent).join(' '); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.text = ''; }
  setAttribute(key, value) { this.attributes[key] = value; }
  reportValidity() { return true; }
}
const all = node => [node, ...node.children.flatMap(all)];
const find = (root, predicate) => all(root).find(predicate);
const field = (root, name) => find(root, node => node.name === name);
const text = (root, value) => find(root, node => node.textContent === value);
const form = root => find(root, node => node.tag === 'form');
const submit = root => form(root).onsubmit({ preventDefault() {} });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; };
const disconnected = { provider: 'retell', verified: false, has_secret: false, has_webhook_secret: false, config: {}, outreach_started: false };
const voiceList = { provider: 'retell', voices: [{ voice_id: 'voice-a', voice_name: 'Alex', accent: 'British', gender: 'female' }], outreach_started: false };
const numberList = { provider: 'retell', phone_numbers: [{ phone_number: '+447700900123', nickname: 'Synthetic caller', number_type: 'custom' }], truncated: false, outreach_started: false };
const verified = { verified: true, config: { voice_id: 'voice-a', from_number: '', verified_at: 123 }, outreach_started: false };
function globals() {
  const original = { document: globalThis.document, MutationObserver: globalThis.MutationObserver };
  const observers = [];
  globalThis.document = { createElement: tag => new Element(tag), documentElement: new Element('html') };
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  return { observers, restore: () => Object.assign(globalThis, original) };
}
async function harness({ initial = disconnected, onWrite = async path => path.endsWith('/voices') ? voiceList : verified, options = {} } = {}) {
  const env = globals(); const root = new Element('root'); const writes = [], reads = [];
  let status = initial;
  const api = async (path, request) => {
    if (!request) { reads.push(path); return status; }
    writes.push({ path, ...request }); return onWrite(path, request);
  };
  const controller = await mountProviderSetup(root, api, { canRead: true, canConfigure: true, ...options });
  return { ...env, root, api, writes, reads, controller, setStatus: next => { status = next; } };
}
async function prepare(root) {
  field(root, 'secret').value = 'new-provider-api-secret';
  field(root, 'webhook_secret').value = 'documented-webhook-key';
  await text(root, 'Load available voices').onclick();
  field(root, 'voice_id').value = 'voice-a'; field(root, 'voice_id').onchange();
}

test('provider setup defaults to no access and performs no request', async () => {
  const env = globals(); const root = new Element('root'); let called = false;
  try {
    await mountProviderSetup(root, async () => { called = true; });
    assert.equal(called, false);
    assert.match(root.textContent, /no connection access/);
    assert.equal(field(root, 'secret'), undefined);
  } finally { env.restore(); }
});

test('read-only connection access exposes status but no credential form', async () => {
  const h = await harness({ initial: { ...disconnected, verified: true, has_secret: true, has_webhook_secret: true, config: { voice_id: 'saved-voice' } }, options: { canConfigure: false } });
  try {
    assert.deepEqual(h.reads, ['/api/agent-builder/connection']);
    assert.ok(text(h.root, 'Connected and verified'));
    assert.equal(field(h.root, 'secret'), undefined);
    assert.equal(form(h.root), undefined);
    assert.deepEqual(h.writes, []);
  } finally { h.restore(); }
});

test('voices are read from the authorised API and selected by returned ID without manual ID entry', async () => {
  const unsafeName = '<img src=x onerror=alert(1)>';
  const h = await harness({ onWrite: async () => ({ ...voiceList, voices: [{ voice_id: 'voice-a', voice_name: unsafeName }] }) });
  try {
    field(h.root, 'secret').value = 'new-provider-api-secret';
    field(h.root, 'webhook_secret').value = 'separate-webhook-key';
    await text(h.root, 'Load available voices').onclick();
    assert.equal(field(h.root, 'voice_id').tag, 'select');
    assert.equal(field(h.root, 'voice_id').disabled, false);
    assert.deepEqual(h.writes[0].body, { secret: 'new-provider-api-secret' });
    assert.equal(h.writes[0].path, '/api/agent-builder/connection/voices');
    assert.equal(typeof h.writes[0].guard, 'function');
    assert.ok(text(h.root, unsafeName));
    assert.equal(all(h.root).filter(node => node.tag === 'img').length, 0);
    assert.equal(field(h.root, 'secret').value, 'new-provider-api-secret');
  } finally { h.restore(); }
});

test('pending voice reads cannot double-submit and do not erase the typed key before verification', async () => {
  const pending = deferred(); const h = await harness({ onWrite: async () => pending.promise });
  try {
    field(h.root, 'secret').value = 'new-provider-api-secret';
    const button = text(h.root, 'Load available voices'); const operation = button.onclick();
    await button.onclick(); assert.equal(h.writes.length, 1); assert.equal(button.disabled, true);
    pending.resolve(voiceList); await operation;
    assert.equal(field(h.root, 'secret').value, 'new-provider-api-secret');
  } finally { h.restore(); }
});

test('unverified setup requires the designated webhook key and a selected returned voice', async () => {
  const h = await harness();
  try {
    field(h.root, 'secret').value = 'new-provider-api-secret';
    await submit(h.root);
    assert.match(find(h.root, node => node.className === 'provider-setup-notice').textContent, /webhook verification key/);
    field(h.root, 'webhook_secret').value = 'documented-webhook-key';
    await submit(h.root);
    assert.match(find(h.root, node => node.className === 'provider-setup-notice').textContent, /choose one/);
    assert.equal(h.writes.length, 0);
  } finally { h.restore(); }
});

test('confirmed verification saves only setup fields, clears password values and reports the actual result', async () => {
  const callbacks = []; const h = await harness({ options: { onVerified: result => { callbacks.push(result); } } });
  try {
    await prepare(h.root); await submit(h.root);
    assert.deepEqual(h.writes[1].body, { voice_id: 'voice-a', from_number: '', secret: 'new-provider-api-secret', webhook_secret: 'documented-webhook-key' });
    assert.equal(h.writes[1].path, '/api/agent-builder/connection/verify');
    assert.equal(field(h.root, 'secret').value, ''); assert.equal(field(h.root, 'webhook_secret').value, '');
    assert.ok(text(h.root, 'Connected and verified'));
    assert.match(find(h.root, node => node.className === 'provider-setup-notice').textContent, /verified and saved/);
    assert.deepEqual(callbacks, [verified]);
  } finally { h.restore(); }
});

test('saved encrypted credentials can be reused without posting blank secrets or revealing existing values', async () => {
  const h = await harness({ initial: { ...disconnected, verified: true, has_secret: true, has_webhook_secret: true, config: { voice_id: 'voice-a', from_number: '' } } });
  try {
    assert.equal(field(h.root, 'secret').value, '');
    assert.equal(field(h.root, 'webhook_secret').value, '');
    await submit(h.root);
    assert.deepEqual(h.writes[0].body, { voice_id: 'voice-a', from_number: '' });
  } finally { h.restore(); }
});

test('failed verification keeps form values but redacts credentials from displayed error text', async () => {
  const h = await harness({ onWrite: async path => {
    if (path.endsWith('/voices')) return voiceList;
    throw Error('Rejected new-provider-api-secret and documented-webhook-key');
  } });
  try {
    await prepare(h.root); await submit(h.root);
    const notice = find(h.root, node => node.className === 'provider-setup-notice');
    assert.equal(notice.attributes.role, 'alert');
    assert.equal(notice.textContent, 'Rejected [redacted] and [redacted]');
    assert.equal(field(h.root, 'secret').value, 'new-provider-api-secret');
    assert.equal(field(h.root, 'webhook_secret').value, 'documented-webhook-key');
    assert.equal(text(h.root, 'Connected and verified'), undefined);
  } finally { h.restore(); }
});

test('an unconfirmed verification result cannot become a connected success state', async () => {
  const h = await harness({ onWrite: async path => path.endsWith('/voices') ? voiceList : { verified: false, config: { voice_id: 'voice-a' } } });
  try {
    await prepare(h.root); await submit(h.root);
    assert.equal(text(h.root, 'Connected and verified'), undefined);
    assert.match(find(h.root, node => node.className === 'provider-setup-notice').textContent, /did not confirm/);
    assert.equal(field(h.root, 'secret').value, 'new-provider-api-secret');
  } finally { h.restore(); }
});

test('changing API key invalidates prior voices and ignores a delayed response for the previous key', async () => {
  const pending = deferred(); const h = await harness({ onWrite: async () => pending.promise });
  try {
    field(h.root, 'secret').value = 'first-provider-key';
    const operation = text(h.root, 'Load available voices').onclick();
    field(h.root, 'webhook_secret').value = 'prior-account-webhook-key';
    field(h.root, 'secret').value = 'second-provider-key'; field(h.root, 'secret').oninput();
    assert.equal(field(h.root, 'webhook_secret').value, '');
    assert.equal(h.writes[0].guard(), false);
    pending.resolve(voiceList); await operation;
    assert.equal(all(field(h.root, 'voice_id')).some(node => node.value === 'voice-a'), false);
    assert.equal(field(h.root, 'voice_id').disabled, true);
    assert.equal(field(h.root, 'secret').value, 'second-provider-key');
  } finally { h.restore(); }
});

test('verification request guards bind credential values and cannot show stale success after a credential change', async () => {
  const pending = deferred(); let callbacks = 0;
  const h = await harness({ onWrite: async path => path.endsWith('/voices') ? voiceList : pending.promise, options: { onVerified: () => { callbacks++; } } });
  try {
    await prepare(h.root);
    const operation = submit(h.root);
    assert.equal(h.writes[1].guard(), true);
    field(h.root, 'secret').value = 'replacement-provider-key'; field(h.root, 'secret').oninput();
    assert.equal(h.writes[1].guard(), false);
    assert.equal(field(h.root, 'webhook_secret').value, '');
    pending.resolve(verified); await operation;
    assert.equal(callbacks, 0);
    assert.equal(text(h.root, 'Connected and verified'), undefined);
    assert.equal(field(h.root, 'secret').value, 'replacement-provider-key');
    assert.match(find(h.root, node => node.className === 'provider-setup-notice').textContent, /setup changed while verification was pending/);
  } finally { h.restore(); }
});

test('a stale failed voice request cannot overwrite feedback for newly entered credentials', async () => {
  const pending = deferred(); const h = await harness({ onWrite: async () => pending.promise });
  try {
    field(h.root, 'secret').value = 'first-provider-key';
    const operation = text(h.root, 'Load available voices').onclick();
    field(h.root, 'secret').value = 'replacement-provider-key'; field(h.root, 'secret').oninput();
    pending.reject(Error('Prior account was rejected')); await operation;
    const notice = find(h.root, node => node.className === 'provider-setup-notice');
    assert.match(notice.textContent, /Load voices for this API key/);
    assert.doesNotMatch(notice.textContent, /Prior account/);
    assert.equal(field(h.root, 'secret').value, 'replacement-provider-key');
  } finally { h.restore(); }
});

test('verification transport guard also binds the selected voice and caller configuration', async () => {
  const pending = deferred(); const h = await harness({ onWrite: async path => path.endsWith('/voices') ? voiceList : pending.promise });
  try {
    await prepare(h.root);
    const operation = submit(h.root);
    field(h.root, 'from_number').value = '+441234567890';
    assert.equal(h.writes[1].guard(), false);
    pending.resolve(verified); await operation;
    assert.equal(text(h.root, 'Connected and verified'), undefined);
  } finally { h.restore(); }
});

test('detaching or changing the selected installation clears typed secrets and fences pending results', async () => {
  for (const mode of ['detach', 'selection']) {
    const pending = deferred(); let current = true;
    const h = await harness({ onWrite: async () => pending.promise, options: { isCurrent: () => current } });
    try {
      field(h.root, 'secret').value = 'new-provider-api-secret'; field(h.root, 'webhook_secret').value = 'documented-webhook-key';
      const secret = field(h.root, 'secret'), webhook = field(h.root, 'webhook_secret');
      const operation = text(h.root, 'Load available voices').onclick();
      if (mode === 'detach') h.root.isConnected = false; else current = false;
      h.observers[0].callback();
      assert.equal(secret.value, ''); assert.equal(webhook.value, '');
      assert.equal(h.writes[0].guard(), false);
      pending.resolve(voiceList); await operation;
      assert.equal(all(field(h.root, 'voice_id')).some(node => node.value === 'voice-a'), false);
    } finally { h.restore(); }
  }
});

test('a newly mounted installation cannot be replaced by an old verification response', async () => {
  const pending = deferred(); const h = await harness({ onWrite: async path => path.endsWith('/voices') ? voiceList : pending.promise });
  try {
    await prepare(h.root);
    const oldKey = field(h.root, 'secret'), oldWebhook = field(h.root, 'webhook_secret');
    const operation = submit(h.root);
    await mountProviderSetup(h.root, async () => disconnected, { canRead: true, canConfigure: true });
    assert.equal(oldKey.value, ''); assert.equal(oldWebhook.value, '');
    pending.resolve(verified); await operation;
    assert.equal(text(h.root, 'Connected and verified'), undefined);
  } finally { h.restore(); }
});

test('voice-list-only permission cannot save a provider connection', async () => {
  const h = await harness({ options: { canConfigure: false, canListVoices: true, canVerify: false } });
  try {
    await prepare(h.root); await submit(h.root);
    assert.equal(h.writes.length, 1);
    assert.equal(text(h.root, 'Verify and save connection').disabled, true);
  } finally { h.restore(); }
});

test('a saved-connection check preserves unsaved credentials and directs the user to voice loading and verification', async () => {
  const h = await harness();
  try {
    field(h.root, 'secret').value = 'new-provider-api-secret'; field(h.root, 'webhook_secret').value = 'documented-webhook-key';
    field(h.root, 'webhook_secret').oninput();
    const check = text(h.root, 'Check saved API connection');
    assert.equal(check.disabled, true);
    await check.onclick();
    assert.equal(field(h.root, 'secret').value, 'new-provider-api-secret');
    assert.equal(field(h.root, 'webhook_secret').value, 'documented-webhook-key');
    assert.match(find(h.root, node => node.className === 'provider-setup-notice').textContent, /typed credentials are not saved.*Load available voices/);
    assert.equal(h.reads.length, 1); assert.deepEqual(h.writes, []);
  } finally { h.restore(); }
});

test('repeated saved API checks visibly complete while browser login alone never implies connection', async () => {
  const h = await harness();
  try {
    const notice = find(h.root, node => node.className === 'provider-setup-notice');
    assert.match(notice.textContent, /Saved API check #1 complete.*No Retell API key saved.*Retell browser login does not connect/);
    await text(h.root, 'Check saved API connection').onclick();
    assert.match(notice.textContent, /Saved API check #2 complete.*No Retell API key saved/);
    assert.equal(text(h.root, 'Connected and verified'), undefined);
    assert.equal(h.reads.length, 2); assert.deepEqual(h.writes, []);
  } finally { h.restore(); }
});

test('one-time API instructions name the provider key screen and keep agent configuration inside LeadRelay', async () => {
  const h = await harness();
  try {
    const steps = all(h.root).filter(node => node.tag === 'li');
    assert.equal(steps.length, 3);
    assert.match(steps[0].textContent, /System Settings → API Keys/);
    assert.match(steps[1].textContent, /separate secure fields/);
    assert.match(steps[2].textContent, /Load available voices.*Verify and save connection/);
    assert.equal(text(h.root, 'Open Retell to copy API access keys').href, 'https://dashboard.retellai.com/');
    assert.doesNotMatch(h.root.textContent, /Growth HQ then/);
  } finally { h.restore(); }
});

test('caller inventory uses only returned owned numbers and explicit verify saves the selected caller without dialing', async () => {
  const initial = { ...disconnected, verified: true, has_secret: true, has_webhook_secret: true, config: { voice_id: 'voice-a', from_number: '' } };
  const h = await harness({ initial, onWrite: async (path, request) => path.endsWith('/phone-numbers') ? numberList : { ...verified, config: { ...verified.config, from_number: request.body.from_number } } });
  try {
    assert.equal(field(h.root, 'from_number').tag, 'select');
    await text(h.root, 'Load my caller numbers').onclick();
    assert.equal(h.writes[0].path, '/api/agent-builder/connection/phone-numbers');
    assert.deepEqual(h.writes[0].body, {});
    assert.equal(typeof h.writes[0].guard, 'function');
    const options = all(field(h.root, 'from_number')).filter(node => node.tag === 'option');
    assert.deepEqual(options.map(node => node.value), ['', '+447700900123']);
    assert.equal(field(h.root, 'from_number').value, '');
    field(h.root, 'from_number').value = '+447700900123'; field(h.root, 'from_number').onchange();
    await submit(h.root);
    assert.deepEqual(h.writes[1].body, { voice_id: 'voice-a', from_number: '+447700900123' });
    assert.equal(field(h.root, 'from_number').value, '+447700900123');
    assert.ok(h.writes.every(write => /\/(phone-numbers|verify)$/.test(write.path)));
  } finally { h.restore(); }
});

test('arbitrary caller values are held instead of being forwarded for verification', async () => {
  const h = await harness({ initial: { ...disconnected, verified: true, has_secret: true, has_webhook_secret: true, config: { voice_id: 'voice-a' } } });
  try {
    field(h.root, 'from_number').value = '+447700900124';
    await submit(h.root);
    assert.deepEqual(h.writes, []);
    assert.match(find(h.root, node => node.className === 'provider-setup-notice').textContent, /Choose an owned caller number returned for this account/);
  } finally { h.restore(); }
});

test('an empty inventory explains the number requirement while private chat can still be verified with a blank caller', async () => {
  const initial = { ...disconnected, verified: true, has_secret: true, has_webhook_secret: true, config: { voice_id: 'voice-a' } };
  const h = await harness({ initial, onWrite: async path => path.endsWith('/phone-numbers') ? { ...numberList, phone_numbers: [] } : verified });
  try {
    await text(h.root, 'Load my caller numbers').onclick();
    const status = find(h.root, node => node.className === 'provider-setup-caller-status');
    assert.match(status.textContent, /No existing caller number found.*Private chat works without one.*separate owner approval/);
    assert.equal(field(h.root, 'from_number').value, '');
    await submit(h.root);
    assert.equal(h.writes[1].body.from_number, '');
    assert.ok(h.writes.every(write => !/create|purchase|call\//.test(write.path)));
  } finally { h.restore(); }
});

test('partial caller inventory is labelled as partial and does not imply it lists the full account', async () => {
  const h = await harness({ initial: { ...disconnected, has_secret: true }, onWrite: async () => ({ ...numberList, truncated: true }) });
  try {
    await text(h.root, 'Load my caller numbers').onclick();
    assert.match(find(h.root, node => node.className === 'provider-setup-caller-status').textContent, /partial list.*more numbers/);
  } finally { h.restore(); }
});

test('a saved verified caller remains selectable until deliberately changed and is never auto-replaced by inventory', async () => {
  const initial = { ...disconnected, verified: true, has_secret: true, has_webhook_secret: true, config: { voice_id: 'voice-a', from_number: '+447700900124' } };
  const h = await harness({ initial, onWrite: async () => numberList });
  try {
    assert.equal(field(h.root, 'from_number').value, '+447700900124');
    await text(h.root, 'Load my caller numbers').onclick();
    assert.equal(field(h.root, 'from_number').value, '+447700900124');
    assert.ok(all(field(h.root, 'from_number')).some(node => node.value === '+447700900123'));
    assert.ok(all(field(h.root, 'from_number')).some(node => node.value === '+447700900124'));
  } finally { h.restore(); }
});

test('changing API credentials invalidates old caller numbers and fences an inventory request awaiting CSRF', async () => {
  const wait = deferred();
  const h = await harness({ initial: { ...disconnected, has_secret: true }, onWrite: async () => wait.promise });
  try {
    const operation = text(h.root, 'Load my caller numbers').onclick();
    assert.equal(h.writes[0].guard(), true);
    field(h.root, 'secret').value = 'replacement-provider-key'; field(h.root, 'secret').oninput();
    assert.equal(h.writes[0].guard(), false);
    wait.resolve(numberList); await operation;
    assert.equal(field(h.root, 'from_number').value, '');
    assert.equal(all(field(h.root, 'from_number')).some(node => node.value === '+447700900123'), false);
    assert.equal(field(h.root, 'secret').value, 'replacement-provider-key');
  } finally { h.restore(); }
});

test('caller inventory is explicitly granted and cannot be read through voice-only permission', async () => {
  const h = await harness({ initial: { ...disconnected, has_secret: true }, options: { canConfigure: false, canListVoices: true } });
  try {
    const button = text(h.root, 'Load my caller numbers');
    assert.equal(button.disabled, true);
    await button.onclick();
    assert.deepEqual(h.writes, []);
  } finally { h.restore(); }
});

test('detaching a caller-inventory request clears credentials and cannot populate another installation', async () => {
  const wait = deferred(); const h = await harness({ onWrite: async () => wait.promise });
  try {
    field(h.root, 'secret').value = 'new-provider-api-secret'; field(h.root, 'webhook_secret').value = 'documented-webhook-key';
    const secret = field(h.root, 'secret'), webhook = field(h.root, 'webhook_secret');
    const operation = text(h.root, 'Load my caller numbers').onclick();
    h.root.isConnected = false; h.observers[0].callback();
    assert.equal(secret.value, ''); assert.equal(webhook.value, '');
    assert.equal(h.writes[0].guard(), false);
    wait.resolve(numberList); await operation;
    assert.equal(all(field(h.root, 'from_number')).some(node => node.value === '+447700900123'), false);
  } finally { h.restore(); }
});

test('a fresh second business has its own editable API setup without inheriting the first connection', async () => {
  const first = { ...disconnected, verified: true, has_secret: true, has_webhook_secret: true, config: { voice_id: 'voice-a', from_number: '+447700900123' } };
  const h = await harness({ initial: first });
  const secondWrites = [];
  try {
    assert.ok(text(h.root, 'Connected and verified'));
    const previousKey = field(h.root, 'secret'), previousWebhook = field(h.root, 'webhook_secret');
    previousKey.value = 'first-business-unsaved-key'; previousWebhook.value = 'first-business-unsaved-webhook';
    const secondApi = async (path, request) => {
      if (!request) return disconnected;
      secondWrites.push({ path, ...request }); return voiceList;
    };
    await mountProviderSetup(h.root, secondApi, { canRead: true, canConfigure: true });
    assert.equal(previousKey.value, ''); assert.equal(previousWebhook.value, '');
    assert.equal(text(h.root, 'Connected and verified'), undefined);
    assert.equal(field(h.root, 'secret').value, '');
    assert.equal(field(h.root, 'secret').disabled, false);
    assert.equal(field(h.root, 'webhook_secret').disabled, false);
    assert.equal(field(h.root, 'from_number').value, '');
    assert.equal(field(h.root, 'voice_id').value, '');
    assert.equal(text(h.root, 'Load available voices').disabled, false);
    assert.match(h.root.textContent, /saved per business.*never copies credentials.*scan and review its website first/);
    field(h.root, 'secret').value = 'second-business-api-key'; field(h.root, 'secret').oninput();
    await text(h.root, 'Load available voices').onclick();
    assert.equal(secondWrites.length, 1);
    assert.equal(secondWrites[0].path, '/api/agent-builder/connection/voices');
    assert.deepEqual(secondWrites[0].body, { secret: 'second-business-api-key' });
    assert.equal(field(h.root, 'voice_id').disabled, false);
    assert.deepEqual(h.writes, []);
  } finally { h.restore(); }
});
