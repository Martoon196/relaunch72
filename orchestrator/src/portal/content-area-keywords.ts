/**
 * Keywords (release 6 of the SEO quality plan, with the traffic-estimate addendum): the eighth place in the new look,
 * between Brand DNA and Calendar (under More on a phone). Read only: no form, no button, no main action.
 *
 * Each row: the phrase; monthly searches with the month they were measured; easier / medium / harder; what the
 * searcher wants; a short labelled estimate of what it could bring (only for a phrase measured itself within 90 days,
 * always with its condition and the word "Estimate"); and its state. The header carries the full estimate sentence
 * once, the roll-up line for chosen keywords exactly as the addendum words it, and the plain autopilot statement.
 *
 * Only what is bound or queued is promised: a keyword shows as Chosen, Being written, Ready or Live only when an
 * article was planned for it by id; phrases autopilot may consider are never marked "next up" or promised. A row
 * older than 90 days shows no number and no estimate; a list measured for another country is not shown as this
 * business's. Every number on this page comes from the stored keyword list; the supplier is never named. Shown only
 * when SEO_BLOG_KEYWORD_POOL is on (the engine says so).
 */

import { poolInMarket, type InventoryKeywordPool, type KeywordPoolRead } from '../seo-blog/keyword-fill.js';
import { freshness, type KeywordChoices, type StoredKeywordRow } from '../seo-blog/keyword-store-shape.js';
import type { ShortlistRow } from '../seo-blog/keyword-planning.js';
import { difficultyBand, intentLabel, monthLabel } from '../seo-blog/keyword-pool.js';
import { ESTIMATE_DISCLOSURE, estimateForPhrase, formatCount, rollupEstimate, type KeywordState, type PhraseDemand, type RollupRow } from '../seo-blog/traffic-estimate.js';
import { supportedMarketForLocale } from '../keyword/dataforseo-labs.js';
import type { ArticleBrief, Brand, Job } from '../seo-blog/types.js';
import type { ArticleListRow } from './seo-blog-article-view.js';
import { CONTENT_PAGE_CSS } from './content-area-pages.js';
import { layout, type Shell } from './seo-blog-view.js';
import { publishingDays } from './content-area-layout.js';
import { escapeHtml as e } from './ui.js';

export interface KeywordsPageData {
  /** The stored list, or null when it has never been built or cannot be read. */
  readonly pool: InventoryKeywordPool | null;
  /** What the one shape check found ('ok' when absent from older callers). A damaged or newer-shaped list shows the honest empty state. */
  readonly listStatus?: KeywordPoolRead['status'];
  readonly choices: KeywordChoices | null;
  readonly briefs: readonly ArticleBrief[];
  readonly articles: readonly ArticleListRow[];
  readonly jobs: readonly Job[];
  /** What autopilot would consider next from the list (the planning shortlist). Never promised or marked on a row. */
  readonly nextUp: readonly ShortlistRow[];
  readonly now: string;
}

/** The seven states, as the owner reads them. */
export const STATE_LABEL: Record<KeywordState, string> = {
  suggested: 'Suggested', chosen: 'Chosen', being_written: 'Being written', ready: 'Ready', live: 'Live', already_covered: 'Already covered', dismissed: 'Not for us',
};
const STATE_ORDER: readonly KeywordState[] = ['live', 'ready', 'being_written', 'chosen', 'suggested', 'already_covered', 'dismissed'];

/** The owner's dismissed phrases, read defensively (a damaged choices record never breaks the page). */
function dismissedList(choices: KeywordChoices | null | undefined): { phrase: string }[] {
  const list = (choices as { dismissed?: unknown } | null | undefined)?.dismissed;
  return Array.isArray(list) ? list.filter((x): x is { phrase: string } => typeof x === 'object' && x !== null && typeof (x as { phrase?: unknown }).phrase === 'string') : [];
}

