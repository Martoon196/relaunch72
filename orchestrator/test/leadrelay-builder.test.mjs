import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/integrations/leadrelay/agent-builder.js', import.meta.url), 'utf8');
const { mountAgentBuilder } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

class Element {
  constructor(tag) {
    this.tag = tag;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.classList = { add() {} };
    this.isConnected = true;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.attributes = {};
    this.style = {};
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text || this.children.map(child => child.textContent).join(' '); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.text = ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
  reportValidity() { return true; }
  focus(options) { this.focused = true; this.focusOptions = options; }
  scrollIntoView(options) { this.scrollOptions = options; }
}
const all = node => [node, ...node.children.flatMap(all)];
const find = (node, predicate) => all(node).find(predicate);
const byText = (root, text) => find(root, node => node.textContent === text);
const input = (root, name) => find(root, node => node.name === name);
const formFor = (root, name) => find(root, node => node.tag === 'form' && input(node, name));
const submit = form => form.onsubmit({ preventDefault() {} });
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { resolve, reject, promise }; };
const readyDraft = { id: 'draft-a', status: 'ready', source_url: 'https://example.com/', pages: [{ url: 'https://example.com/', title: 'A business', content: 'Reviewed business facts.' }] };
const callReceipt = request => ({ queued: true, job_id: 'job-a', operation_id: request.body.request_id, status: 'queued', earliest_delay_seconds: 0, maximum_call_seconds: 180, paid_provider_usage: true, one_call_only: true });

async function harness(initial, onWrite = async () => ({})) {
  const saved = { document: globalThis.document, setTimeout: globalThis.setTimeout, scrollTo: globalThis.scrollTo, scrollX: globalThis.scrollX, scrollY: globalThis.scrollY };
  globalThis.document = { createElement: tag => new Element(tag) };
  const timers = [];
  globalThis.setTimeout = fn => { timers.push(fn); return timers.length; };
  const scrolls = [];
  globalThis.scrollTo = options => { scrolls.push(options); };
  let status = initial;
  const writes = [];
  const api = async (path, options) => {
    if (!options) return status;
    writes.push({ path, ...options });
    return onWrite(path, options);
  };
  const root = new Element('root');
  await mountAgentBuilder(root, api);
  return { root, api, writes, timers, scrolls, setStatus: next => { status = next; }, restore: () => Object.assign(globalThis, saved) };
}

test('ready website facts require explicit review and stay text, never HTML', async () => {
  const unsafe = '<img src=x onerror=alert(1)>';
  const draft = structuredClone(readyDraft);
  draft.pages[0].title = unsafe;
  draft.pages[0].content = unsafe;
  const h = await harness({ draft });
  try {
    const form = formFor(h.root, 'review_confirmed');
    await submit(form);
    assert.deepEqual(h.writes, []);
    assert.match(find(h.root, node => node.className === 'agent-builder-message').textContent, /Review and approve/);
    assert.equal(input(form, 'content_0').value, unsafe);
    assert.ok(byText(h.root, unsafe));
    assert.equal(all(h.root).filter(node => node.tag === 'img').length, 0);
    input(form, 'review_confirmed').checked = true;
    input(form, 'business_name').value = 'Business';
    input(form, 'agent_name').value = 'Alex';
    await submit(form);
    assert.equal(h.writes[0].path, '/api/agent-builder/approve');
    assert.deepEqual(h.writes[0].body, { draft_id: 'draft-a', business_name: 'Business', agent_name: 'Alex', review_confirmed: true, pages: [{ url: 'https://example.com/', title: unsafe, content: unsafe }] });
  } finally { h.restore(); }
});

test('pending scan submit is single and cannot replace a newly selected workspace UI', async () => {
  const pending = deferred();
  const h = await harness({}, async () => pending.promise);
  try {
    const oldForm = formFor(h.root, 'url');
    input(oldForm, 'url').value = 'https://business-a.example/';
    const operation = submit(oldForm);
    await submit(oldForm);
    assert.equal(h.writes.length, 1);
    h.setStatus({ business_name: 'Business B' });
    await mountAgentBuilder(h.root, h.api);
    const currentForm = formFor(h.root, 'url');
    input(currentForm, 'url').value = 'https://business-b.example/';
    pending.resolve({ draft: readyDraft });
    await operation;
    assert.equal(formFor(h.root, 'url'), currentForm);
    assert.equal(input(currentForm, 'url').value, 'https://business-b.example/');
    assert.equal(h.writes[0].body.url, 'https://business-a.example/');
  } finally { h.restore(); }
});

