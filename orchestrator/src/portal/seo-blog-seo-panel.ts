/**
 * The SEO report on the article page: what the article is aiming for, how many people search for it (only when that
 * was measured; never estimated), what is really sent to search engines, and our on-page SEO score with each check.
 *
 * Read only. It adds no form and no main (amber) action: every "what to do" is a quiet link to a control that already
 * exists on the page (the picture area, the Google fields in the editor, the rewrite fold). Every value is escaped.
 * The two pieces are wrapped in marker comments so the "page unchanged apart from the panel" proof can lift them out.
 */

import type { Article, ArticleBrief, ArticleVersion, Brand, Destination } from '../seo-blog/types.js';
import { SEO_GROUP_LABELS, seoNextSteps, seoScore, type SeoCheck, type SeoFix, type SeoScore } from '../seo-blog/seo-score.js';
import { SEO_BLOG_BASE } from './seo-blog-view.js';
import { hasSearchTarget } from '../seo-blog/search-requirements.js';
import { escapeHtml as e } from './ui.js';

export const SEO_PANEL_START = '<!--r72-seo-panel-->';
export const SEO_PANEL_END = '<!--/r72-seo-panel-->';

export interface SeoPanelData {
  readonly article: Article;
  readonly articleBrief?: ArticleBrief | null;
  readonly destinations: readonly Omit<Destination, 'sealedCredential'>[];
  readonly publications?: readonly { readonly destinationId: string; readonly state: string }[];
}

const articleBase = (b: Brand, a: Article) => `${SEO_BLOG_BASE}/b/${b.id}/articles/${a.id}`;

/** The canonical address the page shows elsewhere (Google fold, Where it publishes). */
function addressOf(a: Article, v: ArticleVersion): string | null {
  return v.websiteTarget?.target.canonicalUrl ?? a.publishedUrl ?? v.promotionPack?.canonicalUrl ?? null;
}

/** One score per page view: the summary line and the report share it (keyed by the very objects of this render). */
const scored = new WeakMap<ArticleVersion, { readonly b: Brand; readonly d: SeoPanelData; readonly s: SeoScore }>();

/** The scored result for this version, with the site's own addresses for telling internal links from outside ones. */
export function articleSeoScore(b: Brand, d: SeoPanelData, v: ArticleVersion): SeoScore {
  const hit = scored.get(v);
  if (hit && hit.b === b && hit.d === d) return hit.s;
  const self = addressOf(d.article, v);
  const hosts = [b.website, self, d.article.publishedUrl, ...d.destinations.map((x) => x.publicBaseUrl)];
  // The existing quality checks count only when they ran on exactly this version. Issues from an earlier version are
  // passed on as stale: an open must-fix there holds the score down until the checks run again, so the report never
  // shows a high score beside the page's "things to fix" box.
  const ranHere = Boolean(d.article.checks && d.article.checks.versionId === v.id);
  const checkIssues = ranHere ? d.article.checks!.issues : null;
  const staleCheckIssues = !ranHere && d.article.checks ? d.article.checks.issues : null;
  // A brief with a measured target is scored against the phrase the writer was given, not the question; others as before.
  const brief = d.articleBrief && hasSearchTarget(d.articleBrief) ? { ...d.articleBrief, targetQuery: d.articleBrief.seo!.primary.phrase } : d.articleBrief ?? null;
  const s = seoScore(brief, v.body, { siteHosts: hosts, selfUrl: self, checkIssues, staleCheckIssues });
  scored.set(v, { b, d, s });
  return s;
}

const tone = (score: number) => (score >= 80 ? 'sp-hi' : score >= 50 ? 'sp-mid' : 'sp-lo');
function verdict(score: number): string {
  if (score >= 80) return 'Strong. Only small things are left to improve.';
  if (score >= 60) return 'Good, with a few things to improve.';
  if (score >= 40) return 'It needs some work. A few changes would help people find it.';
  return 'It needs work before it can do well in Google.';
}
const SAME_KIND = 'These are the same kind of checks SEO plugins such as Rank Math and Yoast run, plus checks they cannot run. It is our score; their number can differ a little.';

