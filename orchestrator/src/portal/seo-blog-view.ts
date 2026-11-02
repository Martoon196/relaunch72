/**
 * Server-rendered owner screens for the SEO blog engine. Native forms and
 * links only; the calendar adds optional drag-and-drop on top of the same
 * keyboard-accessible forms. No raw hashes, database ids in visible text,
 * commit labels or permission jargon are shown.
 */

import type { BrandReadiness } from '../seo-blog/engine.js';
import { sha256, USAGE_ESTIMATES } from '../seo-blog/engine.js';
import { promotionPublicationHold } from '../seo-blog/promotions.js';
import { bindingHold, type SocialOverview } from '../seo-blog/social.js';
import { articleStatusLabel } from '../seo-blog/policy.js';
import { addDays, utcToLocal } from '../seo-blog/schedule.js';
import { KNOWLEDGE_CATEGORIES, type ActivityEvent, type Article, type ArticleBrief, type ArticleVersion, type Brand, type BrandProfile, type Destination, type Job, type KnowledgeDocument, type Publication, type TopicPlan, type SocialDispatch, type UsageKind, type WebsiteInventory } from '../seo-blog/types.js';
import type { WebsitePublisher } from '../seo-blog/publishers/types.js';
import { escapeHtml as e } from './ui.js';
import { centralActionFeedbackHead, centralActionFeedbackStatus } from './action-feedback.js';
import { isProfileJob, profilePayload, unacknowledgedProfileCalls } from '../seo-blog/profile-jobs.js';

export const SEO_BLOG_BASE = '/portal/seo-blog';
export type SeoBlogTab = 'overview' | 'setup' | 'topics' | 'articles' | 'calendar' | 'publishing' | 'social' | 'activity';

const CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--ink:#1b1f24;--muted:#5b6570;--line:#d9dee4;--accent:#0b5cad;--ok:#1d7a3a;--warn:#9a5b00;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0f1215;--card:#171b20;--ink:#e6e9ec;--muted:#a7b0b9;--line:#2a3138;--accent:#7cb7ff;--ok:#5fd38a;--warn:#f0b35a;--bad:#ff8a80}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:var(--bg);color:var(--ink)}
a{color:var(--accent)}header.sb{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:12px 20px;background:var(--card);border-bottom:1px solid var(--line)}
header.sb form{display:flex;gap:8px;align-items:center}main{max-width:1180px;margin:0 auto;padding:20px}
nav.tabs{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 16px}nav.tabs a{padding:8px 12px;border-radius:6px;text-decoration:none;color:var(--ink);border:1px solid transparent}
nav.tabs a[aria-current=page]{background:var(--card);border-color:var(--line);font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 16px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
label{display:block;font-weight:600;margin:8px 0 4px}input[type=text],input[type=url],input[type=date],input[type=time],input[type=number],input[type=password],select,textarea{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);font:inherit}
textarea{min-height:120px}button,.button{display:inline-block;padding:8px 14px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;font:inherit;cursor:pointer;text-decoration:none}
button.secondary,.button.secondary{background:transparent;color:var(--accent)}button.danger{background:var(--bad);border-color:var(--bad)}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line)}.pill.ok{color:var(--ok);border-color:var(--ok)}.pill.warn{color:var(--warn);border-color:var(--warn)}.pill.bad{color:var(--bad);border-color:var(--bad)}
.toggle-state.on{color:var(--ok);border-color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,var(--card))}.toggle-state.off{color:var(--muted);border-color:var(--muted);background:var(--card)}.toggle-state.paused{color:var(--bad);border-color:var(--bad);background:color-mix(in srgb,var(--bad) 12%,var(--card))}
.toggle-control.on{background:#166534;border-color:#166534;color:#fff}.toggle-control.on:hover{background:#14532d}.toggle-control.off{background:#e5e7eb;border-color:#6b7280;color:#1f2937}.toggle-control.off:hover{background:#d1d5db}.toggle-control.paused{background:#b42318;border-color:#b42318;color:#fff}.toggle-control.paused:hover{background:#912018}
.notice{padding:10px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);margin:0 0 16px}.notice.bad{border-color:var(--bad)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
.muted{color:var(--muted)}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:end}.row>*{flex:1 1 160px}
.cal{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}.day{min-height:96px;border:1px solid var(--line);border-radius:8px;padding:6px;background:var(--card)}.day.drop{outline:2px dashed var(--accent)}
.day h4{margin:0 0 4px;font-size:12px;color:var(--muted)}.slot{font-size:12px;padding:4px 6px;border-radius:6px;border:1px solid var(--line);margin:0 0 4px;background:var(--bg);cursor:grab}
.slot.planned{border-style:dashed;cursor:default}details>summary{cursor:pointer}
@media (max-width:700px){.cal{grid-template-columns:1fr}.day{min-height:auto}}
`;

export interface Shell {
  readonly brands: readonly Brand[];
  readonly brand: Brand | null;
  readonly tab: SeoBlogTab | null;
  readonly csrf: string;
  readonly notice?: string | null;
  readonly error?: string | null;
  readonly applicationName?: string;
}

function url(brand: Brand, tab: string): string {
  return `${SEO_BLOG_BASE}/b/${brand.id}/${tab}`;
}

export function csrfField(csrf: string): string {
  return `<input type="hidden" name="_csrf" value="${e(csrf)}">`;
}

export function layout(shell: Shell, title: string, body: string, extraHead = ''): string {
  const feedback = shell.applicationName === 'Relaunch72 Content';
  const switcher = shell.brands.length
    ? `<form method="get" action="${SEO_BLOG_BASE}/switch"><label for="brand-switch" class="muted" style="margin:0">Brand</label><select id="brand-switch" name="brand">${shell.brands.map((b) => `<option value="${e(b.id)}"${b.id === shell.brand?.id ? ' selected' : ''}>${e(b.name)}</option>`).join('')}</select><button class="secondary" type="submit">Open</button></form>`
    : '';
  const tabs: [SeoBlogTab, string][] = [['overview', 'Overview'], ['setup', 'Brand setup'], ['topics', 'Topics'], ['articles', 'Articles'], ['calendar', 'Calendar'], ['publishing', 'Publishing'], ['social', 'Social'], ['activity', 'Activity']];
  const nav = shell.brand ? `<nav class="tabs" aria-label="SEO Blog">${tabs.map(([t, label]) => `<a href="${url(shell.brand!, t)}"${t === shell.tab ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>` : '';
  return `<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${e(title)} · SEO Blog</title><style>${CSS}</style>${extraHead}${centralActionFeedbackHead(feedback)}</head><body>${centralActionFeedbackStatus(feedback)}
<header class="sb"><div>${shell.applicationName ? `<strong>${e(shell.applicationName)}</strong> · ` : ''}<a href="${SEO_BLOG_BASE}"><strong>Brands</strong></a>${shell.brand ? ` › <strong>${e(shell.brand.name)}</strong> · SEO Blog` : ''}</div>${switcher}<a href="/portal">${shell.applicationName ? 'Content home' : 'Back to portal'}</a></header>
<main>${nav}${shell.notice ? `<p class="notice" role="status">${e(shell.notice)}</p>` : ''}${shell.error ? `<p class="notice bad" role="alert">${e(shell.error)}</p>` : ''}${body}</main></body></html>`;
}

export function brandsPage(shell: Shell, commandId: string): string {
  const cards = shell.brands.map((b) => `<article class="card"><h3><a href="${url(b, 'overview')}">${e(b.name)}</a></h3><p class="muted">${b.website ? e(b.website) : 'No website yet'}</p><p>Automatic publishing: <strong>${b.settings.autoPublish ? 'on' : 'off'}</strong>${b.settings.pauseAll ? ' · <span class="pill bad">publishing paused</span>' : ''}</p></article>`).join('');
  return layout(shell, 'Brands', `<h1>Brands</h1>
<div class="grid">${cards || '<p class="muted">No brands yet. Add your first brand to start its blog.</p>'}</div>
<section class="card" aria-labelledby="add-brand"><h2 id="add-brand">Add brand</h2><form method="post" action="${SEO_BLOG_BASE}/brands">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${e(commandId)}">
<div class="row"><div><label for="name">Brand name</label><input id="name" name="name" type="text" required minlength="2" maxlength="120"></div><div><label for="website">Website (optional)</label><input id="website" name="website" type="text" placeholder="www.example.co.uk"></div></div>
<p class="muted">Creates a separate workspace for this brand. You can add the website and guidance later.</p><button type="submit">Add brand</button></form></section>`);
}

function check(ok: boolean, label: string): string {
  return `<li><span class="pill ${ok ? 'ok' : 'warn'}">${ok ? 'Ready' : 'To do'}</span> ${e(label)}</li>`;
}

export function overviewPage(shell: Shell, data: { readiness: BrandReadiness; articles: { article: Article; status: string }[]; usage: Record<UsageKind, number>; jobs: Job[] }): string {
  const b = shell.brand!;
  const r = data.readiness;
  const counts = new Map<string, number>();
  for (const a of data.articles) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
  const running = data.jobs.filter((j) => ['queued', 'running'].includes(j.state));
  return layout(shell, 'Overview', `<h1>${e(b.name)}</h1>
<div class="grid"><section class="card"><h2>Setup</h2><ul style="list-style:none;padding:0">
${check(r.website, 'Website added')}${check(r.knowledge > 0, `Brand guidance uploaded (${r.knowledge} document${r.knowledge === 1 ? '' : 's'})`)}${check(r.profile === 'confirmed', r.profile === 'stale' ? 'Brand facts changed — confirm the profile again' : 'Brand profile confirmed')}
${check(r.research, 'Research provider connected')}${check(r.generation !== 'unavailable', r.generation === 'simulated' ? 'Writing model (simulated)' : 'Writing model connected')}${check(r.budgets, 'Monthly budgets set')}${check(r.destination === 'connected', 'Website connected for publishing')}</ul>
${r.unreadableKnowledge ? `<p class="notice bad">${r.unreadableKnowledge} upload(s) could not be read. See Brand setup.</p>` : ''}
${r.canPlan ? `<a class="button" href="${url(b, 'topics')}">Plan my content</a>` : `<p class="muted">${e(r.missing.join(' '))}</p>`}</section>
<section class="card"><h2>Articles</h2>${data.articles.length ? `<ul>${[...counts].map(([s, n]) => `<li>${e(s)}: ${n}</li>`).join('')}</ul>` : '<p class="muted">No articles yet.</p>'}<a href="${url(b, 'articles')}">Open articles</a></section>
<section class="card"><h2>This month</h2><p>Writing: ${data.usage.model_tokens.toLocaleString('en-GB')} of ${b.settings.budgets.modelTokensPerMonth.toLocaleString('en-GB')} tokens</p><p>Research: ${data.usage.search_calls} of ${b.settings.budgets.searchCallsPerMonth} searches</p>
<p>Automatic publishing: <strong>${b.settings.autoPublish ? 'on' : 'off'}</strong>${b.settings.pauseAll ? ' · <strong>all publishing paused</strong>' : ''}</p>
${running.length ? `<p>${running.length} task(s) in progress — progress continues if you leave this page.</p>` : ''}</section></div>`);
}

function docStatus(d: KnowledgeDocument): string {
  const cls = ['extracted', 'image_reference'].includes(d.status) ? 'ok' : d.status === 'partial' ? 'warn' : 'bad';
  const label = { pending: 'Reading', extracted: 'Read', partial: 'Partly read', image_reference: 'Visual reference', unreadable: 'Unreadable', unsupported: 'Not supported', rejected: 'Rejected' }[d.status];
  return `<span class="pill ${cls}">${label}</span>`;
}

const CATEGORY_LABEL: Record<string, string> = {
  brand_guidelines: 'Brand guidelines', voice_samples: 'Voice samples', audience_notes: 'Audience notes', product_facts: 'Product facts',
  approved_claims: 'Approved claims', faqs: 'FAQs', visual_guidance: 'Visual guidance', other: 'Other',
};

export function setupPage(shell: Shell, data: {
  documents: KnowledgeDocument[]; profile: BrandProfile | null; inventory: WebsiteInventory | null;
  destinations: Omit<Destination, 'sealedCredential'>[]; publishers: WebsitePublisher[]; vaultReady: boolean;
  usage?: Record<UsageKind, number>;
  jobs?: readonly Job[]; extractionCommandId?: string;
}): string {
  const b = shell.brand!;
  const latest = new Map<string, KnowledgeDocument>();
  for (const d of data.documents) if (!latest.has(d.id) || latest.get(d.id)!.version < d.version) latest.set(d.id, d);
  const docs = [...latest.values()];
  const cats = KNOWLEDGE_CATEGORIES.map((c) => `<option value="${c}">${CATEGORY_LABEL[c]}</option>`).join('');
  const p = data.profile;
  const profileJobs = (data.jobs ?? []).filter(isProfileJob).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const activeProfile = profileJobs.find((j) => ['queued', 'running'].includes(j.state));
  const latestProfileJob = activeProfile ?? profileJobs[0];
  const uncertainPrior = unacknowledgedProfileCalls(profileJobs).length > 0;
  const taskStatus = latestProfileJob ? `<div class="notice" role="status"${activeProfile ? ` data-profile-status-url="${url(b, 'profile/status')}?job=${e(activeProfile.id)}"` : ''}><strong>Profile extraction</strong><p data-profile-status-detail>${e(latestProfileJob.state)}: ${e(latestProfileJob.error ?? latestProfileJob.progress)}</p><a href="${url(b, 'setup')}">Refresh status</a> · <a data-profile-review href="${url(b, 'setup')}#brand-profile"${activeProfile ? ' hidden' : ''}>Review current profile / result</a> · <a href="${url(b, 'activity')}">Task history and controls</a><p class="muted">Status updates do not reload this page or replace unsaved edits. Results need your review and confirmation.</p></div>${activeProfile ? `<script src="${SEO_BLOG_BASE}/profile-status.js" defer></script>` : ''}` : '';
  const used = data.usage?.model_tokens;
  const ceiling = b.settings.budgets.modelTokensPerMonth;
  const remaining = used === undefined ? null : Math.max(0, ceiling - used);
  const shortfall = remaining === null ? null : Math.max(0, USAGE_ESTIMATES.profile - remaining);
  const n = (value: number) => value.toLocaleString('en-GB');
  const allowance = used === undefined ? '<p class="muted">Monthly usage is unavailable. The server checks your allowance before extraction.</p>' : `<div class="notice${shortfall! > 0 ? ' bad' : ''}" role="status"><strong>${ceiling <= 0 ? 'Writing allowance not configured' : used >= ceiling ? 'Monthly writing ceiling reached' : shortfall! > 0 ? 'More headroom needed for profile extraction' : 'Profile extraction fits the current allowance'}</strong><p>Used ${n(used)} · Monthly ceiling ${n(ceiling)} · Remaining ${n(remaining!)} model tokens.</p><p>Profile extraction preflight estimate: ${n(USAGE_ESTIMATES.profile)} tokens.${shortfall! > 0 ? ` Shortfall: ${n(shortfall!)} tokens. Minimum estimated monthly ceiling for this action: ${n(used + USAGE_ESTIMATES.profile)} tokens.` : ''}</p><a href="${url(b, 'publishing')}#writing-budget">Review writing allowance in Publishing</a><p class="muted">This is a usage ceiling, not a purchased credit balance. Choose and save your own limit; it is never increased automatically.</p></div>`;
  const profileBlock = p ? `<p><span class="pill ${p.confirmedAt ? 'ok' : 'warn'}">${p.confirmedAt ? 'Confirmed' : 'Needs your confirmation'}</span> Version ${p.version}${p.generation?.mode === 'simulated' ? ' · <span class="pill warn">simulated extraction</span>' : ''}</p>
<p>${e(p.summary)}</p>
<form method="post" action="${url(b, 'profile/edit')}">${csrfField(shell.csrf)}<input type="hidden" name="version" value="${p.version}">
${p.conflicts.length || p.missingFacts.length ? `<h3>Edit the items found</h3><p>Edit an issue directly, or tick <strong>Resolved</strong> only when you have settled it. Unticked issues remain. Save edits, then review and confirm the new profile. This does not run extraction or change your original documents.</p>` : ''}
${p.conflicts.map((c, i) => `<fieldset class="notice bad"><legend>Conflict ${i + 1}</legend><label for="conflict-${i}-field">Fact or offer</label><input id="conflict-${i}-field" name="conflict_${i}_field" value="${e(c.field)}" maxlength="200"><label for="conflict-${i}-detail">Issue / your correction</label><textarea id="conflict-${i}-detail" name="conflict_${i}_detail" maxlength="2000">${e(c.detail)}</textarea><p class="muted">Source documents: ${c.documentIds.map((id) => e(docs.find((d) => d.id === id)?.title ?? 'Original source document')).join(', ') || 'None recorded'}. Source references are retained.</p><label><input type="checkbox" name="conflict_${i}_resolved" value="1"> Resolved — remove this conflict from the new profile</label></fieldset>`).join('')}
${p.missingFacts.map((fact, i) => `<fieldset><legend>Missing fact ${i + 1}</legend><label for="missing-fact-${i}">Issue / your correction</label><textarea id="missing-fact-${i}" name="missingFact_${i}_text" maxlength="2000">${e(fact)}</textarea><label><input type="checkbox" name="missingFact_${i}_resolved" value="1"> Resolved — remove this missing fact from the new profile</label></fieldset>`).join('')}
<label for="pf-summary">Summary</label><textarea id="pf-summary" name="summary">${e(p.summary)}</textarea>
<label for="pf-positioning">Positioning</label><textarea id="pf-positioning" name="positioning">${e(p.positioning)}</textarea>
<label for="pf-audiences">Audiences (one per line)</label><textarea id="pf-audiences" name="audiences">${e(p.audiences.join('\n'))}</textarea>
<label for="pf-claims">Approved claims (one per line)</label><textarea id="pf-claims" name="approvedClaims">${e(p.approvedClaims.join('\n'))}</textarea>
<label for="pf-exclusions">Exclusions (one per line)</label><textarea id="pf-exclusions" name="exclusions">${e(p.exclusions.join('\n'))}</textarea>
<label for="pf-dont">Voice: avoid (one per line)</label><textarea id="pf-dont" name="voiceDont">${e(p.voice.dont.join('\n'))}</textarea>
<p><strong>Offers</strong> (prices exactly as your documents state):</p>${p.offers.length ? `<ul>${p.offers.map((o) => `<li>${e(o.name)}${o.price ? ` — ${e(o.price)}` : ''}</li>`).join('')}</ul>` : '<p class="muted">None found.</p>'}
<button class="secondary" type="submit">Save edits</button></form>
${p.confirmedAt ? '' : `<form method="post" action="${url(b, 'profile/confirm')}">${csrfField(shell.csrf)}<input type="hidden" name="version" value="${p.version}"><button type="submit">Confirm this profile</button></form>`}` : '<p class="muted">No profile yet. Upload guidance, then extract.</p>';
  const destinationForms = data.publishers.map((pub) => `<details class="card"><summary><strong>Connect: ${e(pub.label)}</strong></summary><p class="muted">${e(pub.description)}</p>
<form method="post" action="${url(b, 'destinations')}">${csrfField(shell.csrf)}<input type="hidden" name="type" value="${e(pub.type)}">
<label for="dl-${pub.type}">Name</label><input id="dl-${pub.type}" name="label" type="text" value="Website">
${pub.fields.map((f) => `<label for="df-${pub.type}-${f.key}">${e(f.label)}</label><input id="df-${pub.type}-${f.key}" name="cfg_${e(f.key)}" type="text" ${f.required ? 'required' : ''} placeholder="${e(f.placeholder ?? '')}"><small class="muted">${e(f.help)}</small>`).join('')}
<label for="dc-${pub.type}">${e(pub.credentialLabel)}</label><input id="dc-${pub.type}" name="credential" type="password" autocomplete="off" required>
<p class="muted">Stored encrypted on the server and never shown again.</p><button type="submit"${data.vaultReady ? '' : ' disabled'}>Connect and check</button>${data.vaultReady ? '' : ' <span class="muted">Secure credential storage is not configured on the server.</span>'}</form></details>`).join('');
  return layout(shell, 'Brand setup', `<h1>Brand setup</h1>
<section class="card"><h2>Website and locale</h2><form method="post" action="${url(b, 'basics')}">${csrfField(shell.csrf)}<input type="hidden" name="rowVersion" value="${b.rowVersion}">
<div class="row"><div><label for="bw">Website</label><input id="bw" name="website" type="text" value="${e(b.website ?? '')}"></div><div><label for="bl">Locale</label><input id="bl" name="locale" type="text" value="${e(b.locale)}"></div><div><label for="bt">Timezone</label><input id="bt" name="timezone" type="text" value="${e(b.timezone)}"></div></div><button type="submit">Save</button></form>
<form method="post" action="${url(b, 'inventory')}" style="margin-top:8px">${csrfField(shell.csrf)}<button class="secondary" type="submit"${b.website ? '' : ' disabled'}>Read website pages</button>
${data.inventory ? ` <span class="muted">Last read ${e(data.inventory.fetchedAt.slice(0, 16).replace('T', ' '))} UTC: ${data.inventory.pages.filter((x) => x.fetchStatus === 'ok').length} pages, ${data.inventory.pages.filter((x) => x.editorial).length} editorial, ${data.inventory.pages.filter((x) => x.fetchStatus !== 'ok').length} unreadable.</span>` : ''}</form></section>
<section class="card"><h2>Brand guidance</h2>
<form method="post" action="${url(b, 'knowledge')}" enctype="multipart/form-data">${csrfField(shell.csrf)}
<div class="row"><div><label for="kc">Kind</label><select id="kc" name="category">${cats}</select></div><div><label for="kt">Title</label><input id="kt" name="title" type="text"></div><div><label for="kf">File (PDF, DOCX, TXT, Markdown, PNG, JPEG, WebP)</label><input id="kf" name="file" type="file" accept=".pdf,.docx,.txt,.md,.markdown,.png,.jpg,.jpeg,.webp"></div></div>
<label for="kp">…or paste text</label><textarea id="kp" name="pastedText"></textarea>
<label for="kr">Replace an existing document (optional)</label><select id="kr" name="replaces"><option value="">— New document —</option>${docs.filter((d) => d.active).map((d) => `<option value="${e(d.id)}">${e(d.title)} (v${d.version})</option>`).join('')}</select>
<button type="submit">Upload</button></form>
<table><thead><tr><th>Document</th><th>Kind</th><th>Version</th><th>Result</th><th></th></tr></thead><tbody>${docs.map((d) => `<tr><td>${e(d.title)}</td><td>${CATEGORY_LABEL[d.category]}</td><td>${d.version}</td><td>${docStatus(d)} <span class="muted">${e(d.statusDetail)}</span></td><td>${d.active ? `<form method="post" action="${url(b, `knowledge/${d.id}/retire`)}">${csrfField(shell.csrf)}<button class="secondary" type="submit">Retire</button></form>` : '<span class="muted">Retired</span>'}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No guidance yet.</td></tr>'}</tbody></table>
<p class="muted">Uploaded documents are brand context only. Instructions inside them are ignored.</p></section>
<section class="card" id="brand-profile"><h2>Brand profile</h2>${taskStatus}${allowance}<form method="post" action="${url(b, 'profile/extract')}">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${e(data.extractionCommandId ?? '')}"><input type="hidden" name="baseVersion" value="${p?.version ?? 0}">${uncertainPrior && !activeProfile ? '<p class="notice bad">A previous model call has an uncertain outcome and may already have used tokens. Review the current profile before requesting another.</p><label><input type="checkbox" name="acknowledgePriorUsage" value="1" required> I have reviewed the current profile and want a new paid extraction; the earlier call may have used tokens.</label>' : ''}<button class="secondary" type="submit"${activeProfile || (shortfall !== null && (shortfall > 0 || ceiling <= 0)) ? ' disabled aria-describedby="profile-budget-help"' : ''}>${p ? 'Re-extract from current guidance' : 'Extract profile'}</button></form><p id="profile-budget-help" class="muted">Extraction queues in the background; you can leave and check its status here. The estimate is a preflight headroom check. Actual recorded usage may differ with document length and retries.</p>${profileBlock}</section>
<section class="card"><h2>Website publishing connection</h2>${data.destinations.length ? `<table><tbody>${data.destinations.map((d) => `<tr><td>${e(d.label)}</td><td>${e(d.publicBaseUrl)}</td><td><span class="pill ${d.status === 'connected' ? 'ok' : d.status === 'failed' ? 'bad' : 'warn'}">${d.status === 'connected' ? 'Connected' : d.status === 'failed' ? 'Failed' : 'Not checked'}</span> <span class="muted">${e(d.statusDetail)}</span></td><td><form method="post" action="${url(b, `destinations/${d.id}/check`)}">${csrfField(shell.csrf)}<button class="secondary" type="submit">Check again</button></form></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No website connected.</p>'}
${destinationForms}<p class="muted">Other website types are not supported yet. You can always export articles as Markdown or HTML.</p></section>`);
}

export function topicsPage(shell: Shell, data: { plans: { plan: TopicPlan; briefs: ArticleBrief[] }[]; readiness: BrandReadiness; commandId: string; estimatePerArticle: number }): string {
  const b = shell.brand!;
  const planForm = `<section class="card"><h2>Plan my content</h2>${data.readiness.canPlan ? '' : `<p class="notice bad">${e(data.readiness.missing.filter((m) => !m.includes('for publishing')).join(' '))}</p>`}
<form method="post" action="${url(b, 'plan')}">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${e(data.commandId)}">
<p class="muted">No topic needed — the engine reads your website, researches and proposes a cluster itself. Optional:</p>
<div class="row"><div><label for="pfocus">Campaign focus</label><input id="pfocus" name="focus" type="text" maxlength="300"></div><div><label for="pex">Subjects to avoid (comma separated)</label><input id="pex" name="excluded" type="text"></div><div><label for="psrc">Start from an article URL</label><input id="psrc" name="sourceArticleUrl" type="text"></div></div>
<button type="submit"${data.readiness.canPlan ? '' : ' disabled'}>Plan my content</button></form></section>`;
  const plans = data.plans.map(({ plan, briefs }) => `<section class="card"><h2>${e(plan.topic)}</h2><p><span class="pill ${plan.status === 'accepted' ? 'ok' : 'warn'}">${plan.status === 'accepted' ? 'Accepted' : plan.status === 'proposed' ? 'Proposed' : e(plan.status)}</span> ${plan.generation.mode === 'simulated' ? '<span class="pill warn">simulated plan</span>' : ''} <span class="muted">${plan.sources.length} research sources</span></p>
${plan.status === 'proposed' ? `<form method="post" action="${url(b, `plans/${plan.id}/accept`)}">${csrfField(shell.csrf)}<button type="submit">Accept plan</button></form>` : ''}
<form method="post" action="${url(b, 'generate')}">${csrfField(shell.csrf)}<table><thead><tr><th><span class="muted">Select</span></th><th>Article</th><th>Why it fits</th><th>Demand</th><th>Overlap</th><th>Suggested</th><th></th></tr></thead><tbody>
${briefs.map((x) => `<tr><td>${['planned', 'accepted'].includes(x.status) ? `<input type="checkbox" name="brief" value="${e(x.id)}" aria-label="Select ${e(x.workingTitle)}">` : ''}</td>
<td><strong>${e(x.workingTitle)}</strong><br><span class="pill">${x.role === 'pillar' ? 'Pillar' : 'Supporting'}</span> <span class="muted">${e(x.searchIntent)} · “${e(x.targetQuery)}”</span><details><summary>Angle and outline</summary><p>${e(x.angle)}</p><ol>${x.outline.map((o) => `<li>${e(o)}</li>`).join('')}</ol><p class="muted">Sources: ${x.sourceIds.map((id) => { const s = plan.sources.find((y) => y.id === id); return s ? `<a href="${e(s.url)}" rel="noopener">${e(s.title)}</a>` : ''; }).filter(Boolean).join(', ') || 'none'}</p></details></td>
<td>${e(x.whyFit)}</td><td>${x.demand.kind === 'measured' ? `Measured: ${x.demand.volume ?? '—'} searches/month (${e(x.demand.provider)}, ${e(x.demand.retrievedAt.slice(0, 10))})` : '<span class="muted">Qualitative</span>'}</td>
<td>${x.duplicate.verdict === 'distinct' ? '<span class="pill ok">Distinct</span>' : `<span class="pill warn">${e({ new_angle: 'Overlap', update_existing: 'Update existing page', skip: 'Duplicate', distinct: '' }[x.duplicate.verdict])}</span><br><small>${e(x.duplicate.advice)}</small>`}</td>
<td>${x.suggestedAtUtc ? e(utcToLocal(x.suggestedAtUtc, b.timezone).date) : '<span class="muted">—</span>'}</td>
<td>${e(x.status)}${['planned', 'accepted', 'postponed', 'omitted'].includes(x.status) ? ` <button class="secondary" type="submit" formaction="${url(b, `briefs/${x.id}/${x.status === 'omitted' || x.status === 'postponed' ? 'planned' : 'omitted'}`)}">${x.status === 'omitted' || x.status === 'postponed' ? 'Restore' : 'Omit'}</button>` : ''}</td></tr>`).join('')}
</tbody></table><p class="muted">Estimated writing use: about ${data.estimatePerArticle.toLocaleString('en-GB')} tokens per article.</p><button type="submit">Generate selected articles</button></form></section>`).join('');
  return layout(shell, 'Topics', `<h1>Topics</h1>${planForm}${plans || '<p class="muted">No plans yet.</p>'}`);
}

export function articlesPage(shell: Shell, data: { articles: { article: Article; title: string; status: string }[] }): string {
  const b = shell.brand!;
  return layout(shell, 'Articles', `<h1>Articles</h1><section class="card"><table><thead><tr><th>Title</th><th>Status</th><th>Scheduled</th><th>Checks</th></tr></thead><tbody>
${data.articles.map(({ article, title, status }) => `<tr><td><a href="${url(b, `articles/${article.id}`)}">${e(title)}</a></td><td><span class="pill ${statusClass(status)}">${e(status)}</span>${article.hold ? `<br><small>${e(article.hold.detail)}</small>` : ''}</td><td>${article.schedule ? `${e(article.schedule.localDate)} ${e(article.schedule.localTime)}` : '<span class="muted">Unscheduled</span>'}</td><td>${article.checks ? `<span class="pill ${article.checks.status === 'pass' ? 'ok' : article.checks.status === 'warnings' ? 'warn' : 'bad'}">${article.checks.status === 'critical' ? 'Must fix' : article.checks.status === 'warnings' ? 'Suggestions' : 'Passed'}</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No articles yet. Generate them from Topics.</td></tr>'}
</tbody></table></section>`);
}

function statusClass(status: string): string {
  return ['Published', 'Scheduled', 'Approved'].includes(status) ? 'ok' : ['Held', 'Failed', 'Outcome unknown'].includes(status) ? 'bad' : 'warn';
}

export function editorPage(shell: Shell, data: { article: Article; version: ArticleVersion | null; versions: ArticleVersion[]; publications: Publication[]; status: string; destinations: Omit<Destination, 'sealedCredential'>[]; social?: SocialOverview | null }): string {
  const b = shell.brand!;
  const a = data.article;
  const v = data.version;
  if (!v) return layout(shell, 'Article', `<h1>Article</h1><p class="notice">${a.editorialState === 'failed' ? `Writing failed: ${e(a.failure ?? '')}` : 'This article is being written. Progress continues if you leave this page.'}</p>`);
  const body = v.body;
  const base = url(b, `articles/${a.id}`);
  const issues = a.checks?.issues ?? [];
  return layout(shell, body.title, `<h1>${e(body.title)}</h1>
<p><span class="pill ${statusClass(data.status)}">${e(data.status)}</span> Version ${v.number}${v.generation?.mode === 'simulated' ? ' · <span class="pill warn">simulated text</span>' : ''} · <a href="${base}/preview?v=${e(v.id)}" target="_blank" rel="noopener">Preview</a> · <a href="${base}/export?format=markdown">Export Markdown</a> · <a href="${base}/export?format=html">Export HTML</a></p>
${a.hold ? `<p class="notice bad">Held: ${e(a.hold.detail)}</p>` : ''}
<div class="grid"><section class="card"><h2>Checks</h2>${issues.length ? `<ul>${issues.map((i) => `<li><span class="pill ${i.severity === 'critical' ? 'bad' : 'warn'}">${i.severity === 'critical' ? 'Must fix' : 'Suggestion'}</span> ${e(i.message)}${i.location ? ` <span class="muted">(${e(i.location)})</span>` : ''}<br><small>Fix: ${e(i.fix)}</small></li>`).join('')}</ul>` : '<p>No issues found. Checks are editorial signals, not guarantees.</p>'}
<form method="post" action="${base}/checks">${csrfField(shell.csrf)}<button class="secondary" type="submit">Run checks again</button></form></section>
<section class="card"><h2>Approval</h2>
<form method="post" action="${base}/approval-flag">${csrfField(shell.csrf)}<input type="hidden" name="rowVersion" value="${a.rowVersion}"><input type="hidden" name="required" value="${a.requiresApproval ? '0' : '1'}"><p>Needs my approval: <span class="pill toggle-state ${a.requiresApproval ? 'on' : 'off'}">${a.requiresApproval ? 'On' : 'Off'}</span> <button role="switch" aria-checked="${a.requiresApproval}" aria-label="Needs my approval: ${a.requiresApproval ? 'On. Turn off' : 'Off. Turn on'}" class="toggle-control ${a.requiresApproval ? 'on' : 'off'}" type="submit">${a.requiresApproval ? 'Turn off' : 'Turn on'}</button></p></form>
${a.approval?.versionId === v.id ? `<p><span class="pill ok">Version ${v.number} approved</span></p>` : `<form method="post" action="${base}/approve">${csrfField(shell.csrf)}<input type="hidden" name="versionId" value="${e(v.id)}"><button type="submit"${a.checks?.status === 'critical' ? ' disabled' : ''}>Approve version ${v.number}</button></form>`}
<form method="post" action="${base}/hold">${csrfField(shell.csrf)}<input type="hidden" name="rowVersion" value="${a.rowVersion}"><input type="hidden" name="held" value="${a.hold ? '0' : '1'}"><button class="secondary" type="submit">${a.hold ? 'Release hold' : 'Hold'}</button></form></section>
<section class="card"><h2>Schedule</h2>${scheduleForm(shell, b, a, data.destinations, base)}</section></div>
<section class="card"><h2>Edit</h2><form method="post" action="${base}/edit">${csrfField(shell.csrf)}<input type="hidden" name="versionId" value="${e(v.id)}">
<div class="row"><div><label for="et">Title (page heading)</label><input id="et" name="title" type="text" value="${e(body.title)}"></div><div><label for="es">Slug</label><input id="es" name="slug" type="text" value="${e(body.slug)}"></div></div>
<div class="row"><div><label for="est">SEO title</label><input id="est" name="seoTitle" type="text" value="${e(body.seoTitle)}"></div><div><label for="emd">Meta description</label><input id="emd" name="metaDescription" type="text" value="${e(body.metaDescription)}"></div></div>
<label for="eex">Excerpt</label><input id="eex" name="excerpt" type="text" value="${e(body.excerpt)}">
<div class="row"><div><label for="eimg">Featured image URL (existing brand image)</label><input id="eimg" name="imageUrl" type="text" value="${e(body.image.url ?? '')}"></div><div><label for="ealt">Image alt text</label><input id="ealt" name="imageAlt" type="text" value="${e(body.image.alt)}"></div></div>
<label for="ei">Introduction</label><textarea id="ei" name="intro">${e(body.intro)}</textarea>
${body.sections.map((s, i) => `<fieldset class="card"><legend>Section ${i + 1}</legend><input type="hidden" name="sectionId" value="${e(s.id)}"><label for="sh${i}">Heading</label><input id="sh${i}" name="sectionHeading" type="text" value="${e(s.heading)}"><label for="sb${i}">Body</label><textarea id="sb${i}" name="sectionBody">${e(s.body)}</textarea></fieldset>`).join('')}
<label for="ec">Conclusion</label><textarea id="ec" name="conclusion">${e(body.conclusion)}</textarea>
<p class="muted">Saving creates a new version, keeps the old one and resets approval. Citations like [src:…] link claims to sources.</p><button type="submit">Save as new version</button></form></section>
<section class="card"><h2>Regenerate one section</h2><form method="post" action="${base}/regenerate-section">${csrfField(shell.csrf)}<input type="hidden" name="versionId" value="${e(v.id)}">
<label for="rs">Section</label><select id="rs" name="sectionId">${body.sections.map((s) => `<option value="${e(s.id)}">${e(s.heading)}</option>`).join('')}</select>
<label for="ri">What should change?</label><input id="ri" name="instruction" type="text" maxlength="1000"><p class="muted">Only this section changes; the rest is kept exactly.</p><button type="submit">Regenerate section</button></form>
<form method="post" action="${base}/regenerate">${csrfField(shell.csrf)}<input type="hidden" name="versionId" value="${e(v.id)}"><button class="secondary" type="submit">Regenerate whole article</button></form></section>
<section class="card"><h2>Accompanying social posts</h2><p>Review these separately from the blog. Each approval binds the exact article version, post and blog URL. Editing the article requires new linked approvals.</p>
${v.promotionPack ? `<p class="muted">${v.promotionPack.mode === 'model' ? 'Brand-grounded model drafts' : 'Article excerpt fallback; the social writing stage was unavailable'} · ${v.promotionPack.canonicalUrl ? `Reviewed blog URL: ${e(v.promotionPack.canonicalUrl)}` : 'Connect a blog website, then refresh these drafts to bind the final URL.'}</p>
${v.promotionPack.posts.map(post => `<article class="card"><h3>${e(post.network)} — ${e(post.title)}</h3><pre style="white-space:pre-wrap">${e(post.copy)}${v.promotionPack!.canonicalUrl ? `\n\n${e(v.promotionPack!.canonicalUrl)}` : ''}</pre><p><strong>Artwork brief:</strong> ${e(post.artworkInstructions)}</p><p class="notice">${e(promotionPublicationHold(a, v, post.network) ?? 'Blog and exact post approval are ready. Select this brand’s connected account in its social calendar.')}</p>
<form method="post" action="${base}/promotion-approve">${csrfField(shell.csrf)}<input type="hidden" name="versionId" value="${e(v.id)}"><input type="hidden" name="packSha" value="${e(sha256(v.promotionPack))}"><input type="hidden" name="network" value="${post.network}"><button type="submit"${v.promotionPack!.canonicalUrl ? '' : ' disabled'}>Approve exact ${e(post.network)} post</button></form>
${socialScheduleBlock(shell, a, v, post.network, base, data.social)}</article>`).join('')}` : '<p>No accompanying drafts were created for this older article version.</p>'}
<form method="post" action="${base}/promotion-refresh">${csrfField(shell.csrf)}<input type="hidden" name="versionId" value="${e(v.id)}"><button class="secondary" type="submit">Create new promotion version with current blog URL</button></form></section>
<section class="card"><h2>Sources</h2><ol>${body.citations.map((c) => `<li><a href="${e(c.url)}" rel="noopener">${e(c.title)}</a> <span class="muted">retrieved ${e(c.retrievedAt.slice(0, 10))}${c.public ? '' : ' · internal only'}</span><br><small>${e(c.passage)}</small></li>`).join('')}</ol></section>
<section class="card"><h2>History</h2><table><tbody>${[...data.versions].reverse().map((x) => `<tr><td>Version ${x.number}</td><td>${e({ generated: 'Written', edited: 'Edited', section_regenerated: 'Section regenerated', regenerated: 'Regenerated', image_changed: 'Image changed', metadata_changed: 'Details changed' }[x.change])}</td><td>${e(x.createdAt.slice(0, 16).replace('T', ' '))} UTC</td><td><a href="${base}/preview?v=${e(x.id)}" target="_blank" rel="noopener">Preview</a></td></tr>`).join('')}</tbody></table>
${data.publications.length ? `<h3>Publication attempts</h3><ul>${data.publications.map((p) => `<li>${e(p.state.replace('_', ' '))} — ${e(p.detail)}${p.verifiedAt ? ` (verified ${e(p.verifiedAt.slice(0, 16).replace('T', ' '))} UTC at <a href="${e(p.publicUrl)}">${e(p.publicUrl)}</a>)` : ''}</li>`).join('')}</ul>` : ''}</section>`);
}

function scheduleForm(shell: Shell, b: Brand, a: Article, destinations: Omit<Destination, 'sealedCredential'>[], base: string): string {
  if (!destinations.length) return '<p class="muted">Connect a website in Brand setup first.</p>';
  const s = a.schedule;
  return `<form method="post" action="${base}/schedule" data-schedule-form>${csrfField(shell.csrf)}<input type="hidden" name="rowVersion" value="${a.rowVersion}">
<label for="sd-${a.id}">Date</label><input id="sd-${a.id}" name="localDate" type="date" value="${e(s?.localDate ?? '')}" required>
<label for="st-${a.id}">Time (${e(b.timezone)})</label><input id="st-${a.id}" name="localTime" type="time" value="${e(s?.localTime ?? b.settings.cadence.localTime)}" required>
<label for="sw-${a.id}">Website</label><select id="sw-${a.id}" name="destinationId">${destinations.map((d) => `<option value="${e(d.id)}"${d.id === s?.destinationId ? ' selected' : ''}>${e(d.label)}</option>`).join('')}</select>
<button type="submit">${s ? 'Move' : 'Schedule'}</button></form>${s ? `<form method="post" action="${base}/unschedule">${csrfField(shell.csrf)}<input type="hidden" name="rowVersion" value="${a.rowVersion}"><button class="secondary" type="submit">Cancel schedule</button></form>` : ''}
<p class="muted">A diary slot does not change the website until publication is verified.</p>`;
}

export function calendarPage(shell: Shell, data: { view: 'month' | 'week' | 'list'; anchor: string; articles: { article: Article; title: string; status: string }[]; briefs: ArticleBrief[]; destinations: Omit<Destination, 'sealedCredential'>[]; brandsAll: boolean }): string {
  const b = shell.brand!;
  const scheduled = data.articles.filter((x) => x.article.schedule);
  const tray = data.articles.filter((x) => !x.article.schedule && x.article.currentVersionId && x.status !== 'Published');
  const planned = data.briefs.filter((x) => x.suggestedAtUtc && ['planned', 'accepted'].includes(x.status));
  const proposed = tray.flatMap(x => {
    const brief = data.briefs.find(b => b.id === x.article.briefId);
    return brief?.suggestedAtUtc ? [{ ...x, proposal: utcToLocal(brief.suggestedAtUtc, b.timezone) }] : [];
  });
  const days: string[] = [];
  if (data.view === 'week') {
    const local = utcToLocal(`${data.anchor}T12:00:00Z`, 'UTC');
    const monday = addDays(data.anchor, 1 - local.weekday);
    for (let i = 0; i < 7; i++) days.push(addDays(monday, i));
  } else {
    const first = `${data.anchor.slice(0, 7)}-01`;
    const lead = utcToLocal(`${first}T12:00:00Z`, 'UTC').weekday - 1;
    for (let i = -lead; i < 42 - lead; i++) days.push(addDays(first, i));
  }
  const card = (x: { article: Article; title: string; status: string }) => `<div class="slot" draggable="true" data-article="${e(x.article.id)}" data-row-version="${x.article.rowVersion}" data-time="${e(x.article.schedule?.localTime ?? b.settings.cadence.localTime)}" data-destination="${e(x.article.schedule?.destinationId ?? data.destinations[0]?.id ?? '')}"><a href="${url(b, `articles/${x.article.id}`)}">${e(x.title)}</a><br>${e(b.name)} · ${e(x.article.schedule?.localTime ?? '')} · <span class="pill ${statusClass(x.status)}">${e(x.status)}</span>${x.article.schedule ? ` · ${e(data.destinations.find((d) => d.id === x.article.schedule!.destinationId)?.label ?? 'Website')}` : ''}</div>`;
  const plannedCard = (x: ArticleBrief) => `<div class="slot planned">Planned: ${e(x.workingTitle)}<br><span class="muted">not written yet</span></div>`;
  const proposalCard = (x: typeof proposed[number]) => `<div class="slot planned" data-editorial-proposal><strong>BLOG · proposed ${e(x.proposal.time)}</strong><br><a href="${url(b, `articles/${x.article.id}`)}">${e(x.title)}</a><br><span class="pill">${e(x.status)}</span><br><small>Draft for review · no publication scheduled</small><form method="post" action="${url(b, `articles/${x.article.id}/proposal`)}">${csrfField(shell.csrf)}<input type="hidden" name="rowVersion" value="${x.article.rowVersion}"><input aria-label="Proposed date" type="date" name="localDate" value="${e(x.proposal.date)}" required><input aria-label="Proposed time" type="time" name="localTime" value="${e(x.proposal.time)}" required><button class="secondary" type="submit">Move proposed date</button></form></div>`;
  const grid = data.view === 'list'
    ? `<table><thead><tr><th>Date</th><th>Time</th><th>Article</th><th>Status</th><th>Website</th></tr></thead><tbody>${scheduled.sort((x, y) => x.article.schedule!.publishAtUtc.localeCompare(y.article.schedule!.publishAtUtc)).map((x) => `<tr><td>${e(x.article.schedule!.localDate)}</td><td>${e(x.article.schedule!.localTime)}</td><td><a href="${url(b, `articles/${x.article.id}`)}">${e(x.title)}</a></td><td>${e(x.status)}</td><td>${e(data.destinations.find((d) => d.id === x.article.schedule!.destinationId)?.label ?? '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing scheduled.</td></tr>'}</tbody></table>`
    : `<div class="cal" role="grid">${days.map((d) => `<div class="day" role="gridcell" data-date="${d}" aria-label="${d}"><h4>${d.slice(8)}${d.slice(0, 7) !== data.anchor.slice(0, 7) && data.view === 'month' ? ` ${d.slice(5, 7)}` : ''}</h4>${scheduled.filter((x) => x.article.schedule!.localDate === d).map(card).join('')}${proposed.filter(x => x.proposal.date === d).map(proposalCard).join('')}${planned.filter((x) => utcToLocal(x.suggestedAtUtc!, b.timezone).date === d).map(plannedCard).join('')}</div>`).join('')}</div>`;
  const shift = (n: number) => data.view === 'week' ? addDays(data.anchor, 7 * n) : addDays(`${data.anchor.slice(0, 7)}-15`, 30 * n);
  return layout(shell, 'Calendar', `<h1>Calendar</h1>
<p><a href="?view=month&date=${data.anchor}">Month</a> · <a href="?view=week&date=${data.anchor}">Week</a> · <a href="?view=list&date=${data.anchor}">List</a> · <a href="?view=${data.view}&date=${shift(-1)}">‹ Previous</a> · <a href="?view=${data.view}&date=${shift(1)}">Next ›</a> · <strong>${e(data.anchor.slice(0, 7))}</strong> · times in ${e(b.timezone)}</p>
<form method="post" action="${url(b, 'calendar/autoplace')}" class="row">${csrfField(shell.csrf)}<div><label for="apd">Place unscheduled articles on</label><select id="apd" name="destinationId">${data.destinations.map((d) => `<option value="${e(d.id)}">${e(d.label)}</option>`).join('')}</select></div><div><button type="submit"${data.destinations.length ? '' : ' disabled'}>Automatic placement</button></div></form>
<section class="card">${grid}${data.view === 'list' ? `<h2>Proposed drafts awaiting review</h2>${proposed.map(proposalCard).join('') || '<p>No proposed drafts.</p>'}${planned.map(plannedCard).join('')}` : ''}</section>
<section class="card"><h2>Unscheduled</h2>${tray.length ? tray.map((x) => `<details><summary>${e(x.title)} — <span class="pill ${statusClass(x.status)}">${e(x.status)}</span></summary>${scheduleForm(shell, b, x.article, data.destinations, url(b, `articles/${x.article.id}`))}</details>`).join('') : '<p class="muted">Nothing waiting.</p>'}</section>
<form id="dnd-form" method="post" hidden>${csrfField(shell.csrf)}<input name="rowVersion"><input name="localDate"><input name="localTime"><input name="destinationId"></form>
<script src="${SEO_BLOG_BASE}/calendar.js" defer></script>`);
}

/** Progressive enhancement only: dropping a card submits the same form a keyboard user can fill in. */
export const CALENDAR_SCRIPT = `(() => {
  const form = document.getElementById('dnd-form');
  if (!form) return;
  let dragged = null;
  document.querySelectorAll('.slot[draggable=true]').forEach((el) => el.addEventListener('dragstart', () => { dragged = el; }));
  document.querySelectorAll('.day[data-date]').forEach((day) => {
    day.addEventListener('dragover', (ev) => { if (dragged) { ev.preventDefault(); day.classList.add('drop'); } });
    day.addEventListener('dragleave', () => day.classList.remove('drop'));
    day.addEventListener('drop', (ev) => {
      ev.preventDefault(); day.classList.remove('drop');
      if (!dragged || !dragged.dataset.destination) return;
      form.action = location.pathname.replace(/\\/calendar$/, '') + '/articles/' + dragged.dataset.article + '/schedule';
      form.elements.rowVersion.value = dragged.dataset.rowVersion;
      form.elements.localDate.value = day.dataset.date;
      form.elements.localTime.value = dragged.dataset.time;
      form.elements.destinationId.value = dragged.dataset.destination;
      form.submit();
    });
  });
})();`;

export function publishingPage(shell: Shell, data: { usage: Record<UsageKind, number> }): string {
  const b = shell.brand!;
  const s = b.settings;
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const toggle = (name: string, on: boolean, label: string, help: string) => `<form method="post" action="${url(b, 'settings/toggle')}">${csrfField(shell.csrf)}<input type="hidden" name="rowVersion" value="${b.rowVersion}"><input type="hidden" name="name" value="${name}"><input type="hidden" name="value" value="${on ? '0' : '1'}"><p><strong>${label}:</strong> <span class="pill toggle-state ${on ? name === 'pauseAll' ? 'paused' : 'on' : 'off'}">${on ? 'On' : 'Off'}</span> <button role="switch" aria-checked="${on}" aria-label="${e(label)}: ${on ? 'On. Turn off' : 'Off. Turn on'}" class="toggle-control ${on ? name === 'pauseAll' ? 'paused' : 'on' : 'off'}" type="submit">${on ? 'Turn off' : 'Turn on'}</button><br><small class="muted">${help}</small></p></form>`;
  return layout(shell, 'Publishing', `<h1>Publishing</h1>
<section class="card"><h2>Controls</h2>
${toggle('autoPublish', s.autoPublish, 'Automatic publishing', 'On: articles that do not need your approval publish at their diary time if checks and the website connection pass. Off: every article needs approval of its exact version.')}
${toggle('pauseAll', s.pauseAll, 'Pause all blog publishing', 'Holds every publication that has not started, including approved articles. Missed times are never replayed.')}
${toggle('ongoingProduction', s.ongoingProduction, 'Ongoing production', 'A bounded daily job refreshes the website inventory, tops up the plan and drafts accepted articles up to the backlog ceiling. It never publishes by itself.')}
${toggle('autoAcceptPlans', s.autoAcceptPlans, 'Accept system plans automatically', 'Only used with ongoing production.')}</section>
<section class="card"><h2>Cadence, limits and author</h2><form method="post" action="${url(b, 'settings')}">${csrfField(shell.csrf)}<input type="hidden" name="rowVersion" value="${b.rowVersion}">
<fieldset><legend>Publishing days</legend>${days.map((d, i) => `<label style="display:inline-block;margin-right:10px;font-weight:400"><input type="checkbox" name="weekday" value="${i + 1}"${s.cadence.weekdays.includes(i + 1) ? ' checked' : ''}> ${d}</label>`).join('')}</fieldset>
<div class="row"><div><label for="ct">Time</label><input id="ct" name="localTime" type="time" value="${e(s.cadence.localTime)}"></div><div><label for="cp">Posts per week</label><input id="cp" name="perWeek" type="number" min="1" max="14" value="${s.cadence.perWeek}"></div><div><label for="ch">Planning horizon (days)</label><input id="ch" name="horizon" type="number" min="7" max="120" value="${s.planningHorizonDays}"></div><div><label for="cb">Backlog ceiling</label><input id="cb" name="backlog" type="number" min="0" max="50" value="${s.backlogCeiling}"></div></div>
<div class="row"><div id="writing-budget"><label for="bm">Writing allowance (model tokens / UTC calendar month)</label><input id="bm" name="modelTokens" type="number" min="0" value="${s.budgets.modelTokensPerMonth}" aria-describedby="token-budget-guide"></div><div><label for="bs">Research allowance (searches / month)</label><input id="bs" name="searchCalls" type="number" min="0" value="${s.budgets.searchCallsPerMonth}"></div><div><label for="bi">Images / month</label><input id="bi" name="images" type="number" min="0" value="${s.budgets.imagesPerMonth}"></div></div>
<div id="token-budget-guide" class="notice"><p>Model tokens count recorded input and output usage together for this brand, from the first day of each month at 00:00 UTC. This limit is not a wallet or purchased Relaunch72 credits. Profile extraction needs at least ${USAGE_ESTIMATES.profile.toLocaleString('en-GB')} tokens of remaining preflight headroom; earlier usage adds to the minimum ceiling. Estimates are not guaranteed final usage.</p><p><strong>Provider-cost example only:</strong> Sonnet 4.6 standard global rates are US$3 per million input tokens and US$15 per million output tokens. An example of 10,000 input + 4,000 output tokens costs US$0.09. The active model can be overridden, and document length, input/output split, retries and cache use affect actual billing. Total tokens alone do not determine the cost. <a href="https://platform.claude.com/docs/en/about-claude/pricing" target="_blank" rel="noopener noreferrer">Check current Anthropic API pricing</a> and your provider console. No limit or provider credit is purchased or increased by this guide.</p></div>
<div class="row"><div><label for="lp">Length preference</label><select id="lp" name="length">${(['concise', 'standard', 'in-depth'] as const).map((l) => `<option value="${l}"${s.lengthPreference === l ? ' selected' : ''}>${l}</option>`).join('')}</select></div><div><label for="an">Author name (optional)</label><input id="an" name="authorName" type="text" value="${e(s.author?.name ?? '')}"></div><div><label for="au">Author profile URL (optional)</label><input id="au" name="authorUrl" type="text" value="${e(s.author?.url ?? '')}"></div></div>
<button type="submit">Save settings</button></form>
<p class="muted">Used this month: ${data.usage.model_tokens.toLocaleString('en-GB')} tokens, ${data.usage.search_calls} searches, ${data.usage.images} images.</p></section>`);
}

export function activityPage(shell: Shell, data: { events: ActivityEvent[]; jobs: Job[] }): string {
  const b = shell.brand!;
  const label: Record<string, string> = { inventory: 'Read website', plan: 'Plan content', write: 'Write article', publish: 'Publish', daily: 'Daily top-up' };
  return layout(shell, 'Activity', `<h1>Activity</h1>
<section class="card"><h2>Tasks</h2><table><thead><tr><th>Task</th><th>State</th><th>Detail</th><th></th></tr></thead><tbody>${data.jobs.slice(0, 50).map((j) => `<tr><td>${e(isProfileJob(j) ? 'Profile extraction' : label[j.kind] ?? j.kind)}</td><td>${e(j.state)}</td><td>${e(j.error ?? j.progress)}</td><td>${['queued', 'running', 'blocked'].includes(j.state) ? `<form method="post" action="${url(b, `jobs/${j.id}/cancel`)}">${csrfField(shell.csrf)}<button class="secondary" type="submit">Cancel</button></form>` : ''}${['blocked', 'failed'].includes(j.state) ? isProfileJob(j) && profilePayload(j).start && !profilePayload(j).receipt ? `<a href="${url(b, 'setup')}#brand-profile">Review before a new extraction</a>` : `<form method="post" action="${url(b, `jobs/${j.id}/retry`)}">${csrfField(shell.csrf)}<button class="secondary" type="submit">${isProfileJob(j) && profilePayload(j).receipt ? 'Apply saved result (no model call)' : 'Retry'}</button></form>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No tasks.</td></tr>'}</tbody></table></section>
<section class="card"><h2>History</h2><ul>${data.events.map((ev) => `<li><span class="muted">${e(ev.at.slice(0, 16).replace('T', ' '))} UTC</span> ${e(ev.message)}</li>`).join('') || '<li class="muted">Nothing yet.</li>'}</ul></section>`);
}

export { articleStatusLabel };

function dispatchLabel(d: SocialDispatch, timezone: string): string {
  const local = utcToLocal(d.scheduledFor, timezone);
  return `${local.date} ${local.time} — ${d.state === 'queued' ? `queued (re-verified shortly before sending; caps ${d.dailyCap}/day, ${d.monthlyCap}/month)` : `held: ${d.detail ?? ''}`}`;
}

function socialScheduleBlock(shell: Shell, a: Article, v: ArticleVersion, network: 'instagram' | 'linkedin', base: string, social: SocialOverview | null | undefined): string {
  const b = shell.brand!;
  const dispatches = (a.socialDispatches ?? []).filter(d => d.articleVersionId === v.id && d.network === network);
  const history = dispatches.length ? `<ul class="muted">${dispatches.slice(-5).map(d => `<li>${e(dispatchLabel(d, b.timezone))}</li>`).join('')}</ul>` : '';
  const articleHold = promotionPublicationHold(a, v, network);
  const accountHold = social ? bindingHold(social.bindings, network) : 'Social delivery is not available on this server.';
  if (articleHold || accountHold) return `${history}<p class="muted">Scheduling: ${e(articleHold ?? accountHold ?? '')}${!articleHold && accountHold ? ` <a href="${url(b, 'social')}">Register accounts</a>` : ''}</p>`;
  const local = utcToLocal(new Date(Date.now() + 3_600_000).toISOString(), b.timezone);
  return `${history}<form method="post" action="${base}/social-schedule">${csrfField(shell.csrf)}<input type="hidden" name="versionId" value="${e(v.id)}"><input type="hidden" name="packSha" value="${e(sha256(v.promotionPack))}"><input type="hidden" name="network" value="${network}">
<div class="row"><div><label for="sd-${network}">Date (${e(b.timezone)})</label><input id="sd-${network}" name="localDate" type="date" value="${e(local.date)}" required></div><div><label for="st-${network}">Time</label><input id="st-${network}" name="localTime" type="time" value="${e(local.time)}" required></div></div>
<button type="submit">Queue ${e(network)} post through the brand’s registered account</button><p class="muted">The post is re-verified against the live article shortly before sending; if the article, URL or approval changed, nothing is sent.</p></form>`;
}

export function socialPage(shell: Shell, data: { overview: SocialOverview; connectHere: boolean; connectHost: string; intentId: string }): string {
  const b = shell.brand!;
  const o = data.overview;
  const networks = ['instagram', 'linkedin'] as const;
  const profile = o.profile
    ? `<p><strong>Zernio profile:</strong> ${e(o.profile.providerProfileId)} <span class="muted">registered ${e(o.profile.registeredAt.slice(0, 16).replace('T', ' '))} UTC</span></p>`
    : `<form method="post" action="${url(b, 'social/profile')}">${csrfField(shell.csrf)}<label for="pp">Zernio profile id for this brand</label><input id="pp" name="providerProfileId" type="text" required pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,127}"><label for="pn">Connection name</label><input id="pn" name="displayName" type="text" maxlength="120" value="${e(b.name)} social accounts"><p class="muted">Create a separate profile for this brand in your Zernio dashboard and paste its id. Property Predator’s profile can never be registered to a brand.</p><button type="submit">Register profile</button></form>`;
  const connect = o.profile ? `<h3>Connect accounts</h3>${data.connectHere
    ? networks.map(n => `<form method="post" action="${url(b, 'social/connect')}" style="display:inline-block;margin-right:8px">${csrfField(shell.csrf)}<input type="hidden" name="network" value="${n}"><input type="hidden" name="intentId" value="${e(data.intentId)}"><input type="hidden" name="confirm" value="CONNECT"><button class="secondary" type="submit">Connect ${n}</button></form>`).join('')
    : `<p class="muted">Account connection completes through the provider callback on <a href="${e(data.connectHost)}${url(b, 'social')}">${e(data.connectHost)}</a>. Open this page there to connect accounts.</p>`}` : '';
  const accounts = o.accounts.length ? `<table><thead><tr><th>Network</th><th>Username</th><th>Status</th><th>Connected</th></tr></thead><tbody>${o.accounts.map(acc => `<tr><td>${e(acc.network)}</td><td>${e(acc.username ?? '—')}</td><td>${e(acc.status)}${acc.webhookReceiptCount === 0 ? ' <span class="muted">(awaiting provider confirmation)</span>' : ''}</td><td>${e(acc.linkedAt.slice(0, 10))}</td></tr>`).join('')}</tbody></table>` : (o.profile ? '<p class="muted">No accounts connected yet.</p>' : '');
  const bindings = o.bindings.filter(x => x.status === 'active');
  const registered = bindings.length ? `<table><thead><tr><th>Network</th><th>Account</th><th>Per day</th><th>Per month</th><th></th></tr></thead><tbody>${bindings.map(x => `<tr><td>${e(x.network)}</td><td>${e(x.username ?? '—')} <code class="muted">${e(x.providerAccountIdSha256.slice(0, 12))}…</code></td><td>${x.dailyCap}</td><td>${x.monthlyCap}</td><td>${x.dailyCap === 0 || x.monthlyCap === 0 ? '<span class="muted">off</span> ' : ''}<form method="post" action="${url(b, 'social/revoke')}" style="display:inline">${csrfField(shell.csrf)}<input type="hidden" name="bindingId" value="${e(x.id)}"><button class="danger" type="submit">Revoke</button></form></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No account is registered for delivery. Queued posts hold until one is.</p>';
  const bind = o.profile ? `<h3>Register a connected account for delivery</h3><form method="post" action="${url(b, 'social/bind')}">${csrfField(shell.csrf)}
<div class="row"><div><label for="bn">Network</label><select id="bn" name="network">${networks.map(n => `<option value="${n}">${n}</option>`).join('')}</select></div><div><label for="ba">Account id (24 characters, from Zernio)</label><input id="ba" name="providerAccountId" type="text" required pattern="[a-f0-9]{24}"></div><div><label for="bd">Posts per day (0 = off)</label><input id="bd" name="dailyCap" type="number" min="0" max="24" value="0"></div><div><label for="bm">Posts per month (0 = off)</label><input id="bm" name="monthlyCap" type="number" min="0" max="300" value="0"></div></div>
<p class="muted">Only an account the provider has confirmed as connected under this brand’s profile can be registered. Caps are enforced again at send time; lowering a cap to 0 or revoking stops queued posts.</p><button type="submit">Register account</button></form>` : '';
  return layout(shell, 'Social', `<h1>Social delivery</h1>
<section class="card"><h2>This brand’s accounts</h2><p>Accompanying posts go out only through accounts this brand connected and registered here. Nothing is shared with any other brand or application.</p>${profile}${connect}${accounts}</section>
<section class="card"><h2>Registered for delivery</h2>${registered}${bind}</section>
<section class="card"><h2>How a post is sent</h2><ol><li>You approve the exact article and the exact accompanying post.</li><li>The article is verified public at its final URL.</li><li>You queue the post for a time; it is planned through the canonical calendar with this brand’s caps.</li><li>Shortly before the time it is re-verified from the live article; if anything changed, it is cancelled with a note.</li><li>Instagram additionally needs a real approved image; text-only LinkedIn posts are independent.</li></ol></section>`);
}
