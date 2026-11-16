/**
 * The content area preview's own screens: Home ("what needs you"), the Calendar month, the Articles list and an honest
 * Results page, plus the page that switches the preview on or off for a browser.
 *
 * Everything shown is read from the business's real records through the rules the existing pages use: `situation`
 * and `writingStatus` from the article page, `plannedSiteGone` from the publishing plan, and the engine's own conditions
 * for writing ahead (see `fillOutlook`). The shell never says something the article page or the engine would contradict,
 * and shows no number the system does not have.
 */
import { addDays, utcToLocal } from '../seo-blog/schedule.js';
import { plannedSiteGone } from '../seo-blog/publishing-plan.js';
import { monthlyCeiling } from '../seo-blog/limits.js';
import { legacyPlanningHold } from '../seo-blog/programme.js';
import { isArticleWriteJob } from '../seo-blog/image-campaign.js';
import { USAGE_ESTIMATES, type BrandReadiness } from '../seo-blog/engine.js';
import type { Article, ArticleBody, ArticleBrief, Brand, Destination, Job, TopicPlan, UsageKind } from '../seo-blog/types.js';
import { csrfField, layout, SEO_BLOG_BASE, type BrandDnaDoorStatus, type Shell } from './seo-blog-view.js';
import { longWhen, safeHttps, situation, writingStatus, type ArticleListRow, type ResumeFacts, type Situation, type WritingStatus } from './seo-blog-article-view.js';
import { autopilot, publishingDays, type ContentAreaAutopilot } from './content-area-layout.js';
import { CONTENT_AREA_TOKENS } from './content-area-theme.js';
import { escapeHtml as e } from './ui.js';

type PublicDestination = Omit<Destination, 'sealedCredential'>;

export interface ContentAreaData {
  readonly articles: readonly ArticleListRow[];
  readonly destinations: readonly PublicDestination[];
  readonly jobs: readonly Job[];
  readonly briefs: readonly ArticleBrief[];
  readonly now: string;
  /** Current facts a stopped write is judged against (the article page's ResumeFacts). */
  readonly resume?: ResumeFacts | null;
}

/** What the engine needs before it writes for an empty publishing day (all read-only). */
export interface FillFacts {
  readonly readiness: BrandReadiness | null;
  readonly usage: Record<UsageKind, number> | null;
  readonly dna: BrandDnaDoorStatus | undefined;
  readonly plans: readonly TopicPlan[];
}

/** What needs the owner. 'stuck' is writing that stopped and has no button of its own: shown, but below reading and off the badge. */
type Problem = 'paused' | 'site_gone' | 'no_website' | 'failed' | 'writing' | 'held' | 'owner_hold' | 'read' | 'stuck';

interface Item {
  readonly row: ArticleListRow | null;
  readonly brief: ArticleBrief | null;
  readonly href: string;
  readonly title: string;
  readonly line: string;
  readonly excerpt: string;
  readonly picture: string | null;
  readonly alt: string;
  /** What the article page says (with the business paused, that is "Publishing is paused" for every article). */
  readonly sit: Situation | null;
  /** The article's own state with the pause set aside: what would need the owner once publishing is back on. */
  readonly own: Situation | null;
  readonly gone: { readonly id: string; readonly label: string; readonly removed: boolean; readonly other: boolean } | null;
  readonly retryJobId: string | null;
  /** The retry button's words ("Write it now" once the cause was cleared). */
  readonly retryLabel?: string | undefined;
  readonly link: { href: string; label: string } | null;
  /** Set when this needs the owner, with the kind of problem. */
  readonly problem: Problem | null;
}

