/**
 * "Start with your website": the Brand DNA front door.
 *
 * One page, one main button at a time. It is written for a phone and for an owner who is not
 * technical: no task, version or model words. Every fact on the card says where it was read;
 * a fact with no recorded source says so instead of implying one.
 */

import type { BrandDnaState } from '../seo-blog/engine.js';
import type { BrandDnaCard, DnaItem, DnaSource } from '../seo-blog/brand-dna.js';
import { brandDnaPayload } from '../seo-blog/brand-dna.js';
import { profilePayload } from '../seo-blog/profile-jobs.js';
import { escapeHtml as e } from './ui.js';
import { csrfField, layout, SEO_BLOG_BASE, type Shell } from './seo-blog-view.js';

const STYLE = `<style>
.dna{max-width:720px;margin:0 auto}.dna h1{margin-bottom:8px}.dna .lead{font-size:17px;margin:0 0 20px}
.dna .main{display:block;width:100%;padding:14px 18px;font-size:17px;font-weight:600;text-align:center;border-radius:10px}
.dna button[disabled]{opacity:.5;cursor:not-allowed}.dna .from{display:block;font-size:13px;color:var(--muted);margin-top:2px}
.dna .from q{font-style:italic}.dna ul.facts{list-style:none;padding:0;margin:0}.dna ul.facts li{padding:10px 0;border-bottom:1px solid var(--line)}
.dna ul.facts li:last-child{border-bottom:0}.dna .price{font-weight:700}.dna fieldset{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 14px}
.dna legend{font-weight:700;padding:0 6px}.dna .choice{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--line);font-weight:400;margin:0}
.dna .choice input[type=radio]{margin-top:5px;width:20px;height:20px;flex:0 0 auto}.dna .choice strong{display:block}
.dna .answers{display:grid;gap:0}@media(min-width:640px){.dna .answers.side{grid-template-columns:1fr 1fr;gap:0 18px}}
.dna .quiet{margin-top:18px}.dna .quiet button,.dna .quiet .button{width:100%;text-align:center}.dna .pill{vertical-align:middle}
</style>`;

/** What a worker from before Brand DNA says when it meets a website read. */
const OLDER_WORKER = 'This worker does not support that task stage.';
const link = (shell: Shell, tab: string) => `${SEO_BLOG_BASE}/b/${shell.brand!.id}/${tab}`;
const number = (value: number) => Number.isFinite(value) ? value.toLocaleString('en-GB') : 'no limit';

function sourceLine(source: DnaSource | null): string {
  if (!source) return '<span class="from">Where this came from was not recorded. Check it before you confirm.</span>';
  const label = source.url ? `<a href="${e(source.url)}" target="_blank" rel="noopener noreferrer">${e(source.label)}</a>` : e(source.label);
  return `<span class="from">${label}${source.quote ? `: <q>${e(source.quote)}</q>` : ''}</span>`;
}

function facts(items: readonly DnaItem[], empty: string): string {
  return items.length ? `<ul class="facts">${items.map((i) => `<li>${e(i.text)}${sourceLine(i.source)}</li>`).join('')}</ul>` : `<p class="muted">${e(empty)}</p>`;
}

function plainList(items: readonly string[]): string {
  return `<ul>${items.map((i) => `<li>${e(i)}</li>`).join('')}</ul>`;
}

/** The differing answers, side by side. The form sends positions only; the server reads the values from the stored card. */
function conflictForms(shell: Shell, card: BrandDnaCard, version: number, confirmed: boolean): string {
  if (!card.conflicts.length) return '';
  return `<section class="card" id="choose"><h2>We found different answers</h2>
<p>Your website pages and documents do not agree on ${card.conflicts.length === 1 ? 'this' : 'these'}. Pick the right answer${card.conflicts.length === 1 ? '' : ' each time'}. We have not chosen for you.</p>
${confirmed ? '<p class="notice">Saving an answer makes a new card. Your content pauses until you confirm the new card.</p>' : ''}
${card.conflicts.map((c) => `<form method="post" action="${link(shell, 'dna/settle')}">${csrfField(shell.csrf)}<input type="hidden" name="version" value="${version}"><input type="hidden" name="conflict" value="${c.index}">
<fieldset><legend>${e(c.title)}</legend><p class="muted">${e(c.detail)}</p><div class="answers${c.options.length > 1 ? ' side' : ''}">
${c.options.map((o) => `<label class="choice"><input type="radio" name="choice" value="${o.index}" required><span><strong>${e(o.value)}</strong>${sourceLine(o.source)}</span></label>`).join('')}
</div><label class="choice"><input type="radio" name="choice" value="typed" required><span><strong>Neither, I’ll type it</strong></span></label>
<label for="typed-${c.index}">The right answer</label><input id="typed-${c.index}" type="text" name="typed" maxlength="300" autocomplete="off">
<p style="margin:12px 0 0"><button class="secondary" type="submit">Save this answer</button></p></fieldset></form>`).join('')}</section>`;
}

