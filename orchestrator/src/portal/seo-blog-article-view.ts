/**
 * The article page and the articles list of the SEO blog area.
 *
 * The article page opens as the article itself, rendered by the same Markdown and citation renderer the
 * website publisher uses (render.ts), in one calm column. One action bar carries the article's state in
 * plain words and exactly one main button. Everything technical stays reachable, folded away at the bottom.
 * Editing happens in place: the same column, the same type, borderless fields.
 *
 * Every form posts to an existing article route (or a thin composition of existing steps); nothing here
 * decides a gate. Native forms and links only; no script.
 */

import { randomUUID } from 'node:crypto';
import { sha256 } from '../seo-blog/engine.js';
import { citationNumbers, renderMarkdown } from '../seo-blog/render.js';
import { withoutCitations } from '../seo-blog/citation-edit.js';
import { linkedPromotionFor, promotionPublicationHold } from '../seo-blog/promotions.js';
import { bindingHold, type SocialOverview } from '../seo-blog/social.js';
import { approvalIsCurrent, approvalRequired } from '../seo-blog/policy.js';
import { utcToLocal } from '../seo-blog/schedule.js';
import { isArticleWriteJob } from '../seo-blog/image-campaign.js';
import type { Article, ArticleBody, ArticleBrief, ArticleVersion, Brand, CheckIssue, Destination, Job, Publication, SocialDispatch } from '../seo-blog/types.js';
import { csrfField, layout, savedCampaignCopyStatus, SEO_BLOG_BASE, type Shell } from './seo-blog-view.js';
import { escapeHtml as e } from './ui.js';

type PublicDestination = Omit<Destination, 'sealedCredential'>;
export type ArticlePageMode = 'read' | 'edit';
export const ARTICLE_FOLDS = ['google', 'where', 'sources', 'history', 'download', 'rewrite', 'improve'] as const;
export type ArticleFold = typeof ARTICLE_FOLDS[number];

const brandUrl = (b: Brand, path: string) => `${SEO_BLOG_BASE}/b/${b.id}/${path}`;
const NETWORK: Record<string, string> = { linkedin: 'LinkedIn', instagram: 'Instagram' };

// ─── Dates in plain words ─────────────────────────────────────────────────────

const clock = (time: string) => time.replace(/^0(\d)/, '$1');
function dateParts(localDate: string): Date { return new Date(`${localDate}T12:00:00Z`); }
/** "Tue 18 Nov, 9:00" (the year only when it is not this year). */
export function shortWhen(localDate: string, localTime?: string | null, today = new Date().toISOString().slice(0, 10)): string {
  const d = dateParts(localDate);
  const year = localDate.slice(0, 4) !== today.slice(0, 4) ? ` ${localDate.slice(0, 4)}` : '';
  const day = `${d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })} ${d.getUTCDate()} ${d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}${year}`;
  return localTime ? `${day}, ${clock(localTime)}` : day;
}
/** "Tuesday 18 November at 9:00". */
export function longWhen(localDate: string, localTime: string, today = new Date().toISOString().slice(0, 10)): string {
  const d = dateParts(localDate);
  const year = localDate.slice(0, 4) !== today.slice(0, 4) ? ` ${localDate.slice(0, 4)}` : '';
  return `${d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })} ${d.getUTCDate()} ${d.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })}${year} at ${clock(localTime)}`;
}
function instant(iso: string, timezone: string): { date: string; time: string } {
  try { return utcToLocal(iso, timezone); } catch { return { date: iso.slice(0, 10), time: iso.slice(11, 16) }; }
}

// ─── Check messages in plain English ──────────────────────────────────────────

/** Where an issue lives, as an owner would say it. */
function placeName(location: string | null): string {
  if (!location) return '';
  if (location === 'Introduction') return ' in the opening paragraph';
  if (location === 'Conclusion') return ' in the closing paragraph';
  const faq = /^FAQ (\d+)$/.exec(location); if (faq) return ` in question ${faq[1]}`;
  const section = /^Section “(.*)”$/.exec(location); if (section) return ` in “${section[1]}”`;
  return '';
}
const quoted = (message: string) => /“([^”]+)”/.exec(message)?.[1] ?? '';
const count = (message: string) => /(\d+) characters/.exec(message)?.[1] ?? '';

/** Every check message that can reach this page, rewritten. Unknown codes keep their own sentence. */
export function plainCheck(issue: Pick<CheckIssue, 'code' | 'message' | 'location'>): string {
  const where = placeName(issue.location);
  const q = quoted(issue.message);
  const n = count(issue.message);
  const table: Record<string, string> = {
    'structure.title_missing': 'The article needs a title.',
    'structure.intro_missing': 'The opening paragraph is empty.',
    'structure.too_few_sections': 'The article needs at least two parts.',
    'structure.section_incomplete': `The part${where.replace(/^ in/, '')} is too short to publish.`,
    'structure.heading_missing': 'One part of the article has no heading.',
    'structure.heading_repeated': 'Two parts of the article have the same heading.',
    'structure.conclusion_missing': 'The closing paragraph is empty.',
    'meta.slug_invalid': 'The web address for this article can only use lower-case words joined by hyphens.',
    'meta.seo_title_missing': 'The title Google shows is empty.',
    'meta.seo_title_long': `The title Google shows is ${n} characters long, so Google may cut it short.`,
    'meta.description_missing': 'The short description Google shows is empty.',
    'meta.description_length': `The short description Google shows is ${n} characters. Between 70 and 160 reads best.`,
    'image.alt_missing': 'The picture needs a short description for people who cannot see it.',
    'image.none': 'There is no picture yet.',
    'meta.author_missing': 'No author name is set, so your business name will be shown as the author.',
    'profile.unconfirmed': 'Your business details have not been confirmed yet.',
    'profile.unresolved_fact': `The article mentions “${q}”, but your business documents disagree about it.`,
    'markup.unsafe': `Some text${where} contains web code that cannot be published.`,
    'links.invalid': `The link “${q}”${where} is not a full web address.`,
    'links.broken_internal': `A link${where} points to a page that is not on your website yet.`,
    'links.unverified_external': `A link${where} goes to another website that was not part of the research.`,
    'facts.unknown_source': `A fact${where} points to a source we no longer have.`,
    'facts.figure_not_in_source': `The number “${q}”${where} does not match the source it points to.`,
    'facts.unsupported_figure': `The number “${q}”${where} has no source behind it.`,
    'facts.regulatory_needs_evidence': `A statement about law, tax or rules${where} needs an official source.`,
    'claims.misleading_promise': `The text${where} promises a result (“${q}”).`,
    'claims.unverified_proof': `The text${where} mentions reviews, clients or case studies you have not confirmed.`,
    'facts.quote_fabricated': `A quotation${where} cannot be found in any source.`,
    'originality.copied_source': 'A passage is too close to the wording of one of the sources.',
    'duplication.slug': 'Another article already uses this web address.',
    'duplication.substantial': `This article is almost the same as “${q}”.`,
    'duplication.overlap': `This article covers similar ground to “${q}”.`,
    'voice.cliche': `“${q}” sounds like generic marketing language.`,
    'voice.brand_rule': `Your brand guidance says to avoid “${q}”.`,
  };
  return table[issue.code] ?? issue.message;
}

/** Where the button for an issue takes the owner. */
function fixTarget(b: Brand, base: string, issue: CheckIssue, version: ArticleVersion): { href: string; label: string } {
  const code = issue.code;
  if (code.startsWith('profile.')) return { href: brandUrl(b, 'dna'), label: 'Check your business details' };
  if (code === 'meta.author_missing') return { href: `${brandUrl(b, 'publishing')}#author`, label: 'Add an author' };
  if (code === 'structure.too_few_sections' || code === 'duplication.substantial' || code === 'originality.copied_source') return { href: `${base}?open=rewrite#rewrite`, label: 'Ask for a rewrite' };
  if (code.startsWith('meta.') || code === 'duplication.slug' || code === 'image.alt_missing') return { href: `${base}?edit=1#google`, label: 'Fix it' };
  if (code === 'image.none') return { href: '#picture', label: 'Add a picture' };
  const section = /^Section “(.*)”$/.exec(issue.location ?? '')?.[1];
  const target = section !== undefined ? version.body.sections.find((s) => s.heading === section) : null;
  const anchor = target ? `part-${target.id}` : issue.location === 'Introduction' ? 'opening' : issue.location === 'Conclusion' ? 'closing' : /^FAQ (\d+)$/.test(issue.location ?? '') ? `question-${/^FAQ (\d+)$/.exec(issue.location!)![1]}` : 'opening';
  return { href: `${base}?edit=1#${anchor}`, label: 'Fix it' };
}

// ─── Plain reasons for holds and stalled writing ─────────────────────────────