test('approval shows a persistent saved result and keeps submitted edited facts read-only without jumping', async () => {
  const version = { id: 'approved-a', draft_id: 'draft-a', status: 'approved', business_name: 'Reviewed name', agent_name: 'Sam' };
  const requirements = [{ id: 'retell', title: 'Retell verified', complete: false }];
  let h;
  h = await harness({ draft: readyDraft, requirements }, async () => {
    h.setStatus({ draft: readyDraft, version, requirements });
    return { version, outreach_started: false };
  });
  try {
    const form = formFor(h.root, 'review_confirmed');
    input(form, 'review_confirmed').checked = true;
    input(form, 'business_name').value = 'Reviewed name';
    input(form, 'agent_name').value = 'Sam';
    input(form, 'content_0').value = 'Corrected business facts';
    globalThis.scrollY = 1450;
    globalThis.scrollX = 0;
    await submit(form);
    const saved = find(h.root, node => node.className === 'helper agent-builder-approved');
    assert.match(saved.textContent, /Website facts saved and approved.*Reviewed name.*Sam/);
    assert.equal(saved.focused, true);
    assert.equal(saved.scrollOptions, undefined);
    assert.deepEqual(saved.focusOptions, { preventScroll: true });
    assert.deepEqual(h.scrolls.at(-1), { top: 1450, left: 0, behavior: 'instant' });
    assert.equal(formFor(h.root, 'review_confirmed'), undefined);
    assert.equal(input(h.root, 'saved_content_0').value, 'Corrected business facts');
    assert.equal(input(h.root, 'saved_content_0').readOnly, true);
    assert.equal(input(h.root, 'saved_business_name').value, 'Reviewed name');
    assert.doesNotMatch(saved.textContent, /Reviewed business facts\./);
    assert.match(saved.textContent, /connect Retell/);
    assert.equal(byText(h.root, 'Create my chat and call agents').disabled, true);
    await mountAgentBuilder(h.root, h.api);
    assert.ok(byText(h.root, 'Website facts saved and approved'));
    assert.equal(input(h.root, 'saved_content_0'), undefined);
    assert.equal(formFor(h.root, 'review_confirmed'), undefined);
    assert.equal(h.writes.length, 1);
  } finally { h.restore(); }
});

test('approval pending and failure stay beside the form and preserve typed facts', async () => {
  const pending = deferred();
  const h = await harness({ draft: readyDraft }, () => pending.promise);
  try {
    const form = formFor(h.root, 'review_confirmed');
    input(form, 'review_confirmed').checked = true;
    input(form, 'business_name').value = 'Typed name';
    input(form, 'content_0').value = 'Facts edited before saving';
    const operation = submit(form);
    const feedback = find(form, node => node.className === 'agent-builder-form-message');
    assert.match(feedback.textContent, /Saving your approved/);
    assert.equal(feedback.hidden, false);
    assert.equal(byText(form, 'Approve a shared knowledge version').disabled, true);
    await submit(form);
    assert.equal(h.writes.length, 1);
    pending.reject(Error('Approval could not be saved; try again'));
    await operation;
    assert.equal(formFor(h.root, 'review_confirmed'), form);
    assert.equal(input(form, 'business_name').value, 'Typed name');
    assert.equal(input(form, 'content_0').value, 'Facts edited before saving');
    assert.equal(feedback.attributes.role, 'alert');
    assert.match(feedback.textContent, /could not be saved/);
    assert.equal(feedback.focused, true);
    assert.equal(feedback.scrollOptions, undefined);
    assert.deepEqual(feedback.focusOptions, { preventScroll: true });
    assert.equal(byText(form, 'Approve a shared knowledge version').disabled, false);
  } finally { h.restore(); }
});