/** Briefs bound to this phrase as their target (only a target chosen by id; the honest "none" never counts). */
function briefsFor(phrase: string, briefs: readonly ArticleBrief[]): ArticleBrief[] {
  return briefs.filter((b) => b.seo && b.seo.primary.basis !== 'none' && b.seo.primary.phrase === phrase && !['omitted', 'skipped'].includes(b.status));
}

const PROGRESS: readonly KeywordState[] = ['live', 'ready', 'being_written', 'chosen'];
function briefState(brief: ArticleBrief, d: Pick<KeywordsPageData, 'articles'>): KeywordState | null {
  const article = d.articles.find((a) => a.article.briefId === brief.id || a.article.id === brief.articleId)?.article;
  if (article?.delivery === 'published') return 'live';
  if (brief.status === 'generated') return 'ready';
  if (brief.status === 'generating') return 'being_written';
  if (brief.status === 'accepted') return 'chosen';
  return null;
}

/**
 * A phrase's state, derived (only "Not for us" is stored, as the owner's choice). When two articles target one phrase,
 * the furthest along decides (live, then ready, being written, chosen), not whichever happens to be first.
 */
export function keywordState(row: Pick<StoredKeywordRow, 'phrase' | 'ownPosition'>, d: Pick<KeywordsPageData, 'briefs' | 'articles' | 'choices'>): KeywordState {
  if (dismissedList(d.choices).some((x) => x.phrase === row.phrase)) return 'dismissed';
  const states = briefsFor(row.phrase, d.briefs).map((b) => briefState(b, d)).filter((x): x is KeywordState => x !== null);
  const best = PROGRESS.find((p) => states.includes(p));
  if (best) return best;
  if (typeof row.ownPosition === 'number' && row.ownPosition >= 1 && row.ownPosition <= 10) return 'already_covered';
  return 'suggested';
}

/** The number a row may show now: none once measured more than 90 days ago (the plan's freshness rule). */
function currentDemand(basis: PhraseDemand['basis'], searches: number | null, measuredAt: string | null, now: string): PhraseDemand & { readonly expired: boolean } {
  const expired = basis !== 'observed' && basis !== 'none' && (!measuredAt || freshness(measuredAt, now) === 'expired');
  return expired ? { basis: 'none', searches: null, expired } : { basis, searches, expired };
}

/** The page-level state. */
export type KeywordsPageState = 'unreadable' | 'unsupported_country' | 'other_country' | 'not_built' | 'building' | 'no_data' | 'thin' | 'measured';
/** The page-level state. With a business (`locale`), a list measured for another country is never shown as its own. */
export function keywordsPageState(d: Pick<KeywordsPageData, 'pool' | 'jobs' | 'listStatus'>, locale?: string): KeywordsPageState {
  if (d.listStatus === 'damaged' || d.listStatus === 'newer') return 'unreadable';
  if (locale !== undefined) {
    const market = supportedMarketForLocale(locale);
    if (!market) return 'unsupported_country';
    if (d.pool && d.pool.builtAt && !poolInMarket(d.pool, market)) return 'other_country';
  }
  const building = d.jobs.some((j) => j.kind === 'inventory' && j.payload.keywordFill && ['queued', 'running'].includes(j.state));
  if (!d.pool || !d.pool.builtAt) return building ? 'building' : 'not_built';
  if (!d.pool.rows.length || d.pool.state === 'no_data') return 'no_data';
  return d.pool.rows.some((r) => r.basis === 'measured' && r.searches !== null) ? 'measured' : 'thin';
}

const UNREADABLE = 'We cannot show your keyword list just now. Your plans and articles are not affected.';
const UNSUPPORTED = 'Keyword lists are not available for your business\'s country yet.';
const OTHER_COUNTRY = 'Your keyword list was measured for another country, so it is not shown here. It will be measured for your country the next time it is refreshed.';
const NO_DATA = 'We could not find search numbers for your niche yet. That is common for specialist and local businesses. We will still write about the questions your customers ask, and we will mark those "no search number yet".';