export function plainHold(reason: string): string {
  return ({
    owner: 'You asked for this not to go out yet.', missing_approval: 'Its time passed while it was waiting for your approval.',
    checks_failed: 'It needs checking again before it can go out.', paused: 'Publishing was paused when it was due.',
    destination: 'Your website connection needs checking.', budget: 'Your monthly allowance ran out.',
    outcome_unknown: 'We could not confirm the last attempt reached your website.', stale_version: 'The article changed just before it was due.',
    missed_window: 'Its time passed before it could go out.',
  } as Record<string, string>)[reason] ?? 'It is on hold.';
}

export interface WritingStatus {
  readonly sentence: string;
  /** A blocked or failed write task the existing Retry can safely queue again (it refuses unsafe repeats itself). */
  readonly retryJobId: string | null;
  readonly retryCosts: boolean;
  readonly link: { readonly href: string; readonly label: string } | null;
}

/** Why an article with no written version is where it is, from its write task. Nothing is invented. */
export function writingStatus(b: Brand, article: Pick<Article, 'briefId' | 'editorialState' | 'failure' | 'campaignGeneration'> | null, briefId: string, jobs: readonly Job[]): WritingStatus {
  const job = [...jobs].filter((j) => isArticleWriteJob(j) && j.payload.briefId === briefId && !j.payload.fromVersionId).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))[0];
  const none = { retryJobId: null, retryCosts: false, link: null };
  if (article?.campaignGeneration?.startedAt && !article.campaignGeneration.receipt) {
    return { ...none, sentence: 'Paused: the last writing step did not confirm its result, so it will not repeat by itself.', link: { href: brandUrl(b, 'activity'), label: 'See what happened' } };
  }
  if (!job && !article) return { ...none, sentence: 'Waiting to start' };
  if (!job) return article?.editorialState === 'failed' ? { ...none, sentence: `Writing stopped${article.failure ? `: ${plainWritingError(article.failure).reason}` : '.'}` } : { ...none, sentence: 'Being written' };
  if (job.state === 'running') return { ...none, sentence: 'Being written now' };
  if (job.state === 'queued') {
    const later = Date.parse(job.runAfter) > Date.now() + 60_000;
    return { ...none, sentence: job.attempts > 0 ? `Will try again${later ? ` at ${clock(instant(job.runAfter, b.timezone).time)}` : ' shortly'}` : 'Waiting to start' };
  }
  if (job.state === 'cancelled') return { ...none, sentence: 'Writing was cancelled.' };
  if (job.state === 'done') return { ...none, sentence: article?.editorialState === 'failed' ? `Writing stopped${article.failure ? `: ${plainWritingError(article.failure).reason}` : '.'}` : 'Being written' };
  const plain = plainWritingError(job.error ?? job.progress);
  return { sentence: `Paused: ${plain.reason}`, retryJobId: plain.retry ? job.id : null, retryCosts: plain.retry, link: plain.link ? { href: brandUrl(b, plain.link.path), label: plain.link.label } : null };
}

function plainWritingError(message: string): { reason: string; retry: boolean; link: { path: string; label: string } | null } {
  if (/allowance/i.test(message)) return { reason: 'waiting for more writing allowance this month.', retry: false, link: { path: 'publishing#writing-budget', label: 'Check the allowance' } };
  if (/brand profile|business details|Confirm the current/i.test(message)) return { reason: 'waiting for you to confirm your business details.', retry: false, link: { path: 'dna', label: 'Confirm your details' } };
  if (/paused by the owner|paused/i.test(message)) return { reason: 'writing is paused for your business.', retry: false, link: { path: 'publishing', label: 'Open publishing settings' } };
  if (/not configured|Connect a model/i.test(message)) return { reason: 'the writing service is not connected.', retry: false, link: null };
  if (/uncertain outcome|awaiting a durable receipt|Another worker started/i.test(message)) return { reason: 'the last writing step did not confirm its result, so it will not repeat by itself.', retry: false, link: { path: 'activity', label: 'See what happened' } };
  if (/programme authority|Review a new plan|changed profile or editorial guidance/i.test(message)) return { reason: 'its plan is out of date. Plan this topic again.', retry: false, link: { path: 'topics', label: 'Open Topics' } };
  return { reason: 'something stopped it before it finished.', retry: true, link: null };
}

// ─── Shared bits ─────────────────────────────────────────────────────────────

function hidden(fields: Record<string, string | number>): string {
  return Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`).join('');
}
function postButton(shell: Shell, action: string, fields: Record<string, string | number>, label: string, opts: { primary?: boolean; cls?: string; disabled?: boolean } = {}): string {
  return `<form method="post" action="${action}" class="ap-inline">${csrfField(shell.csrf)}${hidden(fields)}<button type="submit" class="${opts.primary ? 'ap-primary' : `secondary ${opts.cls ?? ''}`.trim()}"${opts.primary ? ' data-primary' : ''}${opts.disabled ? ' disabled' : ''}>${e(label)}</button></form>`;
}
function primaryLink(href: string, label: string, external = false): string {
  return `<a class="button ap-primary" data-primary href="${e(href)}"${external ? ' target="_blank" rel="noopener"' : ''}>${e(label)}</a>`;
}
function hostOf(url: string): string { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } }

/** The picture shown to the owner: a privately reviewed hero is served from the private route until it is released. */
function pictureSrc(b: Brand, article: Article, image: ArticleBody['image']): string | null {
  if (!image.url) return null;
  const hero = article.heroMedia;
  if (hero && image.url === hero.reservation.prospectiveUrl) return `${SEO_BLOG_BASE}/b/${b.id}/media/${hero.reservation.assetId}/${hero.reservation.assetSha256}.jpg`;
  return image.url;
}

// ─── The state of the article and its one main action ───────────────────────

interface BarAction { readonly html: string }
interface ScreenState {
  readonly kind: string;
  readonly sentence: string;
  readonly detail?: string;
  readonly primary: BarAction | null;
  readonly secondary: readonly BarAction[];
}

function laterPanel(shell: Shell, base: string, label: string, v: ArticleVersion, a: Article, connected: readonly PublicDestination[], route: 'approve-publish' | 'schedule', primary: boolean): string {
  const b = shell.brand!;
  const s = a.schedule;
  const today = instant(new Date().toISOString(), b.timezone).date;
  const site = connected.length > 1
    ? `<label for="later-site">Website</label><select id="later-site" name="destinationId">${connected.map((d) => `<option value="${e(d.id)}"${d.id === s?.destinationId ? ' selected' : ''}>${e(d.label)}</option>`).join('')}</select>`
    : connected[0] ? hidden({ destinationId: connected[0].id }) : '';
  const fields = route === 'schedule' ? hidden({ rowVersion: a.rowVersion }) : hidden({ versionId: v.id, when: 'at' });
  return `<details class="ap-later"><summary class="${primary ? 'button ap-primary' : 'ap-textbutton'}"${primary ? ' data-primary' : ''}>${e(label)}</summary><div class="ap-panel"><form method="post" action="${base}/${route}">${csrfField(shell.csrf)}${fields}
<div class="ap-when"><div><label for="later-date">Day</label><input id="later-date" type="date" name="localDate" min="${today}" value="${e(s?.localDate ?? '')}" required></div><div><label for="later-time">Time</label><input id="later-time" type="time" name="localTime" value="${e(s?.localTime ?? b.settings.cadence.localTime)}" required></div></div>${site}
<p class="ap-note">${route === 'approve-publish' ? 'This approves the article as it is now. ' : ''}Times are ${b.timezone === 'Europe/London' ? 'UK time' : e(b.timezone)}.</p><button type="submit" class="secondary">${route === 'schedule' ? 'Save the new time' : 'Approve and publish then'}</button></form></div></details>`;
}

function screenState(shell: Shell, d: ArticlePageData, v: ArticleVersion, critical: readonly CheckIssue[]): ScreenState {
  const b = shell.brand!;
  const a = d.article;
  const base = brandUrl(b, `articles/${a.id}`);
  const connected = d.destinations.filter((x) => x.status === 'connected');
  const approvePublish = (label: string) => ({ html: postButton(shell, `${base}/approve-publish`, { versionId: v.id, when: 'next' }, label, { primary: true }) });
  const later = (label = 'Publish later') => ({ html: laterPanel(shell, base, label, v, a, connected, 'approve-publish', false) });
  const liveNote = a.publishedUrl && a.publishedVersionId !== v.id ? ' An earlier version is live on your website; this one would replace it.' : '';
  if (a.delivery === 'published' && a.publishedVersionId === v.id) {
    const since = a.publishedAt ? ` since ${shortWhen(instant(a.publishedAt, b.timezone).date, null, (d.now ?? new Date().toISOString()).slice(0, 10))}` : '';
    return { kind: 'published', sentence: `Live on your website${since}.`, primary: a.publishedUrl ? { html: primaryLink(a.publishedUrl, 'View it', true) } : null, secondary: [] };
  }
  if (a.delivery === 'publishing') return { kind: 'publishing', sentence: 'Going onto your website now.', primary: null, secondary: [] };
  if (a.delivery === 'unknown') return { kind: 'unknown', sentence: 'We are checking whether it reached your website. You do not need to do anything.', primary: null, secondary: [] };
  if (a.hold?.reason === 'owner') return { kind: 'owner_hold', sentence: 'You asked for this not to go out yet.', primary: { html: postButton(shell, `${base}/hold`, { rowVersion: a.rowVersion, held: '0' }, 'Allow it to go out', { primary: true }) }, secondary: [] };
  if (critical.length) return { kind: 'must_fix', sentence: `${critical.length === 1 ? '1 thing' : `${critical.length} things`} to fix before this can go out.`, primary: { html: primaryLink('#fix', 'Show me') }, secondary: [] };
  if (!connected.length) return { kind: 'no_website', sentence: 'Ready for you to read. Your website is not connected yet, so it cannot go out.', primary: { html: primaryLink(`${brandUrl(b, 'setup')}#websites`, 'Connect your website') }, secondary: [] };
  if (a.delivery === 'failed') {
    return { kind: 'failed', sentence: 'It did not reach your website last time.', detail: a.failure ?? undefined, primary: { html: postButton(shell, `${base}/approve-publish`, { versionId: v.id, when: 'now' }, 'Try again now', { primary: true }) }, secondary: [later('Choose a time')] };
  }
  if (a.hold) {
    const why = plainHold(a.hold.reason);
    if (a.hold.reason === 'paused' && b.settings.pauseAll) return { kind: 'held', sentence: `${why} Publishing is still paused for your business.`, primary: { html: primaryLink(brandUrl(b, 'publishing'), 'Open publishing settings') }, secondary: [] };
    if (a.hold.reason === 'destination') return { kind: 'held', sentence: why, primary: { html: primaryLink(`${brandUrl(b, 'setup')}#websites`, 'Check the connection') }, secondary: [later('Choose a new time')] };
    if (a.hold.reason === 'budget') return { kind: 'held', sentence: why, primary: { html: primaryLink(brandUrl(b, 'publishing'), 'Check the allowance') }, secondary: [] };
    if (a.hold.reason === 'checks_failed') return { kind: 'held', sentence: why, primary: { html: postButton(shell, `${base}/checks`, {}, 'Check it again', { primary: true }) }, secondary: [] };
    return { kind: 'held', sentence: `${why} Choose when it should go out now.`, primary: approvePublish('Approve and publish'), secondary: [later('Choose a time')] };
  }
  const needsApproval = approvalRequired(b.settings.autoPublish, a.requiresApproval);
  const approved = approvalIsCurrent(a, v);
  const nowIso = d.now ?? new Date().toISOString();
  const today = nowIso.slice(0, 10);
  const future = a.schedule && Date.parse(a.schedule.publishAtUtc) > Date.parse(nowIso) ? a.schedule : null;
  if (future && (approved || !needsApproval)) {
    const paused = b.settings.pauseAll ? ' Publishing is paused for your business, so it will wait until you switch it back on.' : '';
    return { kind: 'scheduled', sentence: `Going out on ${longWhen(future.localDate, future.localTime, today)}.${paused}`, primary: { html: laterPanel(shell, base, 'Change the time', v, a, connected, 'schedule', true) },
      secondary: [{ html: postButton(shell, `${base}/approve-publish`, { versionId: v.id, when: 'now' }, 'Publish now', { cls: 'ap-textbutton' }) }] };
  }
  if (needsApproval && !approved) {
    const planned = future ? ` It is planned for ${shortWhen(future.localDate, future.localTime, today)}.` : '';
    return { kind: 'ready', sentence: `Ready for you to read.${planned}${liveNote}`, primary: approvePublish('Approve and publish'), secondary: [later()] };
  }
  return { kind: 'approved', sentence: `${approved ? 'Approved' : 'Ready'}, but not on the calendar yet.${liveNote}`, primary: approvePublish('Publish'), secondary: [later()] };
}