test('a delayed approval result cannot replace a different installation selection', async () => {
  const pending = deferred();
  const h = await harness({ draft: readyDraft }, () => pending.promise);
  try {
    const form = formFor(h.root, 'review_confirmed');
    input(form, 'review_confirmed').checked = true;
    const operation = submit(form);
    h.setStatus({ draft: { ...readyDraft, id: 'draft-b' }, business_name: 'Business B' });
    await mountAgentBuilder(h.root, h.api);
    const currentForm = formFor(h.root, 'review_confirmed');
    input(currentForm, 'business_name').value = 'Business B changed';
    pending.resolve({ version: { id: 'approved-a' } });
    await operation;
    assert.equal(formFor(h.root, 'review_confirmed'), currentForm);
    assert.equal(input(currentForm, 'business_name').value, 'Business B changed');
    assert.equal(byText(h.root, 'Website facts saved and approved'), undefined);
  } finally { h.restore(); }
});

test('same-installation refresh retains the form layout while status loads', async () => {
  const h = await harness({ draft: readyDraft });
  try {
    const currentForm = formFor(h.root, 'review_confirmed');
    const pending = deferred();
    h.setStatus(pending.promise);
    const operation = byText(h.root, 'Refresh status').onclick();
    assert.equal(formFor(h.root, 'review_confirmed'), currentForm);
    pending.resolve({ draft: readyDraft });
    await operation;
    assert.ok(formFor(h.root, 'review_confirmed'));
  } finally { h.restore(); }
});

test('a failed status refresh preserves form layout and edits with a visible retry path', async () => {
  const h = await harness({ draft: readyDraft });
  try {
    const form = formFor(h.root, 'review_confirmed');
    input(form, 'content_0').value = 'Facts to preserve during a failed read';
    const pending = deferred();
    h.setStatus(pending.promise);
    const operation = byText(h.root, 'Refresh status').onclick();
    pending.reject(Error('Status service unavailable'));
    await operation;
    assert.equal(formFor(h.root, 'review_confirmed'), form);
    assert.equal(input(form, 'content_0').value, 'Facts to preserve during a failed read');
    assert.equal(input(form, 'content_0').disabled, true);
    const message = find(h.root, node => node.className === 'agent-builder-message');
    assert.equal(message.attributes.role, 'alert');
    assert.equal(message.attributes['data-error'], 'true');
    assert.match(message.textContent, /displayed facts are preserved/);
    h.setStatus({ draft: readyDraft });
    await byText(h.root, 'Refresh status').onclick();
    assert.equal(input(formFor(h.root, 'review_confirmed'), 'content_0').disabled, false);
  } finally { h.restore(); }
});

test('unconnected provider has explicit API setup instructions without preventing review', async () => {
  const h = await harness({ draft: readyDraft, website: 'https://business.example/', requirements: [{ id: 'retell', complete: false }] });
  try {
    assert.ok(formFor(h.root, 'review_confirmed'));
    const setup = find(h.root, node => node.className === 'helper amber agent-builder-provider-setup');
    assert.match(setup.textContent, /Website scanning and approval need no provider account/);
    assert.match(setup.textContent, /this app creates and configures the chat and call agents/);
    assert.equal(byText(setup, 'Retell account / one-time API access →').href, 'https://dashboard.retellai.com');
    assert.equal(byText(setup, 'Connect Retell here →').href, '#live');
    h.setStatus({ website: 'https://business.example/' });
    await mountAgentBuilder(h.root, h.api);
    assert.equal(input(h.root, 'url').value, 'https://business.example/');
  } finally { h.restore(); }
});

test('completed module badges distinguish saved setup from an actual verified private chat response', async () => {
  const version = { id: 'version-a', draft_id: 'draft-a', status: 'published', business_name: 'Business', agent_name: 'Sam' };
  const h = await harness({ draft: readyDraft, version, deployment: { version_id: 'version-a' } }, async () => ({ ai_generated: true, reply: 'An actual provider reply', chat_id: 'chat-a' }));
  const section = title => find(h.root, node => node.tag === 'section' && byText(node, title));
  try {
    assert.equal(section('Scan your website').attributes['data-complete'], 'true');
    assert.equal(section('Review your business knowledge').attributes['data-complete'], 'true');
    assert.equal(section('Create chat and voice agents').attributes['data-complete'], 'true');
    assert.equal(section('Deploy when you are ready').attributes['data-complete'], 'true');
    assert.equal(section('Test your agent').attributes['data-complete'], undefined);
    const form = formFor(h.root, 'message');
    input(form, 'message').value = 'What do you do?';
    await submit(form);
    assert.equal(section('Test your agent').attributes['data-complete'], 'true');
    assert.ok(byText(section('Test your agent'), 'Private chat verified'));
  } finally { h.restore(); }
});