function cardSections(card: BrandDnaCard): string {
  const offers = card.offers.length ? `<ul class="facts">${card.offers.map((o) => `<li><strong>${e(o.name)}</strong>${o.description ? `<br>${e(o.description)}` : ''}${sourceLine(o.source)}
<span class="price">${o.priceOpen ? 'Price: choose the right one above' : o.price ? `Price: ${e(o.price)}` : 'Price: none found in your pages or documents'}</span>${o.price && !o.priceOpen ? sourceLine(o.priceSource) : ''}</li>`).join('')}</ul>`
    : '<p class="muted">We did not find anything you sell written down. Nothing was added.</p>';
  return `<section class="card"><h2>In a sentence</h2><p>${e(card.summary)}</p>${card.positioning ? `<p>${e(card.positioning)}</p>` : ''}<p class="muted">Summed up from the pages and documents listed under “Where we looked”.</p></section>
<section class="card"><h2>What you sell</h2><p class="muted">${card.checked ? 'Prices are shown exactly as written. We never work one out.' : 'Check each price against your own price list before you confirm.'}</p>${offers}</section>
<section class="card"><h2>Who it is for</h2>${facts(card.audiences, 'We did not find who you sell to written down. Nothing was added.')}</section>
<section class="card"><h2>What you can say</h2>${facts(card.claims, 'We did not find any claims you make written down. Nothing was added.')}</section>
<section class="card"><h2>How you sound</h2>${card.voice.tone.length ? `<p>${e(card.voice.tone.join(', '))}</p>` : '<p class="muted">Not enough of your own words to tell yet.</p>'}
${card.voice.do.length ? `<p><strong>Do</strong></p>${plainList(card.voice.do)}` : ''}${card.voice.dont.length ? `<p><strong>Avoid</strong></p>${plainList(card.voice.dont)}` : ''}
<p class="muted">This is our reading of the words on your pages, not a fact about you. Change anything that is wrong.</p></section>
${card.never.length ? `<section class="card"><h2>Never say</h2>${plainList(card.never)}</section>` : ''}
${card.missing.length ? `<section class="card"><h2>What we could not find</h2><p class="muted">We left these out rather than guess. Add them to your website or your documents if they matter.</p>${plainList(card.missing)}</section>` : ''}
<section class="card"><h2>Where we looked</h2>${card.readFrom.length ? `<ul>${card.readFrom.map((r) => `<li>${r.url ? `<a href="${e(r.url)}" target="_blank" rel="noopener noreferrer">${e(r.label)}</a>` : e(r.label)}</li>`).join('')}</ul>` : '<p class="muted">The pages and documents this card was made from are no longer on record.</p>'}
${card.unsourced ? `<p class="notice">${card.unsourced} line${card.unsourced === 1 ? '' : 's'} on this card ${card.unsourced === 1 ? 'has' : 'have'} no recorded source. Check ${card.unsourced === 1 ? 'it' : 'them'} yourself before you rely on ${card.unsourced === 1 ? 'it' : 'them'}.</p>` : ''}</section>`;
}

function correctionForm(shell: Shell, state: BrandDnaState): string {
  const p = state.profile!;
  const area = (id: string, label: string, value: string, hint = '') => `<label for="dna-${id}">${label}</label><textarea id="dna-${id}" name="${id}">${e(value)}</textarea>${hint ? `<small class="muted">${hint}</small>` : ''}`;
  return `<details class="card"><summary><strong>Something not right? Change it</strong></summary>
<p class="muted">Use your own words. A line you add is marked “You told us”. To change a price, change it on your website or in your documents, then read your website again.</p>
${state.status === 'confirmed' ? '<p class="notice">Saving a change makes a new card. Your content pauses until you confirm the new card.</p>' : ''}
<form method="post" action="${link(shell, 'dna/edit')}">${csrfField(shell.csrf)}<input type="hidden" name="version" value="${p.version}">
${area('summary', 'In a sentence', p.summary)}${area('audiences', 'Who it is for', p.audiences.join('\n'), 'One per line.')}
${area('approvedClaims', 'What you can say', p.approvedClaims.join('\n'), 'One per line.')}${area('exclusions', 'Never say', p.exclusions.join('\n'), 'One per line.')}
${area('voiceDont', 'Words and styles to avoid', p.voice.dont.join('\n'), 'One per line.')}
<p><button class="secondary" type="submit">Save my changes</button></p></form></details>`;
}