// ─── The article page ────────────────────────────────────────────────────────

export interface ArticlePageData {
  readonly article: Article;
  readonly version: ArticleVersion | null;
  readonly versions: readonly ArticleVersion[];
  readonly publications: readonly Publication[];
  readonly status: string;
  readonly destinations: readonly PublicDestination[];
  readonly social?: SocialOverview | null;
  readonly jobs?: readonly Job[];
  readonly mode?: ArticlePageMode;
  readonly open?: readonly string[];
  /** The planned working title, shown while the article has no written version. */
  readonly workingTitle?: string | null;
  /** The current instant (tests and screenshots pin it). */
  readonly now?: string;
}

/** The reading column: the article as it will be published (same renderer, same order, same citations). */
function readingColumn(b: Brand, a: Article, body: ArticleBody): string {
  const cites = citationNumbers(body);
  const canonical = a.publishedUrl ?? 'https://example.invalid/';
  const md = (text: string, sub = false) => renderMarkdown(text, cites.number, canonical, sub);
  return [
    `<h1 class="ap-title">${e(body.title)}</h1>`,
    `<div id="opening">${md(body.intro)}</div>`,
    ...body.sections.map((s) => `<section class="ap-part" id="part-${e(s.id)}"><h2>${e(s.heading)}</h2>\n${md(s.body, true)}</section>`),
    body.faqs.length ? `<section class="ap-part" id="questions"><h2>Frequently asked questions</h2>\n${body.faqs.map((f, i) => `<div id="question-${i + 1}"><h3>${e(f.q)}</h3>\n${md(f.a)}</div>`).join('\n')}</section>` : '',
    `<div id="closing">${md(body.conclusion)}</div>`,
    body.cta ? `<p><a class="ap-cta" href="${e(body.cta.url)}" rel="noopener">${e(body.cta.label)}</a></p>` : '',
    cites.list.length ? `<section class="ap-sources" aria-label="Sources"><h2>Sources</h2><ol>${cites.list.map((c, i) => `<li id="source-${i + 1}"><a href="${e(c.url)}" rel="noopener">${e(c.title)}</a> (accessed ${e(c.retrievedAt.slice(0, 10))})</li>`).join('')}</ol></section>` : '',
  ].filter(Boolean).join('\n');
}

const rowsFor = (text: string, perLine = 68) => Math.max(1, text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / perLine)), 0));

/** The same column, editable in place. Bodies stay Markdown; citation markers are hidden and put back on save. */
function editingColumn(body: ArticleBody): string {
  const area = (name: string, id: string, value: string, cls: string, label: string, extra = '') =>
    `<label class="ap-sr" for="${id}">${e(label)}</label><textarea id="${id}" name="${name}" class="ap-edit ${cls}" rows="${rowsFor(value, cls === 'ap-edit-h1' ? 34 : cls === 'ap-edit-h2' ? 48 : 68)}"${extra}>\n${e(value)}</textarea>`;
  return [
    area('title', 'edit-title', body.title, 'ap-edit-h1', 'Title', ' maxlength="200" required'),
    `<div id="opening">${area('intro', 'edit-intro', withoutCitations(body.intro), 'ap-edit-p', 'Opening paragraph')}</div>`,
    ...body.sections.map((s, i) => `<section class="ap-part" id="part-${e(s.id)}"><input type="hidden" name="sectionId" value="${e(s.id)}">${area('sectionHeading', `edit-h-${i}`, s.heading, 'ap-edit-h2', `Heading of part ${i + 1}`, ' maxlength="140"')}${area('sectionBody', `edit-b-${i}`, withoutCitations(s.body), 'ap-edit-p', `Text of part ${i + 1}`)}</section>`),
    `<input type="hidden" name="faqEditor" value="1">`,
    body.faqs.length ? `<section class="ap-part" id="questions"><h2>Frequently asked questions</h2>${body.faqs.map((f, i) => `<div id="question-${i + 1}">${area('faqQuestion', `edit-q-${i}`, f.q, 'ap-edit-h3', `Question ${i + 1}`, ' maxlength="200" required')}${area('faqAnswer', `edit-a-${i}`, withoutCitations(f.a), 'ap-edit-p', `Answer ${i + 1}`, ' maxlength="1500" required')}</div>`).join('')}</section>` : '',
    `<div id="closing">${area('conclusion', 'edit-conclusion', withoutCitations(body.conclusion), 'ap-edit-p', 'Closing paragraph')}</div>`,
  ].join('\n');
}

