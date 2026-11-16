/**
 * Keywords (release 6 of the SEO quality plan, with the traffic-estimate addendum): the eighth place in the new look,
 * between Brand DNA and Calendar (under More on a phone). Read only: no form, no button, no main action.
 *
 * Each row: the phrase; monthly searches with the month they were measured; easier / medium / harder; what the
 * searcher wants; the labelled estimate of what it could bring (only for a phrase measured itself, always with its
 * condition and the word "Estimate"); and its state. The header carries the roll-up line exactly as the addendum
 * words it, and the plain autopilot statement. Every number on this page comes from the stored keyword list; the
 * supplier is never named. Shown only when SEO_BLOG_KEYWORD_POOL is on (the engine says so).
 */

import type { InventoryKeywordPool } from '../seo-blog/keyword-fill.js';
import type { KeywordChoices, StoredKeywordRow } from '../seo-blog/keyword-store-shape.js';
import type { ShortlistRow } from '../seo-blog/keyword-planning.js';
import { difficultyBand, intentLabel, searchesLabel } from '../seo-blog/keyword-pool.js';
import { ESTIMATE_DISCLOSURE, estimateForPhrase, rollupEstimate, type KeywordState, type RollupRow } from '../seo-blog/traffic-estimate.js';
import type { ArticleBrief, Brand, Job } from '../seo-blog/types.js';
import type { ArticleListRow } from './seo-blog-article-view.js';
import { CONTENT_PAGE_CSS } from './content-area-pages.js';
import { layout, type Shell } from './seo-blog-view.js';
import { publishingDays } from './content-area-layout.js';
import { escapeHtml as e } from './ui.js';

export interface KeywordsPageData {
  /** The stored list, or null when it has never been built. */
  readonly pool: InventoryKeywordPool | null;
  readonly choices: KeywordChoices | null;
  readonly briefs: readonly ArticleBrief[];
  readonly articles: readonly ArticleListRow[];
  readonly jobs: readonly Job[];
  /** What autopilot would plan next from the list (the planning shortlist). */
  readonly nextUp: readonly ShortlistRow[];
  readonly now: string;
}

/** The seven states, as the owner reads them. */
export const STATE_LABEL: Record<KeywordState, string> = {
  suggested: 'Suggested', chosen: 'Chosen', being_written: 'Being written', ready: 'Ready', live: 'Live', already_covered: 'Already covered', dismissed: 'Not for us',
};
const STATE_ORDER: readonly KeywordState[] = ['live', 'ready', 'being_written', 'chosen', 'suggested', 'already_covered', 'dismissed'];

/** The brief whose measured primary phrase is this phrase (one article per phrase). */
function briefFor(phrase: string, briefs: readonly ArticleBrief[]): ArticleBrief | null {
  return briefs.find((b) => b.seo?.primary.phrase === phrase && !['omitted', 'skipped'].includes(b.status)) ?? null;
}

/** A phrase's state, derived (only "Not for us" is stored, as the owner's choice). */
export function keywordState(row: Pick<StoredKeywordRow, 'phrase' | 'ownPosition'>, d: Pick<KeywordsPageData, 'briefs' | 'articles' | 'choices'>): KeywordState {
  if (d.choices?.dismissed.some((x) => x.phrase === row.phrase)) return 'dismissed';
  const brief = briefFor(row.phrase, d.briefs);
  if (brief) {
    const article = d.articles.find((a) => a.article.briefId === brief.id || a.article.id === brief.articleId)?.article;
    if (article?.delivery === 'published') return 'live';
    if (brief.status === 'generated') return 'ready';
    if (brief.status === 'generating') return 'being_written';
    if (brief.status === 'accepted') return 'chosen';
  }
  if (typeof row.ownPosition === 'number' && row.ownPosition >= 1 && row.ownPosition <= 10) return 'already_covered';
  return 'suggested';
}

/** The page-level state. */
export type KeywordsPageState = 'not_built' | 'building' | 'no_data' | 'thin' | 'measured';
export function keywordsPageState(d: Pick<KeywordsPageData, 'pool' | 'jobs'>): KeywordsPageState {
  const building = d.jobs.some((j) => j.kind === 'inventory' && j.payload.keywordFill && ['queued', 'running'].includes(j.state));
  if (!d.pool || !d.pool.builtAt) return building ? 'building' : 'not_built';
  if (!d.pool.rows.length || d.pool.state === 'no_data') return 'no_data';
  return d.pool.rows.some((r) => r.basis === 'measured' && r.searches !== null) ? 'measured' : 'thin';
}

