/** Server-rendered Creative Studio pages inside the existing multi-brand SEO area. No client script required. */
import type { CreativeBrandContext } from '../creative-studio/brand-context.js';
import { PLACEMENTS, PLACEMENT_IDS, type PlacementId } from '../creative-studio/placements.js';
import type { SavedGeneratedImage, ApprovalState, setView } from '../creative-studio/service.js';
import type { CreativeSetSummary, CreativeSetRecord } from '../creative-studio/store.js';
import { CREATIVE_PURPOSES, PURPOSE_LABELS, type BrandKit, type CreativeVersion } from '../creative-studio/types.js';
import { csrfField, layout, SEO_BLOG_BASE, type Shell } from './seo-blog-view.js';

const e = (value: unknown) => String(value ?? '').replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);
const base = (shell: Shell) => `${SEO_BLOG_BASE}/b/${shell.brand!.id}/creative`;
export const artUrl = (shell: Shell, v: Pick<CreativeVersion, 'id' | 'render'>, download = false) => `${base(shell)}/art/${v.id}/${v.render.sha256}.jpg${download ? '?download=1' : ''}`;

const STYLE = `<style>
.cs-hero{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;align-items:flex-end;margin:0 0 16px}.cs-hero h1{margin:0}.cs-hero p{margin:4px 0 0}
.cs-steps{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 0;padding:0;list-style:none}.cs-steps li{font-size:12px;padding:3px 9px;border-radius:99px;border:1px solid var(--line);background:var(--card)}
.swatches{display:flex;gap:8px;flex-wrap:wrap}.swatch{display:flex;align-items:center;gap:6px;font-size:13px}.swatch i{display:inline-block;width:22px;height:22px;border-radius:6px;border:1px solid var(--line)}
.cs-form fieldset{border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:0 0 12px}.cs-form legend{font-weight:600;padding:0 6px}
.choice{display:flex;flex-wrap:wrap;gap:8px}.choice label{display:flex;gap:6px;align-items:center;font-weight:400;margin:0;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg)}
.estimate{border-left:4px solid var(--accent);padding:8px 12px;background:var(--bg);border-radius:6px}
.cmp{display:grid;gap:14px;grid-template-columns:repeat(var(--cols),minmax(220px,1fr));align-items:start}
.cmp-row{margin:0 0 18px}.cmp-row>h3{margin:0 0 8px;font-size:15px}
figure.art{margin:0;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px}figure.art img{display:block;width:100%;height:auto;border-radius:6px;background:#111}
figure.art figcaption{font-size:13px;margin-top:8px;display:grid;gap:6px}.art-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.art-actions form{margin:0}
.issues{margin:0;padding-left:18px;font-size:12px}.issues li.block{color:var(--bad)}.small{font-size:12px}
.concept-head{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.concept-head h3{margin:0 0 4px}.concept-head dl{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:8px 0 0;font-size:13px}.concept-head dt{color:var(--muted)}
.kit-logo{max-height:56px;max-width:220px;background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/14px 14px;padding:6px;border-radius:6px}
.saved-grid{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}.saved-grid label{display:block;font-weight:400;border:1px solid var(--line);border-radius:8px;padding:6px;margin:0}.saved-grid img{width:100%;border-radius:4px;display:block;margin-top:4px}
@media(max-width:700px){.cmp{grid-template-columns:1fr}}
</style>`;

const statePill = (s: ApprovalState) => s === 'approved' ? '<span class="pill ok">Approved image</span>' : s === 'stale' ? '<span class="pill bad">Approval no longer current</span>' : '<span class="pill warn">Needs review</span>';

function gapsList(context: CreativeBrandContext): string {
  const essential = !context.confirmed ? `<li><span class="pill bad">Needed</span> Confirm the brand profile in <a href="${SEO_BLOG_BASE}/b/${e(context.brandId)}/setup">Brand setup</a>. Unconfirmed facts are never used in artwork.</li>` : '';
  return `<ul>${essential}${context.decorativeGaps.map((g) => `<li><span class="pill warn">Fallback</span> ${e(g.detail)} <span class="muted">${e(g.action)}</span></li>`).join('')}${!essential && !context.decorativeGaps.length ? '<li><span class="pill ok">Ready</span> Brand facts, colours and logo are confirmed.</li>' : ''}</ul>`;
}