function pictureArea(shell: Shell, a: Article, v: ArticleVersion, base: string): string {
  const b = shell.brand!;
  const src = pictureSrc(b, a, v.body.image);
  const perMonth = b.settings.budgets.imagesPerMonth;
  const choices = `<div class="ap-panel ap-choices">
<details class="ap-choice"><summary class="ap-textbutton">Upload a photo</summary><form method="post" enctype="multipart/form-data" action="${base}/image-upload">${csrfField(shell.csrf)}${hidden({ versionId: v.id, commandId: randomUUID() })}<label for="pic-file">A JPG photo, up to 8 MB</label><input id="pic-file" type="file" name="file" accept="image/jpeg,.jpg,.jpeg" required><button type="submit" class="secondary">Upload this photo</button><p class="ap-note">Free. Next you check how it is cropped and describe it.</p></form></details>
<details class="ap-choice"><summary class="ap-textbutton">Use a picture from your website</summary><form method="post" action="${base}/picture">${csrfField(shell.csrf)}${hidden({ versionId: v.id })}<label for="pic-url">The picture’s web address</label><input id="pic-url" type="url" name="imageUrl" placeholder="https://…" required><label for="pic-alt">Describe what it shows</label><input id="pic-alt" type="text" name="imageAlt" minlength="5" maxlength="200" required><button type="submit" class="secondary">Use this picture</button><p class="ap-note">Free. Saving makes a new version; you’ll approve it again.</p></form></details>
<p class="ap-choice"><a class="ap-textbutton" href="${base}/campaign">Choose one you have already prepared</a></p>
${perMonth > 0
    ? `<details class="ap-choice"><summary class="ap-textbutton">Make one for me</summary><form method="post" action="${base}/image-request">${csrfField(shell.csrf)}${hidden({ versionId: v.id, commandId: randomUUID() })}<p class="ap-note">This asks our picture service to make one illustration for this article. It uses 1 of your ${perMonth} pictures this month. You check it before it is used.</p><button type="submit" class="secondary">Make a picture</button></form></details>`
    : `<p class="ap-choice ap-note">Making pictures is switched off for your business. You can switch it on in <a href="${brandUrl(b, 'publishing')}">Publishing</a>.</p>`}
</div>`;
  if (src) return `<figure class="ap-pic" id="picture"><img src="${e(src)}" alt="${e(v.body.image.alt)}"><figcaption><details class="ap-change"><summary class="ap-textbutton">Change picture</summary>${choices}</details></figcaption></figure>`;
  return `<div class="ap-pic ap-pic-empty" id="picture"><p>No picture yet</p><details class="ap-change"><summary class="button secondary">Add a picture</summary>${choices}</details></div>`;
}

function improvements(shell: Shell, base: string, v: ArticleVersion, warnings: readonly CheckIssue[], open: boolean): string {
  const b = shell.brand!;
  const list = warnings.filter((w) => w.code !== 'image.none');
  const label = list.length ? `${list.length} optional improvement${list.length === 1 ? '' : 's'}` : 'No problems found';
  return `<details class="ap-quiet" id="improve"${open ? ' open' : ''}><summary>${label}</summary><div class="ap-panel">${list.length ? `<ul class="ap-list">${list.map((w) => { const t = fixTarget(b, base, w, v); return `<li>${e(plainCheck(w))} <a href="${e(t.href)}">${e(t.label)}</a></li>`; }).join('')}</ul>` : '<p class="ap-note">These checks look for gaps and risky claims. They are a help, not a guarantee.</p>'}
${postButton(shell, `${base}/checks`, {}, 'Run checks again', { cls: 'ap-textbutton' })}</div></details>`;
}

function mustFix(shell: Shell, base: string, v: ArticleVersion, critical: readonly CheckIssue[]): string {
  if (!critical.length) return '';
  const b = shell.brand!;
  return `<section class="ap-fix" id="fix" aria-labelledby="fix-title"><h2 id="fix-title">${critical.length === 1 ? 'One thing to fix' : `${critical.length} things to fix`} before this can go out</h2><ul>${critical.map((c) => { const t = fixTarget(b, base, c, v); return `<li><span>${e(plainCheck(c))}</span><a class="button secondary" href="${e(t.href)}">${e(t.label)}</a></li>`; }).join('')}</ul></section>`;
}

function dispatchLine(d: SocialDispatch, timezone: string): string {
  const local = instant(d.scheduledFor, timezone);
  return `${shortWhen(local.date, local.time)}: ${d.state === 'queued' ? 'waiting to send' : `not sent. ${d.detail ?? ''}`}`;
}

function plainPostHold(hold: string): string {
  if (/not been bound/i.test(hold)) return 'Connect your website first, so the post can link to the article.';
  if (/article changed/i.test(hold)) return 'The article changed, so look at this post again.';
  if (/verified public/i.test(hold)) return 'Goes out after the article is live on your website.';
  if (/Awaiting separate approval/i.test(hold)) return 'Waiting for your approval.';
  if (/predates scheduling/i.test(hold)) return 'Approve this post once more so it can go out.';
  if (/Instagram requires/i.test(hold)) return 'Instagram needs a picture before this can go out.';
  return hold;
}

function postSending(shell: Shell, a: Article, v: ArticleVersion, network: 'instagram' | 'linkedin', base: string, social: SocialOverview | null | undefined): string {
  const b = shell.brand!;
  const dispatches = (a.socialDispatches ?? []).filter((d) => d.articleVersionId === v.id && d.network === network);
  const history = dispatches.length ? `<ul class="ap-note">${dispatches.slice(-5).map((d) => `<li>${e(dispatchLine(d, b.timezone))}</li>`).join('')}</ul>` : '';
  const articleHold = promotionPublicationHold(a, v, network);
  const accountHold = social ? bindingHold(social.bindings, network) : 'Sending posts is not available here yet.';
  // The card already says why it is waiting for the article; only account problems are added here.
  if (articleHold) return history;
  if (accountHold) {
    const text = /No .* account is registered/.test(accountHold!) ? `Connect your ${NETWORK[network]} account to send it.` : /switched off/.test(accountHold!) ? `Sending to ${NETWORK[network]} is switched off.` : accountHold!;
    return `${history}<p class="ap-note">${e(text)}${!articleHold && accountHold ? ` <a href="${brandUrl(b, 'social')}">Social accounts</a>` : ''}</p>`;
  }
  const local = instant(new Date(Date.now() + 3_600_000).toISOString(), b.timezone);
  return `${history}<details class="ap-choice"><summary class="ap-textbutton">Choose when to send it</summary><form method="post" action="${base}/social-schedule">${csrfField(shell.csrf)}${hidden({ versionId: v.id, packSha: sha256(v.promotionPack), network })}
<div class="ap-when"><div><label for="sd-${network}">Day</label><input id="sd-${network}" name="localDate" type="date" value="${e(local.date)}" required></div><div><label for="st-${network}">Time</label><input id="st-${network}" name="localTime" type="time" value="${e(local.time)}" required></div></div>
<button type="submit" class="secondary">Send this ${NETWORK[network]} post then</button><p class="ap-note">Just before sending we check the article is still live and unchanged. If anything changed, nothing is sent.</p></form></details>`;
}

function postsSection(shell: Shell, d: ArticlePageData, v: ArticleVersion, base: string): string {
  const a = d.article;
  const b = shell.brand!;
  const pack = v.promotionPack;
  const pic = pictureSrc(b, a, v.body.image);
  if (!pack) return `<section class="ap-posts" aria-labelledby="posts-title"><h2 id="posts-title">Posts that go out with this article</h2><p class="ap-note">No posts were written for this older version of the article.</p></section>`;
  const pending = pack.canonicalUrl ? pack.posts.filter((p) => !linkedPromotionFor(a, v, p.network)) : [];
  const cards = pack.posts.map((post) => {
    const approved = Boolean(linkedPromotionFor(a, v, post.network));
    const hold = promotionPublicationHold(a, v, post.network);
    return `<article class="ap-post" aria-label="${e(NETWORK[post.network] ?? post.network)} post"><header><strong>${e(NETWORK[post.network] ?? post.network)}</strong><span class="ap-note">${approved ? 'Approved' : 'Not approved yet'}</span></header>
${pic ? `<img src="${e(pic)}" alt="${e(v.body.image.alt)}">` : ''}<p class="ap-post-text">${e(post.copy)}</p>${pack.canonicalUrl ? `<p class="ap-post-link">${e(pack.canonicalUrl)}</p>` : ''}
<p class="ap-note">${e(hold ? plainPostHold(hold) : 'Ready to send.')}</p>
<details class="ap-choice"><summary class="ap-textbutton">Picture idea</summary><p class="ap-note">${e(post.artworkInstructions)}</p></details>
${approved ? '' : postButton(shell, `${base}/promotion-approve`, { versionId: v.id, packSha: sha256(pack), network: post.network }, 'Approve this post', { disabled: !pack.canonicalUrl })}
${postSending(shell, a, v, post.network, base, d.social)}</article>`;
  }).join('');
  return `<section class="ap-posts" aria-labelledby="posts-title"><h2 id="posts-title">Posts that go out with this article</h2>
<p>They go out after the article is live on your website. If you change the article, you’ll approve the posts again.</p>
${pack.canonicalUrl ? '' : '<p class="ap-note">Connect your website first, so the posts can link to the article.</p>'}
${pending.length > 1 ? postButton(shell, `${base}/promotion-approve-all`, { versionId: v.id, packSha: sha256(pack) }, `Approve all ${pending.length} posts`) : ''}
<div class="ap-post-grid">${cards}</div>
<details class="ap-choice"><summary class="ap-textbutton">Posts not linking to the right address?</summary><p class="ap-note">This refreshes the posts with the article’s current web address. It makes a new version of the article, so you’ll approve it again.</p>${postButton(shell, `${base}/promotion-refresh`, { versionId: v.id }, 'Refresh the posts’ link')}</details></section>`;
}