/** One quiet line near the top of the page: the score, and a link that opens the report. */
export function seoSummaryLine(shell: { brand?: Brand | null }, d: SeoPanelData, v: ArticleVersion): string {
  const b = shell.brand!;
  const s = articleSeoScore(b, d, v);
  return `${SEO_PANEL_START}<p class="ap-quiet-line sp-line"><span class="sp-pill ${tone(s.score)}">SEO score ${s.score} out of 100</span> <a href="${e(`${articleBase(b, d.article)}?open=seo#seo`)}">See what it aims for and how to improve it</a></p>${SEO_PANEL_END}`;
}

// ─── The parts ───────────────────────────────────────────────────────────────

const INTENT: Record<string, string> = {
  buy: 'Ready to buy or hire: they are looking for someone to do it for them.',
  compare: 'Comparing options before they choose.',
  learn: 'Learning: they want to understand how something works.',
};

function longDate(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(t));
}
const VISITS = 'How many visits this brings depends on where the page ranks in Google.';

function aimCard(brief: ArticleBrief | null | undefined): string {
  if (!brief) return `<section class="sp-card" aria-labelledby="sp-aim"><h3 id="sp-aim">What this article is aiming for</h3><p>The search phrase is not on record for this article. It was planned before we kept this information.</p><p class="ap-note">The score below still checks everything that does not need the phrase.</p></section>`;
  const phrase = typeof brief.targetQuery === 'string' ? brief.targetQuery.trim() : '';
  const questions = (Array.isArray(brief.relatedQuestions) ? brief.relatedQuestions : []).filter((q) => typeof q === 'string' && q.trim()).slice(0, 12);
  const why = typeof brief.whyFit === 'string' ? brief.whyFit.trim() : '';
  return `<section class="sp-card" aria-labelledby="sp-aim"><h3 id="sp-aim">What this article is aiming for</h3>
<dl class="sp-dl"><dt>The search phrase</dt><dd>${phrase ? `<span class="sp-phrase">${e(phrase)}</span>` : 'Not on record for this article.'}</dd>
<dt>What the searcher wants</dt><dd>${e(INTENT[brief.searchIntent] ?? 'Not on record.')}</dd>
<dt>Why we picked it</dt><dd>${why ? e(why) : 'Not on record.'}</dd>
<dt>Questions people ask about it</dt><dd>${questions.length ? `<ul class="sp-qs">${questions.map((q) => `<li>${e(q)}</li>`).join('')}</ul>` : 'None on record.'}</dd></dl></section>`;
}

function demandCard(brief: ArticleBrief | null | undefined): string {
  const head = '<section class="sp-card" aria-labelledby="sp-demand"><h3 id="sp-demand">How many people search for this</h3>';
  const demand = brief?.demand as ArticleBrief['demand'] | undefined;
  if (demand && demand.kind === 'measured') {
    const volume = typeof demand.volume === 'number' && Number.isFinite(demand.volume) && demand.volume >= 0 ? Math.round(demand.volume) : null;
    const when = typeof demand.retrievedAt === 'string' ? longDate(demand.retrievedAt) : null;
    if (volume !== null) return `${head}<p class="sp-big"><strong>${e(volume.toLocaleString('en-GB'))}</strong> searches a month in Google</p>${when ? `<p class="ap-note">Measured on ${e(when)}.</p>` : ''}<p class="ap-note">${VISITS}</p></section>`;
  }
  return `${head}<p>We do not have search numbers for this phrase yet.</p><p class="ap-note">${VISITS}</p></section>`;
}

/** Where the article goes (its time's website, else the one it went to, else the only connected one). */
function destinationFor(d: SeoPanelData): Omit<Destination, 'sealedCredential'> | null {
  const id = d.article.schedule?.destinationId ?? d.publications?.find((p) => p.state === 'published')?.destinationId ?? null;
  const byId = id ? d.destinations.find((x) => x.id === id) : undefined;
  if (byId) return byId;
  const connected = d.destinations.filter((x) => x.status === 'connected');
  return connected.length === 1 ? connected[0]! : null;
}

