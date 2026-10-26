/* Native provider setup: credentials go only to the current authorised server. */
const mounts = new WeakMap();
const el = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  return node;
};

export async function mountProviderSetup(root, api, options = {}) {
  mounts.get(root)?.dispose();
  const token = {};
  let observer;
  let key, webhook;
  const clearSecrets = () => { if (key) key.value = ''; if (webhook) webhook.value = ''; };
  const dispose = () => {
    clearSecrets();
    observer?.disconnect();
    if (mounts.get(root)?.token === token) mounts.delete(root);
  };
  mounts.set(root, { token, dispose });
  const active = () => {
    let selected = false;
    try { selected = options.isCurrent?.() !== false; } catch { /* Lost selection is inactive. */ }
    const current = mounts.get(root)?.token === token && root.isConnected !== false && selected;
    if (!current) clearSecrets();
    return current;
  };
  if (typeof MutationObserver === 'function' && document.documentElement) {
    observer = new MutationObserver(() => { if (!active()) dispose(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  root.classList.add('provider-setup');
  const card = el('section'); card.className = 'card provider-setup-card';
  const heading = el('div'); heading.className = 'provider-setup-heading';
  const title = el('div');
  title.append(el('h2', 'Connect the AI provider'), el('p', 'Connect Retell here. Growth HQ then creates your chat and call agents through its API using your approved business knowledge.'));
  const badge = el('span', 'Not connected'); badge.className = 'provider-setup-badge';
  heading.append(title, badge); card.append(heading);
  card.append(el('p', 'A Retell account and API access are the one-time account step. Agent setup, voice selection and creation are managed here; provider billing and account verification remain with Retell.'));
  const account = el('a', 'Open Retell account / API access');
  account.href = 'https://dashboard.retellai.com/'; account.target = '_blank'; account.rel = 'noopener noreferrer';
  card.append(account);
  const notice = el('p'); notice.className = 'provider-setup-notice'; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const refresh = el('button', 'Refresh connection'); refresh.type = 'button'; refresh.className = 'btn small';
  card.append(notice, refresh); root.replaceChildren(card);
  const canRead = options.canRead === true;
  const canList = options.canListVoices === true || options.canConfigure === true;
  const canVerify = options.canVerify === true || options.canConfigure === true;
  if (!canRead) {
    notice.textContent = 'Your role has no connection access for this business. Ask its owner to grant access.';
    refresh.disabled = true;
    return { dispose };
  }
  let saved = { verified: false, has_secret: false, has_webhook_secret: false, config: {} };
  let loaded = false, busy = false, revision = 0;
  let voices = [];
  const form = el('form'); form.className = 'provider-setup-form';
  const field = (name, label, type = 'text') => {
    const wrapper = el('label'); wrapper.className = 'field';
    const input = el('input'); input.name = name; input.type = type;
    input.autocomplete = type === 'password' ? 'new-password' : 'off';
    wrapper.append(el('span', label), input); form.append(wrapper);
    return input;
  };
  key = field('secret', 'Retell API key · blank reuses the encrypted saved key', 'password'); key.maxLength = 10000;
  webhook = field('webhook_secret', 'Retell webhook verification key · blank keeps the saved key', 'password'); webhook.maxLength = 10000;
  form.append(el('p', 'Use the API key designated by Retell for webhook verification. It may be the same designated key, but it is not inferred from another API key. Credentials are encrypted server-side and never shown again.'));
  const list = el('button', 'Load available voices'); list.type = 'button'; list.className = 'btn'; form.append(list);
  const voiceLabel = el('label'); voiceLabel.className = 'field';
  const voice = el('select'); voice.name = 'voice_id'; voice.required = true;
  voiceLabel.append(el('span', 'Agent voice'), voice); form.append(voiceLabel);
  const caller = field('from_number', 'Existing owned caller number · optional for chat', 'tel'); caller.maxLength = 20;
  form.append(el('p', 'Leave the caller number blank for private chat. Phone tests need an existing authorised number; this connection step buys no number and starts no call.'));
  const verify = el('button', 'Verify and save connection'); verify.type = 'submit'; verify.className = 'btn primary'; form.append(verify);
  if (canList || canVerify) card.append(form);
  else card.append(el('p', 'Connection details are read-only for your role.'));
  function message(text, error = false) {
    notice.textContent = text;
    notice.setAttribute('role', error ? 'alert' : 'status');
    notice.setAttribute('data-error', error ? 'true' : 'false');
  }
  function failureText(error, submitted = []) {
    let text = error?.message || 'The provider request could not be completed.';
    for (const secret of [key.value, webhook.value, ...submitted]) {
      if (secret) text = text.split(secret).join('[redacted]');
    }
    return text;
  }
  function controls() {
    key.disabled = webhook.disabled = caller.disabled = busy || !loaded;
    voice.disabled = busy || !loaded || (!voices.length && !voice.value);
    list.disabled = busy || !loaded || !canList;
    verify.disabled = busy || !loaded || !canVerify || !voice.value;
    refresh.disabled = busy;
  }
  function voiceOptions(selected = '') {
    const placeholder = el('option', voices.length ? 'Select a voice' : 'Load voices to choose'); placeholder.value = '';
    const entries = [placeholder];
    for (const item of voices) {
      const detail = [item.voice_name || item.voice_id, item.accent, item.gender].filter(Boolean).join(' · ');
      const option = el('option', detail); option.value = item.voice_id; entries.push(option);
    }
    if (selected && !voices.some(item => item.voice_id === selected)) {
      const option = el('option', `Saved voice · ${selected}`); option.value = selected; entries.push(option);
    }
    voice.replaceChildren(...entries); voice.value = selected;
  }
  function showStatus() {
    const verified = saved.verified === true && saved.has_secret === true && typeof saved.config?.voice_id === 'string' && !!saved.config.voice_id;
    card.classList.toggle('provider-setup-verified', verified);
    badge.textContent = verified ? 'Connected and verified' : 'Not connected';
    key.placeholder = saved.has_secret ? 'Encrypted key saved' : 'Paste your API key securely';
    webhook.placeholder = saved.has_webhook_secret ? 'Verification key saved' : 'Paste the designated webhook key securely';
  }
  async function loadStatus() {
    if (!active() || busy) return;
    busy = true; controls(); message('Checking the saved connection…');
    try {
      const response = await api('/api/agent-builder/connection');
      if (!active()) return;
      saved = { verified: response.verified === true, has_secret: response.has_secret === true, has_webhook_secret: response.has_webhook_secret === true, config: response.config || {} };
      loaded = true; voiceOptions(saved.config.voice_id || ''); caller.value = saved.config.from_number || '';
      showStatus(); message(badge.textContent === 'Connected and verified' ? 'Saved Retell connection verified. Agent creation remains a separate explicit step.' : 'Connect your account, choose a voice, then verify and save. No agent or call starts during verification.');
    } catch (error) { if (active()) message(failureText(error), true); }
    finally { busy = false; if (active()) controls(); }
  }
  key.oninput = () => {
    if (!active()) return;
    // A typed verification key belongs to the prior credential entry. Never
    // accidentally pair it with a newly entered API account/key.
    webhook.value = '';
    revision++; voices = []; voiceOptions(''); controls();
    badge.textContent = 'Changes not verified'; card.classList.toggle('provider-setup-verified', false);
    message('Load voices for this API key before saving the connection.');
  };
  webhook.oninput = () => {
    if (!active()) return;
    revision++;
    badge.textContent = 'Changes not verified'; card.classList.toggle('provider-setup-verified', false);
    message('Verification key changed. Verify and save the connection to apply it.');
  };
  voice.onchange = controls;
  list.onclick = async () => {
    if (!active() || busy || !loaded || !canList) return;
    const capturedRevision = revision, secret = key.value.trim();
    const requestCurrent = () => active() && capturedRevision === revision && key.value.trim() === secret;
    if (!secret && !saved.has_secret) { message('Enter your Retell API key securely first.', true); return; }
    busy = true; controls(); message('Reading available voices from Retell…');
    try {
      const result = await api('/api/agent-builder/connection/voices', { method: 'POST', body: secret ? { secret } : {}, guard: requestCurrent });
      if (!requestCurrent()) return;
      if (!Array.isArray(result.voices) || result.voices.length > 200 || result.voices.some(item => !item || typeof item.voice_id !== 'string' || !item.voice_id || item.voice_id.length > 120)) throw Error('Retell did not return a valid voice list. No connection was changed.');
      voices = result.voices;
      const selected = voices.some(item => item.voice_id === voice.value) ? voice.value : '';
      voiceOptions(selected); message(voices.length ? `${voices.length} voices loaded. Choose your agent voice, then verify and save.` : 'No voices were returned. Check the API key permissions in Retell.');
    } catch (error) { if (requestCurrent()) message(failureText(error, [secret]), true); }
    finally { busy = false; if (active()) controls(); }
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (!active() || busy || !loaded || !canVerify) return;
    if (form.reportValidity && !form.reportValidity()) return;
    const secret = key.value.trim(), webhookSecret = webhook.value.trim();
    const capturedRevision = revision;
    if (!secret && !saved.has_secret) { message('Enter your Retell API key securely first.', true); return; }
    if (!webhookSecret && !saved.has_webhook_secret) { message('Enter the designated Retell webhook verification key securely.', true); return; }
    if (!voice.value) { message('Load the available voices and choose one before saving.', true); return; }
    const body = { voice_id: voice.value, from_number: caller.value.trim() };
    const requestCurrent = () => active() && capturedRevision === revision && key.value.trim() === secret
      && webhook.value.trim() === webhookSecret && voice.value === body.voice_id && caller.value.trim() === body.from_number;
    if (secret) body.secret = secret;
    if (webhookSecret) body.webhook_secret = webhookSecret;
    busy = true; controls(); message('Verifying the account and selected voice…');
    try {
      const result = await api('/api/agent-builder/connection/verify', { method: 'POST', body, guard: requestCurrent });
      if (!requestCurrent()) {
        if (active()) message('The setup changed while verification was pending. Refresh connection to check the saved result before continuing.', true);
        return;
      }
      if (result.verified !== true || !result.config?.voice_id || result.outreach_started === true) throw Error('The server did not confirm this connection. Refresh its status before continuing.');
      clearSecrets(); saved = { verified: true, has_secret: true, has_webhook_secret: true, config: result.config };
      voiceOptions(result.config.voice_id); caller.value = result.config.from_number || ''; showStatus();
      message('Connection verified and saved. You can now create your chat and call agents from the approved business facts.');
      if (options.onVerified) {
        try { await options.onVerified(result); }
        catch { if (active()) message('Connection verified and saved. Refresh your agent status to continue.'); }
      }
    } catch (error) { if (requestCurrent()) message(failureText(error, [secret, webhookSecret]), true); }
    finally { busy = false; if (active()) controls(); }
  };
  refresh.onclick = async () => { clearSecrets(); revision++; voices = []; await loadStatus(); };
  voiceOptions(); controls(); await loadStatus();
  return { dispose };
}