function fold(id: ArticleFold, title: string, body: string, open: boolean): string {
  return `<details class="ap-fold" id="${id}"${open ? ' open' : ''}><summary><h2>${e(title)}</h2></summary><div class="ap-fold-body">${body}</div></details>`;
}

function googleFold(d: ArticlePageData, v: ArticleVersion, base: string, editing: boolean, open: boolean): string {
  const body = v.body;
  if (editing) {
    const field = (name: string, id: string, label: string, value: string, help: string, extra = '') => `<label for="${id}">${e(label)}</label><input id="${id}" name="${name}" type="text" value="${e(value)}"${extra}><p class="ap-note">${e(help)}</p>`;
    return fold('google', 'How it appears in Google', `${field('seoTitle', 'g-title', 'Title in Google', body.seoTitle, 'Up to 65 characters.', ' form="article-edit" maxlength="200"')}
${field('metaDescription', 'g-desc', 'Short description in Google', body.metaDescription, '70 to 160 characters reads best.', ' form="article-edit" maxlength="400"')}
${field('slug', 'g-slug', 'Web address ending', body.slug, d.article.publishedUrl ? 'This article is already live, so its address stays the same.' : 'Lower-case words joined by hyphens.', ' form="article-edit" maxlength="80"')}
${field('excerpt', 'g-excerpt', 'Summary on your blog page', body.excerpt, 'One or two sentences.', ' form="article-edit" maxlength="400"')}
${field('imageAlt', 'g-alt', 'Picture description', body.image.alt, 'For people who cannot see the picture.', ' form="article-edit" maxlength="200"')}`, true);
  }
  const address = v.websiteTarget?.target.canonicalUrl ?? d.article.publishedUrl ?? v.promotionPack?.canonicalUrl ?? null;
  return fold('google', 'How it appears in Google', `<div class="ap-serp"><p class="ap-serp-url">${e(address ? address.replace(/^https?:\/\//, '') : `…/${body.slug}`)}</p><p class="ap-serp-title">${e(body.seoTitle)}</p><p class="ap-serp-desc">${e(body.metaDescription)}</p></div>
<dl class="ap-facts"><dt>Summary on your blog page</dt><dd>${e(body.excerpt)}</dd><dt>Picture description</dt><dd>${e(body.image.alt || 'None yet')}</dd><dt>Web address ending</dt><dd>${e(body.slug)}</dd></dl>
<p><a class="ap-textbutton" href="${base}?edit=1#google">Change these</a></p>`, open);
}

function whereFold(shell: Shell, d: ArticlePageData, v: ArticleVersion, base: string, open: boolean): string {
  const b = shell.brand!;
  const a = d.article;
  const connected = d.destinations.filter((x) => x.status === 'connected');
  const site = connected.find((x) => x.id === a.schedule?.destinationId) ?? connected.find((x) => x.id === b.settings.programme?.structure?.destinationId) ?? connected[0];
  const address = v.websiteTarget?.target.canonicalUrl ?? a.publishedUrl ?? v.promotionPack?.canonicalUrl ?? null;
  const parts: string[] = [];
  parts.push(site ? `<p>It goes on <strong>${e(site.label)}</strong>${address ? ` at <span class="ap-url">${e(address)}</span>` : ''}.</p>` : `<p>Your website is not connected yet. <a href="${brandUrl(b, 'setup')}#websites">Connect it in Brand setup</a>.</p>`);
  if (a.publishedUrl) parts.push('<p class="ap-note">It is already live, so its web address stays the same when you change it.</p>');
  // Topics on the website: only when the connected website lets him choose (otherwise there is nothing to decide).
  for (const dest of connected.filter((x) => x.websiteCapability?.protocol === 'v2')) {
    const guidance = b.settings.programme?.structure;
    const root = dest.websiteCapability?.protocol === 'v2' ? dest.websiteCapability.capabilities.roots.find((r) => r.id === guidance?.website?.rootId) : null;
    const historical = d.versions.find((x) => x.id === a.publishedVersionId)?.websiteTarget;
    const currentMatches = guidance?.destinationId === dest.id && guidance.website && (!a.publishedUrl || root?.articleUrlPattern.replace('{slug}', v.body.slug) === a.publishedUrl);
    const catalog = currentMatches ? guidance.website!.categories : a.publishedUrl && historical?.destinationId === dest.id ? historical.target.categories : [];
    if (!catalog.length) continue;
    const chosen = v.websiteTarget?.target.categoryIds ?? [];
    parts.push(`<form method="post" action="${base}/website-target">${csrfField(shell.csrf)}${hidden({ versionId: v.id, destinationId: dest.id })}<fieldset><legend>Which topics on ${e(dest.label)} should list it? (up to five)</legend>${catalog.map((c) => `<label class="ap-check"><input type="checkbox" name="categoryId" value="${e(c.id)}"${chosen.includes(c.id) ? ' checked' : ''}> ${e(c.label)}</label>`).join('')}</fieldset><p class="ap-note">Saving makes a new version; you’ll approve it again. Nothing is published.</p><button class="secondary" type="submit">Save topics</button></form>`);
  }
  // "Ask me before this goes out": the per-article approval switch (it only matters while automatic publishing is on).
  const asks = a.requiresApproval;
  parts.push(`<form method="post" action="${base}/approval-flag" class="ap-setting">${csrfField(shell.csrf)}${hidden({ rowVersion: a.rowVersion, required: asks ? '0' : '1' })}<p><strong>Always ask me before this article goes out:</strong> ${asks ? 'Yes' : 'No'} <button type="submit" class="secondary" role="switch" aria-checked="${asks}" aria-label="Always ask me before this article goes out: ${asks ? 'yes. Switch off' : 'no. Switch on'}">${asks ? 'Switch off' : 'Switch on'}</button></p><p class="ap-note">${b.settings.autoPublish
    ? asks ? 'Automatic publishing is on for your business, but this article still waits for your approval.' : 'Automatic publishing is on for your business, so this article goes out at its time without asking you.'
    : 'Automatic publishing is off for your business, so every article waits for your approval anyway. This only matters if you switch automatic publishing on.'}</p></form>`);
  for (const p of d.publications.filter((x) => x.state === 'published')) parts.push(deliveryChecks(shell, p, d.destinations.find((x) => x.id === p.destinationId), base));
  return fold('where', 'Where it publishes', parts.join('\n'), open);
}

function deliveryChecks(shell: Shell, p: Publication, destination: PublicDestination | undefined, base: string): string {
  const evidence = p.websiteDelivery;
  const label = (state: string) => state === 'verified' ? 'showing' : state === 'different' ? 'showing something different' : 'not checked yet';
  const rows = evidence ? [['The article', evidence.article], ['Your blog page', evidence.index], ...evidence.categories.map((c, i) => [`Topic page ${i + 1}`, c] as const), ['Your site map (for Google)', evidence.sitemap]] as const : [];
  const repair = destination?.websiteCapability?.protocol === 'v2' && destination.websiteCapability.capabilities.repair.sitemap;
  return `<div class="ap-delivery"><h3>Is it showing on your website?</h3>${evidence ? `<ul class="ap-list">${rows.map(([what, check]) => `<li>${e(what)}: ${e(label(check.state))}</li>`).join('')}</ul>` : '<p class="ap-note">We have not checked it yet.</p>'}
${p.sitemapRepair ? `<p class="ap-note">Site map repair: ${e(p.sitemapRepair.state)}. ${e(p.sitemapRepair.detail)}</p>` : ''}
${postButton(shell, `${base}/delivery-recheck`, { publicationId: p.id }, 'Check again')}
${repair ? `<details class="ap-choice"><summary class="ap-textbutton">Add it to the site map only</summary><form method="post" action="${base}/sitemap-repair">${csrfField(shell.csrf)}${hidden({ publicationId: p.id, commandId: randomUUID() })}<p class="ap-note">This only adds this article to your site map. The article itself is not sent again.</p>${p.sitemapRepair?.uncertain && p.sitemapRepair.state !== 'done' ? '<label class="ap-check"><input type="checkbox" name="acknowledgeUnknown" value="1" required> I have checked the earlier attempt and want to try again.</label>' : ''}<button class="secondary" type="submit">Add to the site map</button></form></details>` : ''}</div>`;
}