function structuredData(d: SeoPanelData): string {
  const type = destinationFor(d)?.type;
  const ours = 'the Google title, the short description, the page address, sharing details for social media, and article details (the kind called BlogPosting): headline, short description, date, language, author, publisher and main picture';
  const faqNote = ' The questions and answers are not marked as a questions block for search engines.';
  if (type === 'wordpress') return `We fill in the Google title, the short description and the sharing details in Rank Math or Yoast when one of them is installed, or in our own WordPress plugin when neither is. That plugin then adds the data for search engines.${faqNote}`;
  if (type === 'content_api') return `We send the title, the Google title, the short description, the page address, the summary, the author and the main picture. Your website’s own templates turn these into the tags and data for search engines, so they are set on your website.${faqNote}`;
  if (type === 'github_static') return `We build the whole page, so it carries ${ours}.${faqNote}`;
  return `When we build the page ourselves (as in “Open it as a web page”), it carries ${ours}. Once a website is connected, what is sent depends on that website.${faqNote}`;
}

function tagsCard(d: SeoPanelData, v: ArticleVersion): string {
  const body = v.body;
  const address = addressOf(d.article, v);
  const target = v.websiteTarget?.target;
  const chosen = target ? target.categoryIds.map((id) => target.categories.find((c) => c.id === id)?.label).filter((x): x is string => Boolean(x)) : [];
  const offersTopics = d.destinations.some((x) => x.status === 'connected' && x.websiteCapability?.protocol === 'v2');
  const topics = chosen.length ? chosen.map((c) => e(c)).join(', ') : offersTopics ? 'None chosen yet. You can choose them in “Where it publishes” below.' : 'None. Your website connection does not offer topics.';
  const author = body.author?.name?.trim();
  const picture = body.image?.url ? `Yes. Its description: ${body.image.alt?.trim() ? `“${e(body.image.alt.trim())}”` : 'none yet'}` : 'None yet.';
  return `<section class="sp-card sp-wide" aria-labelledby="sp-tags"><h3 id="sp-tags">Tags and data for search engines</h3>
<dl class="sp-dl sp-dl-row"><dt>Page address</dt><dd class="sp-url">${e(address ? address : `…/${body.slug}`)}</dd>
<dt>Summary on your blog page</dt><dd>${body.excerpt?.trim() ? e(body.excerpt) : 'None yet.'}</dd>
<dt>Topics on your website</dt><dd>${topics}</dd>
<dt>Tags</dt><dd>None. Articles do not have tags, so we do not send any.</dd>
<dt>Author</dt><dd>${author ? e(author) : 'None set, so your business name is shown as the author.'}</dd>
<dt>Main picture</dt><dd>${picture}</dd>
<dt>Data for search engines</dt><dd>${e(structuredData(d))}</dd></dl>
<p class="sp-foot">The Google title and short description are shown in <a href="#google">How it appears in Google</a>, just below.</p></section>`;
}

/** Where each fix lives on this page, or null when the owner cannot make it now. Nothing here is a new control. */
function fixTarget(fix: SeoFix | null, base: string, v: ArticleVersion, a: Article): [string, string] | null {
  if (!fix) return null;
  const editable = a.delivery !== 'publishing';
  const firstPart = v.body.sections[0]?.id;
  const to: Record<SeoFix, [string, string] | null> = {
    'google-title': editable ? [`${base}?edit=1#google`, 'Edit the Google title'] : null,
    description: editable ? [`${base}?edit=1#google`, 'Edit the short description'] : null,
    address: editable && !a.publishedUrl ? [`${base}?edit=1#google`, 'Edit the page address'] : null,
    'picture-description': editable ? [`${base}?edit=1#google`, 'Edit the picture description'] : null,
    opening: editable ? [`${base}?edit=1#opening`, 'Edit the opening paragraph'] : null,
    headings: editable && firstPart ? [`${base}?edit=1#part-${firstPart}`, 'Edit the sub-headings'] : editable ? [`${base}?open=rewrite#rewrite`, 'Ask for a rewrite'] : null,
    text: editable ? [`${base}?edit=1`, 'Edit the article'] : null,
    links: editable ? [`${base}?edit=1`, 'Edit the article'] : null,
    rewrite: [`${base}?open=rewrite#rewrite`, 'Ask for a rewrite'],
    picture: ['#picture', 'Add a picture'],
    fix: ['#fix', 'Show me what to fix'],
  };
  return to[fix];
}
function fixLink(fix: SeoFix | null, base: string, v: ArticleVersion, a: Article): string {
  const t = fixTarget(fix, base, v, a);
  return t ? ` <a class="sp-fix" href="${e(t[0])}">${e(t[1])}</a>` : '';
}