function kitSummary(shell: Shell, context: CreativeBrandContext, kit: BrandKit | null): string {
  const p = context.palette;
  return `<section class="card" aria-labelledby="kit-h"><div class="cs-hero"><div><h2 id="kit-h" style="margin:0">Brand rules for artwork</h2><p class="muted">From ${e(context.brandName)}'s confirmed profile${context.profileVersion ? ` (version ${context.profileVersion})` : ''} and creative kit${kit ? ` (version ${kit.version})` : ''}.</p></div><a class="button secondary" href="${base(shell)}/kit">Edit creative kit</a></div>
<div class="grid"><div><strong>Colours</strong> <span class="pill ${context.paletteSource === 'brand_kit' ? 'ok' : 'warn'}">${context.paletteSource === 'brand_kit' ? 'Brand kit' : 'Neutral fallback'}</span><div class="swatches" style="margin-top:6px">${(['primary', 'accent', 'dark', 'light'] as const).map((k) => `<span class="swatch"><i style="background:${e(p[k])}"></i>${k} ${e(p[k])}</span>`).join('')}</div></div>
<div><strong>Logo</strong><div style="margin-top:6px">${context.logo ? `<img class="kit-logo" style="background:${e(context.palette.dark)}" alt="Approved logo for ${e(context.brandName)}" src="${base(shell)}/kit-logo/${e(kit!.version)}/${e(context.logo.sha256)}">` : '<span class="muted">No approved logo — the brand name is set in plain text.</span>'}</div></div>
<div><strong>Required disclosure</strong><p class="small">${context.disclosure ? e(context.disclosure) : '<span class="muted">None set.</span>'}</p><strong>Restricted wording</strong><p class="small">${context.restricted.length ? context.restricted.map(e).join(' · ') : '<span class="muted">None set.</span>'}</p></div></div>
<h3 style="margin-bottom:0">Readiness</h3>${gapsList(context)}</section>`;
}

