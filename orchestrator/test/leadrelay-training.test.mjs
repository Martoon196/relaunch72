import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/integrations/leadrelay/agent-training.js', import.meta.url), 'utf8');
const { mountAgentTraining } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.value = ''; this.checked = false; this.disabled = false; this.attributes = {};
    this.isConnected = true; this.classes = new Set(); this.classList = { add: value => this.classes.add(value), toggle: (value, on) => on ? this.classes.add(value) : this.classes.delete(value) };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text || this.children.map(child => child.textContent).join(' '); }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.isConnected = false; this.children = []; this.text = ''; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  reportValidity() { return true; }
}
const all = node => [node, ...node.children.flatMap(all)];
const find = (root, predicate) => all(root).find(predicate);
const text = (root, value) => find(root, node => node.textContent === value);
const field = (root, name) => find(root, node => node.name === name);
const formFor = (root, name) => find(root, node => node.tag === 'form' && field(node, name));
const submit = form => form.onsubmit({ preventDefault() {} });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; };
const defaults = { objective: null, reply_length: 'existing', one_question: null, sales_guidance: false, signup_url: '', payment_url: '', instructions: '', business_capabilities: '', knowledge_ids: [], executable_tools: null };
const latestVersion = { id: 'version-base', status: 'published', business_name: 'Synthetic business', agent_name: 'Alex' };
const profileMetadata = (profile = defaults, extra = {}) => ({ profile: structuredClone(profile), saved: false, saved_at: null, profile_digest: 'a'.repeat(64), review_digest: 'b'.repeat(64), latest_version: latestVersion, published_version: latestVersion, applied_version_id: null,
  executable_tool_catalog: [
    { id: 'calendar_book', title: 'Reserve an agreed meeting', description: 'Reserve only after the configured calendar confirms it.', execution: 'calendar_function', requires: 'verified calendar access' },
    { id: 'offer_signup_link', title: 'Offer signup link', description: 'Offer the approved signup URL.', execution: 'approved_link', requires: 'approved signup URL' },
  ], approval_required: true, provider_publication_required: true, ...extra });
const readySource = { source_id: 'source-a', title: 'Synthetic facts', status: 'ready', approved: false, knowledge_id: 'knowledge-a', content: 'These are synthetic business facts for local tests only.', sha256: '1'.repeat(64), created_at: 123 };
const approvedSource = { ...readySource, source_id: 'source-b', knowledge_id: 'knowledge-b', title: 'Reviewed synthetic brand', status: 'reviewed', approved: true };

function globals() {
  const saved = { document: globalThis.document, MutationObserver: globalThis.MutationObserver, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, btoa: globalThis.btoa };
  const observers = [], timers = [];
  globalThis.document = { createElement: tag => new Element(tag), documentElement: new Element('html') };
  globalThis.MutationObserver = class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } };
  globalThis.setTimeout = callback => { timers.push(callback); return timers.length; };
  globalThis.clearTimeout = () => {};
  globalThis.btoa = value => Buffer.from(value, 'binary').toString('base64');
  return { observers, timers, restore: () => Object.assign(globalThis, saved) };
}
async function harness({ sources = [], metadata = profileMetadata(), options = {}, onWrite } = {}) {
  const env = globals(), root = new Element('root'), reads = [], writes = [];
  let sourceState = structuredClone(sources), profileState = structuredClone(metadata);
  const api = async (path, request) => {
    if (!request?.method || request.method === 'GET') {
      reads.push(path);
      if (path.endsWith('/sources')) return { sources: structuredClone(sourceState), outreach_started: false };
      if (path.endsWith('/profile')) return structuredClone(profileState);
      throw Error('Unexpected training read');
    }
    writes.push({ path, ...request });
    if (onWrite) return onWrite(path, request);
    if (path.endsWith('/profile')) {
      profileState = profileMetadata(request.body, { saved: true, saved_at: 123 }); return structuredClone(profileState);
    }
    if (path.endsWith('/approve')) return { version: { ...latestVersion, id: 'version-new', status: 'approved' }, draft_id: 'draft-new', outreach_started: false, published_version_unchanged: true, provider_publication_required: true };
    if (path.endsWith('/source-review')) return { source: { ...readySource, ...request.body, status: 'reviewed' }, outreach_started: false };
    if (path.endsWith('/source')) return { source: { ...readySource, title: request.body.title, content: request.body.content, category: request.body.category }, outreach_started: false };
    if (path.endsWith('/upload')) return { source: { source_id: 'file-source', filename: request.body.filename, title: request.body.filename, category: request.body.category, status: 'queued', approved: false, created_at: 123 }, outreach_started: false };
    throw Error('Unexpected training write');
  };
  const controller = await mountAgentTraining(root, api, { canRead: true, canTrain: true, ...options });
  return { ...env, root, reads, writes, api, controller, setSources: next => { sourceState = structuredClone(next); }, setMetadata: next => { profileState = structuredClone(next); } };
}