const MARK: Record<SeoCheck['result'], string> = { pass: 'Done', partly: 'Partly', fail: 'Not yet' };

function checkItem(c: SeoCheck, label: string, base: string, v: ArticleVersion, a: Article): string {
  return `<li class="sp-check sp-${c.result}"><span class="sp-mark" aria-hidden="true"></span><div><p class="sp-name"><span class="sp-group">${e(label)}</span><strong>${e(c.name)}</strong> <span class="sp-tag">${MARK[c.result]}</span></p><p class="sp-found">${e(c.found)}</p>${c.todo ? `<p class="sp-todo"><span class="sp-label">What to do:</span> ${e(c.todo)}${fixLink(c.fix, base, v, a)}</p>` : ''}</div></li>`;
}

const COUNT_WORDS = ['No things', 'One thing', 'Two things', 'Three things', 'Four things', 'Five things'];

/** The lead: the few changes worth most, with the score they would reach together; everything else folded away. */
function leadBlock(s: SeoScore, base: string, v: ArticleVersion, a: Article): string {
  const todo = s.checks.filter((c) => c.result !== 'pass');
  if (!todo.length) return '<p class="sp-sub">Every check passes.</p>';
  // Only changes the owner can make now count towards the headline (never the page address once it is live).
  const next = seoNextSteps(s, 3, (c) => fixTarget(c.fix, base, v, a) !== null);
  const top = next.checks;
  const held = Boolean(s.cap && s.uncapped > s.cap.limit);
  const headline = top.length && next.to > next.from
    ? `${COUNT_WORDS[top.length]} would take this from ${next.from} to ${next.to}`
    : top.length ? `${top.length === 1 ? 'The thing' : `The ${COUNT_WORDS[top.length]!.toLowerCase()}`} that would help most` : 'What is left to improve';
  // A cap from the checks links to what they found, or to where they are run.
  const capLink = s.cap && (s.cap.kind === 'must-fix' || s.cap.kind === 'stale-checks') ? ' <a class="sp-fix" href="#fix">Show me what to fix</a>' : '';
  const capNote = s.cap && (held || next.to >= s.cap.limit) ? `<p class="ap-note sp-cap">${e(s.cap.reason)}${capLink}</p>` : '';
  const rest = todo.filter((c) => !top.includes(c));
  const notYet = rest.filter((c) => c.result === 'fail'), nearly = rest.filter((c) => c.result === 'partly');
  const list = (cs: readonly SeoCheck[]) => cs.map((c) => checkItem(c, SEO_GROUP_LABELS[c.group], base, v, a)).join('');
  return `<h4 class="sp-sub sp-lead">${e(headline)}</h4>${capNote}${top.length ? `<ul class="sp-checks sp-top">${list(top)}</ul>` : ''}
${rest.length ? `<details class="sp-done sp-rest"><summary>Everything else to improve (${rest.length})</summary>${notYet.length ? `<h4 class="sp-sub">Not yet (${notYet.length})</h4><ul class="sp-checks">${list(notYet)}</ul>` : ''}${nearly.length ? `<h4 class="sp-sub">Nearly there (${nearly.length})</h4><ul class="sp-checks">${list(nearly)}</ul>` : ''}</details>` : ''}`;
}

