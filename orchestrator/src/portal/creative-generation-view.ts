import { unlimited } from '../seo-blog/limits.js';
/** Typed-brief image generation pages: briefs, honest cost review, explicit request, progress and results. */
import { randomUUID } from 'node:crypto';
import { SEO_IMAGE_SIZES } from '../seo-blog/image-generation.js';
import type { Brand, Job } from '../seo-blog/types.js';
import type { SeoImageOperatorPolicy } from '../seo-blog/media-types.js';
import { SIZE_LABEL, type CreativeBrief } from '../creative-studio/generation.js';
import type { GenerationEstimate } from '../creative-studio/generation-service.js';
import type { BriefVersion, GenerationState } from '../creative-studio/generation-store.js';
import { base, STYLE } from './creative-studio-view.js';
import { csrfField, layout, SEO_BLOG_BASE, type Shell } from './seo-blog-view.js';
import type { EnquirySettings } from '../creative-studio/pg-store.js';
import { ENQUIRY_LIMITS, ENQUIRY_ROUTE, enquiryEmbedSnippet } from '../creative-studio/enquiry-capture.js';

const e = (value: unknown) => String(value ?? '').replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);
const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(micro % 10_000 ? 4 : 2)}`;
const STATE: Readonly<Record<string, [string, string]>> = { queued: ['warn', 'Waiting to start'], running: ['warn', 'Generating'], done: ['ok', 'Generated'], blocked: ['bad', 'Held'], failed: ['bad', 'Failed'], cancelled: ['', 'Cancelled'] };
const pill = (state: string) => `<span class="pill ${STATE[state]?.[0] ?? ''}">${e(STATE[state]?.[1] ?? state)}</span>`;
const GEN_STYLE = `<style>.gen-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}.gen-grid figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px}.gen-grid img{width:100%;height:auto;border-radius:6px;display:block}
.cost{border-left:4px solid var(--accent,#3557ff);background:var(--bg);border-radius:6px;padding:10px 14px}.cost dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:6px 0 0}.cost dt{color:var(--muted)}.cost dd{margin:0}@media (max-width:600px){.cost dl{grid-template-columns:1fr;gap:0}.cost dd{margin-bottom:6px}}
.blockers li{color:var(--bad)}.ref-grid{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(120px,1fr))}.ref-grid label{font-weight:400;border:1px solid var(--line);border-radius:8px;padding:6px}.ref-grid img{width:100%;display:block;border-radius:4px;margin-top:4px}</style>`;

export interface ReferenceChoice { readonly assetId: string; readonly sha256: string; readonly label: string; readonly previewUrl: string }

function settingsCard(shell: Shell, brand: Brand, state: GenerationState, policy: SeoImageOperatorPolicy | null, providerConfigured: boolean): string {
  const s = brand.settings.studioImages, enabled = s?.enabled === true, perMonth = s?.perMonth ?? 0;
  const open = Boolean(policy?.enabled && policy.maxConcurrency > 0 && (policy.monthlyUnlimited === true || policy.monthlyMicrousd > 0) && policy.perAttemptMicrousd > 0);
  return `<section class="card" id="generation-settings"><h2>Allowances</h2>
<ul class="small"><li><strong>Studio image generation:</strong> ${enabled ? `on, ${unlimited(brand.settings, 'studioImages') ? 'Unlimited' : `up to ${perMonth} per UTC month`}` : 'off'} (${state.usage.studioImagesCounted} counted this month${state.usage.studioUnresolved ? `, ${state.usage.studioUnresolved} awaiting reconciliation` : ''}).</li>
<li><strong>Brand image allowance</strong> (shared with blog images, set in <a href="${SEO_BLOG_BASE}/b/${e(brand.id)}/publishing#campaign-images">Publishing</a>): ${state.usage.brandImagesThisMonth} of ${unlimited(brand.settings, 'images') ? 'Unlimited' : brand.settings.budgets.imagesPerMonth} used this month.</li>
<li><strong>Platform image policy</strong> (operator-controlled): ${open ? 'open' : 'closed — no paid image can start'}. ${providerConfigured ? '' : 'The image provider is not configured on this server.'}</li></ul>
<form method="post" action="${base(shell)}/generate/settings" class="cs-form">${csrfField(shell.csrf)}<input type="hidden" name="rowVersion" value="${brand.rowVersion}">
<label><input type="checkbox" name="enabled" value="1"${enabled ? ' checked' : ''} style="width:auto"> Allow paid images from typed briefs for this brand</label>
<label for="gen-per-month">Studio images per UTC month (0 = none)</label>${unlimited(brand.settings, 'studioImages') ? `<input name="perMonth" type="hidden" value="${perMonth}"><output id="gen-per-month">Unlimited</output>` : `<input id="gen-per-month" name="perMonth" type="number" min="0" max="${brand.settings.operatorLimits?.studioImages ?? 1000}" value="${perMonth}">`}
<button class="secondary" type="submit">Save allowance</button>
<p class="small muted">A writing (model-token) allowance is not an image allowance. Each studio image also uses one of the brand image allowance above and is reserved against the platform’s monthly limit. Saving this never starts a request.</p></form></section>`;
}

function briefForm(shell: Shell, briefId: string | null, references: readonly ReferenceChoice[], brief: CreativeBrief | null): string {
  const chosen = new Set((brief?.references ?? []).map((r) => r.assetId));
  return `<form method="post" action="${base(shell)}/generate/brief" class="cs-form">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${randomUUID()}">${briefId ? `<input type="hidden" name="briefId" value="${e(briefId)}">` : ''}
<label for="brief-title">Short name</label><input id="brief-title" name="title" maxlength="80" value="${e(brief?.title ?? '')}" placeholder="e.g. Calm kitchen morning">
<label for="brief-text">What should the picture show?</label><textarea id="brief-text" name="text" required minlength="10" maxlength="1500" rows="5" placeholder="e.g. A bright modern kitchen in morning light, a mug on the counter, space on the left for a headline">${e(brief?.text ?? '')}</textarea>
<p class="small muted">Describe the picture only. Don’t include the headline, price, logo or offer: those are added exactly afterwards in the artwork, and the image is generated without any words in it.</p>
<label for="brief-size">Image size</label><select id="brief-size" name="size">${SEO_IMAGE_SIZES.map((s) => `<option value="${s}"${(brief?.size ?? '1536x1024') === s ? ' selected' : ''}>${e(SIZE_LABEL[s])}</option>`).join('')}</select>
<label><input type="checkbox" name="useVisualGuidance" value="1"${brief === null || brief.useVisualGuidance ? ' checked' : ''} style="width:auto"> Use this brand’s saved visual guidance (colours, mood)</label>
${references.length ? `<fieldset><legend>Reference images (optional, up to 3 of this brand’s saved images)</legend><div class="ref-grid">${references.map((r) => `<label><input type="checkbox" name="reference" value="${e(r.assetId)}:${e(r.sha256)}"${chosen.has(r.assetId) ? ' checked' : ''}> ${e(r.label)}<img src="${e(r.previewUrl)}" alt="Saved image: ${e(r.label)}" loading="lazy"></label>`).join('')}</div><p class="small muted">References guide subject or style and add input cost. Only this brand’s private, non-withdrawn images can be used.</p></fieldset>` : ''}
<button type="submit">${brief ? 'Save as a new version' : 'Save brief and review the cost'}</button> <span class="small muted">Saving costs nothing.</span></form>`;
}

export function generationPage(shell: Shell, data: { brand: Brand; state: GenerationState; policy: SeoImageOperatorPolicy | null; providerConfigured: boolean; references: readonly ReferenceChoice[] }): string {
  const latest = new Map<string, BriefVersion>();
  for (const b of data.state.briefs) if (!latest.has(b.id) || latest.get(b.id)!.version < b.version) latest.set(b.id, b);
  const rows = [...latest.values()].map((b) => {
    const jobs = data.state.jobs.filter((j) => j.briefId === b.id), gens = data.state.generations.filter((g) => g.briefId === b.id);
    return `<tr><td><a href="${base(shell)}/generate/${e(b.id)}">${e(b.data.title)}</a><br><span class="small muted">version ${b.version} · ${e(SIZE_LABEL[b.data.size])}</span></td><td>${jobs[0] ? pill(jobs[0].state) : '<span class="muted small">Not requested</span>'}</td><td>${gens.length}</td></tr>`;
  }).join('');
  return layout(shell, 'Generate an image', `${STYLE}${GEN_STYLE}<p><a href="${base(shell)}">← Creative studio</a></p><h1>Generate a new image</h1>
<p class="muted">Describe a picture, review the cost and allowances, then generate it. The new image is saved privately for you to turn into branded artwork; nothing is approved, published or spent beyond the one image you confirm.</p>
${settingsCard(shell, data.brand, data.state, data.policy, data.providerConfigured)}
<section class="card"><h2>New image brief</h2>${briefForm(shell, null, data.references, null)}</section>
<section class="card"><h2>Your briefs</h2>${rows ? `<table><thead><tr><th>Brief</th><th>Latest request</th><th>Images</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No briefs yet.</p>'}</section>`);
}

