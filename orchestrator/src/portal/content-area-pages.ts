/**
 * The content area preview's own screens: Home ("what needs you"), the Calendar month, the Articles list and an honest
 * Results page, plus the page that switches the preview on or off for a browser.
 *
 * Everything shown is read from the business's real records through the same rules the existing pages use
 * (`situation` and `writingStatus` from the article page). No number is shown that the system does not have.
 * Native links and forms only; no script.
 */
import { addDays, utcToLocal } from '../seo-blog/schedule.js';
import type { Article, ArticleBody, ArticleBrief, Brand, Destination, Job } from '../seo-blog/types.js';
import { csrfField, layout, SEO_BLOG_BASE, type Shell } from './seo-blog-view.js';
import { longWhen, safeHttps, situation, writingStatus, type ArticleListRow, type Situation } from './seo-blog-article-view.js';
import { autopilot, icon, publishingDays } from './content-area-layout.js';
import { CONTENT_AREA_TOKENS } from './content-area-theme.js';
import { escapeHtml as e } from './ui.js';

type PublicDestination = Omit<Destination, 'sealedCredential'>;

export interface ContentAreaData {
  readonly articles: readonly ArticleListRow[];
  readonly destinations: readonly PublicDestination[];
  readonly jobs: readonly Job[];
  readonly briefs: readonly ArticleBrief[];
  readonly now: string;
}

interface Item {
  readonly row: ArticleListRow | null;
  readonly brief: ArticleBrief | null;
  readonly href: string;
  readonly title: string;
  readonly line: string;
  readonly excerpt: string;
  readonly picture: string | null;
  readonly alt: string;
  readonly sit: Situation | null;
  readonly retryJobId: string | null;
  readonly link: { href: string; label: string } | null;
}