function scoreCard(s: SeoScore, base: string, v: ArticleVersion, a: Article): string {
  const done = s.checks.filter((c) => c.result === 'pass');
  const pts = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  return `<section class="sp-card sp-wide sp-score" aria-labelledby="sp-score"><h3 id="sp-score" class="ap-sr">SEO score</h3>
<div class="sp-head"><div class="sp-dial ${tone(s.score)}" style="--sp-v:${s.score}" role="img" aria-label="SEO score ${s.score} out of 100"><span><b>${s.score}</b><small>out of 100</small></span></div>
<div class="sp-head-text"><p class="sp-verdict">${e(verdict(s.score))}</p><p class="ap-note">SEO score ${s.score} out of 100. ${SAME_KIND}</p>${s.leftOut.length ? `<p class="ap-note">Left out because they cannot be checked for this article: ${e(s.leftOut.join('; '))}. The rest are scored out of 100.</p>` : ''}</div></div>
${leadBlock(s, base, v, a)}
<details class="sp-done sp-parts"><summary>Score by part</summary><ul class="sp-groups">${s.parts.map((g) => `<li><span class="sp-gname">${e(g.label)}</span><span class="sp-bar" aria-hidden="true"><i style="width:${Math.round((g.points * 100) / g.weight)}%"></i></span><span class="sp-gpts">${pts(g.points)} of ${g.weight}</span></li>`).join('')}</ul></details>
${done.length ? `<details class="sp-done"><summary>Already good (${done.length})</summary><ul class="sp-checks">${done.map((c) => checkItem(c, SEO_GROUP_LABELS[c.group], base, v, a)).join('')}</ul></details>` : ''}</section>`;
}

/** The fold: sits just above "How it appears in Google" and links to it rather than repeating it. */
export function seoPanel(shell: { brand?: Brand | null }, d: SeoPanelData, v: ArticleVersion, open: boolean): string {
  const b = shell.brand!;
  const s = articleSeoScore(b, d, v);
  const base = articleBase(b, d.article);
  return `${SEO_PANEL_START}<details class="ap-fold sp" id="seo"${open ? ' open' : ''}><summary><h2>SEO report: ${s.score} out of 100</h2></summary><div class="ap-fold-body"><style>${SEO_PANEL_CSS}</style>
<div class="sp-grid">${aimCard(d.articleBrief)}${demandCard(d.articleBrief)}${scoreCard(s, base, v, d.article)}${tagsCard(d, v)}</div></div></details>${SEO_PANEL_END}`;
}