export function briefPage(shell: Shell, data: { brand: Brand; briefId: string; versions: readonly BriefVersion[]; state: GenerationState; estimate: GenerationEstimate; references: readonly ReferenceChoice[]; previewUrl: (generationId: string) => string }): string {
  const current = [...data.versions].sort((a, b) => b.version - a.version)[0]!, brief = current.data, est = data.estimate;
  const jobs = data.state.jobs.filter((j) => j.briefId === data.briefId && j.briefVersion === current.version);
  const active = jobs.find((j) => j.state === 'queued' || j.state === 'running');
  const attempted = data.state.attempts.find((a) => jobs.some((j) => j.id === a.jobId));
  const lastIntent = attempted?.intentId ?? null;
  const gens = data.state.generations.filter((g) => g.briefId === data.briefId);
  const cost = `<div class="cost"><strong>Before you generate</strong><dl>
<dt>Paid requests</dt><dd>${est.paidGenerations} image</dd><dt>Model</dt><dd>${e(est.model)} · quality ${e(est.quality)} (set by the platform policy)</dd>
<dt>Size</dt><dd>${e(SIZE_LABEL[est.size])}</dd><dt>Reference images</dt><dd>${est.references}</dd>
<dt>Reserved against the platform limit</dt><dd>${est.reservedMicrousd === null ? 'Not available (paid images are not enabled)' : `${usd(est.reservedMicrousd)} (a fixed reservation set by the operator; it is not the charge and does not cap it)`}</dd>
<dt>Exact cost</dt><dd>${e(est.exactCost)}</dd>
<dt>Brand image allowance</dt><dd>${est.brandAllowance.unlimited ? 'Unlimited' : `${est.brandAllowance.remaining} of ${est.brandAllowance.limit} left this month`}</dd>
<dt>Studio image allowance</dt><dd>${est.studioAllowance.enabled ? `${est.studioAllowance.unlimited ? 'Unlimited' : `${est.studioAllowance.remaining} of ${est.studioAllowance.limit} left this month`}` : 'off'}${est.studioAllowance.unresolved ? ` (${est.studioAllowance.unresolved} awaiting reconciliation still count)` : ''}</dd></dl>
${est.blockers.length ? `<ul class="blockers small">${est.blockers.map((b) => `<li>${e(b)}</li>`).join('')}</ul>` : ''}</div>`;
  const requestForm = active ? `<p role="status" data-creative-job="${e(active.id)}" data-endpoint="${base(shell)}/jobs/${e(active.id)}">${pill(active.state)} <span data-job-detail>${e(active.progress)}</span></p><p class="small muted">You can leave this page; the request continues on the server and survives restarts.</p><noscript><p class="small"><a href="">Refresh to check progress</a></p></noscript>`
    : `<form method="post" action="${base(shell)}/generate/${e(data.briefId)}/request">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${randomUUID()}"><input type="hidden" name="version" value="${current.version}">
${lastIntent ? `<input type="hidden" name="replacesIntentId" value="${e(lastIntent)}"><label><input type="checkbox" name="confirmedNewIntent" value="1" required style="width:auto"> I want another paid image for this same brief version. The earlier one stays on record.</label>` : `<label><input type="checkbox" name="confirm" value="1" required style="width:auto"> Use one paid image from this brand’s allowances.</label>`}
<button type="submit"${est.blockers.length ? ' disabled' : ''}>${lastIntent ? 'Generate another image (new paid request)' : 'Generate image (1 paid request)'}</button></form>`;
  const history = jobs.filter((j) => j !== active).map((j) => `<li>${pill(j.state)} ${e(new Date(j.createdAt).toISOString().slice(0, 16).replace('T', ' '))} UTC · ${e(j.error ?? j.progress)}${j.paidAttemptStarted ? '' : ' <span class="small muted">(no paid request started)</span>'}</li>`).join('');
  const results = gens.length ? `<div class="gen-grid">${gens.map((g) => `<figure><img src="${e(data.previewUrl(g.id))}" alt="Image generated from brief “${e(brief.title)}” version ${g.briefVersion}" width="${g.width}" height="${g.height}" loading="lazy"><figcaption class="small"><span class="pill">AI-generated · not approved</span> version ${g.briefVersion} · ${g.width}×${g.height} · ${e(g.createdAt.slice(0, 10))}${g.data.usage ? '' : ' · provider usage not reported'}<br><a class="button" href="${base(shell)}?bg=generated:${e(g.id)}#new-h">Create artwork from this image</a></figcaption></figure>`).join('')}</div>`
    : '<p class="muted">No image generated from this brief yet.</p>';
  return layout(shell, 'Image brief', `${STYLE}${GEN_STYLE}<p><a href="${base(shell)}/generate">← All briefs</a></p><h1>${e(brief.title)}</h1>
<p class="muted">Version ${current.version} · ${e(SIZE_LABEL[brief.size])} · ${brief.references.length} reference image(s) · visual guidance ${brief.useVisualGuidance ? 'on' : 'off'}</p>
<section class="card"><h2>Image brief</h2><blockquote>${e(brief.text)}</blockquote>${cost}${requestForm}${history ? `<details><summary>Earlier requests for this version</summary><ul class="small">${history}</ul></details>` : ''}</section>
<section class="card"><h2>Generated images</h2>${results}</section>
<section class="card"><h2>Edit the brief</h2><p class="small muted">Saving creates a new version. Earlier versions and their images are kept.</p>${briefForm(shell, data.briefId, data.references, brief)}</section>
<script src="${SEO_BLOG_BASE}/creative-job-status.js" defer></script>`);
}