const brandHref = (b: Brand, path: string) => `${SEO_BLOG_BASE}/b/${b.id}/${path}`;
const clock = (time: string) => time.replace(/^0(\d)/, '$1');
function local(iso: string, tz: string): { date: string; time: string } {
  try { return utcToLocal(iso, tz); } catch { return { date: iso.slice(0, 10), time: iso.slice(11, 16) }; }
}
const weekday = (date: string) => utcToLocal(`${date}T12:00:00Z`, 'UTC').weekday;
const dayName = (date: string, style: 'short' | 'long' = 'short') => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: style, timeZone: 'UTC' });
const longDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const monthName = (date: string) => new Date(`${date.slice(0, 7)}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const suggestedAt = (brief: ArticleBrief | null) => (brief as (ArticleBrief & { suggestedAtUtc?: string | null }) | null)?.suggestedAtUtc ?? null;

/** The picture the owner sees for an article (a privately reviewed hero comes from the private route), as on the article page. */
function pictureSrc(b: Brand, article: Article, image: ArticleBody['image'] | undefined): string | null {
  if (!image?.url) return null;
  const hero = article.heroMedia;
  if (hero && image.url === hero.reservation.prospectiveUrl && /^[0-9a-f-]{36}$/i.test(hero.reservation.assetId) && /^[0-9a-f]{64}$/i.test(hero.reservation.assetSha256)) return `${SEO_BLOG_BASE}/b/${b.id}/media/${hero.reservation.assetId}/${hero.reservation.assetSha256}.jpg`;
  return safeHttps(image.url);
}

/** States where the article page itself puts a planned-but-disconnected website first (mirrors its `plan.goneSite` rule). */
const GONE_SHOWN = (kind: string) => !['live', 'publishing', 'checking', 'owner_hold', 'must_fix'].includes(kind);

type Groups = Record<'ready' | 'coming' | 'writing' | 'stopped' | 'live', Item[]>;

/** Every article (and every topic being written) in the articles list's four groups; "ready" is everything that needs the owner. */
function groups(b: Brand, d: ContentAreaData): Groups {
  const websites = d.destinations.filter((x) => x.status === 'connected').length;
  const briefs = new Map(d.briefs.map((x) => [x.id, x]));
  const unpaused = b.settings.pauseAll ? { ...b, settings: { ...b.settings, pauseAll: false } } : b;
  const out: Groups = { ready: [], coming: [], writing: [], stopped: [], live: [] };
  // Writing that will not carry on by itself needs the owner: a retry, a link, or the article page's "Paused:",
  // "Writing stopped" and "Writing was cancelled" sentences (writingStatus). Without an action of its own, the next
  // step is the task history in Activity, where the task can be looked at and tried again.
  // A stop with no button of its own ("stuck": cancelled, stopped, or the writing service not connected) cannot be
  // restarted from here, so it never pins Home or the badge; it is listed under "Stopped" with Activity as the next step.
  const stalled = (w: WritingStatus): Problem | null => w.retryJobId || w.link ? 'writing' : /^(Paused:|Writing stopped|Writing was cancelled)/.test(w.sentence) ? 'stuck' : null;
  const place = (p: Problem | null) => p === 'stuck' ? 'stopped' : p ? 'ready' : 'writing';
  const nextStep = (w: WritingStatus, problem: Problem | null) => w.link ?? (problem && !w.retryJobId ? { href: brandHref(b, 'activity'), label: 'See what happened' } : null);
  for (const row of d.articles) {
    const a = row.article;
    const brief = briefs.get(a.briefId) ?? null;
    const base = { row, brief, href: brandHref(b, `articles/${a.id}`), excerpt: (row.excerpt ?? '').split(/\n/)[0] ?? '', picture: pictureSrc(b, a, row.image), alt: row.image?.alt ?? '', gone: null };
    if (!a.currentVersionId) {
      const w = writingStatus(b, a, a.briefId, d.jobs, d.resume);
      const problem = stalled(w);
      out[place(problem)].push({ ...base, title: brief?.workingTitle || row.title.replace(/^./, (c) => c.toUpperCase()), line: w.sentence.replace(/\.$/, ''), sit: null, own: null, retryJobId: w.retryJobId, retryLabel: w.retryLabel, link: nextStep(w, problem), problem });
      continue;
    }
    const sit = situation(a, b, d.now, websites);
    const own = b.settings.pauseAll ? situation(a, unpaused, d.now, websites) : sit;
    const planned = GONE_SHOWN(own.kind) ? plannedSiteGone(a, d.destinations) : null;
    // plannedSiteGone names a website that is still on record; one that was removed has no name to give.
    const gone = planned ? { ...planned, removed: !d.destinations.some((x) => x.id === planned.id), other: d.destinations.some((x) => x.status === 'connected' && x.id !== planned.id) } : null;
    const problem: Problem | null = gone ? 'site_gone' : own.group !== 'ready' ? null
      : own.kind === 'no_website' ? 'no_website' : own.kind === 'failed' ? 'failed' : own.kind === 'held' ? 'held' : own.kind === 'owner_hold' ? 'owner_hold' : 'read';
    const line = gone ? (gone.removed ? 'Planned for a website that has been removed' : `Planned for ${gone.label}, which is not connected any more`) : sit.line;
    const group = problem ? 'ready' : own.group === 'ready' ? 'coming' : own.group;
    out[group].push({ ...base, title: row.title, line, sit, own, gone, retryJobId: null, link: null, problem });
  }
  for (const brief of d.briefs) {
    if (brief.status !== 'generating' || d.articles.some((r) => r.article.briefId === brief.id)) continue;
    const w = writingStatus(b, null, brief.id, d.jobs, d.resume);
    const problem = stalled(w);
    out[place(problem)].push({ row: null, brief, href: brandHref(b, 'topics'), title: brief.workingTitle, line: w.sentence.replace(/\.$/, ''), excerpt: '', picture: null, alt: '', sit: null, own: null, gone: null, retryJobId: w.retryJobId, retryLabel: w.retryLabel, link: nextStep(w, problem), problem });
  }
  const order: Record<Problem, number> = { paused: 0, site_gone: 1, no_website: 2, failed: 3, writing: 4, held: 5, owner_hold: 6, read: 7, stuck: 8 };
  out.stopped.sort((x, y) => (x.row?.article.createdAt ?? '~').localeCompare(y.row?.article.createdAt ?? '~'));
  out.ready.sort((x, y) => order[x.problem!] - order[y.problem!] || (x.row?.article.createdAt ?? '~').localeCompare(y.row?.article.createdAt ?? '~'));
  out.coming.sort((x, y) => (x.row!.article.schedule?.publishAtUtc ?? '').localeCompare(y.row!.article.schedule?.publishAtUtc ?? ''));
  out.live.sort((x, y) => (y.row!.article.publishedAt ?? '').localeCompare(x.row!.article.publishedAt ?? ''));
  return out;
}

/** The written articles that need the owner, in the order Home and the badge use (for "2 of 5 that need you"). */
export function needsQueue(b: Brand, d: ContentAreaData): string[] {
  return groups(b, d).ready.flatMap((i) => i.row ? [i.row.article.id.toLowerCase()] : []);
}

/** An error answer in the new look (a page of its own, no business sidebar), with the same message and way back. */
export function contentErrorPage(shell: Shell, status: number, message: string): string {
  return layout(shell, status === 404 ? 'Not found' : 'Something needs attention', `<div class="ca-col"><section class="ca-panel ca-empty-big"><h1 class="ca-h1">${status === 404 ? 'Not found' : 'Something needs attention'}</h1><p>${e(message)}</p><a class="ca-btn" href="${SEO_BLOG_BASE}" data-primary>Back to your businesses ${arrow}</a></section></div>`, `<style>${PAGE_CSS}</style>`);
}

/** The number on the Articles badge: everything that needs the owner (the new list's "Needs you" group). */
export function needsYouCount(b: Brand, d: ContentAreaData): number {
  return groups(b, d).ready.length;
}

/**
 * Whether the engine will really write for an empty publishing day, from the same conditions its daily job and plan
 * acceptance use (engine.ts runDaily / topUpWrites / plan commit): ongoing production on and not paused, plans accepted
 * without the owner, Brand DNA and set-up ready, no research hold, allowance left, below the backlog ceiling and no
 * suggested plan waiting for the owner. Anything unknown counts as "no".
 */
export interface FillOutlook {
  readonly fills: boolean;
  /** The Calendar's sentence. */
  readonly line: string;
  /** True when ongoing production is on but something stops it writing that the owner can fix. */
  readonly held: boolean;
  /** A short title and line for Home and the sidebar while it is held, and where to fix it. */
  readonly title: string;
  readonly short: string;
  readonly fix: { readonly href: string; readonly label: string } | null;
}

/** Whether the engine can afford its next step, with the engine's own estimates and its requireBudget rule (used + estimate within a positive ceiling). */
function affordable(b: Brand, usage: Record<UsageKind, number>, kind: 'model_tokens' | 'search_calls', estimate: number): boolean {
  const ceiling = monthlyCeiling(b.settings, kind);
  return ceiling > 0 && usage[kind] + estimate <= ceiling;
}

export function fillOutlook(b: Brand, d: ContentAreaData, f: FillFacts): FillOutlook {
  const s = b.settings;
  const quiet = (line: string): FillOutlook => ({ fills: false, line, held: false, title: '', short: '', fix: null });
  const held = (line: string, title: string, short: string, fix: FillOutlook['fix']): FillOutlook => ({ fills: false, line, held: true, title, short, fix });
  if (s.pauseAll) return quiet('Publishing is paused, so nothing new is written and nothing goes out until you switch it back on.');
  if (!s.ongoingProduction) return quiet('Empty publishing days stay empty until you choose topics for them.');
  if (f.dna !== 'confirmed' || f.readiness?.profile !== 'confirmed') return held('Empty publishing days are not filled until your Brand DNA is confirmed.',
    'Autopilot is waiting for your Brand DNA', 'It writes nothing new until your Brand DNA is confirmed.', { href: brandHref(b, 'dna'), label: 'Open your Brand DNA' });
  // Allowance before the rest of set-up: a zero allowance is also what makes set-up incomplete, and allowance is the reason to give.
  const plan = USAGE_ESTIMATES.plan, searches = USAGE_ESTIMATES.searchPerPlan;
  if (f.readiness?.budgets === false || (f.usage && (!affordable(b, f.usage, 'model_tokens', plan) || !affordable(b, f.usage, 'search_calls', searches)))) {
    return held('Empty publishing days are not filled until there is enough writing and research allowance left this month for new topics.',
      'Autopilot is waiting for allowance', 'There is not enough writing or research allowance left this month for new topics.', { href: `${brandHref(b, 'publishing')}#writing-budget`, label: 'Check the allowance' });
  }
  if (!f.usage) return held('Empty publishing days are filled only while there is allowance left; we could not check it just now.',
    'Autopilot could not check the allowance', 'We could not check the allowance just now.', { href: `${brandHref(b, 'publishing')}#writing-budget`, label: 'Check the allowance' });
  if (!f.readiness?.canPlan) return held('Empty publishing days are not filled until set-up is finished.',
    'Autopilot is waiting for set-up', 'Set-up is not finished, so it cannot plan new topics.', { href: brandHref(b, 'setup'), label: 'Finish set-up' });
  if (s.programme?.researchHold || legacyPlanningHold(d.jobs, s.programme?.researchAcknowledgements)) return held('Empty publishing days are not filled until you look at the research hold in Topics.',
    'Autopilot is waiting for you in Topics', 'Research is on hold until you look at it.', { href: `${brandHref(b, 'topics')}#research-status`, label: 'Look at the research hold' });
  if (f.plans.some((p) => p.status === 'proposed')) return held('Empty publishing days are not filled until you accept the topics already suggested in Topics.',
    'Autopilot is waiting for you in Topics', 'Suggested topics are waiting for you to accept them.', { href: brandHref(b, 'topics'), label: 'Look at the suggested topics' });
  if (!s.autoAcceptPlans) return quiet('Empty publishing days are not filled until you accept new topics in Topics.');
  const pending = d.jobs.filter((j) => isArticleWriteJob(j) && ['queued', 'running'].includes(j.state)).length;
  const backlog = d.articles.filter((r) => r.article.delivery !== 'published').length + pending;
  if (backlog >= s.backlogCeiling) return quiet(`Empty publishing days are not filled while ${plural(backlog, 'unpublished article is', 'unpublished articles are')} waiting (your limit is ${s.backlogCeiling}).`);
  return { fills: true, line: `Empty publishing days up to ${plural(s.planningHorizonDays, 'day', 'days')} ahead fill themselves, so all you do is read and decide.`, held: false, title: '', short: '', fix: null };
}

/** The sidebar's autopilot line, made true by the same outlook as the Calendar. */
export function contentAreaAutopilot(b: Brand, d: ContentAreaData, f: FillFacts): ContentAreaAutopilot | undefined {
  const o = fillOutlook(b, d, f);
  return o.held ? { on: false, title: o.title, line: o.short, fix: o.fix } : undefined;
}

function picture(i: Pick<Item, 'picture' | 'alt'>, cls = '', writing = false): string {
  if (i.picture) return `<span class="ca-pic ${cls}"><img src="${e(i.picture)}" alt="${e(i.alt)}" loading="lazy"></span>`;
  return `<span class="ca-pic ca-pic-none ${cls}" aria-hidden="true">${writing ? PEN : ''}</span>`;
}

