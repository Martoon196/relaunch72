/* Owner voice controls. No provider credentials or automatic live changes. */
const mounts = new WeakMap();
const el = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  return node;
};

export async function mountVoiceSettings(root, api, options = {}) {
  mounts.get(root)?.dispose();
  const token = {};
  let observer, audioUrl, audio;
  const clearPreview = () => {
    if (audio) { audio.pause?.(); audio.removeAttribute?.('src'); }
    if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = undefined; }
  };
  const dispose = () => { clearPreview(); observer?.disconnect(); if (mounts.get(root)?.token === token) mounts.delete(root); };
  mounts.set(root, { token, dispose });
  const active = () => {
    let current = false;
    try { current = options.isCurrent?.() !== false; } catch { /* Selection is no longer available. */ }
    return mounts.get(root)?.token === token && root.isConnected !== false && current;
  };
  if (typeof MutationObserver === 'function' && document.documentElement) {
    observer = new MutationObserver(() => { if (!active()) dispose(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  root.classList.add('voice-settings');
  const card = el('section'); card.className = 'card voice-settings-card';
  card.append(el('h2', 'Agent voice'), el('p', 'Choose a voice here. Save your choice, then explicitly apply it to your agent. Your approved instructions and knowledge stay unchanged.'));
  const notice = el('p'); notice.className = 'voice-settings-notice'; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  card.append(notice); root.replaceChildren(card);
  if (options.canRead !== true) {
    notice.textContent = 'Your role has no voice settings access for this business.';
    return { dispose };
  }
  const canList = (options.canCatalog ?? options.canLoadCatalog ?? options.canListVoices ?? options.canConfigure) === true;
  const canPreview = (options.canPreview ?? options.canConfigure) === true;
  const canSave = (options.canSaveChoice ?? options.canConfigure) === true;
  const canApply = (options.canApplyVoice ?? (options.canConfigure === true && options.canPublish === true)) === true;
  let state, voices = [], busy = false, loaded = false, revision = 0, requestId, requestVersion, nextOffset = null;
  const currentVoice = el('p'); currentVoice.className = 'voice-settings-current'; card.append(currentVoice);
  const filters = el('div'); filters.className = 'voice-settings-filters';
  const filter = (name, title) => {
    const wrap = el('label'); wrap.className = 'field'; const node = el('select'); node.name = name;
    const blank = el('option', 'All ' + title.toLowerCase()); blank.value = ''; node.append(blank);
    wrap.append(el('span', title), node); filters.append(wrap); return node;
  };
  const provider = filter('voice_provider', 'Providers'), gender = filter('voice_gender', 'Genders'), accent = filter('voice_accent', 'Accents');
  const queryLabel = el('label'); queryLabel.className = 'field'; const query = el('input'); query.name = 'voice_query'; query.type = 'search'; query.maxLength = 120;
  queryLabel.append(el('span', 'Search voice name'), query); filters.append(queryLabel); card.append(filters);
  const loadVoices = el('button', 'Load available voices'); loadVoices.type = 'button'; loadVoices.className = 'btn';
  const label = el('label'); label.className = 'field';
  const selected = el('select'); selected.name = 'agent_voice';
  label.append(el('span', 'Voice choice'), selected); card.append(loadVoices, label);
  const more = el('button', 'Load more voices'); more.type = 'button'; more.className = 'btn small'; more.hidden = true; card.append(more);
  const catalogStatus = el('p'); catalogStatus.className = 'voice-settings-catalog-status'; catalogStatus.setAttribute('role', 'status'); card.append(catalogStatus);
  const preview = el('button', 'Hear selected voice'); preview.type = 'button'; preview.className = 'btn'; card.append(preview);
  audio = el('audio'); audio.controls = true; audio.preload = 'none'; audio.hidden = true; card.append(audio);
  const save = el('button', 'Save voice choice'); save.type = 'button'; save.className = 'btn'; card.append(save);
  const applyForm = el('form'); applyForm.className = 'voice-settings-apply';
  const confirmLabel = el('label'); confirmLabel.className = 'check';
  const confirm = el('input'); confirm.type = 'checkbox'; confirm.name = 'voice_apply_confirmed'; confirm.required = true;
  confirmLabel.append(confirm, el('span', 'Apply my saved voice choice to a new published voice version. Keep the current instructions and knowledge.'));
  const apply = el('button', 'Apply voice to agent'); apply.type = 'submit'; apply.className = 'btn primary';
  applyForm.append(confirmLabel, apply); card.append(applyForm);
  const refresh = el('button', 'Check voice status'); refresh.type = 'button'; refresh.className = 'btn small'; card.append(refresh);

  function message(text, error = false) {
    notice.textContent = text; notice.setAttribute('role', error ? 'alert' : 'status');
    notice.setAttribute('data-state', error ? 'error' : 'success');
  }
  function controls() {
    const changed = selected.value !== (state?.saved_voice?.voice_id || '');
    loadVoices.disabled = busy || !loaded || !canList || !state?.verified;
    selected.disabled = busy || !loaded || (!canSave && !canPreview) || !!requestId;
    save.disabled = busy || !loaded || !canSave || !selected.value || !changed || !!requestId;
    for (const node of [provider, gender, accent, query]) node.disabled = busy || !loaded || !canList;
    more.disabled = busy || !loaded || !canList || nextOffset === null;
    preview.disabled = busy || !loaded || !canPreview || !selected.value;
    confirm.disabled = busy || !canApply || changed || !state?.can_apply || !!requestId;
    apply.disabled = busy || !loaded || !canApply || changed || (!requestId && !state?.can_apply);
    refresh.disabled = busy || !loaded;
  }
  function choices(value = '') {
    const previous = selected.value;
    const blank = el('option', 'Choose a voice'); blank.value = '';
    const entries = [blank];
    for (const voice of voices) {
      const option = el('option', [voice.voice_name, voice.accent, voice.gender].filter(Boolean).join(' · '));
      option.value = voice.voice_id; option.disabled = voice.supported === false; entries.push(option);
    }
    const saved = state?.saved_voice;
    if (saved?.voice_id && !voices.some(voice => voice.voice_id === saved.voice_id)) {
      const option = el('option', saved.voice_name || 'Saved voice'); option.value = saved.voice_id; entries.push(option);
    }
    selected.replaceChildren(...entries); selected.value = entries.some(option => option.value === value) ? value : '';
    if (selected.value !== previous) { revision++; clearPreview(); audio.hidden = true; confirm.checked = false; }
  }
  function showCurrent() {
    if (!state.published) currentVoice.textContent = 'Create and publish your first agent before applying a different voice.';
    else {
      const id = state.published.voice_id;
      const name = state.published.voice_name || voices.find(voice => voice.voice_id === id)?.voice_name
        || (state.saved_voice?.voice_id === id ? state.saved_voice.voice_name : 'Previous voice');
      currentVoice.textContent = `Published voice: ${name || 'Current voice'}.`;
      if (state.saved_voice?.voice_id && state.saved_voice.voice_id !== id) currentVoice.textContent += ' A different saved choice is ready to apply.';
    }
  }
  async function readStatus() {
    const next = await api('/api/agent-builder/voice-settings', { guard: active });
    if (!active()) return;
    if (next.outreach_started !== false) throw Error('The server did not confirm these voice settings.');
    state = next; loaded = true;
    choices(state.saved_voice?.voice_id || ''); showCurrent();
  }
  selected.onchange = () => {
    if (!active() || busy || requestId) return;
    revision++; clearPreview(); audio.hidden = true; confirm.checked = false; controls();
    message('Voice choice changed. Save it first; your published agent is unchanged.');
  };
  function updateFacets(node, items) {
    const current = node.value; const blank = el('option', 'All'); blank.value = '';
    const entries = [blank];
    for (const value of items) { const option = el('option', value); option.value = value; entries.push(option); }
    node.replaceChildren(...entries); node.value = items.includes(current) ? current : '';
  }
  const filterBody = () => ({ provider: provider.value, gender: gender.value, accent: accent.value, query: query.value.trim() });
  async function readCatalog(offset = 0) {
    if (!active() || busy || loadVoices.disabled) return;
    const selectedValue = selected.value, body = { ...filterBody(), offset }, captured = revision;
    const current = () => active() && captured === revision && JSON.stringify(filterBody()) === JSON.stringify({ provider: body.provider, gender: body.gender, accent: body.accent, query: body.query });
    busy = true; controls(); message('Loading your available voices…');
    try {
      const data = await api('/api/agent-builder/voice-catalog', { method: 'POST', body, guard: current });
      if (!current()) return;
      if (!Array.isArray(data.voices) || data.voices.length > 200 || data.outreach_started !== false
        || !data.facets || !['providers', 'genders', 'accents'].every(key => Array.isArray(data.facets[key]) && data.facets[key].length <= 2000 && data.facets[key].every(value => typeof value === 'string' && value.length <= 120))
        || data.voices.some(voice => !voice || typeof voice.voice_id !== 'string' || typeof voice.voice_name !== 'string')
        || !Number.isSafeInteger(data.total) || data.total < 0 || data.total > 2000 || !(data.next_offset === null || (Number.isSafeInteger(data.next_offset) && data.next_offset > offset && data.next_offset <= 2000))) throw Error('The provider did not return a confirmed voice list.');
      voices = offset === 0 ? data.voices : [...voices, ...data.voices.filter(item => !voices.some(old => old.voice_id === item.voice_id))];
      nextOffset = data.next_offset; more.hidden = nextOffset === null;
      updateFacets(provider, data.facets.providers); updateFacets(gender, data.facets.genders); updateFacets(accent, data.facets.accents);
      choices(selectedValue); showCurrent(); catalogStatus.textContent = `${data.total} matching voice(s). ${voices.length} shown.`;
      message('Voices loaded. Hear a preview, choose one and save it. Applying is a separate step.');
    } catch (error) { if (current()) message(error.message || 'Could not load voices.', true); }
    finally { busy = false; if (active()) controls(); }
  }
  loadVoices.onclick = () => readCatalog();
  more.onclick = () => nextOffset === null ? undefined : readCatalog(nextOffset);
  for (const node of [provider, gender, accent]) node.onchange = () => { if (!busy && active()) { revision++; return readCatalog(); } };
  query.oninput = () => { if (!busy && active()) revision++; };
  preview.onclick = async () => {
    if (!active() || busy || preview.disabled) return;
    const voiceId = selected.value, captured = revision;
    const current = () => active() && captured === revision && selected.value === voiceId;
    busy = true; controls(); clearPreview(); audio.hidden = true; message('Loading this voice preview…');
    try {
      const data = await api('/api/agent-builder/voice-preview', { method: 'POST', body: { voice_id: voiceId }, guard: current });
      if (!current()) return;
      if (data.voice_id !== voiceId || data.outreach_started !== false || typeof data.audio_base64 !== 'string' || data.audio_base64.length > 699052 || !['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4'].includes(data.mime)) throw Error('The server did not confirm a safe audio preview.');
      const raw = atob(data.audio_base64); if (!raw.length || raw.length > 524288) throw Error('This voice preview is too large or empty.');
      const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
      audioUrl = URL.createObjectURL(new Blob([bytes], { type: data.mime })); audio.src = audioUrl; audio.hidden = false;
      message('Preview ready. Press play to listen. Your saved choice and live agent are unchanged.');
      try { await audio.play?.(); } catch { /* Native controls remain available after autoplay restrictions. */ }
    } catch (error) { if (current()) message(error.message || 'Could not load this voice preview.', true); }
    finally { busy = false; if (active()) controls(); }
  };
  save.onclick = async () => {
    if (!active() || busy || save.disabled || requestId) return;
    const voiceId = selected.value, captured = revision;
    if (!voices.some(voice => voice.voice_id === voiceId)) { message('Choose a voice from the available list.', true); return; }
    const current = () => active() && revision === captured && selected.value === voiceId;
    busy = true; controls(); message('Verifying and saving your voice choice…');
    try {
      const result = await api('/api/agent-builder/voice-choice', { method: 'POST', body: { voice_id: voiceId }, guard: current });
      if (!current()) return;
      if (result.saved !== true || result.voice_id !== voiceId || result.outreach_started !== false) throw Error('The server did not confirm this saved choice. Check voice status before continuing.');
      await readStatus(); if (active()) message('Voice choice saved. Your published agent has not changed. Tick the approval below to apply it.');
    } catch (error) { if (current()) message(error.message || 'Could not save this voice choice.', true); }
    finally { busy = false; if (active()) controls(); }
  };
  applyForm.onsubmit = async event => {
    event.preventDefault();
    if (!active() || busy || apply.disabled) return;
    if (!requestId) {
      if (!confirm.checked) { message('Confirm that you want to apply your saved choice.', true); return; }
      if (!globalThis.crypto?.randomUUID) { message('Use a secure HTTPS browser to apply this choice.', true); return; }
      requestId = globalThis.crypto.randomUUID(); requestVersion = state.published.version_id;
    }
    busy = true; controls(); apply.textContent = 'Check this voice request'; message('Checking your explicit voice update…');
    try {
      const result = await api('/api/agent-builder/voice-apply', { method: 'POST', body: {
        version_id: requestVersion, request_id: requestId, confirmation: 'APPLY VERIFIED VOICE TO MY AGENT'
      }, guard: active });
      if (!active()) return;
      if (result.operation_id !== requestId || typeof result.version_id !== 'string' || result.outreach_started !== false) throw Error('The voice update was not confirmed. Check this same request before continuing.');
      confirm.checked = false;
      message(result.unchanged ? 'This voice is already applied. Your agent is unchanged.'
        : result.status === 'published' ? 'Your selected voice is published. Your instructions and knowledge stayed unchanged.'
          : ['failed', 'uncertain'].includes(result.status) ? 'This voice update needs review. Check the agent status before making another request.'
            : 'Your voice update is processing. Your current published agent stays available until the new voice is confirmed.');
      if (result.status === 'published') {
        await readStatus();
        if (!active()) return;
        requestId = undefined; requestVersion = undefined; apply.textContent = 'Apply voice to agent';
      }
    } catch (error) { if (active()) message(error.message || 'Could not confirm this voice request. Check the same request before continuing.', true); }
    finally { busy = false; if (active()) controls(); }
  };
  refresh.onclick = async () => {
    if (!active() || busy || !loaded) return;
    busy = true; controls();
    try { await readStatus(); if (active()) message(state.blocker || 'Voice status checked. Saving a choice never changes the live agent.'); }
    catch (error) { if (active()) message(error.message || 'Could not check voice status.', true); }
    finally { busy = false; if (active()) controls(); }
  };
  try {
    await readStatus(); if (active()) message(state.blocker || 'Choose a voice. Your agent changes only after explicit Apply.');
  } catch (error) { if (active()) message(error.message || 'Could not load voice settings.', true); }
  if (active()) controls();
  return { dispose };
}