export const SEO_PANEL_CSS = `
.sp-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;padding-top:4px}
.sp-card{min-width:0;margin:0;padding:16px 18px;background:var(--card);border:1px solid var(--line);border-radius:14px;color:var(--ink)}
.sp-card h3{margin:0 0 10px;font-size:16px;line-height:1.3}.sp-card p{margin:0 0 8px}.sp-card p:last-child{margin-bottom:0}
.sp-wide{grid-column:1/-1}
.sp-dl{margin:0}.sp-dl dt{font-size:13px;font-weight:600;color:var(--muted);margin:10px 0 2px}.sp-dl dt:first-child{margin-top:0}.sp-dl dd{margin:0}
.sp-dl-row{display:grid;grid-template-columns:minmax(150px,200px) minmax(0,1fr);gap:8px 16px}.sp-dl-row dt,.sp-dl-row dt:first-child{margin:0;padding-top:1px}
.sp-phrase{display:inline-block;padding:3px 12px;border-radius:999px;background:color-mix(in srgb,var(--accent) 10%,var(--card));border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);font-weight:700;font-size:16px;overflow-wrap:anywhere}
.sp-qs{margin:2px 0 0;padding-left:1.1em}.sp-qs li{margin:0 0 3px}
.sp-big{font-size:15px}.sp-big strong{font-size:28px;line-height:1.1;margin-right:4px}
.sp-label{font-weight:600}
.sp-url{overflow-wrap:anywhere}
.sp-foot{margin-top:12px!important;font-size:14px;color:var(--muted)}
.sp-head{display:flex;gap:18px;align-items:center;margin-bottom:14px}
.sp-head-text{flex:1;min-width:0}
.sp-verdict{font-size:18px;font-weight:700;line-height:1.35;margin:0 0 4px!important}
.sp-dial{--sp-c:var(--accent);flex:none;width:96px;height:96px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(var(--sp-c) calc(var(--sp-v) * 1%),color-mix(in srgb,var(--line) 85%,transparent) 0)}
.sp-dial>span{width:76px;height:76px;border-radius:50%;background:var(--card);display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1}
.sp-dial b{font-size:28px;font-weight:800}.sp-dial small{font-size:11px;color:var(--muted);margin-top:3px}
.sp-hi{--sp-c:var(--ok)}.sp-mid{--sp-c:var(--warn)}.sp-lo{--sp-c:var(--bad)}
.sp-groups{list-style:none;margin:0 0 6px;padding:0;display:grid;gap:8px}
.sp-groups li{display:grid;grid-template-columns:minmax(120px,170px) minmax(0,1fr) auto;gap:12px;align-items:center;font-size:14px}
.sp-gname{font-weight:600}.sp-gpts{color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.sp-bar{height:8px;border-radius:999px;background:color-mix(in srgb,var(--line) 85%,transparent);overflow:hidden}.sp-bar i{display:block;height:100%;border-radius:999px;background:var(--accent)}
.sp-sub{font-size:15px;margin:18px 0 6px}
.sp-checks{list-style:none;margin:0;padding:0}
.sp-check{display:flex;gap:12px;padding:10px 0;border-top:1px solid var(--line)}
.sp-check p{margin:0 0 3px}
.sp-mark{flex:none;width:24px;height:24px;margin-top:1px;border-radius:50%;display:grid;place-items:center;font-size:13px;font-weight:800;color:var(--card)}
.sp-pass .sp-mark{background:var(--ok)}.sp-pass .sp-mark::before{content:"\\2713"}
.sp-partly .sp-mark{background:var(--warn)}.sp-partly .sp-mark::before{content:"!"}
.sp-fail .sp-mark{background:var(--bad)}.sp-fail .sp-mark::before{content:"\\2715"}
.sp-name{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px}.sp-group{flex-basis:100%;font-size:12px;color:var(--muted);font-weight:600}
.sp-tag{font-size:12px;font-weight:700;padding:1px 8px;border-radius:999px;border:1px solid currentColor}
.sp-pass .sp-tag{color:var(--ok)}.sp-partly .sp-tag{color:var(--warn)}.sp-fail .sp-tag{color:var(--bad)}
.sp-found{color:var(--ink)}.sp-todo{color:var(--muted)}.sp-todo .sp-label{color:var(--ink)}
.sp-fix{font-weight:600;white-space:nowrap}
.sp-done{margin-top:10px}.sp-done>summary{cursor:pointer;font-weight:600;color:var(--accent);padding:10px 0;min-height:24px}
.sp-lead{font-size:17px;margin:4px 0 6px}.sp-cap{margin:0 0 6px!important}.sp-parts .sp-groups{margin-top:6px}
.sp-pill{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:700;font-size:14px;color:var(--ink);background:color-mix(in srgb,var(--sp-c) 14%,var(--card));border:1px solid color-mix(in srgb,var(--sp-c) 45%,transparent)}
.sp-line a{font-weight:600}
@media(max-width:700px){
.sp-grid{grid-template-columns:minmax(0,1fr)}
.sp-dl-row{grid-template-columns:minmax(0,1fr);gap:2px}.sp-dl-row dd{margin-bottom:10px}
.sp-head{gap:14px}.sp-dial{width:80px;height:80px}.sp-dial>span{width:62px;height:62px}.sp-dial b{font-size:24px}
.sp-groups li{grid-template-columns:minmax(0,1fr) auto;gap:4px 10px}.sp-groups .sp-bar{grid-column:1/-1;grid-row:2}
}
`;