const NO_DATA = 'We could not find search numbers for your niche yet. That is common for specialist and local businesses. We will still write about the questions your customers ask, and we will mark those "no search number yet".';

/** The plain autopilot statement, from the business's own settings. */
export function autopilotStatement(brand: Brand, nextUp: number): string {
  const s = brand.settings;
  if (s.pauseAll) return 'Publishing is paused. Nothing is written or goes out until you switch it back on in Settings.';
  if (!s.ongoingProduction) return 'Autopilot is off. Nothing is written until you choose.';
  if (!nextUp) return 'Autopilot is on. There is nothing lined up from your keywords yet.';
  const these = nextUp === 1 ? 'this one' : `these ${nextUp}`;
  if (!s.autoAcceptPlans) return `Autopilot is on. We have lined up ${these}. Say yes to start.`;
  return `Autopilot is on. If you do not choose, we will write ${these} next to fill ${publishingDays(s.cadence.weekdays, s.cadence.localTime)}.`;
}

function rollupRows(d: KeywordsPageData): RollupRow[] {
  const rows: RollupRow[] = [];
  for (const b of d.briefs) {
    if (!b.seo || ['omitted', 'skipped'].includes(b.status)) continue;
    const state = keywordState({ phrase: b.seo.primary.phrase, ownPosition: null }, d);
    rows.push({ articleKey: b.id, state, primary: { basis: b.seo.primary.basis, searches: b.seo.primary.searches } });
  }
  return rows;
}

/** The roll-up sentence: what is chosen; with nothing chosen and autopilot on, what autopilot will write next. */
export function rollupLine(brand: Brand, d: KeywordsPageData): string | null {
  const chosen = rollupEstimate(rollupRows(d), 'chosen');
  if (chosen.sentence) return chosen.sentence;
  if (!brand.settings.ongoingProduction || brand.settings.pauseAll || !d.nextUp.length) return null;
  return rollupEstimate(d.nextUp.map((r) => ({ articleKey: r.id, state: 'chosen' as const, primary: { basis: r.basis, searches: r.searches } })), 'autopilot').sentence;
}

function rowHtml(row: StoredKeywordRow, state: KeywordState, next: ShortlistRow | undefined): string {
  const band = difficultyBand(row.rankingDifficulty);
  const want = intentLabel(row.intent);
  const estimate = estimateForPhrase({ basis: row.basis, searches: row.searches });
  const estimateLine = estimate.kind === 'none' ? (estimate.notice ? `<p class="kw-est kw-none">${e(estimate.notice)}.</p>` : '') : `<p class="kw-est">${e(estimate.sentence)}</p>`;
  return `<li class="kw-row kw-${state}"><div class="kw-head"><h3 class="kw-phrase">${e(row.phrase)}</h3><span class="kw-state">${e(STATE_LABEL[state])}</span>${next ? '<span class="kw-next">Next up</span>' : ''}</div>
<p class="kw-searches">${e(searchesLabel(row.basis, row.basis === 'parent_phrase' ? row.parentSearches : row.searches, row.measuredMonth))}</p>
<dl class="kw-facts"><div><dt>How hard</dt><dd><span class="kw-band kw-${band.band}">${e(band.label)}</span></dd></div><div><dt>What the searcher wants</dt><dd>${e(want?.label ?? 'Not known yet')}</dd></div></dl>
${estimateLine}${next ? `<p class="kw-why">${e(next.why)}</p>` : ''}</li>`;
}

