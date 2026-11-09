import { escapeHtml as e } from './ui.js';
import { csrfField, layout, type Shell } from './seo-blog-view.js';
import type { LimitsPageData } from './seo-blog-limits-service.js';
import type { LimitKey } from '../seo-blog/limits.js';

const LABELS: Record<LimitKey, string> = { modelTokens: 'Writing tokens', searchCalls: 'Research calls', images: 'Images (shared)', studioImages: 'Studio images' };
export function limitsPage(shell: Shell, data: LimitsPageData): string {
  const brands = data.brands.map(b => `<section class="card"><h2>${e(b.name)}</h2><p>${e(b.owner)}</p>
<form method="post" action="/portal/seo-blog/limits">${csrfField(shell.csrf)}<input type="hidden" name="target" value="${e(b.id)}"><input type="hidden" name="rowVersion" value="${b.rowVersion}">
<div class="grid">${(Object.keys(LABELS) as LimitKey[]).map(k => `<fieldset><legend>${LABELS[k]}</legend><p>Used this UTC month: <strong>${b.usage[k].toLocaleString('en-GB')}</strong> · Limit: <strong>${b.limits[k] === null ? 'Unlimited' : b.limits[k].toLocaleString('en-GB')}</strong></p>
<label><input type="checkbox" name="${k}Unlimited" value="1"${b.limits[k] === null ? ' checked' : ''}> Unlimited</label>
<label for="${b.id}-${k}">Monthly limit (used when Unlimited is off)</label><input id="${b.id}-${k}" name="${k}" type="number" min="0" max="1000000000" value="${b.limits[k] ?? 0}"></fieldset>`).join('')}</div>
<button type="submit">Save limits for ${e(b.name)}</button></form></section>`).join('');
  const p = data.policy;
  return layout(shell, 'Usage & limits', `<h1>Usage & limits</h1><p>Founder controls for each user’s brand workspaces. Zero stops new requests; Unlimited removes the monthly ceiling. Usage, failed calls, retries and unknown outcomes remain recorded. Changes do not publish content or start a generation.</p>
${brands || '<p>No brand workspaces yet.</p>'}<section class="card"><h2>Platform image settings</h2>
<p>This is the shared platform gate. Each brand keeps its own limits above. Every paid image still needs an explicit request.</p>
<form method="post" action="/portal/seo-blog/limits">${csrfField(shell.csrf)}<input type="hidden" name="action" value="policy"><input type="hidden" name="version" value="${p.version}">
<label><input type="checkbox" name="enabled" value="1"${p.enabled ? ' checked' : ''}> Allow image generation</label>
<label><input type="checkbox" name="monthlyUnlimited" value="1"${p.monthlyUnlimited ? ' checked' : ''}> Unlimited monthly image spending</label>
<label for="policy-monthly">Monthly reservation budget in US dollars (when Unlimited is off)</label><input id="policy-monthly" type="number" name="monthly" min="0" max="1000000" step="0.01" value="${p.monthlyMicrousd / 1_000_000}">
<p class="muted">Reservations control admission; they are not the final provider charge or a guaranteed billing cap. Actual provider usage is kept on every attempt.</p>
<label for="policy-concurrency">Concurrent image requests</label><input id="policy-concurrency" name="concurrency" type="number" min="1" max="10" value="${p.maxConcurrency || 1}">
<p class="muted">Concurrency protects service capacity; it does not limit monthly usage. Duplicate requests never cause a second paid call.</p><button type="submit">Save platform image settings</button></form></section>`);
}