function readForm(shell: Shell, state: BrandDnaState, options: { label: string; main: boolean; again: boolean; commandId: string }): string {
  return `<form method="post" action="${link(shell, 'dna/read')}">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${e(options.commandId)}">${options.again ? '<input type="hidden" name="again" value="1">' : ''}
<label for="dna-website">Your website address</label><input id="dna-website" type="text" name="website" inputmode="url" autocomplete="url" placeholder="www.example.co.uk" value="${e(state.brand.website ?? '')}" required>
${state.uncertainEarlierAttempt ? '<label class="choice"><input type="checkbox" name="acknowledgePriorUsage" value="1" required><span>An earlier attempt did not report back and may have used some of my monthly allowance. I understand and want to try again.</span></label>' : ''}
<p style="margin:14px 0 0"><button class="${options.main ? 'main' : 'secondary'}" type="submit">${options.label}</button></p></form>`;
}

/** What stopped the last attempt, in the owner's words. Null when nothing needs saying. */
function lastAttempt(state: BrandDnaState): { text: string; pasteInstead: boolean } | null {
  const read = state.job, made = state.cardJob;
  const newerThanCard = (at: string) => !state.profile || at > state.profile.createdAt;
  if (read && ['blocked', 'failed'].includes(read.state) && newerThanCard(read.updatedAt)) {
    const reason = brandDnaPayload(read).reason;
    if (reason === 'allowance') return null; // The allowance notice below already says what to do.
    // Seen only while the service is part-way through an update: the reader that picked this up was the older one.
    if (read.error === OLDER_WORKER) return { text: 'We are updating the part of the service that reads websites. This will be ready in a few minutes. Nothing was changed. Press “Read my website” again then.', pasteInstead: false };
    return { text: read.state === 'failed' ? 'We could not finish reading your website. Nothing was changed. Please try again.' : read.error ?? 'Reading your website stopped. Nothing was changed.', pasteInstead: reason === 'no_words' };
  }
  if (made && ['blocked', 'failed'].includes(made.state) && newerThanCard(made.updatedAt)) {
    const reason = profilePayload(made).reason;
    if (reason === 'rejected') return { text: made.error ?? 'We stopped before making your card rather than guess. Nothing was saved.', pasteInstead: false };
    if (reason === 'budget') return null;
    if (reason === 'outcome_unknown') return { text: 'The last attempt to make your card did not report back. It may have used some of your monthly allowance. Nothing was saved.', pasteInstead: false };
    return { text: 'Making your card stopped before it finished. Nothing was saved or changed. Please read your website again.', pasteInstead: false };
  }
  return null;
}