function sourcesFold(v: ArticleVersion, open: boolean): string {
  const cites = citationNumbers(v.body);
  const ordered = [...cites.list, ...v.body.citations.filter((c) => !cites.list.includes(c))];
  return fold('sources', 'Where the facts came from', ordered.length ? `<ol class="ap-source-list">${ordered.map((c) => `<li><a href="${e(c.url)}" rel="noopener">${e(c.title)}</a> <span class="ap-note">${e(hostOf(c.url))}${c.public ? '' : ' · used for research, not shown to readers'}</span><details><summary class="ap-textbutton">show</summary><p class="ap-note">${e(c.passage)}</p></details></li>`).join('')}</ol>` : '<p class="ap-note">No sources are recorded for this version.</p>', open);
}

function historyFold(shell: Shell, d: ArticlePageData, base: string, open: boolean): string {
  const tz = shell.brand!.timezone;
  const change: Record<string, string> = { generated: 'Written', edited: 'You edited it', section_regenerated: 'One part rewritten', regenerated: 'Rewritten', image_changed: 'Picture changed', metadata_changed: 'Details changed' };
  const versions = [...d.versions].reverse().map((x) => { const at = instant(x.createdAt, tz); return `<li><span>Version ${x.number}${x.id === d.article.currentVersionId ? ' (this one)' : ''} · ${e(change[x.change] ?? 'Changed')} · ${e(shortWhen(at.date, at.time))}</span> <a href="${base}/preview?v=${e(x.id)}" target="_blank" rel="noopener">Preview</a></li>`; }).join('');
  const attempts = d.publications.length ? `<h3>Publishing attempts</h3><ul class="ap-list">${d.publications.map((p) => `<li>${e(({ prepared: 'Getting ready', submitted: 'Sent to your website', outcome_unknown: 'Result not confirmed', verifying: 'Checking it is live', published: 'Live', failed: 'Did not work', cancelled: 'Cancelled' } as Record<string, string>)[p.state] ?? p.state)}${p.verifiedAt ? ` · confirmed ${e(shortWhen(instant(p.verifiedAt, tz).date, instant(p.verifiedAt, tz).time))} at <a href="${e(p.publicUrl)}">${e(p.publicUrl)}</a>` : ''}<br><span class="ap-note">${e(p.detail)}</span></li>`).join('')}</ul>` : '';
  return fold('history', 'Earlier versions', `<ul class="ap-list">${versions}</ul>${attempts}`, open);
}

function rewriteFold(shell: Shell, v: ArticleVersion, base: string, open: boolean): string {
  return fold('rewrite', 'Ask for a rewrite', `<form method="post" action="${base}/rewrite">${csrfField(shell.csrf)}${hidden({ versionId: v.id })}<label for="rw-part">Which part?</label><select id="rw-part" name="sectionId"><option value="whole">The whole article</option>${v.body.sections.map((s) => `<option value="${e(s.id)}">${e(s.heading)}</option>`).join('')}</select>
<label for="rw-what">What should change?</label><textarea id="rw-what" name="instruction" maxlength="1000" rows="3" placeholder="For example: make it simpler, add an example"></textarea>
<p class="ap-note">One part: only that part changes and the rest stays exactly as it is. The whole article is written again from the same plan, and your note is not used. Either way it uses some of your monthly writing allowance, and you’ll approve it again.</p><button type="submit" class="secondary">Ask for the rewrite</button></form>`, open);
}

function moreMenu(shell: Shell, d: ArticlePageData, v: ArticleVersion, base: string): string {
  const a = d.article;
  const items: string[] = [];
  if (a.delivery !== 'publishing') items.push(`<a href="${base}?edit=1">Edit</a>`);
  items.push(`<a href="${base}?open=rewrite#rewrite">Ask for a rewrite</a>`);
  if (a.delivery !== 'publishing') items.push(postButton(shell, `${base}/hold`, { rowVersion: a.rowVersion, held: a.hold?.reason === 'owner' ? '0' : '1' }, a.hold?.reason === 'owner' ? 'Allow it to go out' : 'Don’t publish this', { cls: 'ap-menu-button' }));
  if (a.schedule && a.delivery !== 'publishing') items.push(postButton(shell, `${base}/unschedule`, { rowVersion: a.rowVersion }, 'Take it off the calendar', { cls: 'ap-menu-button' }));
  items.push(`<a href="${base}?open=download#download">Download</a>`, `<a href="${base}?open=history#history">Earlier versions</a>`, `<a href="${base}/preview?v=${e(v.id)}" target="_blank" rel="noopener">Open it as a web page</a>`,
    `<a href="${base}/campaign">Pictures and social posts plan</a>`, `<a href="${base}/posts">Posts for other sites (copy and paste)</a>`);
  return `<details class="ap-more"><summary class="ap-textbutton">More</summary><div class="ap-menu" role="menu">${items.map((i) => `<div role="menuitem">${i}</div>`).join('')}</div></details>`;
}

function bar(inner: string): string {
  return `<div class="ap-bar" role="region" aria-label="What happens next">${inner}</div>`;
}

export function editorPage(shell: Shell, d: ArticlePageData): string {
  const b = shell.brand!;
  const a = d.article;
  const v = d.version;
  const base = brandUrl(b, `articles/${a.id}`);
  const open = new Set(d.open ?? []);
  if (!v) {
    const status = writingStatus(b, a, a.briefId, d.jobs ?? []);
    const failed = a.editorialState === 'failed';
    const sentence = a.campaignGeneration ? 'This article is written, but its last step did not finish.' : failed ? status.sentence : status.sentence === 'Being written' ? 'This article is being written. You can leave this page; it carries on.' : `${status.sentence}${/[.:]$/.test(status.sentence) ? '' : '.'}`;
    const action = status.retryJobId ? postButton(shell, brandUrl(b, `jobs/${status.retryJobId}/retry`), { back: `articles/${a.id}` }, 'Try again', { primary: true }) : status.link ? primaryLink(status.link.href, status.link.label) : '';
    const title = d.workingTitle || a.slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
    return layout(shell, 'Article', `<div class="ap">${bar(`<p class="ap-state">${e(sentence)}${status.retryCosts ? ' <span class="ap-note">Trying again uses some of your writing allowance.</span>' : ''}</p><div class="ap-actions">${action}</div>`)}
<article class="ap-read"><h1 class="ap-title">${e(title)}</h1><p class="ap-note">Not written yet. The article appears here as soon as it is ready.</p></article>${a.campaignGeneration ? `<div class="ap-column">${savedCampaignCopyStatus(shell, a)}</div>` : ''}</div>`, `<style>${ARTICLE_CSS}</style>`);
  }
  const editing = d.mode === 'edit';
  const issues = a.checks?.versionId === v.id ? a.checks.issues : (a.checks?.issues ?? []);
  const critical = issues.filter((i) => i.severity === 'critical');
  const warnings = issues.filter((i) => i.severity !== 'critical');
  const simulated = v.generation?.mode === 'simulated' ? '<p class="ap-quiet-line">This is practice text written without the writing service. Do not publish it as it is.</p>' : '';
  if (editing) {
    const head = bar(`<p class="ap-state"><strong>Editing</strong> <span class="ap-note">Type **bold** for bold, and start a line with - for a list. Saving makes a new version. You’ll approve it again.</span></p><div class="ap-actions"><a class="ap-textbutton" href="${base}">Cancel</a><button type="submit" form="article-edit" class="ap-primary" data-primary>Save changes</button></div>`);
    return layout(shell, v.body.title, `<div class="ap ap-editing">${head}
<form method="post" action="${base}/edit" id="article-edit" class="ap-read">${csrfField(shell.csrf)}${hidden({ versionId: v.id, citationsHidden: '1', imageUrl: v.body.image.url ?? '' })}
${editingColumn(v.body)}
<p class="ap-note">Sources stay linked to their sentences when you save. If you delete a sentence, its source link goes with it.</p></form>
<div class="ap-folds">${googleFold(d, v, base, true, true)}</div></div>`, `<style>${ARTICLE_CSS}</style>`);
  }
  const state = screenState(shell, d, v, critical);
  const head = bar(`<p class="ap-state">${e(state.sentence)}${state.detail ? ` <span class="ap-note">${e(state.detail)}</span>` : ''}</p><div class="ap-actions">${state.secondary.map((s) => s.html).join('')}${moreMenu(shell, d, v, base)}${state.primary?.html ?? ''}</div>`);
  return layout(shell, v.body.title, `<div class="ap">${head}
<div class="ap-column">${simulated}${mustFix(shell, base, v, critical)}${improvements(shell, base, v, warnings, open.has('improve'))}</div>
<article class="ap-read">${pictureArea(shell, a, v, base)}
${readingColumn(b, a, v.body)}</article>
<div class="ap-column">${postsSection(shell, d, v, base)}</div>
<div class="ap-folds">
${googleFold(d, v, base, false, open.has('google'))}
${whereFold(shell, d, v, base, open.has('where'))}
${sourcesFold(v, open.has('sources'))}
${historyFold(shell, d, base, open.has('history'))}
${fold('download', 'Download', `<p><a href="${base}/export?format=markdown">Download as a text file (Markdown)</a></p><p><a href="${base}/export?format=html">Download as a web page (HTML)</a></p>`, open.has('download'))}
${rewriteFold(shell, v, base, open.has('rewrite'))}
</div></div>`, `<style>${ARTICLE_CSS}</style>`);
}