export function creativeOverviewPage(shell: Shell, data: {
  readonly context: CreativeBrandContext; readonly kit: BrandKit | null; readonly sets: readonly CreativeSetSummary[];
  readonly articles: readonly { id: string; title: string; currentVersionId: string | null }[];
  readonly savedImages: readonly (SavedGeneratedImage & { previewUrl: string | null })[]; readonly rendererReady: boolean; readonly commandId: string;
}): string {
  const c = data.context;
  const radios = (name: string, options: [string, string][], checked: string) => options.map(([v, l]) => `<label><input type="radio" name="${name}" value="${e(v)}"${v === checked ? ' checked' : ''}> ${e(l)}</label>`).join('');
  const form = `<section class="card" aria-labelledby="new-h"><h2 id="new-h">Create images</h2>${!data.rendererReady ? '<p class="notice bad">The artwork renderer is not installed on this server, so no artwork can be produced yet.</p>' : ''}
<form class="cs-form" method="post" action="${base(shell)}/draft" enctype="multipart/form-data">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${e(data.commandId)}">
<fieldset><legend>1 · What is it for?</legend><div class="choice">${radios('purpose', CREATIVE_PURPOSES.map((p) => [p, PURPOSE_LABELS[p]]), 'advert')}</div></fieldset>
<fieldset><legend>2 · What is it about?</legend><div class="choice">${radios('source_kind', [['offer', 'An approved offer'], ['article', 'An article'], ['brief', 'A short brief']], c.offers.length ? 'offer' : 'brief')}</div>
<div class="row"><div><label for="cs-offer">Offer</label><select id="cs-offer" name="offer">${c.offers.length ? c.offers.map((o) => `<option value="${e(o.name)}">${e(o.name)}${o.price ? ` — ${e(o.price)}` : ''}</option>`).join('') : '<option value="">No offers in the confirmed profile</option>'}</select></div>
<div><label for="cs-article">Article</label><select id="cs-article" name="article">${data.articles.filter((a) => a.currentVersionId).map((a) => `<option value="${e(a.id)}">${e(a.title)}</option>`).join('') || '<option value="">No articles yet</option>'}</select></div></div>
<label for="cs-brief">Brief <span class="muted">(used when “A short brief” is chosen; figures you type are flagged for confirmation)</span></label><textarea id="cs-brief" name="brief" maxlength="1200" style="min-height:70px" placeholder="What should the artwork say, in your own words?"></textarea></fieldset>
<fieldset><legend>3 · Who and where?</legend><div class="row"><div><label for="cs-aud">Audience</label><select id="cs-aud" name="audience"><option value="">General audience</option>${c.audiences.map((a) => `<option value="${e(a)}">${e(a)}</option>`).join('')}<option value="__custom">Other…</option></select><input type="text" name="audience_custom" maxlength="80" placeholder="Other audience (optional)" aria-label="Other audience"></div>
<div><label for="cs-dest">Destination</label><select id="cs-dest" name="destination"><option value="">No link (organic post)</option>${c.destinations.map((d) => `<option value="${e(d.url)}">${e(d.label)} — ${e(d.url)}</option>`).join('')}</select></div></div>
<p class="small muted">Only approved conversion pages from the confirmed profile can be used. Adverts and product promotions need one.</p>
<label>Formats</label><div class="choice">${PLACEMENT_IDS.map((id) => `<label><input type="checkbox" name="placements" value="${id}"${['square', 'portrait', 'vertical'].includes(id) ? ' checked' : ''}> ${e(PLACEMENTS[id].label)} <span class="muted small">${PLACEMENTS[id].width}×${PLACEMENTS[id].height}</span></label>`).join('')}</div>
<div class="row"><div><label for="cs-n">Distinct concepts</label><select id="cs-n" name="concepts"><option>1</option><option>2</option><option selected>3</option></select></div><div><label for="cs-cards">Carousel cards (carousel only)</label><select id="cs-cards" name="cards">${[2, 3, 4, 5].map((n) => `<option${n === 4 ? ' selected' : ''}>${n}</option>`).join('')}</select></div></div></fieldset>
<fieldset><legend>4 · Background image</legend><div class="choice">${radios('background', [['neutral', 'Brand-colour background'], ['upload', 'Upload an approved image'], ['saved', 'A saved generated image']], 'neutral')}</div>
<label for="cs-file">Image to upload (JPEG or PNG, up to 8 MB)</label><input id="cs-file" type="file" name="file" accept="image/jpeg,image/png">
${data.savedImages.length ? `<p class="small muted">Images already generated and receipted by the article image pipeline. Reusing one makes no new provider call.</p><div class="saved-grid">${data.savedImages.map((s, i) => `<label><input type="radio" name="saved" value="${e(s.assetId)}:${e(s.sha256)}"${i === 0 ? ' checked' : ''}> ${e(s.articleTitle)}${s.previewUrl ? `<img alt="Saved generated illustration for ${e(s.articleTitle)}" src="${e(s.previewUrl)}" loading="lazy">` : ''}</label>`).join('')}</div>` : '<p class="small muted">No generated images are saved for this brand yet. Article images are generated, with their own allowance, from an article\'s Campaign page.</p>'}</fieldset>
<p class="estimate small"><strong>Estimated usage:</strong> one local render per concept × format (× card). Rendering is done on this server: <strong>no provider call and no image-generation charge</strong>. New paid image generation is not started from here.</p>
<button type="submit"${data.rendererReady && c.confirmed ? '' : ' disabled'}>Create images</button> <span class="small muted">Creates private drafts only. Nothing is published, scheduled or spent.</span></form></section>`;
  const library = `<section class="card" aria-labelledby="lib-h"><h2 id="lib-h">Creative library</h2>${data.sets.length ? `<table><thead><tr><th>Created</th><th>Purpose</th><th>Source</th><th>Formats</th><th>Versions</th><th>Approved</th></tr></thead><tbody>${data.sets.map((s) => {
    const r = s.set.request; const src = r.source.kind === 'offer' ? `Offer: ${r.source.name}` : r.source.kind === 'article' ? `Article: ${r.source.title}` : `Brief: ${r.source.text.slice(0, 60)}`;
    return `<tr><td><a href="${base(shell)}/s/${e(s.set.id)}">${e(s.set.createdAt.slice(0, 16).replace('T', ' '))}</a></td><td>${e(PURPOSE_LABELS[r.purpose])}</td><td>${e(src)}</td><td>${r.placements.map((p) => e(PLACEMENTS[p].label)).join(', ')}</td><td>${s.versionCount}</td><td>${s.approvedCount}</td></tr>`;
  }).join('')}</tbody></table>` : '<p class="muted">No artwork yet.</p>'}</section>`;
  return layout(shell, 'Creative studio', `${STYLE}<div class="cs-hero"><div><h1>Creative studio</h1><p class="muted">Brand-aware images and ad creative for ${e(c.brandName)}. Drafts only — nothing is published, scheduled or spent.</p><ol class="cs-steps"><li>Create images</li><li>Compare</li><li>Edit</li><li>Approve</li><li>Download / add to campaign</li></ol></div></div>${kitSummary(shell, c, data.kit)}${form}${library}`);
}