test('queued provider creation polls status without reposting and stops on detached UI', async () => {
  const h = await harness({ version: { id: 'version-a', status: 'queued' } });
  try {
    assert.equal(h.timers.length, 1);
    assert.equal(byText(h.root, 'Create my chat and call agents'), undefined);
    h.root.isConnected = false;
    h.timers[0]();
    assert.deepEqual(h.writes, []);
    assert.match(find(h.root, node => node.className === 'agent-builder-message').textContent, /queued or processing/);
  } finally { h.restore(); }
});

test('chat accepts only an actual AI provider response and binds immutable version', async () => {
  const h = await harness({ version: { id: 'version-a', status: 'published' }, pilot_ready: true }, async () => ({ reply: 'A fixture answer', ai_generated: false }));
  try {
    const form = formFor(h.root, 'message');
    input(form, 'message').value = 'What do you do?';
    await submit(form);
    assert.deepEqual(h.writes[0].body, { version_id: 'version-a', message: 'What do you do?', request_id: h.writes[0].body.request_id });
    assert.match(h.writes[0].body.request_id, /^[a-f0-9-]{36}$/);
    assert.equal(find(h.root, node => node.className === 'agent-builder-chat').children.length, 0);
    assert.match(find(h.root, node => node.className === 'agent-builder-message').textContent, /verified AI chat reply/);
  } finally { h.restore(); }
});

test('queued chat polls the same operation without repeating the user message', async () => {
  let requests = 0;
  const h = await harness({ version: { id: 'version-a', status: 'published' } }, async () => {
    requests++;
    return requests === 1 ? { chat_id: 'chat-a', status: 'queued', queued: true } : { chat_id: 'chat-a', status: 'ready', reply: 'Actual provider reply', ai_generated: true };
  });
  try {
    const form = formFor(h.root, 'message');
    input(form, 'message').value = 'What do you do?';
    const operation = submit(form);
    await new Promise(setImmediate);
    assert.equal(h.timers.length, 1);
    assert.equal(input(form, 'message').disabled, true);
    h.timers[0]();
    await operation;
    const requestId = h.writes[0].body.request_id;
    assert.deepEqual(h.writes.map(write => write.body), [
      { version_id: 'version-a', message: 'What do you do?', request_id: requestId },
      { version_id: 'version-a', chat_id: 'chat-a', request_id: requestId },
    ]);
    assert.match(find(h.root, node => node.className === 'agent-builder-chat').textContent, /Actual provider reply/);
    assert.equal(input(form, 'message').disabled, false);
  } finally { h.restore(); }
});

test('uncertain chat retry checks the prior turn and never sends a fresh message', async () => {
  let requests = 0;
  const h = await harness({ version: { id: 'version-a', status: 'published' } }, async () => {
    requests++;
    return requests === 1 ? { chat_id: 'chat-a', status: 'uncertain' } : { chat_id: 'chat-a', status: 'ready', reply: 'Recovered provider reply', ai_generated: true };
  });
  try {
    const form = formFor(h.root, 'message');
    input(form, 'message').value = 'First question';
    await submit(form);
    input(form, 'message').value = 'Must not send this';
    await submit(form);
    assert.deepEqual(h.writes[1].body, { version_id: 'version-a', chat_id: 'chat-a', request_id: h.writes[0].body.request_id });
    assert.match(find(h.root, node => node.className === 'agent-builder-chat').textContent, /You: First question/);
    assert.doesNotMatch(find(h.root, node => node.className === 'agent-builder-chat').textContent, /Must not send this/);
  } finally { h.restore(); }
});

test('lost initial chat response is recovered with the same request ID and original message', async () => {
  let requests = 0;
  const h = await harness({ version: { id: 'version-a', status: 'published' } }, async () => {
    requests++;
    if (requests === 1) throw Error('Response lost after queue acceptance');
    return { chat_id: 'chat-a', status: 'ready', reply: 'Recovered provider reply', ai_generated: true };
  });
  try {
    const form = formFor(h.root, 'message');
    input(form, 'message').value = 'First question';
    await submit(form);
    const firstBody = structuredClone(h.writes[0].body);
    input(form, 'message').value = 'Do not send a new question';
    await submit(form);
    assert.deepEqual(h.writes[1].body, firstBody);
    assert.match(find(h.root, node => node.className === 'agent-builder-chat').textContent, /You: First question/);
    input(form, 'message').value = 'Second confirmed question';
    await submit(form);
    assert.notEqual(h.writes[2].body.request_id, firstBody.request_id);
    assert.equal(h.writes[2].body.message, 'Second confirmed question');
  } finally { h.restore(); }
});

