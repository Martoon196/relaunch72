/* Read-only install details for this business's existing reviewed website chat. */
const mounts = new WeakMap();
const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); return node; };

export async function mountWebsiteChatSettings(root, api, options = {}) {
  mounts.get(root)?.dispose();
  const token = {};
  let observer;
  const dispose = () => { observer?.disconnect(); if (mounts.get(root)?.token === token) mounts.delete(root); };
  mounts.set(root, { token, dispose });
  const active = () => {
    try { return mounts.get(root)?.token === token && root.isConnected !== false && options.isCurrent?.() !== false; }
    catch { return false; }
  };
  if (typeof MutationObserver === 'function' && document.documentElement) {
    observer = new MutationObserver(() => { if (!active()) dispose(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  root.classList.add('website-chat-settings');
  const heading = el('h1', 'Website chat');
  const notice = el('p'); notice.className = 'website-chat-notice'; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const message = (text, error = false) => { if (active()) { notice.textContent = text; notice.setAttribute('role', error ? 'alert' : 'status'); } };
  root.replaceChildren(heading, el('p', 'Add this business’s approved agent to its website. Copying the code does not activate chat or publish a new agent version.'), notice);
  if (options.canRead !== true) { message('Your role has no website chat access for this business.'); return { dispose }; }
  let result;
  try { result = await api('/api/agent-builder', { guard: active }); }
  catch (error) { if (active()) message(error.message || 'Website chat details could not be loaded.', true); return { dispose }; }
  if (!active()) return { dispose };
  const config = result.website_chat;
  let script;
  try {
    script = new URL(config?.script_url);
    if (script.protocol !== 'https:' || script.username || script.password || script.search || script.hash || script.pathname !== '/widget.js' || typeof config.workspace_id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(config.workspace_id)) throw Error();
  } catch { message('The server did not return safe install details. Reopen this page before installing chat.', true); return { dispose }; }
  const origins = Array.isArray(config.origins) ? config.origins.filter(value => typeof value === 'string') : [];
  const enabled = config.runtime_enabled === true && config.worker_enabled === true && config.business_enabled === true && config.chat_enabled === true && config.paused === false && !!config.deployed_version_id && origins.length > 0 && config.available === true;
  const status = el('section'); status.className = 'website-chat-card';
  status.append(el('h2', enabled ? 'Ready on reviewed websites' : config.chat_enabled === true ? 'Configured · currently unavailable' : 'Website AI chat is off'));
  if (enabled) status.append(el('p', 'The deployed published agent is available on the reviewed origins below. The website still needs the install code.'));
  else {
    const holds = [];
    if (!config.deployed_version_id) holds.push('Choose a provider-published agent version.');
    if (config.runtime_enabled !== true) holds.push('Website chat must be enabled securely for this installation.');
    if (config.worker_enabled !== true) holds.push('The agent background worker is unavailable.');
    if (config.chat_enabled !== true || config.business_enabled !== true) holds.push('Explicitly enable website chat for this business after review.');
    if (!origins.length) holds.push('Review the exact website origins that may use this agent.');
    if (config.paused !== false) holds.push('This business is paused. Resume only when you choose.');
    if (!holds.length) holds.push('The installation has not confirmed website chat availability.');
    for (const hold of holds) status.append(el('p', hold));
  }
  status.append(el('h3', 'Reviewed website origins'));
  for (const origin of origins) status.append(el('p', origin));
  if (!origins.length) status.append(el('p', 'No website origins approved yet.'));
  root.append(status);
  const install = el('section'); install.className = 'website-chat-card';
  install.append(el('h2', 'Install on this business’s website'), el('p', 'Paste this script before the closing </body> tag, or give it to your website manager. It contains this business’s public widget ID, with no API keys.'));
  const code = el('textarea'); code.readOnly = true; code.rows = 3; code.setAttribute('aria-label', 'Website chat embed code');
  const escapeAttribute = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  code.value = `<script src="${escapeAttribute(script.href)}" data-workspace="${escapeAttribute(config.workspace_id)}" defer></script>`;
  const copy = el('button', 'Copy install code'); copy.type = 'button'; copy.className = 'btn';
  let copying = false;
  copy.onclick = async () => {
    if (!active() || copying) return;
    copying = true; copy.disabled = true;
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') throw Error();
      await navigator.clipboard.writeText(code.value);
      if (active()) message('Install code copied. Chat availability and your published agent are unchanged.');
    } catch {
      if (active()) { code.focus(); code.select(); message('Automatic copy is unavailable. The install code is selected; copy it manually.'); }
    } finally { copying = false; if (active()) copy.disabled = false; }
  };
  install.append(code, copy, el('p', 'Try it from an approved website after installation. Signup, booking and payment links appear only when explicitly approved in the deployed agent version. They open the business’s page; they do not prove a completed conversion.'));
  root.append(install);
  if (typeof options.onReturnBuilder === 'function') {
    const open = el('button', 'Review agent and website deployment →'); open.type = 'button'; open.className = 'btn';
    let opening = false;
    open.onclick = async () => {
      if (!active() || opening) return;
      opening = true; open.disabled = true;
      try { await options.onReturnBuilder({ isCurrent: active }); }
      catch (error) { if (active()) message(error.message || 'The agent page could not be opened.', true); }
      finally { opening = false; if (active()) open.disabled = false; }
    };
    root.append(open);
  } else {
    const open = el('a', 'Review agent and website deployment →'); open.href = '#agents'; root.append(open);
  }
  message(enabled ? 'Install details loaded. No deployment changes were made.' : 'Install code is available to prepare. Website AI chat is not active.');
  return { dispose };
}