/**
 * The plain autopilot statement, from the business's own settings and what is really queued. It never promises that
 * particular keywords will be written: only planned articles are bound to a keyword, and those show on their rows.
 */
export function autopilotStatement(brand: Brand, d: { readonly planning: boolean }): string {
  const s = brand.settings;
  if (s.pauseAll) return 'Publishing is paused. Nothing is written or goes out until you switch it back on in Settings.';
  if (!s.ongoingProduction) return 'Autopilot is off. Nothing is written until you choose.';
  if (d.planning) return 'Autopilot is planning your next articles now. Each keyword an article is planned for will show here.';
  if (!s.autoAcceptPlans) return 'Autopilot is on. When it plans, it suggests articles for you to say yes to. Each keyword you say yes to shows here as Chosen.';
  return `Autopilot is on. When it next plans articles to fill ${publishingDays(s.cadence.weekdays, s.cadence.localTime)}, each keyword it chooses shows here as Chosen.`;
}

/** Whether a planning task is queued or running for this business (what is truly queued). */
function planningQueued(jobs: readonly Job[]): boolean {
  return jobs.some((j) => j.kind === 'plan' && ['queued', 'running'].includes(j.state));
}

/** One row per bound phrase (two articles on one phrase count once, at the furthest state), current numbers only. */
function rollupRows(d: KeywordsPageData, market: { readonly locationCode: number } | null): RollupRow[] {
  const rows = new Map<string, RollupRow>();
  for (const b of d.briefs) {
    if (!b.seo || ['omitted', 'skipped'].includes(b.status)) continue;
    const p = b.seo.primary;
    // An article planned with no measured keyword is said as uncounted, never given a number.
    if (p.basis === 'none') { const state = briefState(b, d); if (state) rows.set(`brief:${b.id}`, { articleKey: `brief:${b.id}`, state, primary: { basis: 'none', searches: null } }); continue; }
    const state = keywordState({ phrase: p.phrase, ownPosition: null }, d);
    // A number measured for another country, or more than 90 days ago, is not counted (it is said as uncounted).
    const demand = market && p.locationCode === market.locationCode ? currentDemand(p.basis, p.searches, p.measuredAt, d.now) : { basis: 'none' as const, searches: null };
    if (!rows.has(`phrase:${p.phrase}`)) rows.set(`phrase:${p.phrase}`, { articleKey: `phrase:${p.phrase}`, state, primary: { basis: demand.basis, searches: demand.searches } });
  }
  return [...rows.values()];
}

/** The roll-up sentence: only keywords that articles are planned for and chosen (bound by id). Null when there are none. */
export function rollupLine(brand: Brand, d: KeywordsPageData): string | null {
  return rollupEstimate(rollupRows(d, supportedMarketForLocale(brand.locale)), 'chosen').sentence;
}

/** The full sentence, said once at the top; each row carries the short form. */
export const ESTIMATE_EXPLAINED = 'Visit figures on each keyword are what it could bring each month if its article reaches the top three on Google. Estimate.';

/** The short form on a row: the range, the condition and the word "Estimate". Null when there is no current measured number. */
export function shortEstimate(demand: PhraseDemand): string | null {
  if (demand.basis === 'measured' && demand.searches === 0) return null;
  const est = estimateForPhrase(demand);
  if (est.kind === 'none') return null;
  return est.kind === 'fewer_than_10' ? 'Fewer than 10 visits a month if top three. Estimate.'
    : `${est.low > 0 ? `About ${formatCount(est.low)} to ${formatCount(est.high)}` : `Up to about ${formatCount(est.high)}`} visits a month if top three. Estimate.`;
}