const PEN = '<svg class="ca-ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
const arrow = '<svg class="ca-ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const chevron = '<svg class="ca-ic ca-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9 6 6 6-6 6"/></svg>';
const bolt = '<svg class="ca-ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>';
const amber = (href: string, label: string, cls = '') => `<a class="ca-btn ${cls}" href="${e(href)}" data-primary>${e(label)} ${arrow}</a>`;
const retryButton = (shell: Shell, jobId: string, back: string, primary: boolean, label = 'Try again') => `<form method="post" action="${e(brandHref(shell.brand!, `jobs/${jobId}/retry`))}" class="${primary ? 'ca-hero-form' : 'ca-row-act'}">${csrfField(shell.csrf)}<input type="hidden" name="back" value="${e(back)}"><button type="submit" class="${primary ? 'ca-btn' : 'ca-btn-quiet'}"${primary ? ' data-primary' : ''}>${e(label)}</button><span class="ca-note">Uses some of your writing allowance.</span></form>`;

/** The words and the one action for the first thing that needs the owner (the article page's own sentence and action). */
function needHero(shell: Shell, i: Item, others: number): { tag: string; title: string; text: string; action: string } {
  const b = shell.brand!;
  const more = others ? ` ${others === 1 ? 'One more thing needs' : `${others} more need`} you in Articles.` : '';
  const t = `“${e(i.title)}”`;
  switch (i.problem) {
    case 'site_gone': return i.gone!.removed
      ? i.gone!.other
        ? { tag: 'Needs you today', title: 'The website for an article was removed', text: `${t} was planned for a website that has been removed. Choose another website for it, or a new time.${more}`, action: amber(i.href, 'Choose another website') }
        : { tag: 'Needs you today', title: 'The website for an article was removed', text: `${t} was planned for a website that has been removed, and no other website is connected. Connect your website and then choose a time for it.${more}`, action: amber(`${brandHref(b, 'setup')}#website-connection`, 'Connect your website') }
      : { tag: 'Needs you today', title: 'Your website is not connected', text: `${t} was planned for ${e(i.gone!.label)}, which is not connected any more. It will not go out until the connection works or you choose another website.${more}`, action: amber(`${brandHref(b, 'setup')}#website-connection`, `Check the connection to ${i.gone!.label}`) };
    case 'no_website': return { tag: 'Needs you today', title: 'Connect your website', text: `${t} is ready, but your website is not connected yet, so nothing can go out.${more}`, action: amber(`${brandHref(b, 'setup')}#website-connection`, 'Connect your website') };
    case 'failed': return { tag: 'Needs you today', title: 'An article did not reach your website', text: `${t}: ${e(i.own!.bar)} Open it to try again or choose a time.${more}`, action: amber(i.href, 'Open it and try again') };
    case 'writing': {
      // The Articles row's own sentence, then a true next step for the cases that have no button of their own.
      const step = /writing service is not connected/.test(i.line) ? ' Ask whoever set up your account to connect it. Nothing written so far is lost.'
        : /^Writing was cancelled|^Writing stopped/.test(i.line) ? ' It will not carry on by itself. Activity shows what happened to it.' : '';
      return { tag: 'Needs you today', title: /^Writing was cancelled/.test(i.line) ? 'Writing was cancelled' : 'Writing has stopped', text: `${t}: ${e(i.line)}.${step}${more}`,
        action: i.retryJobId ? retryButton(shell, i.retryJobId, 'articles', true, i.retryLabel) : amber(i.link!.href.replace(/&amp;/g, '&'), i.link!.label) };
    }
    case 'held': {
      const reason = i.row!.article.hold?.reason;
      const action = reason === 'destination' ? amber(`${brandHref(b, 'setup')}#website-connection`, 'Check the connection') : reason === 'budget' ? amber(brandHref(b, 'publishing'), 'Check the allowance') : amber(i.href, 'Open it');
      return { tag: 'Needs you today', title: 'An article is on hold', text: `${t}: ${e(i.own!.bar)}${more}`, action };
    }
    case 'owner_hold': return { tag: 'Needs you today', title: 'An article is waiting for your go-ahead', text: `${t}: ${e(i.own!.bar)} Open it when you want it to go out.${more}`, action: amber(i.href, 'Open it') };
    default: return { tag: 'Needs you today', title: '', text: '', action: '' };
  }
}

const DNA_DOOR: Record<'proposed' | 'out_of_date', { title: string; text: string; label: string }> = {
  proposed: { title: 'Check your Brand DNA card', text: 'We have read your website and made your Brand DNA card. Check what we found and confirm it, so the articles sound like you.', label: 'Check your Brand DNA card' },
  out_of_date: { title: 'Your Brand DNA is out of date', text: 'Something about your business has changed since your Brand DNA card was confirmed. Look at it again so new articles stay right.', label: 'Look at your Brand DNA' },
};

// ─── Home ────────────────────────────────────────────────────────────────────