test('training access defaults denied and never fetches data or renders upload controls', async () => {
  const env = globals(), root = new Element('root'); let requested = false;
  try {
    await mountAgentTraining(root, async () => { requested = true; });
    assert.equal(requested, false); assert.match(root.textContent, /no training access/);
    assert.equal(field(root, 'training_file'), undefined);
    assert.equal(field(root, 'brand_guidelines_file'), undefined); assert.equal(field(root, 'brand_voice_file'), undefined);
  } finally { env.restore(); }
});

test('initial settings preserve the current agent and do not activate sales or tool presets', async () => {
  const h = await harness();
  try {
    assert.equal(field(h.root, 'objective').value, ''); assert.equal(field(h.root, 'reply_length').value, 'existing');
    assert.equal(field(h.root, 'one_question').value, ''); assert.equal(field(h.root, 'sales_guidance').checked, false);
    assert.equal(field(h.root, 'tool_mode').value, 'keep'); assert.equal(field(h.root, 'tool_calendar_book').disabled, true);
    assert.equal(field(h.root, 'tool_calendar_book').checked, false);
    assert.deepEqual(h.writes, []);
    assert.match(h.root.textContent, /Published agent: Synthetic business.*Existing agent settings will be kept/);
  } finally { h.restore(); }
});

test('read-only training roles cannot save drafts, approve versions or upload documents', async () => {
  const h = await harness({ options: { canTrain: false } });
  try {
    assert.equal(field(h.root, 'training_file'), undefined);
    assert.equal(field(h.root, 'brand_guidelines_file'), undefined); assert.equal(field(h.root, 'brand_voice_file'), undefined);
    assert.equal(field(h.root, 'objective').disabled, true);
    assert.equal(text(h.root, 'Save settings draft').disabled, true);
    field(h.root, 'objective').value = 'signup'; await submit(formFor(h.root, 'objective'));
    assert.deepEqual(h.writes, []);
  } finally { h.restore(); }
});

test('saving settings sends an exact draft without publishing, creating agents or placing calls', async () => {
  const h = await harness();
  try {
    field(h.root, 'reply_length').value = 'short'; field(h.root, 'reply_length').onchange();
    field(h.root, 'instructions').value = 'Ask one concise question and offer the approved next step.';
    await submit(formFor(h.root, 'objective'));
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].path, '/api/agent-builder/training/profile');
    assert.deepEqual(h.writes[0].body, { ...defaults, reply_length: 'short', instructions: 'Ask one concise question and offer the approved next step.' });
    assert.match(h.root.textContent, /Settings draft saved.*Your published agent is unchanged/);
    assert.ok(h.writes.every(request => !/publish|test-call|voice-apply/.test(request.path)));
  } finally { h.restore(); }
});

test('draft approval requires a saved reviewed digest and explicit confirmation, then creates an unpublished version', async () => {
  const h = await harness();
  try {
    const review = formFor(h.root, 'training_confirmed');
    field(review, 'training_confirmed').checked = true; await submit(review); assert.deepEqual(h.writes, []);
    await submit(formFor(h.root, 'objective'));
    field(review, 'training_confirmed').checked = false; await submit(review);
    assert.equal(h.writes.length, 1);
    field(review, 'training_confirmed').checked = true; await submit(review);
    assert.equal(h.writes.length, 2);
    assert.equal(h.writes[1].path, '/api/agent-builder/training/approve');
    assert.deepEqual(h.writes[1].body, { source_version_id: 'version-base', review_digest: 'b'.repeat(64), confirmation: 'APPROVE THIS TRAINING VERSION' });
    assert.match(h.root.textContent, /New training version approved.*published agent is unchanged/);
    assert.equal(text(h.root, 'Approve new training version').disabled, true);
    assert.ok(h.writes.every(request => !/publish|test-call/.test(request.path)));
  } finally { h.restore(); }
});