export function brandDnaPage(shell: Shell, state: BrandDnaState, commandId: string): string {
  const paste = `<a href="${link(shell, 'setup')}#brand-guidance">Paste your details instead</a>`;
  const body = (title: string, inner: string, head = '') => layout(shell, title, `${STYLE}<div class="dna">${inner}</div>`, head);

  if (state.working) {
    const reading = state.job && ['queued', 'running'].includes(state.job.state);
    return body('Brand DNA', `<h1>${reading ? 'Reading your website' : 'Making your Brand DNA card'}</h1>
<p class="lead">${reading ? 'We are reading the pages that describe your business.' : 'Your pages are read. We are putting your card together.'} This usually takes a minute or two.</p>
<section class="card" role="status"><p>You can leave this page. It carries on without you, and nothing is published.</p><p><a class="button main" href="${link(shell, 'dna')}">Check again</a></p></section>`,
    '<meta http-equiv="refresh" content="8">');
  }

  const stopped = lastAttempt(state);
  const stoppedNotice = stopped ? `<p class="notice bad" role="alert">${e(stopped.text)}</p>` : '';
  const { allowance } = state;
  const allowanceNotice = `<section class="card"><h2>Set a monthly allowance first</h2>
<p>Reading your website uses a little of your monthly writing allowance, usually a few pence. Your allowance is ${number(allowance.ceiling)} a month and ${number(allowance.used)} ${allowance.used === 1 ? 'has' : 'have'} been used this month.</p>
<p class="muted">Nothing has been read and nothing has been spent.</p><p><a class="button main" href="${link(shell, 'publishing')}#writing-budget">Set my monthly allowance</a></p></section>`;
  const cannotStart = !state.writerReady
    ? '<p class="notice bad" role="alert">The writing service is not switched on for this account yet, so a card cannot be made. Ask whoever looks after your account to switch it on.</p>'
    : !allowance.enough ? allowanceNotice : '';

  if (!state.card || !state.profile) {
    const pasteFirst = stopped?.pasteInstead === true;
    return body('Start with your website', `<h1>Start with your website</h1>
<p class="lead">Paste your website address. We read your pages and any documents you have added, then show you a Brand DNA card: what you sell and what it costs, who it is for and how you sound.</p>
<p class="muted">Every line on the card says where we found it. Nothing is made up, and nothing is used until you confirm it.</p>
${stoppedNotice}${cannotStart || (pasteFirst
    ? `<section class="card"><p><a class="button main" href="${link(shell, 'setup')}#brand-guidance">Paste your details instead</a></p><p class="muted">Paste what you sell, what it costs and who it is for. Then come back here and press “Read my website”.</p></section>
<details class="card"><summary>Try my website again</summary>${readForm(shell, state, { label: 'Read my website', main: false, again: false, commandId })}</details>`
    : `<section class="card">${readForm(shell, state, { label: 'Read my website', main: true, again: false, commandId })}
<p class="muted" style="margin-top:12px">This uses a little of your monthly writing allowance, usually a few pence. Pressing twice does not charge you twice.</p></section>`)}
${pasteFirst ? '' : `<p class="muted">Website does not show its words, or no website yet? ${paste}.</p>`}
${state.documents ? `<p class="muted">You have already added ${state.documents} document${state.documents === 1 ? '' : 's'}. ${state.documents === 1 ? 'It is' : 'They are'} read alongside your website, and any disagreement is shown to you.</p>` : ''}`);
  }

  const card = state.card, version = state.profile.version;
  const confirmed = state.status === 'confirmed', outOfDate = state.status === 'out_of_date';
  const open = card.conflicts.length;
  const pill = outOfDate ? '<span class="pill bad">Out of date</span>' : confirmed ? '<span class="pill ok">Confirmed</span>' : '<span class="pill warn">Needs your confirmation</span>';
  const documentsOnly = state.job?.state === 'done' && brandDnaPayload(state.job).result?.websiteReadable === false
    ? `<p class="notice">We could not read enough words from your website, so this card uses your documents only. ${paste} if anything is missing.</p>` : '';
  const look = shell.creativeAvailable && (state.look?.themeColour || state.look?.logoCandidates.length)
    ? `<section class="card"><h2>Logo and colours</h2><p>We found ${state.look.logoCandidates.length ? 'a logo' : 'a colour'}${state.look.logoCandidates.length && state.look.themeColour ? ' and a colour' : ''} on your website. Nothing is used until you say so.</p><p><a class="button secondary" href="${link(shell, 'creative/kit')}?website=1">Check your logo and colours</a></p></section>` : '';

  let action: string;
  if (outOfDate) {
    action = `<section class="card"><h2>This card is out of date</h2><p>Your website pages or documents changed after this card was made. Your content is paused until you confirm a new card.</p>
${cannotStart || readForm(shell, state, { label: 'Read my website again', main: true, again: true, commandId })}</section>`;
  } else if (confirmed) {
    action = `<p><a class="button main" href="${link(shell, 'topics')}">Plan my content</a></p>
<details class="card quiet"><summary>Has your website changed?</summary><p><strong>Your content pauses until you confirm the new card.</strong> Reading your website again makes a new card from today’s pages and documents. The card above carries on being used until the new one is ready. If a new card cannot be made, nothing changes.</p>
${cannotStart || readForm(shell, state, { label: 'Read my website again', main: false, again: true, commandId })}</details>`;
  } else {
    action = `<form method="post" action="${link(shell, 'dna/confirm')}">${csrfField(shell.csrf)}<input type="hidden" name="version" value="${version}">
<button class="main" type="submit"${open ? ' disabled aria-describedby="dna-why"' : ''}>Confirm my Brand DNA</button>
<p class="muted" id="dna-why">${open ? `Choose an answer for ${open === 1 ? 'the question' : `each of the ${open} questions`} above first.` : 'Only a confirmed card is used to write your content. You can change it later.'}</p></form>
<details class="card quiet"><summary>Read my website again</summary><p class="muted">Makes a fresh card from today’s pages and documents. This card is replaced.</p>
${cannotStart || readForm(shell, state, { label: 'Read my website again', main: false, again: false, commandId })}</details>`;
  }

  return body('Your Brand DNA', `<h1>Your Brand DNA ${pill}</h1>
<p class="lead">${outOfDate ? 'This is the old card.' : confirmed ? 'This is what your content is written from.' : card.checked ? 'Check each line. Every one says where we found it.' : 'Check each line before you confirm it.'}</p>
${stoppedNotice}${documentsOnly}${outOfDate ? action : ''}${conflictForms(shell, card, version, confirmed)}${cardSections(card)}
${outOfDate ? '' : correctionForm(shell, state)}${look}${outOfDate ? '' : action}`);
}