export function contentHomePage(shell: Shell, d: ContentAreaData & { readonly fill: FillFacts }): string {
  const b = shell.brand!;
  const s = b.settings;
  const g = groups(b, d);
  const now = local(d.now, b.timezone);
  const hour = Number(now.time.slice(0, 2));
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const needs = g.ready;
  const reading = needs.filter((i) => i.problem === 'read');
  const problems = needs.filter((i) => i.problem !== 'read');
  const anything = d.articles.length > 0 || g.writing.length > 0 || g.stopped.length > 0 || needs.length > 0;
  const dna = d.fill.dna === 'proposed' || d.fill.dna === 'out_of_date' ? DNA_DOOR[d.fill.dna] : null;
  const outlook = fillOutlook(b, d, d.fill);
  const dnaLine = dna ? ` <a class="ca-hero-link" href="${e(brandHref(b, 'dna'))}">${e(dna.title)}</a>` : '';
  const heroBox = (tag: string, title: string, text: string, action: string, art = '', calm = false) => `<section class="ca-hero${calm ? ' ca-hero-calm' : ''}" aria-labelledby="ca-hero-title"><div class="ca-hero-text"><p class="ca-tag${calm ? ' ca-tag-calm' : ''}">${e(tag)}</p>
<h2 id="ca-hero-title" class="ca-hero-h">${e(title)}</h2><p class="ca-hero-p">${text}</p>${action}</div>${art}</section>`;
  let lede: string, hero: string;
  if (s.pauseAll) {
    lede = needs.length ? `Publishing is paused, and ${plural(needs.length, 'article needs', 'articles need')} you.` : 'Publishing is paused.';
    hero = heroBox('Paused', 'Publishing is paused', `Nothing goes out and nothing new is written until you switch it back on.${needs.length ? ` ${plural(needs.length, 'article also needs', 'articles also need')} you in Articles.` : ''}${dnaLine}`, amber(`${brandHref(b, 'publishing')}#pause`, 'Switch publishing back on'));
  } else if (problems.length) {
    const h = needHero(shell, problems[0]!, needs.length - 1);
    lede = needs.length === 1 ? 'One thing needs you.' : `${needs.length} things need you.`;
    hero = heroBox(h.tag, h.title, `${h.text}${dnaLine}`, h.action);
  } else if (reading.length) {
    const n = reading.length;
    const first = reading[0]!;
    const allReading = reading.every((i) => i.own?.kind === 'ready');
    const pics = reading.filter((i) => i.picture).slice(0, 3);
    lede = `${n === 1 ? 'One article is' : `${n} articles are`} written and waiting for you.`;
    hero = heroBox('Needs you today', n === 1 ? `1 article ${allReading ? 'is ready for you to read' : 'needs you'}` : `${n} articles ${allReading ? 'are ready for you to read' : 'need you'}`,
      `Start with “${e(first.title)}”. Read it, then decide whether it goes out.${n > 1 ? ' The others wait in Articles.' : ''}${dnaLine}`, amber(first.href, 'Start reading'),
      pics.length ? `<div class="ca-hero-art ca-hero-art-${pics.length}" aria-hidden="true">${pics.map((p, i) => picture(p, `ca-hero-pic ca-p${i + 1}`)).join('')}</div>` : '');
  } else if (dna) {
    lede = 'Your Brand DNA needs a look.';
    hero = heroBox('Needs you today', dna.title, e(dna.text), amber(brandHref(b, 'dna'), dna.label));
  } else if (anything) {
    const next = g.coming.find((i) => i.own?.kind === 'scheduled' && Date.parse(i.row!.article.schedule!.publishAtUtc) > Date.parse(d.now));
    const sc = next?.row?.article.schedule;
    const now0 = g.coming.find((i) => i.own?.kind === 'due' || i.own?.kind === 'publishing');
    const outNext = next && sc ? `Next out: “${e(next.title)}” on ${e(longWhen(sc.localDate, sc.localTime, now.date))}.`
      : now0 ? `“${e(now0.title)}” is going out now.` : 'Nothing is booked to go out yet.';
    const writing = g.writing.length ? ` ${plural(g.writing.length, 'article is', 'articles are')} being written; we will show it here when it is ready for you.` : '';
    if (outlook.held) {
      // Not "everything is running": ongoing production is held by something he can fix (the Calendar's reason).
      lede = 'Nothing to read today, but autopilot is waiting for you.';
      hero = heroBox('Autopilot is waiting', outlook.title, `${e(outlook.short)} ${outNext}${writing}`, outlook.fix ? amber(outlook.fix.href, outlook.fix.label) : '');
    } else if (g.stopped.length) {
      // Stopped writing with no button of its own: said plainly, but it does not hold Home (nothing he can press fixes it here).
      const stuck = g.stopped[0]!;
      lede = 'Nothing needs you today.';
      hero = heroBox('Nothing to do now', 'Nothing needs you today', `${outNext}${writing} “${e(stuck.title)}”: ${e(stuck.line)}. It will not carry on by itself.${g.stopped.length > 1 ? ` ${plural(g.stopped.length - 1, 'other has', 'others have')} stopped too.` : ''}`,
        `<a class="ca-btn-2" href="${e(brandHref(b, 'activity'))}">See what happened</a>`, '', true);
    } else {
      lede = 'Everything is running. Nothing needs you today.';
      hero = heroBox('All clear', 'Nothing needs you today', `${outNext}${writing}`, `<a class="ca-btn-2" href="${e(brandHref(b, 'calendar'))}">See the calendar</a>`, '', true);
    }
  } else {
    const confirmed = d.fill.dna === 'confirmed';
    lede = `Let us get the first articles written for ${b.name}.`;
    hero = heroBox('First step', confirmed ? 'Choose your first topics' : 'Start with your website', confirmed ? 'Your Brand DNA is ready. Pick the topics you want us to write about and the articles appear here as they are written.' : 'Paste your website address. We read it and learn how your business talks, then you check what we found.',
      amber(brandHref(b, confirmed ? 'topics' : 'dna'), confirmed ? 'Choose topics' : 'Start with your website'));
  }
  const monday = addDays(now.date, 1 - weekday(now.date));
  const sunday = addDays(monday, 6);
  const inWeek = (date: string | null | undefined) => Boolean(date && date >= monday && date <= sunday);
  const going = s.pauseAll ? [] : g.coming.filter((i) => ['scheduled', 'due', 'publishing', 'rewriting'].includes(i.own?.kind ?? '') && inWeek(i.row!.article.schedule?.localDate));
  const week = [...g.live.filter((i) => inWeek(i.row!.article.publishedAt ? local(i.row!.article.publishedAt, b.timezone).date : null)).map((i) => ({ i, date: local(i.row!.article.publishedAt!, b.timezone).date, live: true })),
    ...going.map((i) => ({ i, date: i.row!.article.schedule!.localDate, live: false }))].sort((x, y) => x.date.localeCompare(y.date));
  const weekRows = week.map(({ i, date, live }) => `<li><a class="ca-wk" href="${e(i.href)}"><span class="ca-sr">${e(longDay(date))}: </span><span class="ca-wk-date" aria-hidden="true"><b>${e(dayName(date))}</b><i>${Number(date.slice(8))}</i></span>${picture(i, 'ca-wk-pic')}<span class="ca-row-text"><span class="ca-row-title">${e(i.title)}</span><span class="ca-sr">. </span><span class="ca-row-line">${e(i.line)}</span></span><span class="ca-chip${live ? ' ca-chip-live' : ''}" aria-hidden="true">${live ? 'Live' : 'Going out'}</span></a></li>`).join('');
  const days = publishingDays(s.cadence.weekdays, s.cadence.localTime);
  const weekNeeds = needs.some((i) => inWeek(i.row?.article.schedule?.localDate));
  const weekBlock = anything ? `<section aria-labelledby="ca-week"><h2 id="ca-week" class="ca-h2">Going out this week</h2><p class="ca-sub">${s.cadence.weekdays.length ? `You publish on ${e(days)}.` : 'No publishing days are set.'}${s.pauseAll ? ' Publishing is paused, so nothing else goes out this week.' : week.length && !weekNeeds ? ' Nothing here needs you.' : ''}</p>
${week.length ? `<ul class="ca-panel ca-rows">${weekRows}</ul>` : `<p class="ca-panel ca-empty">Nothing is going out this week. <a href="${e(brandHref(b, 'calendar'))}">Open the calendar</a></p>`}</section>` : '';
  const auto = autopilot(shell);
  const autoBlock = `<section class="ca-autocard" aria-labelledby="ca-auto"><span class="ca-auto-badge" aria-hidden="true">${bolt}</span><div><h2 id="ca-auto" class="ca-h3">${e(auto.title)}</h2><p>${e(auto.line)}</p></div><a href="${e(auto.fix?.href ?? brandHref(b, 'publishing'))}">${e(auto.fix?.label ?? 'Change this')}</a></section>`;
  return layout(shell, 'Home', `<div class="ca-col"><header><h1 class="ca-h1">${greeting}</h1><p class="ca-lede">${e(lede)}</p></header>${hero}${weekBlock}${autoBlock}</div>`, `<style>${PAGE_CSS}</style>`);
}

// ─── Calendar ────────────────────────────────────────────────────────────────

interface CalItem { readonly kind: 'live' | 'going' | 'needs' | 'writing' | 'topic' | 'free' | 'fill'; readonly label: string; readonly title: string; readonly href: string | null; readonly pic: Pick<Item, 'picture' | 'alt'> | null }