/** Brand enquiry form: where campaign leads enter the existing CRM, which stage means "qualified", and the embed code. */
export function creativeEnquiriesPage(shell: Shell, data: { settings: EnquirySettings; brandId: string; origin: string | null; live: boolean }): string {
  const s = data.settings, open = s.stages.filter((x) => x.type === 'open');
  const select = (name: string, id: string, chosen: string | null, label: string, help: string) => s.stages.length
    ? `<label for="${id}">${label}</label><select id="${id}" name="${name}">${open.map((x) => `<option value="${e(x.id)}"${x.id === chosen ? ' selected' : ''}>${e(x.name)}</option>`).join('')}</select><p class="small muted">${help}</p>` : '';
  const hosted = s.publicKey && data.origin ? `${data.origin}${ENQUIRY_ROUTE}/${data.brandId}/${s.publicKey}` : null;
  const ready = s.enabled && data.live;
  // Pre-select a sensible "qualified" stage on first setup: the stage named Qualified…, else the next open stage.
  const defaultQualified = s.qualifiedStageId ?? (open.find((x) => /^qualif/iu.test(x.name)) ?? open[1] ?? open[0])?.id ?? null;
  return layout(shell, 'Enquiries', `${STYLE}${GEN_STYLE}<p><a href="${base(shell)}">← Creative studio</a></p><h1>Enquiry form</h1>
<p class="muted">Leads from your tracked campaign links arrive here: a short form that creates the contact and opportunity in this brand’s CRM pipeline, and keeps the campaign tags only when they match a tracked link this brand issued. Nothing is published, emailed or spent.</p>
<section class="card"><h2>Settings</h2>
<ul class="small"><li><strong>Status:</strong> ${s.enabled ? 'on' : 'off'}${data.live ? '' : ' (the public form is not available on this server)'}.</li>
<li><strong>Pipeline:</strong> ${s.pipelineName ? e(s.pipelineName) : 'none yet — saving creates the standard “Enquiries” pipeline (New enquiry, Contacted, Qualified, Won, Not proceeding)'}.</li>
<li><strong>Campaign-tagged leads so far:</strong> ${s.touches}.</li></ul>
<form method="post" action="${base(shell)}/enquiries" class="cs-form">${csrfField(shell.csrf)}<input type="hidden" name="rowVersion" value="${s.rowVersion}">
${select('newStageId', 'enq-new', s.newStageId, 'Stage for new enquiries', 'New leads start here.')}
${select('qualifiedStageId', 'enq-qual', defaultQualified, 'Stage that means “qualified”', 'Results count a lead as qualified when it reaches this stage (or a later open stage, or is won). Stored by stage id, so renaming the stage keeps the meaning.')}
<label for="enq-privacy">Privacy notice (https link)</label><input id="enq-privacy" name="privacyUrl" type="url" maxlength="500" value="${e(s.privacyUrl ?? '')}" placeholder="https://your-site.example/privacy">
<label><input type="checkbox" name="enabled" value="1"${s.enabled ? ' checked' : ''} style="width:auto"> Accept enquiries through this form</label>
<button type="submit">Save</button></form></section>
${ready ? hosted ? `<section class="card"><h2>Put the form where your links land</h2>
<p class="small">Embed it on the page your tracked links open (recommended — the tracked link stays on your own site). The form can only be embedded on this brand’s own website and its confirmed conversion pages:</p>
<textarea readonly rows="6" class="small" aria-label="Embed code">${e(enquiryEmbedSnippet(data.origin!, data.brandId, s.publicKey!))}</textarea>
<p class="small">Or use the hosted form: <a class="link-out" href="${e(hosted)}" rel="noopener" target="_blank">${e(hosted)}</a></p>
<p class="small muted">The embed passes only the campaign tags (utm_source, utm_medium, utm_campaign, utm_content) from the page address. Names, emails and messages are sent in the form, never in a link. Up to ${ENQUIRY_LIMITS.perHour} enquiries per hour are accepted.</p>
<form method="post" action="${base(shell)}/enquiries/rotate" class="cs-form">${csrfField(shell.csrf)}<input type="hidden" name="rowVersion" value="${s.rowVersion}"><button class="secondary" type="submit">Issue a new form address</button> <span class="small muted">Use this if the link or embed code has leaked. The old address stops working at once.</span></form></section>`
  : `<section class="card"><h2>Put the form where your links land</h2><p class="small">This portal has no public address configured, so the hosted link and embed code cannot be shown. Ask the release owner to set the portal base URL.</p></section>` : ''}`);
}

