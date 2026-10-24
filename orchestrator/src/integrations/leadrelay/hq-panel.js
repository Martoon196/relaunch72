/* Native, dependency-free Growth HQ module. Serve from HQ's own assets origin.
   No LeadRelay bearer token, browser storage, iframe or public CORS connection. */
export function mountLeadRelay(root, {apiBase = '/api/leadrelay', csrfToken, csrfHeader = 'X-CSRF-Token'} = {}) {
  if (!(root instanceof HTMLElement) || typeof csrfToken !== 'function') throw Error('A container and existing HQ CSRF-token accessor are required');
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(apiBase) || apiBase.startsWith('//')) throw Error('Use a same-origin API path');
  let registry = [], current = null, disposed = false;
  const node = (tag, text = '', className = '') => { const x = document.createElement(tag); x.textContent = text; if (className) x.className = className; return x; };
  root.classList.add('lrhq');
  const title = node('h2', 'LeadRelay'), intro = node('p', 'Sales follow-up · Growth HQ control module');
  const selection = node('select'); selection.setAttribute('aria-label', 'LeadRelay installation');
  const controls = node('div', '', 'lrhq-toolbar'), message = node('p', '', 'lrhq-message'), content = node('div');
  root.replaceChildren(title, intro, selection, controls, message, content);
  const can = action => current?.actions.includes(action);
  const error = e => { message.textContent = e.message || 'Request failed'; message.setAttribute('role', 'alert'); };
  async function request(path, method = 'GET', body, installationId = current?.id) {
    const unchanged = () => { if (installationId !== current?.id) throw Error('Installation changed; use the refreshed controls'); };
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
    const data = await request(path('status'));
    if (disposed || current.id !== activeId) return;
    controls.replaceChildren(); content.replaceChildren(); message.textContent = '';
    action('Refresh', refresh);
    action('Pause processing', async () => { await request(path('pause'), 'POST', {reason: 'Paused from Growth HQ'}); await refresh(); }, controls, can('POST:pause'));
    action('Resume simulation', async () => {
      if (confirm('Resume simulation processing? Live outreach remains disabled.')) { await request(path('resume-simulation'), 'POST', {confirmation: 'RESUME SIMULATION ONLY'}); await refresh(); }
    }, controls, can('POST:resume-simulation'));
    action('Business setup', setup, controls, can('GET:settings'));
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
    content.append(node('p', 'Detailed areas open LeadRelay with its own login. This is not shared sign-in. No iframe or browser API key is used.', 'lrhq-note'));
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
  async function setup() {
    const id = current.id;
    const [cfg, ports] = await Promise.all([request(path('settings')), request(path('providers'))]);
    if (current.id !== id || disposed) return;
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
      wrap.append(node('strong', entry.definition.name), choice);
      const links = node('div', '', 'lrhq-links');
      const showLinks = () => { links.replaceChildren(); const p = entry.definition.providers.find(p => p.id === choice.value); if (p?.setup_url) link('Provider account', p.setup_url, links); if (p?.docs_url) link('Setup documentation', p.docs_url, links); };
      choice.onchange = showLinks; showLinks();
      action('Save preference', async () => { await request(path('provider'), 'PUT', {port: entry.definition.port, provider: choice.value}); message.textContent = 'Preference saved. Adapter remains disconnected.'; }, wrap, can('PUT:provider'));
      wrap.append(links); content.append(wrap);
    }
    content.append(node('p', 'Provider credentials must be added in LeadRelay by an authorised administrator later. Saving a choice neither verifies a key nor installs an adapter.', 'lrhq-note'));
  }
  selection.onchange = async () => { current = registry.find(i => i.id === selection.value); try { await refresh(); } catch (e) { error(e); } };
  const ready = (async () => {
    try {
      registry = await request('/installations');
      if (disposed) return;
      if (!registry.length) { message.textContent = 'No LeadRelay installations are assigned to your HQ account.'; return; }
      for (const entry of registry) { const option = node('option', entry.label); option.value = entry.id; selection.append(option); }
      current = registry[0]; await refresh();
    } catch (e) { error(e); }
  })();
  return {ready, refresh, destroy() { disposed = true; root.replaceChildren(); }};
}
