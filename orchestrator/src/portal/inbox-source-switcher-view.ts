import type { InboxSourceStatus } from './inbox-source-status.js';
import { escapeHtml } from './ui.js';

const LABEL: Record<InboxSourceStatus['state'], string> = {
  ready: 'Ready', check_on_open: 'Check on open', not_connected: 'Not connected', permission_missing: 'Permission needed',
  paused: 'Replies paused', read_failed: 'Could not refresh', not_available: 'Not available',
};

export function renderInboxSourceSwitcher(
  sources: readonly InboxSourceStatus[], current: InboxSourceStatus['id'],
): string {
  return `<style>.inbox-sources{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:0 0 16px}.inbox-source{display:grid;gap:5px;min-height:96px;padding:13px 14px;border:1px solid var(--line);border-radius:11px;background:var(--panel);color:var(--ink);text-decoration:none}.inbox-source[aria-current="page"]{border-color:var(--accent);box-shadow:inset 3px 0 var(--accent)}.inbox-source-head{display:flex;justify-content:space-between;gap:9px}.inbox-source-head span{color:var(--accent-deep);font-size:11px;font-weight:850}.inbox-source small{color:var(--muted);line-height:1.4}.inbox-source b{color:var(--faint);font-size:11px}@media(max-width:620px){.inbox-sources{grid-template-columns:1fr}}</style><nav class="inbox-sources" aria-label="Inbox sources">${sources.map((source) => `<a class="inbox-source" href="${escapeHtml(source.href)}"${source.id === current ? ' aria-current="page"' : ''}><span class="inbox-source-head"><strong>${escapeHtml(source.label)}</strong><span>${escapeHtml(LABEL[source.state])}</span></span><small>${escapeHtml(source.readDetail)}</small><b>${escapeHtml(source.replyDetail)}</b></a>`).join('')}</nav>`;
}
