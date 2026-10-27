/* Website-to-agent setup. Provider credentials stay in the existing secure setup.
 * Website text is displayed as text and requires explicit review before use.
 */
const renderTokens = new WeakMap();
const pollStarted = new WeakMap();
const el = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  return node;
};

function link(label, href) {
  const node = el('a', label);
  node.href = href;
  if (href.startsWith('https://')) {
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
  }
  return node;
}

function sourceLink(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw Error();
    return link(parsed.href, parsed.href);
  } catch {
    return el('span', 'Source address unavailable');
  }
}

function field(parent, name, label, value = '', type = 'text') {
  const wrapper = el('label');
  wrapper.className = type === 'checkbox' ? 'check' : 'field';
  const input = el(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') input.type = type;
  input.name = name;
  input.value = value;
  if (type === 'checkbox') wrapper.append(input, el('span', label));
  else wrapper.append(el('span', label), input);
  parent.append(wrapper);
  return input;
}

function card(root, step, title, description) {
  const section = el('section');
  section.className = 'card agent-builder-step';
  const heading = el('div');
  heading.className = 'agent-builder-heading';
  const number = el('span', String(step));
  number.className = 'step-no';
  const copy = el('div');
  copy.append(el('h2', title), el('p', description));
  heading.append(number, copy);
  section.append(heading);
  root.append(section);
  return section;
}

function completed(section, label) {
  section.classList.add('agent-builder-complete');
  section.setAttribute('data-complete', 'true');
  if (section.completionBadge) section.completionBadge.textContent = label;
  else {
    const badge = el('span', label);
    badge.className = 'agent-builder-completion';
    section.children[0].append(badge);
    section.completionBadge = badge;
  }
}

function viewport(root) {
  const containers = [];
  for (let node = root; node; node = node.parentElement) {
    if (typeof node.scrollTop === 'number') containers.push({ node, top: node.scrollTop, left: node.scrollLeft });
  }
  return { top: globalThis.scrollY || 0, left: globalThis.scrollX || 0, containers };
}

function restoreViewport(position) {
  if (!position) return;
  for (const item of position.containers) {
    item.node.scrollTop = item.top;
    item.node.scrollLeft = item.left;
  }
  globalThis.scrollTo?.({ top: position.top, left: position.left, behavior: 'instant' });
}

function disableStaleForms(node, insideForm = false) {
  const inForm = insideForm || node.tagName?.toLowerCase() === 'form';
  if (inForm && 'disabled' in node) node.disabled = true;
  for (const child of node.children || []) disableStaleForms(child, inForm);
}

function stateLabel(status) {
  return String(status || 'not ready').replaceAll('_', ' ');
}

export async function mountAgentBuilder(root, api, options = {}) {
  // Only an internal refresh of this same mounted installation may keep the
  // existing layout while loading. A new external mount still clears old data.
  const restore = options.restore;
  const preserveLayout = restore?.token === renderTokens.get(root) && !!restore?.token;
  const notice = options.notice;
  options = { ...options };
  delete options.restore;
  delete options.notice;
  const token = {};
  renderTokens.set(root, token);
  const active = () => renderTokens.get(root) === token && root.isConnected !== false;
  const remount = extra => mountAgentBuilder(root, api, { ...options, ...extra, restore: { token, viewport: viewport(root), ...extra?.restore } });
  root.classList.add('agent-builder');
  const title = el('div');
  title.className = 'page-head';
  const copy = el('div');
  copy.append(el('h1', 'Create your business agent'), el('p', 'One approved business knowledge version for website chat and AI calls.'));
  function sectionLink(label, section) {
    const openSection = section === 'live' ? options.onOpenConnections : section === 'agent-settings' ? (options.onOpenSettings || options.onOpenAgentSettings) : undefined;
    if (typeof openSection === 'function') {
      const button = el('button', label);
      button.type = 'button';
      button.className = 'btn small';
      let pending = false;
      button.onclick = async event => {
        event?.preventDefault?.();
        if (!active() || pending) return;
        pending = true; button.disabled = true;
        try { await openSection({ isCurrent: active }); }
        catch (error) {
          if (active()) {
            message.textContent = error?.message || 'That setup page could not be opened. Your current agent setup is preserved.';
            message.setAttribute('role', 'alert');
            message.setAttribute('data-error', 'true');
            message.removeAttribute?.('data-success');
          }
        } finally { pending = false; if (active()) button.disabled = false; }
      };
      return button;
    }
    let href = options.sectionUrl ? options.sectionUrl(section) : options.links?.[section];
    if (typeof href !== 'string') href = '#' + section;
    if (!href.startsWith('#')) {
      try {
        const parsed = new URL(href);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw Error();
      } catch { href = '#' + section; }
    }
    return link(label, href);
  }
  const actions = el('div');
  actions.className = 'page-actions';
  const refresh = el('button', 'Refresh status');
  refresh.type = 'button';
  refresh.className = 'btn';
  refresh.onclick = async () => {
    if (!active()) return;
    pollStarted.delete(root);
    await remount();
  };
  actions.append(refresh, sectionLink('Agent settings →', 'agent-settings'), sectionLink('Secure connections →', 'live'));
  title.append(copy, actions);
  const message = el('p');
  message.className = 'agent-builder-message';
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  if (notice) message.textContent = notice;
  if (!preserveLayout) root.replaceChildren(title, message, el('p', 'Loading your agent setup…'));
  let data;
  try {
    data = await api('/api/agent-builder');
  } catch (error) {
    if (active()) {
      message.textContent = `${notice ? notice + ' ' : ''}${error.message || 'Agent setup could not be loaded.'} Use Refresh status to check again.`;
      message.setAttribute('role', 'alert');
      message.setAttribute('data-error', 'true');
      if (preserveLayout) {
        const sections = Array.from(root.children).slice(2);
        for (const section of sections) disableStaleForms(section);
        message.textContent += ' Your displayed facts are preserved; refresh successfully before continuing.';
        root.replaceChildren(title, message, ...sections);
        restoreViewport(restore.viewport);
      } else root.replaceChildren(title, message, sectionLink('Return to secure connections →', 'live'));
    }
    return;
  }
  if (!active()) return;
  root.replaceChildren(title, message);
  if (notice) {
    message.setAttribute('data-success', 'true');
    setTimeout(() => { if (active() && message.textContent === notice) { message.textContent = ''; message.removeAttribute?.('data-success'); } }, 7000);
  }

  const draft = data.draft || data.current_draft;
  const version = data.version || data.current_version;
  const published = version?.status === 'published';
  const scanning = ['queued', 'processing'].includes(draft?.status);
  const creating = ['queued', 'processing'].includes(version?.status);
  const blockers = Array.isArray(data.blockers) ? data.blockers : [];
  const providerMissing = data.requirements?.find(requirement => requirement.id === 'retell')?.complete === false;
  const approvedDraft = !!draft && !!version && version.draft_id === draft.id;
  const intro = el('div');
  intro.className = 'helper';
  intro.append(el('strong', 'Start with your website. You control what goes live.'), el('p', 'Scanning creates a draft. Review the facts before creating provider agents. A test call uses only your authorised own-contact pilot; it never starts a lead-list campaign.'));
  root.append(intro);
  if (blockers.length) {
    const setup = el('div');
    setup.className = 'helper amber agent-builder-blockers';
    setup.append(el('strong', 'Before live testing'));
    const items = el('ul');
    for (const blocker of blockers) items.append(el('li', typeof blocker === 'string' ? blocker : blocker.message || blocker.reason || blocker.code));
    setup.append(items, sectionLink('Open verified provider and own-contact setup →', 'live'));
    root.append(setup);
  }
  if (Array.isArray(data.requirements) && data.requirements.length) {
    const checks = el('div');
    checks.className = 'agent-builder-requirements';
    for (const requirement of data.requirements) checks.append(el('span', `${requirement.complete ? '✓' : '○'} ${requirement.title}`));
    root.append(checks);
  }
  if (scanning || creating) {
    const status = scanning ? 'Website scan is queued or processing.' : 'Provider agent creation is queued or processing.';
    message.textContent = `${status} This page checks for the actual result; refreshing does not repeat the operation.`;
    const started = pollStarted.get(root) || Date.now();
    pollStarted.set(root, started);
    if (Date.now() - started < 90000) {
      setTimeout(() => {
        if (active()) remount().catch(error => { if (root.isConnected !== false) message.textContent = error.message; });
      }, 2000);
    } else message.textContent += ' Processing is taking longer than expected. Refresh to check again.';
  } else pollStarted.delete(root);

  function submit(form, label, action, { disabled = false, pendingLabel = 'Working…' } = {}) {
    const feedback = el('p');
    feedback.className = 'agent-builder-form-message';
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    feedback.hidden = true;
    const button = el('button', label);
    button.type = 'submit';
    button.className = 'btn primary';
    button.disabled = disabled;
    form.append(feedback, button);
    let pending = false;
    form.onsubmit = async event => {
      event.preventDefault();
      if (!active() || pending || button.disabled) return;
      if (form.reportValidity && !form.reportValidity()) return;
      pending = true;
      button.disabled = true;
      message.textContent = '';
      feedback.hidden = false;
      feedback.className = 'agent-builder-form-message';
      feedback.setAttribute('role', 'status');
      feedback.textContent = pendingLabel;
      try {
        await action();
        if (active()) feedback.textContent = message.textContent;
      } catch (error) {
        if (active()) {
          message.textContent = error.message || 'The request could not be completed.';
          feedback.textContent = message.textContent;
          feedback.className = 'agent-builder-form-message helper amber';
          feedback.setAttribute('role', 'alert');
          feedback.tabIndex = -1;
          feedback.focus?.({ preventScroll: true });
        }
      } finally {
        pending = false;
        if (active()) button.disabled = disabled;
      }
    };
    return button;
  }

  const scan = card(root, 1, 'Scan your website', 'Add the final public HTTPS address. We read a small set of pages on that site; we do not log in or submit forms.');
  if (draft?.status === 'ready') completed(scan, 'Scanned');
  const scanForm = el('form');
  const url = field(scanForm, 'url', 'Business website', draft?.source_url || data.website || '', 'url');
  url.required = true;
  url.placeholder = 'https://your-business.com/';
  url.maxLength = 1000;
  submit(scanForm, draft ? 'Scan a new draft' : 'Scan website', async () => {
    const capturedUrl = url.value.trim();
    message.textContent = 'Reading public pages. This can take a few moments…';
    await api('/api/agent-builder/scan', { method: 'POST', body: { url: capturedUrl } });
    if (active()) await remount();
  }, { disabled: scanning });
  scan.append(scanForm);
  if (draft?.status === 'failed' && draft.detail) scan.append(el('p', draft.detail));

  const review = card(root, 2, 'Review your business knowledge', 'Check services, pricing, promises and contact details. Website instructions are untrusted until you approve the business facts.');
  let approvedNotice;
  if (approvedDraft) {
    completed(review, 'Approved');
    // Preserve the successful operation's exact edited facts and layout. The
    // raw scan is not an approved snapshot. A fresh page load uses the compact
    // persisted summary because the status API deliberately omits that snapshot.
    const saved = options.approvedFacts;
    if (saved?.version_id === version.id && saved?.draft_id === draft.id) {
      const readOnly = el('div');
      readOnly.className = 'agent-builder-saved-facts';
      field(readOnly, 'saved_business_name', 'Business name', saved.business_name).readOnly = true;
      field(readOnly, 'saved_agent_name', 'Agent name', saved.agent_name).readOnly = true;
      for (const [index, page] of saved.pages.entries()) {
        const details = el('details');
        details.className = 'agent-builder-source';
        details.open = page.open;
        details.append(el('summary', page.title || page.url), sourceLink(page.url));
        field(details, `saved_title_${index}`, 'Page title', page.title).readOnly = true;
        const content = field(details, `saved_content_${index}`, 'Approved business facts · saved', page.content, 'textarea');
        content.rows = 10;
        content.readOnly = true;
        if (page.height && content.style) content.style.height = page.height + 'px';
        readOnly.append(details);
      }
      const confirmed = field(readOnly, 'saved_review_confirmed', 'These reviewed facts are saved and approved.', '', 'checkbox');
      confirmed.checked = true;
      confirmed.disabled = true;
      const done = el('button', 'Saved and approved');
      done.type = 'button';
      done.className = 'btn';
      done.disabled = true;
      readOnly.append(done);
      review.append(readOnly);
    }
    approvedNotice = el('div');
    approvedNotice.className = 'helper agent-builder-approved';
    approvedNotice.setAttribute('role', 'status');
    approvedNotice.setAttribute('aria-live', 'polite');
    approvedNotice.tabIndex = -1;
    approvedNotice.append(el('strong', 'Website facts saved and approved'), el('p', `${version.business_name || 'Your business'} · Agent: ${version.agent_name || 'your assistant'}. This approved knowledge version is saved.`));
    approvedNotice.append(el('p', providerMissing ? 'Next, connect Retell in Live connections. Website scanning and fact approval do not require a provider account.' : published ? 'Your chat and voice agents use this saved knowledge. Continue with the private tests below.' : 'Next, create your chat and voice agents below. Verified provider access is required before creation.'));
    review.append(approvedNotice, sectionLink('Review your saved facts in Knowledge →', 'knowledge'), el('p', 'To approve different facts for a new agent version, scan a new draft above.'));
  } else if (draft?.status === 'ready' && draft.pages?.length) {
    const reviewForm = el('form');
    const businessName = field(reviewForm, 'business_name', 'Business name', version?.business_name || version?.snapshot?.business_name || data.business_name || '');
    businessName.maxLength = 120;
    businessName.required = true;
    const agentName = field(reviewForm, 'agent_name', 'Agent name', version?.agent_name || version?.snapshot?.agent_name || data.agent_name || 'Alex');
    agentName.maxLength = 80;
    agentName.required = true;
    const pages = [];
    for (const [index, page] of draft.pages.entries()) {
      const details = el('details');
      details.className = 'agent-builder-source';
      details.open = index === 0;
      details.append(el('summary', page.title || page.url || `Page ${index + 1}`), sourceLink(page.url));
      const titleInput = field(details, `title_${index}`, 'Page title', page.title || 'Business information');
      titleInput.maxLength = 200;
      const content = field(details, `content_${index}`, 'Business facts to approve', page.content || '', 'textarea');
      content.rows = 10;
      content.maxLength = 50000;
      content.required = true;
      reviewForm.append(details);
      pages.push({ url: page.url, title: titleInput, content, details });
    }
    const skipped = draft.skipped || draft.evidence?.skipped;
    if (skipped?.length) reviewForm.append(el('p', `${skipped.length} page(s) were skipped. Only the source text shown above is included.`));
    const reviewed = field(reviewForm, 'review_confirmed', 'I reviewed this content and approve these facts for my business agent.', '', 'checkbox');
    reviewed.required = true;
    const capturedDraftId = draft.id;
    submit(reviewForm, 'Approve a shared knowledge version', async () => {
      if (!reviewed.checked) throw Error('Review and approve the business facts first.');
      const body = { draft_id: capturedDraftId, business_name: businessName.value.trim(), agent_name: agentName.value.trim(), review_confirmed: true, pages: pages.map(page => ({ url: page.url, title: page.title.value.trim(), content: page.content.value.trim() })) };
      const approved = await api('/api/agent-builder/approve', { method: 'POST', body });
      if (active()) await remount({ notice: 'Website facts saved and approved. Continue with provider setup below.', approvedFacts: { ...body, version_id: approved.version?.id, pages: body.pages.map((page, index) => ({ ...page, open: pages[index].details.open, height: pages[index].content.getBoundingClientRect?.().height })) }, restore: { focus: 'review' } });
    }, { pendingLabel: 'Saving your approved website facts…' });
    review.append(reviewForm);
  } else {
    review.append(el('p', draft?.status === 'failed' ? 'The scan failed. Review the source URL and try again, or manage your knowledge directly.' : 'Your scanned pages will appear here as an editable draft. No scanned content is approved automatically.'), sectionLink('Manage existing approved knowledge →', 'knowledge'));
  }

  const provider = card(root, 3, 'Create chat and voice agents', 'Both agents use the same approved knowledge version. Creating agents does not call anyone or enable your public website widget.');
  if (published) completed(provider, 'Created');
  if (providerMissing) {
    const setup = el('div');
    setup.className = 'helper amber agent-builder-provider-setup';
    setup.append(el('strong', 'Retell API access not connected'), el('p', 'Connect your Retell API access here; this app creates and configures the chat and call agents from your approved business facts. Website scanning and approval need no provider account. Provider usage may incur charges; no purchase is made here.'), sectionLink('Connect Retell here →', 'live'), link('Retell account / one-time API access →', 'https://dashboard.retellai.com'));
    provider.append(setup);
  }
  if (version) {
    const status = el('p', `Knowledge version: ${String(version.id)} · ${stateLabel(version.status)}`);
    status.className = 'agent-builder-status';
    provider.append(status);
    if (version.detail) provider.append(el('p', version.detail));
    if (published) {
      provider.append(el('p', 'Provider agents are published for this knowledge version. Use a separate test below before customer activation.'));
    } else if (['queued', 'processing', 'uncertain', 'reconciling'].includes(version.status)) {
      provider.append(el('p', 'Provider creation is still processing or needs reconciliation. We will not blindly create duplicate agents. Refresh after the provider result has been reconciled.'));
    } else {
      const publishForm = el('form');
      const confirm = field(publishForm, 'publish_confirmed', 'Create dedicated agents in my configured provider account. I understand that subsequent live tests may incur provider charges.', '', 'checkbox');
      confirm.required = true;
      const capturedVersionId = version.id;
      submit(publishForm, 'Create my chat and call agents', async () => {
        if (!confirm.checked) throw Error('Confirm provider agent creation first.');
        await api('/api/agent-builder/publish', { method: 'POST', body: { version_id: capturedVersionId, confirmation: 'CREATE DEDICATED VOICE AND CHAT AGENTS' } });
        if (active()) await remount();
      }, { disabled: providerMissing });
      provider.append(publishForm);
    }
  } else provider.append(el('p', 'Approve the website facts to create the first shared knowledge version.'));

  const testSection = card(root, 4, 'Test your agent', 'Request one paid call to your saved own number now. Private chat is optional and can be skipped. This requests one test only; new-enquiry follow-up still waits at least two minutes.');
  testSection.append(el('h3', 'Call my own number'));
  const callForm = el('form');
  callForm.className = 'agent-builder-call';
  const own = field(callForm, 'own_contact_confirmed', 'Call only my saved, verified own test number.', '', 'checkbox');
  own.required = true;
  const consent = field(callForm, 'ai_call_consent', 'I request this paid automated AI test call and agree to the configured call disclosure and recording policy.', '', 'checkbox');
  consent.required = true;
  const capturedVersionId = version?.id;
  let callRequestId;
  const callButton = submit(callForm, 'Call me', async () => {
    if (!callRequestId) {
      if (!own.checked || !consent.checked) throw Error('Confirm your own-contact test and AI call permission.');
      if (!globalThis.crypto?.randomUUID) throw Error('Open this page in a secure HTTPS browser before requesting a call.');
      callRequestId = globalThis.crypto.randomUUID();
      own.disabled = true;
      consent.disabled = true;
    }
    callButton.textContent = 'Check this call request';
    const result = await api('/api/agent-builder/test-call', { method: 'POST', body: { version_id: capturedVersionId, own_contact_confirmed: true, ai_call_consent: true, confirmation: 'PLACE ONE PAID TEST CALL TO MY OWN NUMBER', mode: 'call_me', request_id: callRequestId }, guard: active });
    if (!active()) return;
    const hasJob = typeof result.job_id === 'string' && !!result.job_id;
    if (result.one_call_only !== true || result.operation_id !== callRequestId || (!hasJob && result.status !== 'cancelled')) throw Error('The server did not confirm this one-call request. Use this button to check the same request or review Activity; no new request ID will be created.');
    const status = result.status;
    if (status === 'cancelled' && !hasJob) {
      message.textContent = 'This one-call request was cancelled before a call was queued. Review Activity before requesting another call.';
    } else if (['blocked', 'failed', 'cancelled', 'uncertain', 'skipped'].includes(status)) {
      message.textContent = `This call request is ${stateLabel(status)}. Review Activity & queue before requesting another call. Request: ${result.job_id}.`;
    } else if (status === 'completed') {
      message.textContent = `This one-call request is complete. Open Activity & queue for its actual provider result. Request: ${result.job_id}.`;
    } else if (status === 'awaiting_outcome') {
      message.textContent = `Your one-call test was submitted and is awaiting its verified provider outcome. Request: ${result.job_id}.`;
    } else if (['queued', 'processing'].includes(status)) {
      message.textContent = `One call requested to your saved test number. It will run as soon as its final eligibility checks pass. Request: ${result.job_id}. A queued request is not proof that a call was made.`;
    } else throw Error('The call request has an unknown status. Check the same request or Activity before continuing.');
    own.checked = false;
    consent.checked = false;
  }, { disabled: !published || data.call_me_ready !== true, pendingLabel: 'Checking your one-call request…' });
  testSection.append(callForm, sectionLink('See actual queue and call outcomes →', 'activity'));
  if (published && data.call_me_ready !== true) testSection.append(el('p', data.call_me_blocker || 'Verify the caller and save your own-contact attestation before requesting this one-call test.'));

  testSection.append(el('h3', 'Optional private chat'));
  const chatForm = el('form');
  const question = field(chatForm, 'message', 'Ask your agent about your business', '', 'textarea');
  question.rows = 3;
  question.maxLength = 1000;
  question.required = true;
  const chatLog = el('div');
  chatLog.className = 'agent-builder-chat';
  chatLog.setAttribute('aria-live', 'polite');
  let chatId;
  let chatPending = false;
  let pendingQuestion;
  let requestId;
  const chatButton = submit(chatForm, 'Send test message', async () => {
    const capturedMessage = requestId ? pendingQuestion : question.value.trim();
    if (!capturedMessage) throw Error('Enter a question to test.');
    if (!requestId) {
      if (!globalThis.crypto?.randomUUID) throw Error('Open this setup in a secure HTTPS browser context before starting AI chat.');
      requestId = globalThis.crypto.randomUUID();
      pendingQuestion = capturedMessage;
      question.disabled = true;
      chatButton.textContent = 'Check pending reply';
    }
    // The same ID survives an initial response loss. A retry recovers that turn;
    // it cannot create another provider completion under a fresh operation ID.
    let response = await api('/api/agent-builder/chat', { method: 'POST', body: { version_id: version.id, request_id: requestId, ...(!chatPending ? { message: capturedMessage } : {}), ...(chatId ? { chat_id: chatId } : {}) } });
    if (!active()) return;
    chatId = response.chat_id || chatId;
    if (response.queued === true || ['queued', 'processing', 'uncertain'].includes(response.status)) {
      chatPending = true;
      pendingQuestion = capturedMessage;
      chatButton.textContent = 'Check pending reply';
      question.disabled = true;
      message.textContent = 'Your provider chat reply is queued. Waiting for the actual response…';
      const started = Date.now();
      while (['queued', 'processing'].includes(response.status) && Date.now() - started < 60000) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (!active()) return;
        response = await api('/api/agent-builder/chat', { method: 'POST', body: { version_id: version.id, chat_id: chatId, request_id: requestId } });
        if (!active()) return;
      }
    }
    if (['queued', 'processing', 'uncertain'].includes(response.status)) throw Error('This chat reply is still processing or needs reconciliation. Submit again to check the same pending reply; no new message will be sent.');
    const reply = response.reply || response.message;
    if (response.ai_generated !== true || typeof reply !== 'string' || !reply.trim()) throw Error('The provider did not return a verified AI chat reply. No generated answer is available.');
    chatLog.append(el('p', `You: ${capturedMessage}`), el('p', `Agent: ${reply}`));
    completed(testSection, 'Private chat verified');
    chatPending = false;
    pendingQuestion = undefined;
    requestId = undefined;
    chatButton.textContent = 'Send test message';
    question.disabled = false;
    question.value = '';
    message.textContent = '';
  }, { disabled: !published });
  testSection.append(chatForm, chatLog);
  if (!published) testSection.append(el('p', 'Private AI chat becomes available after the provider confirms agent publication.'));


  const deployment = card(root, 5, 'Deploy when you are ready', 'Publication creates provider agents. Customer-facing chat and sales follow-up have separate activation controls.');
  if (version && data.deployment?.version_id === version.id) completed(deployment, 'Deployed');
  if (data.deployment?.version_id) deployment.append(el('p', `Current deployment: public AI chat is ${data.deployment.chat_enabled ? 'enabled on reviewed website origins' : 'off'}. Sales calls retain the own-contact pilot and pause controls.`));
  deployment.append(el('p', 'A successful test requires an actual provider call result. A booking requires a real calendar reservation; the agent cannot mark one booked simply by saying it is.'), sectionLink('Review website origins, widget and business settings →', 'settings'), sectionLink('Review eligible enquiries, pause controls and stops →', 'control'));
  const deployForm = el('form');
  const origins = field(deployForm, 'origins', 'Reviewed website origins · one HTTPS origin per line', (data.deployment?.origins || []).join('\n'), 'textarea');
  origins.rows = 3;
  origins.placeholder = 'https://your-business.com';
  const publicChat = field(deployForm, 'public_chat_enabled', 'Allow AI chat to reply automatically on these reviewed website origins.', '', 'checkbox');
  publicChat.checked = data.deployment?.chat_enabled === true;
  const deployConfirm = field(deployForm, 'deploy_confirmed', 'Activate this approved version for my installation. Keep existing pilot, pause and enquiry eligibility controls.', '', 'checkbox');
  deployConfirm.required = true;
  const embed = el('pre');
  embed.className = 'code agent-builder-embed';
  submit(deployForm, 'Deploy this approved version', async () => {
    if (!deployConfirm.checked) throw Error('Confirm deployment of this approved version first.');
    const reviewedOrigins = origins.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const result = await api('/api/agent-builder/deploy', { method: 'POST', body: { version_id: version.id, public_chat_enabled: publicChat.checked, origins: reviewedOrigins, confirmation: 'DEPLOY THIS APPROVED AGENT VERSION' } });
    if (!active()) return;
    message.textContent = `Approved agent version deployed. Public AI chat is ${result.public_chat_enabled ? 'enabled on the reviewed origins' : 'off'}. Existing call eligibility and pause controls still apply.`;
    let widgetCode = '';
    if (typeof result.widget_script === 'string') {
      if (result.widget_script.startsWith('<script')) widgetCode = result.widget_script;
      else if (result.workspace_id) {
        try {
          const scriptUrl = new URL(result.widget_script);
          if (scriptUrl.protocol !== 'https:' || scriptUrl.username || scriptUrl.password) throw Error();
          const attribute = value => String(value).replace(/[&"<>]/g, char => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[char]));
          widgetCode = `<script src="${attribute(scriptUrl.href)}" data-workspace="${attribute(result.workspace_id)}" defer></script>`;
        } catch { widgetCode = ''; }
      }
    }
    embed.textContent = widgetCode;
    deployConfirm.checked = false;
  }, { disabled: !published });
  deployment.append(deployForm, embed);
  if (data.deployment?.message) deployment.append(el('p', data.deployment.message));
  if (restore?.focus === 'review') {
    const target = approvedNotice || review;
    target.tabIndex = -1;
    target.focus?.({ preventScroll: true });
  }
  if (preserveLayout) restoreViewport(restore.viewport);
}

export const renderAgentBuilder = mountAgentBuilder;