test('editing a saved draft disables approval until that new draft is saved again', async () => {
  const h = await harness({ metadata: profileMetadata(defaults, { saved: true }) });
  try {
    assert.equal(text(h.root, 'Approve new training version').disabled, false);
    field(h.root, 'instructions').value = 'New owner-edited instructions'; field(h.root, 'instructions').oninput();
    assert.equal(text(h.root, 'Approve new training version').disabled, true);
    field(h.root, 'training_confirmed').checked = true; await submit(formFor(h.root, 'training_confirmed'));
    assert.deepEqual(h.writes, []);
  } finally { h.restore(); }
});

test('only reviewed sources can be selected and text remains inert instead of becoming HTML', async () => {
  const unsafe = '<img src=x onerror=alert(1)>';
  const h = await harness({ sources: [{ ...readySource, title: unsafe, content: unsafe }, approvedSource] });
  try {
    assert.equal(field(h.root, 'knowledge_knowledge-a'), undefined);
    assert.ok(field(h.root, 'knowledge_knowledge-b'));
    assert.ok(text(h.root, unsafe)); assert.equal(all(h.root).filter(node => node.tag === 'img').length, 0);
    field(h.root, 'knowledge_knowledge-b').checked = true; field(h.root, 'knowledge_knowledge-b').onchange();
    await submit(formFor(h.root, 'objective'));
    assert.deepEqual(h.writes[0].body.knowledge_ids, ['knowledge-b']);
  } finally { h.restore(); }
});

test('a source must be explicitly reviewed before it becomes a selectable approved source', async () => {
  const h = await harness({ sources: [readySource] });
  try {
    await text(h.root, 'Review this source').onclick();
    const review = formFor(h.root, 'review_source_title');
    field(review, 'review_source_content').value = 'Owner-reviewed synthetic facts';
    await submit(review); assert.deepEqual(h.writes, []);
    field(review, 'source_reviewed').checked = true; await submit(review);
    assert.equal(h.writes[0].path, '/api/agent-builder/training/source-review');
    assert.deepEqual(h.writes[0].body, { source_id: 'source-a', title: 'Synthetic facts', content: 'Owner-reviewed synthetic facts', approved: true });
    assert.equal(field(h.root, 'knowledge_knowledge-a').checked, false);
    assert.match(h.root.textContent, /Source approved.*Select it/);
  } finally { h.restore(); }
});

test('refreshing sources preserves unsaved instructions and keeps the current draft unapproved', async () => {
  const h = await harness({ sources: [readySource] });
  try {
    const instructions = field(h.root, 'instructions'); instructions.value = 'Keep this owner edit'; instructions.oninput();
    h.setSources([approvedSource]); await text(h.root, 'Refresh sources').onclick();
    assert.equal(field(h.root, 'instructions'), instructions); assert.equal(instructions.value, 'Keep this owner edit');
    assert.equal(text(h.root, 'Approve new training version').disabled, true);
    assert.deepEqual(h.writes, []);
  } finally { h.restore(); }
});

test('descriptive business capabilities do not enable executable tools unless the owner explicitly selects them', async () => {
  const h = await harness();
  try {
    field(h.root, 'business_capabilities').value = 'Explain our signup service';
    await submit(formFor(h.root, 'objective'));
    assert.equal(h.writes[0].body.executable_tools, null);
    field(h.root, 'tool_mode').value = 'custom'; field(h.root, 'tool_mode').onchange();
    assert.equal(field(h.root, 'tool_offer_signup_link').disabled, false);
    field(h.root, 'tool_offer_signup_link').checked = true; field(h.root, 'tool_offer_signup_link').onchange();
    await submit(formFor(h.root, 'objective'));
    assert.deepEqual(h.writes[1].body.executable_tools, ['offer_signup_link']);
  } finally { h.restore(); }
});

test('oversize and unsupported training files are held before file reading or uploading', async () => {
  const h = await harness(); let reads = 0;
  try {
    for (const file of [{ name: 'large.pdf', size: 512 * 1024 + 1 }, { name: 'contact-list.csv', size: 20 }]) {
      field(h.root, 'training_file').files = [{ ...file, arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } }];
      await submit(formFor(h.root, 'training_file'));
    }
    assert.equal(reads, 0); assert.deepEqual(h.writes, []);
    assert.match(h.root.textContent, /no larger than 512 KB/);
  } finally { h.restore(); }
});

