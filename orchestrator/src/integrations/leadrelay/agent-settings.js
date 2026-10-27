import { mountVoiceSettings } from './voice-settings.js';
import { mountAgentTraining } from './agent-training.js';
import { mountWebsiteChatSettings } from './website-chat-settings.js';

const mounted = new WeakMap();
const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
const check = guard => { try { return guard === undefined || (typeof guard === 'function' && guard() === true); } catch { return false; } };

/** Business-scoped settings. Each capability must be explicitly granted by the host. */
export async function mountAgentSettings(root, api, options = {}) {
  mounted.get(root)?.dispose();
  const token = {}, controllers = new Set();
  let stopped = false, observer, childToken, currentController;
  const active = () => !stopped && mounted.get(root)?.token === token && root.isConnected !== false && check(options.isCurrent);
  const dispose = () => {
    if (stopped) return;
    stopped = true; childToken = undefined; observer?.disconnect();
    for (const controller of controllers) controller.dispose?.();
    controllers.clear(); currentController = undefined;
    if (mounted.get(root)?.token === token) mounted.delete(root);
  };
  const controller = { dispose };
  mounted.set(root, { token, dispose });
  if (typeof MutationObserver === 'function' && document.documentElement) {
    observer = new MutationObserver(() => { if (!active()) dispose(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  root.classList.add('agent-settings');
  const heading = el('div'); heading.className = 'page-head';
  const title = el('div'); title.append(el('h1', 'Agent settings'), el('p', 'Choose your agent’s voice, business knowledge and conversation goals. Changes stay separate from the published agent until you approve and apply them.'));
  heading.append(title);
  const notice = el('p'); notice.className = 'agent-settings-notice'; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const message = (text, error = false) => { if (active()) { notice.textContent = text; notice.setAttribute('role', error ? 'alert' : 'status'); } };
  const tabs = el('div'); tabs.className = 'agent-settings-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Agent settings');
  const pane = el('div'); pane.className = 'agent-settings-pane';
  root.replaceChildren(heading, notice, tabs, pane);
  const voice = options.voice || {}, training = options.training || {}, websiteChat = options.websiteChat || {};
  const available = [];
  if (voice.canRead === true) available.push(['voice', 'Voice']);
  if (training.canRead === true) available.push(['training', 'Training & goals']);
  if (websiteChat.canRead === true) available.push(['website-chat', 'Website chatbot']);
  if (!available.length) { message('Your role has no agent settings access for this business.'); return controller; }
  const buttons = new Map();
  async function open(section) {
    if (!active() || !buttons.has(section)) return;
    const ownToken = {}; childToken = ownToken;
    currentController?.dispose?.(); if (currentController) controllers.delete(currentController); currentController = undefined;
    const childRoot = el('section'); childRoot.className = 'agent-settings-section'; childRoot.setAttribute('role', 'tabpanel');
    childRoot.id = `agent-settings-${section}`; pane.replaceChildren(childRoot); notice.textContent = '';
    for (const [key, button] of buttons) { button.setAttribute('aria-selected', String(key === section)); button.tabIndex = key === section ? 0 : -1; }
    const current = () => active() && childToken === ownToken && childRoot.isConnected !== false;
    const childApi = async (path, request = {}) => {
      if (request.guard !== undefined && typeof request.guard !== 'function') throw new Error('The operation guard is invalid.');
      const guard = () => current() && check(request.guard);
      if (!guard()) throw new Error('Agent settings view changed.');
      const response = await api(path, { ...request, guard });
      if (!guard()) throw new Error('Agent settings view changed.');
      return response;
    };
    const forward = callback => async (context = {}) => {
      const guard = () => current() && check(context.isCurrent);
      if (!guard()) return;
      if (typeof callback !== 'function') { message('This page is not available for your current role.'); return; }
      await callback({ isCurrent: guard });
    };
    const shared = { isCurrent: current, onOpenConnections: forward(options.onOpenConnections), onReturnBuilder: forward(options.onReturnBuilder) };
    try {
      const child = section === 'voice'
        ? await mountVoiceSettings(childRoot, childApi, {
          ...shared, canRead: true,
          canListVoices: voice.canListVoices === true, canCatalog: voice.canCatalog === true,
          canPreview: voice.canPreview === true, canSaveChoice: voice.canSaveChoice === true,
          canApplyVoice: voice.canApplyVoice === true,
          canConfigure: voice.canConfigure === true, canPublish: voice.canPublish === true,
        })
        : section === 'training' ? await mountAgentTraining(childRoot, childApi, {
          ...shared, canRead: true, canTrain: training.canTrain === true,
          canEdit: training.canTrain === true, canReview: training.canTrain === true,
        }) : await mountWebsiteChatSettings(childRoot, childApi, { ...shared, canRead: true });
      if (!current()) { child?.dispose?.(); return; }
      if (child) { currentController = child; controllers.add(child); }
    } catch (error) {
      if (current()) message(error.message || 'Agent settings could not be loaded. Select the tab to try again.', true);
    }
  }
  for (const [key, label] of available) {
    const button = el('button', label); button.type = 'button'; button.className = 'btn';
    button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', `agent-settings-${key}`);
    button.onclick = () => open(key); tabs.append(button); buttons.set(key, button);
  }
  await open(available[0][0]);
  return controller;
}
