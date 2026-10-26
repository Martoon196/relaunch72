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
  title.append(el('h2', 'Connect the AI provider'), el('p', 'Connect Retell here. LeadRelay then creates your chat and call agents through its API using your approved business knowledge.'));
  const badge = el('span', 'Not connected'); badge.className = 'provider-setup-badge';
  heading.append(title, badge); card.append(heading);
  card.append(el('p', 'Connections and caller numbers are saved per business. Switching businesses keeps their connections intact and never copies credentials. A new business needs its own API setup; you can scan and review its website first.'));
  card.append(el('p', 'Retell browser login does not connect this workspace to its API. The check below reads only the API connection already saved here.'));
  const steps = el('ol');
  steps.append(
    el('li', 'In Retell, open System Settings → API Keys and copy your API key.'),
    el('li', 'Return here and paste the API key and designated webhook verification key into their separate secure fields.'),
    el('li', 'Load available voices, choose your agent voice, then Verify and save connection.')
  );
  card.append(steps);
  const account = el('a', 'Open Retell to copy API access keys');
  account.href = 'https://dashboard.retellai.com/'; account.target = '_blank'; account.rel = 'noopener noreferrer';
  card.append(account);
  const notice = el('p'); notice.className = 'provider-setup-notice'; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const refreshLabel = 'Check saved API connection';
  const refresh = el('button', refreshLabel); refresh.type = 'button'; refresh.className = 'btn small';
  card.append(notice, refresh); root.replaceChildren(card);
  const canRead = options.canRead === true;
  const canList = options.canListVoices === true || options.canConfigure === true;
  const canListNumbers = options.canListNumbers === true || options.canConfigure === true;
  const canVerify = options.canVerify === true || options.canConfigure === true;
  if (!canRead) {
    notice.textContent = 'Your role has no connection access for this business. Ask its owner to grant access.';
    refresh.disabled = true;
    return { dispose };
  }
  let saved = { verified: false, has_secret: false, has_webhook_secret: false, config: {} };
  let loaded = false, busy = false, revision = 0, checks = 0;
  let voices = [], phoneNumbers = [];
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
  const draftNotice = el('p', 'These typed credentials are not saved yet. Use Load available voices, choose a voice, then Verify and save connection. The saved-connection check is disabled so it cannot discard your entry.');
  draftNotice.hidden = true;
  form.append(draftNotice);
  form.append(el('p', 'Use the API key designated by Retell for webhook verification. It may be the same designated key, but it is not inferred from another API key. Credentials are encrypted server-side and never shown again.'));
  const list = el('button', 'Load available voices'); list.type = 'button'; list.className = 'btn'; form.append(list);
  const voiceLabel = el('label'); voiceLabel.className = 'field';
  const voice = el('select'); voice.name = 'voice_id'; voice.required = true;
  voiceLabel.append(el('span', 'Agent voice'), voice); form.append(voiceLabel);
  const numbers = el('button', 'Load my caller numbers'); numbers.type = 'button'; numbers.className = 'btn'; form.append(numbers);
  const callerLabel = el('label'); callerLabel.className = 'field';
  const caller = el('select'); caller.name = 'from_number';
  callerLabel.append(el('span', 'Owned caller number · optional for private chat'), caller); form.append(callerLabel);
  const callerStatus = el('p', 'Load your existing Retell caller numbers to prepare a phone test. Leave this blank for private chat. This step buys no number and starts no call.');
  callerStatus.className = 'provider-setup-caller-status'; callerStatus.setAttribute('role', 'status'); callerStatus.setAttribute('aria-live', 'polite'); form.append(callerStatus);
  const verify = el('button', 'Verify and save connection'); verify.type = 'submit'; verify.className = 'btn primary'; form.append(verify);
  if (canList || canListNumbers || canVerify) card.append(form);
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
    numbers.disabled = busy || !loaded || !canListNumbers;
    verify.disabled = busy || !loaded || !canVerify || !voice.value;
    const typedCredentials = !!(key.value.trim() || webhook.value.trim());
    refresh.disabled = busy || typedCredentials;
    draftNotice.hidden = !typedCredentials;
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
  function allowedCallers() {
    const result = new Set(phoneNumbers.map(item => item.phone_number));
    if (!key.value.trim() && saved.config.from_number) result.add(saved.config.from_number);
    return result;
  }
  function callerOptions(selected = '') {
    const blank = el('option', 'No caller number · private chat only'); blank.value = '';
    const entries = [blank];
    for (const item of phoneNumbers) {
      const option = el('option', [item.nickname || item.phone_number, item.nickname ? item.phone_number : ''].filter(Boolean).join(' · '));
      option.value = item.phone_number; entries.push(option);
    }
    const storedCaller = !key.value.trim() && saved.config.from_number;
    if (storedCaller && !phoneNumbers.some(item => item.phone_number === storedCaller)) {
      const option = el('option', `Saved caller · ${storedCaller}`); option.value = storedCaller; entries.push(option);
    }
    caller.replaceChildren(...entries);
    caller.value = allowedCallers().has(selected) ? selected : '';
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
    busy = true; controls(); refresh.textContent = 'Checking saved API connection…'; message('Checking only this workspace’s saved API connection…');
    try {
      const response = await api('/api/agent-builder/connection');
      if (!active()) return;
      saved = { verified: response.verified === true, has_secret: response.has_secret === true, has_webhook_secret: response.has_webhook_secret === true, config: response.config || {} };
      loaded = true; voiceOptions(saved.config.voice_id || ''); callerOptions(saved.config.from_number || '');
      checks++;
      showStatus();
      const result = badge.textContent === 'Connected and verified'
        ? 'Saved Retell API connection is verified. Agent creation remains a separate explicit step.'
        : !saved.has_secret
          ? 'No Retell API key saved. Retell browser login does not connect this workspace. Copy your key from System Settings → API Keys in Retell, paste it below, load voices and verify.'
          : 'An encrypted API key is saved, but this connection is not verified. Choose a voice and verify the connection below.';
      message(`Saved API check #${checks} complete. ${result}`);
    } catch (error) { if (active()) message(failureText(error), true); }
    finally { busy = false; if (active()) { refresh.textContent = refreshLabel; controls(); } }
  }
  key.oninput = () => {
    if (!active()) return;
    // A typed verification key belongs to the prior credential entry. Never
    // accidentally pair it with a newly entered API account/key.
    webhook.value = '';
    revision++; voices = []; phoneNumbers = []; voiceOptions(''); callerOptions(''); controls();
    callerStatus.textContent = 'API key changed. Load caller numbers for this account before selecting a number.';
    badge.textContent = 'Changes not verified'; card.classList.toggle('provider-setup-verified', false);
    message('Load voices for this API key before saving the connection.');
  };
  webhook.oninput = () => {
    if (!active()) return;
    revision++;
    badge.textContent = 'Changes not verified'; card.classList.toggle('provider-setup-verified', false);
    controls();
    message('Verification key changed. Verify and save the connection to apply it.');
  };
  voice.onchange = controls;
  caller.onchange = () => {
    if (!active()) return;
    badge.textContent = 'Changes not verified'; card.classList.toggle('provider-setup-verified', false);
    controls(); message('Caller selection changed. Verify and save to apply it; no call has started.');
  };
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
  numbers.onclick = async () => {
    if (!active() || busy || !loaded || !canListNumbers) return;
    const capturedRevision = revision, secret = key.value.trim();
    const requestCurrent = () => active() && capturedRevision === revision && key.value.trim() === secret;
    if (!secret && !saved.has_secret) { message('Enter your Retell API key securely first.', true); return; }
    busy = true; controls(); callerStatus.textContent = 'Reading your existing caller numbers from Retell…';
    try {
      const result = await api('/api/agent-builder/connection/phone-numbers', { method: 'POST', body: secret ? { secret } : {}, guard: requestCurrent });
      if (!requestCurrent()) return;
      if (!Array.isArray(result.phone_numbers) || result.phone_numbers.length > 100 || typeof result.truncated !== 'boolean' || result.outreach_started === true
          || result.phone_numbers.some(item => !item || typeof item.phone_number !== 'string' || !/^\+[1-9]\d{6,14}$/.test(item.phone_number))) throw Error('Retell did not return a valid caller-number list. No connection was changed.');
      phoneNumbers = result.phone_numbers;
      const selected = caller.value;
      callerOptions(selected);
      callerStatus.textContent = phoneNumbers.length
        ? `${phoneNumbers.length} existing caller number(s) loaded.${result.truncated ? ' This is a partial list; Retell reports more numbers in the account.' : ''} Select one and verify/save before a phone test. No number was bought and no call was started.`
        : result.truncated
          ? 'No caller numbers were returned on this page, but Retell reports more inventory. Check the account inventory; private chat still works without a caller number.'
          : 'No existing caller number found in this Retell account. Private chat works without one. Adding or buying a caller number needs separate owner approval; no purchase was made here.';
      message('Caller-number inventory checked. The saved connection is unchanged until you verify and save.');
    } catch (error) { if (requestCurrent()) { callerStatus.textContent = failureText(error, [secret]); message('Caller numbers could not be loaded. No connection was changed.', true); } }
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
    if (caller.value && !allowedCallers().has(caller.value)) { message('Choose an owned caller number returned for this account, or leave the number blank for private chat.', true); return; }
    const body = { voice_id: voice.value, from_number: caller.value.trim() };
    const requestCurrent = () => active() && capturedRevision === revision && key.value.trim() === secret
      && webhook.value.trim() === webhookSecret && voice.value === body.voice_id && caller.value.trim() === body.from_number;
    if (secret) body.secret = secret;
    if (webhookSecret) body.webhook_secret = webhookSecret;
    busy = true; controls(); message('Verifying the account and selected voice…');
    try {
      const result = await api('/api/agent-builder/connection/verify', { method: 'POST', body, guard: requestCurrent });
      if (!requestCurrent()) {
        if (active()) message('The setup changed while verification was pending. Check the saved API connection after clearing unsaved credential entries to confirm its saved result.', true);
        return;
      }
      if (result.verified !== true || !result.config?.voice_id || result.outreach_started === true) throw Error('The server did not confirm this connection. Refresh its status before continuing.');
      clearSecrets(); saved = { verified: true, has_secret: true, has_webhook_secret: true, config: result.config };
      voiceOptions(result.config.voice_id); callerOptions(result.config.from_number || ''); showStatus();
      message('Connection verified and saved. You can now create your chat and call agents from the approved business facts.');
      if (options.onVerified) {
        try { await options.onVerified(result); }
        catch { if (active()) message('Connection verified and saved. Refresh your agent status to continue.'); }
      }
    } catch (error) { if (requestCurrent()) message(failureText(error, [secret, webhookSecret]), true); }
    finally { busy = false; if (active()) controls(); }
  };
  refresh.onclick = async () => {
    if (!active() || busy) return;
    if (key.value.trim() || webhook.value.trim()) {
      controls();
      message('Your typed credentials are not saved. Use Load available voices and Verify and save connection, or clear the credential fields before checking the saved API connection.');
      return;
    }
    revision++; voices = []; phoneNumbers = []; await loadStatus();
  };
  voiceOptions(); callerOptions(); controls(); await loadStatus();
  return { dispose };
}