/** One durable render task: follows the job, explains a stop, and is replaced by the result page once it is done. */
export function renderTaskPage(shell: Shell, data: { job: Job; label: string; retryable?: boolean }): string {
  const { job } = data, live = job.state === 'queued' || job.state === 'running';
  const status = live
    ? `<p role="status" data-creative-job="${e(job.id)}" data-endpoint="${base(shell)}/jobs/${e(job.id)}">${pill(job.state)} <span data-job-detail>${e(job.progress)}</span></p>
<p class="small muted">The work runs on the server and survives restarts. You can leave this page and come back from the Creative studio or Tasks. Rendering is local: no provider is called and nothing is charged.</p><noscript><p><a href="">Refresh to check progress</a></p></noscript>`
    : `<p>${pill(job.state)} ${e(job.error ?? job.progress)}</p><p class="small muted">Nothing was published or approved.</p>${['blocked', 'failed'].includes(job.state) && data.retryable
      ? `<form method="post" action="${base(shell)}/task/${e(job.id)}/retry" class="cs-form">${csrfField(shell.csrf)}<button class="secondary" type="submit">Try again</button> <span class="small muted">Replays the same request after you have fixed what stopped it. Rendering is local; nothing is charged.</span></form>` : ''}`;
  return layout(shell, data.label, `${STYLE}${GEN_STYLE}<p><a href="${base(shell)}">← Creative studio</a></p><h1>${e(data.label)}</h1>
<section class="card">${status}</section>${live ? `<script src="${SEO_BLOG_BASE}/creative-job-status.js" defer></script>` : ''}`);
}