export function contentCalendarPage(shell: Shell, d: ContentAreaData & { readonly month: string; readonly fill: FillFacts }): string {
  const b = shell.brand!;
  const s = b.settings;
  const g = groups(b, d);
  const today = local(d.now, b.timezone).date;
  const items = new Map<string, CalItem[]>();
  const add = (date: string, item: CalItem) => items.set(date, [...(items.get(date) ?? []), item]);
  const suggested = (i: Item) => { const at = suggestedAt(i.brief); return at ? local(at, b.timezone).date : null; };
  for (const i of g.live) add(local(i.row!.article.publishedAt ?? i.row!.article.schedule?.publishAtUtc ?? d.now, b.timezone).date, { kind: 'live', label: 'Live', title: i.title, href: i.href, pic: i });
  for (const i of g.coming) {
    const sc = i.row!.article.schedule;
    if (!sc) continue;
    // The label is the article page's own state: never "going out" while paused or while it is being checked.
    const kind = i.own?.kind;
    const label = s.pauseAll ? 'Paused' : kind === 'checking' ? 'Being checked' : kind === 'due' || kind === 'publishing' ? 'Going out now'
      : (kind === 'scheduled' || kind === 'rewriting') && Date.parse(sc.publishAtUtc) > Date.parse(d.now) ? `Goes out ${clock(sc.localTime)}` : 'Coming up';
    add(sc.localDate, { kind: 'going', label, title: i.title, href: i.href, pic: i });
  }
  for (const i of g.ready) {
    const date = i.row?.article.schedule?.localDate ?? suggested(i);
    if (date) add(date, { kind: 'needs', label: 'Needs you', title: i.title, href: i.href, pic: i.row ? i : null });
  }
  for (const i of g.writing) { const date = suggested(i); if (date) add(date, { kind: 'writing', label: 'Being written', title: i.title, href: i.href, pic: null }); }
  for (const brief of d.briefs) {
    const at = suggestedAt(brief);
    if (!at || !['planned', 'accepted'].includes(brief.status) || d.articles.some((r) => r.article.briefId === brief.id)) continue;
    add(local(at, b.timezone).date, { kind: 'topic', label: 'Topic chosen', title: brief.workingTitle, href: brandHref(b, 'topics'), pic: null });
  }
  const first = `${d.month}-01`;
  const lead = weekday(first) - 1;
  const start = addDays(first, -lead);
  const lastDay = addDays(`${new Date(Date.UTC(Number(d.month.slice(0, 4)), Number(d.month.slice(5, 7)), 15)).toISOString().slice(0, 7)}-01`, -1);
  const weeks = Math.ceil((lead + Number(lastDay.slice(8))) / 7);
  const days = Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
  // Empty publishing days ahead: "We will fill this" only when the engine really will write for them (fillOutlook).
  const outlook = fillOutlook(b, d, d.fill);
  const horizon = addDays(today, s.planningHorizonDays);
  const perWeek = new Map<string, number>();
  for (const day of days) { const monday = addDays(day, 1 - weekday(day)); perWeek.set(monday, (perWeek.get(monday) ?? 0) + (items.get(day)?.filter((x) => x.kind !== 'topic').length ?? 0)); }
  if (!s.pauseAll) for (const day of days) {
    if (day <= today || !s.cadence.weekdays.includes(weekday(day)) || items.get(day)?.length) continue;
    const monday = addDays(day, 1 - weekday(day));
    if ((perWeek.get(monday) ?? 0) >= s.cadence.perWeek) continue;
    perWeek.set(monday, (perWeek.get(monday) ?? 0) + 1);
    const fills = outlook.fills && day <= horizon;
    add(day, { kind: fills ? 'fill' : 'free', label: fills ? 'We will fill this' : 'Free publishing day', title: '', href: null, pic: null });
  }
  const tile = (x: CalItem) => {
    const media = x.kind === 'fill' || x.kind === 'free' ? `<span class="ca-slot ca-slot-${x.kind}" aria-hidden="true">${x.kind === 'fill' ? bolt : ''}</span>`
      : x.pic ? picture(x.pic, 'ca-cal-pic') : `<span class="ca-slot ca-slot-${x.kind}" aria-hidden="true">${x.kind === 'writing' ? '<svg class="ca-ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>' : ''}</span>`;
    const inner = `${media}<span class="ca-st ca-st-${x.kind}">${e(x.label)}</span>${x.title ? `<span class="ca-cal-title">${e(x.title)}</span>` : ''}`;
    return x.href ? `<a class="ca-cal-item" href="${e(x.href)}">${inner}</a>` : `<div class="ca-cal-item">${inner}</div>`;
  };
  const cell = (day: string) => {
    const out = day.slice(0, 7) !== d.month;
    const list = items.get(day) ?? [];
    return `<li class="ca-day${out ? ' ca-out' : ''}${day === today ? ' ca-today' : ''}"><h3 class="ca-dnum"><span class="ca-sr">${e(longDay(day))}</span><span aria-hidden="true">${Number(day.slice(8))}</span>${day === today ? '<span class="ca-today-tag">Today</span>' : ''}</h3>${list.map(tile).join('')}</li>`;
  };
  const shift = (n: number) => new Date(Date.UTC(Number(d.month.slice(0, 4)), Number(d.month.slice(5, 7)) - 1 + n, 1)).toISOString().slice(0, 10);
  const agendaDays = days.filter((day) => day.slice(0, 7) === d.month && (items.get(day)?.length ?? 0) > 0);
  const agenda = agendaDays.length ? agendaDays.map((day) => `<li class="ca-ag-day${day === today ? ' ca-today' : ''}"><h3 class="ca-ag-date"><b>${e(dayName(day))}</b><i>${Number(day.slice(8))}</i>${day === today ? '<span class="ca-today-tag">Today</span>' : ''}</h3><div class="ca-ag-items">${(items.get(day) ?? []).map(tile).join('')}</div></li>`).join('')
    : '<li class="ca-empty">Nothing is on the calendar this month.</li>';
  const needs = g.ready.length;
  const fillLine = outlook.line;
  const primary = s.pauseAll ? amber(`${brandHref(b, 'publishing')}#pause`, 'Switch publishing back on')
    : needs ? amber(g.ready[0]!.href, needs === 1 ? 'Open the one that needs you' : `Start with the first of the ${needs} that need you`)
      : outlook.held && outlook.fix ? amber(outlook.fix.href, outlook.fix.label) : '';
  return layout(shell, 'Calendar', `<div class="ca-col ca-wide"><header class="ca-cal-head"><h1 class="ca-h1">${e(monthName(first))}</h1><nav class="ca-month-nav" aria-label="Month"><a class="ca-mn" href="?date=${shift(-1)}"><span class="ca-sr">Previous month</span><span aria-hidden="true">‹</span></a><a class="ca-mn" href="?date=${shift(1)}"><span class="ca-sr">Next month</span><span aria-hidden="true">›</span></a></nav><span class="ca-grow"></span>${primary}</header>
<p class="ca-autoline"><span class="ca-auto-badge" aria-hidden="true">${bolt}</span><span class="ca-grow">${s.cadence.weekdays.length ? `You publish on ${e(publishingDays(s.cadence.weekdays, s.cadence.localTime))}.` : 'No publishing days are set.'} ${e(fillLine)}</span><a href="${e(brandHref(b, 'publishing'))}">Change the days</a></p>
<section class="ca-cal" aria-label="${e(monthName(first))}"><div class="ca-dow" aria-hidden="true">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x) => `<span>${x}</span>`).join('')}</div><ol class="ca-days">${days.map(cell).join('')}</ol></section>
<section class="ca-agenda" aria-label="${e(monthName(first))}, day by day"><ol>${agenda}</ol></section>
<p class="ca-quiet-links"><a href="${e(brandHref(b, `calendar?view=month&date=${first}`))}">Move dates and schedule drafts by hand</a> · <a href="${e(brandHref(b, 'social/calendar'))}">Social posts calendar</a></p></div>`, `<style>${PAGE_CSS}</style>`);
}

// ─── Articles ────────────────────────────────────────────────────────────────

/** The Articles header button: "read" only for a written article to read; otherwise it opens the first one (or Topics). */
function headerLabel(first: Item, n: number): string {
  if (!first.row) return 'Open Topics';
  if (first.problem === 'read') return n === 1 ? 'Read it' : 'Start with the first';
  return n === 1 ? 'Open it' : 'Open the first one';
}