test('Call me is first and works from server-owned readiness without an optional chat or settings journey', async () => {
  const h = await harness({ version: { id: 'version-a', status: 'published' }, call_me_ready: true, pilot_ready: false }, async (_path, request) => callReceipt(request));
  try {
    const section = find(h.root, node => node.tag === 'section' && byText(node, 'Test your agent'));
    const callForm = formFor(section, 'own_contact_confirmed');
    const chatForm = formFor(section, 'message');
    assert.ok(section.children.indexOf(callForm) < section.children.indexOf(chatForm));
    assert.ok(byText(section, 'Optional private chat'));
    assert.match(section.textContent, /Private chat is optional and can be skipped/);
    assert.equal(input(chatForm, 'message').value, '');
    assert.equal(byText(callForm, 'Call me').disabled, false);
    assert.match(section.textContent, /new-enquiry follow-up still waits at least two minutes/);
    assert.equal(byText(section, 'Review the configured own number and permissions →'), undefined);
    input(callForm, 'own_contact_confirmed').checked = true;
    input(callForm, 'ai_call_consent').checked = true;
    await submit(callForm);
    assert.deepEqual(h.writes.map(write => write.path), ['/api/agent-builder/test-call']);
    assert.equal(input(chatForm, 'message').value, '');
    assert.equal(find(section, node => node.className === 'agent-builder-chat').children.length, 0);
  } finally { h.restore(); }
});

test('paid Call me request cannot post before both explicit own-contact and AI permissions', async () => {
  const h = await harness({ version: { id: 'version-a', status: 'published' }, call_me_ready: true }, async (_path, request) => callReceipt(request));
  try {
    const form = formFor(h.root, 'own_contact_confirmed');
    await submit(form);
    assert.deepEqual(h.writes, []);
    input(form, 'own_contact_confirmed').checked = true;
    input(form, 'ai_call_consent').checked = true;
    await submit(form);
    assert.deepEqual(h.writes[0].body, { version_id: 'version-a', own_contact_confirmed: true, ai_call_consent: true, confirmation: 'PLACE ONE PAID TEST CALL TO MY OWN NUMBER', mode: 'call_me', request_id: h.writes[0].body.request_id });
    assert.match(h.writes[0].body.request_id, /^[a-f0-9-]{36}$/);
    assert.match(find(h.root, node => node.className === 'agent-builder-message').textContent, /queued.*not proof/);
  } finally { h.restore(); }
});

test('Call me holds when authoritative readiness is absent or a verified caller/contact prerequisite is blocked', async () => {
  for (const state of [{ pilot_ready: true }, { call_me_ready: false, call_me_blocker: 'Verify the saved owned caller first' }]) {
    const h = await harness({ version: { id: 'version-a', status: 'published' }, ...state });
    try {
      const form = formFor(h.root, 'own_contact_confirmed');
      assert.equal(byText(form, 'Call me').disabled, true);
      input(form, 'own_contact_confirmed').checked = true; input(form, 'ai_call_consent').checked = true;
      await submit(form); assert.deepEqual(h.writes, []);
      if (state.call_me_blocker) assert.ok(byText(h.root, state.call_me_blocker));
    } finally { h.restore(); }
  }
});

test('a lost Call me response retains one stable request ID for checking instead of creating another call intent', async () => {
  let requests = 0;
  const h = await harness({ version: { id: 'version-a', status: 'published' }, call_me_ready: true }, async (_path, request) => {
    if (++requests === 1) throw Error('Call request response was lost');
    return callReceipt(request);
  });
  try {
    const form = formFor(h.root, 'own_contact_confirmed');
    input(form, 'own_contact_confirmed').checked = true; input(form, 'ai_call_consent').checked = true;
    await submit(form);
    const original = h.writes[0].body;
    assert.ok(byText(form, 'Check this call request'));
    assert.equal(input(form, 'own_contact_confirmed').disabled, true);
    assert.equal(input(form, 'ai_call_consent').disabled, true);
    await submit(form);
    assert.deepEqual(h.writes[1].body, original);
    assert.equal(h.writes[1].body.mode, 'call_me');
    assert.match(find(h.root, node => node.className === 'agent-builder-message').textContent, /One call requested/);
  } finally { h.restore(); }
});