/** The searches line: the wider phrase is named; a measured 0 is "too few searches to measure"; an old number is not shown. */
function searchesLine(row: StoredKeywordRow, now: string): string {
  const demand = currentDemand(row.basis, row.basis === 'parent_phrase' ? row.parentSearches : row.searches, row.measuredAt, now);
  if (demand.expired) return 'Measured more than three months ago, so no number is shown until it is measured again';
  const when = monthLabel(row.measuredMonth);
  const tail = when ? `, measured ${when}` : '';
  if (row.basis === 'observed' || demand.searches === null) return 'No search number yet';
  if (demand.searches === 0) return `Too few searches to measure${tail}`;
  if (row.basis === 'parent_phrase') return `About ${formatCount(demand.searches)} searches a month for the wider phrase "${row.parent ?? ''}"${tail}`;
  return `About ${formatCount(demand.searches)} searches a month${tail}`;
}

function rowHtml(row: StoredKeywordRow, state: KeywordState, now: string): string {
  const band = difficultyBand(row.rankingDifficulty);
  const want = intentLabel(row.intent);
  const demand = currentDemand(row.basis, row.searches, row.measuredAt, now);
  const short = shortEstimate(demand);
  const estimateLine = short ? `<p class="kw-est">${e(short)}</p>` : row.basis === 'observed' ? '<p class="kw-est kw-none">No search number yet, so no estimate.</p>' : '';
  return `<li class="kw-row kw-${state}"><div class="kw-head"><h3 class="kw-phrase">${e(row.phrase)}</h3><span class="kw-state">${e(STATE_LABEL[state])}</span></div>
<p class="kw-searches">${e(searchesLine(row, now))}</p>
<dl class="kw-facts"><div><dt>How hard</dt><dd><span class="kw-band kw-${band.band}">${e(band.label)}</span></dd></div><div><dt>Wants to</dt><dd>${e(want?.label ?? 'Not known yet')}</dd></div></dl>
${estimateLine}</li>`;
}

export function contentKeywordsPage(shell: Shell, brand: Brand, d: KeywordsPageData): string {
  const state = keywordsPageState(d, brand.locale);
  const ownList = state === 'measured' || state === 'thin' || state === 'no_data';
  const rows = (ownList ? d.pool?.rows ?? [] : []).map((r) => ({ r, state: keywordState(r, d) }))
    .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || b.r.opportunity - a.r.opportunity || (a.r.phrase < b.r.phrase ? -1 : 1));
  const shown = rows.filter((x) => x.state !== 'dismissed');
  const dismissed = dismissedList(d.choices);
  const roll = state === 'measured' || state === 'thin' ? rollupLine(brand, d) : null;
  const intro = state === 'unreadable' ? `<p class="kw-empty">${e(UNREADABLE)}</p>`
    : state === 'unsupported_country' ? `<p class="kw-empty">${e(UNSUPPORTED)}</p>`
    : state === 'other_country' ? `<p class="kw-empty">${e(OTHER_COUNTRY)}</p>` : state === 'not_built' ? '<p class="kw-empty">We have not built your keyword list yet. It is built from your website and your Brand DNA.</p>'
    : state === 'building' ? '<p class="kw-empty" role="status">We are building your keyword list. This page fills in once it is ready.</p>'
      : state === 'no_data' ? `<p class="kw-empty">${e(NO_DATA)}</p>`
        : state === 'thin' ? `<p class="kw-note">${e(NO_DATA)}</p>` : '';
  const header = `<header><h1 class="ca-h1">Keywords</h1><p class="ca-lede">The searches that matter to your business, how many people make them each month and how hard each one is to reach.</p></header>`;
  const estimates = shown.some((x) => shortEstimate(currentDemand(x.r.basis, x.r.searches, x.r.measuredAt, d.now)) !== null);
  const explained = roll || estimates ? `${roll ? `<p class="kw-roll">${e(roll)}</p>` : ''}${estimates ? `<p class="kw-explain">${e(ESTIMATE_EXPLAINED)}</p>` : ''}<details class="kw-how"><summary>How we work this out</summary><p>${e(ESTIMATE_DISCLOSURE)}</p></details>` : '';
  const summary = `<section class="kw-summary" aria-label="Summary">${explained}<p class="kw-auto">${e(autopilotStatement(brand, { planning: planningQueued(d.jobs) }))}</p></section>`;
  const list = shown.length ? `<section aria-labelledby="kw-list-h"><h2 id="kw-list-h" class="ca-h2">Your keywords</h2><p class="ca-sub">${shown.length} ${shown.length === 1 ? 'phrase' : 'phrases'}, the ones in progress first.</p><ul class="kw-list">${shown.map((x) => rowHtml(x.r, x.state, d.now)).join('')}</ul></section>` : '';
  const folded = dismissed.length ? `<details class="kw-fold"><summary>Not for us (${dismissed.length})</summary><ul class="kw-plain">${dismissed.map((x) => `<li>${e(x.phrase)}</li>`).join('')}</ul></details>` : '';
  return layout({ ...shell, preview: { ...shell.preview!, place: 'keywords' } }, 'Keywords', `<div class="ca-col">${header}${summary}${intro}${list}${folded}</div>`, `<style>${CONTENT_PAGE_CSS}${KEYWORDS_CSS}</style>`);
}