// ─── The articles list ───────────────────────────────────────────────────────

export interface ArticleListRow {
  readonly article: Article;
  readonly title: string;
  readonly status: string;
  readonly excerpt?: string;
  readonly image?: ArticleBody['image'];
}

type Group = 'ready' | 'coming' | 'writing' | 'live';

function rowState(b: Brand, row: ArticleListRow, jobs: readonly Job[], today: string): { group: Group; line: string; retryJobId: string | null; link: WritingStatus['link'] } {
  const a = row.article;
  const none = { retryJobId: null, link: null };
  if (!a.currentVersionId) {
    const w = writingStatus(b, a, a.briefId, jobs);
    return { group: 'writing', line: w.sentence.replace(/\.$/, ''), retryJobId: w.retryJobId, link: w.link };
  }
  const critical = (a.checks?.issues ?? []).filter((i) => i.severity === 'critical').length;
  switch (row.status) {
    case 'Published': return { ...none, group: 'live', line: `Live since ${a.publishedAt ? shortWhen(instant(a.publishedAt, b.timezone).date, null, today) : 'recently'}` };
    case 'Scheduled': return { ...none, group: 'coming', line: a.schedule ? `Going out ${shortWhen(a.schedule.localDate, a.schedule.localTime, today)}` : 'Going out soon' };
    case 'Publishing': return { ...none, group: 'coming', line: 'Going onto your website now' };
    case 'Outcome unknown': return { ...none, group: 'coming', line: 'Checking it reached your website' };
    default: break;
  }
  if (critical) return { ...none, group: 'ready', line: critical === 1 ? 'Needs one fix' : `Needs ${critical} fixes` };
  if (row.status === 'Held') return { ...none, group: 'ready', line: plainHold(a.hold?.reason ?? '').replace(/\.$/, '') };
  if (row.status === 'Failed') return { ...none, group: 'ready', line: 'Did not reach your website' };
  if (row.status === 'Needs approval') return { ...none, group: 'ready', line: a.schedule ? `Ready for you to read · planned for ${shortWhen(a.schedule.localDate, null, today)}` : 'Ready for you to read' };
  return { ...none, group: 'ready', line: 'Approved, not on the calendar yet' };
}

export function articlesPage(shell: Shell, data: { articles: readonly ArticleListRow[]; jobs?: readonly Job[]; briefs?: readonly ArticleBrief[]; now?: string }): string {
  const b = shell.brand!;
  const today = (data.now ?? new Date().toISOString()).slice(0, 10);
  const jobs = data.jobs ?? [];
  const briefs = new Map((data.briefs ?? []).map((x) => [x.id, x]));
  type Item = { href: string; title: string; line: string; excerpt: string; thumb: string | null; alt: string; retryJobId: string | null; link: WritingStatus['link']; sort: string };
  const groups: Record<Group, Item[]> = { ready: [], coming: [], writing: [], live: [] };
  for (const row of data.articles) {
    const s = rowState(b, row, jobs, today);
    const brief = briefs.get(row.article.briefId);
    const title = row.article.currentVersionId ? row.title : brief?.workingTitle || row.title.replace(/^./, (c) => c.toUpperCase());
    const src = row.image ? pictureSrc(b, row.article, row.image) : null;
    groups[s.group].push({ href: brandUrl(b, `articles/${row.article.id}`), title, line: s.line, excerpt: (row.excerpt ?? '').split(/\n/)[0] ?? '', thumb: src, alt: row.image?.alt ?? '', retryJobId: s.retryJobId, link: s.link,
      sort: s.group === 'coming' ? row.article.schedule?.publishAtUtc ?? '' : s.group === 'live' ? `~${row.article.publishedAt ?? ''}` : row.article.createdAt });
  }
  // Topics asked for but not started yet (the article record appears when writing starts).
  for (const brief of data.briefs ?? []) {
    if (brief.status !== 'generating' || data.articles.some((r) => r.article.briefId === brief.id)) continue;
    const w = writingStatus(b, null, brief.id, jobs);
    groups.writing.push({ href: brandUrl(b, 'topics'), title: brief.workingTitle, line: w.sentence.replace(/\.$/, ''), excerpt: '', thumb: null, alt: '', retryJobId: w.retryJobId, link: w.link, sort: brief.id });
  }
  groups.coming.sort((x, y) => x.sort.localeCompare(y.sort));
  groups.live.sort((x, y) => y.sort.localeCompare(x.sort));
  const titles: Record<Group, string> = { ready: 'Ready for you', coming: 'Coming up', writing: 'Being written', live: 'Live' };
  const row = (i: Item) => `<li class="al-row"><a class="al-link" href="${i.href}"><span class="al-thumb">${i.thumb ? `<img src="${e(i.thumb)}" alt="${e(i.alt)}">` : '<span class="al-thumb-empty" aria-hidden="true"></span>'}</span><span class="al-text"><span class="al-title">${e(i.title)}</span><span class="al-line${i.retryJobId || i.link ? ' al-line-wrap' : ''}">${e(i.line)}${i.excerpt ? ` · ${e(i.excerpt)}` : ''}</span></span></a>${i.retryJobId ? `<form method="post" action="${brandUrl(b, `jobs/${i.retryJobId}/retry`)}" class="al-act">${csrfField(shell.csrf)}${hidden({ back: 'articles' })}<button type="submit" class="secondary" title="Trying again uses some of your writing allowance">Try again</button></form>` : i.link ? `<a class="al-act ap-textbutton" href="${e(i.link.href)}">${e(i.link.label)}</a>` : ''}</li>`;
  const sections = (['ready', 'coming', 'writing', 'live'] as const).filter((g) => groups[g].length).map((g) => `<section class="al-group" aria-labelledby="al-${g}"><h2 id="al-${g}">${titles[g]} <span class="al-count">(${groups[g].length})</span></h2><ul class="al-list">${groups[g].map(row).join('')}</ul></section>`).join('');
  return layout(shell, 'Articles', `<div class="al"><h1>Articles</h1>${sections || `<p class="al-empty">No articles yet. Choose topics in <a href="${brandUrl(b, 'topics')}">Topics</a> and they appear here as they are written.</p>`}</div>`, `<style>${ARTICLE_CSS}</style>`);
}

// ─── Styles (the portal's own tokens; no new fonts or assets) ────────────────