test('a business change during file reading clears the selection and cannot upload its document to the new business', async () => {
  const wait = deferred(); let current = true;
  const h = await harness({ options: { isCurrent: () => current } });
  try {
    const input = field(h.root, 'training_file');
    input.files = [{ name: 'brand.md', size: 5, arrayBuffer: async () => wait.promise }]; input.value = 'synthetic-selected-file';
    const pending = submit(formFor(h.root, 'training_file'));
    current = false; h.observers[0].callback();
    wait.resolve(Uint8Array.from([65, 66, 67, 68, 69]).buffer); await pending;
    assert.equal(input.value, ''); assert.deepEqual(h.writes, []);
  } finally { h.restore(); }
});

test('a pending upload uses only the captured file and never submits a different later file selection', async () => {
  const wait = deferred(); const h = await harness();
  try {
    const input = field(h.root, 'training_file');
    input.files = [{ name: 'first.md', size: 5, arrayBuffer: async () => wait.promise }];
    const pending = submit(formFor(h.root, 'training_file'));
    input.files = [{ name: 'second.md', size: 3, arrayBuffer: async () => new ArrayBuffer(3) }];
    wait.resolve(new ArrayBuffer(5)); await pending;
    assert.deepEqual(h.writes, []);
  } finally { h.restore(); }
});

test('document upload creates an extraction draft and does not approve or select its facts automatically', async () => {
  const h = await harness();
  try {
    const input = field(h.root, 'training_file');
    input.files = [{ name: 'brand.md', size: 3, arrayBuffer: async () => Uint8Array.from([65, 66, 67]).buffer }]; input.value = 'synthetic-selected-file';
    await submit(formFor(h.root, 'training_file'));
    assert.equal(h.writes.length, 1); assert.equal(h.writes[0].path, '/api/agent-builder/training/upload');
    assert.deepEqual(h.writes[0].body, { filename: 'brand.md', content_base64: 'QUJD', category: 'general' });
    assert.equal(typeof h.writes[0].guard, 'function');
    assert.equal(input.value, ''); assert.match(h.root.textContent, /Waiting for extraction/);
    assert.equal(field(h.root, 'knowledge_file-source'), undefined);
    assert.ok(h.writes.every(request => !/approve|publish|test-call/.test(request.path)));
  } finally { h.restore(); }
});

test('pending draft save freezes current controls and source selection and remains single flight', async () => {
  const wait = deferred(); const h = await harness({ sources: [approvedSource], onWrite: async () => wait.promise });
  try {
    const form = formFor(h.root, 'objective');
    field(h.root, 'instructions').value = 'Preserve this current draft'; field(h.root, 'instructions').oninput();
    const pending = submit(form); await submit(form);
    assert.equal(h.writes.length, 1);
    assert.equal(field(h.root, 'instructions').disabled, true);
    assert.equal(field(h.root, 'knowledge_knowledge-b').disabled, true);
    assert.equal(text(h.root, 'Save settings draft').disabled, true);
    wait.resolve(profileMetadata(h.writes[0].body, { saved: true })); await pending;
    assert.equal(field(h.root, 'instructions').disabled, false);
    assert.equal(field(h.root, 'instructions').value, 'Preserve this current draft');
    assert.equal(field(h.root, 'knowledge_knowledge-b').disabled, false);
  } finally { h.restore(); }
});

test('failed settings saves preserve owner edits and never mark them approved', async () => {
  const h = await harness({ onWrite: async () => { throw Error('Saved review context changed; check this draft'); } });
  try {
    field(h.root, 'instructions').value = 'Keep my instructions'; field(h.root, 'instructions').oninput();
    await submit(formFor(h.root, 'objective'));
    assert.equal(field(h.root, 'instructions').value, 'Keep my instructions');
    assert.equal(text(h.root, 'Approve new training version').disabled, true);
    assert.match(find(h.root, node => node.className === 'agent-training-notice').textContent, /review context changed/);
    assert.equal(find(h.root, node => node.className === 'agent-training-notice').attributes.role, 'alert');
  } finally { h.restore(); }
});

test('an existing sales brief enters instructions only after the owner explicitly chooses the draft action', async () => {
  const h = await harness({ metadata: profileMetadata(defaults, { legacy_sales_brief: 'Owner-authored legacy sales brief' }) });
  try {
    assert.equal(field(h.root, 'instructions').value, '');
    assert.deepEqual(h.writes, []);
    await text(h.root, 'Use existing sales brief as draft').onclick();
    assert.equal(field(h.root, 'instructions').value, 'Owner-authored legacy sales brief');
    assert.equal(text(h.root, 'Approve new training version').disabled, true);
    assert.deepEqual(h.writes, []);
  } finally { h.restore(); }
});