const KEYWORDS_CSS = `
.kw-summary{display:grid;gap:10px;padding:18px 20px;border-radius:var(--ca-radius-l);background:var(--ca-surface);box-shadow:var(--ca-shadow)}
.kw-summary p{margin:0}.kw-roll{font-size:17px;font-weight:600;color:var(--ca-ink)}.kw-auto{color:var(--ca-muted)}
.kw-how>summary{cursor:pointer;font-weight:600;color:var(--ca-link);min-height:24px;padding:4px 0}.kw-how p{margin:6px 0 0;color:var(--ca-muted);max-width:680px}
.kw-empty,.kw-note{margin:0;padding:18px 20px;border-radius:var(--ca-radius-l);background:var(--ca-surface);color:var(--ca-muted)}
.kw-list{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.kw-row{padding:16px 20px;border-radius:var(--ca-radius-l);background:var(--ca-surface);box-shadow:var(--ca-shadow);display:grid;gap:6px;min-width:0;overflow-wrap:anywhere}
.kw-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}
.kw-phrase{margin:0;font:700 17px/1.3 var(--ca-font-body);color:var(--ca-ink);overflow-wrap:anywhere;flex:1 1 220px}
.kw-state,.kw-next,.kw-band{display:inline-flex;align-items:center;min-height:24px;padding:0 10px;border-radius:var(--ca-radius-pill);font-size:13px;font-weight:700;border:1px solid var(--ca-line);color:var(--ca-ink)}
.kw-next{border-color:var(--ca-link);color:var(--ca-link)}
.kw-live .kw-state,.kw-ready .kw-state{border-color:var(--ca-ok);color:var(--ca-ok)}
.kw-searches{margin:0;color:var(--ca-ink)}
.kw-facts{display:flex;flex-wrap:wrap;gap:6px 22px;margin:0}.kw-facts div{display:flex;gap:8px;align-items:center}.kw-facts dt{color:var(--ca-muted);font-size:14px}.kw-facts dd{margin:0;font-weight:600}
.kw-easier{border-color:var(--ca-ok);color:var(--ca-ok)}.kw-medium{border-color:var(--ca-warn);color:var(--ca-warn)}.kw-harder{border-color:var(--ca-bad);color:var(--ca-bad)}
.kw-est{margin:0;color:var(--ca-ink)}.kw-none{color:var(--ca-muted)}.kw-explain{color:var(--ca-muted)}
.kw-fold>summary{cursor:pointer;font-weight:600;color:var(--ca-link);padding:6px 0}.kw-plain{margin:6px 0 0;padding-left:1.2em;color:var(--ca-muted);overflow-wrap:anywhere}
@media(max-width:600px){.kw-row,.kw-summary{padding:14px 16px}.kw-row{gap:4px}.kw-phrase{font-size:16px;flex-basis:160px}.kw-searches,.kw-est{font-size:14px}.kw-facts{gap:2px 14px}.kw-facts dt{font-size:13px}}
`;