test('pending Call me is single flight and a different mounted business cannot receive its result', async () => {
  const wait = deferred();
  const h = await harness({ version: { id: 'version-a', status: 'published' }, call_me_ready: true }, async () => wait.promise);
  try {
    const form = formFor(h.root, 'own_contact_confirmed');
    input(form, 'own_contact_confirmed').checked = true; input(form, 'ai_call_consent').checked = true;
    const pending = submit(form); await submit(form);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].guard(), true);
    h.setStatus({ business_name: 'Another business' }); await mountAgentBuilder(h.root, h.api);
    assert.equal(h.writes[0].guard(), false);
    wait.resolve(callReceipt(h.writes[0])); await pending;
    assert.equal(find(h.root, node => node.className === 'agent-builder-message').textContent, '');
  } finally { h.restore(); }
});

test('Call me does not present an unbound or non-one-shot receipt as a successful request', async () => {
  const h = await harness({ version: { id: 'version-a', status: 'published' }, call_me_ready: true }, async (_path, request) => ({ ...callReceipt(request), operation_id: 'different-operation' }));
  try {
    const form = formFor(h.root, 'own_contact_confirmed');
    input(form, 'own_contact_confirmed').checked = true; input(form, 'ai_call_consent').checked = true;
    await submit(form);
    assert.match(find(h.root, node => node.className === 'agent-builder-message').textContent, /did not confirm this one-call request/);
    const section = find(h.root, node => node.tag === 'section' && byText(node, 'Test your agent'));
    assert.equal(section.attributes['data-complete'], undefined);
  } finally { h.restore(); }
});

test('an authoritative expired Call me receipt without a job is shown as cancelled without queueing another intent', async () => {
  const h = await harness({ version: { id: 'version-a', status: 'published' }, call_me_ready: true }, async (_path, request) => {
    const result = { ...callReceipt(request), status: 'cancelled', queued: false }; delete result.job_id; return result;
  });
  try {
    const form = formFor(h.root, 'own_contact_confirmed');
    input(form, 'own_contact_confirmed').checked = true; input(form, 'ai_call_consent').checked = true;
    await submit(form);
    assert.match(find(h.root, node => node.className === 'agent-builder-message').textContent, /cancelled before a call was queued/);
    await submit(form);
    assert.equal(h.writes[1].body.request_id, h.writes[0].body.request_id);
  } finally { h.restore(); }
});

test('public AI chat activation is a separate explicit deployment with reviewed origins', async () => {
  const h = await harness({ version: { id: 'version-a', status: 'published' }, deployment: { origins: ['https://example.com'], chat_enabled: false } }, async () => ({ public_chat_enabled: true, widget_script: '<script src="https://leadrelay.example/widget.js"></script>' }));
  try {
    const form = formFor(h.root, 'origins');
    assert.equal(input(form, 'public_chat_enabled').checked, false);
    await submit(form);
    assert.deepEqual(h.writes, []);
    input(form, 'public_chat_enabled').checked = true;
    input(form, 'deploy_confirmed').checked = true;
    await submit(form);
    assert.deepEqual(h.writes[0].body, { version_id: 'version-a', public_chat_enabled: true, origins: ['https://example.com'], confirmation: 'DEPLOY THIS APPROVED AGENT VERSION' });
    assert.match(find(h.root, node => node.className === 'code agent-builder-embed').textContent, /^<script/);
    assert.equal(all(h.root).filter(node => node.tag === 'script').length, 0);
  } finally { h.restore(); }
});

test('unsafe source addresses are not converted to executable links', async () => {
  const draft = structuredClone(readyDraft);
  draft.pages[0].url = 'javascript:alert(1)';
  const h = await harness({ draft });
  try {
    assert.ok(byText(h.root, 'Source address unavailable'));
    assert.equal(all(h.root).filter(node => node.href?.startsWith('javascript:')).length, 0);
  } finally { h.restore(); }
});