const brandHref = (b: Brand, path: string) => `${SEO_BLOG_BASE}/b/${b.id}/${path}`;
const clock = (time: string) => time.replace(/^0(\d)/, '$1');
function local(iso: string, tz: string): { date: string; time: string } {
  try { return utcToLocal(iso, tz); } catch { return { date: iso.slice(0, 10), time: iso.slice(11, 16) }; }
}
const weekday = (date: string) => utcToLocal(`${date}T12:00:00Z`, 'UTC').weekday;
const dayName = (date: string, style: 'short' | 'long' = 'short') => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: style, timeZone: 'UTC' });
const monthName = (date: string) => new Date(`${date.slice(0, 7)}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The picture the owner sees for an article (a privately reviewed hero comes from the private route), as on the article page. */
function pictureSrc(b: Brand, article: Article, image: ArticleBody['image'] | undefined): string | null {
  if (!image?.url) return null;
  const hero = article.heroMedia;
  if (hero && image.url === hero.reservation.prospectiveUrl && /^[0-9a-f-]{36}$/i.test(hero.reservation.assetId) && /^[0-9a-f]{64}$/i.test(hero.reservation.assetSha256)) return `${SEO_BLOG_BASE}/b/${b.id}/media/${hero.reservation.assetId}/${hero.reservation.assetSha256}.jpg`;
  return safeHttps(image.url);
}

/** Every article (and every topic being written) in the same four groups as the articles list. */
function groups(b: Brand, d: ContentAreaData): Record<'ready' | 'coming' | 'writing' | 'live', Item[]> {
  const websites = d.destinations.filter((x) => x.status === 'connected').length;
  const briefs = new Map(d.briefs.map((x) => [x.id, x]));
  const out: Record<'ready' | 'coming' | 'writing' | 'live', Item[]> = { ready: [], coming: [], writing: [], live: [] };
  for (const row of d.articles) {
    const a = row.article;
    const brief = briefs.get(a.briefId) ?? null;
    const base = { row, brief, href: brandHref(b, `articles/${a.id}`), excerpt: (row.excerpt ?? '').split(/\n/)[0] ?? '', picture: pictureSrc(b, a, row.image), alt: row.image?.alt ?? '' };
    if (!a.currentVersionId) {
      const w = writingStatus(b, a, a.briefId, d.jobs);
      out.writing.push({ ...base, title: brief?.workingTitle || row.title.replace(/^./, (c) => c.toUpperCase()), line: w.sentence.replace(/\.$/, ''), sit: null, retryJobId: w.retryJobId, link: w.link });
      continue;
    }
    const sit = situation(a, b, d.now, websites);
    out[sit.group].push({ ...base, title: row.title, line: sit.line, sit, retryJobId: null, link: null });
  }
  for (const brief of d.briefs) {
    if (brief.status !== 'generating' || d.articles.some((r) => r.article.briefId === brief.id)) continue;
    const w = writingStatus(b, null, brief.id, d.jobs);
    out.writing.push({ row: null, brief, href: brandHref(b, 'topics'), title: brief.workingTitle, line: w.sentence.replace(/\.$/, ''), excerpt: '', picture: null, alt: '', sit: null, retryJobId: w.retryJobId, link: w.link });
  }
  out.ready.sort((x, y) => (x.row!.article.createdAt).localeCompare(y.row!.article.createdAt));
  out.coming.sort((x, y) => (x.row!.article.schedule?.publishAtUtc ?? '').localeCompare(y.row!.article.schedule?.publishAtUtc ?? ''));
  out.live.sort((x, y) => (y.row!.article.publishedAt ?? '').localeCompare(x.row!.article.publishedAt ?? ''));
  return out;
}

/** The number on the Articles badge: written articles waiting for the owner (the articles list's "Ready for you"). */
export function needsYouCount(b: Brand, articles: readonly ArticleListRow[], destinations: readonly PublicDestination[], now: string): number {
  const websites = destinations.filter((x) => x.status === 'connected').length;
  return articles.filter((r) => r.article.currentVersionId && situation(r.article, b, now, websites).group === 'ready').length;
}

function picture(i: Pick<Item, 'picture' | 'alt'>, cls = '', writing = false): string {
  if (i.picture) return `<span class="ca-pic ${cls}"><img src="${e(i.picture)}" alt="${e(i.alt)}" loading="lazy"></span>`;
  return `<span class="ca-pic ca-pic-none ${cls}" aria-hidden="true">${writing ? '<svg class="ca-ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>' : ''}</span>`;
}

const arrow = '<svg class="ca-ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const chevron = '<svg class="ca-ic ca-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9 6 6 6-6 6"/></svg>';
const bolt = '<svg class="ca-ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>';
const amber = (href: string, label: string, cls = '') => `<a class="ca-btn ${cls}" href="${e(href)}" data-primary>${e(label)} ${arrow}</a>`;

// ─── Home ────────────────────────────────────────────────────────────────────

export function contentHomePage(shell: Shell, d: ContentAreaData & { readonly dnaConfirmed: boolean }): string {
  const b = shell.brand!;
  const g = groups(b, d);
  const now = local(d.now, b.timezone);
  const hour = Number(now.time.slice(0, 2));
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const n = g.ready.length;
  const allReading = g.ready.every((i) => i.sit?.kind === 'ready');
  const anything = d.articles.length > 0 || g.writing.length > 0;
  let lede: string, hero: string;
  if (n) {
    const first = g.ready[0]!;
    const pics = g.ready.filter((i) => i.picture).slice(0, 3);
    lede = `${n === 1 ? 'One article is' : `${n} articles are`} written and waiting for you.`;
    hero = `<section class="ca-hero" aria-labelledby="ca-hero-title"><div class="ca-hero-text"><p class="ca-tag">Needs you today</p>
<h2 id="ca-hero-title" class="ca-hero-h">${n === 1 ? `1 article ${allReading ? 'is ready for you to read' : 'needs you'}` : `${n} articles ${allReading ? 'are ready for you to read' : 'need you'}`}</h2>
<p class="ca-hero-p">Start with “${e(first.title)}”. Read it, then decide whether it goes out. ${n > 1 ? 'The others wait in Articles.' : ''}</p>${amber(first.href, 'Start reading')}</div>
${pics.length ? `<div class="ca-hero-art ca-hero-art-${pics.length}" aria-hidden="true">${pics.map((p, i) => picture(p, `ca-hero-pic ca-p${i + 1}`)).join('')}</div>` : ''}</section>`;
  } else if (anything) {
    const next = g.coming[0];
    const s = next?.row?.article.schedule;
    lede = 'Everything is running. Nothing needs you today.';
    hero = `<section class="ca-hero ca-hero-calm" aria-labelledby="ca-hero-title"><div class="ca-hero-text"><p class="ca-tag ca-tag-calm">All clear</p><h2 id="ca-hero-title" class="ca-hero-h">Nothing needs you today</h2>
<p class="ca-hero-p">${next && s ? `Next out: “${e(next.title)}” on ${e(longWhen(s.localDate, s.localTime, now.date))}.` : 'Nothing is booked to go out yet.'} ${g.writing.length ? `${plural(g.writing.length, 'article is', 'articles are')} being written; we will show it here when it is ready for you.` : ''}</p>
<a class="ca-btn-2" href="${e(brandHref(b, 'calendar'))}">See the calendar</a></div></section>`;
  } else {
    lede = `Let us get the first articles written for ${b.name}.`;
    hero = `<section class="ca-hero" aria-labelledby="ca-hero-title"><div class="ca-hero-text"><p class="ca-tag">First step</p><h2 id="ca-hero-title" class="ca-hero-h">${d.dnaConfirmed ? 'Choose your first topics' : 'Start with your website'}</h2>
<p class="ca-hero-p">${d.dnaConfirmed ? 'Your Brand DNA is ready. Pick the topics you want us to write about and the articles appear here as they are written.' : 'Paste your website address. We read it and learn how your business talks, then you check what we found.'}</p>${amber(brandHref(b, d.dnaConfirmed ? 'topics' : 'dna'), d.dnaConfirmed ? 'Choose topics' : 'Start with your website')}</div></section>`;
  }
  const monday = addDays(now.date, 1 - weekday(now.date));
  const sunday = addDays(monday, 6);
  const inWeek = (date: string | null | undefined) => Boolean(date && date >= monday && date <= sunday);
  const week = [...g.live.filter((i) => inWeek(i.row!.article.publishedAt ? local(i.row!.article.publishedAt, b.timezone).date : null)).map((i) => ({ i, date: local(i.row!.article.publishedAt!, b.timezone).date, live: true })),
    ...g.coming.filter((i) => inWeek(i.row!.article.schedule?.localDate)).map((i) => ({ i, date: i.row!.article.schedule!.localDate, live: false }))].sort((x, y) => x.date.localeCompare(y.date));
  const weekRows = week.map(({ i, date, live }) => `<li><a class="ca-wk" href="${e(i.href)}"><span class="ca-wk-date"><b>${e(dayName(date))}</b><i>${Number(date.slice(8))}</i></span>${picture(i, 'ca-wk-pic')}<span class="ca-row-text"><span class="ca-row-title">${e(i.title)}</span><span class="ca-row-line">${e(i.line)}</span></span><span class="ca-chip${live ? ' ca-chip-live' : ''}">${live ? 'Live' : 'Going out'}</span></a></li>`).join('');
  const days = publishingDays(b.settings.cadence.weekdays, b.settings.cadence.localTime);
  const weekBlock = anything ? `<section aria-labelledby="ca-week"><h2 id="ca-week" class="ca-h2">Going out this week</h2><p class="ca-sub">You publish on ${e(days)}.${week.length ? ' Nothing here needs you.' : ''}</p>
${week.length ? `<ul class="ca-panel ca-rows">${weekRows}</ul>` : `<p class="ca-panel ca-empty">Nothing is going out this week. ${g.coming.length ? 'The next article is on the calendar.' : ''} <a href="${e(brandHref(b, 'calendar'))}">Open the calendar</a></p>`}</section>` : '';
  const auto = autopilot(shell);
  const autoBlock = `<section class="ca-autocard" aria-labelledby="ca-auto"><span class="ca-auto-badge" aria-hidden="true">${bolt}</span><div><h2 id="ca-auto" class="ca-h3">${e(auto.title)}</h2><p>${e(auto.line)}</p></div><a href="${e(brandHref(b, 'publishing'))}">Change this</a></section>`;
  return layout(shell, 'Home', `<div class="ca-col"><header><h1 class="ca-h1">${greeting}</h1><p class="ca-lede">${e(lede)}</p></header>${hero}${weekBlock}${autoBlock}</div>`, `<style>${PAGE_CSS}</style>`);
}

// ─── Calendar ────────────────────────────────────────────────────────────────

interface CalItem { readonly kind: 'live' | 'going' | 'needs' | 'writing' | 'topic' | 'free' | 'fill'; readonly label: string; readonly title: string; readonly href: string | null; readonly pic: Pick<Item, 'picture' | 'alt'> | null }

export function contentCalendarPage(shell: Shell, d: ContentAreaData & { readonly month: string }): string {
  const b = shell.brand!;
  const s = b.settings;
  const g = groups(b, d);
  const today = local(d.now, b.timezone).date;
  const items = new Map<string, CalItem[]>();
  const add = (date: string, item: CalItem) => items.set(date, [...(items.get(date) ?? []), item]);
  const suggested = (i: Item) => i.brief && (i.brief as ArticleBrief & { suggestedAtUtc?: string }).suggestedAtUtc ? local((i.brief as ArticleBrief & { suggestedAtUtc: string }).suggestedAtUtc, b.timezone).date : null;
  for (const i of g.live) add(local(i.row!.article.publishedAt ?? i.row!.article.schedule?.publishAtUtc ?? d.now, b.timezone).date, { kind: 'live', label: 'Live', title: i.title, href: i.href, pic: i });
  for (const i of g.coming) {
    const sc = i.row!.article.schedule;
    if (sc) add(sc.localDate, { kind: 'going', label: i.sit?.kind === 'scheduled' || (i.sit?.kind === 'rewriting' && sc.localDate > today) ? `Goes out ${clock(sc.localTime)}` : 'Going out now', title: i.title, href: i.href, pic: i });
  }
  for (const i of g.ready) {
    const date = i.row!.article.schedule?.localDate ?? suggested(i);
    if (date) add(date, { kind: 'needs', label: 'Needs you', title: i.title, href: i.href, pic: i });
  }
  for (const i of g.writing) { const date = suggested(i); if (date) add(date, { kind: 'writing', label: 'Being written', title: i.title, href: i.href, pic: null }); }
  for (const brief of d.briefs as (ArticleBrief & { suggestedAtUtc?: string })[]) {
    if (!brief.suggestedAtUtc || !['planned', 'accepted'].includes(brief.status) || d.articles.some((r) => r.article.briefId === brief.id)) continue;
    add(local(brief.suggestedAtUtc, b.timezone).date, { kind: 'topic', label: 'Topic chosen', title: brief.workingTitle, href: brandHref(b, 'topics'), pic: null });
  }
  const first = `${d.month}-01`;
  const lead = weekday(first) - 1;
  const start = addDays(first, -lead);
  const lastDay = addDays(`${new Date(Date.UTC(Number(d.month.slice(0, 4)), Number(d.month.slice(5, 7)), 15)).toISOString().slice(0, 7)}-01`, -1);
  const weeks = Math.ceil((lead + Number(lastDay.slice(8))) / 7);
  const days = Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
  // Empty publishing days ahead: the system fills them only while ongoing production is on (within its planning horizon).
  const horizon = addDays(today, s.planningHorizonDays);
  const perWeek = new Map<string, number>();
  for (const day of days) { const monday = addDays(day, 1 - weekday(day)); perWeek.set(monday, (perWeek.get(monday) ?? 0) + (items.get(day)?.filter((x) => x.kind !== 'topic').length ?? 0)); }
  if (!s.pauseAll) for (const day of days) {
    if (day <= today || !s.cadence.weekdays.includes(weekday(day)) || items.get(day)?.length) continue;
    const monday = addDays(day, 1 - weekday(day));
    if ((perWeek.get(monday) ?? 0) >= s.cadence.perWeek) continue;
    perWeek.set(monday, (perWeek.get(monday) ?? 0) + 1);
    const fills = s.ongoingProduction && day <= horizon;
    add(day, { kind: fills ? 'fill' : 'free', label: fills ? 'We will fill this' : 'Free publishing day', title: '', href: null, pic: null });
  }
  const tile = (x: CalItem) => {
    const media = x.kind === 'fill' || x.kind === 'free' ? `<span class="ca-slot ca-slot-${x.kind}" aria-hidden="true">${x.kind === 'fill' ? bolt : ''}</span>`
      : x.pic ? picture(x.pic, 'ca-cal-pic') : `<span class="ca-slot ca-slot-${x.kind}" aria-hidden="true">${x.kind === 'writing' ? '<svg class="ca-ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>' : ''}</span>`;
    const inner = `${media}<span class="ca-st ca-st-${x.kind}">${e(x.label)}</span>${x.title ? `<span class="ca-cal-title">${e(x.title)}</span>` : ''}`;
    return x.href ? `<a class="ca-cal-item" href="${e(x.href)}">${inner}</a>` : `<div class="ca-cal-item">${inner}</div>`;
  };
  const longDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
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
  const fillLine = s.pauseAll ? 'Publishing is paused, so nothing goes out until you switch it back on.'
    : s.ongoingProduction ? `Empty publishing days up to ${s.planningHorizonDays} days ahead fill themselves, so all you do is read and decide.`
      : 'Empty publishing days stay empty until you choose topics for them.';
  return layout(shell, 'Calendar', `<div class="ca-col ca-wide"><header class="ca-cal-head"><h1 class="ca-h1">${e(monthName(first))}</h1><nav class="ca-month-nav" aria-label="Month"><a class="ca-mn" href="?date=${shift(-1)}"><span class="ca-sr">Previous month</span><span aria-hidden="true">‹</span></a><a class="ca-mn" href="?date=${shift(1)}"><span class="ca-sr">Next month</span><span aria-hidden="true">›</span></a></nav><span class="ca-grow"></span>${needs ? amber(g.ready[0]!.href, needs === 1 ? 'Read the one that needs you' : `Read the ${needs} that need you`) : ''}</header>
<p class="ca-autoline"><span class="ca-auto-badge" aria-hidden="true">${bolt}</span><span class="ca-grow">You publish on ${e(publishingDays(s.cadence.weekdays, s.cadence.localTime))}. ${e(fillLine)}</span><a href="${e(brandHref(b, 'publishing'))}">Change the days</a></p>
<section class="ca-cal" aria-label="${e(monthName(first))}"><div class="ca-dow" aria-hidden="true">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x) => `<span>${x}</span>`).join('')}</div><ol class="ca-days">${days.map(cell).join('')}</ol></section>
<section class="ca-agenda" aria-label="${e(monthName(first))}, day by day"><ol>${agenda}</ol></section>
<p class="ca-quiet-links"><a href="${e(brandHref(b, `calendar?view=month&date=${first}`))}">Move dates and schedule drafts by hand</a> · <a href="${e(brandHref(b, 'social/calendar'))}">Social posts calendar</a></p></div>`, `<style>${PAGE_CSS}</style>`);
}

// ─── Articles ────────────────────────────────────────────────────────────────

export function contentArticlesPage(shell: Shell, d: ContentAreaData): string {
  const b = shell.brand!;
  const g = groups(b, d);
  const titles = { ready: 'Ready for you', coming: 'Coming up', writing: 'Being written', live: 'Live' } as const;
  const row = (i: Item, group: keyof typeof g) => {
    const action = i.retryJobId ? `<form method="post" action="${e(brandHref(b, `jobs/${i.retryJobId}/retry`))}" class="ca-row-act">${csrfField(shell.csrf)}<input type="hidden" name="back" value="articles"><button type="submit" class="ca-btn-quiet">Try again</button><span class="ca-note">Uses some of your writing allowance.</span></form>`
      : i.link ? `<a class="ca-row-act ca-link" href="${e(i.link.href)}">${e(i.link.label)}</a>` : '';
    return `<li class="ca-row"><a class="ca-row-main" href="${e(i.href)}">${picture(i, 'ca-row-pic', group === 'writing')}<span class="ca-row-text"><span class="ca-row-title">${e(i.title)}</span><span class="ca-row-line">${e(i.line)}</span>${i.excerpt && group !== 'writing' ? `<span class="ca-row-ex">${e(i.excerpt)}</span>` : ''}</span>${chevron}</a>${action}</li>`;
  };
  const sections = (['ready', 'coming', 'writing', 'live'] as const).filter((k) => g[k].length).map((k) => `<section class="ca-group" aria-labelledby="ca-g-${k}"><div class="ca-group-head"><h2 id="ca-g-${k}" class="ca-h2">${titles[k]}</h2><span class="ca-gcount${k === 'ready' ? ' ca-gcount-needs' : ''}"><span class="ca-sr">: </span>${g[k].length}</span><span class="ca-grow"></span>${k === 'ready' ? amber(g.ready[0]!.href, g.ready.length === 1 ? 'Read it' : 'Start with the first', 'ca-btn-sm') : ''}</div><ul class="ca-panel ca-rows">${g[k].map((i) => row(i, k)).join('')}</ul></section>`).join('');
  const empty = `<section class="ca-panel ca-empty-big"><h2 class="ca-h2">No articles yet</h2><p>Choose the topics you want us to write about. The articles appear here as they are written.</p><a class="ca-btn" href="${e(brandHref(b, 'topics'))}" data-primary>Choose topics ${arrow}</a></section>`;
  return layout(shell, 'Articles', `<div class="ca-col"><header><h1 class="ca-h1">Articles</h1><p class="ca-lede">Everything we have written for ${e(b.name)}.</p></header>${sections || empty}</div>`, `<style>${PAGE_CSS}</style>`);
}

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
.ca-hero .ca-btn{margin-top:8px}
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
.ca-row-line{font-size:15px;line-height:1.4;color:var(--ca-muted)}
.ca-row-ex{font-size:14px;line-height:1.4;color:var(--ca-muted);opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
.ca-row-act{margin:-4px 0 14px 96px}
.ca-group-head .ca-btn{width:100%}.ca-cal-head .ca-btn{width:100%}.ca-autoline{display:grid;grid-template-columns:auto 1fr;border-radius:var(--ca-radius-m);padding:14px}.ca-autoline>a{grid-column:2}.ca-autocard{display:grid;grid-template-columns:auto 1fr;border-radius:var(--ca-radius-m)}.ca-autocard>a{grid-column:2}
.ca-cal{display:none}.ca-agenda{display:block}
}
`;