test('an overlength legacy sales brief is held without silent copying or truncation', async () => {
  const h = await harness({ metadata: profileMetadata(defaults, { legacy_sales_brief: 'x'.repeat(8001) }) });
  try {
    await text(h.root, 'Use existing sales brief as draft').onclick();
    assert.equal(field(h.root, 'instructions').value, '');
    assert.match(find(h.root, node => node.className === 'agent-training-notice').textContent, /nothing was copied or truncated/);
    assert.deepEqual(h.writes, []);
  } finally { h.restore(); }
});

test('business facts, brand guidelines and brand voice have separate upload areas without changing the audio voice', async () => {
  const h = await harness();
  try {
    const areas = all(h.root).filter(node => node.className === 'agent-training-upload-area');
    assert.equal(areas.length, 3);
    for (const [name, category] of [['training_file', 'general'], ['brand_guidelines_file', 'brand_guidelines'], ['brand_voice_file', 'brand_voice']]) {
      const form = formFor(h.root, name);
      assert.equal(form.attributes['data-source-category'], category);
      assert.equal(field(form, name).accept, '.txt,.md,.pdf,.docx');
      assert.equal(field(form, name).disabled, false);
    }
    assert.deepEqual(field(h.root, 'source_category').children.map(node => [node.value, node.textContent]), [['general', 'Business facts'], ['brand_guidelines', 'Brand guidelines'], ['brand_voice', 'Brand voice']]);
    assert.equal(field(h.root, 'source_category').value, 'general');
    assert.match(h.root.textContent, /does not change the audio voice/);
    assert.deepEqual(h.writes, []);
  } finally { h.restore(); }
});

test('pasted guidance carries only the owner-selected category and remains an unapproved draft', async () => {
  const h = await harness();
  try {
    for (const category of ['general', 'brand_guidelines', 'brand_voice']) {
      field(h.root, 'source_category').value = category;
      field(h.root, 'source_title').value = `Synthetic ${category}`;
      field(h.root, 'source_content').value = 'Reviewed later, never activated automatically.';
      await submit(formFor(h.root, 'source_title'));
      assert.equal(h.writes.at(-1).path, '/api/agent-builder/training/source');
      assert.deepEqual(h.writes.at(-1).body, { title: `Synthetic ${category}`, content: 'Reviewed later, never activated automatically.', category });
      assert.equal(field(h.root, 'knowledge_knowledge-a'), undefined);
    }
    assert.equal(h.writes.length, 3);
    assert.ok(h.writes.every(request => !/approve|publish|test-call|voice-apply/.test(request.path)));
  } finally { h.restore(); }
});

test('each upload posts its own fixed category and is not approved or selected automatically', async () => {
  const h = await harness();
  try {
    for (const [name, category] of [['training_file', 'general'], ['brand_guidelines_file', 'brand_guidelines'], ['brand_voice_file', 'brand_voice']]) {
      const input = field(h.root, name), filename = `${category}.md`;
      input.files = [{ name: filename, size: 3, arrayBuffer: async () => Uint8Array.from([65, 66, 67]).buffer }]; input.value = filename;
      await submit(formFor(h.root, name));
      assert.equal(h.writes.at(-1).path, '/api/agent-builder/training/upload');
      assert.deepEqual(h.writes.at(-1).body, { filename, content_base64: 'QUJD', category });
      assert.equal(input.value, ''); assert.equal(field(h.root, 'knowledge_file-source'), undefined);
    }
    assert.equal(h.writes.length, 3);
    assert.ok(h.writes.every(request => !/approve|publish|test-call|voice-apply/.test(request.path)));
  } finally { h.restore(); }
});

test('sources are grouped and approved choices identify their category while legacy sources stay under business facts', async () => {
  const sources = [
    { ...approvedSource, source_id: 'legacy', knowledge_id: 'legacy-knowledge', title: 'Legacy facts' },
    { ...approvedSource, source_id: 'guidelines', knowledge_id: 'guidelines-knowledge', title: 'Approved brand rules', category: 'brand_guidelines' },
    { ...approvedSource, source_id: 'voice', knowledge_id: 'voice-knowledge', title: 'Approved writing tone', category: 'brand_voice' },
  ];
  const h = await harness({ sources });
  try {
    for (const [category, title, knowledge, label] of [['general', 'Legacy facts', 'legacy-knowledge', 'Business facts'], ['brand_guidelines', 'Approved brand rules', 'guidelines-knowledge', 'Brand guidelines'], ['brand_voice', 'Approved writing tone', 'voice-knowledge', 'Brand voice']]) {
      const group = find(h.root, node => node.className === 'agent-training-source-group' && node.attributes['data-source-category'] === category);
      assert.ok(text(group, title));
      const choice = field(h.root, `knowledge_${knowledge}`);
      assert.equal(choice.checked, false);
      assert.equal(choice.parentElement.textContent.trim(), `${title} · ${label}`);
    }
    assert.deepEqual(h.writes, []);
  } finally { h.restore(); }
});