/** Polls a creative job status endpoint and reloads once the job stops running. Endpoint shape is checked before use. */
export const CREATIVE_JOB_STATUS_SCRIPT = `(()=>{'use strict';
const ENDPOINT=/^\\/portal\\/seo-blog\\/b\\/[0-9a-f-]{36}\\/creative\\/jobs\\/[0-9a-f-]{36}$/;
for(const el of document.querySelectorAll('[data-creative-job]')){
  const url=el.getAttribute('data-endpoint')||'';if(!ENDPOINT.test(url))continue;
  const detail=el.querySelector('[data-job-detail]');let rounds=0;
  const stop=(msg)=>{if(detail)detail.textContent=msg;};
  const tick=async()=>{rounds++;if(rounds>300){stop('Progress updates paused. Refresh this page to check.');return;}
    const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),10000);
    try{const r=await fetch(url,{credentials:'same-origin',headers:{accept:'application/json'},signal:ctl.signal});
      if(r.status===401||r.status===403||r.status===404){stop('Progress could not be read (you may need to sign in again). Refresh this page to check.');return;}
      if(r.ok){const j=await r.json();if(j&&typeof j.state==='string'){if(detail&&typeof j.detail==='string')detail.textContent=j.detail;
        if(!['queued','running'].includes(j.state)){location.replace(location.pathname);return;}}}}catch(e){}finally{clearTimeout(t);}
    setTimeout(tick,4000);};
  setTimeout(tick,3000);}
})();`;