export const ARTICLE_CSS = `
.ap,.al{--col:42rem}
.ap-bar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;justify-content:space-between;max-width:calc(var(--col) + 120px);margin:0 auto 28px;padding:12px 16px;background:color-mix(in srgb,var(--card) 94%,transparent);backdrop-filter:blur(6px);border:1px solid var(--line);border-radius:14px;box-shadow:0 6px 20px #0c10180d}
.ap-state{margin:0;flex:1 1 260px;font-size:16px;line-height:1.45}.ap-state .ap-note{display:block;margin-top:2px}
.ap-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:flex-end}
.ap-inline{display:inline;margin:0}
.ap .ap-primary,.ap-bar .ap-primary{min-height:44px;padding:10px 18px;border-radius:999px;font-weight:700;background:var(--accent);border-color:var(--accent);color:#fff;text-decoration:none;cursor:pointer;list-style:none}
summary.ap-primary::-webkit-details-marker,summary.ap-textbutton::-webkit-details-marker,.ap-more summary::-webkit-details-marker,.ap-change summary::-webkit-details-marker{display:none}
.ap-textbutton{display:inline-block;background:none;border:0;color:var(--accent);font:inherit;font-weight:600;padding:8px 6px;min-height:auto;cursor:pointer;text-decoration:none;list-style:none}
button.ap-textbutton{border:0;background:none;color:var(--accent)}
.ap-textbutton:hover{text-decoration:underline}
.ap-more,.ap-later{position:relative}
.ap-menu,.ap-later>.ap-panel{position:absolute;right:0;top:calc(100% + 6px);z-index:6;min-width:260px;background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 30px #0c10181f;padding:8px}
.ap-menu>div>a,.ap-menu .ap-menu-button{display:block;width:100%;text-align:left;padding:10px 12px;border-radius:8px;color:var(--ink);text-decoration:none;background:none;border:0;font:inherit;font-weight:500;min-height:auto}
.ap-menu>div>a:hover,.ap-menu .ap-menu-button:hover{background:var(--bg)}
.ap-later>.ap-panel{min-width:300px;padding:16px}
.ap-when{display:flex;gap:12px}.ap-when>div{flex:1}
.ap-column,.ap-read,.ap-folds{max-width:var(--col);margin-left:auto;margin-right:auto}
.ap-read{font-size:18px;line-height:1.7;color:var(--ink)}
.ap-read p,.ap-read li{margin:0 0 1em}.ap-read ul,.ap-read ol{padding-left:1.3em;margin:0 0 1.1em}.ap-read li{margin:0 0 .45em}
.ap-title{font-size:clamp(30px,4.2vw,40px);line-height:1.15;letter-spacing:-.025em;margin:8px 0 22px}
.ap-read h2{font-size:25px;line-height:1.25;letter-spacing:-.015em;margin:1.8em 0 .55em}
.ap-read h3{font-size:19px;line-height:1.35;margin:1.4em 0 .4em}
.ap-read sup{font-size:.6em;line-height:0}.ap-read sup a{text-decoration:none;color:var(--muted)}
.ap-cta{display:inline-block;padding:10px 16px;border:1px solid var(--accent);border-radius:999px;text-decoration:none}
.ap-sources{margin-top:2.4em;padding-top:1em;border-top:1px solid var(--line);font-size:15px;color:var(--muted)}.ap-sources h2{font-size:17px;margin:0 0 .6em}
.ap-pic{margin:0 0 6px}.ap-pic img{display:block;width:100%;height:auto;max-height:420px;object-fit:cover;border-radius:16px;background:var(--bg)}
.ap-pic figcaption{display:flex;justify-content:flex-end}
.ap-pic-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:200px;padding:28px 16px;border-radius:16px;background:var(--bg);border:1px dashed color-mix(in srgb,var(--muted) 45%,transparent);text-align:center}
.ap-pic-empty>p{margin:0;color:var(--muted);font-size:16px}
.ap-change{width:100%;text-align:center}.ap-change>summary{cursor:pointer;margin:0 auto}
.ap-choices{margin:12px auto 0;max-width:460px;text-align:left;padding:14px 16px;background:var(--card);border:1px solid var(--line);border-radius:12px;font-size:15px;line-height:1.5}
.ap-choice{margin:4px 0}.ap-choice form{padding:4px 0 10px}
.ap-note{color:var(--muted);font-size:14px;line-height:1.5}
.ap-quiet-line{color:var(--muted);font-size:15px;margin:0 0 14px}
.ap-quiet{margin:0 0 22px;font-size:15px;color:var(--muted)}.ap-quiet>summary{cursor:pointer;display:inline-block;text-decoration:underline dotted;text-underline-offset:3px}
.ap-quiet .ap-panel{margin-top:8px;padding:12px 16px;background:var(--card);border:1px solid var(--line);border-radius:12px;color:var(--ink)}
.ap-list{margin:0 0 10px;padding-left:1.1em}.ap-list li{margin:0 0 .5em}
.ap-fix{margin:0 0 22px;padding:16px 18px;border-radius:14px;background:color-mix(in srgb,var(--bad) 7%,var(--card));border:1px solid color-mix(in srgb,var(--bad) 35%,transparent)}
.ap-fix h2{font-size:18px;margin:0 0 10px}.ap-fix ul{list-style:none;margin:0;padding:0}
.ap-fix li{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;justify-content:space-between;padding:8px 0;border-top:1px solid color-mix(in srgb,var(--bad) 18%,transparent)}.ap-fix li:first-child{border-top:0}
.ap-fix li span{flex:1 1 260px}
.ap-posts{margin:56px auto 8px;padding-top:28px;border-top:1px solid var(--line)}.ap-posts>h2{font-size:22px;margin:0 0 6px}.ap-posts>p{margin:0 0 14px;color:var(--muted)}
.ap-post-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin:16px 0}
.ap-post{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;min-width:0}
.ap-post header{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:10px}
.ap-post img{display:block;width:100%;height:150px;object-fit:cover;border-radius:10px;margin:0 0 10px}
.ap-post-text{white-space:pre-wrap;margin:0 0 6px;font-size:15px;line-height:1.55}.ap-post-link{margin:0 0 6px;font-size:14px;color:var(--accent);overflow-wrap:anywhere}
.ap-folds{margin-top:40px;border-top:1px solid var(--line)}
.ap-fold{border-bottom:1px solid var(--line)}.ap-fold>summary{cursor:pointer;padding:16px 4px;list-style:none;display:flex;justify-content:space-between;align-items:center}
.ap-fold>summary::-webkit-details-marker{display:none}.ap-fold>summary h2{font-size:17px;margin:0;font-weight:600}
.ap-fold>summary::after{content:"Show";color:var(--accent);font-weight:600;font-size:14px}.ap-fold[open]>summary::after{content:"Hide"}
.ap-fold-body{padding:0 4px 22px;font-size:15px;line-height:1.55;overflow-wrap:anywhere}
.ap-serp{padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--card);margin:0 0 14px}.ap-serp p{margin:0}
.ap-serp-url{font-size:13px;color:var(--muted);overflow-wrap:anywhere}.ap-serp-title{font-size:19px;color:var(--accent);margin:2px 0 4px!important}.ap-serp-desc{font-size:14px;color:var(--ink)}
.ap-facts dt{font-weight:600;margin-top:8px}.ap-facts dd{margin:2px 0 0}
.ap-url{overflow-wrap:anywhere}.ap-check{font-weight:500;display:flex;gap:8px;align-items:center}.ap-check input{width:auto}
.ap-source-list{padding-left:1.2em}.ap-source-list li{margin:0 0 .8em}.ap-source-list details{display:inline}
.ap-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.ap-edit{display:block;width:100%;min-height:0;border:0;border-radius:6px;background:transparent;color:var(--ink);padding:2px 0;margin:0;resize:none;overflow:hidden;field-sizing:content;box-shadow:inset 0 -1px 0 transparent;transition:background .15s}
.ap-edit:hover{background:color-mix(in srgb,var(--accent) 4%,transparent)}
.ap-edit:focus{background:color-mix(in srgb,var(--accent) 6%,transparent);outline:2px solid color-mix(in srgb,var(--accent) 55%,transparent);outline-offset:4px}
.ap-edit-h1{font-size:clamp(30px,4.2vw,40px);line-height:1.15;letter-spacing:-.025em;font-weight:700;margin:8px 0 22px}
.ap-edit-h2{font-size:25px;line-height:1.25;letter-spacing:-.015em;font-weight:700;margin:1.8em 0 .55em}
.ap-edit-h3{font-size:19px;line-height:1.35;font-weight:700;margin:1.4em 0 .4em}
.ap-edit-p{font-size:18px;line-height:1.7;margin:0 0 1em}
.ap-editing .ap-bar{border-color:color-mix(in srgb,var(--accent) 40%,var(--line))}
.ap :focus-visible{outline:3px solid #3557ff;outline-offset:3px}
.al{max-width:46rem;margin:0 auto}.al h1{margin-bottom:28px}
.al-group{margin:0 0 34px}.al-group h2{font-size:15px;text-transform:none;letter-spacing:0;color:var(--muted);font-weight:600;margin:0 0 6px}.al-count{font-weight:500}
.al-list{list-style:none;margin:0;padding:0}
.al-row{display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--line)}
.al-link{flex:1;display:flex;align-items:center;gap:16px;padding:14px 4px;min-width:0;text-decoration:none;color:var(--ink);border-radius:10px}
.al-link:hover{background:color-mix(in srgb,var(--accent) 4%,transparent)}
.al-thumb{flex:0 0 88px;width:88px;height:60px;border-radius:10px;overflow:hidden;background:var(--bg)}
.al-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.al-thumb-empty{display:block;width:100%;height:100%;background:linear-gradient(135deg,var(--bg),color-mix(in srgb,var(--line) 70%,var(--bg)))}
.al-text{display:flex;flex-direction:column;min-width:0;gap:3px}
.al-title{font-size:17px;font-weight:600;line-height:1.35}
.al-line{font-size:14px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.al-act{flex:0 0 auto;margin:0}.al-line-wrap{white-space:normal}
.al-empty{color:var(--muted)}
@media(max-width:700px){
.ap-bar{border-radius:0;margin:0 -16px 20px;border-left:0;border-right:0;padding:10px 16px}
.ap-actions{width:100%;justify-content:space-between}
.ap-more,.ap-later{position:static}.ap-menu,.ap-later>.ap-panel{position:absolute;left:8px;right:8px;top:calc(100% + 4px);min-width:0;max-height:70vh;overflow:auto}
.ap-read{font-size:17px}.ap-edit-p{font-size:17px}.ap-read h2,.ap-edit-h2{font-size:22px}
.al-thumb{flex-basis:64px;width:64px;height:48px}.al-link{gap:12px}
.al-row{flex-wrap:wrap}.al-link{flex:1 1 100%}.al-act{margin:-6px 0 12px 80px}
}
`;
