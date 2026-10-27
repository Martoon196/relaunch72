/* Business-owned training drafts. Saving and reviewing never publishes an AI. */
const mounts = new WeakMap();
const el = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  return node;
};

export async function mountAgentTraining(root, api, options = {}) {
  mounts.get(root)?.dispose();
  const token = {}, timers = new Set();
  const fileInputs = new Set();
  let observer;
  const dispose = () => {
    for (const input of fileInputs) input.value = '';
    for (const timer of timers) clearTimeout(timer);
    observer?.disconnect();
    if (mounts.get(root)?.token === token) mounts.delete(root);
  };
  mounts.set(root, { token, dispose });
  const active = () => {
    let current = false;
    try { current = options.isCurrent?.() !== false; } catch { /* Lost selection holds requests. */ }
    current = current && mounts.get(root)?.token === token && root.isConnected !== false;
    if (!current) for (const input of fileInputs) input.value = '';
    return current;
  };
  if (typeof MutationObserver === 'function' && document.documentElement) {
    observer = new MutationObserver(() => { if (!active()) dispose(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  root.classList.add('agent-training');
  const heading = el('div'); heading.className = 'page-head';
  const title = el('div'); title.append(el('h1', 'Agent training and settings'), el('p', 'Choose what this business’s agent knows, how it replies and the next step it should offer.'));
  heading.append(title);
  const notice = el('p'); notice.className = 'agent-training-notice'; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  root.replaceChildren(heading, notice);
  let lastMessageError = false, lastMessagePending = false;
  const message = (text, error = false, pending = false) => {
    lastMessageError = error; lastMessagePending = pending;
    notice.textContent = text; notice.setAttribute('role', error ? 'alert' : 'status');
    notice.setAttribute('data-error', error ? 'true' : 'false');
    notice.setAttribute('data-state', error ? 'error' : pending ? 'working' : 'success');
  };
  if (options.canRead !== true) { message('Your role has no training access for this business.'); return { dispose }; }
  const canTrain = options.canTrain === true;
  let sourceResponse, profileResponse;
  try {
    [sourceResponse, profileResponse] = await Promise.all([
      api('/api/agent-builder/training/sources', { guard: active }),
      api('/api/agent-builder/training/profile', { guard: active }),
    ]);
  } catch (error) {
    if (active()) message(error.message || 'Training settings could not be loaded. Reopen this page to check again.', true);
    return { dispose };
  }
  if (!active()) return { dispose };
  if (!Array.isArray(sourceResponse.sources) || !profileResponse.profile || !Array.isArray(profileResponse.executable_tool_catalog)) {
    message('The server did not return the training settings. Reopen this page before making changes.', true);
    return { dispose };
  }
  let sources = sourceResponse.sources, savedProfile = profileResponse.profile;
  let saved = profileResponse.saved === true, savedAt = profileResponse.saved_at;
  let latestVersion = profileResponse.latest_version, publishedVersion = profileResponse.published_version;
  let approvalCurrent = profileResponse.approval_current === true, trainingPublished = profileResponse.training_published === true;
  let approvedVersionId = profileResponse.approved_version_id, approvedVersionStatus = profileResponse.approved_version_status;
  let reviewDigest = profileResponse.review_digest, approvalBlocker = profileResponse.approval_blocker;
  let dirty = false, busy = false, approvedHere = false, sourcePolling = false, sourceRead = 0;
  let pollDeadline = Date.now() + 90000;
  const sourceInputs = new Set(), sourceButtons = new Set();
  const chosenKnowledge = new Set(savedProfile.knowledge_ids || []), widgets = [];
  const catalog = profileResponse.executable_tool_catalog;
  function track(node, disabled = () => false) { widgets.push({ node, disabled }); return node; }
  function card(name, description) {
    const section = el('section'); section.className = 'card agent-training-card';
    section.append(el('h2', name), el('p', description)); root.append(section); return section;
  }
  function field(parent, name, label, type = 'text', value = '', maximum) {
    const wrapper = el('label'); wrapper.className = type === 'checkbox' ? 'check' : 'field';
    const input = el(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') input.type = type;
    input.name = name; input.value = value;
    if (maximum) input.maxLength = maximum;
    if (type === 'checkbox') wrapper.append(input, el('span', label));
    else wrapper.append(el('span', label), input);
    parent.append(wrapper); track(input); return input;
  }
  function select(parent, name, label, items, value = '') {
    const wrapper = el('label'); wrapper.className = 'field';
    const input = el('select'); input.name = name;
    for (const [id, text] of items) { const option = el('option', text); option.value = id; input.append(option); }
    input.value = value; wrapper.append(el('span', label), input); parent.append(wrapper); track(input); return input;
  }
  function action(label, callback) {
    const button = el('button', label); button.type = 'button'; button.className = 'btn';
    let opening = false;
    button.onclick = async () => {
      if (!active() || opening) return;
      opening = true; button.disabled = true;
      try { await callback({ isCurrent: active }); }
      catch (error) { if (active()) message(error.message || 'That page could not be opened. Your draft is preserved.', true); }
      finally { opening = false; if (active()) button.disabled = false; }
    };
    return button;
  }
  function pageLink(label, section, callback) {
    if (typeof callback === 'function') return action(label, callback);
    const node = el('a', label); node.href = '#' + section; return node;
  }
  function feedback(parent) {
    const node = el('p'); node.className = 'agent-training-form-message'; node.hidden = true;
    node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite'); parent.append(node);
    return (value, error = false, pending = false) => {
      if (!active()) return;
      node.hidden = false; node.textContent = value; node.setAttribute('role', error ? 'alert' : 'status');
      node.setAttribute('data-state', error ? 'error' : pending ? 'working' : 'success');
    };
  }
  const intro = card('Your published agent stays separate from the draft', 'Nothing on this page changes a published agent automatically. Save a draft, review and approve a new version, then publish it when you choose.');
  const publishedStatus = el('p'), draftStatus = el('p'); intro.append(publishedStatus, draftStatus);
  intro.append(pageLink('Open Create an agent →', 'agents', options.onReturnBuilder));
  const workflow = card('Your training steps', 'For a document pack: upload, review and select the sources, add any separate agent instructions, then save, approve and publish. You can also keep existing reviewed website facts; no category or optional text box must be filled just to proceed.');
  workflow.classList.add('agent-training-workflow');
  const steps = el('ol'); workflow.append(steps);
  const stepRows = new Map();
  for (const [id, label] of [['sources', 'Add documents'], ['review', 'Review and select sources'], ['instructions', 'Instructions and goals'], ['save', 'Save your draft'], ['approve', 'Review training approval'], ['publish', 'Publish to agents']]) {
    const item = el('li'), copy = el('strong', label), detail = el('span');
    item.setAttribute('data-step', id); item.append(copy, detail); steps.append(item); stepRows.set(id, { item, detail });
  }
  const sourceCard = card('1. Upload your business documents', 'Use the matching Business facts, Brand guidelines and Brand voice areas. After upload, review the extracted text and explicitly select the approved source below. Keep passwords, API keys and contact lists out of training.');
  sourceCard.append(el('p', 'You do not need to paste these same documents into the other text boxes. Those fields are optional extras. A separate agent-instructions document belongs in Your instructions under Settings draft, not in another upload area.'));
  const sourceForms = el('div'); sourceForms.className = 'agent-training-source-forms'; sourceCard.append(sourceForms);
  const textForm = el('form');
  textForm.append(el('h3', 'Add written guidance instead of a file'));
  const categories = [['general', 'Business facts'], ['brand_guidelines', 'Brand guidelines'], ['brand_voice', 'Brand voice']];
  const categoryLabel = value => categories.find(([id]) => id === value)?.[1] || 'Business facts';
  const textCategory = select(textForm, 'source_category', 'Guidance area', categories, 'general');
  const textTitle = field(textForm, 'source_title', 'Source title', 'text', '', 200); textTitle.required = true;
  const textContent = field(textForm, 'source_content', 'Additional facts or brand reference text', 'textarea', '', 50000); textContent.required = true; textContent.rows = 6;
  const addText = el('button', 'Add text for review'); addText.type = 'submit'; addText.className = 'btn'; textForm.append(addText); track(addText);
  const textFeedback = feedback(textForm);
  const uploadForms = [];
  const sourceGroups = new Map();
  const uploadDescriptions = {
    general: 'Products, services, FAQs and other business facts.',
    brand_guidelines: 'Brand rules, positioning and approved messages.',
    brand_voice: 'Tone, wording and examples of how your business speaks. This does not change the audio voice.',
  };
  for (const [category, label] of categories) {
    const area = el('section'); area.className = 'agent-training-upload-area'; area.setAttribute('data-source-category', category);
    const form = el('form'); form.className = 'agent-training-upload-form'; form.setAttribute('data-source-category', category);
    form.append(el('h3', label), el('p', uploadDescriptions[category]));
    const input = field(form, category === 'general' ? 'training_file' : category + '_file', 'Upload ' + label.toLowerCase(), 'file');
    input.accept = '.txt,.md,.pdf,.docx'; input.required = true; fileInputs.add(input);
    form.append(el('p', 'TXT, Markdown, PDF or DOCX · up to 512 KB and 50,000 extracted characters per file.'));
    const button = el('button', 'Add file for review'); button.type = 'submit'; button.className = 'btn'; form.append(button); track(button);
    const uploadFeedback = feedback(form);
    const group = el('div'); group.className = 'agent-training-source-group'; group.setAttribute('data-source-category', category);
    area.append(form, group); sourceGroups.set(category, group);
    uploadForms.push({ form, input, category, button, uploadFeedback, tracking: { sourceId: null, filename: null } });
    if (canTrain) sourceForms.append(area);
  }
  if (canTrain) {
    const optional = el('details'); optional.className = 'agent-training-optional-text';
    optional.append(el('summary', 'Optional: paste extra facts or guidance instead of uploading a file'), el('p', 'Use this only for an additional source or as an alternative to a file. It is not required when your documents contain the same information.'), textForm);
    sourceCard.append(optional);
  }
  const refreshSources = el('button', 'Refresh sources'); refreshSources.type = 'button'; refreshSources.className = 'btn small'; sourceCard.append(refreshSources);
  const sourceList = el('div'); sourceList.className = 'agent-training-source-list'; sourceCard.append(sourceList);
  const editor = el('div'); editor.className = 'agent-training-source-editor'; sourceCard.append(editor);
  const settings = card('2. Settings draft and selected sources', 'Choose the approved documents to include and any behaviour changes. Extra descriptions are optional. Keep existing saved text and links unless you intend to change them. Saving a draft does not publish it.');
  const profileForm = el('form'); settings.append(profileForm);
  const objective = select(profileForm, 'objective', 'Primary sales goal', [['', 'Keep the current goal'], ['signup', 'Help the customer sign up'], ['book', 'Help the customer book a meeting'], ['pay', 'Help the customer use an approved payment link']]);
  const replyLength = select(profileForm, 'reply_length', 'Reply length', [['existing', 'Keep the current reply length'], ['short', 'Short'], ['balanced', 'Balanced'], ['detailed', 'Detailed']]);
  const oneQuestion = select(profileForm, 'one_question', 'Questions per reply', [['', 'Keep the current approach'], ['true', 'Ask one question at a time'], ['false', 'Allow more than one question when useful']]);
  const salesGuidance = field(profileForm, 'sales_guidance', 'Add concise sales guidance to this draft (optional)', 'checkbox');
  profileForm.append(el('p', 'Have a separate agent-instructions file? Paste its text into Your instructions here. The uploads above provide reference knowledge; this field sets how the agent should speak and sell within its existing controls.'));
  const instructions = field(profileForm, 'instructions', 'Your instructions', 'textarea', '', 8000); instructions.rows = 6;
  instructions.placeholder = 'Describe the tone, qualification questions, offers and boundaries you want the agent to follow.';
  if (profileResponse.legacy_sales_brief) {
    const legacy = el('details'); legacy.className = 'agent-training-legacy';
    legacy.append(el('summary', 'Existing business sales brief · draft only'));
    const preview = el('textarea'); preview.value = profileResponse.legacy_sales_brief; preview.readOnly = true; preview.rows = 6;
    legacy.append(preview, el('p', 'This existing brief has not been added to these instructions. Choose the parts you want in the next draft.'));
    const copy = el('button', 'Use existing sales brief as draft'); copy.type = 'button'; copy.className = 'btn small';
    track(copy); legacy.append(copy); profileForm.append(legacy);
    copy.onclick = () => {
      if (!active() || busy || !canTrain) return;
      if (profileResponse.legacy_sales_brief.length > 8000) { message('This brief exceeds the 8,000-character instruction limit. Edit and paste the parts you want; nothing was copied or truncated.', true); return; }
      instructions.value = profileResponse.legacy_sales_brief; markDirty(); message('Existing brief copied into the settings draft. Save and review it before creating a new version.');
    };
  }
  const signupUrl = field(profileForm, 'signup_url', 'Approved signup link', 'url'); signupUrl.maxLength = 1000;
  const paymentUrl = field(profileForm, 'payment_url', 'Approved payment link', 'url'); paymentUrl.maxLength = 1000;
  profileForm.append(el('p', 'Booking uses this business’s existing booking or calendar settings. Link tools offer an approved URL; they do not complete a signup or take a payment themselves.'));
  const capabilities = field(profileForm, 'business_capabilities', 'Business services the agent can explain (optional)', 'textarea', '', 4000); capabilities.rows = 4;
  profileForm.append(el('p', 'These descriptions explain what your business offers. They do not enable automated actions.'));
  const selection = el('div'); selection.className = 'agent-training-selected-sources'; profileForm.append(el('h3', 'Approved sources for this draft'), selection);
  const sourceNote = el('p'); profileForm.append(sourceNote);
  const clearSources = el('button', 'Clear additional source selection'); clearSources.type = 'button'; clearSources.className = 'btn small'; profileForm.append(clearSources); track(clearSources);
  const toolMode = select(profileForm, 'tool_mode', 'Agent actions', [['keep', 'Keep the current tools'], ['custom', 'Choose tools for this draft']]);
  const toolBox = el('div'); toolBox.className = 'agent-training-tools'; profileForm.append(toolBox);
  const toolInputs = new Map();
  for (const tool of catalog) {
    if (typeof tool.id !== 'string') continue;
    const row = el('div'); row.className = 'agent-training-tool';
    const check = field(row, 'tool_' + tool.id, tool.title || tool.id, 'checkbox');
    widgets.find(item => item.node === check).disabled = () => toolMode.value !== 'custom';
    row.append(el('p', tool.description || ''), el('small', tool.execution === 'calendar_function' ? 'Configured calendar action' : 'Offers an approved link'));
    if (tool.requires) {
      const requirements = { calendar_connection: 'a verified calendar connection', calendar_availability: 'calendar availability checks', signup_url: 'an approved signup link', booking_url: 'an approved booking link', payment_url: 'an approved payment link' };
      row.append(el('small', 'Requires ' + (requirements[tool.requires] || String(tool.requires).replaceAll('_', ' '))));
    }
    toolBox.append(row); toolInputs.set(tool.id, check);
  }
  const saveDraft = el('button', 'Save settings draft'); saveDraft.type = 'submit'; saveDraft.className = 'btn primary'; profileForm.append(saveDraft); track(saveDraft);
  const draftFeedback = feedback(profileForm);
  const review = card('3. Review and approve a new version', 'This combines the saved settings draft with your existing reviewed business facts and selected approved sources. Publication is a separate step.');
  const reviewSummary = el('div'); reviewSummary.className = 'agent-training-review'; review.append(reviewSummary);
  const reviewForm = el('form');
  const confirmed = field(reviewForm, 'training_confirmed', 'I reviewed these settings and approved sources. Create a new version for me to publish.', 'checkbox'); confirmed.required = true;
  const approve = el('button', 'Approve new training version'); approve.type = 'submit'; approve.className = 'btn primary'; reviewForm.append(approve);
  const approvalFeedback = feedback(reviewForm);
  review.append(reviewForm);
  const publication = card('4. Publish the approved version', 'After approval, open Create an agent and publish in section 3. Uploading, saving and approving alone do not update the provider agents.');
  const publicationStatus = el('p'); publicationStatus.setAttribute('role', 'status'); publicationStatus.setAttribute('aria-live', 'polite');
  publication.append(publicationStatus, pageLink('Open Create an agent to publish →', 'agents', options.onReturnBuilder));
  const voiceHint = card('Audio voice is a separate setting', 'Brand voice documents describe tone and wording. Choose and hear the synthetic voice in the Voice tab of Agent settings. Training approval keeps the saved voice choice.');
  let selectedSourceId;
  const editable = [objective, replyLength, oneQuestion, salesGuidance, instructions, signupUrl, paymentUrl, capabilities, toolMode];
  function markDirty() { dirty = true; approvedHere = false; confirmed.checked = false; status(); controls(); }
  for (const input of editable) input.oninput = input.onchange = markDirty;
  for (const input of toolInputs.values()) input.onchange = markDirty;
  clearSources.onclick = () => { if (!active() || busy || !canTrain) return; chosenKnowledge.clear(); renderSourceChoices(); markDirty(); };
  function controls() {
    for (const item of widgets) item.node.disabled = busy || !canTrain || item.disabled();
    for (const input of sourceInputs) input.disabled = busy || !canTrain;
    for (const button of sourceButtons) button.disabled = busy;
    refreshSources.disabled = busy;
    const blocked = busy || !canTrain || dirty || !saved || approvedHere || approvalCurrent || !latestVersion?.id || !/^[a-f0-9]{64}$/.test(reviewDigest || '');
    confirmed.disabled = approve.disabled = blocked;
  }
  function status() {
    const currentApproval = !dirty && (approvedHere || (approvalCurrent && typeof approvedVersionId === 'string' && !!approvedVersionId));
    const currentPublished = currentApproval && trainingPublished;
    publishedStatus.textContent = publishedVersion ? `Published agent: ${publishedVersion.business_name || 'this business'} · ${publishedVersion.agent_name || 'assistant'}.` : 'No provider-published agent is recorded yet.';
    draftStatus.textContent = dirty ? 'Unsaved settings draft.' : currentPublished ? 'This training version is published to your agents.' : currentApproval ? 'New training version approved; publication is still required.' : saved ? 'Settings draft saved. It is not published by saving.' : 'No settings draft saved. Existing agent settings will be kept unless you choose changes.';
    const pendingSources = sources.filter(source => ['queued', 'extracting'].includes(source.status)).length;
    const failedSources = sources.filter(source => source.status === 'failed').length;
    const reviewedSources = sources.filter(source => source.approved === true).length;
    const step = (id, value, state) => { const row = stepRows.get(id); row.detail.textContent = value; row.item.setAttribute('data-state', state); };
    step('sources', !sources.length ? 'Optional: add files below, or keep your existing reviewed website facts.' : pendingSources ? `${pendingSources} document(s) are being read. Uploaded does not mean approved.` : failedSources ? `${failedSources} source(s) need attention; review their status below.` : `${sources.length} source(s) available.`, pendingSources ? 'working' : failedSources ? 'error' : sources.length ? 'complete' : 'optional');
    step('review', `${reviewedSources} reviewed; ${chosenKnowledge.size} additional sources selected. Existing reviewed website facts are retained. Approval alone does not select a source.`, chosenKnowledge.size ? 'complete' : 'optional');
    step('instructions', instructions.value.trim() ? 'Instructions entered. Review your goals and links, then save.' : 'Optional: paste any separate agent-instructions text below; no need to repeat uploaded documents.', instructions.value.trim() ? 'complete' : 'optional');
    step('save', dirty ? 'Unsaved changes: save this draft before approval.' : saved ? 'Settings draft saved.' : 'Save after choosing sources and settings.', saved && !dirty ? 'complete' : 'todo');
    step('approve', currentApproval ? 'This draft has an approved training version.' : approvalBlocker || 'Review the saved draft and confirm approval below.', currentApproval ? 'complete' : 'todo');
    const publishing = currentApproval && ['queued', 'processing', 'reconciling'].includes(approvedVersionStatus);
    const heldPublication = currentApproval && ['failed', 'uncertain'].includes(approvedVersionStatus);
    const publishText = currentPublished ? 'Confirmed published for these approved settings and sources.' : publishing ? 'Provider publication is processing. Open Create an agent to check the result.' : heldPublication ? 'Provider publication needs review. Open Create an agent; do not create another request blindly.' : currentApproval ? 'Approved and ready for publication in Create an agent, section 3.' : 'Publication follows saved-draft approval. Your existing agent stays as it is.';
    step('publish', publishText, currentPublished ? 'complete' : publishing ? 'working' : heldPublication ? 'error' : 'todo');
    publicationStatus.textContent = publishText;
    publication.setAttribute('data-state', currentPublished ? 'complete' : publishing ? 'working' : heldPublication ? 'error' : 'todo');
    settings.setAttribute('data-state', saved && !dirty ? 'complete' : 'todo');
    review.setAttribute('data-state', currentApproval ? 'complete' : 'todo');
    sourceCard.setAttribute('data-state', pendingSources ? 'working' : chosenKnowledge.size ? 'complete' : 'todo');
    const rows = [
      ['Goal', savedProfile.objective || 'Keep current'], ['Reply length', savedProfile.reply_length || 'existing'],
      ['Questions', savedProfile.one_question === true ? 'One at a time' : savedProfile.one_question === false ? 'Allow more than one' : 'Keep current'],
      ['Concise sales guidance', savedProfile.sales_guidance ? 'Selected' : 'Not selected'],
      ['Additional approved sources', (savedProfile.knowledge_ids || []).length],
      ['Tools', savedProfile.executable_tools === null || savedProfile.executable_tools === undefined ? 'Keep current' : savedProfile.executable_tools.length + ' selected'],
    ];
    reviewSummary.replaceChildren(...rows.map(([name, value]) => el('p', name + ': ' + value)));
    if (savedProfile.instructions) reviewSummary.append(el('p', 'Instructions: ' + savedProfile.instructions));
    if (savedProfile.signup_url) reviewSummary.append(el('p', 'Signup link: ' + savedProfile.signup_url));
    if (savedProfile.payment_url) reviewSummary.append(el('p', 'Payment link: ' + savedProfile.payment_url));
    if (dirty) reviewSummary.append(el('p', 'Save the current draft before approving it.'));
    else if (approvalBlocker) reviewSummary.append(el('p', approvalBlocker));
    if (!latestVersion) reviewSummary.append(pageLink('Review your business website facts first →', 'agents', options.onReturnBuilder));
    if (savedAt) draftStatus.textContent += ' Saved ' + new Date(savedAt * 1000).toLocaleString() + '.';
  }
  function applyProfile(profile) {
    objective.value = profile.objective || ''; replyLength.value = profile.reply_length || 'existing';
    oneQuestion.value = profile.one_question === true ? 'true' : profile.one_question === false ? 'false' : '';
    salesGuidance.checked = profile.sales_guidance === true;
    instructions.value = profile.instructions || ''; signupUrl.value = profile.signup_url || ''; paymentUrl.value = profile.payment_url || ''; capabilities.value = profile.business_capabilities || '';
    toolMode.value = Array.isArray(profile.executable_tools) ? 'custom' : 'keep';
    for (const [id, input] of toolInputs) input.checked = Array.isArray(profile.executable_tools) && profile.executable_tools.includes(id);
    chosenKnowledge.clear(); for (const id of profile.knowledge_ids || []) chosenKnowledge.add(id);
    renderSourceChoices();
  }
  function renderSourceChoices() {
    sourceInputs.clear();
    const rows = [], known = new Set();
    for (const source of sources) {
      if (source.approved !== true || !source.knowledge_id) continue;
      known.add(source.knowledge_id);
      const wrapper = el('label'); wrapper.className = 'check';
      const input = el('input'); input.type = 'checkbox'; input.name = 'knowledge_' + source.knowledge_id; input.checked = chosenKnowledge.has(source.knowledge_id);
      input.disabled = busy || !canTrain;
      sourceInputs.add(input);
      input.onchange = () => { if (!active() || busy || !canTrain) return; input.checked ? chosenKnowledge.add(source.knowledge_id) : chosenKnowledge.delete(source.knowledge_id); markDirty(); };
      wrapper.append(input, el('span', (source.title || source.filename || 'Reviewed source') + ' · ' + categoryLabel(source.category))); rows.push(wrapper);
    }
    selection.replaceChildren(...rows);
    if (!rows.length) selection.append(el('p', 'Review a source above before selecting it for this draft.'));
    const retained = [...chosenKnowledge].filter(id => !known.has(id)).length;
    sourceNote.textContent = 'Your existing reviewed website facts are retained in the new version.' + (retained ? ` ${retained} selected approved library source(s) are also retained.` : '');
  }
  function editSource(source, row) {
    selectedSourceId = source.source_id;
    const form = el('form'); form.className = 'agent-training-review-source';
    form.append(el('h3', source.approved ? 'Review saved source' : 'Review extracted facts'));
    form.append(el('p', categoryLabel(source.category) + ' · Review this guidance before adding it to an agent version.'));
    const name = field(form, 'review_source_title', 'Source title', 'text', source.title || '', 200); name.required = true;
    const content = field(form, 'review_source_content', 'Business facts to review', 'textarea', source.content || '', 50000); content.required = true; content.rows = 10;
    const reviewed = field(form, 'source_reviewed', 'I reviewed this source and approve these business facts.', 'checkbox'); reviewed.required = true;
    name.oninput = content.oninput = () => { reviewed.checked = false; };
    const button = el('button', 'Approve this source'); button.type = 'submit'; button.className = 'btn'; form.append(button); track(button);
    const sourceFeedback = feedback(form);
    editor.replaceChildren(form); controls();
    row?.append(editor);
    form.onsubmit = async event => {
      event.preventDefault();
      if (!active() || busy || !canTrain || selectedSourceId !== source.source_id) return;
      if (form.reportValidity && !form.reportValidity()) return;
      if (!reviewed.checked) { const value = 'Review and confirm the source before approving it.'; message(value, true); sourceFeedback(value, true); return; }
      const body = { source_id: source.source_id, title: name.value.trim(), content: content.value.trim(), approved: true };
      await write(async () => {
        const result = await api('/api/agent-builder/training/source-review', { method: 'POST', body, guard: () => active() && selectedSourceId === source.source_id });
        if (!active()) return;
        if (result.source?.approved !== true) throw Error('The server did not confirm source approval.');
        updateSource(result.source); reviewDigest = null; markDirty();
        reviewed.checked = false;
        message('Source approved. Select it for your settings draft, then save and review the new version.');
      }, { feedback: sourceFeedback, button, pendingLabel: 'Approving this reviewed source…', buttonLabel: 'Approving source…' });
    };
  }
  function renderSources() {
    sourceButtons.clear();
    const rows = sources.map(source => {
      const row = el('div'); row.className = 'agent-training-source';
      row.setAttribute('data-source-id', source.source_id);
      row.append(el('strong', source.title || source.filename || 'Training source'));
      const labels = { queued: 'Waiting for extraction', extracting: 'Reading document', ready: 'Ready for your review', reviewed: 'Reviewed and approved', failed: 'Could not extract this document' };
      row.append(el('span', labels[source.status] || 'Status unavailable'));
      row.setAttribute('data-state', source.status === 'failed' ? 'error' : source.approved === true ? 'complete' : ['queued', 'extracting'].includes(source.status) ? 'working' : 'todo');
      if (source.filename && source.filename !== source.title) row.append(el('small', source.filename));
      if (source.status === 'failed') row.append(el('p', 'This file could not be extracted. Check that it is readable and within the limits, or add its text as an optional source. No source was approved.'));
      if (['ready', 'reviewed'].includes(source.status) && typeof source.content === 'string') {
        const button = el('button', source.approved ? 'Review saved source' : 'Review this source'); button.type = 'button'; button.className = 'btn small';
        button.disabled = busy; button.onclick = () => { if (active() && !busy) editSource(source, row); }; row.append(button);
        sourceButtons.add(button);
      }
      if (selectedSourceId === source.source_id && editor.children.length) row.append(editor);
      return row;
    });
    sourceList.replaceChildren();
    for (const [category, label] of categories) {
      const group = sourceGroups.get(category);
      group.replaceChildren(el('h3', canTrain ? 'Saved documents' : label));
      const matching = rows.filter((_, index) => (categories.some(([id]) => id === sources[index].category) ? sources[index].category : 'general') === category);
      group.append(...(matching.length ? matching : [el('p', 'No ' + label.toLowerCase() + ' sources yet.')]));
      if (!canTrain) sourceList.append(group);
    }
    for (const { tracking, uploadFeedback } of uploadForms) {
      const source = sources.find(item => item.source_id === tracking.sourceId);
      if (!source) continue;
      const state = uploadedState(source, tracking.filename);
      uploadFeedback(state.text, state.error, state.pending);
    }
    renderSourceChoices(); status(); pollSources();
  }
  function uploadedState(source, selectedFilename) {
    const name = source.filename || source.title || 'Document';
    const saved = (selectedFilename && selectedFilename !== source.filename
      ? `${selectedFilename} is saved as the source "${name}" below.`
      : `${name} is saved below.`) + ' The file picker is clear so you can add another document.';
    if (['queued', 'extracting'].includes(source.status)) return { text: `${saved} Reading its text; review and approval come next.`, pending: true };
    if (source.status === 'failed') return { text: `${saved} This document could not be extracted. Check that it is readable and within the limits, or add its text instead. Nothing was approved or published.`, error: true };
    if (source.approved === true) return { text: `${saved} This source is already reviewed and approved. Select it under Approved sources for this draft, then save and approve the training version.`, pending: false };
    return { text: `${saved} Document text is ready. Click Review this source below, approve it, then select it for your settings draft.`, pending: false };
  }
  function updateSource(source) {
    sourceRead++;
    if (['queued', 'extracting'].includes(source.status)) pollDeadline = Date.now() + 90000;
    const index = sources.findIndex(item => item.source_id === source.source_id);
    index === -1 ? sources.push(source) : sources.splice(index, 1, source);
    renderSources();
  }
  async function refreshSourceList(announce = false) {
    if (!active() || busy) return;
    const read = ++sourceRead, requestCurrent = () => active() && sourceRead === read;
    try {
      const result = await api('/api/agent-builder/training/sources', { guard: requestCurrent });
      if (!requestCurrent()) return;
      if (!Array.isArray(result.sources)) throw Error('Source status could not be confirmed.');
      sources = result.sources; renderSources(); controls();
      if (announce) message('Source status refreshed. Your entered settings are preserved; no source was approved or selected automatically.');
    } catch (error) { if (requestCurrent()) { message(error.message || 'Sources could not be refreshed.', true); pollSources(); } }
  }
  function pollSources() {
    if (sourcePolling || !sources.some(source => ['queued', 'extracting'].includes(source.status)) || Date.now() >= pollDeadline) return;
    sourcePolling = true;
    const timer = setTimeout(async () => {
      timers.delete(timer); sourcePolling = false;
      if (!active()) return;
      if (!busy) await refreshSourceList(); else pollSources();
    }, 2000);
    timers.add(timer);
  }
  async function write(callback, operation = {}) {
    if (!active() || busy || !canTrain) return;
    sourceRead++; busy = true; controls();
    const originalLabel = operation.button?.textContent;
    if (operation.button) { operation.button.textContent = operation.buttonLabel || 'Working…'; operation.button.setAttribute('aria-busy', 'true'); }
    if (operation.pendingLabel) { message(operation.pendingLabel, false, true); operation.feedback?.(operation.pendingLabel, false, true); }
    try {
      const result = await callback();
      if (active()) {
        if (result === false) {
          const value = 'Document selection changed. Check source status before submitting another file; no automatic approval or publication occurred.';
          message(value, true); operation.feedback?.(value, true);
        } else operation.feedback?.(notice.textContent, lastMessageError, lastMessagePending);
      }
    }
    catch (error) {
      if (active()) { const value = error.message || 'The request could not be completed. Your entered details are preserved.'; message(value, true); operation.feedback?.(value, true); }
    }
    finally {
      busy = false;
      if (active()) {
        if (operation.button) { operation.button.textContent = originalLabel; operation.button.setAttribute('aria-busy', 'false'); }
        renderSourceChoices(); status(); controls(); pollSources();
      }
    }
  }
  textForm.onsubmit = async event => {
    event.preventDefault(); if (!active() || busy || !canTrain || (textForm.reportValidity && !textForm.reportValidity())) return;
    const body = { title: textTitle.value.trim(), content: textContent.value.trim(), category: textCategory.value };
    await write(async () => {
      const result = await api('/api/agent-builder/training/source', { method: 'POST', body, guard: active });
      if (!active()) return;
      if (!result.source?.source_id) throw Error('The server did not confirm this source.');
      updateSource(result.source); textTitle.value = ''; textContent.value = '';
      message('Text added as a draft. Review and approve its facts before selecting it for an agent version.');
    }, { feedback: textFeedback, button: addText, pendingLabel: 'Adding your text as an unapproved source…', buttonLabel: 'Adding text…' });
  };
  for (const { form: uploadForm, input: fileInput, category, button, uploadFeedback, tracking } of uploadForms) uploadForm.onsubmit = async event => {
    event.preventDefault(); if (!active() || busy || !canTrain) return;
    const file = fileInput.files?.[0];
    if (!file || file.size > 512 * 1024 || !/\.(txt|md|pdf|docx)$/i.test(file.name) || /[\\/]/.test(file.name) || file.name.length > 200) { const value = 'Choose a TXT, Markdown, PDF or DOCX file no larger than 512 KB.'; message(value, true); uploadFeedback(value, true); return; }
    const currentFile = () => active() && fileInput.files?.[0] === file;
    await write(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!currentFile()) return false;
      if (bytes.byteLength > 512 * 1024) throw Error('This document exceeds 512 KB.');
      let binary = ''; for (let start = 0; start < bytes.length; start += 16384) binary += String.fromCharCode(...bytes.subarray(start, start + 16384));
      const body = { filename: file.name, content_base64: btoa(binary), category };
      const result = await api('/api/agent-builder/training/upload', { method: 'POST', body, guard: currentFile });
      if (!currentFile()) return false;
      const source = result.source;
      if (result.outreach_started !== false || !source || typeof source.source_id !== 'string' || !/^[A-Za-z0-9_-]{1,36}$/.test(source.source_id)
        || !['queued', 'extracting', 'ready', 'reviewed', 'failed'].includes(source.status) || typeof source.approved !== 'boolean'
        || (source.category ?? 'general') !== category
        || (['ready', 'reviewed'].includes(source.status) && (typeof source.content !== 'string' || typeof source.knowledge_id !== 'string' || !/^[A-Za-z0-9_-]{1,36}$/.test(source.knowledge_id)))
        || (source.status === 'reviewed' && source.approved !== true)) throw Error('The server did not confirm this upload. Your file selection is preserved; refresh sources before trying again.');
      tracking.sourceId = result.source.source_id;
      tracking.filename = file.name;
      updateSource(result.source); fileInput.value = '';
      const state = uploadedState(result.source, file.name);
      message(state.text, state.error, state.pending);
    }, { feedback: uploadFeedback, button, pendingLabel: 'Preparing and uploading your document for review…', buttonLabel: 'Adding document…' });
  };
  profileForm.onsubmit = async event => {
    event.preventDefault(); if (!active() || busy || !canTrain || (profileForm.reportValidity && !profileForm.reportValidity())) return;
    const body = { objective: objective.value || null, reply_length: replyLength.value, one_question: oneQuestion.value === '' ? null : oneQuestion.value === 'true', sales_guidance: salesGuidance.checked,
      signup_url: signupUrl.value.trim(), payment_url: paymentUrl.value.trim(), instructions: instructions.value.trim(), business_capabilities: capabilities.value.trim(), knowledge_ids: [...chosenKnowledge],
      executable_tools: toolMode.value === 'keep' ? null : [...toolInputs].filter(([, input]) => input.checked).map(([id]) => id) };
    await write(async () => {
      const result = await api('/api/agent-builder/training/profile', { method: 'POST', body, guard: active });
      if (!active()) return;
      if (result.saved !== true || !result.profile) throw Error('The server did not confirm this settings draft.');
      savedProfile = result.profile; saved = true; savedAt = result.saved_at; latestVersion = result.latest_version;
      publishedVersion = result.published_version; reviewDigest = result.review_digest; approvalBlocker = result.approval_blocker;
      approvalCurrent = result.approval_current === true; trainingPublished = result.training_published === true;
      approvedVersionId = result.approved_version_id; approvedVersionStatus = result.approved_version_status;
      dirty = false; approvedHere = false; confirmed.checked = false;
      applyProfile(savedProfile); status(); message('Settings draft saved. Review it below before approving a new version. Your published agent is unchanged.');
    }, { feedback: draftFeedback, button: saveDraft, pendingLabel: 'Saving these settings and selected sources as a draft…', buttonLabel: 'Saving settings…' });
  };
  reviewForm.onsubmit = async event => {
    event.preventDefault(); if (!active() || busy || approve.disabled || !canTrain) return;
    if (!confirmed.checked) { const value = 'Confirm your review before approving a new training version.'; message(value, true); approvalFeedback(value, true); return; }
    const body = { source_version_id: latestVersion.id, review_digest: reviewDigest, confirmation: 'APPROVE THIS TRAINING VERSION' };
    await write(async () => {
      const result = await api('/api/agent-builder/training/approve', { method: 'POST', body, guard: active });
      if (!active()) return;
      if (!result.version?.id || result.version.status !== 'approved' || result.published_version_unchanged !== true || result.provider_publication_required !== true || result.outreach_started !== false) throw Error('The server did not confirm a draft-only approval. Check the agent status before continuing.');
      latestVersion = result.version; approvedHere = true; reviewDigest = null; confirmed.checked = false;
      approvalCurrent = true; trainingPublished = false; approvedVersionId = result.version.id; approvedVersionStatus = result.version.status;
      status(); message('New training version approved. Your published agent is unchanged. Open Create an agent when you choose to publish this version.');
    }, { feedback: approvalFeedback, button: approve, pendingLabel: 'Approving the reviewed training version. Provider publication is separate…', buttonLabel: 'Approving training…' });
  };
  refreshSources.onclick = () => refreshSourceList(true);
  applyProfile(savedProfile); renderSources(); status(); controls();
  message(canTrain ? 'Your settings are ready to review. Changes stay in a draft until you explicitly approve and publish.' : 'Training settings are read-only for your role.');
  return { dispose };
}