export function creativeKitPage(shell: Shell, data: { readonly context: CreativeBrandContext; readonly kit: BrandKit | null; readonly commandId: string }): string {
  const p = data.kit?.palette ?? data.context.palette;
  const field = (k: keyof typeof p, label: string) => `<div><label for="kit-${k}">${label}</label><input id="kit-${k}" type="text" name="${k}" value="${e(p[k])}" pattern="#?[0-9a-fA-F]{6}" required><input type="color" value="${e(p[k])}" aria-label="${label} preview" disabled></div>`;
  return layout(shell, 'Creative kit', `${STYLE}<h1>Creative kit</h1><p class="muted">Owner-confirmed decorative and compliance rules applied deterministically to every artwork. Saving a new kit version makes earlier image approvals for this brand no longer current.</p>
${data.context.suggestedColours.length ? `<p class="notice small">Colours mentioned in your visual guidance (not applied until you confirm them): ${data.context.suggestedColours.map((c) => `<span class="swatch" style="display:inline-flex"><i style="background:${e(c)}"></i>${e(c)}</span>`).join(' ')}</p>` : ''}
<form class="card cs-form" method="post" action="${base(shell)}/kit" enctype="multipart/form-data">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${e(data.commandId)}"><input type="hidden" name="expectedVersion" value="${data.kit?.version ?? 0}">
<fieldset><legend>Colours</legend><div class="row">${field('primary', 'Primary')}${field('accent', 'Accent (buttons)')}${field('dark', 'Dark (text panels)')}${field('light', 'Light (text)')}</div><p class="small muted">Text contrast is measured on every rendered image; a failing combination is flagged and blocks approval.</p></fieldset>
<fieldset><legend>Logo</legend>${data.kit?.logo ? `<p><img class="kit-logo" style="background:${e(data.kit.palette.dark)}" alt="Current approved logo" src="${base(shell)}/kit-logo/${data.kit.version}/${e(data.kit.logo.sha256)}"></p><div class="choice"><label><input type="radio" name="logo_action" value="keep" checked> Keep</label><label><input type="radio" name="logo_action" value="upload"> Replace</label><label><input type="radio" name="logo_action" value="remove"> Remove</label></div>` : '<input type="hidden" name="logo_action" value="upload">'}
<label for="kit-logo">Approved logo file (PNG with transparency, or JPEG)</label><input id="kit-logo" type="file" name="file" accept="image/png,image/jpeg"><label for="kit-logo-label">Logo description</label><input id="kit-logo-label" type="text" name="logo_label" maxlength="80" value="${e(data.kit?.logo?.label ?? '')}">
<p class="small muted">The exact file is placed on artwork unchanged. Logos are never redrawn by an image model. SVG is not accepted.</p></fieldset>
<fieldset><legend>Compliance</legend><label for="kit-disc">Required disclosure (shown on every artwork)</label><input id="kit-disc" type="text" name="disclosure" maxlength="220" value="${e(data.kit?.disclosure ?? '')}">
<label for="kit-restricted">Restricted wording (one phrase per line; added to the profile's exclusions)</label><textarea id="kit-restricted" name="restricted" style="min-height:80px">${e((data.kit?.restrictedPhrases ?? []).join('\n'))}</textarea></fieldset>
<button type="submit">Save kit version ${(data.kit?.version ?? 0) + 1}</button> <a href="${base(shell)}">Cancel</a></form>`);
}