test('reviewing brand guidance preserves its category without adding category or activation fields to the review request', async () => {
  const source = { ...readySource, category: 'brand_guidelines' };
  const h = await harness({ sources: [source], onWrite: async (path, request) => ({ source: { ...source, ...request.body, status: 'reviewed' }, outreach_started: false }) });
  try {
    await text(h.root, 'Review this source').onclick();
    const review = formFor(h.root, 'review_source_title');
    field(review, 'source_reviewed').checked = true; await submit(review);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].path, '/api/agent-builder/training/source-review');
    assert.deepEqual(h.writes[0].body, { source_id: 'source-a', title: 'Synthetic facts', content: readySource.content, approved: true });
    const group = find(h.root, node => node.className === 'agent-training-source-group' && node.attributes['data-source-category'] === 'brand_guidelines');
    assert.ok(text(group, 'Synthetic facts'));
    assert.equal(field(h.root, 'knowledge_knowledge-a').checked, false);
    assert.equal(text(h.root, 'Approve new training version').disabled, true);
  } finally { h.restore(); }
});

test('a pending category upload freezes every upload area and cannot be redirected by another category submit', async () => {
  const wait = deferred(); const h = await harness();
  try {
    const voice = field(h.root, 'brand_voice_file');
    voice.files = [{ name: 'synthetic-voice.md', size: 3, arrayBuffer: async () => wait.promise }];
    const pending = submit(formFor(h.root, 'brand_voice_file'));
    for (const name of ['training_file', 'brand_guidelines_file', 'brand_voice_file', 'source_category']) assert.equal(field(h.root, name).disabled, true);
    const general = field(h.root, 'training_file');
    general.files = [{ name: 'other-facts.md', size: 3, arrayBuffer: async () => { throw Error('The other category must not start reading'); } }];
    await submit(formFor(h.root, 'training_file'));
    assert.deepEqual(h.writes, []);
    wait.resolve(Uint8Array.from([65, 66, 67]).buffer); await pending;
    assert.equal(h.writes.length, 1);
    assert.deepEqual(h.writes[0].body, { filename: 'synthetic-voice.md', content_base64: 'QUJD', category: 'brand_voice' });
    for (const name of ['training_file', 'brand_guidelines_file', 'brand_voice_file', 'source_category']) assert.equal(field(h.root, name).disabled, false);
  } finally { h.restore(); }
});

test('a business switch during brand-guidelines reading clears every selection and prevents upload', async () => {
  const wait = deferred(); let current = true; const h = await harness({ options: { isCurrent: () => current } });
  try {
    for (const name of ['training_file', 'brand_guidelines_file', 'brand_voice_file']) field(h.root, name).value = `synthetic-${name}`;
    field(h.root, 'brand_guidelines_file').files = [{ name: 'synthetic-rules.md', size: 3, arrayBuffer: async () => wait.promise }];
    const pending = submit(formFor(h.root, 'brand_guidelines_file'));
    current = false; h.observers[0].callback();
    wait.resolve(new ArrayBuffer(3)); await pending;
    for (const name of ['training_file', 'brand_guidelines_file', 'brand_voice_file']) assert.equal(field(h.root, name).value, '');
    assert.deepEqual(h.writes, []);
  } finally { h.restore(); }
});

test('detaching during brand-voice reading clears every selection and does not send the captured file', async () => {
  const wait = deferred(); const h = await harness();
  try {
    for (const name of ['training_file', 'brand_guidelines_file', 'brand_voice_file']) field(h.root, name).value = `synthetic-${name}`;
    field(h.root, 'brand_voice_file').files = [{ name: 'synthetic-tone.md', size: 3, arrayBuffer: async () => wait.promise }];
    const pending = submit(formFor(h.root, 'brand_voice_file'));
    h.root.isConnected = false; h.observers[0].callback();
    wait.resolve(new ArrayBuffer(3)); await pending;
    for (const name of ['training_file', 'brand_guidelines_file', 'brand_voice_file']) assert.equal(field(h.root, name).value, '');
    assert.deepEqual(h.writes, []);
  } finally { h.restore(); }
});