export function contentKeywordsPage(shell: Shell, brand: Brand, d: KeywordsPageData): string {
  const state = keywordsPageState(d);
  const nextIds = new Map(d.nextUp.map((r) => [r.phrase, r]));
  const rows = (d.pool?.rows ?? []).map((r) => ({ r, state: keywordState(r, d) }))
    .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || Number(nextIds.has(b.r.phrase)) - Number(nextIds.has(a.r.phrase)) || b.r.opportunity - a.r.opportunity || (a.r.phrase < b.r.phrase ? -1 : 1));
  const shown = rows.filter((x) => x.state !== 'dismissed');
  const dismissed = d.choices?.dismissed ?? [];
  const roll = state === 'measured' || state === 'thin' ? rollupLine(brand, d) : null;
  const intro = state === 'not_built' ? '<p class="kw-empty">We have not built your keyword list yet. It is built from your website and your Brand DNA.</p>'
    : state === 'building' ? '<p class="kw-empty" role="status">We are building your keyword list. This page fills in once it is ready.</p>'
      : state === 'no_data' ? `<p class="kw-empty">${e(NO_DATA)}</p>`
        : state === 'thin' ? `<p class="kw-note">${e(NO_DATA)}</p>` : '';
  const header = `<header><h1 class="ca-h1">Keywords</h1><p class="ca-lede">The searches that matter to your business, how many people make them each month and how hard each one is to reach.</p></header>`;
  const summary = `<section class="kw-summary" aria-label="Summary">${roll ? `<p class="kw-roll">${e(roll)}</p><details class="kw-how"><summary>How we work this out</summary><p>${e(ESTIMATE_DISCLOSURE)}</p></details>` : ''}<p class="kw-auto">${e(autopilotStatement(brand, d.nextUp.length))}</p></section>`;
  const list = shown.length ? `<section aria-labelledby="kw-list-h"><h2 id="kw-list-h" class="ca-h2">Your keywords</h2><p class="ca-sub">${shown.length} ${shown.length === 1 ? 'phrase' : 'phrases'}, the ones in progress first.</p><ul class="kw-list">${shown.map((x) => rowHtml(x.r, x.state, nextIds.get(x.r.phrase))).join('')}</ul></section>` : '';
  const folded = dismissed.length ? `<details class="kw-fold"><summary>Not for us (${dismissed.length})</summary><ul class="kw-plain">${dismissed.map((x) => `<li>${e(x.phrase)}</li>`).join('')}</ul></details>` : '';
  return layout({ ...shell, preview: { ...shell.preview!, place: 'keywords' } }, 'Keywords', `<div class="ca-col">${header}${summary}${intro}${list}${folded}</div>`, `<style>${CONTENT_PAGE_CSS}${KEYWORDS_CSS}</style>`);
}

const KEYWORDS_CSS = `
.kw-summary{display:grid;gap:10px;padding:18px 20px;border-radius:var(--ca-radius-l);background:var(--ca-surface);box-shadow:var(--ca-shadow)}
.kw-summary p{margin:0}.kw-roll{font-size:17px;font-weight:600;color:var(--ca-ink)}.kw-auto{color:var(--ca-muted)}
.kw-how>summary{cursor:pointer;font-weight:600;color:var(--ca-link);min-height:24px;padding:4px 0}.kw-how p{margin:6px 0 0;color:var(--ca-muted);max-width:680px}
.kw-empty,.kw-note{margin:0;padding:18px 20px;border-radius:var(--ca-radius-l);background:var(--ca-surface);color:var(--ca-muted)}
.kw-list{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.kw-row{padding:16px 20px;border-radius:var(--ca-radius-l);background:var(--ca-surface);box-shadow:var(--ca-shadow);display:grid;gap:6px;min-width:0}
.kw-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}
.kw-phrase{margin:0;font:700 17px/1.3 var(--ca-font-body);color:var(--ca-ink);overflow-wrap:anywhere;flex:1 1 220px}
.kw-state,.kw-next,.kw-band{display:inline-flex;align-items:center;min-height:24px;padding:0 10px;border-radius:var(--ca-radius-pill);font-size:13px;font-weight:700;border:1px solid var(--ca-line);color:var(--ca-ink)}
.kw-next{border-color:var(--ca-link);color:var(--ca-link)}
.kw-live .kw-state,.kw-ready .kw-state{border-color:var(--ca-ok);color:var(--ca-ok)}
.kw-searches{margin:0;color:var(--ca-ink)}
.kw-facts{display:flex;flex-wrap:wrap;gap:6px 22px;margin:0}.kw-facts div{display:flex;gap:8px;align-items:center}.kw-facts dt{color:var(--ca-muted);font-size:14px}.kw-facts dd{margin:0;font-weight:600}
.kw-easier{border-color:var(--ca-ok);color:var(--ca-ok)}.kw-medium{border-color:var(--ca-warn);color:var(--ca-warn)}.kw-harder{border-color:var(--ca-bad);color:var(--ca-bad)}
.kw-est{margin:0;color:var(--ca-ink)}.kw-none{color:var(--ca-muted)}.kw-why{margin:0;color:var(--ca-muted);font-size:14px}
.kw-fold>summary{cursor:pointer;font-weight:600;color:var(--ca-link);padding:6px 0}.kw-plain{margin:6px 0 0;padding-left:1.2em;color:var(--ca-muted)}
@media(max-width:600px){.kw-row,.kw-summary{padding:14px 16px}.kw-facts{gap:4px 16px}}
`;
