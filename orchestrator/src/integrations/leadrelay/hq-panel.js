/* Native, dependency-free Growth HQ module. Serve from HQ's own assets origin.
   No LeadRelay bearer token, browser storage, iframe or public CORS connection. */
export function mountLeadRelay(root, {apiBase = '/api/leadrelay', csrfToken, csrfHeader = 'X-CSRF-Token', loadBuilder = () => import('/portal/leadrelay/builder.js'), loadProvider = () => import('/portal/leadrelay/provider-setup.js'), loadSettings = () => import('/portal/leadrelay/agent-settings.js')} = {}) {
  if (!(root instanceof HTMLElement) || typeof csrfToken !== 'function') throw Error('A container and existing HQ CSRF-token accessor are required');
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(apiBase) || apiBase.startsWith('//')) throw Error('Use a same-origin API path');
  let registry = [], current = null, disposed = false;
  let view = {}, providerView = null, currentStatus = null;
  function beginView() {
    providerView?.dispose(); providerView = null;
    view = {}; return view;
  }
  const viewIsCurrent = (token, id) => !disposed && current?.id === id && view === token;
  const node = (tag, text = '', className = '') => { const x = document.createElement(tag); x.textContent = text; if (className) x.className = className; return x; };
  root.classList.add('lrhq');
  const title = node('h2', 'LeadRelay'), intro = node('p', 'Sales follow-up · Growth HQ control module');
  const selection = node('select'); selection.setAttribute('aria-label', 'LeadRelay installation');
  const controls = node('div', '', 'lrhq-toolbar'), message = node('p', '', 'lrhq-message'), content = node('div');
  root.replaceChildren(title, intro, selection, controls, message, content);
  const can = action => current?.actions.includes(action);
  const error = e => { message.textContent = e.message || 'Request failed'; message.setAttribute('role', 'alert'); };
  async function request(path, method = 'GET', body, installationId = current?.id, guard) {
    if (guard !== undefined && typeof guard !== 'function') throw Error('Setup guard must be a function');
    const unchanged = () => {
      if (disposed || installationId !== current?.id) throw Error('Installation changed; use the refreshed controls');
      if (guard && guard() !== true) throw Error('Setup view changed; request cancelled');
    };
    unchanged();
    const headers = {'Content-Type': 'application/json'};
    if (method !== 'GET') {
      const token = await csrfToken(); if (!token) throw Error('Your HQ session needs a valid CSRF token before changes are allowed');
      unchanged();
      headers[csrfHeader] = token;
    }
    unchanged();
    const r = await fetch(apiBase + path, {method, credentials: 'same-origin', headers, body: body === undefined ? undefined : JSON.stringify(body)});
    const data = await r.json().catch(() => ({detail: 'Unreadable gateway response'}));
    unchanged();
    if (!r.ok) throw Error(typeof data.detail === 'string' ? data.detail : `Control request failed (${r.status})`);
    return data;
  }
  const path = operation => '/installations/' + encodeURIComponent(current.id) + '/' + operation;
  function action(label, callback, parent = controls, enabled = true) {
    const boundInstallation = current?.id;
    const b = node('button', label); b.type = 'button'; b.disabled = !enabled;
    b.onclick = async () => { b.disabled = true; message.textContent = ''; try { if (boundInstallation !== current?.id) throw Error('Installation changed; use the refreshed controls'); await callback(); } catch (e) { error(e); } finally { b.disabled = !enabled; } };
    parent.append(b); return b;
  }
  function link(label, url, parent) {
    try { const u = new URL(url); if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1','testserver'].includes(u.hostname))) return; }
    catch { return; }
    const a = node('a', label); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; parent.append(a);
  }
  function card(label, value, parent) { const c = node('article', '', 'lrhq-card'); c.append(node('small', label), node('strong', String(value))); parent.append(c); }
  function download(data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
    const a = node('a'); a.href = url; a.download = 'leadrelay-business-pack.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function refresh() {
    if (!current || disposed) return;
    const activeId = current.id;
    const token = beginView();
    const data = await request(path('status'), 'GET', undefined, activeId);
    if (!viewIsCurrent(token, activeId)) return;
    currentStatus = {id:activeId,data};
    controls.replaceChildren(); content.replaceChildren(); message.textContent = '';
    action('Refresh', refresh);
    action('Pause processing', async () => { await request(path('pause'), 'POST', {reason: 'Paused from Growth HQ'}); await refresh(); }, controls, can('POST:pause'));
    action('Resume simulation', async () => {
      if (confirm('Resume simulation processing? Live outreach remains disabled.')) { await request(path('resume-simulation'), 'POST', {confirmation: 'RESUME SIMULATION ONLY'}); await refresh(); }
    }, controls, can('POST:resume-simulation'));
    action('Business setup', setup, controls, can('GET:settings'));
    if (can('GET:agent-status') || can('GET:agent-voice-settings') || (can('GET:agent-training-profile') && can('GET:agent-training-sources'))) action('Agent settings', () => openAgentSettings(data), controls);
    if (can('GET:agent-connection')) action('AI connection', () => openProviderSetup(data), controls);
    if (can('GET:agent-status')) action('Create an agent', () => openAgentBuilder(data), controls);
    const banner = node('p', `${data.paused ? 'PAUSED' : data.live_outreach ? 'OWN-CONTACT LIVE PILOT' : 'SIMULATION AVAILABLE'} · ${data.business_name} · ${data.live_outreach ? 'Only authorised test contacts' : 'No live calling authorised'}`, 'lrhq-banner'); content.append(banner);
    const stats = node('div', '', 'lrhq-grid'); content.append(stats);
    card('Real leads', data.lead_count, stats); card('Confirmed purchases', data.confirmed_purchases, stats);
    card('Queued jobs', data.jobs?.queued || 0, stats); card('Scheduler', data.scheduler?.status || 'Unknown', stats);
    card('Confirmed bookings', data.lead_statuses?.booked || 0, stats);
    card('Cancelled follow-ups', data.jobs?.cancelled || 0, stats);
    card('Provider-accepted calls awaiting outcome', data.jobs?.awaiting_outcome || 0, stats);
    card('Confirmed Brevo projections', data.crm_outcome_sync?.confirmed_deliveries || 0, stats);
    card('Brevo projections retrying', data.crm_outcome_sync?.retrying_deliveries || 0, stats);
    content.append(node('p', 'A pause or stop prevents unsent follow-up. Provider-accepted calls remain visible until their outcome is reconciled.', 'lrhq-note'));

    content.append(node('h3', 'Setup and working areas'));
    const sections = node('div', '', 'lrhq-links'); content.append(sections);
    for (const section of data.sections || []) link(section.title, section.url, sections);
    content.append(node('p', 'AI connection and agent creation stay in Growth HQ. Other detailed areas open LeadRelay with its own login. No LeadRelay server key is sent to the browser.', 'lrhq-note'));
    const checklist = node('ul'); for (const step of data.setup || []) checklist.append(node('li', `${step.complete ? '✓' : '○'} ${step.title}`)); content.append(checklist);
    const packs = node('div', '', 'lrhq-toolbar'); content.append(node('h3', 'Portable business setup'), packs);
    action('Export configuration', async () => { download(await request(path('pack-export'), 'POST', {})); message.textContent = 'Exported without brief or knowledge. Review scripts before sharing.'; }, packs, can('POST:pack-export'));
    const file = node('input'); file.type = 'file'; file.accept = '.json,application/json'; file.setAttribute('aria-label', 'Business pack JSON'); file.disabled = !can('POST:pack-import'); packs.append(file);
    action('Import paused setup', async () => {
      const installationId = current.id;
      const importPath = '/installations/' + encodeURIComponent(installationId) + '/pack-import';
      const unchanged = () => { if (disposed || current?.id !== installationId) throw Error('Installation changed; import cancelled'); };
      const f = file.files[0]; if (!f || f.size > 750000) throw Error('Choose a JSON pack below 750 KB');
      const pack = JSON.parse(await f.text());
      unchanged();
      if (!confirm(`Import ${pack.name || 'this setup'} into ${data.business_name}? The target must be fresh. Processing stays paused.`)) return;
      unchanged();
      await request(importPath, 'POST', {pack, confirmation: 'IMPORT INTO FRESH WORKSPACE'}, installationId); await refresh();
    }, packs, can('POST:pack-import'));
    content.append(node('p', 'No contacts, users or credentials are transferred. Imported scripts require review; sequences remain disabled and knowledge is unapproved.', 'lrhq-note'));
  }
  async function openAgentBuilder(status, parentGuard) {
    const installationId = current.id;
    const allowed = new Set(current.actions);
    const previousView = view;
    if(parentGuard!==undefined&&(typeof parentGuard!=='function'||parentGuard()!==true))throw Error('Setup view changed; agent setup cancelled');
    const routes = Object.freeze({
      'GET:/api/agent-builder':'agent-status',
      'POST:/api/agent-builder/scan':'agent-scan',
      'POST:/api/agent-builder/approve':'agent-approve',
      'POST:/api/agent-builder/publish':'agent-publish',
      'POST:/api/agent-builder/chat':'agent-chat',
      'POST:/api/agent-builder/test-call':'agent-test-call',
      'POST:/api/agent-builder/deploy':'agent-deploy',
    });
    const module = await loadBuilder();
    if (!viewIsCurrent(previousView, installationId) || (parentGuard && parentGuard()!==true)) throw Error('Installation changed; agent setup cancelled');
    if (typeof module?.mountAgentBuilder !== 'function') throw Error('Agent setup module is unavailable');
    // Keep the visible module usable until its replacement has actually loaded.
    const token = beginView();
    const unchanged = () => { if (!viewIsCurrent(token, installationId)) throw Error('Installation changed; agent setup cancelled'); };
    // A removed child invalidates the builder's own pending render/poll handlers.
    const builderRoot = node('div'); content.replaceChildren(builderRoot);
    const api = async (apiPath, options = {}) => {
      unchanged();
      const method = options.method || 'GET';
      const operation = routes[method+':'+apiPath];
      if (!operation) throw Error('Agent setup operation is not supported');
      if (!allowed.has(method+':'+operation)) throw Error('Your HQ role does not permit this agent action');
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['method','body','guard'].includes(key))) throw Error('Agent setup accepts no header, credential or target override');
      if (options.guard !== undefined && typeof options.guard !== 'function') throw Error('Setup guard must be a function');
      const boundPath = '/installations/'+encodeURIComponent(installationId)+'/'+operation;
      const guard = () => viewIsCurrent(token, installationId) && (options.guard ? options.guard() === true : true);
      const result = await request(boundPath, method, options.body, installationId, guard);
      unchanged();
      return result;
    };
    const links = {};
    for (const section of status.sections || []) {
      const id = section.id || (() => { try { return new URL(section.url).hash.slice(1); } catch { return ''; } })();
      if (['live','activity','calls','settings','control'].includes(id)) {
        try { const u = new URL(section.url); if (u.protocol === 'https:') links[id] = u.href; } catch {}
      }
    }
    const onOpenConnections = allowed.has('GET:agent-connection') ? (context={}) => { unchanged(); return openProviderSetup(status,context.isCurrent); } : undefined;
    const onOpenSettings = (context={}) => {
      unchanged();
      if(!allowed.has('GET:agent-status')&&!allowed.has('GET:agent-voice-settings')&&!(allowed.has('GET:agent-training-profile')&&allowed.has('GET:agent-training-sources')))throw Error('Your HQ role does not permit Agent settings for this business');
      return openAgentSettings(status,context.isCurrent);
    };
    await module.mountAgentBuilder(builderRoot, api, {links, onOpenConnections, onOpenSettings, onOpenAgentSettings:onOpenSettings});
  }
  async function openProviderSetup(status, parentGuard) {
    const installationId = current.id;
    const allowed = new Set(current.actions);
    const previousView = view;
    if(parentGuard!==undefined&&(typeof parentGuard!=='function'||parentGuard()!==true))throw Error('Setup view changed; connection setup cancelled');
    const module = await loadProvider();
    if (!viewIsCurrent(previousView, installationId) || (parentGuard && parentGuard()!==true)) throw Error('Installation changed; AI connection setup cancelled');
    if (typeof module?.mountProviderSetup !== 'function') throw Error('AI connection setup module is unavailable');
    const token = beginView();
    const isCurrent = () => viewIsCurrent(token, installationId);
    const unchanged = () => { if (!isCurrent()) throw Error('Installation changed; AI connection setup cancelled'); };
    const providerRoot = node('div'), next = node('div', '', 'lrhq-toolbar');
    content.replaceChildren(providerRoot, next);
    const routes = Object.freeze({
      'GET:/api/agent-builder/connection':'agent-connection',
      'POST:/api/agent-builder/connection/voices':'agent-voices',
      'POST:/api/agent-builder/connection/phone-numbers':'agent-phone-numbers',
      'POST:/api/agent-builder/connection/verify':'agent-connect',
    });
    const api = async (apiPath, options = {}) => {
      unchanged();
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['method','body','guard'].includes(key))) throw Error('AI connection accepts no header, credential or target override');
      if (options.guard !== undefined && typeof options.guard !== 'function') throw Error('Setup guard must be a function');
      const method = options.method || 'GET';
      const operation = routes[method+':'+apiPath];
      if (!operation) throw Error('AI connection operation is not supported');
      if (!allowed.has(method+':'+operation)) throw Error('Your HQ role does not permit this AI connection action');
      const guard = () => isCurrent() && (options.guard ? options.guard() === true : true);
      const result = await request('/installations/'+encodeURIComponent(installationId)+'/'+operation, method, options.body, installationId, guard);
      unchanged(); return result;
    };
    let nextButton;
    const mounted = await module.mountProviderSetup(providerRoot, api, {
      canRead:allowed.has('GET:agent-connection'),
      canListVoices:allowed.has('POST:agent-voices'),
      canListNumbers:allowed.has('POST:agent-phone-numbers'),
      canVerify:allowed.has('POST:agent-connect'),
      isCurrent,
      onVerified: () => {
        unchanged();
        message.setAttribute('role','status');
        message.textContent = 'AI connection verified and saved. Agent creation is the next explicit step.';
        if (!nextButton && allowed.has('GET:agent-status')) nextButton = action('Continue to Create an agent', () => openAgentBuilder(status), next);
      },
    });
    if (!isCurrent()) { mounted?.dispose(); return; }
    providerView = mounted;
  }
  async function openAgentSettings(status, parentGuard) {
    const installationId=current.id, allowed=new Set(current.actions), previousView=view;
    if(parentGuard!==undefined&&(typeof parentGuard!=='function'||parentGuard()!==true))throw Error('Setup view changed; agent settings cancelled');
    const module=await loadSettings();
    if(!viewIsCurrent(previousView,installationId)||(parentGuard&&parentGuard()!==true))throw Error('Installation changed; agent settings cancelled');
    if(typeof module?.mountAgentSettings!=='function')throw Error('Agent settings module is unavailable');
    const token=beginView(), isCurrent=()=>viewIsCurrent(token,installationId);
    const unchanged=()=>{if(!isCurrent())throw Error('Installation changed; agent settings cancelled');};
    const settingsRoot=node('div');content.replaceChildren(settingsRoot);
    const routes=Object.freeze({
      'GET:/api/agent-builder':'agent-status',
      'GET:/api/agent-builder/voice-settings':'agent-voice-settings',
      'POST:/api/agent-builder/voice-choice':'agent-voice-choice',
      'POST:/api/agent-builder/voice-apply':'agent-voice-apply',
      'POST:/api/agent-builder/voice-catalog':'agent-voice-catalog',
      'POST:/api/agent-builder/voice-preview':'agent-voice-preview',
      'GET:/api/agent-builder/training/sources':'agent-training-sources',
      'POST:/api/agent-builder/training/source':'agent-training-source',
      'POST:/api/agent-builder/training/upload':'agent-training-upload',
      'POST:/api/agent-builder/training/source-review':'agent-training-review',
      'GET:/api/agent-builder/training/profile':'agent-training-profile',
      'POST:/api/agent-builder/training/profile':'agent-training-profile',
      'POST:/api/agent-builder/training/approve':'agent-training-approve',
    });
    const api=async(apiPath,options={})=>{
      unchanged();
      if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['method','body','guard'].includes(key)))throw Error('Agent settings accepts no header, credential or target override');
      if(options.guard!==undefined&&typeof options.guard!=='function')throw Error('Setup guard must be a function');
      const method=options.method||'GET',operation=routes[method+':'+apiPath];
      if(!operation)throw Error('Agent settings operation is not supported');
      if(!allowed.has(method+':'+operation))throw Error('Your HQ role does not permit this agent settings action');
      const guard=()=>isCurrent()&&(options.guard?options.guard()===true:true);
      const result=await request('/installations/'+encodeURIComponent(installationId)+'/'+operation,method,options.body,installationId,guard);
      unchanged();return result;
    };
    const trainingWrites=['POST:agent-training-source','POST:agent-training-upload','POST:agent-training-review','POST:agent-training-profile','POST:agent-training-approve'];
    const onOpenConnections=allowed.has('GET:agent-connection')?(context={})=>{unchanged();return openProviderSetup(status,context.isCurrent);}:undefined;
    const onReturnBuilder=allowed.has('GET:agent-status')?(context={})=>{unchanged();return openAgentBuilder(status,context.isCurrent);}:undefined;
    const mounted=await module.mountAgentSettings(settingsRoot,api,{
      voice:{canRead:allowed.has('GET:agent-voice-settings'),canListVoices:allowed.has('POST:agent-voices'),canCatalog:allowed.has('POST:agent-voice-catalog'),canPreview:allowed.has('POST:agent-voice-preview'),canSaveChoice:allowed.has('POST:agent-voice-choice'),canApplyVoice:allowed.has('POST:agent-voice-apply')},
      training:{canRead:allowed.has('GET:agent-training-sources')&&allowed.has('GET:agent-training-profile'),canTrain:trainingWrites.every(action=>allowed.has(action))},
      websiteChat:{canRead:allowed.has('GET:agent-status')},
      isCurrent,onOpenConnections,onReturnBuilder,
    });
    if(!isCurrent()){mounted?.dispose();return;}providerView=mounted;
  }
  async function setup() {
    const id = current.id;
    const token = beginView();
    const [cfg, ports] = await Promise.all([request(path('settings')), request(path('providers'))]);
    if (!viewIsCurrent(token,id)) return;
    const status = currentStatus?.id === id ? currentStatus.data : {sections:[]};
    content.replaceChildren(node('h3', 'Business settings'));
    const form = node('form', '', 'lrhq-form'), inputs = new Map(); content.append(form);
    for (const [name, label, type] of [['business_name','Business name','text'],['app_label','Application label','text'],['website','Website','url'],['booking_url','Booking link','url'],['privacy_url','Privacy URL','url'],['timezone','Timezone','text'],['start_hour','Contact start hour','number'],['end_hour','Contact end hour','number'],['max_contacts_per_lead_day','Daily contacts per lead','number'],['daily_budget_pence','Estimated daily budget · pence','number'],['brand_accent','Brand accent','color']]) {
      const row = node('label', label), input = node('input'); input.type = type; input.name = name; input.value = cfg[name] ?? ''; input.disabled = !can('PUT:settings'); row.append(input); form.append(row); inputs.set(name, input);
    }
    action('Save settings', async () => {
      const values = {...cfg}; for (const [k, input] of inputs) values[k] = input.type === 'number' ? Number(input.value) : input.value;
      await request(path('settings'), 'PUT', values); message.textContent = 'Business settings saved. Pause state and public-widget activation were not changed.';
    }, form, can('PUT:settings'));
    form.onsubmit = e => e.preventDefault();
    content.append(node('h3', 'Provider selections · not live connections'));
    for (const entry of ports) {
      const wrap = node('div', '', 'lrhq-port'), choice = node('select'); choice.setAttribute('aria-label', entry.definition.name);
      for (const p of entry.definition.providers) { const option = node('option', p.name); option.value = p.id; option.selected = p.id === entry.selected; choice.append(option); }
      choice.value = entry.definition.providers.some(p => p.id === entry.selected) ? entry.selected : entry.definition.providers[0]?.id || '';
      wrap.append(node('strong', entry.definition.name), choice);
      const links = node('div', '', 'lrhq-links');
      let savePreference;
      const showLinks = () => {
        links.replaceChildren();
        const p = entry.definition.providers.find(p => p.id === choice.value);
        const nativeRetell = entry.definition.port === 'voice' && choice.value === 'retell';
        if (nativeRetell) {
          links.append(node('p','Retell account verification and voice selection are managed in the native AI connection view.'));
          action('Verify Retell API connection', () => openProviderSetup(status), links, can('GET:agent-connection'));
        } else {
          if (p?.setup_url) link('Provider account', p.setup_url, links);
          if (p?.docs_url) link('Setup documentation', p.docs_url, links);
        }
        if (savePreference) savePreference.disabled = !can('PUT:provider') || nativeRetell;
      };
      savePreference = action('Save preference', async () => { await request(path('provider'), 'PUT', {port: entry.definition.port, provider: choice.value}); message.textContent = 'Preference saved. Adapter remains disconnected.'; }, wrap, can('PUT:provider'));
      choice.onchange = showLinks; showLinks();
      wrap.append(links); content.append(wrap);
    }
    content.append(node('p', 'Retell verification happens in AI connection. Other selections save disconnected preferences until their supplier setup is completed; saving a choice never verifies a key or starts outreach.', 'lrhq-note'));
  }
  selection.onchange = async () => { current = registry.find(i => i.id === selection.value); try { await refresh(); } catch (e) { error(e); } };
  const ready = (async () => {
    try {
      registry = await request('/installations');
      if (disposed) return;
      if (!registry.length) { selection.hidden = true; message.textContent = 'No LeadRelay installations are assigned to your HQ account. An owner must connect the hosted LeadRelay installation and grant setup access securely before website scanning or agent tests are available.'; return; }
      for (const entry of registry) { const option = node('option', entry.label); option.value = entry.id; selection.append(option); }
      current = registry[0]; await refresh();
    } catch (e) { error(e); }
  })();
  return {ready, refresh, destroy() { disposed = true; beginView(); root.replaceChildren(); }};
}