test('HQ embedding can provide real LeadRelay section URLs without hash navigation into HQ', async () => {
  const h = await harness({});
  try {
    await mountAgentBuilder(h.root, h.api, { sectionUrl: section => `https://leadrelay.example/#${section}` });
    assert.equal(byText(h.root, 'Secure connections →').href, 'https://leadrelay.example/#live');
    assert.equal(byText(h.root, 'Manage existing approved knowledge →').href, 'https://leadrelay.example/#knowledge');
  } finally { h.restore(); }
});

test('native connection callback opens setup without links or replacing the current edited review', async () => {
  const h = await harness({ draft: readyDraft, requirements: [{ id: 'retell', complete: false }] });
  let calls = 0, guard;
  try {
    await mountAgentBuilder(h.root, h.api, { onOpenConnections: options => { calls++; guard = options.isCurrent; } });
    input(h.root, 'content_0').value = 'Keep these unsaved edits';
    const review = formFor(h.root, 'review_confirmed');
    const connect = byText(h.root, 'Connect Retell here →');
    assert.equal(connect.tag, 'button'); assert.equal(connect.href, undefined);
    await connect.onclick({ preventDefault() {} });
    assert.equal(calls, 1); assert.equal(guard(), true);
    assert.equal(formFor(h.root, 'review_confirmed'), review);
    assert.equal(input(h.root, 'content_0').value, 'Keep these unsaved edits');
    assert.deepEqual(h.writes, []);
  } finally { h.restore(); }
});

test('native connection failures preserve review edits and show feedback beside the current view', async () => {
  const h = await harness({ draft: readyDraft });
  try {
    await mountAgentBuilder(h.root, h.api, { onOpenConnections: async () => { throw Error('Connection access needs review'); } });
    input(h.root, 'content_0').value = 'Preserve this review';
    const connect = byText(h.root, 'Secure connections →');
    await connect.onclick();
    assert.equal(input(h.root, 'content_0').value, 'Preserve this review');
    assert.match(find(h.root, node => node.className === 'agent-builder-message').textContent, /Connection access needs review/);
    assert.equal(find(h.root, node => node.className === 'agent-builder-message').attributes['data-error'], 'true');
    assert.equal(connect.disabled, false);
  } finally { h.restore(); }
});

test('pending native connection opens are single and cannot alter a newly selected or detached view', async () => {
  const wait = deferred(); const h = await harness({});
  let calls = 0, guard;
  try {
    await mountAgentBuilder(h.root, h.api, { onOpenConnections: async options => { calls++; guard = options.isCurrent; return wait.promise; } });
    const connect = byText(h.root, 'Secure connections →');
    const operation = connect.onclick(); await connect.onclick();
    assert.equal(calls, 1); assert.equal(connect.disabled, true);
    await mountAgentBuilder(h.root, h.api, { onOpenConnections: async () => { calls++; } });
    assert.equal(guard(), false);
    wait.reject(Error('Old connection request failed')); await operation;
    assert.equal(find(h.root, node => node.className === 'agent-builder-message').textContent, '');
    h.root.isConnected = false;
    await byText(h.root, 'Secure connections →').onclick();
    assert.equal(calls, 1);
  } finally { h.restore(); }
});


test('Agent settings opens the guarded native callback and preserves edited builder facts', async () => {
  const h = await harness({ draft: readyDraft }); let calls = 0, guard;
  try {
    await mountAgentBuilder(h.root, h.api, { onOpenSettings: context => { calls++; guard = context.isCurrent; } });
    input(h.root, 'content_0').value = 'Keep this unsaved review';
    const settings = byText(h.root, 'Agent settings →');
    assert.equal(settings.tag, 'button'); assert.equal(settings.href, undefined);
    await settings.onclick(); assert.equal(calls, 1); assert.equal(guard(), true);
    assert.equal(input(h.root, 'content_0').value, 'Keep this unsaved review'); assert.deepEqual(h.writes, []);
    h.root.isConnected = false; assert.equal(guard(), false); await settings.onclick(); assert.equal(calls, 1);
  } finally { h.restore(); }
});

test('standalone builder links directly to the local Agent settings view', async () => {
  const h = await harness({});
  try { assert.equal(byText(h.root, 'Agent settings →').href, '#agent-settings'); }
  finally { h.restore(); }
});