type SetViewData = ReturnType<typeof setView>;
export function creativeSetPage(shell: Shell, data: {
  readonly context: CreativeBrandContext; readonly record: CreativeSetRecord; readonly view: SetViewData;
  readonly articles: readonly { id: string; title: string }[]; readonly savedImages: readonly SavedGeneratedImage[];
  readonly newCommand: () => string; readonly rendererReady: boolean;
}): string {
  const r = data.record.set.request; const concepts = data.view.concepts;
  const src = r.source.kind === 'offer' ? `Offer: ${r.source.name}` : r.source.kind === 'article' ? `Article: ${r.source.title}` : `Brief: ${r.source.text}`;
  const head = (c: SetViewData['concepts'][number]) => {
    const heads = c.variants.map((v) => v.version.id);
    const stale = c.variants.some((v) => v.staleContext);
    const card = c.concept.cards.length ? `<dt>Cards</dt><dd>${c.concept.cards.map((x, i) => `${i + 1}. ${e(x.headline)}`).join('<br>')}</dd>` : '';
    return `<div class="concept-head"><h3>Concept ${e(c.key.slice(1))} · ${e(c.concept.angle)}</h3><dl><dt>Hook</dt><dd>${e(c.concept.hook) || '—'}</dd><dt>Headline</dt><dd><strong>${e(c.concept.headline)}</strong></dd><dt>Body</dt><dd>${e(c.concept.body) || '—'}</dd><dt>CTA</dt><dd>${e(c.concept.cta) || '—'}</dd>${card}<dt>Background</dt><dd>${c.concept.background.kind === 'image' ? `${e(c.concept.background.label)}${c.concept.background.origin === 'generated_article_image' ? ' <span class="pill">AI-generated illustration</span>' : ''}` : 'Brand-colour background'}</dd></dl>
${stale ? `<form method="post" action="${base(shell)}/s/${e(data.record.set.id)}/refresh/${e(c.key)}">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${e(data.newCommand())}"><input type="hidden" name="heads" value="${e(heads.join(','))}"><p class="notice bad small">Brand facts or the creative kit changed since these images were made.</p><button type="submit">Refresh from current brand</button></form>` : ''}
<details><summary>Edit concept</summary><form class="cs-form" method="post" action="${base(shell)}/s/${e(data.record.set.id)}/concept/${e(c.key)}" enctype="multipart/form-data">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${e(data.newCommand())}"><input type="hidden" name="heads" value="${e(heads.join(','))}">
<label>Hook<input type="text" name="hook" maxlength="48" value="${e(c.concept.hook)}"></label><label>Headline<input type="text" name="headline" maxlength="90" required value="${e(c.concept.headline)}"></label><label>Body<textarea name="body" maxlength="180" style="min-height:60px">${e(c.concept.body)}</textarea></label><label>Call to action<input type="text" name="cta" maxlength="28" value="${e(c.concept.cta)}"></label>
${c.concept.cards.map((x, i) => `<label>Card ${i + 1} headline<input type="text" name="card_headline" maxlength="110" required value="${e(x.headline)}"></label><label>Card ${i + 1} body<input type="text" name="card_body" maxlength="140" value="${e(x.body)}"></label>`).join('')}
${c.concept.background.kind === 'image' ? `<label style="font-weight:400"><input type="checkbox" name="illustrative" value="1"${c.concept.illustrativeTag ? ' checked' : ''}> Show “Illustrative image” marker</label>` : ''}
<label>Background</label><div class="choice"><label><input type="radio" name="background" value="keep" checked> Keep</label><label><input type="radio" name="background" value="neutral"> Brand colours</label><label><input type="radio" name="background" value="upload"> Upload</label>${data.savedImages.length ? '<label><input type="radio" name="background" value="saved"> Saved generated image</label>' : ''}</div>
<input type="file" name="file" accept="image/jpeg,image/png" aria-label="Background image">${data.savedImages.length ? `<select name="saved" aria-label="Saved generated image">${data.savedImages.map((s) => `<option value="${e(s.assetId)}:${e(s.sha256)}">${e(s.articleTitle)}</option>`).join('')}</select>` : ''}
<p class="small muted">Only this concept's images get new versions; other concepts and their approvals are untouched. Edited images need review again.</p><button type="submit">Save and re-render</button></form></details></div>`;
  };
  const figure = (v: SetViewData['concepts'][number]['variants'][number] | undefined) => {
    if (!v) return '<div></div>';
    const x = v.version; const pl = PLACEMENTS[x.placement];
    const figures = x.issues.some((i) => i.code === 'unsupported_figure');
    const blocking = x.issues.some((i) => i.blocking);
    const focal = x.concept.background.kind === 'image' ? `<details class="small"><summary>Move focal point (this format only)</summary><form method="post" action="${base(shell)}/v/${e(x.id)}/focal">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${e(data.newCommand())}"><div class="row"><label>Across<select name="x">${[0, 0.25, 0.5, 0.75, 1].map((n) => `<option value="${n}"${n === x.variant.focal.x ? ' selected' : ''}>${n === 0 ? 'Left' : n === 1 ? 'Right' : n === 0.5 ? 'Centre' : n}</option>`).join('')}</select></label><label>Down<select name="y">${[0, 0.25, 0.5, 0.75, 1].map((n) => `<option value="${n}"${n === x.variant.focal.y ? ' selected' : ''}>${n === 0 ? 'Top' : n === 1 ? 'Bottom' : n === 0.5 ? 'Middle' : n}</option>`).join('')}</select></label></div><button class="secondary" type="submit">Re-render</button></form></details>` : '';
    const approve = v.state === 'approved' ? '' : `<form method="post" action="${base(shell)}/v/${e(x.id)}/approve">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${e(data.newCommand())}"><input type="hidden" name="sha" value="${e(x.render.sha256)}">${figures ? '<label class="small" style="font-weight:400"><input type="checkbox" name="figures_confirmed" value="1" required> I confirm the flagged figures are accurate</label>' : ''}<button type="submit"${blocking || v.staleContext ? ' disabled' : ''}>Approve this image</button></form>`;
    const handoff = v.state === 'approved' && data.articles.length ? `<form method="post" action="${base(shell)}/v/${e(x.id)}/handoff">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${e(data.newCommand())}"><select name="article" aria-label="Campaign">${data.articles.map((a) => `<option value="${e(a.id)}">${e(a.title)}</option>`).join('')}</select><button class="secondary" type="submit">Add to campaign</button></form>` : '';
    const contrast = Object.entries(x.render.contrast).map(([k, n]) => `${k} ${n}:1`).join(' · ');
    return `<figure class="art" id="v-${e(x.id)}"><a href="${artUrl(shell, x)}"><img src="${artUrl(shell, x)}" width="${x.render.width}" height="${x.render.height}" loading="lazy" alt="${e(`${pl.label} artwork: ${x.card ? x.concept.cards[x.card - 1]?.headline : x.concept.headline}`)}"></a>
<figcaption><div>${statePill(v.state)} <span class="muted small">${pl.width}×${pl.height} · version ${x.number}${x.card ? ` · card ${x.card}/${x.concept.cards.length}` : ''}</span></div>
${x.issues.length ? `<ul class="issues">${x.issues.map((i) => `<li class="${i.blocking ? 'block' : ''}">${e(i.detail)}</li>`).join('')}</ul>` : '<span class="small muted">No layout, contrast or wording issues found.</span>'}
<span class="small muted">Measured contrast: ${e(contrast)}</span>
<div class="art-actions">${approve}<a class="button secondary" href="${artUrl(shell, x, true)}">Download</a>${handoff}</div>${v.handoffs.length ? `<span class="small">Added to campaign as a draft input (${v.handoffs.length}).</span>` : ''}${focal}
${v.history.length > 1 ? `<details class="small"><summary>${v.history.length - 1} earlier version${v.history.length === 2 ? '' : 's'}</summary><ul>${v.history.slice(1).map((h) => `<li><a href="${artUrl(shell, h)}">Version ${h.number}</a> · ${e(h.change)}${data.record.approvals.some((a) => a.versionId === h.id) ? ' · approved then superseded' : ''}</li>`).join('')}</ul></details>` : ''}</figcaption></figure>`;
  };
  const rows: { label: string; placement: PlacementId; card: number }[] = [];
  for (const p of r.placements) for (const card of r.cardCount ? Array.from({ length: Math.max(...concepts.map((c) => c.concept.cards.length)) }, (_, i) => i + 1) : [0]) rows.push({ label: `${PLACEMENTS[p].label}${card ? ` · card ${card}` : ''}`, placement: p, card });
  const cols = Math.max(1, concepts.length);
  return layout(shell, 'Compare artwork', `${STYLE}<p><a href="${base(shell)}">← Creative studio</a></p><div class="cs-hero"><div><h1>Compare artwork</h1><p class="muted">${e(PURPOSE_LABELS[r.purpose])} · ${e(src)}${r.audience ? ` · for ${e(r.audience)}` : ''}${r.destination ? ` · links to ${e(r.destination.label)}` : ''}</p></div></div>
<p class="notice small">Approving covers one exact image only. It does not approve a caption, campaign, schedule or paid advert, and nothing is published or spent. Starter copy was drafted from ${e(data.context.brandName)}'s approved facts only — edit it freely.</p>${!data.rendererReady ? '<p class="notice bad">The artwork renderer is not installed on this server; edits cannot be rendered.</p>' : ''}
<div class="cmp" style="--cols:${cols};margin-bottom:18px">${concepts.map(head).join('')}</div>
${rows.map((row) => `<section class="cmp-row"><h3>${e(row.label)} <span class="muted small">${PLACEMENTS[row.placement].use}</span></h3><div class="cmp" style="--cols:${cols}">${concepts.map((c) => figure(c.variants.find((v) => v.version.placement === row.placement && v.version.card === row.card))).join('')}</div></section>`).join('')}`);
}
