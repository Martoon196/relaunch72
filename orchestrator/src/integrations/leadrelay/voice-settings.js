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
  let observer, audioUrl, audio, pollTimer;
  const clearPreview = () => {
    if (audio) { audio.pause?.(); audio.removeAttribute?.('src'); }
    if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = undefined; }
  };
  const dispose = () => { clearPreview(); if (pollTimer !== undefined) clearTimeout(pollTimer); observer?.disconnect(); if (mounts.get(root)?.token === token) mounts.delete(root); };
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
  let state, voices = [], busy = false, loaded = false, revision = 0, requestId, requestVersion, resultVersion, nextOffset = null;
  let pollAttempts = 0, pollStarted = 0, applyPhase = 'info';
  const voiceNames = new Map();
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
  const saveArea = el('section'); saveArea.className = 'voice-settings-save';
  const save = el('button', 'Save voice choice'); save.type = 'button'; save.className = 'btn';
  const saveNotice = el('p'); saveNotice.className = 'voice-settings-feedback'; saveNotice.setAttribute('role', 'status'); saveNotice.setAttribute('aria-live', 'polite');
  saveArea.append(el('h3', '1. Save your choice'), el('p', 'Saving verifies the voice and keeps it ready. Your published agent changes in step 2.'), save, saveNotice); card.append(saveArea);
  const applyForm = el('form'); applyForm.className = 'voice-settings-apply';
  const confirmLabel = el('label'); confirmLabel.className = 'check';
  const confirm = el('input'); confirm.type = 'checkbox'; confirm.name = 'voice_apply_confirmed'; confirm.required = true;
  confirmLabel.append(confirm, el('span', 'Apply my saved voice choice to a new published voice version. Keep the current instructions and knowledge.'));
  const apply = el('button', 'Apply voice to agent'); apply.type = 'submit'; apply.className = 'btn primary';
  const applyNotice = el('p'); applyNotice.className = 'voice-settings-feedback'; applyNotice.setAttribute('role', 'status'); applyNotice.setAttribute('aria-live', 'polite');
  applyForm.append(el('h3', '2. Apply to your agent'), confirmLabel, apply, applyNotice); card.append(applyForm);
  const refresh = el('button', 'Check voice status'); refresh.type = 'button'; refresh.className = 'btn small'; card.append(refresh);

  function feedback(node, text, phase = 'info') {
    node.textContent = text; node.setAttribute('role', phase === 'error' ? 'alert' : 'status');
    node.setAttribute('data-state', phase); node.setAttribute('aria-busy', String(phase === 'pending'));
    if (node === applyNotice) applyPhase = phase;
  }
  function message(text, error = false, phase = error ? 'error' : 'info') {
    feedback(notice, text, phase);
  }
  function alreadyApplied() {
    return !!state?.published?.voice_id && state.published.voice_id === state?.saved_voice?.voice_id;
  }
  function controls() {
    const changed = selected.value !== (state?.saved_voice?.voice_id || '');
    card.setAttribute('aria-busy', String(busy));
    loadVoices.disabled = busy || !loaded || !canList || !state?.verified || !!requestId;
    selected.disabled = busy || !loaded || (!canSave && !canPreview) || !!requestId;
    save.disabled = busy || !loaded || !canSave || !selected.value || !changed || !!requestId;
    for (const node of [provider, gender, accent, query]) node.disabled = busy || !loaded || !canList || !!requestId;
    more.disabled = busy || !loaded || !canList || nextOffset === null || !!requestId;
    preview.disabled = busy || !loaded || !canPreview || !selected.value;
    confirm.disabled = busy || !canApply || changed || !state?.can_apply || !!requestId || alreadyApplied();
    apply.disabled = busy || !loaded || !canApply || (!requestId && (changed || !state?.can_apply || alreadyApplied()));
    refresh.disabled = busy;
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
    const published = state?.published;
    if (published?.voice_id && !entries.some(option => option.value === published.voice_id)) {
      const option = el('option', published.voice_name || voiceNames.get(published.voice_id) || 'Published voice'); option.value = published.voice_id; entries.push(option);
    }
    selected.replaceChildren(...entries); selected.value = entries.some(option => option.value === value) ? value : '';
    if (selected.value !== previous) { revision++; clearPreview(); audio.hidden = true; confirm.checked = false; }
  }
  function showCurrent() {
    if (!state.published) currentVoice.textContent = 'Create and publish your first agent before applying a different voice.';
    else {
      const id = state.published.voice_id;
      const name = state.published.voice_name || voices.find(voice => voice.voice_id === id)?.voice_name || voiceNames.get(id)
        || (state.saved_voice?.voice_id === id ? state.saved_voice.voice_name : 'Previous voice');
      currentVoice.textContent = `Published voice: ${name || 'Current voice'}.`;
      if (state.saved_voice?.voice_id && state.saved_voice.voice_id !== id) currentVoice.textContent += ' A different saved choice is ready to apply.';
    }
  }
  function operation(value) {
    if (value === undefined || value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !/^[A-Za-z0-9_-]{16,100}$/.test(value.operation_id)
      || ![value.parent_version_id, value.version_id].every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,36}$/.test(id))
      || !['queued', 'processing', 'published', 'failed', 'uncertain'].includes(value.status)
      || !['voice', 'publish_voice', 'complete'].includes(value.step) || typeof value.unchanged !== 'boolean') throw Error('The saved voice update could not be confirmed. Check voice status before continuing.');
    return value;
  }
  function stopPolling() {
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = undefined;
  }
  function finishPublished() {
    stopPolling(); requestId = undefined; requestVersion = undefined; resultVersion = undefined;
    apply.textContent = 'Apply voice to agent'; confirm.checked = false;
    const name = state.published?.voice_name || voices.find(voice => voice.voice_id === state.published?.voice_id)?.voice_name || voiceNames.get(state.published?.voice_id)
      || (state.saved_voice?.voice_id === state.published?.voice_id ? state.saved_voice.voice_name : 'the confirmed voice');
    const text = `Voice update published. Your agent is now using ${name}. Your approved instructions and knowledge stayed unchanged.`;
    feedback(applyNotice, text, 'success'); message(text, false, 'success');
  }
  function showOperation(update) {
    if (requestId && update && update.operation_id !== requestId) {
      stopPolling(); feedback(applyNotice, 'A different voice update is recorded. Your original request is preserved; review the current agent before requesting another change.', 'warning'); return;
    }
    if (update && (!requestId || update.operation_id === requestId)) {
      if (['queued', 'processing', 'failed', 'uncertain'].includes(update.status)) {
        requestId = update.operation_id; requestVersion = update.parent_version_id; resultVersion = update.version_id;
        apply.textContent = 'Check this voice request';
      }
      if (update.status === 'published') {
        if (state.published?.version_id === update.version_id) finishPublished();
        else { stopPolling(); feedback(applyNotice, 'This voice request finished, but a different agent version is currently published. Review the published voice above before changing anything else.', 'warning'); }
        return;
      }
      if (['failed', 'uncertain'].includes(update.status)) {
        stopPolling(); feedback(applyNotice, update.status === 'uncertain'
          ? 'This voice update needs provider reconciliation. Publication is not confirmed. Check this existing request; no new update will be created.'
          : 'This voice update failed. Your previous published agent remains available. Review the agent status; checking this request does not retry publication.', update.status === 'failed' ? 'error' : 'warning'); return;
      }
      feedback(applyNotice, 'Voice update is processing. Your previous published voice remains in use until the provider confirms publication. This page is checking its status.', 'pending');
      return;
    }
    if (requestId) {
      if (resultVersion && state.published?.version_id === resultVersion) { finishPublished(); return; }
      feedback(applyNotice, 'Your existing voice update is awaiting confirmation. Check this same request before making another change.', 'warning'); return;
    }
    if (selected.value && selected.value !== state.saved_voice?.voice_id) {
      feedback(applyNotice, 'Save your selected voice before applying it to the agent.', 'info'); return;
    }
    if (alreadyApplied()) feedback(applyNotice, 'Your saved voice choice is already in use by the published agent. No apply step is needed.', 'success');
    else if (state.blocker) feedback(applyNotice, state.blocker, 'warning');
    else feedback(applyNotice, 'Your saved choice is ready. Confirm step 2, then Apply voice to agent.', 'info');
  }
  async function readStatus({ preserveSelection = false } = {}) {
    const selectedValue = selected.value;
    const next = await api('/api/agent-builder/voice-settings', { guard: active });
    if (!active()) return;
    if (next.outreach_started !== false) throw Error('The server did not confirm these voice settings.');
    const update = operation(next.voice_operation);
    state = next; loaded = true;
    for (const item of [state.saved_voice, state.published]) {
      if (item?.voice_id && item.voice_name) voiceNames.set(item.voice_id, item.voice_name);
    }
    choices(preserveSelection ? selectedValue : state.saved_voice?.voice_id || ''); showCurrent();
    const unsaved = selected.value && selected.value !== state.saved_voice?.voice_id;
    feedback(saveNotice, unsaved ? `Your selected voice has not been saved. Saved choice: ${state.saved_voice?.voice_name || 'none'}.`
      : state.saved_voice?.voice_id ? `Saved voice choice: ${state.saved_voice.voice_name || state.saved_voice.voice_id}. ${alreadyApplied() ? 'This is the published voice.' : 'It is saved; publication is a separate step below.'}` : 'Choose an available voice, then save it.', state.saved_voice?.voice_id && !unsaved ? 'success' : 'info');
    showOperation(update);
    if (requestId && update?.operation_id === requestId && ['queued', 'processing'].includes(update.status)) schedulePoll();
    return update;
  }
  function schedulePoll() {
    stopPolling();
    if (!active() || !requestId || !resultVersion) return;
    if (!pollStarted) pollStarted = Date.now();
    if (pollAttempts >= 30 || Date.now() - pollStarted >= 60000) {
      feedback(applyNotice, 'The provider has not confirmed publication yet. Your existing request is preserved. Use Check voice status to check again; no new update will be created.', 'warning'); return;
    }
    pollTimer = setTimeout(async () => {
      pollTimer = undefined;
      if (!active() || !requestId) return;
      if (busy) { schedulePoll(); return; }
      pollAttempts++;
      await checkStatus(true);
    }, 2000);
  }
  async function checkStatus(automatic = false) {
    if (!active() || busy) return;
    busy = true; controls(); refresh.textContent = 'Checking voice status…';
    if (!automatic) message('Checking saved and published voice status…', false, 'pending');
    try {
      const update = await readStatus({ preserveSelection: true });
      if (!active()) return;
      if (requestId && (!update || (update.operation_id === requestId && ['queued', 'processing'].includes(update.status)))) schedulePoll();
      if (!requestId && !automatic && applyPhase !== 'success') message(state.blocker || 'Voice status checked. Saving a choice never changes the live agent.');
    } catch (error) {
      stopPolling();
      if (active()) {
        loaded = false;
        const text = error.message || 'Could not check voice status.';
        message(text, true);
        if (requestId) feedback(applyNotice, `${text} Your existing request is preserved. Check voice status again; no new publication was requested.`, 'warning');
      }
    } finally { busy = false; if (active()) { refresh.textContent = 'Check voice status'; controls(); } }
  }
  selected.onchange = () => {
    if (!active() || busy || requestId) return;
    revision++; clearPreview(); audio.hidden = true; confirm.checked = false; controls();
    message('Voice choice changed. Save it first; your published agent is unchanged.');
    feedback(saveNotice, 'Unsaved voice choice. Save it to verify and keep this selection.', 'info');
    feedback(applyNotice, 'Save your selected voice before applying it to the agent.', 'info');
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
    busy = true; controls(); loadVoices.textContent = 'Loading voices…'; message('Loading your available voices…', false, 'pending');
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
    finally { busy = false; if (active()) { loadVoices.textContent = 'Load available voices'; controls(); } }
  }
  loadVoices.onclick = () => readCatalog();
  more.onclick = () => nextOffset === null ? undefined : readCatalog(nextOffset);
  for (const node of [provider, gender, accent]) node.onchange = () => { if (!busy && !requestId && active()) { revision++; return readCatalog(); } };
  query.oninput = () => { if (!busy && !requestId && active()) revision++; };
  preview.onclick = async () => {
    if (!active() || busy || preview.disabled) return;
    const voiceId = selected.value, captured = revision;
    const current = () => active() && captured === revision && selected.value === voiceId;
    busy = true; controls(); preview.textContent = 'Loading preview…'; clearPreview(); audio.hidden = true; message('Loading this voice preview…', false, 'pending');
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
    finally { busy = false; if (active()) { preview.textContent = 'Hear selected voice'; controls(); } }
  };
  save.onclick = async () => {
    if (!active() || busy || save.disabled || requestId) return;
    const voiceId = selected.value, captured = revision;
    if (!voices.some(voice => voice.voice_id === voiceId)) { message('Choose a voice from the available list.', true); return; }
    const current = () => active() && revision === captured && selected.value === voiceId;
    let savedConfirmed = false;
    busy = true; controls(); save.textContent = 'Verifying and saving…';
    message('Verifying and saving your voice choice…', false, 'pending');
    feedback(saveNotice, 'Verifying this voice with your provider and saving your choice…', 'pending');
    try {
      const result = await api('/api/agent-builder/voice-choice', { method: 'POST', body: { voice_id: voiceId }, guard: current });
      if (!current()) return;
      if (result.saved !== true || result.voice_id !== voiceId || result.outreach_started !== false) throw Error('The server did not confirm this saved choice. Check voice status before continuing.');
      savedConfirmed = true;
      await readStatus();
      if (active()) {
        const text = 'Voice choice saved. Your published agent has not changed. Tick the approval below to apply it.';
        feedback(saveNotice, text, 'success'); message(text, false, 'success');
      }
    } catch (error) {
      if (active()) {
        if (savedConfirmed) loaded = false;
        const text = savedConfirmed ? 'Your voice choice was saved, but its status could not be refreshed.' : error.message || 'Could not save this voice choice.';
        feedback(saveNotice, text + ' Your selection is preserved. Check voice status before continuing.', savedConfirmed ? 'warning' : 'error'); message(text, !savedConfirmed, savedConfirmed ? 'warning' : 'error');
      }
    }
    finally { busy = false; if (active()) { save.textContent = 'Save voice choice'; controls(); } }
  };
  applyForm.onsubmit = async event => {
    event.preventDefault();
    if (!active() || busy || apply.disabled) return;
    if (requestId && resultVersion) { await checkStatus(); return; }
    if (!requestId) {
      if (!confirm.checked) { message('Confirm that you want to apply your saved choice.', true); return; }
      if (!globalThis.crypto?.randomUUID) { message('Use a secure HTTPS browser to apply this choice.', true); return; }
      requestId = globalThis.crypto.randomUUID(); requestVersion = state.published.version_id;
      pollAttempts = 0; pollStarted = Date.now();
    }
    busy = true; controls(); apply.textContent = 'Applying voice…';
    message('Submitting your explicit voice update…', false, 'pending');
    feedback(applyNotice, 'Applying your saved voice choice. Waiting for the provider to confirm publication…', 'pending');
    try {
      const result = await api('/api/agent-builder/voice-apply', { method: 'POST', body: {
        version_id: requestVersion, request_id: requestId, confirmation: 'APPLY VERIFIED VOICE TO MY AGENT'
      }, guard: active });
      if (!active()) return;
      if (result.operation_id !== requestId || typeof result.version_id !== 'string' || result.outreach_started !== false
        || !['queued', 'processing', 'published', 'failed', 'uncertain'].includes(result.status) || typeof result.unchanged !== 'boolean') throw Error('The voice update was not confirmed. Check this same request before continuing.');
      resultVersion = result.version_id;
      confirm.checked = false;
      apply.textContent = 'Check this voice request';
      if (['failed', 'uncertain'].includes(result.status)) {
        feedback(applyNotice, result.status === 'uncertain'
          ? 'Provider acceptance needs reconciliation. Your new voice is not confirmed live. Check this existing request before making another change.'
          : 'This voice update failed. Your previous published agent remains available. Check the agent status before making another change.', result.status === 'failed' ? 'error' : 'warning');
      } else feedback(applyNotice, 'Voice update is processing. Your previous published voice remains in use until the provider confirms publication. This page is checking its status.', 'pending');
      if (result.status === 'published') {
        const expectedVersion = result.version_id;
        await readStatus();
        if (!active()) return;
        if (requestId && state.published?.version_id === expectedVersion) finishPublished();
      } else if (['queued', 'processing'].includes(result.status)) schedulePoll();
    } catch (error) {
      if (active()) {
        const text = error.message || 'Could not confirm this voice request.';
        feedback(applyNotice, `${text} Your exact request is preserved. Check this same request; no duplicate update will be created.`, 'warning'); message(text, true);
      }
    }
    finally { busy = false; if (active()) { apply.textContent = requestId ? 'Check this voice request' : 'Apply voice to agent'; controls(); } }
  };
  refresh.onclick = () => checkStatus();
  busy = true; controls(); message('Loading saved and published voice settings…', false, 'pending');
  try {
    await readStatus();
    if (active() && applyPhase !== 'success') message(state.blocker || 'Choose a voice. Your agent changes only after explicit Apply.');
  } catch (error) { if (active()) message(error.message || 'Could not load voice settings.', true); }
  busy = false;
  if (active()) controls();
  return { dispose };
}