export function contentArticlesPage(shell: Shell, d: ContentAreaData): string {
  const b = shell.brand!;
  const g = groups(b, d);
  const titles = { ready: 'Needs you', coming: 'Coming up', writing: 'Being written', stopped: 'Stopped', live: 'Live' } as const;
  const row = (i: Item, group: keyof typeof g) => {
    const action = i.retryJobId ? `<form method="post" action="${e(brandHref(b, `jobs/${i.retryJobId}/retry`))}" class="ca-row-act">${csrfField(shell.csrf)}<input type="hidden" name="back" value="articles"><button type="submit" class="ca-btn-quiet">${e(i.retryLabel ?? 'Try again')}</button><span class="ca-note">Uses some of your writing allowance.</span></form>`
      : i.link ? `<a class="ca-row-act ca-link" href="${e(i.link.href)}">${e(i.link.label)}</a>`
        : i.gone ? (i.gone.removed ? (i.gone.other ? `<a class="ca-row-act ca-link" href="${e(i.href)}">Choose another website</a>` : `<a class="ca-row-act ca-link" href="${e(`${brandHref(b, 'setup')}#website-connection`)}">Connect your website</a>`)
          : `<a class="ca-row-act ca-link" href="${e(`${brandHref(b, 'setup')}#website-connection`)}">Check the connection to ${e(i.gone.label)}</a>`) : '';
    return `<li class="ca-row"><a class="ca-row-main" href="${e(i.href)}">${picture(i, 'ca-row-pic', group === 'writing' || group === 'stopped')}<span class="ca-row-text"><span class="ca-row-title">${e(i.title)}</span><span class="ca-row-line">${e(i.line)}</span>${i.excerpt && group !== 'writing' ? `<span class="ca-row-ex">${e(i.excerpt)}</span>` : ''}</span>${chevron}</a>${action}</li>`;
  };
  const sections = (['ready', 'coming', 'writing', 'stopped', 'live'] as const).filter((k) => g[k].length).map((k) => `<section class="ca-group" aria-labelledby="ca-g-${k}"><div class="ca-group-head"><h2 id="ca-g-${k}" class="ca-h2">${titles[k]}</h2><span class="ca-gcount${k === 'ready' ? ' ca-gcount-needs' : ''}"><span class="ca-sr">: </span>${g[k].length}</span><span class="ca-grow"></span>${k === 'ready' ? amber(g.ready[0]!.href, headerLabel(g.ready[0]!, g.ready.length), 'ca-btn-sm') : ''}</div><ul class="ca-panel ca-rows">${g[k].map((i) => row(i, k)).join('')}</ul></section>`).join('');
  const empty = `<section class="ca-panel ca-empty-big"><h2 class="ca-h2">No articles yet</h2><p>Choose the topics you want us to write about. The articles appear here as they are written.</p><a class="ca-btn" href="${e(brandHref(b, 'topics'))}" data-primary>Choose topics ${arrow}</a></section>`;
  return layout(shell, 'Articles', `<div class="ca-col"><header><h1 class="ca-h1">Articles</h1><p class="ca-lede">Everything we have written for ${e(b.name)}.</p></header>${sections || empty}</div>`, `<style>${PAGE_CSS}</style>`);
}

// ─── Your businesses ─────────────────────────────────────────────────────────

/**
 * Written articles that need the owner, from two cheap reads (articles and websites): the badge's own rule for written
 * articles. Writing that stopped needs the write tasks, which this does not read, so the line only ever speaks of
 * written articles.
 */
export function writtenNeedsCount(b: Brand, articles: readonly ArticleListRow[], destinations: readonly PublicDestination[], now: string): number {
  return groups(b, { articles, destinations, jobs: [], briefs: [], now }).ready.filter((i) => i.row?.article.currentVersionId).length;
}

export interface BusinessCard {
  readonly brand: Brand;
  /** One honest status line, or null when it was not read (beyond the first few businesses, or a read failed). */
  readonly line: string | null;
}

/** The status line for one business, from what was read for it. */
export function businessLine(b: Brand, dna: BrandDnaDoorStatus | undefined, written: number | null): string | null {
  if (dna && dna !== 'confirmed') return dna === 'none' ? 'Start with your website' : dna === 'proposed' ? 'Your Brand DNA card is waiting for you' : 'Your Brand DNA is out of date';
  if (b.settings.pauseAll) return 'Publishing is paused';
  if (written === null) return null;
  return written ? `${plural(written, 'written article needs', 'written articles need')} you` : 'No written articles waiting for you';
}

const initialsOf = (name: string) => { const w = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean); return ((w[0]?.[0] ?? '') + (w[1]?.[0] ?? '')).toUpperCase() || '?'; };

/** "Your businesses" in the new look: one calm card per business; the card opens its Home. Every existing action stays. */
export function contentBusinessesPage(shell: Shell, d: { readonly cards: readonly BusinessCard[]; readonly commandId: string; readonly existing: { readonly commandId: string; readonly name: string; readonly anchor: string } | null; readonly approvalsHref: string; readonly resultsHref: string }): string {
  const many = shell.brands.length > 1;
  const cards = d.cards.map(({ brand: b, line }) => `<li class="ca-bcard"><a class="ca-bcard-main" href="${e(brandHref(b, 'overview'))}"><span class="ca-bcard-av" aria-hidden="true">${e(initialsOf(b.name))}</span><span class="ca-bcard-text"><span class="ca-bcard-name">${e(b.name)}</span>${b.website ? `<span class="ca-bcard-site">${e(b.website.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</span>` : ''}${line ? `<span class="ca-bcard-line">${e(line)}</span>` : ''}</span>${chevron}</a>
<p class="ca-bcard-links"><a href="${e(`${d.approvalsHref}?brand=${b.id}`)}">Approvals</a><a href="${e(`${d.resultsHref}?brand=${b.id}`)}">Campaign results</a></p></li>`).join('');
  const first = !shell.brands.length;
  const add = `<section class="ca-panel ca-addbiz" id="add-business" aria-labelledby="add-business-title"><h2 id="add-business-title" class="ca-h2">${first ? 'Add your first business' : 'Add a business'}</h2>
<p class="ca-sub">Type the name of the business. On the next screen you paste its website address and we read it for you. Adding it publishes nothing, contacts no one and spends nothing.</p>
<form method="post" action="${SEO_BLOG_BASE}/brands">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${e(d.commandId)}">
<div class="ca-fields"><div><label for="name">Business name</label><input id="name" name="name" type="text" required minlength="2" maxlength="120" autocomplete="organization"></div><div><label for="website">Website address (you can add it on the next screen)</label><input id="website" name="website" type="text" inputmode="url" placeholder="www.example.co.uk"></div></div>
<button type="submit" class="${first ? 'ca-btn' : 'ca-btn-quiet'}"${first ? ' data-primary' : ''}>Add a business</button></form></section>`;
  const existing = d.existing ? `<section class="ca-panel ca-addbiz" id="${e(d.existing.anchor)}" aria-labelledby="${e(d.existing.anchor)}-title"><h2 id="${e(d.existing.anchor)}-title" class="ca-h2">${e(d.existing.name)}</h2>
<p class="ca-sub">Use your existing ${e(d.existing.name)} account for blog and content. Your contacts, webinars and emails stay exactly as they are. Nothing is spent until you set a monthly allowance.</p>
<form method="post" action="${SEO_BLOG_BASE}/brands/existing">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${e(d.existing.commandId)}"><button type="submit" class="ca-btn-quiet">Use ${e(d.existing.name)} here</button></form></section>` : '';
  const hidden = shell.brands.length - d.cards.filter((c) => c.line !== null).length;
  return layout(shell, 'Your businesses', `<div class="ca-col"><header><h1 class="ca-h1">Your businesses</h1><p class="ca-lede">${shell.brands.length ? 'Each business has its own articles, calendar and results. Open one to see what needs you.' : 'Add your first business to start.'}</p>
${shell.brands.length ? `<p class="ca-quiet-links"><a href="${e(`${d.approvalsHref}${many ? '?brand=all' : `?brand=${shell.brands[0]!.id}`}`)}">${many ? 'See what is waiting in every business' : 'See what is waiting for approval'}</a> · <a href="#add-business">Add a business</a></p>` : ''}</header>
${cards ? `<ul class="ca-bcards">${cards}</ul>${hidden > 0 && shell.brands.length > 12 ? `<p class="ca-sub">The status line is shown for the first 12 businesses; open any other to see what needs you.</p>` : ''}` : ''}${existing}${add}</div>`, `<style>${PAGE_CSS}${BUSINESS_CSS}</style>`);
}

const BUSINESS_CSS = `
.ca-bcards{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.ca-bcard{display:flex;flex-direction:column;background:var(--ca-surface);border-radius:var(--ca-radius-l);box-shadow:var(--ca-shadow);overflow:hidden}
.ca-bcard-main{display:flex;align-items:center;gap:16px;padding:20px 20px 12px;min-height:44px;color:var(--ca-ink)!important;text-decoration:none}
.ca-bcard-main:hover .ca-bcard-name{text-decoration:underline;text-underline-offset:3px}
.ca-bcard-av{width:52px;height:52px;flex:none;display:grid;place-items:center;border-radius:50%;background:var(--ca-amber);color:var(--ca-on-amber);font:var(--ca-weight-display) 19px/1 var(--ca-font-display)}
.ca-bcard-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.ca-bcard-name{font:var(--ca-weight-display) 20px/1.2 var(--ca-font-display);overflow-wrap:anywhere}
.ca-bcard-site{font-size:14px;color:var(--ca-muted);overflow-wrap:anywhere}
.ca-bcard-line{margin-top:4px;font-size:15px;font-weight:600;color:var(--ca-ink)}
.ca-bcard-links{margin:0;padding:0 20px 14px 88px;display:flex;flex-wrap:wrap;gap:0 16px;font-size:14px}.ca-bcard-links a{min-height:44px;display:inline-flex;align-items:center;font-weight:600}
.ca-addbiz{padding:24px;display:grid;gap:10px}.ca-addbiz form{display:grid;gap:14px;justify-items:start}
.ca-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;width:100%}
.ca-fields label{display:block;font-weight:600;margin:0 0 6px}.ca-fields input{width:100%;min-height:48px;padding:10px 14px;border:1px solid var(--ca-line);border-radius:var(--ca-radius-s);background:var(--ca-mist);color:var(--ca-ink);font:inherit}
@media (max-width:700px){.ca-bcards{grid-template-columns:1fr}.ca-bcard-main{padding:16px 16px 8px;gap:14px}.ca-bcard-av{width:46px;height:46px;font-size:17px}.ca-bcard-links{padding:0 16px 10px 76px}.ca-addbiz{padding:18px}}
`;

// ─── Results ─────────────────────────────────────────────────────────────────

export function contentResultsPage(shell: Shell, d: ContentAreaData): string {
  const b = shell.brand!;
  const live = groups(b, d).live;
  return layout(shell, 'Results', `<div class="ca-col"><header><h1 class="ca-h1">Results</h1><p class="ca-lede">How many people read your articles will show here once we can count visits to your website. We do not count readers yet, so you will not see guessed numbers.</p></header>
<section aria-labelledby="ca-live"><h2 id="ca-live" class="ca-h2">Live on your website</h2><p class="ca-sub">${live.length ? `${plural(live.length, 'article is', 'articles are')} live. Open one to see it on your website.` : 'Nothing is live yet. Articles appear here once they go out.'}</p>
${live.length ? `<ul class="ca-panel ca-rows">${live.map((i) => `<li class="ca-row"><a class="ca-row-main" href="${e(i.href)}">${picture(i, 'ca-row-pic')}<span class="ca-row-text"><span class="ca-row-title">${e(i.title)}</span><span class="ca-row-line">${e(i.line)}</span></span>${chevron}</a></li>`).join('')}</ul>` : ''}</section>
<p class="ca-quiet-links">Meanwhile you can see how your social campaigns are doing in <a href="${e(`/portal/campaign-journey?brand=${b.id}`)}">Campaign results</a>.</p></div>`, `<style>${PAGE_CSS}</style>`);
}

// ─── The switch ──────────────────────────────────────────────────────────────

/** The page where an owner switches the new look on or off for this browser. */
export function lookPage(csrf: string, on: boolean, back: string, brands: readonly Brand[]): string {
  const form = (look: 'new' | 'old', label: string, cls: string) => `<form method="post" action="${SEO_BLOG_BASE}/look">${csrfField(csrf)}<input type="hidden" name="look" value="${look}"><input type="hidden" name="back" value="${e(back)}"><button type="submit" class="${cls}"${cls === 'ca-btn' ? ' data-primary' : ''}>${label}</button></form>`;
  return `<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark"><title>Try the new look</title><style>${CONTENT_AREA_TOKENS}${PAGE_CSS}
body{margin:0;background:var(--ca-mist);color:var(--ca-ink);font-family:var(--ca-font-body);line-height:1.5}.ca-look{max-width:620px;margin:0 auto;padding:56px 20px;display:grid;gap:22px}
.ca-look a{color:var(--ca-link);font-weight:600}.ca-look :focus-visible{outline:3px solid var(--ca-focus);outline-offset:3px}.ca-look form{margin:0}.ca-look ul{margin:0;padding-left:1.2em}</style></head>
<body><main class="ca-look"><h1 class="ca-h1">${on ? 'You are trying the new look' : 'Try the new look'}</h1>
<p class="ca-lede">We are trying a calmer look for your content area: one place for what needs you, a simple calendar and your articles as a list. Only the look changes. Your articles, dates and settings stay exactly as they are, and you can switch back at any time.</p>
${on ? `${brands.length ? `<p>Open a business:</p><ul>${brands.map((x) => `<li><a href="${e(`${SEO_BLOG_BASE}/b/${x.id}/overview`)}">${e(x.name)}</a></li>`).join('')}</ul>` : ''}${form('old', 'Back to the old look', 'ca-btn-quiet')}` : `${form('new', 'Try the new look', 'ca-btn')}<p class="ca-sub">This only changes what you see in this browser.</p>`}
<p><a href="${SEO_BLOG_BASE}">Back to your businesses</a></p></main></body></html>`;
}

const PAGE_CSS = `
.ca-col{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:32px}.ca-col.ca-wide{max-width:1040px;gap:20px}
.ca-col a{color:var(--ca-link)}
.ca-h1{margin:0;font:var(--ca-weight-display) var(--ca-size-h1)/1.08 var(--ca-font-display);letter-spacing:-.02em;color:var(--ca-ink)}
.ca-lede{margin:8px 0 0;font-size:17px;line-height:1.5;color:var(--ca-muted);max-width:640px}
.ca-h2{margin:0;font:var(--ca-weight-display) var(--ca-size-h2)/1.2 var(--ca-font-display);letter-spacing:-.01em;color:var(--ca-ink)}
.ca-h3{margin:0;font:700 16px/1.3 var(--ca-font-body)}
.ca-sub{margin:4px 0 14px;font-size:15px;color:var(--ca-muted)}
.ca-grow{flex:1}
.ca-btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:56px;padding:0 30px;border:0;border-radius:var(--ca-radius-pill);background:var(--ca-amber);color:var(--ca-on-amber)!important;font:700 17px/1 var(--ca-font-body);text-decoration:none;cursor:pointer;white-space:nowrap}
.ca-btn:hover{filter:brightness(1.04)}.ca-btn-sm{min-height:46px;padding:0 22px;font-size:15px}
.ca-btn-2{display:inline-flex;align-items:center;min-height:46px;padding:0 20px;border-radius:var(--ca-radius-pill);border:1px solid var(--ca-on-deep-line);color:var(--ca-on-deep)!important;font-weight:600;text-decoration:none}
.ca-btn-quiet{appearance:none;display:inline-flex;align-items:center;min-height:40px;padding:0 16px;border-radius:var(--ca-radius-pill)!important;border:1px solid var(--ca-link)!important;background:transparent!important;color:var(--ca-link)!important;font:600 14px/1 var(--ca-font-body);cursor:pointer}
.ca-panel{margin:0;padding:6px 20px;border-radius:var(--ca-radius-l);background:var(--ca-surface);box-shadow:var(--ca-shadow);list-style:none}
.ca-empty{padding:18px 20px;color:var(--ca-muted)}
.ca-hero{display:flex;align-items:center;gap:28px;padding:36px;border-radius:var(--ca-radius-xl);background:var(--ca-hero);color:var(--ca-on-deep);box-shadow:var(--ca-shadow);overflow:hidden;--ca-focus:var(--ca-focus-on-deep)}
.ca-hero-text{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:14px}
.ca-tag{margin:0;display:inline-flex;align-items:center;gap:8px;min-height:28px;padding:0 12px;border-radius:var(--ca-radius-pill);border:1px solid rgba(255,255,255,.3);font-weight:600;font-size:13px;color:var(--ca-on-deep-2)}.ca-tag::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--ca-amber)}.ca-tag-calm::before{background:var(--ca-on-deep-2)}
.ca-hero-h{margin:0;font:var(--ca-weight-display) var(--ca-size-hero)/1.1 var(--ca-font-display);letter-spacing:-.02em;color:var(--ca-on-deep)}
.ca-hero-p{margin:0;font-size:17px;line-height:1.5;color:var(--ca-on-deep-2);max-width:520px}
.ca-hero .ca-btn{margin-top:8px}.ca-hero-form{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;margin:0}.ca-hero-form .ca-note{color:var(--ca-on-deep-2);font-size:14px}
.ca-hero-link{color:var(--ca-on-deep)!important;font-weight:700;text-decoration:underline;text-underline-offset:3px}
.ca-pic{display:block;aspect-ratio:3/2;overflow:hidden;flex:none;border-radius:var(--ca-radius-s);background:var(--ca-glow)}.ca-pic img{display:block;width:100%;height:100%;object-fit:cover}
.ca-pic-none{display:grid;place-items:center;color:var(--ca-muted);background:linear-gradient(135deg,var(--ca-glow),var(--ca-mist))}
.ca-hero-art{position:relative;width:300px;height:190px;flex:none}
.ca-hero-pic{position:absolute;width:210px;border-radius:var(--ca-radius-m);border:3px solid rgba(255,255,255,.92);box-shadow:0 16px 30px -12px rgba(0,0,0,.55)}
.ca-p1{left:0;top:40px;z-index:3}.ca-p2{left:46px;top:20px;z-index:2}.ca-p3{left:90px;top:0;z-index:1}
.ca-hero-art-1 .ca-p1{top:10px;left:40px;width:240px}.ca-hero-art-2 .ca-p1{top:30px}.ca-hero-art-2 .ca-p2{left:80px;top:0}
.ca-rows{list-style:none}
.ca-rows>li+li{border-top:1px solid var(--ca-line)}
.ca-wk,.ca-row-main{display:flex;align-items:center;gap:16px;padding:14px 0;text-decoration:none;color:var(--ca-ink)!important;border-radius:var(--ca-radius-s)}
.ca-wk:hover .ca-row-title,.ca-row-main:hover .ca-row-title{text-decoration:underline;text-underline-offset:3px}
.ca-wk-date{width:54px;height:58px;flex:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border-radius:14px;background:var(--ca-glow)}.ca-wk-date b{font-weight:600;font-size:12px;color:var(--ca-muted)}.ca-wk-date i{font:var(--ca-weight-display) 20px/1 var(--ca-font-display);font-style:normal}
.ca-wk-pic,.ca-row-pic{width:104px}
.ca-row-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.ca-row-title{font-weight:600;font-size:17px;line-height:1.3;overflow-wrap:anywhere}
.ca-row-line{font-size:15px;line-height:1.4;color:var(--ca-muted);overflow-wrap:anywhere}
.ca-row-ex{font-size:14px;line-height:1.4;color:var(--ca-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ca-chip{flex:none;display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:0 12px;border-radius:var(--ca-radius-pill);background:var(--ca-glow);font-weight:600;font-size:13px}
.ca-chip-live::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--ca-link)}
.ca-chev{color:var(--ca-muted)}
.ca-row-act{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:-4px 0 14px 120px}.ca-note{font-size:13px;color:var(--ca-muted)}.ca-link{font-weight:600}
.ca-autocard{display:none;align-items:center;gap:14px;padding:16px 20px;border-radius:var(--ca-radius-l);background:var(--ca-glow)}.ca-autocard p{margin:2px 0 0;font-size:15px;color:var(--ca-ink)}.ca-autocard>div{flex:1}.ca-autocard a{font-weight:700}
.ca-auto-badge{width:38px;height:38px;flex:none;display:grid;place-items:center;border-radius:50%;background:var(--ca-deep);color:var(--ca-amber)}
.ca-group-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:0 4px 12px}.ca-group-head .ca-h2{font-size:20px}
.ca-gcount{min-width:26px;height:24px;padding:0 9px;display:grid;place-items:center;border-radius:var(--ca-radius-pill);background:var(--ca-glow);font-weight:700;font-size:13px}.ca-gcount-needs{background:var(--ca-amber);color:var(--ca-on-amber)}
.ca-empty-big{padding:32px;display:grid;gap:12px;justify-items:start}.ca-empty-big p{margin:0;color:var(--ca-muted)}
.ca-cal-head{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
.ca-month-nav{display:flex;gap:8px}.ca-mn{width:40px;height:40px;display:grid;place-items:center;border-radius:50%;background:var(--ca-surface);box-shadow:var(--ca-shadow);color:var(--ca-ink)!important;font-size:22px;text-decoration:none}
.ca-autoline{margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:14px;padding:12px 22px 12px 12px;border-radius:var(--ca-radius-l);background:var(--ca-glow);font-size:15px;line-height:1.4}.ca-autoline a{font-weight:700}
.ca-cal{padding:16px;border-radius:var(--ca-radius-l);background:var(--ca-surface);box-shadow:var(--ca-shadow)}
.ca-dow,.ca-days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}.ca-dow{margin-bottom:8px}.ca-dow span{padding:4px 8px;font-weight:600;font-size:13px;color:var(--ca-muted)}
.ca-days{list-style:none;margin:0;padding:0}
.ca-day{min-height:128px;min-width:0;display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:14px;background:var(--ca-mist)}.ca-day.ca-out{background:transparent}.ca-day.ca-today{box-shadow:inset 0 0 0 2px var(--ca-link)}
.ca-dnum{margin:0;display:flex;align-items:center;gap:6px;min-height:20px;font:700 14px/1 var(--ca-font-body)}.ca-out .ca-dnum{font-weight:500;color:var(--ca-muted)}
.ca-today-tag{padding:4px 8px;border-radius:var(--ca-radius-pill);background:var(--ca-deep);color:var(--ca-on-deep);font:700 11px/1 var(--ca-font-body)}
.ca-cal-item{display:flex;flex-direction:column;gap:5px;min-width:0;text-decoration:none;color:var(--ca-ink)!important;border-radius:var(--ca-radius-xs)}
.ca-cal-item+.ca-cal-item{margin-top:6px}
.ca-cal-pic,.ca-slot{width:100%;border-radius:var(--ca-radius-xs)}
.ca-slot{display:grid;place-items:center;aspect-ratio:3/2;color:var(--ca-muted)}.ca-slot-writing,.ca-slot-topic{background:var(--ca-glow)}.ca-slot-fill{background:var(--ca-surface);border:1.5px dashed var(--ca-muted);color:var(--ca-link)}.ca-slot-free{border:1.5px dashed var(--ca-line);background:transparent}
.ca-st{font-weight:600;font-size:12px;line-height:1.2;color:var(--ca-muted)}.ca-st-live::before{content:"";display:inline-block;width:7px;height:7px;margin-right:5px;border-radius:50%;background:var(--ca-link)}
.ca-st-going{color:var(--ca-ink)}.ca-st-needs{align-self:flex-start;display:inline-flex;align-items:center;min-height:20px;padding:0 8px;border-radius:var(--ca-radius-pill);background:var(--ca-amber);color:var(--ca-on-amber);font-weight:700;font-size:11px}
.ca-cal-title{font-size:12px;line-height:1.3;color:var(--ca-ink);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere}
.ca-cal-item:hover .ca-cal-title{text-decoration:underline}
.ca-agenda{display:none}.ca-agenda ol{list-style:none;margin:0;padding:6px 16px;border-radius:var(--ca-radius-l);background:var(--ca-surface);box-shadow:var(--ca-shadow)}
.ca-ag-day{display:flex;gap:14px;padding:14px 0}.ca-ag-day+.ca-ag-day{border-top:1px solid var(--ca-line)}
.ca-ag-date{margin:0;width:54px;flex:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:8px 0;border-radius:14px;background:var(--ca-glow);font-size:12px;height:fit-content}.ca-ag-date b{font-weight:600;color:var(--ca-muted)}.ca-ag-date i{font:var(--ca-weight-display) 20px/1 var(--ca-font-display);font-style:normal}.ca-ag-date .ca-today-tag{font-size:10px;padding:3px 6px}
.ca-ag-items{flex:1;min-width:0;display:grid;gap:12px}
.ca-ag-items .ca-cal-item{display:grid;grid-template-columns:96px minmax(0,1fr);grid-template-rows:auto 1fr;column-gap:12px;row-gap:4px;align-items:start}.ca-ag-items .ca-cal-item+.ca-cal-item{margin-top:0}
.ca-ag-items .ca-cal-pic,.ca-ag-items .ca-slot{grid-row:1/3;width:96px}.ca-ag-items .ca-cal-title{font-size:15px;font-weight:600;-webkit-line-clamp:3}.ca-ag-items .ca-st{grid-column:2;align-self:start;justify-self:start}
.ca-quiet-links{margin:0;font-size:14px;color:var(--ca-muted)}.ca-quiet-links a{font-weight:600}
@media (max-width:700px){
.ca-col{gap:26px}.ca-h1{font-size:var(--ca-size-h1-phone)}.ca-lede{font-size:16px}
.ca-hero{flex-direction:column;align-items:stretch;gap:16px;padding:24px 20px;border-radius:var(--ca-radius-l)}
.ca-hero-text{display:contents}.ca-hero .ca-tag{align-self:flex-start}.ca-hero-h{font-size:28px}.ca-hero-p{font-size:16px}.ca-hero-art{order:3}.ca-hero .ca-btn{order:4;margin:0;width:100%}.ca-hero .ca-btn-2{order:4;justify-content:center}
.ca-hero-art{width:100%;height:auto;display:flex}.ca-hero-pic{position:relative!important;left:auto!important;top:auto!important;flex:1;width:auto!important;min-width:0;border-width:2px;border-radius:var(--ca-radius-s)}.ca-hero-pic+.ca-hero-pic{margin-left:-22px}
.ca-panel{padding:4px 14px}.ca-wk,.ca-row-main{gap:12px}.ca-wk-date,.ca-chip{display:none}.ca-wk-pic,.ca-row-pic{width:84px}.ca-row-title{font-size:16px}.ca-row-ex{display:none}.ca-chev{display:none}
.ca-row-act{margin:-4px 0 14px 96px;min-width:0;overflow-wrap:anywhere}
.ca-btn{white-space:normal;text-align:center;line-height:1.25;padding:12px 24px}
.ca-group-head .ca-btn{width:100%}.ca-cal-head .ca-btn{width:100%}.ca-autoline{display:grid;grid-template-columns:auto 1fr;border-radius:var(--ca-radius-m);padding:14px}.ca-autoline>a{grid-column:2}.ca-autocard{display:grid;grid-template-columns:auto 1fr;border-radius:var(--ca-radius-m)}.ca-autocard>a{grid-column:2}
.ca-cal{display:none}.ca-agenda{display:block}
}
`;
